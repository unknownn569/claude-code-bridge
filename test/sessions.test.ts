import { describe, it, expect, vi, afterEach } from 'vitest';
import { SessionManager } from '../src/sessions.js';
import type { BridgeConfig } from '../src/config.js';
import type { Query, SDKMessage, SDKUserMessage, Options } from '@anthropic-ai/claude-agent-sdk';

const config: BridgeConfig = {
  anthropicApiKey: 'test-key',
  token: 'test-token',
  workdir: '/tmp',
  maxTurns: 5,
  maxBudgetUsd: 1,
  port: 0,
};

const init = { type: 'system', subtype: 'init', session_id: 'claude-123' } as unknown as SDKMessage;
const assistant = (text: string) =>
  ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }) as unknown as SDKMessage;
const resultMsg = (text: string, opts: { isError?: boolean; subtype?: string } = {}) =>
  ({
    type: 'result',
    subtype: opts.subtype ?? (opts.isError ? 'error_during_execution' : 'success'),
    is_error: opts.isError ?? false,
    num_turns: 2,
    total_cost_usd: 0.01,
    result: text,
    duration_ms: 1,
    duration_api_ms: 1,
    stop_reason: null,
    usage: {},
    modelUsage: {},
    permission_denials: [],
  }) as unknown as SDKMessage;

/** Handler for each user message pushed into the stream: returns the events to emit. */
type Handler = (promptText: string) => SDKMessage[];

function fakeQuery(handlers: Handler[]) {
  const calls: Array<{ prompt: AsyncIterable<SDKUserMessage>; options: Options }> = [];
  const spawn = vi.fn((params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }): Query => {
    calls.push(params);
    const queue: SDKMessage[] = [];
    const waiters: Array<() => void> = [];
    const enqueue = (messages: SDKMessage[]) => {
      if (messages.length === 0) return;
      queue.push(...messages);
      waiters.shift()?.();
    };
    let pushIndex = 0;
    void (async () => {
      for await (const msg of params.prompt) {
        const text = typeof msg.message.content === 'string' ? msg.message.content : '';
        const events = handlers[pushIndex++]?.(text);
        // No handler (undefined) -> echo a success result. A handler may return [] to keep
        // the turn open (for interrupt tests) or its own event list including the result.
        enqueue(events === undefined ? [resultMsg(text)] : events);
      }
    })();
    return {
      [Symbol.asyncIterator]() {
        return {
          next: () => {
            if (queue.length > 0) return Promise.resolve({ value: queue.shift()!, done: false });
            return new Promise<{ value: SDKMessage; done: false }>((resolve) =>
              waiters.push(() => resolve({ value: queue.shift()!, done: false })),
            );
          },
        };
      },
      interrupt: async () => enqueue([resultMsg('interrupted by user')]),
    } as unknown as Query;
  });
  return { spawn, calls };
}

const wait = (ms = 20) => new Promise((r) => setTimeout(r, ms));

let ids: string[] = [];

function start(manager: SessionManager, prompt: string) {
  const snapshot = manager.startTask(prompt);
  ids.push(snapshot.id);
  return snapshot;
}

afterEach(() => {
  ids = [];
});

