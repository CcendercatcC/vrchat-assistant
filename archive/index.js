/**
 * VRCX MCP Actions — MCP proxy server with write action support
 * 
 * Runs on port 8799, forwards standard queries to VRCX-0 (port 8798),
 * and adds write tools (boop, invite, requestInvite) that call VRChat API directly.
 * 
 * Auth: reads Bearer token from incoming Authorization header,
 *       forwards it to VRCX-0 for authentication on proxied requests.
 */
import http from 'node:http';
import { VrchatApiClient } from './vrchat-api.js';
import { Vrcx0Proxy } from './proxy.js';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const MY_PORT = 8799;
const COOKIE_FILE = fileURLToPath(new URL('./auth_cookie.txt', import.meta.url));
const CRED_FILE = fileURLToPath(new URL('./credentials.json', import.meta.url));
const OTP_SCRIPT = fileURLToPath(new URL('./fetch-otp.py', import.meta.url));

// --- Custom tool definitions ---
const CUSTOM_TOOLS = [
  {
    name: 'send_boop',
    description: '[write·vrchat] Send a boop (poke) to a VRChat user. Requires userId (usr_...) and optional emojiId. Confirm with user before sending.',
    inputSchema: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: 'VRChat user id (usr_...)' },
        emojiId: { type: 'string', description: 'Optional emoji ID for the boop' },
      },
      required: ['userId'],
    },
  },
  {
    name: 'send_invite',
    description: '[write·vrchat] Send an invite to join your current instance. Requires userId, worldId, instanceId.',
    inputSchema: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: 'VRChat user id (usr_...)' },
        worldId: { type: 'string', description: 'World ID (wrld_...)' },
        instanceId: { type: 'string', description: 'Instance ID' },
        message: { type: 'string', description: 'Optional invite message' },
      },
      required: ['userId', 'worldId', 'instanceId'],
    },
  },
  {
    name: 'request_invite',
    description: '[write·vrchat] Request an invite from a user. Requires userId.',
    inputSchema: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: 'VRChat user id (usr_...)' },
        message: { type: 'string', description: 'Optional message' },
      },
      required: ['userId'],
    },
  },
  {
    name: 'submit_otp',
    description: '[auth] Submit email OTP code to complete VRChat login. Only needed when write tools report "Auth requires email OTP".',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: '6-digit OTP code from email' },
      },
      required: ['code'],
    },
  },
  {
    name: 'check_auth_status',
    description: '[auth] Check VRChat authentication status. Returns whether the auth cookie is valid and shows current user info.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

// --- Session state ---
const sessions = new Map();

class McpSession {
  constructor() {
    this.id = randomUUID();
    this.vrcxSessionId = '';
    this.vrcxToken = '';
    this.initialized = false;
  }
}

function getOrCreateSession(sessionId) {
  if (!sessionId || !sessions.has(sessionId)) {
    const s = new McpSession();
    sessions.set(s.id, s);
    return s;
  }
  return sessions.get(sessionId);
}

function sendSSE(res, events, sessionId) {
  if (res.headersSent) return;
  let body = '';
  for (const event of events) {
    body += `data: ${JSON.stringify(event)}\n\n`;
  }
  const headers = {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Content-Length': Buffer.byteLength(body),
  };
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;
  res.writeHead(200, headers);
  res.end(body);
}

function sendError(res, id, message) {
  sendSSE(res, [{
    jsonrpc: '2.0', id,
    error: { code: -32603, message },
  }]);
}

/**
 * Auto-fetch VRChat OTP code from QQ邮箱 via IMAP
 */
function autoFetchOtp(creds) {
  if (!creds?.qqmail_auth_code) return null;
  if (!existsSync(OTP_SCRIPT)) {
    console.log(`[MCP Actions] ⚠️ OTP script not found at ${OTP_SCRIPT}`);
    return null;
  }
  try {
    console.log(`[MCP Actions] 📧 Auto-fetching OTP from QQ邮箱...`);
    const result = execSync(
      `python "${OTP_SCRIPT}" "${creds.email}" "${creds.qqmail_auth_code}"`,
      { timeout: 15000, encoding: 'utf-8' }
    ).trim();
    if (result && /^\d{6}$/.test(result)) {
      console.log(`[MCP Actions] ✅ OTP fetched: ${result}`);
      return result;
    }
    console.log(`[MCP Actions] ❌ No valid OTP in email: ${result}`);
    return null;
  } catch (err) {
    console.log(`[MCP Actions] ❌ OTP fetch failed: ${err.message}`);
    return null;
  }
}

// ── Request logger ─────────────────────────────────────────────
function logReq(method, url, sessionId, msg) {
  const ts = new Date().toISOString().slice(11, 19);
  const sid = (sessionId || '').slice(0, 8);
  console.log(`[${ts}][${method} ${url}]${sid ? '['+sid+']' : ''} ${msg}`);
}

// --- Main ---
async function main() {
  // Read VRChat credentials
  let creds;
  try {
    creds = JSON.parse(readFileSync(CRED_FILE, 'utf-8'));
  } catch {
    console.error('credentials.json 读取失败 — 请在项目根目录配置凭据文件');
    process.exit(1);
  }

  // Setup VRChat API client for write actions
  const vrchat = new VrchatApiClient(creds.email, creds.password);
  let loggedIn = vrchat.loadCookieFromFile(COOKIE_FILE);

  async function tryAutoLogin() {
    try {
      const result = await vrchat.tryLoginWithCredentials();
      if (result.requiresOtp) {
        console.log(`[MCP Actions] ⚠️ Needs email OTP — attempting auto-fetch...`);
        const otp = autoFetchOtp(creds);
        if (otp) {
          await vrchat.loginWithOtp(otp);
          console.log(`[MCP Actions] ✅ Auto-OTP verified! Logged in as: ${vrchat.currentUser?.displayName}`);
          return true;
        }
        console.log(`[MCP Actions] ⚠️ Auto-OTP failed. Use submit_otp tool.`);
        return false;
      }
      console.log(`[MCP Actions] ✅ Re-authenticated as: ${result.user.displayName}`);
      return true;
    } catch (err) {
      console.log(`[MCP Actions] ❌ Auth failed: ${err.message}`);
      return false;
    }
  }

  if (loggedIn) {
    try {
      const user = await vrchat.ensureAuth();
      console.log(`[MCP Actions] ✅ VRChat write actions ready as: ${user.displayName}`);
      loggedIn = true;
    } catch (err) {
      if (err.needsOtp) {
        loggedIn = await tryAutoLogin();
      } else {
        loggedIn = await tryAutoLogin();
      }
    }
  } else {
    loggedIn = await tryAutoLogin();
  }

  const server = http.createServer(async (req, res) => {
    // Catch any unhandled throw in the handler to prevent 502
    try {
      await handleRequest(req, res, vrchat, creds);
    } catch (err) {
      logReq(req.method, req.url, '', `❌ Unhandled: ${err.message}`);
      if (!res.headersSent) {
        try {
          res.writeHead(502, { 'Content-Type': 'text/plain', 'Content-Length': Buffer.byteLength(err.message) });
          res.end(err.message);
        } catch {}
      }
    }
  });

  // ── Server-level error handler (prevents crash on connection drop) ──
  server.on('clientError', (err, socket) => {
    console.error(`[MCP Actions] ⚠️ Client error: ${err.message}`);
    if (socket.writable) {
      try {
        socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      } catch {}
    }
  });

  server.on('error', (err) => {
    console.error(`[MCP Actions] 🔴 Server error: ${err.message}`);
  });

  server.listen(MY_PORT, '127.0.0.1', () => {
    console.log(`\n[MCP Actions] 🚀 Server running on http://127.0.0.1:${MY_PORT}/mcp`);
    console.log(`[MCP Actions]    → Read-only tools proxied to VRCX-0 :8798 (uses client's Bearer token)`);
    console.log(`[MCP Actions]    → Write tools: ${CUSTOM_TOOLS.map(t => t.name).join(', ')}`);
    console.log(`[MCP Actions]    → VRChat auth: ${loggedIn ? '✅ Active' : '❌ Not logged in'}`);
    console.log(`[MCP Actions]    → MCP client config:`);
    console.log(`       {\n        "mcpServers": {\n          "vrcx-0": {\n            "url": "http://127.0.0.1:${MY_PORT}/mcp",\n            "headers": {\n              "Authorization": "Bearer <TOKEN>"\n            }\n          }\n        }\n       }`);
    // Warn about Windows system proxy
    const systemProxy = process.env.HTTP_PROXY || process.env.http_proxy || '';
    if (systemProxy) {
      console.log(`[MCP Actions] ⚠️ 系统代理检测: ${systemProxy}`);
      console.log(`[MCP Actions]    hermes mcp test 报 502? → 设置 NO_PROXY=127.0.0.1,localhost`);
    }
    console.log();
  });
}

async function handleRequest(req, res, vrchat, creds) {
  // Health check endpoint — also reports auth status
  if (req.method === 'GET' && req.url === '/health') {
    const authStatus = await vrchat.checkAuth();
    const body = JSON.stringify({
      ok: true,
      auth: authStatus.valid ? { authenticated: true, user: authStatus.displayName }
        : { authenticated: false, needsOtp: vrchat.requiresOtp,
           message: vrchat.requiresOtp ? 'Needs OTP' : 'No auth cookie' },
    });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
    return;
  }

  // Handle GET /mcp — some MCP clients probe with GET first
  if (req.method === 'GET' && req.url === '/mcp') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Content-Length': 0 });
    res.end();
    return;
  }

  if (req.method !== 'POST' || req.url !== '/mcp') {
    res.writeHead(404);
    res.end('Not Found');
    return;
  }

  // Extract VRCX-0 auth token from incoming request
  const authHeader = req.headers['authorization'] || '';
  const bearerToken = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7).trim()
    : '';

  let body = '';
  req.on('data', (chunk) => body += chunk);
  req.on('end', async () => {
    try {
      const rpc = JSON.parse(body);
      const sessionId = req.headers['mcp-session-id'];
      const session = getOrCreateSession(sessionId);

      // Store the token on the session (first time)
      if (bearerToken && !session.vrcxToken) {
        session.vrcxToken = bearerToken;
      }

      logReq('MCP', rpc.method || '?', session.id, `${body.slice(0, 80)}...`);
      await handleRpc(rpc, session, res, vrchat, creds);
    } catch (err) {
      console.error('[MCP Actions] Error:', err);
      sendError(res, null, 'Parse error: ' + err.message);
    }
  });
}

