---
name: vrchat-assistant-development
description: "Use when developing new features or fixing bugs in the vrchat-assistant repo: add an MCP tool, modify existing behavior, or submit a PR. Enforces the repo's DEVELOPMENT.md constraints."
version: 1.0.0
metadata:
  hermes:
    tags: [vrchat, development, mcp, feature, pr]
---

# vrchat-assistant 开发 Skill — 新增功能 / 修改功能 / 提交 PR

本 skill 面向**任何 AI Agent**：当使用者要求给 vrchat-assistant 添加新功能、修改现有功能、修复 bug，或提交 PR 时使用。强制遵守仓库根 `DEVELOPMENT.md` 的全部开发约束。

## 触发条件

- 使用者说"给 vrchat-assistant 加个功能 / 做个工具 / 改一下 XX 行为"
- 使用者要求在仓库内新增脚本、MCP 工具、数据库字段、定时任务
- 使用者要求修复 bug 并提交 issue + PR
- 任何对 `core/`、`start-monitor.js`、`hermes-plugin/`、`desktop/` 下代码的修改

## 开发前必读

按顺序阅读（缺失即补读）：

1. `README.md` — 项目概览（人类简介）
2. `AGENTS.md` — 部署配置（凭据 / 环境变量 / 启动 / 插件）
3. `ARCHITECTURE.md` — 系统架构（数据流 / 模块职责 / handler 划分）
4. `DEVELOPMENT.md` — **开发规范（本 skill 的依据，动手前完整读，§3 跨平台约束必读）**

## 总体原则

- **AI 完成开发，人类只提需求**：使用者不直接编码。流程 = 需求 → 读文档 → 实现 → 自测 → 使用者验收 →（可选）PR
- **新功能默认做成 MCP 工具，禁止只写孤立 CLI 脚本**（2026-08-09 固化）：Agent 通过 MCP `tools/call` 与功能交互，独立脚本 = 功能不可达
- **身份表达**：issue / PR / commit 一律以 AI Agent 口吻书写，不冒用使用者人称（"使用者提出…"而非"我需要…"）；commit author 保持 Agent 自身身份
- **fork 自由、PR 自愿**：自用功能不必提 PR；发现缺陷是义务，必须主动上报（issue + 修复 PR）

## 新增功能标准流程（三件套）

新增一个 MCP 工具的固定套路（参考 `recommend_worlds` / `get_weekly_report` 等既有工具）：

### 1. 工具定义 — `core/mcp-definitions.js`

在 `CUSTOM_TOOLS` 数组追加对象：

```js
{
  name: 'new_tool_name',
  description: '[域·说明] 一句话描述用途与关键参数。',
  inputSchema: {
    type: 'object',
    properties: { /* 参数定义，含 type/description/default */ },
    required: ['xxx'],
  },
}
```

- 命名：snake_case，动词开头（get_/set_/search_/send_/upload_/x_ 等），前缀按能力域（如 x_ 表示 X 博主域）
- description 前缀标注能力域：`[query]` / `[write·vrchat]` / `[查询·X推荐]` 等，参考既有工具风格

### 2. handler — `core/handlers/<功能域>.js`

- 按功能域放对应文件（friends.js / events.js / groups.js / media.js / instance.js / recommend.js / misc.js），新域可建新文件
- 函数签名参考既有 handler（如 `handleGetWeeklyReport`）：**复用主服务登录态**（`ctx.serverState.authUser` + `ctx.api` 实例），不要重复实现登录 / OTP / 凭据读取
- 数据库读写走 `storage`（`_query` / `_run` / `db.transaction`），建表沿用 `core/init-db.sql` 幂等写法（`IF NOT EXISTS`），SQL 一律参数占位符禁止拼接
- 异步路径必须 try/catch；WebSocket 消息处理不得因单条异常中断服务
- **限流不要嵌套**（2026-08-09 真实死锁事故）：handler 内部逐请求 `rateLimiter.execute` 时，RPC case 层**不要再包一层**——外层执行时 `_processing=true`，内层永远排不上队，整个 handler 挂死

### 3. 路由 — `core/rpc-router.js`

在 `handleRpc` 的 switch/case 加新工具的 case，映射到 handler。参考既有 case 写法，注意区分"直接内联访问 ctx.api"与"调用 handler 模块"两种形态。

## 硬性约束（违反即打回）

1. **单一职责**：一个 PR 只做一件事，夹带无关重构/格式化/改名整单打回
2. **无个人环境硬编码**：禁止本机路径（`C:\Users\xxx`、`/home/xxx`）、个人代理、个人账号、个人 Cookie
3. **不破坏现有行为**：既有工具调用方式与返回结构不得随意改变；WS 采集/落库不能回归；Hermes/桌面插件依赖的接口保持不变
4. **DB 变更必须带迁移**：只改 `init-db.sql` 不够——存量用户已有数据库，新增表/列必须幂等迁移（`ALTER TABLE ... ADD COLUMN IF NOT EXISTS` 或独立迁移脚本），PR 描述注明
5. **文档同步（三处）**：新增工具后登记进：
   - `skills/vrc-monitor-agent/SKILL.md`「MCP 工具」表格（**权威登记位置**，2026-08-15 起 README 不再平铺工具清单）
   - `AGENTS.md` §6 工具列举（采样列举，补新工具名）
   - README 核心能力若涉及新能力域，同步更新描述
   - 若新工具属于 BOOTH 域，另登记进 `skills/booth-query-display/SKILL.md`
