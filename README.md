# tennis-todo

把 SJTU 体育场馆系统里"未来未核销"的网球预约同步到 Microsoft To-Do 共享列表。

## 重要：共享列表安全约束

目标 To-Do 列表是与他人共编的共享列表。本脚本对**他人手输的任务（无 `[sjtu-order:...]` marker）完全透明**，绝不修改/删除。`todo_client.py` 在代码层面没有 DELETE 函数。

## 架构总览

```
[server 模式 — 主路径]
浏览器 (sports.sjtu.edu.cn 已登录)
  └─ Tampermonkey userscript: 同源 fetch /venue/personal/personalOrderlist
                              （浏览器自动注入 HttpOnly cookie）
       └─ POST /sync  body=<orders JSON>  X-Token=...
            server.py: parse_orders → sync.run_from_orders → Graph API

[CLI 模式 — 兜底]
python sync.py --apply
  └─ cookie_store.load_cookie → sjtu_client.fetch_pending_orders → 同样的流程
```

## 文件职责

| 文件 | 职责 |
|---|---|
| `auth.py` | Microsoft Graph device-code flow + token.json 持久化 |
| `sjtu_client.py` | SJTU API 调用 + records→Order 解析（`parse_orders` / `fetch_pending_orders`）|
| `merge.py` | 纯逻辑：dataclass + 标题/正文渲染 + 视觉去重 + `compute_merged_title` |
| `todo_client.py` | Microsoft Graph To-Do 的 GET / POST / PATCH（薄壳）|
| `sync.py` | 三段：`gather_pending` → `plan_changes` → `apply_changes`；CLI 入口 |
| `server.py` | 本地 HTTP 服务（127.0.0.1:5454），接 userscript JSON 推送 |
| `userscript_sjtu.js` | Tampermonkey 用户脚本，浏览器侧自动触发 |
| `cookie_store.py` | `.sjtu_cookie` 读写（仅 CLI 模式用）|

## 一次性安装

```powershell
cd D:\self_learning\website\tennis-todo
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
copy config.example.py config.py
```

## 一次性配置

### 1. 填 `config.py`

- **`TODO_LIST_ID`**：to-do.live.com 打开"网球"列表，URL `/tasks/` 后面那段就是 ID
- **`LOCAL_SERVER_TOKEN`**：随机生成，server 与 userscript 共享
  ```powershell
  python -c "import secrets; print(secrets.token_urlsafe(16))"
  ```

### 2. Microsoft Graph 授权

```powershell
python auth.py
```

控制台会打印一个 URL 和一段验证码，浏览器打开 → 输入验证码 → 用微软账号授权。`token.json` 里的 `refresh_token` 90 天滑动有效，持续使用不过期。

## 全自动模式（Tampermonkey，推荐日常使用）

终态：浏览器登录 SJTU 后做预定 → 支付完成几秒内 To-Do 自动出现新任务，**零命令行**。

### 一次性安装

1. 浏览器装 [Tampermonkey](https://www.tampermonkey.net/)
2. Tampermonkey 仪表盘点 "+" 新建脚本，把 `userscript_sjtu.js` 全文粘进去
3. 把脚本顶部的 `TOKEN` 改成 `config.py` 里同一个 `LOCAL_SERVER_TOKEN`，保存
4. 启动本地 server：
   - **临时跑**：双击 `start_server.bat`（前台窗口看实时日志，Ctrl+C 停）
   - **开机自启**：PowerShell 跑 `.\install_autostart.ps1`（无需管理员）

### 触发时机

userscript 在以下情况自动 `fetch /venue/personal/personalOrderlist` 并把 records 推给 server：

- 进入或刷新"我的订单"页（`#/Order`）
- 完成支付（`#/paymentResult/1`）—— 给 SJTU 后端 1.5 秒落库后再触发
- 长时间挂在 SJTU 页时每 5 分钟一次心跳兜底

server 端有 5 秒去抖 + 单线程互斥，连续触发不会撞车。

### 排查

| 现象 | 检查 |
|---|---|
| To-Do 没出新任务 | 看 `server.log` 末尾；F12 Console 找 `[sjtu-sync]` 行 |
| `cookie POST 网络错误` / `status: 0` | server 没在跑（`Get-Process pythonw`），或 Tampermonkey 的 `@connect 127.0.0.1` 未授权 |
| `403 token mismatch` | `config.py` 的 `LOCAL_SERVER_TOKEN` 与 userscript 顶部 `TOKEN` 不一致 |
| `400 bad payload` | userscript 推上来的 JSON 不合法 — 看 server.log 详情 |
| `SJTU code=401` | 浏览器登录态过期，去 sports.sjtu.edu.cn 重新登一次即可 |

自启任务管理：

```powershell
Get-ScheduledTask TennisToDoSync | Get-ScheduledTaskInfo   # 状态
Stop-ScheduledTask -TaskName TennisToDoSync                # 停
Unregister-ScheduledTask -TaskName TennisToDoSync -Confirm:$false  # 卸载
```

## CLI 模式（兜底）

适用：没装浏览器/油猴时手动跑一次。

```powershell
python sync.py            # dry-run，只打印将要新建/合并什么
python sync.py --apply    # 实际写入
```

需要先把 SJTU cookie 写进 `.sjtu_cookie`：浏览器 DevTools → Application → Cookies → sports.sjtu.edu.cn → 把所有 cookie 拼成 `k1=v1; k2=v2; ...` 一行写进文件即可。CLI 不会自动刷新这份 cookie——server 模式才是日用路径。

## 同日合并约定

- 标题形如：`🎾4.28 胡2 20-21 东7 21-22`（emoji + 月.日 + 各预约段）
- 正文每条预约一个 block，含 `[sjtu-order:<orderId>]` marker
- 同日已有脚本管理任务（含 marker） → 合并：新预约段插入到 title 排序，正文追加 block
- 同日没有脚本管理任务 → 新建一条
- 视觉去重：partner 提前手输了某个段在 title 里，脚本只补 body 的 marker，title 不动
