# VRChat 好友监控系统 (vrc-monitor)

> 自建 VRChat 好友动态监控系统 · 替代 VRCX-0
> 技术栈：Node.js + SQLite + WebSocket + MCP + Hermes 插件

监控 VRChat 好友的上下线、世界切换、Avatar/状态变化，通过 WebSocket 实时采集入库，经 MCP 协议暴露给 AI Agent（Hermes）查询，并附带 Hermes 插件实现进程托管。

---

## ✨ 功能

- ✅ **WebSocket 实时监控** — 好友上线/下线/换世界即时入库
- ✅ **自动重连 + 认证自愈** — 指数退避（1s→60s）+ cookie 过期自动 OTP 邮箱取码登录，无需人工干预
- ✅ **自动 OTP 登录** — 邮箱验证码自动从 QQ 邮箱 IMAP 抓取，全链路无人值守
- ✅ **历史数据迁移** — 从 VRCX-0 导入 10 个月的 33 万条活动记录
- ✅ **世界名缓存** — 自动解析 `wrld_xxx` 为可读世界名（24h TTL 防改名陈旧）
- ✅ **关注名单** — 标记核心好友，活动时特别通知
- ✅ **MCP 工具接口** — 15 个工具供 Hermes / 任意 MCP 客户端调用
- ✅ **Hermes 插件托管** — 会话自动拉起、崩溃自愈、`vrc_status` 等管理工具

## 🚀 快速开始

### 0. 准备

- Node.js ≥ 18
- 一个 VRChat 账号（需开启邮箱 2FA）
- 一个 QQ 邮箱（用于接收 OTP 验证码，需生成 IMAP 授权码）

### 1. 配置凭据

复制模板并填入真实凭据（**该文件不会入库**）：

```bash
cp credentials.example.json credentials.json
```

```json
{
  "email": "你的VRChat登录邮箱",
  "password": "你的VRChat密码",
  "qqmail_auth_code": "QQ邮箱IMAP授权码"
}
```

> QQ 邮箱授权码获取：QQ 邮箱 → 设置 → 账号 → 开启 IMAP/SMTP → 生成授权码。

### 2. 启动服务

```bash
cd vrcx-mcp-actions
node start-monitor.js
```

首次启动会提示邮箱验证码，系统自动从 QQ 邮箱抓取并完成登录，随后保持运行。

### 3. 健康检查

```bash
curl http://127.0.0.1:8799/health
```

正常响应：`Auth: true`、`WS: connected`、在线好友数。

## 🤖 Hermes 插件（进程托管）

服务本身是独立 Node 进程；若要交给 Hermes 托管（会话启动自动拉起、崩溃自愈），安装 `hermes-plugin/` 下的插件：

```bash
# 1. 复制插件到 Hermes 用户插件目录（含 dashboard 后端子目录，必须带 -r）
mkdir -p ~/.hermes/plugins/vrc-monitor
cp -r hermes-plugin/* ~/.hermes/plugins/vrc-monitor/

# 2. 启用（需要 hermes 环境）
hermes plugins enable vrc-monitor

# 3. 重启 Hermes 会话生效
```

桌面插件（GUI 配置入口，可选）：

```bash
mkdir -p ~/.hermes/desktop-plugins/vrc-monitor
cp desktop/plugin.js ~/.hermes/desktop-plugins/vrc-monitor/
# 重启 Gateway + 桌面端 ⌘K → Reload desktop plugins
```

### 插件提供的工具

| 工具 | 说明 |
|------|------|
| `vrc_status` | 服务状态：进程存活 + auth/WS/在线数 |
| `vrc_start` | 幂等启动服务（已运行则返回现状） |
| `vrc_stop` | 停止服务 |
| `vrc_restart` | 重启服务 |

### 环境变量（可选覆盖）

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `VRC_MONITOR_DIR` | 自动探测（agent 在仓库目录内运行） | 服务目录（含 start-monitor.js），未探测到时需显式设置 |
| `VRC_MONITOR_NODE` | PATH 中的 node | Node 可执行文件路径 |

### 进程托管原理

