// ==UserScript==
// @name         SJTU → Microsoft To-Do 自动同步
// @namespace    tennis-todo
// @match        https://sports.sjtu.edu.cn/*
// @grant        GM.xmlHttpRequest
// @connect      127.0.0.1
// @run-at       document-idle
// @version      4
// @description  在 SJTU 页面同源 fetch 个人订单 API（带 HttpOnly cookie），把 records 推到本地 server 触发同步
// ==/UserScript==

(function () {
  'use strict';

  // ↓↓↓ 必须跟 config.py 里的 LOCAL_SERVER_TOKEN 完全一致 ↓↓↓
  const TOKEN     = 'PASTE_YOUR_TOKEN_HERE';
  const SERVER    = 'http://127.0.0.1:5454';
  // 第一页 10 条 = SJTU 网页默认条数；未核销订单一般 ≤3，10 已足够覆盖
  const ORDER_URL = '/venue/personal/personalOrderlist?pageNo=1&pageSize=10';

  async function fetchOrders() {
    const r = await fetch(ORDER_URL, {
      credentials: 'include',
      headers: { 'Accept': 'application/json' },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    if (data && typeof data.code === 'number' && data.code !== 0) {
      throw new Error(`SJTU code=${data.code} msg=${data.msg || ''}`);
    }
    return data.records || [];
  }

  function pushRecords(records, reason) {
    GM.xmlHttpRequest({
      method:  'POST',
      url:     SERVER + '/sync',
      headers: { 'X-Token': TOKEN, 'Content-Type': 'application/json' },
      data:    JSON.stringify({ records }),
      onload:  rsp => console.log(
        `[sjtu-sync] /sync (${reason}) → HTTP ${rsp.status}, pushed ${records.length} records`
      ),
      onerror: e => console.warn('[sjtu-sync] POST /sync 网络错误：', e),
    });
  }

  async function syncOnce(reason) {
    let records;
    try {
      records = await fetchOrders();
    } catch (e) {
      console.warn(`[sjtu-sync] fetch orders 失败（${reason}）：`, e);
      return;
    }
    pushRecords(records, reason);
  }

  // 触发场景：进入支付成功页 / 我的订单页 / 心跳
  function maybeSync(reason) {
    const h = location.hash || '';
    if (h.includes('paymentResult/1')) {
      // 给 SJTU 后端 ~1.5s 把新订单落库
      setTimeout(() => syncOnce('payment'), 1500);
    } else if (/^#\/Order(\?|$|\/)/.test(h)) {
      syncOnce(reason);
    }
  }

  maybeSync('load');
  window.addEventListener('hashchange', () => maybeSync('hashchange'));

  // 心跳：长时间挂在 SJTU 页面时，每 5min 主动对一次账
  setInterval(() => syncOnce('heartbeat'), 5 * 60 * 1000);
})();
