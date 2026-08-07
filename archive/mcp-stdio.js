/**
 * MCP Stdio Server — bridges Hermes (stdio) to VRCX-0 HTTP MCP
 * 
 * Hermes launches this via command, communicates over stdin/stdout
 * using the MCP stdio protocol (JSON-RPC with Content-Length headers).
 * This script forwards requests to the HTTP proxy at port 8799.
 * It maintains the MCP session state across messages.
 */
const PROXY_URL = 'http://127.0.0.1:8799/mcp';
const AUTH_TOKEN = '--y3nRNUM8wVDG6fOROKYDG7jNBhV4_EDvrC6yScwPY';

let sessionId = '';
let buffer = '';

process.stdin.on('data', async (chunk) => {
  buffer += chunk.toString();
  process.stderr.write(`[DEBUG] Received ${chunk.length} bytes, buffer=${buffer.length}, first_100=${JSON.stringify(buffer.slice(0,100))}\n`);

  while (true) {
    const headerMatch = buffer.match(/^Content-Length:\s*(\d+)\r?\n\r?\n/);
    if (!headerMatch) break;

    const contentLength = parseInt(headerMatch[1], 10);
    const headerEnd = headerMatch.index + headerMatch[0].length;
    const body = buffer.slice(headerEnd, headerEnd + contentLength);

    if (body.length < contentLength) break;

    buffer = buffer.slice(headerEnd + contentLength);

    try {
      const msg = JSON.parse(body);
      await handleMessage(msg);
    } catch (err) {
      writeResponse({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: `Parse error: ${err.message}` },
      });
    }
  }
});

async function handleMessage(msg) {
  try {
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Authorization': `Bearer ${AUTH_TOKEN}`,
    };
    if (sessionId) {
      headers['Mcp-Session-Id'] = sessionId;
    }

    const resp = await fetch(PROXY_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(msg),
    });

    const newSessionId = resp.headers.get('mcp-session-id') || '';
    if (newSessionId) {
      sessionId = newSessionId;
    }

    const respBody = await resp.text();

    // Parse SSE events
    for (const line of respBody.split('\n')) {
      if (line.startsWith('data: ')) {
        const payload = line.slice(6).trim();
        if (payload) {
          const event = JSON.parse(payload);
          writeResponse(event);
        }
      }
    }
  } catch (err) {
    writeResponse({
      jsonrpc: '2.0',
      id: msg.id || null,
      error: { code: -32603, message: err.message },
    });
  }
}

function writeResponse(obj) {
  const str = JSON.stringify(obj);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(str)}\r\n\r\n${str}`);
}