- **on_session_start 钩子**：每次 Hermes 会话开始，探测 `:8799/health`，未运行则自动 spawn `node start-monitor.js`（detached）
- **状态文件**：`$HERMES_HOME/workspace/vrc-monitor/.active.json`（pid / started_at / log_file）
- **双路检测**：状态文件 pid 存活 **或** 端口探测成功，均可识别为运行中（防状态文件丢失误判）
- **日志**：`$HERMES_HOME/workspace/vrc-monitor/monitor.log`

## 🔌 MCP 工具（15 个）

服务监听 `http://127.0.0.1:8799/mcp`，通过 HTTP SSE 提供 MCP 协议。Hermes 用户可在 `~/.hermes/config.yaml` 配置：

```yaml
mcp_servers:
  vrcx-monitor:
    url: http://127.0.0.1:8799/mcp
```

### 好友查询

| 工具 | 说明 |
|------|------|
| `get_online_friends` | 当前在线好友列表（含位置/平台） |
| `get_friend_info` | 好友详细信息 |
| `search_users` | 按名字搜索用户 |

### 事件历史

| 工具 | 说明 |
|------|------|
| `get_friend_events` | 某好友的事件历史（本地数据库） |
| `get_recent_events` | 最新事件流 |
| `get_companions` | 同屏交叉查询（指定时间窗口内同实例的好友） |

### 世界名

| 工具 | 说明 |
|------|------|
| `get_world_name` | 世界名查询（缓存+API 回退，24h TTL） |

### 关注名单

| 工具 | 说明 |
|------|------|
| `get_watchlist` / `add_to_watchlist` / `remove_from_watchlist` | 关注名单管理 |

### 写操作（限流 2.6s）

| 工具 | 说明 |
|------|------|
| `send_boop` | 发送 Boop |
| `send_invite` | 发送邀请 |
| `request_invite` | 请求邀请 |

### 系统

| 工具 | 说明 |
|------|------|
| `get_server_status` | 服务/认证状态 |
| `get_database_stats` | 数据库统计 |

## 📁 目录结构

```
vrcx-mcp-actions/
├── start-monitor.js        # 主入口（Node 服务）
├── core/
│   ├── init-db.sql         # 数据库 DDL
│   ├── storage.js          # SQLite 封装
│   ├── ws-manager.js       # WebSocket 管理
│   ├── event-pipeline.js   # 事件处理管道
│   ├── friend-state.js     # 好友状态管理
│   ├── companions_method.js # 同屏查询实现
│   └── rate-limiter.js     # API 限流
├── vrchat-api.js           # VRChat API 客户端
├── fetch-otp.py            # QQ 邮箱 OTP 自动抓取
├── migrate-vrcx0.mjs       # VRCX-0 数据迁移脚本
├── hermes-plugin/          # Hermes 托管插件
│   ├── plugin.yaml
│   ├── __init__.py
│   ├── process_manager.py  # 进程生命周期管理
│   ├── tools.py
│   └── dashboard/          # 桌面插件后端 API
│       ├── manifest.json
│       └── plugin_api.py   # /status /credentials /doctor 等路由
├── desktop/
│   └── plugin.js           # Hermes 桌面插件（GUI 配置面板）
├── credentials.example.json # 凭据模板（复制为 credentials.json）
└── README.md
```

## 🛠 故障排查

**Q: WebSocket 连不上？**
A: 国内网络可能需代理。服务自动直连 6s 失败后回退到 `127.0.0.1:7892` 代理，无需人工干预。

**Q: 登录提示 OTP 但一直失败？**
A: 检查 `credentials.json` 的 `qqmail_auth_code` 是否为 QQ 邮箱 IMAP 授权码（非登录密码）。服务会在认证失败后冷却 120s（限流 401 则 5min）自动重试，不会高频刷验证码。

**Q: cookie 过期了要手动处理吗？**
A: 不需要。服务启动和 WS 重连都会自动走 OTP 取码登录，有效 cookie 自动落盘 `auth_cookie.txt`。

**Q: API 限流了怎么办？**
A: 系统内置 2.6s 间隔限流器。可在 `core/rate-limiter.js` 中调整 `minInterval`。

**Q: 数据库文件太大？**
A: 正常。约 28 万行事件 ≈ 200+ MB，sql.js 启动时全量加载到内存。

## 📄 License

MIT — 见 [LICENSE](LICENSE)。
