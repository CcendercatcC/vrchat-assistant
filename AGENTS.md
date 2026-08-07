# VRChat 好友监控服务 (vrc-monitor)

基于 Node.js 的 VRChat 好友在线状态监控服务，配合 Hermes 插件和桌面插件使用，支持自动抓取 OTP 验证码登录。

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

**获取 QQ 邮箱 IMAP 授权码：**
1. 登录 QQ 邮箱网页版
2. 设置 → 账户 → POP3/IMAP/SMTP/Exchange/CardDAV/CalDAV 服务
3. 开启 IMAP/SMTP 服务，按提示发送短信后生成授权码
4. 将授权码填入 `qqmail_auth_code` 字段

### 2. 设置环境变量（可选）

- `VRC_MONITOR_DIR`：指向本仓库目录（克隆后服务所在目录）。若 agent 在仓库目录内运行，服务可自动探测，无需手动设置。
- `VRC_MONITOR_NODE`：指向 Node.js 可执行文件路径。若不设置，自动从 PATH 查找 `node`。

### 3. 启动服务

```bash
node start-monitor.js
```

健康检查：

```bash
curl http://127.0.0.1:8799/health
```

### 4. 安装 Hermes 插件

将 `hermes-plugin/` 目录下的文件复制到 `~/.hermes/plugins/vrc-monitor/`，然后执行：

```bash
hermes plugins enable vrc-monitor
```

### 5. 安装桌面插件

将 `desktop/plugin.js` 复制到 `~/.hermes/desktop-plugins/vrc-monitor/`，重启 Hermes Gateway 并在桌面端执行「Reload desktop plugins」。

## 常见问题

### OTP 验证码自动抓取

服务通过 IMAP 协议自动抓取 QQ 邮箱中的 VRChat OTP 验证码邮件，无需手动输入验证码。确保 `credentials.json` 中的 `qqmail_auth_code` 配置正确。

### 代理说明

如需通过代理访问 VRChat API，请在启动前设置 `HTTPS_PROXY` 或 `HTTP_PROXY` 环境变量。
