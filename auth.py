"""Microsoft Graph 授权（方案 B：device code flow）。

用法：
  python auth.py    # 首次或 refresh_token 失效时跑一次，浏览器授权
  其他时候 sync.py 会调用 get_access_token() 自动换 token。

复用微软公共客户端 "Microsoft Graph Command Line Tools"
(client_id=14d82eec-204b-4c2f-b7e8-296a70dab67e)，无需自建 Azure 应用。
个人微软账号（live.com / outlook.com / 第三方邮箱绑定的 MSA）走 consumers tenant。
"""
from __future__ import annotations

import json
import pathlib
import sys
import time

import requests

CLIENT_ID = "14d82eec-204b-4c2f-b7e8-296a70dab67e"
SCOPES = "Tasks.ReadWrite offline_access"
TENANT = "consumers"

DEVICECODE_URL = f"https://login.microsoftonline.com/{TENANT}/oauth2/v2.0/devicecode"
TOKEN_URL = f"https://login.microsoftonline.com/{TENANT}/oauth2/v2.0/token"

TOKEN_FILE = pathlib.Path(__file__).with_name("token.json")


def _save_refresh_token(rt: str) -> None:
    TOKEN_FILE.write_text(json.dumps({"refresh_token": rt}), encoding="utf-8")


def _load_refresh_token() -> str:
    if not TOKEN_FILE.exists():
        raise SystemExit(
            f"未找到 {TOKEN_FILE.name}。请先运行：python auth.py 完成首次授权。"
        )
    return json.loads(TOKEN_FILE.read_text(encoding="utf-8"))["refresh_token"]


def interactive_login() -> None:
    r = requests.post(
        DEVICECODE_URL,
        data={"client_id": CLIENT_ID, "scope": SCOPES},
        timeout=15,
    )
    r.raise_for_status()
    dev = r.json()
    print(dev["message"], flush=True)
    print(
        f"\n如未自动打开浏览器：访问 {dev['verification_uri']}，"
        f"输入代码 {dev['user_code']}\n",
        flush=True,
    )
    print("等待你完成授权... (Ctrl+C 取消)", flush=True)

    interval = dev.get("interval", 5)
    deadline = time.time() + dev.get("expires_in", 900)
    while time.time() < deadline:
        time.sleep(interval)
        r = requests.post(
            TOKEN_URL,
            data={
                "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
                "client_id": CLIENT_ID,
                "device_code": dev["device_code"],
            },
            timeout=15,
        )
        if r.status_code == 200:
            tok = r.json()
            _save_refresh_token(tok["refresh_token"])
            print(f"\n授权成功，refresh_token 已保存到 {TOKEN_FILE.name}", flush=True)
            return
        err = r.json().get("error")
        if err == "authorization_pending":
            continue
        if err == "slow_down":
            interval += 5
            continue
        raise SystemExit(f"授权失败: {r.json()}")
    raise SystemExit("授权超时，请重试 python auth.py")


def get_access_token() -> str:
    """读 refresh_token，调 token endpoint 换 access_token；
    若服务返回了滚动后的新 refresh_token，原子地更新本地存储。"""
    rt = _load_refresh_token()
    r = requests.post(
        TOKEN_URL,
        data={
            "grant_type": "refresh_token",
            "client_id": CLIENT_ID,
            "scope": SCOPES,
            "refresh_token": rt,
        },
        timeout=15,
    )
    if r.status_code != 200:
        raise SystemExit(
            f"refresh_token 换 access_token 失败 ({r.status_code}): {r.text}\n"
            f"可能 refresh_token 已失效，请重新跑：python auth.py"
        )
    tok = r.json()
    new_rt = tok.get("refresh_token")
    if new_rt and new_rt != rt:
        _save_refresh_token(new_rt)
    return tok["access_token"]


if __name__ == "__main__":
    if sys.platform == "win32":
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    interactive_login()
