import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { exec } from 'node:child_process';

// --- Types ---

export interface OAuthTokens {
  access_token: string;
  token_type: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
}

interface OAuthClientInfo {
  client_id: string;
  client_secret?: string;
  redirect_uris?: string[];
}

interface ProtectedResourceMetadata {
  resource?: string;
  authorization_servers?: string[];
  scopes_supported?: string[];
}

interface AuthServerMetadata {
  issuer?: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
  response_types_supported?: string[];
  code_challenge_methods_supported?: string[];
}

interface StoredAuth {
  tokens?: OAuthTokens;
  clientInfo?: OAuthClientInfo;
  tokenSavedAt?: string;
}

export interface OAuthClientOptions {
  serverUrl: string;
  headers?: Record<string, string>;
  authTimeout?: number;
}

// --- Constants ---

const CONFIG_DIR = join(homedir(), '.mcp-auth', 'mcp-compose');
const DEFAULT_AUTH_TIMEOUT = 120_000;
const MCP_PROTOCOL_VERSION = '2025-03-26';

const CLIENT_NAME = 'mcp-compose';

// --- Helpers ---

function serverHash(url: string): string {
  return createHash('md5').update(url).digest('hex').slice(0, 12);
}

function generateCodeVerifier(): string {
  return randomBytes(32).toString('base64url');
}

function generateCodeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

async function ensureConfigDir(): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
}

function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'start ""'
    : 'xdg-open';
  exec(`${cmd} "${url}"`, (err) => {
    if (err) {
      process.stderr.write(`Please open this URL in your browser:\n${url}\n`);
    }
  });
}

function parseWwwAuthenticateScope(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /scope="([^"]+)"/.exec(header);
  return match?.[1];
}

function listenOnRandomPort(server: ReturnType<typeof createHttpServer>): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}

// --- Storage ---

async function loadStoredAuth(hash: string): Promise<StoredAuth | undefined> {
  try {
    const content = await readFile(join(CONFIG_DIR, `${hash}.json`), 'utf-8');
    return JSON.parse(content) as StoredAuth;
  } catch {
    return undefined;
  }
}

async function saveStoredAuth(hash: string, auth: StoredAuth): Promise<void> {
  await ensureConfigDir();
  await writeFile(join(CONFIG_DIR, `${hash}.json`), JSON.stringify(auth, null, 2), { mode: 0o600 });
}

// --- Discovery ---

async function fetchJson<T>(url: string, headers?: Record<string, string>): Promise<T | undefined> {
  try {
    const res = headers ? await fetch(url, { headers }) : await fetch(url);
    if (res.ok) return await res.json() as T;
  } catch {
    // ignore network errors, continue
  }
  return undefined;
}

async function discoverProtectedResource(
  serverUrl: string,
  headers?: Record<string, string>
): Promise<ProtectedResourceMetadata | undefined> {
  const url = new URL(serverUrl);
  const fetchHeaders = { 'MCP-Protocol-Version': MCP_PROTOCOL_VERSION, ...headers };

  // Path-aware URL first, then root fallback (RFC 9728)
  return await fetchJson<ProtectedResourceMetadata>(
    new URL(`/.well-known/oauth-protected-resource${url.pathname}`, url.origin).toString(),
    fetchHeaders,
  ) ?? await fetchJson<ProtectedResourceMetadata>(
    new URL('/.well-known/oauth-protected-resource', url.origin).toString(),
    fetchHeaders,
  );
}

async function discoverAuthServer(authServerUrl: string): Promise<AuthServerMetadata | undefined> {
  const url = new URL(authServerUrl);
  const hasPath = url.pathname !== '/' && url.pathname !== '';

  // RFC 8414 + OIDC Discovery URLs in priority order
  const urls = hasPath ? [
    new URL(`/.well-known/oauth-authorization-server${url.pathname}`, url.origin),
    new URL(`/.well-known/openid-configuration${url.pathname}`, url.origin),
    new URL(`${url.pathname}/.well-known/openid-configuration`, url.origin),
  ] : [
    new URL('/.well-known/oauth-authorization-server', url.origin),
    new URL('/.well-known/openid-configuration', url.origin),
  ];

  for (const discoveryUrl of urls) {
    const meta = await fetchJson<AuthServerMetadata>(discoveryUrl.toString());
    if (meta) return meta;
  }
  return undefined;
}

