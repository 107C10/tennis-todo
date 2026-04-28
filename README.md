# tennis-todo

把 SJTU 体育场馆系统里"未来未核销"的网球预约**自动同步**到 Microsoft To-Do 共享列表。

终态：浏览器逛 SJTU、完成预定支付的几秒后，To-Do 自动出现新任务。**零命令行**，**零手动 cookie 操作**。

## 共享列表安全约束（必读）

To-Do 列表通常与他人共编。本脚本对**他人手输的任务（无 `[sjtu-order:...]` marker）完全透明**——绝不识别、绝不修改、绝不删除。
`scripts/todo_client.py` 在代码层面没有 DELETE 函数。代码层面就是不可删任务。

---

## 目录结构

```
tennis-todo/
├── start_server.bat            # 双击启动本地 server（前台、看实时日志）
├── install_autostart.ps1       # 注册开机自启（后台 pythonw）
├── userscript_sjtu.js          # 给 Tampermonkey 粘贴的脚本
├── README.md
├── requirements.txt            # 唯一依赖：requests
├── config.example.py           # 配置模板（拷成 data/config.py 后填值）
├── .gitignore
├── scripts/                    # Python 源码（提交到 git）
│   ├── auth.py                 # Microsoft Graph device-code 授权
│   ├── merge.py                # 纯逻辑：标题/正文渲染、视觉去重、合并决策
│   ├── server.py               # 本地 HTTP 服务（127.0.0.1:5454）
│   ├── sjtu_client.py          # SJTU records → Order 解析
│   ├── sync.py                 # 三段同步流程
│   └── todo_client.py          # Microsoft Graph To-Do HTTP
└── data/                       # 用户私有数据（整个目录 gitignored）
    ├── config.py               # 你的配置（TODO_LIST_ID + LOCAL_SERVER_TOKEN）
    ├── token.json              # Microsoft Graph refresh_token（90 天滑动）
    └── server.log              # 实时日志
```

---

## 从 git clone 到跑起来

### Step 1 — 克隆 + 装依赖

```powershell
git clone https://github.com/107C10/tennis-todo
cd tennis-todo

# 强烈推荐用 venv 隔离依赖（避免污染全局 Python）
python -m venv .venv
.venv\Scripts\Activate.ps1            # PowerShell 激活；cmd 用 .venv\Scripts\activate.bat

pip install -r requirements.txt       # 装 requests
```

如果你不想用 venv，直接 `pip install requests` 也行——`start_server.bat` 会自动检测：有 `.venv` 就用它的 Python，否则回退到系统 `python`。

### Step 2 — 拷配置模板，填两个字段

```powershell
copy config.example.py data\config.py
```

打开 `data\config.py`，填这两个字段：

| 字段 | 怎么取值 |
|---|---|
| `TODO_LIST_ID` | 浏览器打开 https://to-do.live.com → 点"网球"列表 → 看 URL，`/tasks/` 后面那段 base64 字符串就是 |
| `LOCAL_SERVER_TOKEN` | 随机生成：`python -c "import secrets; print(secrets.token_urlsafe(16))"` |

### Step 3 — Microsoft Graph 一次性授权

```powershell
python scripts\auth.py
```

控制台会打印一个 URL（通常 https://microsoft.com/devicelogin）和一段验证码：

1. 浏览器打开那个 URL
2. 输入验证码
3. 用你的 Microsoft 账号（live.com / outlook.com / 第三方邮箱绑定的 MSA）授权
4. 控制台显示"授权成功"，`refresh_token` 写入 `data\token.json`

之后 90 天滑动有效。脚本会在每次跑时自动用 `refresh_token` 换新 access_token。

### Step 4 — Tampermonkey 装 userscript

