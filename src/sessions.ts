import { query, type Query, type Options, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { BridgeConfig } from './config.js';

export type SessionStatus = 'running' | 'idle' | 'error' | 'closed';

export interface StoredMessage {
  seq: number;
  role: 'assistant' | 'result' | 'system';
  text: string;
  subtype?: string;
}

export interface PendingApproval {
  id: string;
  toolName: string;
  input: Record<string, unknown>;
  resolve: (decision: { behavior: 'allow' } | { behavior: 'deny'; message: string }) => void;
  createdAt: number;
}

export interface SessionSnapshot {
  id: string;
  status: SessionStatus;
  claudeSessionId?: string;
  costUsd: number;
  numTurns: number;
  totalMessages: number;
  error?: string;
  startedAt: string;
  lastActivityAt: string;
}

type InputItem = { type: 'user'; message: { role: 'user'; content: string }; parent_tool_use_id: null };

/** Pull-based async iterable of user messages: the streaming-input queue. */
function makeInputStream(): { stream: AsyncIterable<InputItem>; push: (text: string) => void } {
  const items: InputItem[] = [];
  const waiters: Array<(item: InputItem | undefined) => void> = [];  const push = (text: string) => {
    const item: InputItem = { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null };
    const waiter = waiters.shift();
    if (waiter) waiter(item);
    else items.push(item);
  };
  const stream: AsyncIterable<InputItem> = {
    [Symbol.asyncIterator]() {
      return {
        next: () =>
          new Promise<IteratorResult<InputItem>>((resolve) => {
            const item = items.shift();
            if (item) resolve({ value: item, done: false });
            else waiters.push((item) => resolve(item ? { value: item, done: false } : { value: undefined, done: true }));
          }),
      };
    },
  };
  return { stream, push };
}

function extractText(message: Extract<SDKMessage, { type: 'assistant' | 'user' }>): string {
  const content = message.message.content;
  if (typeof content === 'string') return content;
  return content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

export type SpawnQuery = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => Query;

export class Session {
  readonly id: string;
  status: SessionStatus = 'running';
  claudeSessionId?: string;
  error?: string;
  costUsd = 0;
  numTurns = 0;
  readonly startedAt = new Date().toISOString();
  lastActivityAt = this.startedAt;

  readonly messages: StoredMessage[] = [];
  readonly pendingApprovals = new Map<string, PendingApproval>();

  private readonly config: BridgeConfig;
  private readonly log: (msg: string) => void;
  private seqCounter = 0;
  private pushInput!: (text: string) => void;
  private current: Query | undefined;
  private streamOpen = false;
  private aborted = false;

  constructor(
    readonly prompt: string,
    config: BridgeConfig,
    log: (msg: string) => void,
    private readonly spawnQuery: SpawnQuery = query as SpawnQuery,
  ) {
    this.id = crypto.randomUUID();
    this.config = config;
    this.log = log;
  }

  snapshot(): SessionSnapshot {
    return {
      id: this.id,
      status: this.status,
      claudeSessionId: this.claudeSessionId,
      costUsd: this.costUsd,
      numTurns: this.numTurns,
      totalMessages: this.messages.length,
      error: this.error,
      startedAt: this.startedAt,
      lastActivityAt: this.lastActivityAt,
    };
  }

  messagesSince(cursor: number): { messages: StoredMessage[]; nextCursor: number } {
    const messages = this.messages.filter((m) => m.seq >= cursor);
    return { messages, nextCursor: this.seqCounter };
  }

  /** Sends a follow-up: into the open stream if the query is still alive, otherwise as a resumed query. */
  send(text: string): void {
    if (this.status === 'closed') throw new Error(`Session ${this.id} is closed`);
    if (this.current && this.streamOpen) {
      this.status = 'running';
      this.pushInput(text);
    } else {
      this.status = 'running';
      this.error = undefined;
      this.run(text, this.claudeSessionId);
    }
  }

  async interrupt(): Promise<void> {
    if (this.status !== 'running' || !this.current) {
      throw new Error(`Session ${this.id} is not running (status: ${this.status})`);
    }
    await this.current.interrupt();
    this.log(`interrupted session ${this.id}`);
  }

  resolveApproval(
    approvalId: string,
    decision: { behavior: 'allow' } | { behavior: 'deny'; message: string },
  ): boolean {
    const pending = this.pendingApprovals.get(approvalId);
    if (!pending) return false;
    this.pendingApprovals.delete(approvalId);
    pending.resolve(decision);
    return true;
  }

  start(): void {
    this.run(this.prompt, undefined);
  }

  private record(role: StoredMessage['role'], text: string, subtype?: string): void {
    this.messages.push({ seq: this.seqCounter++, role, text, subtype });
    this.lastActivityAt = new Date().toISOString();
  }

  private run(firstPrompt: string, resumeId: string | undefined): void {
    const input = makeInputStream();
    this.pushInput = input.push;
    this.streamOpen = true;
    input.push(firstPrompt);

    const options: Options = {
      cwd: this.config.workdir,
      maxTurns: this.config.maxTurns,
      maxBudgetUsd: this.config.maxBudgetUsd,
      permissionMode: 'default',
      // Without ANTHROPIC_API_KEY, the CLI uses the machine's logged-in Claude Code
      // subscription; only inject the key when one was configured.
      env: {
        ...process.env,
        ...(this.config.anthropicApiKey ? { ANTHROPIC_API_KEY: this.config.anthropicApiKey } : {}),
      } as Record<string, string>,
      resume: resumeId,
      canUseTool: async (toolName, toolInput) => {
        return new Promise((resolve) => {
          const approvalId = crypto.randomUUID();
          const pending: PendingApproval = {
            id: approvalId,
            toolName,
            input: toolInput,
            createdAt: Date.now(),
            resolve: (decision) => {
              this.log(`approval ${approvalId} for ${toolName}: ${decision.behavior}`);
              resolve(decision);
            },
          };
          this.pendingApprovals.set(approvalId, pending);
          this.log(`pending approval ${approvalId} for ${toolName}`);
        });
      },
    };
    if (this.config.model) options.model = this.config.model;

    const q = this.spawnQuery({ prompt: input.stream, options });
    this.current = q;
    void this.consume(q);
  }

  private async consume(q: Query): Promise<void> {
    try {
      for await (const message of q) {
        if (message.type === 'system' && message.subtype === 'init') {
          this.claudeSessionId = message.session_id;
          this.record('system', `session started (claude session ${message.session_id})`, 'init');
        } else if (message.type === 'assistant') {
          const text = extractText(message);
          if (text) this.record('assistant', text);
        } else if (message.type === 'result') {
          this.costUsd = message.total_cost_usd;
          this.numTurns = message.num_turns;
          const resultText =
            'result' in message ? message.result : ('errors' in message ? message.errors.join('; ') : '');
          this.record('result', resultText, message.subtype);
          if (message.subtype === 'error_max_budget_usd') {
            this.status = 'error';
            this.error = 'Session stopped: max budget exceeded';
          } else if (message.is_error) {
            this.status = 'error';
            this.error = resultText || 'session ended with an error';
          } else {
            this.status = 'idle';
          }
        }
      }
      this.streamOpen = false;
      if (this.status === 'running') this.status = this.aborted ? 'closed' : 'idle';
    } catch (err) {
      this.status = 'error';
      this.error = err instanceof Error ? err.message : String(err);
      this.record('result', `bridge error: ${this.error}`, 'bridge_error');
    }
  }

  abort(): void {
    this.aborted = true;
    this.streamOpen = false;
    this.status = 'closed';
  }
}

export class SessionManager {
  private readonly sessions = new Map<string, Session>();

  constructor(
    private readonly config: BridgeConfig,
    private readonly log: (msg: string) => void = () => {},
    private readonly spawnQuery: SpawnQuery = query as SpawnQuery,
  ) {}

  startTask(prompt: string): SessionSnapshot {
    const session = new Session(prompt, this.config, this.log, this.spawnQuery);
    this.sessions.set(session.id, session);
    session.start();
    return session.snapshot();
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  list(): SessionSnapshot[] {
    return [...this.sessions.values()].map((s) => s.snapshot());
  }

  /**
   * Discards finished sessions from the in-memory list. Running sessions are kept.
   * Returns the number removed.
   */
  pruneFinished(): number {
    let removed = 0;
    for (const [id, session] of this.sessions) {
      if (session.status !== 'running') {
        this.sessions.delete(id);
        removed++;
      }
    }
    return removed;
  }
}
