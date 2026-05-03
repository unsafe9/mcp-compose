import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { AuthMode, LogLevel } from './types.js';
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
  authMode?: AuthMode;
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

interface RequestContext {
  /** Raw Authorization header from the incoming client request, forwarded
   * upstream verbatim in passthrough auth mode. */
  authorization?: string;
}

class UnauthorizedError extends Error {
  constructor(public wwwAuthenticate: string | undefined) {
    super('Upstream returned 401 Unauthorized');
    this.name = 'UnauthorizedError';
  }
}

interface Backend {
  sendRequest(msg: JsonRpcMessage & { id: number | string }, ctx?: RequestContext): Promise<JsonRpcMessage>;
  sendNotification(msg: JsonRpcMessage, ctx?: RequestContext): void;
  onServerMessage: ((msg: JsonRpcMessage) => void) | null;
  onClose: (() => void) | null;
  close(): void;
}

// --- Session ---

interface Session {
  id: string;
  notificationBuffer: JsonRpcMessage[];
  /** Open SSE response handling an in-flight request. Notifications during the
   * request flow here instead of the buffer so the client sees them in real time. */
  liveSSE: ServerResponse | null;
}

// --- Helpers ---

const REQUEST_TIMEOUT_MS = 120_000;
const MAX_NOTIFICATION_BUFFER = 1000;
const MAX_STDOUT_LINE_LENGTH = 10 * 1024 * 1024; // 10 MB
const MAX_SSE_BUFFER = 10 * 1024 * 1024; // 10 MB

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

function sendSSE(res: ServerResponse, msg: JsonRpcMessage): boolean {
  if (res.writableEnded || res.destroyed) return false;
  return res.write(`event: message\nid: ${String(++sseEventId)}\ndata: ${JSON.stringify(msg)}\n\n`);
}

function makeErrorResponse(id: number | string | null, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id });
}

/** RFC 9728 protected-resource metadata URLs to try, in priority order:
 * path-aware first (using upstream's pathname), then root fallback. */
function buildProtectedResourceUrls(remoteUrl: string): string[] {
  const upstream = new URL(remoteUrl);
  const pathname = upstream.pathname === '/' ? '' : upstream.pathname;
  const urls: string[] = [];
  if (pathname) {
    urls.push(new URL(`/.well-known/oauth-protected-resource${pathname}`, upstream.origin).toString());
  }
  urls.push(new URL('/.well-known/oauth-protected-resource', upstream.origin).toString());
  return urls;
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

    sendRequest(msg, _ctx) {
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pendingRequests.delete(msg.id);
          resolve({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'Request timeout' } });
        }, REQUEST_TIMEOUT_MS);
        pendingRequests.set(msg.id, { resolve, timer });
        childStdin.write(JSON.stringify(msg) + '\n');
      });
    },

    sendNotification(msg, _ctx) {
      try {
        childStdin.write(JSON.stringify(msg) + '\n');
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger('debug', `Notification write failed: ${errMsg}`);
      }
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
    if (stdoutBuffer.length > MAX_STDOUT_LINE_LENGTH) {
      logger('info', `stdout line exceeded ${String(MAX_STDOUT_LINE_LENGTH)} bytes without newline; dropping buffer`);
      stdoutBuffer = '';
      return;
    }
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
 * Stream-parse an SSE response from a remote MCP server, forwarding each
 * event as soon as it arrives. Notifications are handed to onServerMessage
 * in real time so in-flight clients see progress without waiting for the
 * entire response. Returns the JSON-RPC response matching originalMsg.
 */
async function parseSseResponse(
  res: Response,
  originalMsg: JsonRpcMessage,
  backend: Backend,
  logger: (level: LogLevel, msg: string) => void,
): Promise<JsonRpcMessage | undefined> {
  const reader = res.body?.getReader() as ReadableStreamDefaultReader<Uint8Array> | undefined;
  if (!reader) return undefined;

  const requestId = hasRequestId(originalMsg) ? originalMsg.id : null;
  const decoder = new TextDecoder();
  let buffer = '';
  let response: JsonRpcMessage | undefined;

  const handleBlock = (block: string): void => {
    let data: string | undefined;
    for (const line of block.split('\n')) {
      if (line.startsWith('data: ')) data = line.slice(6);
      else if (line.startsWith('data:')) data = line.slice(5);
    }
    if (!data?.trim()) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    if (!isJsonRpcMessage(parsed)) return;

    if (requestId !== null && hasRequestId(parsed) && parsed.id === requestId) {
      response = parsed;
    } else {
      backend.onServerMessage?.(parsed);
    }
  };

  try {
    let searchFrom = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > MAX_SSE_BUFFER) {
        logger('info', `SSE event exceeded ${String(MAX_SSE_BUFFER)} bytes without terminator; aborting`);
        await reader.cancel().catch(() => { /* ignore */ });
        return response;
      }
      let boundary = buffer.indexOf('\n\n', searchFrom);
      while (boundary !== -1) {
        handleBlock(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf('\n\n');
      }
      searchFrom = Math.max(0, buffer.length - 1);
    }
    if (buffer.trim()) handleBlock(buffer);
  } catch (err) {
    await reader.cancel().catch(() => { /* ignore */ });
    throw err;
  } finally {
    reader.releaseLock();
  }

  return response;
}

