import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { LogLevel } from './types.js';
import { OAuthClient } from './oauth.js';

export interface StdioGatewayOptions {
  mode: 'stdio';
  port: number;
  command: string;
  logLevel?: LogLevel;
}

export interface ProxyGatewayOptions {
  mode: 'proxy';
  port: number;
  url: string;
  transport?: 'http' | 'sse';
  headers?: Record<string, string>;
  logLevel?: LogLevel;
}

export type GatewayOptions = StdioGatewayOptions | ProxyGatewayOptions;

export interface Gateway {
  start(): Promise<void>;
  stop(): Promise<void>;
}

// --- JSON-RPC types ---

interface JsonRpcMessage {
  jsonrpc: string;
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

interface PendingRequest {
  resolve: (msg: JsonRpcMessage) => void;
  timer: ReturnType<typeof setTimeout>;
}

// --- Backend abstraction ---

interface Backend {
  sendRequest(msg: JsonRpcMessage & { id: number | string }): Promise<JsonRpcMessage>;
  sendNotification(msg: JsonRpcMessage): void;
  onServerMessage: ((msg: JsonRpcMessage) => void) | null;
  onClose: (() => void) | null;
  close(): void;
}

// --- Session ---

interface Session {
  id: string;
  backend: Backend;
  sseResponses: Set<ServerResponse>;
  notificationBuffer: JsonRpcMessage[];
}

// --- Helpers ---

const REQUEST_TIMEOUT_MS = 120_000;
const MAX_NOTIFICATION_BUFFER = 1000;

function isJsonRpcMessage(value: unknown): value is JsonRpcMessage {
  return typeof value === 'object' && value !== null && 'jsonrpc' in value;
}

function hasRequestId(msg: JsonRpcMessage): msg is JsonRpcMessage & { id: number | string } {
  return msg.id !== undefined && msg.id !== null;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => { chunks.push(chunk); });
    req.on('end', () => { resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', reject);
  });
}

function sendSSE(res: ServerResponse, msg: JsonRpcMessage): void {
  res.write(`event: message\nid: ${randomUUID()}\ndata: ${JSON.stringify(msg)}\n\n`);
}

function makeErrorResponse(id: number | string | null, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id });
}

// --- Stdio Backend ---

function createStdioBackend(
  command: string,
  logger: (level: LogLevel, msg: string) => void,
): Backend {
  const child: ChildProcess = spawn(command, { stdio: ['pipe', 'pipe', 'pipe'], shell: true });
  // stdio: ['pipe','pipe','pipe'] guarantees non-null streams
  if (!child.stdout || !child.stderr || !child.stdin) {
    throw new Error('Failed to create stdio pipes');
  }
  const childStdout = child.stdout;
  const childStderr = child.stderr;
  const childStdin = child.stdin;
  const pendingRequests = new Map<number | string, PendingRequest>();
  let stdoutBuffer = '';

  const backend: Backend = {
    onServerMessage: null,
    onClose: null,

    sendRequest(msg) {
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pendingRequests.delete(msg.id);
          resolve({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'Request timeout' } });
        }, REQUEST_TIMEOUT_MS);
        pendingRequests.set(msg.id, { resolve, timer });
        childStdin.write(JSON.stringify(msg) + '\n');
      });
    },

    sendNotification(msg) {
      childStdin.write(JSON.stringify(msg) + '\n');
    },

    close() {
      for (const [, pending] of pendingRequests) { clearTimeout(pending.timer); }
      pendingRequests.clear();
      child.kill('SIGTERM');
    },
  };

  childStdout.on('data', (chunk: Buffer) => {
    stdoutBuffer += chunk.toString('utf8');
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (!isJsonRpcMessage(parsed)) continue;
        // Route response to pending request, or forward as server-initiated message
        if (hasRequestId(parsed) && pendingRequests.has(parsed.id)) {
          const pending = pendingRequests.get(parsed.id);
          if (pending) {
            pendingRequests.delete(parsed.id);
            clearTimeout(pending.timer);
            pending.resolve(parsed);
          }
        } else {
          backend.onServerMessage?.(parsed);
        }
      } catch {
        logger('debug', `Non-JSON stdout: ${line.slice(0, 200)}`);
      }
    }
  });

  childStderr.on('data', (chunk: Buffer) => {
    logger('debug', `stderr: ${chunk.toString('utf8').trimEnd()}`);
  });

  child.on('exit', (code, signal) => {
    logger('info', `subprocess exited (code=${String(code)}, signal=${String(signal)})`);
    for (const [, pending] of pendingRequests) {
      clearTimeout(pending.timer);
      pending.resolve({ jsonrpc: '2.0', error: { code: -32000, message: 'Server process exited' } });
    }
    pendingRequests.clear();
    backend.onClose?.();
  });

  child.on('error', (err) => {
    logger('info', `subprocess error: ${err.message}`);
  });

  return backend;
}

