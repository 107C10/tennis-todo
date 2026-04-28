"""主同步流程：把 SJTU 未核销预约同步到 Microsoft To-Do（同日合并）。

【三段】
  gather_pending(orders)  → 按日期分组的纯整理
  plan_changes(...)       → 决策：哪些新建、哪些合并；纯函数
  apply_changes(plan)     → 调 Graph API 写入

【两个入口】
  run_from_orders(orders, apply)  — server 模式：orders 由 userscript 推上来
  run_cli(apply)                  — CLI 模式：cookie_store 读 cookie 后自抓 SJTU

CLI 用法：
  python sync.py            # dry-run
  python sync.py --apply    # 实际写入  （-a 同义）
"""
from __future__ import annotations

import sys
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date

if sys.platform == "win32":
    # pythonw 没有 console，stdout/stderr 可能为 None
    if sys.stdout is not None:
        sys.stdout.reconfigure(encoding="utf-8")
    if sys.stderr is not None:
        sys.stderr.reconfigure(encoding="utf-8")

import auth
import config
import cookie_store
import merge
import sjtu_client
import todo_client
from merge import BookingInfo, TaskState
from sjtu_client import Order


# ---------- 数据结构 ----------

@dataclass
class SyncPlan:
    creates: list[tuple[date, list[BookingInfo]]] = field(default_factory=list)
    updates: list[tuple[TaskState, list[BookingInfo], list[BookingInfo]]] = field(
        default_factory=list
    )  # (existing, in_title_only, truly_new)

    @property
    def is_empty(self) -> bool:
        return not self.creates and not self.updates


# ---------- 三段纯函数 ----------

def gather_pending(orders: list[Order]) -> dict[date, list[Order]]:
    """按 booking_date 分组。"""
    by_date: dict[date, list[Order]] = defaultdict(list)
    for o in orders:
        by_date[o.booking_date].append(o)
    return by_date


def plan_changes(
    pending_by_date: dict[date, list[Order]],
    managed_tasks: list[TaskState],
) -> SyncPlan:
    """决定每个日期是新建还是合并；不做任何 IO。

    managed_tasks: 已存在的「脚本管理任务」（含 marker 且 due_date 已知）。
    """
    by_date: dict[date, TaskState] = {}
    for t in managed_tasks:
        if t.due_date is None:
            continue
        if t.due_date in by_date:
            print(f"  [warn] 同日多条 marker 任务 {t.due_date}，仅以先出现的为准")
            continue
        by_date[t.due_date] = t

    plan = SyncPlan()
    for d in sorted(pending_by_date.keys()):
        orders = pending_by_date[d]
        existing = by_date.get(d)
        if existing is None:
            plan.creates.append((d, [BookingInfo.from_order(o) for o in orders]))
            continue

        in_title: list[BookingInfo] = []
        truly_new: list[BookingInfo] = []
        for o in orders:
            if o.order_id in existing.marker_order_ids:
                continue  # 已通过 marker 同步过
            b = BookingInfo.from_order(o)
            if merge.visual_match_in_title(existing.title, b):
                in_title.append(b)
            else:
                truly_new.append(b)
        if in_title or truly_new:
            plan.updates.append((existing, in_title, truly_new))

    return plan


def apply_changes(plan: SyncPlan, access_token: str, list_id: str) -> None:
    """实际写入；逐条打日志。"""
    for d, books in plan.creates:
        result = todo_client.create_task(access_token, list_id, books)
        ids = ", ".join(b.order_id for b in books)
        print(f"  ✓ [新建] {d} 含订单 {ids} → task ...{result.get('id', '')[-8:]}")
    for ex, in_title, truly_new in plan.updates:
        todo_client.update_task_merge(access_token, list_id, ex, in_title, truly_new)
        all_ids = ", ".join(b.order_id for b in (in_title + truly_new))
        print(f"  ✓ [合并] {ex.due_date} 加入订单 {all_ids}")


# ---------- 预览（dry-run / apply 通用）----------

def print_pending(orders: list[Order]) -> None:
    print(f"  共 {len(orders)} 条")
    for o in orders:
        print(f"    - {o.order_id}  {o.booking_date} {o.start_time}-{o.end_time}  {o.venue} {o.court_no}")


def print_plan(plan: SyncPlan) -> None:
    print(f"[plan] 待新建 {len(plan.creates)} 条，待合并 {len(plan.updates)} 条")
    for d, books in plan.creates:
        segs = [merge.booking_to_segment(b) for b in books]
        print(f"    [新建] {merge.render_title(d, segs)}")
    for ex, in_title, truly_new in plan.updates:
        new_title = merge.compute_merged_title(ex, truly_new) or ex.title
        print(f"    [合并] {ex.due_date}")
        print(f"             已有 title: {ex.title}")
        if in_title:
            print(f"             已在 title 仅补 body marker: {[b.order_id for b in in_title]}")
        if truly_new:
            print(f"             新增段:                     {[b.order_id for b in truly_new]}")
        print(f"             新 title: {new_title}")


# ---------- 入口 ----------

def run_from_orders(orders: list[Order], apply: bool) -> int:
    """server 模式：orders 已由 userscript 推上来。"""
    print(f"[1/3] 收到 {len(orders)} 条 SJTU 未核销预约")
    print_pending(orders)

    print("[2/3] 拉取 To-Do 任务（含 sjtu-order marker 的视为脚本管理）...")
    access_token = auth.get_access_token()
    all_tasks = todo_client.list_all_tasks(access_token, config.TODO_LIST_ID)
    managed = [t for t in all_tasks if t.marker_order_ids and t.due_date is not None]
    print(f"  全部任务 {len(all_tasks)} 条，其中脚本管理 {len(managed)} 条")

    plan = plan_changes(gather_pending(orders), managed)
    print("[3/3] 计算变更")
    print_plan(plan)

    if not apply:
        print("\n[dry-run] 加 --apply 或 -a 实际写入。")
        return 0
    if plan.is_empty:
        print("无变更，无需写入。")
        return 0
    print("\n开始写入 To-Do...")
    apply_changes(plan, access_token, config.TODO_LIST_ID)
    print("完成。")
    return 0


def run_cli(apply: bool) -> int:
    """CLI 模式：cookie_store 读 cookie 后自抓 SJTU。"""
    cookie = cookie_store.load_cookie()
    if not cookie:
        raise SystemExit(
            "未找到 .sjtu_cookie。\n"
            "  方案 A（推荐）：跑 server 模式 + Tampermonkey userscript 自动同步。\n"
            "  方案 B（手动）：浏览器 DevTools → Application → Cookies 把 sports.sjtu.edu.cn\n"
            "                   的所有 cookie 拼成 'k1=v1; k2=v2;...' 写进 .sjtu_cookie。"
        )
    print("[0/3] 用 .sjtu_cookie 直连 SJTU 接口...")
    try:
        orders = sjtu_client.fetch_pending_orders(cookie)
    except sjtu_client.SjtuAuthError as e:
        raise SystemExit(f"SJTU cookie 失效（{e}）。请刷新 .sjtu_cookie 后重试。")
    return run_from_orders(orders, apply)


if __name__ == "__main__":
    apply_flag = "--apply" in sys.argv or "-a" in sys.argv
    sys.exit(run_cli(apply_flag))
