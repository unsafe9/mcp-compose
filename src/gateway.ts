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
  notificationBuffer: JsonRpcMessage[];
  lastActivity: number;
}

// --- Helpers ---

const REQUEST_TIMEOUT_MS = 120_000;
const MAX_NOTIFICATION_BUFFER = 1000;
const SESSION_IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const SESSION_REAP_INTERVAL_MS = 60 * 1000; // check every minute

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

let sseEventId = 0;

function sendSSE(res: ServerResponse, msg: JsonRpcMessage): void {
  res.write(`event: message\nid: ${String(++sseEventId)}\ndata: ${JSON.stringify(msg)}\n\n`);
}

function makeErrorResponse(id: number | string | null, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id });
}

// --- Stdio Backend ---

function createStdioBackend(
  command: string,
  logger: (level: LogLevel, msg: string) => void,
): Backend {
  const child: ChildProcess = spawn(command, { stdio: ['pipe', 'pipe', 'pipe'], shell: true, detached: true });
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
      // Kill the entire process group (shell + actual MCP server process)
      try {
        if (child.pid) process.kill(-child.pid, 'SIGTERM');
      } catch {
        try { child.kill('SIGTERM'); } catch { /* already dead */ }
      }
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

/**
 * Parse an SSE response from a remote MCP server.
 * Returns the JSON-RPC response matching the request, and forwards
 * any other messages (notifications) to the backend's onServerMessage.
 */
async function parseSseResponse(
  res: Response,
  originalMsg: JsonRpcMessage,
  backend: Backend,
): Promise<JsonRpcMessage | undefined> {
  const text = await res.text();
  const requestId = hasRequestId(originalMsg) ? originalMsg.id : null;
  let response: JsonRpcMessage | undefined;

  for (const block of text.split(/\n\n+/)) {
    let data: string | undefined;
    for (const line of block.split('\n')) {
      if (line.startsWith('data: ')) {
        data = line.slice(6);
      } else if (line.startsWith('data:')) {
        data = line.slice(5);
      }
    }
    if (!data?.trim()) continue;

    try {
      const parsed: unknown = JSON.parse(data);
      if (!isJsonRpcMessage(parsed)) continue;

      // Match response to our request by ID
      if (requestId !== null && hasRequestId(parsed) && parsed.id === requestId) {
        response = parsed;
      } else {
        // Notification or other server-initiated message
        backend.onServerMessage?.(parsed);
      }
    } catch {
      // skip non-JSON data lines
    }
  }

  return response;
}

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
    if (remoteSessionId && msg.method !== 'initialize') {
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

    const contentType = res.headers.get('content-type') ?? '';

    // SSE response: parse events and extract JSON-RPC messages
    if (contentType.includes('text/event-stream')) {
      return await parseSseResponse(res, msg, backend);
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

  const sharedOAuthClient = options.mode === 'proxy'
    ? new OAuthClient({ serverUrl: options.url, headers: options.headers ?? {} })
    : undefined;

  // Single shared backend per gateway — started eagerly, recreated if it dies.
  let nextRequestId = 1;
  let restartBackoff = 1000;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;

  function startBackend(): Backend {
    let b: Backend;
    if (options.mode === 'stdio') {
      b = createStdioBackend(options.command, logger);
    } else {
      if (!sharedOAuthClient) {
        throw new Error('OAuthClient not initialized for proxy mode');
      }
      b = createProxyBackend(
        options.url,
        options.headers ?? {},
        sharedOAuthClient,
        logger,
      );
    }

    b.onServerMessage = (msg): void => {
      for (const session of sessions.values()) {
        if (session.notificationBuffer.length < MAX_NOTIFICATION_BUFFER) {
          session.notificationBuffer.push(msg);
        }
      }
    };

    b.onClose = (): void => {
      logger('info', `Backend died, restarting in ${String(restartBackoff)}ms`);
      sessions.clear();
      restartTimer = setTimeout(() => {
        restartTimer = null;
        backend = startBackend();
        restartBackoff = Math.min(restartBackoff * 2, 30_000);
      }, restartBackoff);
    };

    return b;
  }

  let backend: Backend = startBackend();

  async function sendRequest(msg: JsonRpcMessage & { id: number | string }): Promise<JsonRpcMessage> {
    const originalId = msg.id;
    const internalId = nextRequestId++;
    const response = await backend.sendRequest({ ...msg, id: internalId });
    restartBackoff = 1000;
    return { ...response, id: originalId };
  }

  function sendNotification(msg: JsonRpcMessage): void {
    backend.sendNotification(msg);
  }

  function respondWithResult(
    req: IncomingMessage,
    res: ServerResponse,
    response: JsonRpcMessage,
    session: Session,
  ): void {
    const pending = session.notificationBuffer;
    session.notificationBuffer = [];
    const clientAcceptsSSE = (req.headers.accept ?? '').includes('text/event-stream');

    if (clientAcceptsSSE && pending.length > 0) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Mcp-Session-Id': session.id,
      });
      for (const notif of pending) { sendSSE(res, notif); }
      sendSSE(res, response);
      res.end();
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': session.id });
      res.end(JSON.stringify(response));
    }
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
      const session: Session = {
        id: randomUUID(),
        notificationBuffer: [],
        lastActivity: Date.now(),
      };
      sessions.set(session.id, session);
      logger('info', `Session ${session.id.slice(0, 8)} created (${String(sessions.size)} active)`);

      if (hasRequestId(message)) {
        const response = await sendRequest(message);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': session.id });
        res.end(JSON.stringify(response));
      } else {
        sendNotification(message);
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

    session.lastActivity = Date.now();

    if (hasRequestId(message) && message.method !== undefined) {
      const response = await sendRequest(message);
      respondWithResult(req, res, response, session);
      return;
    }

    sendNotification(message);
    res.writeHead(202);
    res.end();
  }

  function handleDelete(req: IncomingMessage, res: ServerResponse): void {
    const sessionId = req.headers['mcp-session-id'];
    if (typeof sessionId !== 'string') {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Missing Mcp-Session-Id header');
      return;
    }

    if (!sessions.delete(sessionId)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Session not found');
      return;
    }

    logger('info', `Session ${sessionId.slice(0, 8)} destroyed (${String(sessions.size)} active)`);
    res.writeHead(200);
    res.end();
  }

  // --- HTTP server ---

  const httpServer = createHttpServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version');
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

  // Periodically reap idle sessions (safety net for clients that disconnect without DELETE)
  const reapInterval = setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (now - session.lastActivity > SESSION_IDLE_TIMEOUT_MS) {
        logger('info', `Session ${id.slice(0, 8)} idle timeout`);
        sessions.delete(id);
      }
    }
  }, SESSION_REAP_INTERVAL_MS);

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
        clearInterval(reapInterval);
        if (restartTimer) clearTimeout(restartTimer);
        sessions.clear();
        backend.onClose = null;
        backend.close();
        httpServer.close(() => { resolve(); });
      });
    },
  };
}