// --- Proxy Backend ---

function createProxyBackend(
  remoteUrl: string,
  headers: Record<string, string>,
  oauthClient: OAuthClient,
  logger: (level: LogLevel, msg: string) => void,
): Backend {
  let remoteSessionId: string | undefined;
  let accessToken: string | undefined;

  async function forwardToRemote(msg: JsonRpcMessage, retryCount = 0): Promise<JsonRpcMessage | undefined> {
    const reqHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      ...headers,
    };
    if (accessToken) {
      reqHeaders['Authorization'] = `Bearer ${accessToken}`;
    }
    if (remoteSessionId) {
      reqHeaders['Mcp-Session-Id'] = remoteSessionId;
    }

    const res = await fetch(remoteUrl, {
      method: 'POST',
      headers: reqHeaders,
      body: JSON.stringify(msg),
    });

    if (res.status === 401 && retryCount < 2) {
      const wwwAuth = res.headers.get('www-authenticate') ?? undefined;
      logger('info', 'Received 401, starting OAuth flow...');
      accessToken = await oauthClient.handleUnauthorized(wwwAuth);
      logger('info', 'OAuth completed, retrying request...');
      return await forwardToRemote(msg, retryCount + 1);
    }

    const sessionHeader = res.headers.get('mcp-session-id');
    if (sessionHeader) {
      remoteSessionId = sessionHeader;
    }

    if (res.status === 202) return undefined;

    if (!res.ok) {
      const text = await res.text();
      logger('info', `Remote error: ${String(res.status)} ${text.slice(0, 200)}`);
      return {
        jsonrpc: '2.0',
        id: hasRequestId(msg) ? msg.id : null,
        error: { code: -32000, message: `Remote server error: ${String(res.status)}` },
      };
    }

    return await res.json() as JsonRpcMessage;
  }

  const backend: Backend = {
    onServerMessage: null,
    onClose: null,

    async sendRequest(msg) {
      const response = await forwardToRemote(msg);
      return response ?? { jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'No response from remote' } };
    },

    sendNotification(msg) {
      void forwardToRemote(msg);
    },

    close() {
      // Send DELETE to close remote session
      if (remoteSessionId) {
        const reqHeaders: Record<string, string> = { ...headers, 'Mcp-Session-Id': remoteSessionId };
        if (accessToken) reqHeaders['Authorization'] = `Bearer ${accessToken}`;
        void fetch(remoteUrl, { method: 'DELETE', headers: reqHeaders }).catch(() => { /* ignore */ });
      }
    },
  };

  return backend;
}

// --- Gateway ---