async function handleRpc(rpc, session, res, vrchat, creds) {
  const { id, method, params } = rpc;

  // Build proxy with the session's token
  const proxy = new Vrcx0Proxy(session.vrcxToken);

  switch (method) {
    case 'initialize': {
      session.initialized = true;
      // Init VRCX-0 session with the client's token
      if (session.vrcxToken) {
        try {
          const initResult = await proxy.initialize();
          if (initResult.sessionId) {
            session.vrcxSessionId = initResult.sessionId;
            await proxy.notifyInitialized(session.vrcxSessionId);
          }
        } catch (err) {
          console.warn(`[MCP Actions] ⚠️ VRCX-0 init: ${err.message}`);
        }
      }
      sendSSE(res, [{
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: '2025-03-26',
          capabilities: { tools: {}, resources: {} },
          serverInfo: { name: 'vrcx-0-actions', version: '1.0.0' },
        },
      }], session.id);
      break;
    }

    case 'notifications/initialized':
      sendSSE(res, [], session.id);
      break;

    case 'tools/list': {
      let vrcxTools = { tools: [] };
      if (session.vrcxToken) {
        try {
          const result = await proxy.listTools(session.vrcxSessionId);
          if (result.events.length > 0) vrcxTools = result.events[0].result;
        } catch (err) {
          console.warn(`[MCP Actions] ⚠️ VRCX-0 tools/list: ${err.message}`);
        }
      }
      const allTools = [...(vrcxTools.tools || []), ...CUSTOM_TOOLS];
      sendSSE(res, [{ jsonrpc: '2.0', id, result: { tools: allTools } }], session.id);
      break;
    }

    case 'tools/call': {
      const { name, arguments: args } = params;
      const customTool = CUSTOM_TOOLS.find(t => t.name === name);
      if (customTool) {
        await handleCustomTool(id, name, args, res, vrchat, creds);
        return;
      }
      // Forward to VRCX-0
      if (!session.vrcxToken) {
        sendError(res, id, 'VRCX-0 authentication required: send Authorization: Bearer <token> header');
        return;
      }
      try {
        const result = await proxy.callTool(session.vrcxSessionId, name, args);
        sendSSE(res, result.events, session.id);
      } catch (err) {
        sendError(res, id, `VRCX-0 proxy error: ${err.message}`);
      }
      break;
    }

    default:
      sendSSE(res, [], session.id);
  }
}

