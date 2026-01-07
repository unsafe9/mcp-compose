export type LogLevel = 'debug' | 'info' | 'none';

export interface ResourceLimits {
  maxMemory?: string | number; // e.g., "512M", "1G", or bytes as number
  maxRestarts?: number;        // Maximum restart attempts (default: 10)
  restartDelay?: number;       // Delay between restarts in ms (default: 1000)
}

export interface Settings {
  portBase: number;
  claudeConfigPath: string;
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

export type NormalizedServer = StdioServer | RemoteServer;

export interface NormalizedConfig {
  settings: Settings;
  mcpServers: Record<string, NormalizedServer>;
  configPath: string | undefined;
}

export interface NamedStdioServer extends StdioServer {
  name: string;
}

export interface SupergatewayCommand {
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

export interface SyncResult {
  path: string;
  servers: string[];
  merged: boolean;
}

export interface RemoveResult {
  path: string;
  removed: string[];
}
