import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { SessionManager } from './sessions.js';

function json(data: unknown, isError = false) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }], isError };
}

function fail(error: { code: string; message: string }) {
  return json({ error }, true);
}

/** Registers the bridge tools on a fresh McpServer (one per request, stateless). */
export function createMcpServer(manager: SessionManager): McpServer {
  const server = new McpServer({ name: 'claude-code-bridge', version: '0.1.0' });

  server.registerTool(
    'start_task',
    {
      title: 'Start a Claude Code task',
      description:
        'Starts a new Claude Code session on the machine where the bridge runs and returns immediately with its session id. Follow progress with get_output.',
      inputSchema: {
        prompt: z.string().min(1).describe('What Claude Code should do, in plain language.'),
      },
    },
    async ({ prompt }) => json(manager.startTask(prompt)),
  );

  server.registerTool(
    'get_output',
    {
      title: 'Get Claude Code session output',
      description:
        'Returns new messages from a session since a cursor (pass 0 for everything), plus status, spend and pending approvals.',
      inputSchema: {
        session_id: z.string().min(1).describe('The session id returned by start_task.'),
        cursor: z.number().int().min(0).default(0).describe('Only return messages with seq >= cursor.'),
      },
    },
    async ({ session_id, cursor }) => {
      const session = manager.get(session_id);
      if (!session) return fail({ code: 'session_not_found', message: `No session ${session_id}` });
      const { messages, nextCursor } = session.messagesSince(cursor);
      return json({
        status: session.status,
        claude_session_id: session.claudeSessionId,
        cost_usd: session.costUsd,
        num_turns: session.numTurns,
        error: session.error,
        next_cursor: nextCursor,
        messages,
        pending_approvals: [...session.pendingApprovals.values()].map((a) => ({
          id: a.id,
          tool_name: a.toolName,
          input: a.input,
        })),
      });
    },
  );

  server.registerTool(
    'send_message',
    {
      title: 'Send a follow-up to a Claude Code session',
      description:
        'Sends a follow-up prompt to a session. If it is running, the message is queued and runs after the current turn; if it is idle or finished, the session is resumed with this message.',
      inputSchema: {
        session_id: z.string().min(1).describe('The session id returned by start_task.'),
        message: z.string().min(1).describe('The follow-up text.'),
      },
    },
    async ({ session_id, message }) => {
      const session = manager.get(session_id);
      if (!session) return fail({ code: 'session_not_found', message: `No session ${session_id}` });
      try {
        session.send(message);
        return json(session.snapshot());
      } catch (err) {
        return fail({
          code: 'send_failed',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  server.registerTool(
    'interrupt',
    {
      title: 'Interrupt a Claude Code session',
      description: 'Stops the current turn of a running session. The session stays open for follow-ups.',
      inputSchema: {
        session_id: z.string().min(1).describe('The session id returned by start_task.'),
      },
    },
    async ({ session_id }) => {
      const session = manager.get(session_id);
      if (!session) return fail({ code: 'session_not_found', message: `No session ${session_id}` });
      try {
        await session.interrupt();
        return json(session.snapshot());
      } catch (err) {
        return fail({
          code: 'interrupt_failed',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  server.registerTool(
    'list_sessions',
    {
      title: 'List bridge sessions',
      description: 'Lists every session the bridge knows about, with status and spend.',
      inputSchema: {},
    },
    async () => json({ sessions: manager.list() }),
  );

  server.registerTool(
    'list_pending_approvals',
    {
      title: 'List pending permission approvals',
      description: 'Lists tool calls Claude Code is waiting on for a session (when permission mode is default).',
      inputSchema: {
        session_id: z.string().min(1).describe('The session id returned by start_task.'),
      },
    },
    async ({ session_id }) => {
      const session = manager.get(session_id);
      if (!session) return fail({ code: 'session_not_found', message: `No session ${session_id}` });
      return json({
        pending_approvals: [...session.pendingApprovals.values()].map((a) => ({
          id: a.id,
          tool_name: a.toolName,
          input: a.input,
        })),
      });
    },
  );

  server.registerTool(
    'resolve_approval',
    {
      title: 'Resolve a pending permission approval',
      description: 'Allows or denies a tool call Claude Code asked about. The id comes from list_pending_approvals.',
      inputSchema: {
        session_id: z.string().min(1).describe('The session id returned by start_task.'),
        approval_id: z.string().min(1).describe('The approval id from list_pending_approvals.'),
        decision: z.enum(['allow', 'deny']).describe('Allow or deny the tool call.'),
        reason: z.string().optional().describe('Why it was denied, shown to Claude Code.'),
      },
    },
    async ({ session_id, approval_id, decision, reason }) => {
      const session = manager.get(session_id);
      if (!session) return fail({ code: 'session_not_found', message: `No session ${session_id}` });
      const ok = session.resolveApproval(
        approval_id,
        decision === 'allow' ? { behavior: 'allow' } : { behavior: 'deny', message: reason || 'Denied by operator' },
      );
      if (!ok) return fail({ code: 'approval_not_found', message: `No pending approval ${approval_id}` });
      return json({ resolved: approval_id, decision });
    },
  );

  return server;
}
