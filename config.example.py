"""
复制本文件为 config.py 后填入真实值。config.py 不要提交到 git。

取值方法详见 README.md。
"""

# Microsoft To-Do 列表 ID
# 来源：to-do.live.com 打开"网球"列表后，URL 里 /tasks/ 后面的那段
# 若该 URL 形式 ID 在 Graph API 报 itemNotFound，跑 python list_lists.py 找正确 ID
TODO_LIST_ID = ""

# Microsoft Graph access token 不再放这里了 —— 跑 python auth.py 一次性授权后
# refresh_token 存在 token.json，sync.py 会自动换 access_token。

# 本地 server.py 与 Tampermonkey userscript 共享的鉴权 token
# 生成：python -c "import secrets; print(secrets.token_urlsafe(16))"
# 必须跟 userscript_sjtu.js 顶部 TOKEN 完全一致；任意一方改了另一方也要改
LOCAL_SERVER_TOKEN = ""
