/**
 * MCP stdio bridge — Hermes connects via stdio, this script bridges to HTTP proxy
 */
import { createInterface } from 'node:readline';
import http from 'node:http';

const PROXY_URL = 'http://127.0.0.1:8799/mcp';

const rl = createInterface({ input: process.stdin });

let buffer = '';
let contentLength = 0;

rl.on('line', (line) => {
  // Parse MCP JSON-RPC messages from stdin (newline-delimited JSON)
  try {
    const msg = JSON.parse(line);
    handleMessage(msg);
  } catch {
    // Not JSON, might be part of a larger message - ignore
  }
});

async function handleMessage(msg) {
  try {
    const resp = await fetch(PROXY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'Authorization': 'Bearer --y3nRNUM8wVDG6fOROKYDG7jNBhV4_EDvrC6yScwPY',
      },
      body: JSON.stringify(msg),
    });

    const body = await resp.text();
    const sid = resp.headers.get('mcp-session-id') || '';

    // Parse SSE events and write each as JSON to stdout
    for (const line of body.split('\n')) {
      if (line.startsWith('data: ')) {
        const payload = line.slice(6).trim();
        if (payload) {
          const event = JSON.parse(payload);
          const output = { ...event };
          if (sid) {
            output._meta = { ...output._meta, sessionId: sid };
          }
          process.stdout.write(JSON.stringify(output) + '\n');
        }
      }
    }
  } catch (err) {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: msg.id || null,
      error: { code: -32603, message: err.message },
    }) + '\n');
  }
}