1. 浏览器装 [Tampermonkey](https://www.tampermonkey.net/) 扩展
2. Tampermonkey 仪表盘 → 点 "+" 新建脚本
3. 把 `userscript_sjtu.js` **全文**粘进去，覆盖默认模板
4. 把脚本顶部的 `TOKEN` 常量改成 Step 2 里那个 `LOCAL_SERVER_TOKEN`（必须**完全一致**）
5. **Ctrl+S** 保存

### Step 5 — 启动本地 server

两种模式选一：

**A. 临时跑（开发/调试）**
双击 `start_server.bat`，看到窗口里有
```
[2026-04-28 17:30:00] server up on 127.0.0.1:5454
```
就成。Ctrl+C 停。

**B. 开机自启（日用）**
```powershell
.\install_autostart.ps1                # 无需管理员
```
立即启动一份后台 server，并注册到 Task Scheduler，下次登录 Windows 时自动重启。

### Step 6 — 验收

1. 浏览器登录 https://sports.sjtu.edu.cn/pc/#/Order
2. F12 Console 应出现：`[sjtu-sync] /sync (load) → HTTP 202, pushed N records`
3. `data\server.log` 应出现：
   ```
   POST /sync received N records → M pending orders
   sync start (M orders)
   sync done
   ```
4. 打开 https://to-do.live.com → "网球"列表，应能看到形如 `🎾4.30 胡8 20-21` 的任务

往后做预定 → 完成支付 → ~2 秒后 To-Do 自动出新任务。**零操作**。

---

## 同伴部署

每个同伴在自己的电脑上：

1. 同样 git clone（克隆同一份）
2. 同样 `pip install -r requirements.txt`
3. 拷一份 `data\config.py`，**`TODO_LIST_ID` 填同一个**（共享列表 ID 全局唯一），**`LOCAL_SERVER_TOKEN` 自己生成一个**（每个同伴的 token 独立，不互通）
4. `python scripts\auth.py`——用**他自己的 Microsoft 账号**授权（注意是他自己有共享列表读写权限的账号）
5. 装 Tampermonkey + 粘 userscript + 改成自己那一份的 TOKEN
6. 跑 `install_autostart.ps1` 或双击 `start_server.bat`

之后两人各跑各的，To-Do 列表里同日预定会自动合并到一条任务里。**两人各自的 SJTU 账号 cookie 永远在自己浏览器里**，不会暴露给对方。

---

## 架构

```
浏览器 (sports.sjtu.edu.cn 已登录)
  └─ Tampermonkey userscript
       │ 1. 同源 fetch /venue/personal/personalOrderlist
       │    （浏览器自动注入含 HttpOnly 的全部 cookie）
       │ 2. POST 127.0.0.1:5454/sync  body=<orders JSON>  X-Token=...
       ↓
  scripts/server.py  (127.0.0.1:5454)
       │ - 鉴权 (X-Token 比对 LOCAL_SERVER_TOKEN)
       │ - 5 秒去抖 + 单线程互斥
       │ - parse_orders → sync.run_from_orders → Microsoft Graph
```

userscript 触发时机：
- 进入或刷新 `#/Order` 页
- 完成支付 `#/paymentResult/1`（给 SJTU 后端 1.5s 落库后触发）
- 长时间挂在 SJTU 页时每 5 分钟兜底心跳

---

## 同日合并约定

- 标题：`🎾4.28 胡2 20-21 东7 21-22`（emoji + 月.日 + 各预约段）
- 正文每条预约一个 block，含 `[sjtu-order:<orderId>]` marker
- 同日已有脚本管理任务（含 marker） → 合并：title 重排、body 追加 block
- 同日没有脚本管理任务 → 新建一条
- 视觉去重：partner 提前手输了某个段在 title 里 → 仅 body 补 marker，title 不动

---

## 排查

| 现象 | 检查 |
|---|---|
| 双击 bat 闪退 | 加了 `pause`，不会闪退；看窗口里的报错。`ModuleNotFoundError: requests` 多半是没在 venv 里装依赖，回 Step 1 |
| 端口已被占 | `Get-NetTCPConnection -LocalPort 5454`；很可能是 Task Scheduler 已起了一份后台 pythonw，先 `Stop-ScheduledTask -TaskName TennisToDoSync` |
| To-Do 没新任务 | F12 Console 找 `[sjtu-sync]` 行；server 日志看 `POST /sync received N records → M pending orders` 的 M |
| `cookie POST 网络错误` / `status: 0` | server 没在跑（`Get-Process python,pythonw`），或 Tampermonkey 的 `@connect 127.0.0.1` 未授权 |
| `403 token mismatch` | `data\config.py` 的 `LOCAL_SERVER_TOKEN` 与 userscript 顶部 `TOKEN` 不一致 |
| `400 bad payload` | userscript 推上来的 JSON 不合法 — 看 server.log 详情 |
| `SJTU code=401` | 浏览器登录态过期，去 sports.sjtu.edu.cn 重新登一次即可（无须改 cookie） |

自启任务管理：

```powershell
Get-ScheduledTask TennisToDoSync | Get-ScheduledTaskInfo            # 状态
Stop-ScheduledTask -TaskName TennisToDoSync                         # 停（保留注册）
Unregister-ScheduledTask -TaskName TennisToDoSync -Confirm:$false   # 卸载
```

---

## 安全说明

- `data/config.py`、`data/token.json`、`data/server.log` 全部在 `data/` 下，整个目录被 `.gitignore` 排除，不会进 git
- `LOCAL_SERVER_TOKEN` 仅本机使用（server 只绑 `127.0.0.1`，外网不可访问），泄露的最坏后果是同机其他网页能触发本机同步
- `token.json` 里是 Microsoft Graph 的 refresh_token，授权 scope 是 `Tasks.ReadWrite`，仅能读写 To-Do。撤销：账号 → 隐私 → 应用与服务 → "Microsoft Graph Command Line Tools" → 移除
- 浏览器的 SJTU cookie **从未离开浏览器**（同源 fetch 完后，server 只收到订单 JSON，不收 cookie）
