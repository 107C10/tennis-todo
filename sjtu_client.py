"""SJTU 体育场馆系统订单抓取。

接口：GET https://sports.sjtu.edu.cn/venue/personal/personalOrderlist
鉴权：cookie 中的 JSESSIONID

orderstateid 含义（从样本反推）：
  "1" - 已支付未核销（要同步）
  "7" - 已核销（已使用）
  "2" - 已退款
  "8" - 待支付（不同步）

两个调用方：
  - server 模式：浏览器 userscript 同源 fetch 拿到 records，POST 给 server，
    server 调 parse_orders(records) 把 dict 转成 Order，跳过 HTTP 调用。
  - CLI 模式：fetch_pending_orders(cookie) 自己发请求 + 调 parse_orders。
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date, datetime, time

import requests

ORDER_LIST_URL = "https://sports.sjtu.edu.cn/venue/personal/personalOrderlist"

# spaceInfo 形如 "网球 场地7 (20:00-21:00)"
SPACE_INFO_RE = re.compile(r"网球 场地(\d+)\s*\((\d{1,2}:\d{2})-(\d{1,2}:\d{2})\)")


class SjtuAuthError(Exception):
    """SJTU cookie 失效（HTTP 401 或 body 内 code=401）。调用方负责重刷 cookie 后重试。"""


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
    """从 SJTU API 返回的 records 数组挑出"已支付未核销且开始时间在未来"的订单。

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


def fetch_pending_orders(cookie: str, page_size: int = 50) -> list[Order]:
    """CLI 模式：自带 cookie 直接调 SJTU 接口；调 parse_orders 转换。

    只取第一页（page_size=50）— 活跃的未来订单数量极少（通常 < 10）。
    """
    headers = {
        "Accept": "application/json, text/plain, */*",
        "Referer": "https://sports.sjtu.edu.cn/pc/",
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36"
        ),
        "Cookie": cookie,
    }
    params = {"pageNo": 1, "pageSize": page_size}
    resp = requests.get(ORDER_LIST_URL, headers=headers, params=params, timeout=30)
    if resp.status_code == 401:
        raise SjtuAuthError("HTTP 401")
    resp.raise_for_status()
    data = resp.json()
    # SJTU 把鉴权失败也用 200 返回，body 里是 {"code":401,"msg":"...登录超时..."}
    if isinstance(data.get("code"), int) and data["code"] != 0:
        if data["code"] == 401:
            raise SjtuAuthError(f"body code=401 msg={data.get('msg')}")
        raise SystemExit(
            f"SJTU 接口返回非鉴权错误 code={data['code']} msg={data.get('msg')}"
        )
    return parse_orders(data.get("records", []))