async function handleCustomTool(id, name, args, res, vrchat, creds) {
  // If OTP needed, try auto-fetch up to 2 times (in case email is delayed)
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      let result;
      switch (name) {
        case 'check_auth_status': {
          const status = await vrchat.checkAuth();
          if (status.valid) {
            result = { authenticated: true, user: status.displayName };
          } else {
            result = { authenticated: false, message: vrchat.requiresOtp
              ? 'Auth requires email OTP. Please call submit_otp tool with the 6-digit code.'
              : 'Not logged in.' };
          }
          console.log(`[MCP Actions] 🔍 Auth check: ${JSON.stringify(result)}`);
          break;
        }
        case 'submit_otp': {
          const { code } = args;
          if (!code || code.length < 4) throw new Error('Invalid OTP code');
          console.log(`[MCP Actions] 🔑 Submitting OTP code...`);
          await vrchat.loginWithOtp(code);
          result = { success: true, message: 'OTP verified! Write actions are now available.' };
          console.log(`[MCP Actions] ✅ OTP verified, write actions ready`);
          break;
        }
        case 'send_boop': {
          const { userId, emojiId } = args;
          if (!userId?.startsWith('usr_')) throw new Error('Invalid userId');
          console.log(`[MCP Actions] 👆 Booping ${userId}${emojiId ? ' with emoji' : ''}`);
          const response = await vrchat.sendBoop(userId, emojiId || '');
          if (response.status >= 400) throw new Error(`API error ${response.status}: ${JSON.stringify(response.data)}`);
          result = { success: true, userId, booped: true };
          console.log(`[MCP Actions] ✅ Boop sent`);
          break;
        }
        case 'send_invite': {
          const { userId, worldId, instanceId, message } = args;
          if (!userId?.startsWith('usr_')) throw new Error('Invalid userId');
          if (!worldId?.startsWith('wrld_')) throw new Error('Invalid worldId');
          console.log(`[MCP Actions] 📨 Inviting ${userId} to ${worldId}:${instanceId}`);
          const response = await vrchat.sendInvite(userId, worldId, instanceId, message);
          if (response.status >= 400) throw new Error(`API error ${response.status}: ${JSON.stringify(response.data)}`);
          result = { success: true, userId, invited: true };
          console.log(`[MCP Actions] ✅ Invite sent`);
          break;
        }
        case 'request_invite': {
          const { userId, message } = args;
          if (!userId?.startsWith('usr_')) throw new Error('Invalid userId');
          console.log(`[MCP Actions] 🙏 Requesting invite from ${userId}`);
          const response = await vrchat.requestInvite(userId, message || '');
          if (response.status >= 400) throw new Error(`API error ${response.status}: ${JSON.stringify(response.data)}`);
          result = { success: true, userId, requestSent: true };
          console.log(`[MCP Actions] ✅ Invite request sent`);
          break;
        }
        default:
          throw new Error(`Unknown tool: ${name}`);
      }
      sendSSE(res, [{
        jsonrpc: '2.0', id,
        result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] },
      }]);
      return; // Success — exit
    } catch (err) {
      if (err.needsOtp && attempt < 2) {
        console.log(`[MCP Actions] ⚠️ OTP needed (attempt ${attempt + 1}) — auto-fetching from QQ邮箱...`);
        const otp = autoFetchOtp(creds);
        if (otp) {
          try {
            await vrchat.loginWithOtp(otp);
            console.log(`[MCP Actions] ✅ Auto-OTP verified, retrying tool...`);
            continue; // Retry the tool call
          } catch (otpErr) {
            console.log(`[MCP Actions] ❌ Auto-OTP failed: ${otpErr.message}`);
          }
        }
        // Wait a bit in case email is delayed
        if (attempt === 0) {
          await new Promise(r => setTimeout(r, 3000));
          const otp2 = autoFetchOtp(creds);
          if (otp2) {
            try {
              await vrchat.loginWithOtp(otp2);
              console.log(`[MCP Actions] ✅ Auto-OTP verified (retry), continuing tool...`);
              continue;
            } catch {}
          }
        }
        // Give up — tell user
        sendSSE(res, [{
          jsonrpc: '2.0', id,
          error: {
            code: -32001,
            message: 'Auth requires email OTP. Use the submit_otp tool with the 6-digit code from your email.',
          },
        }]);
        return;
      }
      console.error(`[MCP Actions] ❌ ${name} failed: ${err.message}`);
      sendError(res, id, err.message);
      return;
    }
  }
}

main().catch(err => {
  console.error('[MCP Actions] Fatal:', err);
  process.exit(1);
});