6. **Conventional Commits**：`feat:` / `fix:` / `docs:` / `refactor:` / `chore:` 前缀，中文描述
7. **版本号与发布由作者决定**：不修改 package.json version、不打 tag、不创建 release
8. **文档用中文**；**不提交任何密钥**（credentials.json / cookie / token / 密码 / IMAP 授权码）
9. **MIT 许可延续**：保持 LICENSE 及版权声明
10. **PR 描述三段式**：「需求来源（使用者提出…）→ 实现方式 → 验证过程与结果」，验证可复现（参考 test-apis.mjs / test-websocket.mjs）

## 跨平台约束（重点）

服务不一定跑在运行 VRChat 的机器上（可能跑 NAS / 服务器 / Docker / Alpine）。所有新代码必须：

- **headless 可运行**：纯 Node 命令行进程，无 GUI 依赖；禁止硬性要求 VRChat 客户端在本机
- **探测式本机增强 + 静默回退**：Windows 专属逻辑（如命名管道）必须平台门控（`process.platform === 'win32'`）、封装 `core/` 独立模块、探测失败静默回退跨平台 API 路径
- **路径拼接用 `path.join()`**；禁止 spawn 平台专属外壳命令
- **原生依赖谨慎**：优先纯 JS；确需原生模块（如 better-sqlite3）说明 prebuilt 对各平台（含 ARM NAS / Alpine）覆盖
- **新增参数环境变量化**：不新增硬编码端口/路径/代理；WebSocket 代理回退已支持 `VRC_MONITOR_WS_PROXY` 覆盖
- **网络健壮**：断线重连 / 限流 / 认证冷却是基本要求，新增网络逻辑保持同样健壮；禁止硬编码代理地址
- **时区语义**：DB 存 UTC，展示层转本地时区；禁止假设服务机器与看数据的人在同时区
- **数据可迁移**：禁止写死 DB 绝对路径；相对服务目录或环境变量
- **容器友好**：无状态 + 数据卷挂载、日志走 stdout（不新增写日志文件逻辑）、优雅处理 SIGTERM/SIGINT
- **资源占用**：push 不 pull（禁止每 N 秒全量轮询）、REST 走限流、定时任务防重叠、聚合优先 SQL 不把全量数据捞进内存

## 验证（提交前必做）

- 涉及 API / WS / DB 的功能改动，**必须实际运行验证**，不能只静态分析就声称完成
- 现有脚本：`test-apis.mjs`（REST）、`test-websocket.mjs` / `test-ws-direct.mjs`（WS）、`analyze-db.mjs`（DB 分析）
- 服务级验证：`node start-monitor.js` → `/health` 返回 `authenticated: true`、`ws.status: connected`
- 新增工具实测：`curl -X POST http://127.0.0.1:8799/mcp -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"<新工具>","arguments":{...}}}'` 走一遍真实调用
- 文档漂移检查（若改动涉及工具/文档）：`python scripts/check-doc-drift.py`，应退出码 0、结论"无漂移"

## 提交前自检清单

- [ ] `git status` 无 credentials.json / cookie / token 等敏感文件
- [ ] 无本机路径、个人代理、个人账号残留
- [ ] `node start-monitor.js` 正常启动，`/health` 返回 authenticated: true + ws connected
- [ ] 至少跑一遍相关测试脚本，或说明为什么不适用
- [ ] 新工具已登记进 skill 工具表格（+ AGENTS.md 列举 + README 能力域描述）
- [ ] DB 变更已考虑存量库迁移
- [ ] 提交信息 Conventional Commits 格式
- [ ] `python scripts/check-doc-drift.py` 无漂移

## Pitfalls

- ⚠️ **不要只写 CLI 脚本**：新功能必须是 MCP 工具三件套（定义 + handler + 路由），否则 Agent 无法调用，等于没做
- ⚠️ **限流嵌套死锁**：handler 内已逐请求限流时，case 层绝不包第二层 rateLimiter.execute
- ⚠️ **工具登记位置已变更（2026-08-15）**：权威登记 = `skills/vrc-monitor-agent/SKILL.md` 工具表格，不再是 README（README 是纯人类简介，不写工具清单）
- ⚠️ **README 不写工具总数**：全仓库禁止"N 个 MCP 工具"表述，只维护工具名清单
- ⚠️ **DB 迁移必须幂等**：存量库 vrc-monitor.sqlite3 存在，ALTER TABLE 用 IF NOT EXISTS 防重复执行
- ⚠️ **Windows 增强必须可回退**：命名管道等专属逻辑探测失败要静默回退，功能不缺失