function createProxyBackend(
  remoteUrl: string,
  headers: Record<string, string>,
  authMode: AuthMode,
  oauthClient: OAuthClient | undefined,
  logger: (level: LogLevel, msg: string) => void,
): Backend {
  let remoteSessionId: string | undefined;
  let accessToken: string | undefined;

  // Preload cached token (managed mode only) so the first request avoids
  // an unnecessary 401 roundtrip. Passthrough mode never holds tokens.
  const initialTokenLoad = oauthClient
    ? oauthClient.getAccessToken().then((token) => {
        if (token && !accessToken) accessToken = token;
      }).catch(() => { /* fall through to 401-driven flow */ })
    : Promise.resolve();

  async function forwardToRemote(
    msg: JsonRpcMessage,
    ctx: RequestContext | undefined,
    retryCount = 0,
  ): Promise<JsonRpcMessage | undefined> {
    await initialTokenLoad;
    const reqHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      ...headers,
    };
    if (authMode === 'passthrough') {
      if (ctx?.authorization) reqHeaders['Authorization'] = ctx.authorization;
    } else if (accessToken) {
      reqHeaders['Authorization'] = `Bearer ${accessToken}`;
    }
    if (remoteSessionId && msg.method !== 'initialize') {
      reqHeaders['Mcp-Session-Id'] = remoteSessionId;
    }

    let res: Response;
    try {
      res = await fetch(remoteUrl, {
        method: 'POST',
        headers: reqHeaders,
        body: JSON.stringify(msg),
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger('info', `Remote fetch failed: ${errMsg}`);
      return {
        jsonrpc: '2.0',
        id: hasRequestId(msg) ? msg.id : null,
        error: { code: -32000, message: `Remote server unreachable: ${errMsg}` },
      };
    }

    if (res.status === 401) {
      const wwwAuth = res.headers.get('www-authenticate') ?? undefined;
      if (authMode === 'passthrough') {
        // Drain body so the connection can be reused.
        await res.text().catch(() => { /* ignore */ });
        throw new UnauthorizedError(wwwAuth);
      }
      if (oauthClient && retryCount < 2) {
        logger('info', 'Received 401, starting OAuth flow...');
        accessToken = await oauthClient.handleUnauthorized(wwwAuth);
        logger('info', 'OAuth completed, retrying request...');
        return await forwardToRemote(msg, ctx, retryCount + 1);
      }
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
      return await parseSseResponse(res, msg, backend, logger);
    }

    return await res.json() as JsonRpcMessage;
  }

  const backend: Backend = {
    onServerMessage: null,
    onClose: null,

    async sendRequest(msg, ctx) {
      const response = await forwardToRemote(msg, ctx);
      return response ?? { jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'No response from remote' } };
    },

    sendNotification(msg, ctx) {
      forwardToRemote(msg, ctx).catch((err: unknown) => {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger('debug', `Notification forward failed: ${errMsg}`);
      });
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
  const proxyAuthMode: AuthMode = options.mode === 'proxy'
    ? options.authMode ?? 'managed'
    : 'managed';

  function logger(level: LogLevel, msg: string): void {
    if (logLevel === 'none') return;
    if (logLevel === 'info' && level === 'debug') return;
    process.stderr.write(`[${new Date().toISOString()}] [${level}] ${msg}\n`);
  }

  // OAuth client is gateway-managed only; passthrough delegates to the client.
  const sharedOAuthClient = options.mode === 'proxy' && proxyAuthMode === 'managed'
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
      b = createProxyBackend(
        options.url,
        options.headers ?? {},
        proxyAuthMode,
        sharedOAuthClient,
        logger,
      );
    }

    b.onServerMessage = (msg): void => {
      for (const session of sessions.values()) {
        if (session.liveSSE && sendSSE(session.liveSSE, msg)) continue;
        if (session.liveSSE) session.liveSSE = null;
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

  async function sendRequest(
    msg: JsonRpcMessage & { id: number | string },
    ctx?: RequestContext,
  ): Promise<JsonRpcMessage> {
    const originalId = msg.id;
    const internalId = nextRequestId++;
    const response = await backend.sendRequest({ ...msg, id: internalId }, ctx);
    restartBackoff = 1000;
    return { ...response, id: originalId };
  }

  function sendNotification(msg: JsonRpcMessage, ctx?: RequestContext): void {
    backend.sendNotification(msg, ctx);
  }

  function writeUnauthorized(
    res: ServerResponse,
    err: UnauthorizedError,
    requestId: number | string | null,
  ): void {
    if (res.headersSent) return;
    const respHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
    if (err.wwwAuthenticate) respHeaders['WWW-Authenticate'] = err.wwwAuthenticate;
    res.writeHead(401, respHeaders);
    res.end(JSON.stringify({
      jsonrpc: '2.0',
      id: requestId,
      error: { code: -32001, message: 'Unauthorized' },
    }));
  }

  async function handleRequestOverSSE(
    res: ServerResponse,
    message: JsonRpcMessage & { id: number | string },
    session: Session,
    ctx: RequestContext,
  ): Promise<void> {
    // Passthrough mode delays SSE headers so a 401 from upstream can still
    // surface as an HTTP 401 to the client (re-auth requires this).
    if (proxyAuthMode === 'passthrough') {
      let response: JsonRpcMessage;
      try {
        response = await sendRequest(message, ctx);
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          writeUnauthorized(res, err, message.id);
          return;
        }
        throw err;
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Mcp-Session-Id': session.id,
      });
      const pending = session.notificationBuffer;
      session.notificationBuffer = [];
      for (const notif of pending) sendSSE(res, notif);
      sendSSE(res, response);
      res.end();
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Mcp-Session-Id': session.id,
    });

    const pending = session.notificationBuffer;
    session.notificationBuffer = [];
    for (const notif of pending) sendSSE(res, notif);

    session.liveSSE = res;
    const detachIfOwned = (): void => {
      if (session.liveSSE === res) session.liveSSE = null;
    };
    res.on('close', detachIfOwned);

    try {
      const response = await sendRequest(message, ctx);
      sendSSE(res, response);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      sendSSE(res, {
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32603, message: errMsg },
      });
    } finally {
      res.removeListener('close', detachIfOwned);
      detachIfOwned();
      res.end();
    }
  }

  function respondWithJson(
    res: ServerResponse,
    response: JsonRpcMessage,
    sessionId: string,
  ): void {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': sessionId });
    res.end(JSON.stringify(response));
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

    const authHeader = req.headers.authorization;
    const ctx: RequestContext = {};
    if (typeof authHeader === 'string') ctx.authorization = authHeader;

    if (message.method === 'initialize') {
      const session: Session = {
        id: randomUUID(),
        notificationBuffer: [],
        liveSSE: null,
      };
      sessions.set(session.id, session);
      logger('info', `Session ${session.id.slice(0, 8)} created (${String(sessions.size)} active)`);

      try {
        if (hasRequestId(message)) {
          const response = await sendRequest(message, ctx);
          respondWithJson(res, response, session.id);
        } else {
          sendNotification(message, ctx);
          res.writeHead(202, { 'Mcp-Session-Id': session.id });
          res.end();
        }
      } catch (err) {
        sessions.delete(session.id);
        if (err instanceof UnauthorizedError) {
          writeUnauthorized(res, err, message.id ?? null);
          return;
        }
        throw err;
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
      const clientAcceptsSSE = (req.headers.accept ?? '').includes('text/event-stream');
      try {
        if (clientAcceptsSSE) {
          await handleRequestOverSSE(res, message, session, ctx);
        } else {
          const response = await sendRequest(message, ctx);
          respondWithJson(res, response, session.id);
        }
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          writeUnauthorized(res, err, message.id);
          return;
        }
        throw err;
      }
      return;
    }

    sendNotification(message, ctx);
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

  const upstreamProtectedResourceUrls = options.mode === 'proxy' && proxyAuthMode === 'passthrough'
    ? buildProtectedResourceUrls(options.url)
    : [];

  async function handleProtectedResourceProxy(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'text/plain' });
      res.end('Method Not Allowed');
      return;
    }

    let lastStatus = 404;
    let lastBody = '';
    let lastContentType = 'application/json';
    for (const target of upstreamProtectedResourceUrls) {
      let upstream: Response;
      try {
        upstream = await fetch(target, {
          method: 'GET',
          headers: { 'Accept': 'application/json' },
        });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger('info', `Protected-resource fetch failed (${target}): ${errMsg}`);
        continue;
      }
      const text = await upstream.text();
      if (upstream.ok) {
        const ct = upstream.headers.get('content-type') ?? 'application/json';
        res.writeHead(upstream.status, { 'Content-Type': ct });
        res.end(text);
        return;
      }
      lastStatus = upstream.status;
      lastBody = text;
      lastContentType = upstream.headers.get('content-type') ?? 'application/json';
    }
    res.writeHead(lastStatus, { 'Content-Type': lastContentType });
    res.end(lastBody);
  }

  const httpServer = createHttpServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version');
    res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id, WWW-Authenticate');

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

    // Pass-through OAuth discovery so MCP clients can run their own auth flow
    // (RFC 9728). Only enabled in proxy + passthrough mode.
    if (
      upstreamProtectedResourceUrls.length > 0 &&
      (urlPath === '/.well-known/oauth-protected-resource' ||
        urlPath.startsWith('/.well-known/oauth-protected-resource/'))
    ) {
      handleProtectedResourceProxy(req, res).catch((err: unknown) => {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger('info', `Protected-resource proxy error: ${errMsg}`);
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'text/plain' });
          res.end('Bad Gateway');
        }
      });
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
        if (restartTimer) clearTimeout(restartTimer);
        sessions.clear();
        backend.onClose = null;
        backend.close();
        httpServer.close(() => { resolve(); });
      });
    },
  };
}
