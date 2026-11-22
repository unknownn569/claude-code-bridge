// Manual smoke test against a running bridge:
//   BRIDGE_TOKEN=... BASE=http://127.0.0.1:8080 npm run smoke
const base = process.env.BASE ?? 'http://127.0.0.1:8080';
const token = process.env.BRIDGE_TOKEN;
if (!token) {
  console.error('Set BRIDGE_TOKEN (must match the server) and BASE.');
  process.exit(1);
}

async function rpc(id: number, method: string, params: Record<string, unknown> = {}) {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const health = await fetch(`${base}/healthz`);
console.log('healthz', health.status, await health.text());

const tools = await rpc(1, 'tools/list');
console.log('tools/list', tools.status, (tools.body.result as { tools: unknown[] })?.tools?.length, 'tools');

const listed = await rpc(2, 'tools/call', { name: 'list_sessions', arguments: {} });
console.log('list_sessions', listed.status, JSON.stringify(listed.body.result));
