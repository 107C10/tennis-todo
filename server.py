"""本地 HTTP 服务（127.0.0.1:5454）：

  POST /sync  接收 Tampermonkey userscript 推来的 SJTU orders JSON
              body: {"records": [<原始 SJTU record>, ...]}
              header: X-Token: <config.LOCAL_SERVER_TOKEN>
              → server 内部解析后调 sync.run_from_orders(orders, apply=True)

不再保存任何 SJTU cookie（HttpOnly 路径已弃用）。
日志同时写 server.log 和 stdout（pythonw 后台模式下 stdout 为 None 自动跳过）。

启动：
  - 前台：双击 start_server.bat（窗口里看实时日志，Ctrl+C 停）
  - 后台：install_autostart.ps1 注册到 Task Scheduler，开机自启 pythonw server.py
"""
from __future__ import annotations

import http.server
import json
import pathlib
import sys
import threading
import time
import traceback

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

LOG = HERE / "server.log"


def log(msg: str) -> None:
    line = f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}"
    try:
        with LOG.open("a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass
    if sys.stdout is not None:
        try:
            print(line, flush=True)
        except Exception:
            pass


# 业务 import 异常也要落日志，避免 pythonw 静默崩溃
try:
    import config
    import sjtu_client
    import sync as sync_module
except Exception:
    log("import 失败：\n" + traceback.format_exc())
    raise

TOKEN = (getattr(config, "LOCAL_SERVER_TOKEN", "") or "").strip()
if not TOKEN:
    log("FATAL: config.LOCAL_SERVER_TOKEN 未配置，server 拒绝启动")
    raise SystemExit("请在 config.py 设置 LOCAL_SERVER_TOKEN（参考 config.example.py）")

PORT = 5454
DEBOUNCE_S = 5.0
ALLOWED_ORIGIN = "https://sports.sjtu.edu.cn"

_sync_lock = threading.Lock()
_last_sync = 0.0


def _run_sync(orders: list) -> None:
    """串行 + 去抖地把 orders 同步到 To-Do。"""
    global _last_sync
    if not _sync_lock.acquire(blocking=False):
        log("sync skipped: already running")
        return
    try:
        now = time.time()
        if now - _last_sync < DEBOUNCE_S:
            log(f"sync skipped: debounced ({now - _last_sync:.1f}s < {DEBOUNCE_S}s)")
            return
        _last_sync = now
        log(f"sync start ({len(orders)} orders)")
        try:
            sync_module.run_from_orders(orders, apply=True)
            log("sync done")
        except Exception:
            log("sync error\n" + traceback.format_exc())
    finally:
        _sync_lock.release()


class Handler(http.server.BaseHTTPRequestHandler):
    def _cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", ALLOWED_ORIGIN)
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Token")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")

    def _check_token(self) -> bool:
        if self.headers.get("X-Token") != TOKEN:
            log(f"403 token mismatch on {self.command} {self.path}")
            self.send_response(403)
            self._cors()
            self.end_headers()
            return False
        return True

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_POST(self) -> None:
        if not self._check_token():
            return
        if self.path != "/sync":
            self.send_response(404)
            self.end_headers()
            return
        n = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(n) if n > 0 else b""
        try:
            payload = json.loads(raw or b"{}")
            records = payload.get("records", [])
            if not isinstance(records, list):
                raise ValueError(f"records 应为 list，收到 {type(records).__name__}")
            orders = sjtu_client.parse_orders(records)
        except Exception:
            log("400 bad payload:\n" + traceback.format_exc())
            self.send_response(400)
            self._cors()
            self.end_headers()
            return
        log(f"POST /sync received {len(records)} records → {len(orders)} pending orders")
        threading.Thread(target=_run_sync, args=(orders,), daemon=True).start()
        self.send_response(202)
        self._cors()
        self.end_headers()

    def log_message(self, fmt: str, *args) -> None:
        # 接 stdlib 的 access log 到我们的统一日志
        try:
            log("http " + (fmt % args))
        except Exception:
            pass


def main() -> None:
    log(f"server up on 127.0.0.1:{PORT}")
    server = http.server.HTTPServer(("127.0.0.1", PORT), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log("server stopped (Ctrl+C)")
    except Exception:
        log("server crashed\n" + traceback.format_exc())
        raise
    finally:
        log("server down")


if __name__ == "__main__":
    main()
