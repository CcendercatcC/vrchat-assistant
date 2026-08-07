/**
 * VRCX-0 MCP Proxy — forwards standard MCP requests to VRCX-0
 */
const VRCX0_URL = 'http://127.0.0.1:8798/mcp';

export class Vrcx0Proxy {
  constructor(authToken) {
    this.authToken = authToken;
  }

  async forward(jsonRpcBody, sessionId = '') {
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Authorization': `Bearer ${this.authToken}`,
    };
    if (sessionId) {
      headers['Mcp-Session-Id'] = sessionId;
    }

    const resp = await fetch(VRCX0_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(jsonRpcBody),
    });

    const respSessionId = resp.headers.get('mcp-session-id') || '';
    const body = await resp.text();

    // Parse SSE events
    const events = [];
    for (const line of body.split('\n')) {
      if (line.startsWith('data: ')) {
        const payload = line.slice(6).trim();
        if (payload) {
          try { events.push(JSON.parse(payload)); } catch {}
        }
      }
    }

    return { events, sessionId: respSessionId };
  }

  async initialize() {
    return await this.forward({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'vrcx-actions-proxy', version: '1.0' } },
    });
  }

  async notifyInitialized(sessionId) {
    return await this.forward({ jsonrpc: '2.0', method: 'notifications/initialized' }, sessionId);
  }

  async listTools(sessionId) {
    return await this.forward({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, sessionId);
  }

  async callTool(sessionId, name, args) {
    return await this.forward({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: args } }, sessionId);
  }
}
