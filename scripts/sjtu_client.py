"""SJTU 体育场馆系统订单解析。

本模块只负责把 SJTU `/venue/personal/personalOrderlist` 接口返回的 records 数组
解析成 Order 对象。HTTP 调用本身由浏览器 userscript 在 SJTU 页面同源 fetch
完成（自动带上 HttpOnly cookie），通过本地 server 推上来。

orderstateid 含义（从样本反推）：
  "1" - 已支付未核销（要同步）
  "7" - 已核销（已使用）
  "2" - 已退款
  "8" - 待支付（不同步）
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date, datetime, time

# spaceInfo 形如 "网球 场地7 (20:00-21:00)"
SPACE_INFO_RE = re.compile(r"网球 场地(\d+)\s*\((\d{1,2}:\d{2})-(\d{1,2}:\d{2})\)")


@dataclass
class Order:
    order_id: str
    venue: str
    court_no: str  # 例如 "场地7"
    booking_date: date
    start_time: time
    end_time: time

    @property
    def start_datetime(self) -> datetime:
        return datetime.combine(self.booking_date, self.start_time)


def _parse_space_info(space_info: str) -> tuple[str, time, time]:
    m = SPACE_INFO_RE.search(space_info)
    if not m:
        raise ValueError(f"无法解析 spaceInfo: {space_info!r}")
    court_no = f"场地{m.group(1)}"
    start_t = datetime.strptime(m.group(2), "%H:%M").time()
    end_t = datetime.strptime(m.group(3), "%H:%M").time()
    return court_no, start_t, end_t


def _record_to_order(rec: dict) -> Order:
    court_no, start_t, end_t = _parse_space_info(rec["spaceInfo"])
    return Order(
        order_id=str(rec["pOrderid"]),
        venue=rec["venuename"],
        court_no=court_no,
        booking_date=datetime.strptime(rec["scDate"], "%Y-%m-%d").date(),
        start_time=start_t,
        end_time=end_t,
    )


def parse_orders(records: list[dict], now: datetime | None = None) -> list[Order]:
    """从 SJTU API records 数组挑出"已支付未核销且开始时间在未来"的订单。

    Args:
      records: SJTU /venue/personal/personalOrderlist 响应 body 的 records 字段
      now:     用于测试覆盖；默认 datetime.now()

    跳过策略：
      - orderstateid != "1"：忽略
      - cancelOrder 真值：忽略
      - spaceInfo 解析失败：跳过 + 打 warn
      - 开始时间已过：忽略
    """
    cutoff = now or datetime.now()
    out: list[Order] = []
    for rec in records:
        if str(rec.get("orderstateid")) != "1":
            continue
        if rec.get("cancelOrder"):
            continue
        try:
            order = _record_to_order(rec)
        except (KeyError, ValueError) as e:
            print(f"  [warn] 跳过解析失败的记录 {rec.get('pOrderid')}: {e}")
            continue
        if order.start_datetime < cutoff:
            continue
        out.append(order)
    out.sort(key=lambda o: o.start_datetime)
    return out
