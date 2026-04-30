# tennis-todo

把 SJTU 体育场馆系统里"未来未核销"的网球预约**自动同步**到 Microsoft To-Do 共享列表。

终态：浏览器登录 SJTU 后做预定 → 完成支付几秒内 To-Do 自动出现新任务。**零命令行、零本地服务、零 Python**——整个项目就一个 Tampermonkey 用户脚本。

---

## 架构

```
浏览器 (sports.sjtu.edu.cn 已登录)
  └─ Tampermonkey userscript_sjtu.js
        ├─ 同源 fetch /venue/personal/personalOrderlist     ← 浏览器自动注入 HttpOnly cookie
        ├─ GM.xmlHttpRequest → login.microsoftonline.com   ← OAuth refresh / device code
        └─ GM.xmlHttpRequest → graph.microsoft.com         ← To-Do 任务读写
```

`refresh_token` 与 `TODO_LIST_ID` 都存在 Tampermonkey 的 `GM.setValue` 里（per-script，浏览器重启不丢）。

---

## 共享列表安全约束（必读）

To-Do 列表通常与他人共编。本脚本对**他人手输的任务（无 `[sjtu-order:...]` marker）完全透明**——绝不识别、绝不修改、绝不删除。代码层面**根本没有 DELETE 函数**。

---

## 从 git clone 到跑起来（5 分钟）

### Step 1 — 装 Tampermonkey

