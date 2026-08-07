# VRChat 好友监控服务 (vrc-monitor)

基于 Node.js 的 VRChat 好友在线状态监控服务，配合 Hermes 插件和桌面插件使用，支持自动抓取 OTP 验证码登录。

**面向 AI Agent 的配置引导**：以下步骤可由 Agent 自动完成。建议 agent 在本仓库目录内运行（服务目录可自动探测，无需设置环境变量）。

## 配置步骤

### 1. 配置凭据文件

复制 `credentials.example.json` 为 `credentials.json`，填入以下信息：

```json
{
  "email": "你的 VRChat 登录邮箱",
  "password": "你的 VRChat 登录密码",
  "qqmail_auth_code": "你的 QQ 邮箱 IMAP 授权码"
}
```

> ⚠️ **必须使用 QQ 邮箱**：OTP 验证码自动抓取脚本（`fetch-otp.py`）通过 IMAP 协议连接 `imap.qq.com`，只有 QQ 邮箱能配合自动登录。

**获取 QQ 邮箱 IMAP 授权码：**
1. 登录 QQ 邮箱网页版
2. 设置 → 账户 → POP3/IMAP/SMTP/Exchange/CardDAV/CalDAV 服务
3. 开启 IMAP/SMTP 服务，按提示发送短信后生成授权码
4. 将授权码填入 `qqmail_auth_code` 字段

> `credentials.json` 已被 .gitignore 排除，不会提交到仓库。

### 2. 设置环境变量（可选）

- `VRC_MONITOR_DIR`：指向本仓库目录（克隆后服务所在目录）。若 agent 在仓库目录内运行，服务可自动探测，无需手动设置。
- `VRC_MONITOR_NODE`：指向 Node.js 可执行文件路径。若不设置，自动从 PATH 查找 `node`。

### 3. 启动服务

```bash
node start-monitor.js
```

服务启动后自动完成：加载凭据 → 校验 cookie → 过期则自动从 QQ 邮箱抓取 OTP 验证码登录 → 建立 WebSocket 连接。

健康检查：

```bash
curl http://127.0.0.1:8799/health
```

**验证成功的标准**：返回 JSON 中 `auth.authenticated` 为 `true`、`ws.status` 为 `connected`、`friendState.online` 为在线好友数。

### 4. 安装 Hermes 插件（进程托管）

```bash
# 复制整个插件目录（含 dashboard 后端子目录，必须带 -r）
mkdir -p ~/.hermes/plugins/vrc-monitor
cp -r hermes-plugin/* ~/.hermes/plugins/vrc-monitor/

# 启用
hermes plugins enable vrc-monitor
```

插件提供 `vrc_status` / `vrc_start` / `vrc_stop` / `vrc_restart` 工具，并在每次 Hermes 会话开始时自动拉起服务（on_session_start 钩子）。

> ⚠️ `dashboard/` 子目录（manifest.json + plugin_api.py）是桌面插件和 `hermes dashboard` 的后端 API，复制时**不能遗漏**，否则桌面端「配置」功能不可用。

### 5. 安装桌面插件（GUI 配置入口）

```bash
mkdir -p ~/.hermes/desktop-plugins/vrc-monitor
cp desktop/plugin.js ~/.hermes/desktop-plugins/vrc-monitor/
```

然后：
1. 重启 Hermes Gateway（加载 dashboard 后端路由）
2. 桌面端按 ⌘K → **Reload desktop plugins**

桌面端右侧出现「VRChat Monitor」面板：显示服务运行状态，点击「配置」可填写 VRChat 邮箱/密码/QQ 邮箱授权码（保存到 credentials.json），无需手工编辑文件。

## 常用操作

| 操作 | 命令/方式 |
|------|----------|
| 启动服务 | `node start-monitor.js` 或 Hermes 插件自动拉起 |
| 健康检查 | `curl http://127.0.0.1:8799/health` |
| 查询在线好友 | `curl -X POST http://127.0.0.1:8799/mcp -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_online_friends","arguments":{}}}'` |
| 查看服务状态 | Hermes 工具 `vrc_status` 或桌面插件面板 |
| 配置账号 | 桌面插件「配置」弹窗，或编辑 `credentials.json` |
| 重启服务 | Hermes 工具 `vrc_restart` |

## 常见问题

### OTP 验证码自动抓取失败

服务通过 IMAP 协议自动抓取 QQ 邮箱中的 VRChat OTP 验证码邮件，无需手动输入验证码。排查顺序：
1. 确认 `credentials.json` 中的 `qqmail_auth_code` 是 **IMAP 授权码**（非登录密码）
2. 确认邮箱是 QQ 邮箱
3. 连续多次触发 OTP 时，邮箱 IMAP 同步可能有延迟，服务会在冷却后自动重试（认证失败冷却 120s，限流 401 冷却 5min），无需人工干预

### 代理说明

如需通过代理访问 VRChat API，请在启动前设置 `HTTPS_PROXY` 或 `HTTP_PROXY` 环境变量。WebSocket 连接默认直连，6 秒超时后自动回退到 `127.0.0.1:7892` 代理。

### 服务目录找不到

如果 `vrc_status` 或桌面端显示"未找到服务目录"，说明 `VRC_MONITOR_DIR` 未设置且 agent 不在仓库目录内运行。解决：设置 `VRC_MONITOR_DIR` 指向本仓库目录，或在仓库目录内重启服务。