// --- Registration (RFC 7591) ---

async function registerClient(
  authServerUrl: string,
  metadata: AuthServerMetadata | undefined,
  redirectUri: string,
): Promise<OAuthClientInfo> {
  const endpoint = metadata?.registration_endpoint
    ?? new URL('/register', authServerUrl).toString();

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: CLIENT_NAME,
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });

  if (!res.ok) {
    throw new Error(`Client registration failed: ${String(res.status)} ${await res.text()}`);
  }

  const info = await res.json() as OAuthClientInfo;
  info.redirect_uris = [redirectUri];
  return info;
}

// --- Token Exchange ---

function buildClientAuthHeaders(clientInfo: OAuthClientInfo): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Accept': 'application/json',
  };
  if (clientInfo.client_secret) {
    headers['Authorization'] = `Basic ${Buffer.from(`${clientInfo.client_id}:${clientInfo.client_secret}`).toString('base64')}`;
  }
  return headers;
}

async function exchangeCodeForTokens(
  authServerUrl: string,
  metadata: AuthServerMetadata | undefined,
  clientInfo: OAuthClientInfo,
  code: string,
  codeVerifier: string,
  redirectUri: string,
): Promise<OAuthTokens> {
  const tokenUrl = metadata?.token_endpoint ?? new URL('/token', authServerUrl).toString();

  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    code_verifier: codeVerifier,
    redirect_uri: redirectUri,
    client_id: clientInfo.client_id,
  });

  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: buildClientAuthHeaders(clientInfo),
    body: params.toString(),
  });

  if (!res.ok) {
    throw new Error(`Token exchange failed: ${String(res.status)} ${await res.text()}`);
  }

  return await res.json() as OAuthTokens;
}

async function refreshAccessToken(
  authServerUrl: string,
  metadata: AuthServerMetadata | undefined,
  clientInfo: OAuthClientInfo,
  refreshToken: string,
): Promise<OAuthTokens | undefined> {
  const tokenUrl = metadata?.token_endpoint ?? new URL('/token', authServerUrl).toString();

  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientInfo.client_id,
  });

  try {
    const res = await fetch(tokenUrl, {
      method: 'POST',
      headers: buildClientAuthHeaders(clientInfo),
      body: params.toString(),
    });

    if (!res.ok) return undefined;

    const tokens = await res.json() as OAuthTokens;
    // Preserve original refresh token if server doesn't return a new one
    tokens.refresh_token ??= refreshToken;
    return tokens;
  } catch {
    return undefined;
  }
}

// --- Callback Server ---

function waitForOAuthCallback(
  server: ReturnType<typeof createHttpServer>,
  port: number,
  timeout: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      server.close();
      reject(new Error('OAuth authorization timed out'));
    }, timeout);

    server.on('request', (req: IncomingMessage, res: ServerResponse) => {
      const reqUrl = new URL(req.url ?? '/', `http://127.0.0.1:${String(port)}`);
      if (reqUrl.pathname !== '/oauth/callback') {
        res.writeHead(404);
        res.end();
        return;
      }

      const code = reqUrl.searchParams.get('code');
      const error = reqUrl.searchParams.get('error');

      if (code) {
        clearTimeout(timer);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body><h1>Authorization successful</h1><p>You can close this tab.</p></body></html>');
        server.close();
        resolve(code);
      } else {
        clearTimeout(timer);
        const msg = (error ?? reqUrl.searchParams.get('error_description') ?? 'Unknown error')
          .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(`<html><body><h1>Authorization failed</h1><p>${msg}</p></body></html>`);
        server.close();
        reject(new Error(`OAuth error: ${msg}`));
      }
    });
  });
}

// --- Main OAuth Client ---

export class OAuthClient {
  private readonly hash: string;
  private readonly serverUrl: string;
  private readonly headers: Record<string, string>;
  private readonly authTimeout: number;

  private stored: StoredAuth | undefined;
  private authServerUrl: string | undefined;
  private authServerMetadata: AuthServerMetadata | undefined;
  /** Deduplicates concurrent handleUnauthorized() calls into a single auth flow. */
  private pendingAuth: Promise<string> | null = null;

