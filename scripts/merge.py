"""纯逻辑模块：数据结构、标题/正文渲染与解析、合并决策。

不依赖 HTTP；不接触 SJTU 或 Microsoft Graph。
所有函数都可独立单测。

【同日合并约定】
- title 形如：🎾4.28 胡2 20-21 东7 21-22
- body 每条预订一个 block，含 [sjtu-order:<orderId>] marker
- 视觉去重：若新预订段（venue_short + court + 时段）已在 title 中，
  仅 body 追加 marker block，title 不动（防止覆盖 partner 已手输的标题段）
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date, datetime, time

from sjtu_client import Order

# ---------- 正则与常量 ----------

ORDER_MARKER_RE = re.compile(r"\[sjtu-order:([^\]]+)\]")
DATE_LINE_RE = re.compile(r"^日期：(\d{4}-\d{2}-\d{2})", re.MULTILINE)
# 标题段：单个汉字（venue_short）+ 球场号(可含 / 或 -)+ 空格 + HH(:MM)?-HH(:MM)?
TITLE_SEG_RE = re.compile(
    r"([一-鿿])(\d+(?:[/\-]\d+)*)\s+(\d{1,2}(?::\d{2})?)-(\d{1,2}(?::\d{2})?)"
)

WEEKDAYS_CN = ["星期一", "星期二", "星期三", "星期四", "星期五", "星期六", "星期日"]


# ---------- 数据结构 ----------

@dataclass
class BookingInfo:
    order_id: str
    venue: str
    court_no: str
    booking_date: date
    start_time: time
    end_time: time

    @classmethod
    def from_order(cls, o: Order) -> "BookingInfo":
        return cls(o.order_id, o.venue, o.court_no, o.booking_date, o.start_time, o.end_time)


@dataclass
class TitleSegment:
    """标题里一段 booking 的可序列化表示。"""
    venue_short: str   # 单字 '胡' / '东'
    court_token: str   # '2' / '8/7' / '8-6'（保留原 token 不解析）
    start_time: time
    end_time: time


@dataclass
class TaskState:
    """已存在任务的状态快照。"""
    id: str
    title: str
    body: str
    due_date: date | None
    marker_order_ids: set[str] = field(default_factory=set)


# ---------- 内部工具 ----------

def _fmt_hour(t: time) -> str:
    return str(t.hour) if t.minute == 0 else t.strftime("%H:%M")


def _venue_short(name: str) -> str:
    return name[0] if name else "?"


def _court_num(court_no: str) -> str:
    m = re.search(r"\d+", court_no)
    return m.group(0) if m else court_no


def _parse_time_token(s: str) -> time:
    if ":" in s:
        return datetime.strptime(s, "%H:%M").time()
    return time(int(s), 0)


def booking_to_segment(b: BookingInfo) -> TitleSegment:
    return TitleSegment(
        venue_short=_venue_short(b.venue),
        court_token=_court_num(b.court_no),
        start_time=b.start_time,
        end_time=b.end_time,
    )


# ---------- 渲染 ----------

def render_segment_str(s: TitleSegment) -> str:
    return f"{s.venue_short}{s.court_token} {_fmt_hour(s.start_time)}-{_fmt_hour(s.end_time)}"


def render_title(d: date, segments: list[TitleSegment]) -> str:
    """🎾4.28 胡2 20-21 东7 21-22  （segments 自动按 start_time 排序）"""
    parts = [f"🎾{d.month}.{d.day}"]
    for s in sorted(segments, key=lambda x: x.start_time):
        parts.append(render_segment_str(s))
    return " ".join(parts)


def render_block(b: BookingInfo) -> str:
    weekday = WEEKDAYS_CN[b.booking_date.weekday()]
    return (
        f"日期：{b.booking_date.isoformat()} {weekday}\n"
        f"场馆：{b.venue}\n"
        f"场地：{b.court_no}\n"
        f"时段：{b.start_time.strftime('%H:%M')}-{b.end_time.strftime('%H:%M')}\n"
        f"[sjtu-order:{b.order_id}]"
    )


# ---------- 解析与匹配 ----------

def parse_title_segments(title: str) -> list[TitleSegment]:
    """从已有标题尽力解析出 booking 段；解析失败的部分忽略。"""
    out: list[TitleSegment] = []
    for m in TITLE_SEG_RE.finditer(title):
        v, c, s_tok, e_tok = m.groups()
        try:
            out.append(TitleSegment(v, c, _parse_time_token(s_tok), _parse_time_token(e_tok)))
        except ValueError:
            continue
    return out


def visual_match_in_title(title: str, b: BookingInfo) -> bool:
    """标题里是否已含这条预订（venue_short + court 数字 + 起止时间一致）。"""
    target_seg = booking_to_segment(b)
    for seg in parse_title_segments(title):
        if (
            seg.venue_short == target_seg.venue_short
            and _court_num(seg.court_token) == target_seg.court_token
            and seg.start_time == target_seg.start_time
            and seg.end_time == target_seg.end_time
        ):
            return True
    return False


# ---------- 合并决策 ----------

def compute_merged_title(existing: TaskState, truly_new: list[BookingInfo]) -> str | None:
    """existing.title + truly_new → 新 title。

    truly_new 为空 → 返回 None（标题不需要改）。
    existing 解析得到 segments → 用 render_title 重排所有段（含 truly_new）。
    解析不出已有段 → 保留原 title，仅在末尾追加新段（避免丢信息）。
    existing.due_date 缺失 → 同样退回末尾追加（render_title 需要日期）。
    """
    if not truly_new:
        return None

    new_segs = [booking_to_segment(b) for b in truly_new]

    if existing.due_date is None:
        return _append_segments(existing.title, new_segs)

    existing_segs = parse_title_segments(existing.title)
    if existing_segs:
        return render_title(existing.due_date, existing_segs + new_segs)
    return _append_segments(existing.title, new_segs)


def _append_segments(existing_title: str, new_segs: list[TitleSegment]) -> str:
    tail = " ".join(
        render_segment_str(s)
        for s in sorted(new_segs, key=lambda x: x.start_time)
    )
    return (existing_title.rstrip() + " " + tail).strip()


def compute_appended_body(existing_body: str, all_new: list[BookingInfo]) -> str:
    """已有 body + 新 booking 的 block。all_new 由调用方自行排序/去重决定。"""
    blocks = [render_block(b) for b in sorted(all_new, key=lambda x: x.start_time)]
    appended = "\n\n".join(blocks)
    if existing_body.strip():
        return existing_body.rstrip() + "\n\n" + appended
    return appended
