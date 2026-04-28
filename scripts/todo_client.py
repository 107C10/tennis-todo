"""Microsoft Graph To-Do 客户端：仅 HTTP 调用。

【安全约束】
  - GET   读任务列表
  - POST  创建新任务
  - PATCH 修改已有任务（仅在 sync 流程明确决定要合并时；从不修改 due_date 之外
          没有 SJTU 待打订单匹配的任务）
  - 绝不实现 DELETE — 共享列表中失效订单仅作告警

纯逻辑（标题/body 渲染、解析、合并决策）见 merge.py。
"""
from __future__ import annotations

from datetime import date, datetime, time

import requests

from merge import (
    BookingInfo,
    ORDER_MARKER_RE,
    TaskState,
    booking_to_segment,
    compute_appended_body,
    compute_merged_title,
    parse_title_segments,
    render_block,
    render_title,
)

GRAPH_BASE = "https://graph.microsoft.com/v1.0"
CN_TZ = "China Standard Time"


def _headers(access_token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {access_token}", "Content-Type": "application/json"}


def _fmt_due(d: date, t: time) -> dict[str, str]:
    return {
        "dateTime": datetime.combine(d, t).strftime("%Y-%m-%dT%H:%M:%S"),
        "timeZone": CN_TZ,
    }


def list_all_tasks(access_token: str, list_id: str) -> list[TaskState]:
    """读取列表中所有「未完成」的任务（status ne 'completed'）。

    已 completed 的任务对同步无意义（不会再合并），过滤掉减少传输与解析。
    含/不含 marker 不在这里过滤，留给 sync 层决定。
    """
    url = (
        f"{GRAPH_BASE}/me/todo/lists/{list_id}/tasks"
        f"?$top=100&$filter=status%20ne%20%27completed%27"
    )
    out: list[TaskState] = []
    while url:
        resp = requests.get(url, headers=_headers(access_token), timeout=30)
        resp.raise_for_status()
        data = resp.json()
        for task in data.get("value", []):
            body = (task.get("body") or {}).get("content", "")
            due_str = (task.get("dueDateTime") or {}).get("dateTime")
            due_date: date | None = None
            if due_str:
                try:
                    due_date = datetime.fromisoformat(due_str.split("T")[0]).date()
                except (ValueError, IndexError):
                    pass
            out.append(TaskState(
                id=task["id"],
                title=task.get("title", ""),
                body=body,
                due_date=due_date,
                marker_order_ids=set(ORDER_MARKER_RE.findall(body)),
            ))
        url = data.get("@odata.nextLink")
    return out


def create_task(access_token: str, list_id: str, bookings: list[BookingInfo]) -> dict:
    """为同一日期的若干预订创建一条新任务。"""
    if not bookings:
        raise ValueError("create_task 需要至少一个 booking")
    dates = {b.booking_date for b in bookings}
    if len(dates) != 1:
        raise ValueError(f"所有 booking 必须同日期，收到 {dates}")
    d = dates.pop()
    sorted_b = sorted(bookings, key=lambda x: x.start_time)
    segs = [booking_to_segment(b) for b in sorted_b]
    body = "\n\n".join(render_block(b) for b in sorted_b)
    payload = {
        "title": render_title(d, segs),
        "body": {"contentType": "text", "content": body},
        "dueDateTime": _fmt_due(d, sorted_b[0].start_time),
        "isReminderOn": False,
    }
    url = f"{GRAPH_BASE}/me/todo/lists/{list_id}/tasks"
    resp = requests.post(url, headers=_headers(access_token), json=payload, timeout=30)
    resp.raise_for_status()
    return resp.json()


def update_task_merge(
    access_token: str,
    list_id: str,
    existing: TaskState,
    in_title_only: list[BookingInfo],
    truly_new: list[BookingInfo],
) -> dict:
    """合并到已有同日任务：
      - in_title_only：标题里已有这条预订（视觉上不变），只 body 追加 marker block
      - truly_new：标题里也没有 → 标题用 merge.compute_merged_title 重算；body 追加 block

    title / dueDateTime 仅当 truly_new 非空且 due_date 已知时才改。
    """
    if not in_title_only and not truly_new:
        return {}

    all_new = in_title_only + truly_new
    new_body = compute_appended_body(existing.body, all_new)
    payload: dict = {"body": {"contentType": "text", "content": new_body}}

    new_title = compute_merged_title(existing, truly_new)
    if new_title is not None:
        payload["title"] = new_title

    if truly_new and existing.due_date is not None:
        # dueDateTime 取所有段（已解析的原段 + 新段）的最早 start_time
        starts = [s.start_time for s in parse_title_segments(existing.title)]
        starts.extend(b.start_time for b in truly_new)
        if starts:
            payload["dueDateTime"] = _fmt_due(existing.due_date, min(starts))

    url = f"{GRAPH_BASE}/me/todo/lists/{list_id}/tasks/{existing.id}"
    resp = requests.patch(url, headers=_headers(access_token), json=payload, timeout=30)
    resp.raise_for_status()
    return resp.json()
