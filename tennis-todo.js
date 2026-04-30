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
// @version      9
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
  const ORDER_PAGE_SIZE = 50;
  const MAX_ORDER_PAGES = 20;
  const TIMEZONE       = 'China Standard Time';

  const ORDER_MARKER_RE = /\[sjtu-order:([^\]]+)\]/g;
  const BODY_DATE_RE    = /^日期：(\d{4}-\d{1,2}-\d{1,2})\b/m;
  const TITLE_SEG_RE    = /([一-鿿])(\d+(?:[\/\-]\d+)*)\s+(\d{1,2}(?::\d{2})?)-(\d{1,2}(?::\d{2})?)/g;
  const TITLE_DATE_RE   = /^🎾(\d{1,2})\.(\d{1,2})\b/u;   // 标题前缀，识别脚本管理任务
  const SPACE_INFO_RE   = /网球 场地(\d+)\s*\((\d{1,2}:\d{2})-(\d{1,2}:\d{2})\)/;
  const WEEKDAYS_CN     = ['星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日'];

  // ============================================================
  //  通用工具
  // ============================================================
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function urlencode(obj) {
    return Object.entries(obj)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
  }

  function tryParseJson(text) {
    try { return JSON.parse(text); }
    catch { return null; }
  }

  function parseJsonResponse(response) {
    return JSON.parse(response.responseText);
  }

  function createTextBody(content) {
    return { contentType: 'text', content };
  }

  function normalizeDateString(value) {
    if (!value) return null;
    const datePart = String(value).trim().split('T')[0];
    const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(datePart);
    if (!m) return null;
    return `${m[1]}-${pad2(Number(m[2]))}-${pad2(Number(m[3]))}`;
  }

  function normalizeTaskBody(body, contentType) {
    let text = String(body || '');
    const looksHtml = String(contentType || '').toLowerCase() === 'html' || /<[^>]+>/.test(text);
    if (looksHtml) {
      text = text
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(div|p|li|tr|h[1-6])>/gi, '\n');
      text = new DOMParser().parseFromString(text, 'text/html').body.textContent || '';
    }
    return text.replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ').trim();
  }

  function extractMarkerOrderIds(text) {
    const markers = new Set();
    for (const [, orderId] of String(text || '').matchAll(ORDER_MARKER_RE)) markers.add(orderId);
    return markers;
  }

  function looksLikeManagedBody(text) {
    return ['日期：', '场馆：', '场地：', '时段：'].every(part => String(text || '').includes(part));
  }

  function parseTitleDateKey(title, now = new Date()) {
    const m = TITLE_DATE_RE.exec(String(title || ''));
    if (!m) return null;
    const today = new Date(`${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}T00:00:00`);
    const pick = year => normalizeDateString(`${year}-${m[1]}-${m[2]}`);
    let candidate = pick(today.getFullYear());
    if (!candidate) return null;
    const deltaDays = Math.round((new Date(`${candidate}T00:00:00`) - today) / 86400000);
    if (deltaDays < -180) candidate = pick(today.getFullYear() + 1);
    else if (deltaDays > 180) candidate = pick(today.getFullYear() - 1);
    return candidate;
  }

  function parseBodyDateKey(text) {
    const m = BODY_DATE_RE.exec(String(text || ''));
    return m ? normalizeDateString(m[1]) : null;
  }

  // 用 body、title、dueDate 推断任务日期。
  function getTaskDateKey(title, body, dueDate) {
    return parseBodyDateKey(body) || parseTitleDateKey(title) || normalizeDateString(dueDate);
  }

  function parseDueDateTime(dueDateTime) {
    const dueStr = dueDateTime && dueDateTime.dateTime;
    const dueDate = normalizeDateString(dueStr);
    if (!dueDate) return { dueDate: null, dueTime: null };
    const timeMatch = /T(\d{1,2}):(\d{2})/.exec(String(dueStr));
    return {
      dueDate,
      dueTime: timeMatch ? { h: Number(timeMatch[1]), m: Number(timeMatch[2]) } : null,
    };
  }

  function parseGraphTask(task) {
    const body = normalizeTaskBody((task.body || {}).content, (task.body || {}).contentType);
    const { dueDate, dueTime } = parseDueDateTime(task.dueDateTime);
    const title = String(task.title || '').trim();
    return {
      id: task.id,
      etag: task['@odata.etag'] || null,
      title,
      body,
      dueDate,
      dueTime,
      dateKey: getTaskDateKey(title, body, dueDate),
      markerOrderIds: extractMarkerOrderIds(body),
    };
  }

  function summarizeTask(task) {
    return {
      idTail: task.id.slice(-8),
      title: (task.title || '').slice(0, 40),
      dateKey: task.dateKey,
      dueDate: task.dueDate,
      markerCount: task.markerOrderIds.size,
    };
  }

  function summarizeTaskWith(task, extra) {
    return { ...summarizeTask(task), ...extra };
  }

  function collectMarkerOrderIds(tasks) {
    const allMarkerOrderIds = new Set();
    for (const task of tasks) {
      for (const orderId of task.markerOrderIds) allMarkerOrderIds.add(orderId);
    }
    return allMarkerOrderIds;
  }

  // 判断一个任务是否应被脚本接管。
  function getManagedSkipReason(task) {
    if (task.markerOrderIds.size > 0) return task.dateKey ? null : 'no-date';
    if (!TITLE_DATE_RE.test(task.title || '')) return 'title-mismatch';
    if (!task.dateKey) return 'no-date';
    if (!looksLikeManagedBody(task.body)) return 'no-marker';
    return null;
  }

  function getExistingDateKey(existing) {
    return existing.dateKey || existing.dueDate;
  }

  function splitManagedTasks(tasks) {
    const managed = [];
    const skipped = [];
    for (const task of tasks) {
      const reason = getManagedSkipReason(task);
      if (!reason) {
        managed.push(task);
        continue;
      }
      skipped.push(summarizeTaskWith(task, { reason }));
    }
    return { managed, skipped };
  }

  function logTaskScan(reason, tasks) {
    const allMarkerOrderIds = collectMarkerOrderIds(tasks);
    console.log(`[sjtu-sync] (${reason}) listAllTasks: ${tasks.length} tasks, ${allMarkerOrderIds.size} unique markers`);
    console.log(`[sjtu-sync] (${reason}) tasks:`, tasks.map(task => summarizeTaskWith(task, {
      markerSample: [...task.markerOrderIds].slice(0, 3),
    })));
  }

  function logManagedScan(reason, managed, skipped) {
    console.log(`[sjtu-sync] (${reason}) managed=${managed.length}, skipped=${skipped.length}`);
    if (skipped.length) {
      console.log(`[sjtu-sync] (${reason}) skipped from managed:`, skipped);
    }
    console.log(`[sjtu-sync] (${reason}) managed list:`, managed.map(task => summarizeTaskWith(task, {
      markers: [...task.markerOrderIds],
    })));
  }

  function logPendingMatches(reason, pendingByDate, managed) {
    for (const [dateKey, orders] of pendingByDate) {
      const hit = managed.find(task => task.dateKey === dateKey);
      const orderIds = orders.map(order => order.orderId);
      if (hit) {
        console.log(`[sjtu-sync] (${reason}) SJTU date=${dateKey} orders=${JSON.stringify(orderIds)} → 匹配 task ...${hit.id.slice(-8)} (markers=${JSON.stringify([...hit.markerOrderIds])})`);
      } else {
        console.log(`[sjtu-sync] (${reason}) SJTU date=${dateKey} orders=${JSON.stringify(orderIds)} → 【无 managed 任务匹配 → 即将走 creates 分支】`);
      }
    }
  }

  function buildOrderUrl(pageNo) {
    return `/venue/personal/personalOrderlist?pageNo=${pageNo}&pageSize=${ORDER_PAGE_SIZE}`;
  }

  function extractOrderId(record) {
    return record && record.pOrderid != null ? String(record.pOrderid) : null;
  }

  // 把 GM.xmlHttpRequest 包成 Promise。
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
  //  时间和日期工具
  //    Time: { h, m }
  //    Date: YYYY-MM-DD
  // ============================================================
  function fmtHour(t)        { return t.m === 0 ? String(t.h) : `${pad2(t.h)}:${pad2(t.m)}`; }
  function fmtHourMinute(t)  { return `${pad2(t.h)}:${pad2(t.m)}`; }
  function pad2(n)           { return String(n).padStart(2, '0'); }
  function timeKey(t)        { return t.h * 60 + t.m; }
  function fromKey(k)        { return { h: Math.floor(k / 60), m: k % 60 }; }
  function sortByStartTime(items) {
    return [...items].sort((a, b) => timeKey(a.startTime) - timeKey(b.startTime));
  }

  function parseTimeToken(s) {
    if (s.includes(':')) {
      const [h, m] = s.split(':').map(Number);
      return { h, m };
    }
    return { h: Number(s), m: 0 };
  }

  function dateAtTime(dateStr, t) {
    const normalized = normalizeDateString(dateStr);
    return new Date(`${normalized}T${pad2(t.h)}:${pad2(t.m)}:00`);
  }

  function weekdayCN(dateStr) {
    const normalized = normalizeDateString(dateStr);
    const wd = (new Date(normalized + 'T00:00:00').getDay() + 6) % 7;  // 周一=0
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
  //  SJTU 订单解析
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
    const bookingDate = normalizeDateString(rec.scDate);
    if (!bookingDate) throw new Error(`无法解析 scDate: ${rec.scDate}`);
    return {
      orderId:     extractOrderId(rec),
      venue:       rec.venuename,
      courtNo,
      bookingDate,
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
  //  标题、正文和合并逻辑
  // ============================================================
  function renderSegmentStr(s) {
    return `${s.venueShort}${s.courtToken} ${fmtHour(s.startTime)}-${fmtHour(s.endTime)}`;
  }

  function renderTitle(dateStr, segs) {
    const [, m, d] = dateStr.split('-').map(Number);
    const sorted = sortByStartTime(segs);
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
    const sorted = sortByStartTime(newSegs);
    const tail = sorted.map(renderSegmentStr).join(' ');
    return (existingTitle.trimEnd() + ' ' + tail).trim();
  }

  function computeMergedTitle(existing, trulyNew) {
    if (trulyNew.length === 0) return null;
    const newSegs = trulyNew.map(bookingToSegment);
    const dateKey = getExistingDateKey(existing);
    if (!dateKey) return appendSegments(existing.title, newSegs);
    const existingSegs = parseTitleSegments(existing.title);
    if (existingSegs.length > 0) {
      return renderTitle(dateKey, [...existingSegs, ...newSegs]);
    }
    return appendSegments(existing.title, newSegs);
  }

  function computeAppendedBody(existingBody, allNew) {
    const sorted = sortByStartTime(allNew);
    const appended = sorted.map(renderBlock).join('\n\n');
    if ((existingBody || '').trim()) return existingBody.trimEnd() + '\n\n' + appended;
    return appended;
  }

  // 合并后把 dueDateTime 调整到当天最早时段。
  function computeDueDateTime(existing, inTitleOnly, trulyNew) {
    const dateKey = getExistingDateKey(existing);
    if (!dateKey) return null;
    if (inTitleOnly.length === 0 && trulyNew.length === 0) return null;
    const starts = [];
    for (const s of parseTitleSegments(existing.title)) starts.push(timeKey(s.startTime));
    if (existing.dueTime) starts.push(timeKey(existing.dueTime));
    for (const b of inTitleOnly) starts.push(timeKey(b.startTime));
    for (const b of trulyNew)    starts.push(timeKey(b.startTime));
    if (starts.length === 0) return null;
    const min = Math.min(...starts);
    return {
      dateTime: `${dateKey}T${fmtHourMinute(fromKey(min))}:00`,
      timeZone: TIMEZONE,
    };
  }

  // ============================================================
  //  计算 create / update 计划
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

  // 把任务按日期和订单号建索引，方便后续匹配。
  function buildManagedTaskIndexes(managedTasks) {
    const byDate = new Map();
    const byOrderId = new Map();
    for (const task of managedTasks) {
      for (const orderId of task.markerOrderIds) {
        if (!byOrderId.has(orderId)) byOrderId.set(orderId, task);
      }
      if (!task.dateKey) continue;
      if (byDate.has(task.dateKey)) {
        console.warn(`[sjtu-sync] 同日多条 marker 任务 ${task.dateKey}，仅以先出现的为准`);
        continue;
      }
      byDate.set(task.dateKey, task);
    }
    return { byDate, byOrderId };
  }

  function selectExistingTask(dateKey, orders, byDate, byOrderId) {
    return byDate.get(dateKey) || orders.map(order => byOrderId.get(order.orderId)).find(Boolean);
  }

  // 把订单拆成“标题里已有”和“真正新增”两类。
  function splitOrdersForUpdate(orders, existing, byOrderId) {
    const inTitle = [];
    const trulyNew = [];
    for (const order of orders) {
      const owner = byOrderId.get(order.orderId);
      if (owner) {
        if (owner.id !== existing.id) {
          console.warn(`[sjtu-sync] 订单 ${order.orderId} 已存在于 task ...${owner.id.slice(-8)}，跳过重复创建`);
        }
        continue;
      }
      const booking = bookingFromOrder(order);
      if (visualMatchInTitle(existing.title, booking)) inTitle.push(booking);
      else trulyNew.push(booking);
    }
    return { inTitle, trulyNew };
  }

  function planChanges(pendingByDate, managedTasks) {
    const { byDate, byOrderId } = buildManagedTaskIndexes(managedTasks);
    const creates = [], updates = [];
    for (const dateKey of [...pendingByDate.keys()].sort()) {
      const orders = pendingByDate.get(dateKey);
      const existing = selectExistingTask(dateKey, orders, byDate, byOrderId);
      if (!existing) {
        creates.push([dateKey, orders.map(bookingFromOrder)]);
        continue;
      }

      const { inTitle, trulyNew } = splitOrdersForUpdate(orders, existing, byOrderId);
      if (inTitle.length || trulyNew.length) updates.push([existing, inTitle, trulyNew]);
    }
    return { creates, updates, isEmpty: creates.length === 0 && updates.length === 0 };
  }

  // ============================================================
  //  Microsoft Graph 请求
  // ============================================================
  function authHeaders(token) {
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  }

  function fmtDue(dateStr, t) {
    const normalized = normalizeDateString(dateStr);
    if (!normalized) throw new Error(`无法渲染 dueDate: ${dateStr}`);
    return { dateTime: `${normalized}T${fmtHourMinute(t)}:00`, timeZone: TIMEZONE };
  }

  async function listAllTasks(token, listId) {
    let url = `${GRAPH_BASE}/me/todo/lists/${listId}/tasks?$top=100&$filter=${encodeURIComponent("status ne 'completed'")}`;
    const out = [];
    while (url) {
      const r = await gm({ method: 'GET', url, headers: authHeaders(token) });
      if (r.status !== 200) throw new Error(`listAllTasks HTTP ${r.status}: ${r.responseText}`);
      const data = parseJsonResponse(r);
      for (const task of (data.value || [])) out.push(parseGraphTask(task));
      url = data['@odata.nextLink'] || null;
    }
    return out;
  }

  async function createTask(token, listId, bookings) {
    if (bookings.length === 0) throw new Error('createTask 需要至少一个 booking');
    const dates = new Set(bookings.map(b => b.bookingDate));
    if (dates.size !== 1) throw new Error(`bookings 必须同日，收到 ${[...dates]}`);
    const d = [...dates][0];
    const sorted = sortByStartTime(bookings);
    const segs = sorted.map(bookingToSegment);
    const payload = {
      title: renderTitle(d, segs),
      body: createTextBody(sorted.map(renderBlock).join('\n\n')),
      dueDateTime: fmtDue(d, sorted[0].startTime),
      isReminderOn: false,
    };
    const r = await gm({
      method: 'POST',
      url: `${GRAPH_BASE}/me/todo/lists/${listId}/tasks`,
      headers: authHeaders(token),
      data: JSON.stringify(payload),
    });
    if (r.status >= 200 && r.status < 300) return parseJsonResponse(r);
    throw new Error(`createTask HTTP ${r.status}: ${r.responseText}`);
  }

  // 带 ETag 更新任务；412 交给上层重试。
  async function updateTaskMerge(token, listId, existing, inTitleOnly, trulyNew) {
    if (inTitleOnly.length === 0 && trulyNew.length === 0) return {};
    const newBody = computeAppendedBody(existing.body, [...inTitleOnly, ...trulyNew]);
    const payload = { body: createTextBody(newBody) };
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
    if (r.status >= 200 && r.status < 300) return parseJsonResponse(r);
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

  // 复制到剪贴板；失败时回退到隐藏 textarea。
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
  //  Microsoft 授权
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
    const dev = parseJsonResponse(r);

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
        const tok = parseJsonResponse(tr);
        await GM.setValue('refresh_token', tok.refresh_token);
        console.log('[sjtu-sync] device code 授权成功');
        alert('Microsoft 授权成功！refresh_token 已保存。');
        return;
      }
      const err = parseJsonResponse(tr);
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
      const err = tryParseJson(r.responseText);
      const invalidGrant = r.status === 400 && err && err.error === 'invalid_grant';
      if (invalidGrant) {
        console.warn('[sjtu-sync] refresh_token 已失效，重新走 device code flow');
        await GM.deleteValue('refresh_token');
        await deviceCodeLogin();
        return getAccessToken();
      }
      throw new Error(`refresh_token 刷新失败 HTTP ${r.status}: ${(err && (err.error_description || err.error)) || r.responseText}`);
    }
    const tok = parseJsonResponse(r);
    if (tok.refresh_token && tok.refresh_token !== rt) {
      await GM.setValue('refresh_token', tok.refresh_token);
    }
    return tok.access_token;
  }

  // ============================================================
  //  To Do 列表 ID 配置
  // ============================================================
  async function getListId() {
    let id = await GM.getValue('todo_list_id', '');
    let openedTab = false;
    while (!id || !id.trim()) {
      if (!openedTab) {
        // 打开 To Do 页面方便复制 ID。
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
      // 支持直接粘贴整个 URL。
      const urlMatch = id.match(/\/tasks\/([^/?#]+)/);
      if (urlMatch) id = urlMatch[1];
    }
    await GM.setValue('todo_list_id', id);
    return id;
  }

  // ============================================================
  //  抓取 SJTU 订单
  // ============================================================
  async function fetchSjtuOrders() {
    const allRecords = [];
    const seenOrderIds = new Set();

    for (let pageNo = 1; pageNo <= MAX_ORDER_PAGES; pageNo++) {
      const r = await fetch(buildOrderUrl(pageNo), { credentials: 'include', headers: { Accept: 'application/json' } });
      if (!r.ok) throw new Error(`SJTU fetch HTTP ${r.status}`);
      const data = await r.json();
      if (data && typeof data.code === 'number' && data.code !== 0) {
        throw new Error(`SJTU code=${data.code} msg=${data.msg || ''}`);
      }

      const pageRecords = Array.isArray(data.records) ? data.records : [];
      let newlyAdded = 0;
      for (const rec of pageRecords) {
        const orderId = extractOrderId(rec);
        if (orderId && seenOrderIds.has(orderId)) continue;
        if (orderId) seenOrderIds.add(orderId);
        allRecords.push(rec);
        newlyAdded++;
      }

      if (pageRecords.length < ORDER_PAGE_SIZE) break;
      if (newlyAdded === 0) {
        console.warn(`[sjtu-sync] SJTU 第 ${pageNo} 页未返回新记录，提前停止翻页`);
        break;
      }
      if (pageNo === MAX_ORDER_PAGES) {
        console.warn(`[sjtu-sync] SJTU 翻页达到上限 ${MAX_ORDER_PAGES}，可能仍有未抓取记录`);
      }
    }

    return allRecords;
  }

  // 打印任务扫描结果和匹配计划，方便排查同步问题。
  function logPlan(reason, plan) {
    if (plan.creates.length) {
      console.log(`[sjtu-sync] (${reason}) plan.creates:`, plan.creates.map(([dateKey, bookings]) => ({
        date: dateKey,
        count: bookings.length,
        orderIds: bookings.map(booking => booking.orderId),
      })));
    }
    if (plan.updates.length) {
      console.log(`[sjtu-sync] (${reason}) plan.updates:`, plan.updates.map(([task, inTitleOnly, trulyNew]) => ({
        taskIdTail: task.id.slice(-8),
        inTitleOnly: inTitleOnly.length,
        trulyNewOrderIds: trulyNew.map(booking => booking.orderId),
      })));
    }
  }

  function registerMenuCommands(commands) {
    for (const [label, handler] of commands) {
      GM.registerMenuCommand(label, handler);
    }
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
        logTaskScan(reason, allTasks);
        const { managed, skipped: skippedFromManaged } = splitManagedTasks(allTasks);
        logManagedScan(reason, managed, skippedFromManaged);
        const pendingByDate = gatherPending(orders);
        logPendingMatches(reason, pendingByDate, managed);

        const plan = planChanges(pendingByDate, managed);
        logPlan(reason, plan);

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

  // 当前页面内避免并发同步。
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
  //  根据路由决定是否同步
  // ============================================================
  function maybeSync(reason) {
    const h = location.hash || '';
    if (h.includes('paymentResult/1')) {
      // 等订单落库后再同步。
      setTimeout(() => syncOnceGuarded('payment'), 1500);
    } else if (/^#\/Order(\?|$|\/)/.test(h)) {
      syncOnceGuarded(reason);
    }
  }

  // Tampermonkey 菜单。
  registerMenuCommands([
    ['立即同步一次', () => syncOnceGuarded('manual')],
    ['重新授权 Microsoft', async () => {
      await GM.deleteValue('refresh_token');
      alert('已清除旧 refresh_token。下次同步将弹窗走 device code 重新授权。');
    }],
    ['重置 To-Do 列表 ID', async () => {
      await GM.deleteValue('todo_list_id');
      alert('已清除 list_id。下次同步会弹框要求重新输入。');
    }],
    ['重置全部配置', async () => {
      if (confirm('清空 refresh_token 和 list_id？下次访问 SJTU 页时会全部重新配置。')) {
        await GM.deleteValue('refresh_token');
        await GM.deleteValue('todo_list_id');
        alert('已重置。');
      }
    }],
  ]);

  // 页面加载、路由变化和心跳时触发。
  maybeSync('load');
  window.addEventListener('hashchange', () => maybeSync('hashchange'));
  setInterval(() => maybeSync('heartbeat'), 5 * 60 * 1000);
})();
