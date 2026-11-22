import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { loadConfig, type BridgeConfig } from './config.js';
import { SessionManager } from './sessions.js';
import { createMcpServer } from './tools.js';

export function createApp(config: BridgeConfig, manager: SessionManager) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, sessions: manager.list().length });
  });

  app.use('/mcp', (req, res, next) => {
    const auth = req.headers.authorization ?? '';
    if (auth !== `Bearer ${config.token}`) {
      res.status(401).json({
        error: { code: 'unauthorized', message: 'Missing or wrong Authorization: Bearer <BRIDGE_TOKEN>' },
      });
      return;
    }
    next();
  });

  // Stateless MCP endpoint: each request gets its own transport + server.
  app.post('/mcp', async (req, res) => {
    try {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      const server = createMcpServer(manager);
      await server.connect(transport);
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({
          error: { code: 'internal', message: err instanceof Error ? err.message : String(err) },
        });
      }
    }
  });

  app.all('/mcp', (_req, res) => {
    res.status(405).json({ error: { code: 'method_not_allowed', message: 'Use POST for /mcp' } });
  });

  return app;
}

export function main(): void {
  let config: BridgeConfig;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(`[bridge] refusing to start: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const manager = new SessionManager(config, (msg) => console.log(`[bridge] ${msg}`));
  const app = createApp(config, manager);
  const server = app.listen(config.port, () => {
    console.log(`[bridge] listening on http://127.0.0.1:${config.port}/mcp (workdir: ${config.workdir})`);
  });

  const shutdown = () => {
    console.log('[bridge] shutting down');
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (process.argv[1] && process.argv[1].endsWith('server.ts')) {
  main();
}
