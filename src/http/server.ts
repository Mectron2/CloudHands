import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { realpathSync } from 'node:fs';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import type { ErrorRequestHandler } from 'express';
import { defaultStateDirectory, type ServerConfig } from '../config.js';
import { LocalOAuthProvider } from '../auth/provider.js';
import { createOAuthRouter } from '../auth/router.js';
import { toolScope } from '../auth/scopes.js';
import { OAuthStore } from '../auth/store.js';
import { createMcpServer } from '../mcp/server.js';
import { createToolCatalog } from '../tools/catalog.js';

interface Session {
  server: Server;
  transport: StreamableHTTPServerTransport;
  grantId: string;
}

export function createHttpServer(config: ServerConfig) {
  const publicUrl = config.publicUrl ? new URL(config.publicUrl) : undefined;
  const allowedHosts = publicUrl
    ? [...new Set(['localhost', '127.0.0.1', '[::1]', publicUrl.hostname, ...(config.allowedHosts ?? [])])]
    : config.allowedHosts;
  const app = createMcpExpressApp({ host: config.host, allowedHosts });
  const server = createServer(app);
  const tools = createToolCatalog(config.cwd);
  const sessions = new Map<string, Session>();
  const activeSessions = new Set<Session>();
  let closing = false;
  let provider: LocalOAuthProvider | undefined;
  let oauthRouter: ReturnType<typeof createOAuthRouter> | undefined;
  let startupError: unknown;

  const getAuth = () => {
    if (startupError) {
      throw startupError;
    }
    if (!provider) {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : config.port;
      if (!publicUrl && !port) {
        throw new Error('Start the HTTP listener before initializing OAuth on a dynamic port');
      }
      const host = ['0.0.0.0', '::'].includes(config.host) ? '127.0.0.1' : config.host;
      const issuer = publicUrl ?? new URL(`http://${host.includes(':') ? `[${host}]` : host}:${port}`);
      const binding = JSON.stringify({ issuer: issuer.origin, cwd: realpathSync(config.cwd) });
      const initialized = new LocalOAuthProvider(issuer, new OAuthStore(config.stateDirectory ?? defaultStateDirectory(), binding, config.cwd));
      try {
        oauthRouter = createOAuthRouter(initialized);
      } catch (error) {
        initialized.close();
        throw error;
      }
      provider = initialized;
      provider.onRevoked((id) => {
        for (const session of activeSessions) {
          if (session.grantId === id) {
            void session.server.close().catch(() => {});
          }
        }
      });
    }
    return provider;
  };

  server.once('listening', () => {
    try {
      getAuth();
    } catch (error) {
      startupError = error;
    }
  });

  app.get('/health', (_request, response) => {
    response.status(startupError || closing ? 503 : 200).json({ status: startupError || closing ? 'unavailable' : 'ok' });
  });

  app.use((request, response, next) => {
    if (closing) {
      response.status(503).json({ error: 'Server is shutting down' });
      return;
    }
    getAuth();
    return oauthRouter!(request, response, next);
  });

  app.use((request, response, next) => {
    if (request.headers.origin) {
      const origin = URL.parse(request.headers.origin);
      const sameOrigin = origin?.host === request.headers.host && origin?.protocol === 'http:';
      if (!origin || (!sameOrigin && origin.origin !== publicUrl?.origin && !config.allowedOrigins?.includes(request.headers.origin))) {
        response.status(403).json({ error: 'Origin is not allowed' });
        return;
      }
      response.setHeader('Access-Control-Allow-Origin', request.headers.origin);
      response.vary('Origin');
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Authorization, MCP-Session-Id, MCP-Protocol-Version, Last-Event-ID');
      response.setHeader('Access-Control-Expose-Headers', 'MCP-Session-Id, MCP-Protocol-Version, WWW-Authenticate');
    }
    next();
  });

  app.options('/mcp', (_request, response) => {
    response.status(204).end();
  });

  app.use('/mcp', (request, response, next) => {
    const auth = getAuth();
    const name = request.body?.method === 'tools/call' ? request.body?.params?.name : undefined;
    return requireBearerAuth({
      verifier: auth,
      expectedResource: auth.resource,
      resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(auth.resource),
      requiredScopes: typeof name === 'string' ? [toolScope(name)] : [],
    })(request, response, next);
  });

  app.all('/mcp', async (request, response) => {
    if (closing) {
      response.status(503).json({ error: 'Server is shutting down' });
      return;
    }

    if (!['POST', 'GET', 'DELETE'].includes(request.method)) {
      response.setHeader('Allow', 'POST, GET, DELETE');
      response.status(405).end();
      return;
    }

    const sessionId = request.headers['mcp-session-id'];
    const grantId = request.auth?.extra?.grantId;
    if (typeof grantId !== 'string') {
      response.status(401).end();
      return;
    }
    let session: Session | undefined;

    if (typeof sessionId === 'string') {
      session = sessions.get(sessionId);
      if (!session || session.grantId !== grantId) {
        response.status(404).json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Session not found' } });
        return;
      }
    } else if (request.method === 'POST' && isInitializeRequest(request.body)) {
      const server = createMcpServer(tools);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        onsessioninitialized: (id) => {
          sessions.set(id, { server, transport, grantId });
        },
        enableJsonResponse: true,
      });
      session = { server, transport, grantId };
      activeSessions.add(session);
      const activeSession = session;
      transport.onclose = () => {
        if (transport.sessionId) {
          sessions.delete(transport.sessionId);
        }
        activeSessions.delete(activeSession);
      };
      await server.connect(transport);
    } else {
      response.status(400).json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Initialize a session first' } });
      return;
    }

    try {
      await session.transport.handleRequest(request, response, request.body);
    } finally {
      if (!session.transport.sessionId) {
        await session.server.close();
      }
    }
  });

  const handleError: ErrorRequestHandler = (error, _request, response, next) => {
    if (response.headersSent) {
      next(error);
      return;
    }

    const status = error.type === 'entity.parse.failed' ? 400 : error.type === 'entity.too.large' ? 413 : 500;
    response.status(status).json({ error: status === 500 ? 'Internal server error' : 'Invalid request body' });
  };
  app.use(handleError);

  return {
    server,
    get auth() {
      return getAuth();
    },
    async close() {
      closing = true;
      await Promise.all([...activeSessions].map((session) => session.server.close()));
      provider?.close();
      if (server.listening) {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve());
          server.closeAllConnections();
        });
      }
    },
  };
}
