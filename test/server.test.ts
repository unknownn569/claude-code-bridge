import { describe, it, expect, afterAll } from 'vitest';
import { createApp } from '../src/server.js';
import { SessionManager } from '../src/sessions.js';
import type { BridgeConfig } from '../src/config.js';

const config: BridgeConfig = {
  anthropicApiKey: 'test-key',
  token: 'secret-token',
  workdir: '/tmp',
  maxTurns: 5,
  maxBudgetUsd: 1,
  port: 0,
};

const server = createApp(config, new SessionManager(config)).listen(0);
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
afterAll(() => server.close());

async function callMcp(token: string | null, body: unknown) {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const rpc = (id: number, method: string, params?: Record<string, unknown>) => ({
  jsonrpc: '2.0',
  id,
  method,
  params: params ?? {},
});

describe('bridge HTTP server', () => {
  it('GET /healthz works without auth', async () => {
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, sessions: 0 });
  });

  it('rejects requests without the token', async () => {
    const { status, json } = await callMcp(null, rpc(1, 'tools/list'));
    expect(status).toBe(401);
    expect(json).toMatchObject({ error: { code: 'unauthorized' } });
  });

  it('rejects a wrong token', async () => {
    const { status } = await callMcp('wrong', rpc(1, 'tools/list'));
    expect(status).toBe(401);
  });

  it('exposes the 7 bridge tools over MCP with a valid token', async () => {
    const { status, json } = await callMcp('secret-token', rpc(1, 'tools/list'));
    expect(status).toBe(200);
    const tools = (json.result as { tools: { name: string }[] }).tools.map((t) => t.name);
    expect(tools).toEqual([
      'start_task',
      'get_output',
      'send_message',
      'interrupt',
      'list_sessions',
      'list_pending_approvals',
      'resolve_approval',
    ]);
  });

  it('calls list_sessions and get_output with session_not_found error shape', async () => {
    const listed = await callMcp('secret-token', rpc(2, 'tools/call', { name: 'list_sessions', arguments: {} }));
    expect(listed.status).toBe(200);
    expect(listed.json.result).toMatchObject({ isError: false });

    const missing = await callMcp('secret-token', rpc(3, 'tools/call', {
      name: 'get_output',
      arguments: { session_id: 'nope', cursor: 0 },
    }));
    expect(missing.json.result).toMatchObject({ isError: true });
    const text = (missing.json.result as { content: { text: string }[] }).content[0]!.text;
    expect(JSON.parse(text)).toMatchObject({ error: { code: 'session_not_found' } });
  });

  it('rejects GET /mcp', async () => {
    const res = await fetch(`${base}/mcp`, { headers: { authorization: 'Bearer secret-token' } });
    expect(res.status).toBe(405);
  });
});