浏览器装 [Tampermonkey](https://www.tampermonkey.net/) 扩展（Chrome / Edge / Firefox 都行）。

### Step 2 — 拿到 `userscript_sjtu.js` 全文

```powershell
git clone https://github.com/107C10/tennis-todo
```

或直接打开 GitHub 网页，复制 `userscript_sjtu.js` 的内容。**整个项目除了这个文件其余都是文档**。

### Step 3 — 粘到 Tampermonkey

1. Tampermonkey 仪表盘 → 点 "+"
2. **Ctrl+A** 选中编辑器里的默认模板 → **Delete** 删干净
3. 把 `userscript_sjtu.js` **全文**粘进去
4. **Ctrl+S** 保存（标签页左上角小圆点变实心说明已保存）

### Step 4 — 拿到 To-Do 列表 ID

浏览器打开 https://to-do.live.com → 点你和同伴共享的"网球"列表 → 看地址栏。`/tasks/` 后面那段 base64 字符串就是 `TODO_LIST_ID`，复制下来备用。

### Step 5 — 第一次访问 sports.sjtu.edu.cn 触发首次配置

1. 浏览器登录 https://sports.sjtu.edu.cn/pc/#/Order
2. 脚本检测到没有 list_id，**弹框**让你粘贴上一步的 `TODO_LIST_ID`，确定
3. 接着脚本检测到没有 refresh_token，**弹框**告诉你 device code 流程：
   - 自动开新 tab 到 `https://microsoft.com/devicelogin`
   - 在新 tab 里输入弹框中显示的 user_code（5-9 位字符）
   - 用你能读写"网球"To-Do 列表的微软账号授权
   - 看到"已授权该应用"后回到 sports.sjtu.edu.cn 这个 tab
4. ~5 秒后再弹一个 alert："Microsoft 授权成功！"
5. 紧接着第一次同步立即开始，F12 Console 应见类似：
   ```
   [sjtu-sync] (load) 10 records → 3 pending orders
   [sjtu-sync] (load) done: 1 created, 0 updated
   ```

之后浏览器只要登录 SJTU，做预定 → 完成支付 → ~2 秒后 To-Do 自动出现新任务。**零操作**。

---

## 触发时机

userscript 在以下场景自动同步一次（server 端有自然去抖：每次 sync 互斥）：

| 时机 | 触发条件 |
|---|---|
| 进入"我的订单"页 | 路由进 `#/Order` |
| 完成支付 | 路由进 `#/paymentResult/1`，给 SJTU 后端 1.5 秒落库后再触发 |
| 心跳兜底 | 长时间挂在 SJTU 页时每 5 分钟一次 |

也可以手动：Tampermonkey 仪表盘 → 这个脚本左边的图标 → 菜单里有 **立即同步一次**。

---

## Tampermonkey 菜单命令

打开 sports.sjtu.edu.cn 任意页面后，点浏览器右上角 Tampermonkey 图标 → SJTU 这个脚本下面会出现：

| 菜单项 | 用途 |
|---|---|
| 立即同步一次 | 不等触发器，立刻 fetch + sync |
| 重新授权 Microsoft | refresh_token 失效时，清掉旧 token，下次同步会重走 device code |
| 重置 To-Do 列表 ID | 改用其他 list 时，清掉旧 list_id，下次同步会重新弹框 |
| 重置全部配置 | 一键清空 token + list_id |

---

## 同伴部署

每个同伴在自己的电脑上：

1. 装 Tampermonkey
2. 粘同一份 `userscript_sjtu.js`（无需任何修改——脚本里没有任何个人信息）
3. 第一次访问 sports.sjtu.edu.cn：
   - 弹框输入 `TODO_LIST_ID`（**所有同伴共用同一个**——共享列表 ID 是唯一的）
   - 弹框走 device code 用**他自己的微软账号**授权（必须是该共享列表的 owner 或被 share）
4. 完事

之后两人各自做预定，**同日的预订自动合并到同一条 To-Do 任务里**。两人 SJTU 账号 cookie 永远在自己浏览器里、永远不会暴露给对方；微软 refresh_token 也各存各的。

---

## 同日合并约定

- **标题**：`🎾4.28 胡2 20-21 东7 21-22`（emoji + 月.日 + 各预约段，按开始时间排序）
- **正文**：每条预订一个 block，含 `[sjtu-order:<orderId>]` marker
- 同日已有脚本管理任务（含 marker） → 合并：title 重排、body 追加 block
- 同日没有脚本管理任务 → 新建一条
- **视觉去重**：partner 提前手输了某个段在 title 里 → 仅 body 补 marker，title 不动

---

## 多人并发安全（已做的）

| 风险 | 缓解 |
|---|---|
| **A、B 几乎同时 sync 导致 lost update** | 每个 task 抓 ETag；PATCH 时带 `If-Match: <etag>`；收到 412 重新拉列表 + 重算 plan + 重试，最多 3 次 |
| 同日重复任务（race 极端情况）| 后续 sync 选首个 marker 任务为 canonical，剩下的"孤儿"不会被改写也不会被合并（保守、不丢数据）|
| `dueDateTime` 因不可解析段被错算 | starts 集合包含：当前 title 解析出的段 + existing 自身的 dueTime + 新增的所有 booking |

---

## 排查

| 现象 | 检查 |
|---|---|
| 完全无反应 | F12 Console 看有没有 `[sjtu-sync]` 行；Tampermonkey 仪表盘脚本左边开关是否绿色（启用） |
| `SJTU code=401` | 浏览器 SJTU 登录态过期，去 sports.sjtu.edu.cn 重新登一次（无须改任何东西） |
| `device code 授权失败` / `refresh_token 失效` | 菜单点 **重新授权 Microsoft**，下次同步会重走 device code |
| GM.xmlHttpRequest 报 CORS | 检查 `@connect graph.microsoft.com login.microsoftonline.com` 是否完整；Tampermonkey 设置 → 一般 → "配置模式"切到 `高级` |
| `ETag 重试用尽` | 极少见。两人秒级同时 sync 时偶发；下一次任意触发器会自然重试 |

---

## 安全说明

- `refresh_token` 存 Tampermonkey 的 `GM.setValue('refresh_token', ...)` —— per-script 隔离，**普通页面 JS 读不到**，仅你这个脚本本身能访问
- 微软 OAuth scope 是 `Tasks.ReadWrite`，**仅能读写 To-Do**，无邮件、无日历、无文件
- SJTU cookie **从未离开浏览器**——userscript 的 `fetch` 是同源的，cookie 由浏览器自己注入
- 撤销微软授权：账号 → 隐私 → 应用与服务 → "Microsoft Graph Command Line Tools" → 移除
- 撤销脚本：Tampermonkey 仪表盘 → 删除脚本即可（GM storage 里的 token 也跟着删）

---

## 一些 FAQ

**Q：换浏览器了 / 重装系统了，要重做什么？**
A：重新装 Tampermonkey + 粘脚本。第一次访问 SJTU 时会重新弹框输 list_id 和 device code 授权。之前的 refresh_token 弃用，但因为 device code 是新的，一切是新的，不影响旧账号。

**Q：脚本里没有任何个人配置，能直接 commit 进 git 吗？**
A：可以。脚本本体不含任何敏感信息（CLIENT_ID 是微软公开的 CLI 客户端 ID）。`refresh_token` 和 `TODO_LIST_ID` 都在 Tampermonkey 存储里，不在文件里。

**Q：能不能在多浏览器/多设备共享授权？**
A：不能直接共享 GM storage。但 Tampermonkey 设置可以开 **云同步**（基于 Google Drive / Dropbox），把脚本的 GM 数据跨设备同步。或者在每台设备上各做一次首次配置即可。

**Q：To-Do 任务里我手动加了 emoji 备注（如 `🎾5.1 (带球拍) 东7 20-21`）会被覆盖吗？**
A：**会**。脚本下次 merge 时会重排 title 段，自由文本"(带球拍)"会丢。手动备注请放到 body 里，body 是 append-only 不会被覆盖。