describe('SessionManager', () => {
  it('start_task returns immediately, then records init, assistant text and result', async () => {
    const { spawn } = fakeQuery([() => [init, assistant('hello there'), resultMsg('done')]]);
    const manager = new SessionManager(config, () => {}, spawn);
    const snapshot = start(manager, 'say hi');
    expect(snapshot.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(snapshot.status).toBe('running');
    await wait();
    const s = manager.get(snapshot.id)!;
    expect(s.claudeSessionId).toBe('claude-123');
    expect(s.status).toBe('idle');
    expect(s.costUsd).toBe(0.01);
    expect(s.messagesSince(0).messages.map((m) => [m.role, m.text])).toEqual([
      ['system', 'session started (claude session claude-123)'],
      ['assistant', 'hello there'],
      ['result', 'done'],
    ]);
  });

  it('get_output cursor returns only new messages', async () => {
    const { spawn } = fakeQuery([() => [init, assistant('first')]]);
    const manager = new SessionManager(config, () => {}, spawn);
    const { id } = start(manager, 'x');
    await wait();
    const s = manager.get(id)!;
    const first = s.messagesSince(0);
    expect(first.messages).toHaveLength(2);
    const second = s.messagesSince(first.nextCursor);
    expect(second.messages).toHaveLength(0);
  });

  it('send_message on a running session goes through the live stream, not a new query', async () => {
    const { spawn, calls } = fakeQuery([
      () => [resultMsg('turn one done')],
      (text) => [assistant(`replying to ${text}`), resultMsg('turn two done')],
    ]);
    const manager = new SessionManager(config, () => {}, spawn);
    const { id } = start(manager, 'begin');
    await wait();
    manager.get(id)!.send('follow up please');
    await wait(40);
    expect(calls).toHaveLength(1);
    const results = manager.get(id)!.messagesSince(0).messages.filter((m) => m.role === 'result');
    expect(results.map((m) => m.text)).toEqual(['turn one done', 'turn two done']);
    expect(
      manager
        .get(id)!
        .messagesSince(0)
        .messages.filter((m) => m.role === 'assistant')
        .map((m) => m.text),
    ).toEqual(['replying to follow up please']);
    expect(manager.get(id)!.status).toBe('idle');
  });

  it('send_message on a session whose turn finished pushes into the same open query', async () => {
    const { spawn, calls } = fakeQuery([
      () => [init, resultMsg('first done')],
      () => [resultMsg('resumed done')],
    ]);
    const manager = new SessionManager(config, () => {}, spawn);
    const { id } = start(manager, 'begin');
    await wait();
    manager.get(id)!.send('resume me');
    await wait();
    expect(calls).toHaveLength(1); // same query, streaming-input mode
    expect(calls[0]!.options.resume).toBeUndefined();
    expect(manager.get(id)!.status).toBe('idle');
    expect(manager.get(id)!.messagesSince(0).messages.at(-1)?.text).toBe('resumed done');
  });

  it('interrupt stops the current turn and the session stays usable', async () => {
    const { spawn } = fakeQuery([
      () => [], // never finishes on its own
      () => [assistant('after interrupt')],
    ]);
    const manager = new SessionManager(config, () => {}, spawn);
    const { id } = start(manager, 'long task');
    await wait();
    const s = manager.get(id)!;
    await s.interrupt();
    await wait();
    expect(s.status).toBe('idle');
    expect(s.messagesSince(0).messages.at(-1)?.text).toBe('interrupted by user');
  });

  it('interrupt on a non-running session fails', async () => {
    const { spawn } = fakeQuery([() => [resultMsg('done')]]);
    const manager = new SessionManager(config, () => {}, spawn);
    const { id } = start(manager, 'quick');
    await wait();
    await expect(manager.get(id)!.interrupt()).rejects.toThrow(/not running/);
  });

  it('error results set the error status', async () => {
    const { spawn } = fakeQuery([() => [resultMsg('boom', { isError: true })]]);
    const manager = new SessionManager(config, () => {}, spawn);
    const { id } = start(manager, 'bad');
    await wait();
    const s = manager.get(id)!;
    expect(s.status).toBe('error');
    expect(s.error).toBe('boom');
  });

  it('canUseTool hook waits for resolveApproval', async () => {
    const { spawn, calls } = fakeQuery([() => []]);
    const manager = new SessionManager(config, () => {}, spawn);
    const { id } = start(manager, 'needs permission');
    await wait();
    const hook = calls[0]!.options.canUseTool!;
    const pending = hook('Bash', { command: 'rm -rf /' }, { signal: new AbortController().signal, suggestions: [] } as never);
    await wait();
    const approvals = [...manager.get(id)!.pendingApprovals.values()];
    expect(approvals).toHaveLength(1);
    expect(approvals[0]!.toolName).toBe('Bash');
    expect(manager.get(id)!.resolveApproval(approvals[0]!.id, { behavior: 'allow' })).toBe(true);
    await expect(pending).resolves.toEqual({ behavior: 'allow' });
  });

  it('resolveApproval returns false for unknown approval ids', async () => {
    const { spawn } = fakeQuery([() => [resultMsg('done')]]);
    const manager = new SessionManager(config, () => {}, spawn);
    const { id } = start(manager, 'x');
    await wait();
    expect(manager.get(id)!.resolveApproval('nope', { behavior: 'allow' })).toBe(false);
  });

  it('list_sessions shows all sessions and pruneFinished removes finished ones', async () => {
    const { spawn } = fakeQuery([(text) => (text === 'b' ? [] : [resultMsg('done')])]);
    const manager = new SessionManager(config, () => {}, spawn);
    const first = start(manager, 'a');
    const second = start(manager, 'b');
    await wait();
    expect(manager.list().map((s) => s.id)).toEqual([first.id, second.id]);
    expect(manager.pruneFinished()).toBe(1);
    expect(manager.list().map((s) => s.id)).toEqual([second.id]);
  });

  it('passes config into query options', async () => {
    const { spawn, calls } = fakeQuery([() => [resultMsg('ok')]]);
    const manager = new SessionManager(config, () => {}, spawn);
    start(manager, 'check');
    await wait();
    expect(calls[0]!.options.cwd).toBe('/tmp');
    expect(calls[0]!.options.maxTurns).toBe(5);
    expect(calls[0]!.options.maxBudgetUsd).toBe(1);
  });
});