export function createGateway(options: GatewayOptions): Gateway {
  const logLevel = options.logLevel ?? 'info';
  const { port } = options;
  const sessions = new Map<string, Session>();

  function logger(level: LogLevel, msg: string): void {
    if (logLevel === 'none') return;
    if (logLevel === 'info' && level === 'debug') return;
    process.stderr.write(`[${new Date().toISOString()}] [${level}] ${msg}\n`);
  }

  // For proxy mode, share a single OAuthClient across all sessions
  const sharedOAuthClient = options.mode === 'proxy'
    ? new OAuthClient({ serverUrl: options.url, headers: options.headers ?? {} })
    : undefined;

  function createBackend(): Backend {
    if (options.mode === 'stdio') {
      return createStdioBackend(options.command, logger);
    }
    if (!sharedOAuthClient) {
      throw new Error('OAuthClient not initialized for proxy mode');
    }
    return createProxyBackend(
      options.url,
      options.headers ?? {},
      sharedOAuthClient,
      logger,
    );
  }

  function createSession(): Session {
    const id = randomUUID();
    const backend = createBackend();

    const session: Session = {
      id,
      backend,
      sseResponses: new Set(),
      notificationBuffer: [],
    };

    backend.onServerMessage = (msg): void => {
      if (session.sseResponses.size > 0) {
        for (const sseRes of session.sseResponses) { sendSSE(sseRes, msg); }
      } else if (session.notificationBuffer.length < MAX_NOTIFICATION_BUFFER) {
        session.notificationBuffer.push(msg);
      }
    };

    backend.onClose = (): void => {
      for (const sseRes of session.sseResponses) { sseRes.end(); }
      session.sseResponses.clear();
      sessions.delete(id);
    };

    sessions.set(id, session);
    logger('info', `Session ${id.slice(0, 8)} created`);
    return session;
  }

  function destroySession(session: Session): void {
    session.backend.close();
    for (const sseRes of session.sseResponses) { sseRes.end(); }
    session.sseResponses.clear();
    sessions.delete(session.id);
    logger('info', `Session ${session.id.slice(0, 8)} destroyed`);
  }

  // --- HTTP handlers ---

  async function handlePost(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req);
    let message: unknown;
    try {
      message = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(makeErrorResponse(null, -32700, 'Parse error'));
      return;
    }

    if (!isJsonRpcMessage(message)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(makeErrorResponse(null, -32600, 'Invalid Request'));
      return;
    }

    if (message.method === 'initialize') {
      const session = createSession();
      if (hasRequestId(message)) {
        const response = await session.backend.sendRequest(message);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': session.id });
        res.end(JSON.stringify(response));
      } else {
        session.backend.sendNotification(message);
        res.writeHead(202, { 'Mcp-Session-Id': session.id });
        res.end();
      }
      return;
    }

    const sessionId = req.headers['mcp-session-id'];
    if (typeof sessionId !== 'string') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(makeErrorResponse(message.id ?? null, -32000, 'Missing Mcp-Session-Id header'));
      return;
    }

    const session = sessions.get(sessionId);
    if (!session) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(makeErrorResponse(message.id ?? null, -32000, 'Session not found or expired'));
      return;
    }

    if (hasRequestId(message) && message.method !== undefined) {
      const response = await session.backend.sendRequest(message);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': sessionId });
      res.end(JSON.stringify(response));
      return;
    }

    session.backend.sendNotification(message);
    res.writeHead(202);
    res.end();
  }

  function handleGet(req: IncomingMessage, res: ServerResponse): void {
    const sessionId = req.headers['mcp-session-id'];
    if (typeof sessionId !== 'string') {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Missing Mcp-Session-Id header');
      return;
    }

    const session = sessions.get(sessionId);
    if (!session) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Session not found');
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    session.sseResponses.add(res);
    for (const msg of session.notificationBuffer) { sendSSE(res, msg); }
    session.notificationBuffer = [];
    req.on('close', () => { session.sseResponses.delete(res); });
  }

  function handleDelete(req: IncomingMessage, res: ServerResponse): void {
    const sessionId = req.headers['mcp-session-id'];
    if (typeof sessionId !== 'string') {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Missing Mcp-Session-Id header');
      return;
    }

    const session = sessions.get(sessionId);
    if (!session) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Session not found');
      return;
    }

    destroySession(session);
    res.writeHead(200);
    res.end();
  }

  // --- HTTP server ---

  const httpServer = createHttpServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID');
    res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const urlPath = new URL(req.url ?? '/', `http://localhost:${String(port)}`).pathname;

    if (urlPath === '/health' || urlPath === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }

    if (urlPath !== '/mcp') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return;
    }

    const dispatch = async (): Promise<void> => {
      switch (req.method) {
        case 'POST': await handlePost(req, res); break;
        case 'GET': handleGet(req, res); break;
        case 'DELETE': handleDelete(req, res); break;
        default:
          res.writeHead(405, { 'Content-Type': 'text/plain' });
          res.end('Method Not Allowed');
      }
    };

    dispatch().catch((err: unknown) => {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger('info', `Error: ${req.method ?? '?'} ${urlPath}: ${errMsg}`);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(makeErrorResponse(null, -32603, 'Internal error'));
      }
    });
  });

  return {
    start(): Promise<void> {
      return new Promise((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(port, '127.0.0.1', () => {
          httpServer.removeListener('error', reject);
          logger('info', `Gateway listening on http://127.0.0.1:${String(port)}/mcp`);
          resolve();
        });
      });
    },
    stop(): Promise<void> {
      return new Promise((resolve) => {
        for (const session of sessions.values()) { destroySession(session); }
        httpServer.close(() => { resolve(); });
      });
    },
  };
}
