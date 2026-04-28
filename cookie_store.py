"""SJTU cookie 本地缓存。

仅给 CLI 模式（`python sync.py`）使用。Server 模式（Tampermonkey + 浏览器）
完全不依赖此文件——浏览器会在同源 fetch 时自动带上含 HttpOnly 的 cookie。

要更新 .sjtu_cookie：浏览器 DevTools → Application → Cookies → sports.sjtu.edu.cn
拼成 "k1=v1; k2=v2; ..." 写入 .sjtu_cookie 即可。
"""
from __future__ import annotations

import pathlib

COOKIE_FILE = pathlib.Path(__file__).with_name(".sjtu_cookie")


def load_cookie() -> str | None:
    if not COOKIE_FILE.exists():
        return None
    s = COOKIE_FILE.read_text(encoding="utf-8").strip()
    return s or None


def save_cookie(s: str) -> None:
    COOKIE_FILE.write_text(s.strip(), encoding="utf-8")


def looks_valid(s: str) -> bool:
    return "JSESSIONID=" in s
