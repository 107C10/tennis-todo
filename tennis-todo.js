// ==UserScript==
// @name         SJTU Tennis -> Microsoft To-Do
// @namespace    tennis-todo
// @match        https://sports.sjtu.edu.cn/*
// @grant        GM.setValue
// @grant        GM.getValue
// @grant        GM.deleteValue
// @grant        GM.xmlHttpRequest
// @grant        GM.registerMenuCommand
// @connect      graph.microsoft.com
// @connect      login.microsoftonline.com
// @run-at       document-idle
// @version      8
// @description  把 SJTU 网球预约自动同步到 Microsoft To-Do 共享列表。零本地服务，零命令行。
// ==/UserScript==

/* eslint-disable no-undef */

(function () {
  'use strict';

  // ============================================================
  //  常量
  // ============================================================
  const CLIENT_ID      = '14d82eec-204b-4c2f-b7e8-296a70dab67e';   // Microsoft Graph CLI public client
  const SCOPES         = 'Tasks.ReadWrite offline_access';
  const TENANT         = 'consumers';
  const TOKEN_URL      = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`;
  const DEVICECODE_URL = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/devicecode`;
  const GRAPH_BASE     = 'https://graph.microsoft.com/v1.0';
  const ORDER_URL      = '/venue/personal/personalOrderlist?pageNo=1&pageSize=10';
  const TIMEZONE       = 'China Standard Time';

  const ORDER_MARKER_RE = /\[sjtu-order:([^\]]+)\]/g;
  const TITLE_SEG_RE    = /([一-鿿])(\d+(?:[\/\-]\d+)*)\s+(\d{1,2}(?::\d{2})?)-(\d{1,2}(?::\d{2})?)/g;
  const TITLE_DATE_RE   = /^🎾(\d{1,2})\.(\d{1,2})\b/u;   // 标题前缀，识别脚本管理任务
  const SPACE_INFO_RE   = /网球 场地(\d+)\s*\((\d{1,2}:\d{2})-(\d{1,2}:\d{2})\)/;
  const WEEKDAYS_CN     = ['星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日'];

  // ============================================================
  //  通用 helpers
  // ============================================================
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function urlencode(obj) {
    return Object.entries(obj)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
  }

  // GM.xmlHttpRequest 的 Promise 包装。返回 {status, responseText, responseHeaders}
  function gm(opts) {
    return new Promise((resolve, reject) => {
      GM.xmlHttpRequest({
        ...opts,
        onload:  r => resolve(r),
        onerror: r => reject(new Error(`network error: ${r.statusText || r.error || 'unknown'}`)),
        ontimeout: () => reject(new Error('timeout')),
      });
    });
  }

  // ============================================================
  //  时间 / 日期 helpers
  //    Time = {h: 0-23, m: 0-59}      （等价 Python datetime.time）
  //    Date = "YYYY-MM-DD"            （字符串便于做 Map key 与 ISO 拼接）
  // ============================================================
  function fmtHour(t)        { return t.m === 0 ? String(t.h) : `${pad2(t.h)}:${pad2(t.m)}`; }
  function fmtHourMinute(t)  { return `${pad2(t.h)}:${pad2(t.m)}`; }
  function pad2(n)           { return String(n).padStart(2, '0'); }
  function timeKey(t)        { return t.h * 60 + t.m; }
  function fromKey(k)        { return { h: Math.floor(k / 60), m: k % 60 }; }

  function parseTimeToken(s) {
    if (s.includes(':')) {
      const [h, m] = s.split(':').map(Number);
      return { h, m };
    }
    return { h: Number(s), m: 0 };
  }

  function dateAtTime(dateStr, t) {
    return new Date(`${dateStr}T${pad2(t.h)}:${pad2(t.m)}:00`);
  }

  function weekdayCN(dateStr) {
    const wd = (new Date(dateStr + 'T00:00:00').getDay() + 6) % 7;  // 周一=0
    return WEEKDAYS_CN[wd];
  }

  function venueShort(name)  { return name ? Array.from(name)[0] : '?'; }
  function courtNum(courtNo) {
    const m = /\d+/.exec(courtNo);
    return m ? m[0] : courtNo;
  }

  function bookingToSegment(b) {
    return {
      venueShort: venueShort(b.venue),
      courtToken: courtNum(b.courtNo),
      startTime: b.startTime,
      endTime:   b.endTime,
    };
  }

  // ============================================================
  //  SJTU 订单解析  (port from sjtu_client.py)
  // ============================================================
  function parseSpaceInfo(spaceInfo) {
    const m = SPACE_INFO_RE.exec(spaceInfo);
    if (!m) throw new Error(`无法解析 spaceInfo: ${spaceInfo}`);
    return {
      courtNo:   `场地${m[1]}`,
      startTime: parseTimeToken(m[2]),
      endTime:   parseTimeToken(m[3]),
    };
  }

  function recordToOrder(rec) {
    const { courtNo, startTime, endTime } = parseSpaceInfo(rec.spaceInfo);
    return {
      orderId:     String(rec.pOrderid),
      venue:       rec.venuename,
      courtNo,
      bookingDate: rec.scDate,                 // 'YYYY-MM-DD'
      startTime,
      endTime,
    };
  }

  function parseOrders(records, now) {
    const cutoff = now || new Date();
    const out = [];
    for (const rec of records) {
      if (String(rec.orderstateid) !== '1') continue;
      if (rec.cancelOrder) continue;
      let order;
      try { order = recordToOrder(rec); }
      catch (e) {
        console.warn(`[sjtu-sync] 跳过解析失败的记录 ${rec.pOrderid}: ${e.message}`);
        continue;
      }
      if (dateAtTime(order.bookingDate, order.startTime) < cutoff) continue;
      out.push(order);
    }
    out.sort((a, b) => dateAtTime(a.bookingDate, a.startTime) - dateAtTime(b.bookingDate, b.startTime));
    return out;
  }

  // ============================================================
  //  纯逻辑：标题/正文渲染、解析、合并  (port from merge.py)
  // ============================================================
  function renderSegmentStr(s) {
    return `${s.venueShort}${s.courtToken} ${fmtHour(s.startTime)}-${fmtHour(s.endTime)}`;
  }

  function renderTitle(dateStr, segs) {
    const [, m, d] = dateStr.split('-').map(Number);
    const sorted = [...segs].sort((a, b) => timeKey(a.startTime) - timeKey(b.startTime));
    return [`🎾${m}.${d}`, ...sorted.map(renderSegmentStr)].join(' ');
  }

  function renderBlock(b) {
    return [
      `日期：${b.bookingDate} ${weekdayCN(b.bookingDate)}`,
      `场馆：${b.venue}`,
      `场地：${b.courtNo}`,
      `时段：${fmtHourMinute(b.startTime)}-${fmtHourMinute(b.endTime)}`,
      `[sjtu-order:${b.orderId}]`,
    ].join('\n');
  }

  function parseTitleSegments(title) {
    const out = [];
    for (const m of (title || '').matchAll(TITLE_SEG_RE)) {
      try {
        out.push({
          venueShort: m[1],
          courtToken: m[2],
          startTime:  parseTimeToken(m[3]),
          endTime:    parseTimeToken(m[4]),
        });
      } catch { /* skip */ }
    }
    return out;
  }

  function visualMatchInTitle(title, b) {
    const tgt = bookingToSegment(b);
    for (const seg of parseTitleSegments(title)) {
      if (
        seg.venueShort === tgt.venueShort &&
        courtNum(seg.courtToken) === tgt.courtToken &&
        timeKey(seg.startTime) === timeKey(tgt.startTime) &&
        timeKey(seg.endTime)   === timeKey(tgt.endTime)
      ) return true;
    }
    return false;
  }

  function appendSegments(existingTitle, newSegs) {
    const sorted = [...newSegs].sort((a, b) => timeKey(a.startTime) - timeKey(b.startTime));
    const tail = sorted.map(renderSegmentStr).join(' ');
    return (existingTitle.trimEnd() + ' ' + tail).trim();
  }

  function computeMergedTitle(existing, trulyNew) {
    if (trulyNew.length === 0) return null;
    const newSegs = trulyNew.map(bookingToSegment);
    if (!existing.dueDate) return appendSegments(existing.title, newSegs);
    const existingSegs = parseTitleSegments(existing.title);
    if (existingSegs.length > 0) {
      return renderTitle(existing.dueDate, [...existingSegs, ...newSegs]);
    }
    return appendSegments(existing.title, newSegs);
  }

  function computeAppendedBody(existingBody, allNew) {
    const sorted = [...allNew].sort((a, b) => timeKey(a.startTime) - timeKey(b.startTime));
    const appended = sorted.map(renderBlock).join('\n\n');
    if ((existingBody || '').trim()) return existingBody.trimEnd() + '\n\n' + appended;
    return appended;
  }

  // 【Bug E + F 修复】：dueDateTime 取所有可能的最早时刻
  //   - existing 已解析段的 start_time
  //   - existing 当前 dueDateTime 自身的时间（兜底，覆盖无法解析的 court 段）
  //   - inTitleOnly + trulyNew 的所有 booking start_time
  // 触发条件改为 inTitleOnly 或 trulyNew 任一非空（不再要求 trulyNew）
  function computeDueDateTime(existing, inTitleOnly, trulyNew) {
    if (!existing.dueDate) return null;
    if (inTitleOnly.length === 0 && trulyNew.length === 0) return null;
    const starts = [];
    for (const s of parseTitleSegments(existing.title)) starts.push(timeKey(s.startTime));
    if (existing.dueTime) starts.push(timeKey(existing.dueTime));
    for (const b of inTitleOnly) starts.push(timeKey(b.startTime));
    for (const b of trulyNew)    starts.push(timeKey(b.startTime));
    if (starts.length === 0) return null;
    const min = Math.min(...starts);
    return {
      dateTime: `${existing.dueDate}T${fmtHourMinute(fromKey(min))}:00`,
      timeZone: TIMEZONE,
    };
  }

  // ============================================================
  //  Plan / 决策 (port from sync.plan_changes)
  // ============================================================
  function gatherPending(orders) {
    const map = new Map();
    for (const o of orders) {
      if (!map.has(o.bookingDate)) map.set(o.bookingDate, []);
      map.get(o.bookingDate).push(o);
    }
    return map;
  }

  function bookingFromOrder(o) {
    return {
      orderId: o.orderId, venue: o.venue, courtNo: o.courtNo,
      bookingDate: o.bookingDate, startTime: o.startTime, endTime: o.endTime,
    };
  }

  function planChanges(pendingByDate, managedTasks) {
    const byDate = new Map();
    for (const t of managedTasks) {
      if (!t.dueDate) continue;
      if (byDate.has(t.dueDate)) {
        console.warn(`[sjtu-sync] 同日多条 marker 任务 ${t.dueDate}，仅以先出现的为准`);
        continue;
      }
      byDate.set(t.dueDate, t);
    }
    const creates = [], updates = [];
    for (const d of [...pendingByDate.keys()].sort()) {
      const orders = pendingByDate.get(d);
      const existing = byDate.get(d);
      if (!existing) {
        creates.push([d, orders.map(bookingFromOrder)]);
        continue;
      }
      const inTitle = [], trulyNew = [];
      for (const o of orders) {
        if (existing.markerOrderIds.has(o.orderId)) continue;
        const b = bookingFromOrder(o);
        if (visualMatchInTitle(existing.title, b)) inTitle.push(b);
        else trulyNew.push(b);
      }
      if (inTitle.length || trulyNew.length) updates.push([existing, inTitle, trulyNew]);
    }
    return { creates, updates, isEmpty: creates.length === 0 && updates.length === 0 };
  }

  // ============================================================
  //  Microsoft Graph HTTP  (port from todo_client.py + auth.py)
  // ============================================================
  function authHeaders(token) {
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  }

  function fmtDue(dateStr, t) {
    return { dateTime: `${dateStr}T${fmtHourMinute(t)}:00`, timeZone: TIMEZONE };
  }

  async function listAllTasks(token, listId) {
    let url = `${GRAPH_BASE}/me/todo/lists/${listId}/tasks?$top=100&$filter=${encodeURIComponent("status ne 'completed'")}`;
    const out = [];
    while (url) {
      const r = await gm({ method: 'GET', url, headers: authHeaders(token) });
      if (r.status !== 200) throw new Error(`listAllTasks HTTP ${r.status}: ${r.responseText}`);
      const data = JSON.parse(r.responseText);
      for (const task of (data.value || [])) {
        const body = (task.body || {}).content || '';
        const dueStr = (task.dueDateTime || {}).dateTime;
        let dueDate = null, dueTime = null;
        if (dueStr) {
          const [d, tpart] = dueStr.split('T');
          dueDate = d;
          if (tpart) {
            const [hh, mm] = tpart.split(':').map(Number);
            dueTime = { h: hh || 0, m: mm || 0 };
          }
        }
        const markers = new Set();
        for (const m of body.matchAll(ORDER_MARKER_RE)) markers.add(m[1]);
        out.push({
          id: task.id,
          etag: task['@odata.etag'] || null,        // 【Bug A 用】
          title: task.title || '',
          body,
          dueDate,
          dueTime,
          markerOrderIds: markers,
        });
      }
      url = data['@odata.nextLink'] || null;
    }
    return out;
  }

  async function createTask(token, listId, bookings) {
    if (bookings.length === 0) throw new Error('createTask 需要至少一个 booking');
    const dates = new Set(bookings.map(b => b.bookingDate));
    if (dates.size !== 1) throw new Error(`bookings 必须同日，收到 ${[...dates]}`);
    const d = [...dates][0];
    const sorted = [...bookings].sort((a, b) => timeKey(a.startTime) - timeKey(b.startTime));
    const segs = sorted.map(bookingToSegment);
    const payload = {
      title: renderTitle(d, segs),
      body: { contentType: 'text', content: sorted.map(renderBlock).join('\n\n') },
      dueDateTime: fmtDue(d, sorted[0].startTime),
      isReminderOn: false,
    };
    const r = await gm({
      method: 'POST',
      url: `${GRAPH_BASE}/me/todo/lists/${listId}/tasks`,
      headers: authHeaders(token),
      data: JSON.stringify(payload),
    });
    if (r.status >= 200 && r.status < 300) return JSON.parse(r.responseText);
    throw new Error(`createTask HTTP ${r.status}: ${r.responseText}`);
  }

  // 【Bug A 修复】：PATCH 带 If-Match: existing.etag，412 时抛 etag conflict 让上层重试
  async function updateTaskMerge(token, listId, existing, inTitleOnly, trulyNew) {
    if (inTitleOnly.length === 0 && trulyNew.length === 0) return {};
    const newBody = computeAppendedBody(existing.body, [...inTitleOnly, ...trulyNew]);
    const payload = { body: { contentType: 'text', content: newBody } };
    const newTitle = computeMergedTitle(existing, trulyNew);
    if (newTitle !== null) payload.title = newTitle;
    const newDue = computeDueDateTime(existing, inTitleOnly, trulyNew);
    if (newDue) payload.dueDateTime = newDue;

    const headers = authHeaders(token);
    if (existing.etag) headers['If-Match'] = existing.etag;
    const r = await gm({
      method: 'PATCH',
      url: `${GRAPH_BASE}/me/todo/lists/${listId}/tasks/${existing.id}`,
      headers,
      data: JSON.stringify(payload),
    });
    if (r.status === 412) {
      const e = new Error('etag conflict');
      e.code = 412;
      throw e;
    }
    if (r.status >= 200 && r.status < 300) return JSON.parse(r.responseText);
    throw new Error(`updateTaskMerge HTTP ${r.status}: ${r.responseText}`);
  }

  async function applyChanges(plan, token, listId) {
    let created = 0, updated = 0;
    for (const [, books] of plan.creates) {
      await createTask(token, listId, books);
      created++;
    }
    for (const [existing, inTitle, trulyNew] of plan.updates) {
      await updateTaskMerge(token, listId, existing, inTitle, trulyNew);
      updated++;
    }
    return { created, updated };
  }

  // 复制到剪贴板：优先 navigator.clipboard，失败回退到隐藏 textarea + execCommand
  async function copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch { /* 回退 */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0;';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }

  // ============================================================
  //  OAuth: device code flow + refresh_token  (port from auth.py)
  // ============================================================
  async function deviceCodeLogin() {
    console.log('[sjtu-sync] 开始 device code flow');
    const r = await gm({
      method: 'POST',
      url: DEVICECODE_URL,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      data: urlencode({ client_id: CLIENT_ID, scope: SCOPES }),
    });
    if (r.status !== 200) throw new Error(`device code 请求失败 HTTP ${r.status}: ${r.responseText}`);
    const dev = JSON.parse(r.responseText);

    const copied = await copyToClipboard(dev.user_code);
    const copyTip = copied
      ? '\n     （已自动复制到剪贴板，直接 Ctrl+V 粘贴即可）'
      : '\n     （复制失败，请手动选中上面这串）';
    alert(
      '请按下面流程完成 Microsoft 一次性授权：\n\n' +
      '  1. 即将打开授权页：' + dev.verification_uri + '\n' +
      '  2. 输入验证码：' + dev.user_code + copyTip + '\n' +
      '  3. 用能读写"网球" To-Do 列表的微软账号授权\n' +
      '  4. 授权完成后回到本页，本脚本会自动继续\n\n' +
      '点确定开始轮询。'
    );
    window.open(dev.verification_uri, '_blank');

    let interval = dev.interval || 5;
    const deadline = Date.now() + (dev.expires_in || 900) * 1000;
    while (Date.now() < deadline) {
      await sleep(interval * 1000);
      const tr = await gm({
        method: 'POST',
        url: TOKEN_URL,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        data: urlencode({
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          client_id: CLIENT_ID,
          device_code: dev.device_code,
        }),
      });
      if (tr.status === 200) {
        const tok = JSON.parse(tr.responseText);
        await GM.setValue('refresh_token', tok.refresh_token);
        console.log('[sjtu-sync] device code 授权成功');
        alert('Microsoft 授权成功！refresh_token 已保存。');
        return;
      }
      const err = JSON.parse(tr.responseText);
      if (err.error === 'authorization_pending') continue;
      if (err.error === 'slow_down') { interval += 5; continue; }
      throw new Error('device code 授权失败：' + (err.error_description || err.error));
    }
    throw new Error('device code 授权超时');
  }

  async function getAccessToken() {
    let rt = await GM.getValue('refresh_token', '');
    if (!rt) {
      await deviceCodeLogin();
      rt = await GM.getValue('refresh_token', '');
    }
    const r = await gm({
      method: 'POST',
      url: TOKEN_URL,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      data: urlencode({
        grant_type: 'refresh_token',
        client_id: CLIENT_ID,
        scope: SCOPES,
        refresh_token: rt,
      }),
    });
    if (r.status !== 200) {
      console.warn('[sjtu-sync] refresh_token 失效，重新走 device code flow');
      await GM.deleteValue('refresh_token');
      await deviceCodeLogin();
      return getAccessToken();
    }
    const tok = JSON.parse(r.responseText);
    if (tok.refresh_token && tok.refresh_token !== rt) {
      await GM.setValue('refresh_token', tok.refresh_token);
    }
    return tok.access_token;
  }

  // ============================================================
  //  TODO_LIST_ID 配置（首次弹框；存 GM.setValue）
  // ============================================================
  async function getListId() {
    let id = await GM.getValue('todo_list_id', '');
    let openedTab = false;
    while (!id || !id.trim()) {
      if (!openedTab) {
        // 自动开 To-Do 网页方便复制 ID
        window.open('https://to-do.live.com/tasks/', '_blank');
        openedTab = true;
      }
      id = prompt(
        '请输入 Microsoft To-Do 共享列表的 ID：\n\n' +
        '已为你打开 To-Do 官网新标签页。请：\n' +
        '  1. 在新标签页登录后，点击你和同伴共享的"网球"列表\n' +
        '  2. 复制地址栏 URL 里 /tasks/ 后面那段 base64 字符串\n' +
        '  3. 粘到下面输入框\n\n' +
        '你也可以直接粘整个 URL，脚本会自动提取 ID。'
      );
      if (id === null) throw new Error('用户取消 list_id 输入');
      id = id.trim();
      // 用户粘了完整 URL 时，自动提取 /tasks/ 后那段
      const urlMatch = id.match(/\/tasks\/([^/?#]+)/);
      if (urlMatch) id = urlMatch[1];
    }
    await GM.setValue('todo_list_id', id);
    return id;
  }

  // ============================================================
  //  SJTU 订单 fetch（同源；浏览器自动注入 cookie 含 HttpOnly）
  // ============================================================
  async function fetchSjtuOrders() {
    const r = await fetch(ORDER_URL, { credentials: 'include', headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error(`SJTU fetch HTTP ${r.status}`);
    const data = await r.json();
    if (data && typeof data.code === 'number' && data.code !== 0) {
      throw new Error(`SJTU code=${data.code} msg=${data.msg || ''}`);
    }
    return data.records || [];
  }

  // ============================================================
  //  主同步流程
  // ============================================================
  async function syncOnce(reason) {
    let records;
    try {
      records = await fetchSjtuOrders();
    } catch (e) {
      console.warn(`[sjtu-sync] (${reason}) 抓 SJTU 订单失败：`, e.message);
      return;
    }
    const orders = parseOrders(records, new Date());
    console.log(`[sjtu-sync] (${reason}) ${records.length} records → ${orders.length} pending orders`);
    if (orders.length === 0) return;

    let listId, token;
    try {
      listId = await getListId();
      token  = await getAccessToken();
    } catch (e) {
      console.error(`[sjtu-sync] (${reason}) 配置/授权失败：`, e.message);
      return;
    }

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const allTasks = await listAllTasks(token, listId);

        // === 段 A：listAllTasks 概要 ===
        const allMarkerOrderIds = new Set();
        for (const t of allTasks) for (const id of t.markerOrderIds) allMarkerOrderIds.add(id);
        console.log(`[sjtu-sync] (${reason}) listAllTasks: ${allTasks.length} tasks, ${allMarkerOrderIds.size} unique markers`);
        console.log(`[sjtu-sync] (${reason}) tasks:`, allTasks.map(t => ({
          idTail: t.id.slice(-8),
          title: (t.title || '').slice(0, 40),
          dueDate: t.dueDate,
          markerCount: t.markerOrderIds.size,
          markerSample: [...t.markerOrderIds].slice(0, 3),
        })));

        // === 段 B：managed filter 诊断（业务逻辑不变） ===
        // 用户的逻辑：按标题前缀 🎾M.D 识别脚本管理任务（含 partner 用同格式手输的）
        // 不再要求 marker 存在；marker 只用于"哪些 booking 已登记过"的去重
        const managed = [];
        const skippedFromManaged = [];
        for (const t of allTasks) {
          const titleOk = TITLE_DATE_RE.test(t.title || '');
          const dueOk   = !!t.dueDate;
          if (titleOk && dueOk) {
            managed.push(t);
          } else {
            skippedFromManaged.push({
              idTail: t.id.slice(-8),
              title: (t.title || '').slice(0, 40),
              dueDate: t.dueDate,
              markerCount: t.markerOrderIds.size,
              reason: !titleOk ? 'title-mismatch' : 'no-dueDate',
            });
          }
        }
        console.log(`[sjtu-sync] (${reason}) managed=${managed.length}, skipped=${skippedFromManaged.length}`);
        if (skippedFromManaged.length) {
          console.log(`[sjtu-sync] (${reason}) skipped from managed:`, skippedFromManaged);
        }
        console.log(`[sjtu-sync] (${reason}) managed list:`, managed.map(t => ({
          idTail: t.id.slice(-8),
          title: (t.title || '').slice(0, 40),
          dueDate: t.dueDate,
          markers: [...t.markerOrderIds],
        })));

        // === 段 C：SJTU 日期 vs managed 匹配关系 ===
        const pendingByDate = gatherPending(orders);
        for (const [d, os] of pendingByDate) {
          const hit = managed.find(t => t.dueDate === d);
          const orderIds = os.map(o => o.orderId);
          if (hit) {
            console.log(`[sjtu-sync] (${reason}) SJTU date=${d} orders=${JSON.stringify(orderIds)} → 匹配 task ...${hit.id.slice(-8)} (markers=${JSON.stringify([...hit.markerOrderIds])})`);
          } else {
            console.log(`[sjtu-sync] (${reason}) SJTU date=${d} orders=${JSON.stringify(orderIds)} → 【无 managed 任务匹配 → 即将走 creates 分支】`);
          }
        }

        const plan = planChanges(pendingByDate, managed);

        // === 段 D：plan 内容 ===
        if (plan.creates.length) {
          console.log(`[sjtu-sync] (${reason}) plan.creates:`, plan.creates.map(([d, bs]) => ({
            date: d, count: bs.length, orderIds: bs.map(b => b.orderId),
          })));
        }
        if (plan.updates.length) {
          console.log(`[sjtu-sync] (${reason}) plan.updates:`, plan.updates.map(([t, inT, tn]) => ({
            taskIdTail: t.id.slice(-8),
            inTitleOnly: inT.length,
            trulyNewOrderIds: tn.map(b => b.orderId),
          })));
        }

        if (plan.isEmpty) {
          console.log(`[sjtu-sync] (${reason}) no changes`);
          return;
        }
        const result = await applyChanges(plan, token, listId);
        console.log(`[sjtu-sync] (${reason}) done: ${result.created} created, ${result.updated} updated`);
        return;
      } catch (e) {
        if (e.code === 412) {
          console.warn(`[sjtu-sync] (${reason}) ETag 冲突，重试 ${attempt + 1}/3`);
          continue;
        }
        console.error(`[sjtu-sync] (${reason}) 同步出错：`, e);
        return;
      }
    }
    console.error(`[sjtu-sync] (${reason}) ETag 重试用尽，放弃本轮`);
  }

  // 同 tab 内并发保护（多次 hashchange 紧挨着不会重入）
  let _running = false;
  async function syncOnceGuarded(reason) {
    if (_running) {
      console.log(`[sjtu-sync] (${reason}) 跳过：上一次同步还在跑`);
      return;
    }
    _running = true;
    try { await syncOnce(reason); }
    finally { _running = false; }
  }

  // ============================================================
  //  路由触发
  // ============================================================
  function maybeSync(reason) {
    const h = location.hash || '';
    if (h.includes('paymentResult/1')) {
      // 给 SJTU 后端 ~1.5s 落库
      setTimeout(() => syncOnceGuarded('payment'), 1500);
    } else if (/^#\/Order(\?|$|\/)/.test(h)) {
      syncOnceGuarded(reason);
    }
  }

  // Tampermonkey 菜单：手动入口
  GM.registerMenuCommand('立即同步一次',          () => syncOnceGuarded('manual'));
  GM.registerMenuCommand('重新授权 Microsoft',    async () => {
    await GM.deleteValue('refresh_token');
    alert('已清除旧 refresh_token。下次同步将弹窗走 device code 重新授权。');
  });
  GM.registerMenuCommand('重置 To-Do 列表 ID',    async () => {
    await GM.deleteValue('todo_list_id');
    alert('已清除 list_id。下次同步会弹框要求重新输入。');
  });
  GM.registerMenuCommand('重置全部配置',          async () => {
    if (confirm('清空 refresh_token 和 list_id？下次访问 SJTU 页时会全部重新配置。')) {
      await GM.deleteValue('refresh_token');
      await GM.deleteValue('todo_list_id');
      alert('已重置。');
    }
  });

  // 初次加载触发；hashchange 触发；5min 心跳兜底
  maybeSync('load');
  window.addEventListener('hashchange', () => maybeSync('hashchange'));
  setInterval(() => maybeSync('heartbeat'), 5 * 60 * 1000);
})();
