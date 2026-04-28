export type LogLevel = 'debug' | 'info' | 'none';

export interface ResourceLimits {
  maxMemory?: string | number; // e.g., "512M", "1G", or bytes as number
  maxRestarts?: number;        // Maximum restart attempts (default: 10)
  restartDelay?: number;       // Delay between restarts in ms (default: 1000)
}

export interface Settings {
  portBase: number;
  claudeConfigPath: string;
  codexConfigPath: string;
  logLevel: LogLevel;
  processPrefix: string;
}

export interface RawStdioServer {
  type?: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
  disabled?: boolean;
  logLevel?: LogLevel;
  resourceLimits?: ResourceLimits;
}

export interface RawRemoteServer {
  type: 'sse' | 'http';
  url: string;
  disabled?: boolean;
  proxy?: boolean;
  headers?: Record<string, string>;
  logLevel?: LogLevel;
  resourceLimits?: ResourceLimits;
}

export type RawServerConfig = RawStdioServer | RawRemoteServer;

export interface RawConfig {
  settings?: Partial<Settings>;
  mcpServers?: Record<string, RawServerConfig>;
  configPath?: string;
}

export interface StdioServer {
  type: 'stdio';
  command: string;
  args: string[];
  env: Record<string, string>;
  internalPort: number;
  logLevel: LogLevel;
  resourceLimits: ResourceLimits;
}

export interface RemoteServer {
  type: 'sse' | 'http';
  url: string;
}

export interface ProxyServer {
  type: 'proxy';
  url: string;
  transport: 'http' | 'sse';
  headers: Record<string, string>;
  internalPort: number;
  logLevel: LogLevel;
  resourceLimits: ResourceLimits;
}

export type NormalizedServer = StdioServer | RemoteServer | ProxyServer;

export interface NormalizedConfig {
  settings: Settings;
  mcpServers: Record<string, NormalizedServer>;
  configPath: string | undefined;
}

export interface NamedStdioServer extends StdioServer {
  name: string;
}

export interface NamedProxyServer extends ProxyServer {
  name: string;
}

export type NamedManagedServer = NamedStdioServer | NamedProxyServer;

export interface GatewayCommand {
  script: string;
  args: string[];
}

export interface StartResult {
  name: string;
  processName: string;
  port: number;
}

export interface ServerStatus {
  name: string;
  processName: string;
  pid: number | undefined;
  status: string;
  uptime: number | undefined;
  restarts: number;
  memory: number | undefined;
  cpu: number | undefined;
}

export interface ClaudeServerConfig {
  type: 'sse' | 'http';
  url: string;
}

export interface ClaudeConfig {
  mcpServers?: Record<string, ClaudeServerConfig>;
  [key: string]: unknown;
}

export interface CodexStdioServer {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface CodexHttpServer {
  url: string;
}

export type CodexServerConfig = CodexStdioServer | CodexHttpServer;

export interface CodexConfig {
  mcp_servers?: Record<string, CodexServerConfig>;
  [key: string]: unknown;
}

export interface SyncResult {
  path: string;
  servers: string[];
  merged: boolean;
}

export interface RemoveResult {
  path: string;
  removed: string[];
}