  constructor(options: OAuthClientOptions) {
    this.serverUrl = options.serverUrl;
    this.headers = options.headers ?? {};
    this.authTimeout = options.authTimeout ?? DEFAULT_AUTH_TIMEOUT;
    this.hash = serverHash(options.serverUrl);
  }

  /**
   * Get a valid access token, loading from disk cache if available.
   */
  async getAccessToken(): Promise<string | undefined> {
    this.stored ??= await loadStoredAuth(this.hash);
    return this.stored?.tokens?.access_token;
  }

  /**
   * Handle a 401 response from the remote server.
   * Deduplicates concurrent calls — only one auth flow runs at a time;
   * subsequent callers wait for the same result.
   */
  async handleUnauthorized(wwwAuthenticate?: string): Promise<string> {
    if (this.pendingAuth) {
      return this.pendingAuth;
    }

    this.pendingAuth = this.executeAuthFlow(wwwAuthenticate);
    try {
      return await this.pendingAuth;
    } finally {
      this.pendingAuth = null;
    }
  }

  private async executeAuthFlow(wwwAuthenticate?: string): Promise<string> {
    const scope = parseWwwAuthenticateScope(wwwAuthenticate);

    this.stored ??= await loadStoredAuth(this.hash) ?? {};

    // Discover auth server
    await this.discover();

    // Try refresh first
    if (this.stored.tokens?.refresh_token && this.stored.clientInfo && this.authServerUrl) {
      const refreshed = await refreshAccessToken(
        this.authServerUrl,
        this.authServerMetadata,
        this.stored.clientInfo,
        this.stored.tokens.refresh_token,
      );
      if (refreshed) {
        this.stored.tokens = refreshed;
        this.stored.tokenSavedAt = new Date().toISOString();
        await saveStoredAuth(this.hash, this.stored);
        return refreshed.access_token;
      }
    }

    // Full authorization code flow with PKCE
    if (!this.authServerUrl) {
      throw new Error('Failed to discover authorization server');
    }

    // Start callback server on a random port
    const callbackHttpServer = createHttpServer();
    const callbackPort = await listenOnRandomPort(callbackHttpServer);
    const redirectUri = `http://127.0.0.1:${String(callbackPort)}/oauth/callback`;

    try {
      // Register client (or re-register if redirect_uri changed)
      if (!this.stored.clientInfo?.redirect_uris?.includes(redirectUri)) {
        this.stored.clientInfo = await registerClient(
          this.authServerUrl,
          this.authServerMetadata,
          redirectUri,
        );
      }

      // PKCE
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = generateCodeChallenge(codeVerifier);

      // Build authorization URL
      const authEndpoint = this.authServerMetadata?.authorization_endpoint
        ?? new URL('/authorize', this.authServerUrl).toString();
      const authUrl = new URL(authEndpoint);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('client_id', this.stored.clientInfo.client_id);
      authUrl.searchParams.set('redirect_uri', redirectUri);
      authUrl.searchParams.set('code_challenge', codeChallenge);
      authUrl.searchParams.set('code_challenge_method', 'S256');
      if (scope) authUrl.searchParams.set('scope', scope);

      // Open browser and wait for callback
      process.stderr.write(`Opening browser for authorization...\n`);
      openBrowser(authUrl.toString());

      const code = await waitForOAuthCallback(callbackHttpServer, callbackPort, this.authTimeout);

      // Exchange code for tokens
      const tokens = await exchangeCodeForTokens(
        this.authServerUrl,
        this.authServerMetadata,
        this.stored.clientInfo,
        code,
        codeVerifier,
        redirectUri,
      );

      this.stored.tokens = tokens;
      this.stored.tokenSavedAt = new Date().toISOString();
      await saveStoredAuth(this.hash, this.stored);

      return tokens.access_token;
    } finally {
      callbackHttpServer.close();
    }
  }

  private async discover(): Promise<void> {
    if (this.authServerUrl) return;

    const resourceMeta = await discoverProtectedResource(this.serverUrl, this.headers);
    const firstServer = resourceMeta?.authorization_servers?.[0];
    this.authServerUrl = firstServer ?? new URL('/', this.serverUrl).toString();
    this.authServerMetadata = await discoverAuthServer(this.authServerUrl);
  }
}
