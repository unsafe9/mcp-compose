import { readFileSync, existsSync } from 'fs';
import { createServer } from 'net';
import { homedir } from 'os';
import { resolve } from 'path';
import type {
  Settings,
  RawConfig,
  RawServerConfig,
  NormalizedConfig,
  NormalizedServer,
  StdioServer,
  NamedStdioServer,
  ResourceLimits,
} from './types.js';
import { assertValidConfig } from './validation.js';

const DEFAULT_SETTINGS: Settings = {
  portBase: 19100,
  claudeConfigPath: '~/.mcp.json',
  logLevel: 'info',
  processPrefix: 'mcp-compose-',
};

const CONFIG_FILENAMES = [
  'mcp-compose.json',
  'mcp-compose.jsonc',
  'config.json',
  'config.jsonc',
];

export function expandPath(p: string): string {
  if (p.startsWith('~/')) {
    return resolve(homedir(), p.slice(2));
  }
  return resolve(p);
}

export function findConfigFile(startDir: string = process.cwd()): string | null {
  const searchDirs = [
    resolve(homedir(), '.config', 'mcp-compose'),
    startDir,
  ];

  for (const dir of searchDirs) {
    for (const filename of CONFIG_FILENAMES) {
      const configPath = resolve(dir, filename);
      if (existsSync(configPath)) {
        return configPath;
      }
    }
  }
  return null;
}

export function loadConfig(configPath?: string): NormalizedConfig {
  const resolvedPath = configPath ?? findConfigFile();

  if (!resolvedPath) {
    throw new Error(
      'No mcp-compose.json found. Create one or specify path with --config'
    );
  }

  if (!existsSync(resolvedPath)) {
    throw new Error(`Config file not found: ${resolvedPath}`);
  }

  const content = readFileSync(resolvedPath, 'utf-8');
  let config: unknown;
  try {
    config = JSON.parse(content);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid JSON in config file: ${message}`);
  }

  // Validate configuration structure
  assertValidConfig(config);

  return normalizeConfig(config);
}

/**
 * Check if a port is available
 */
export function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => {
      resolve(false);
    });
    server.once('listening', () => {
      server.close(() => {
        resolve(true);
      });
    });
    server.listen(port, '127.0.0.1');
  });
}

/**
 * Find the next available port starting from the given port
 */
async function findAvailablePort(startPort: number, maxAttempts = 100): Promise<number> {
  for (let i = 0; i < maxAttempts; i++) {
    const port = startPort + i;
    if (port > 65535) {
      throw new Error('No available ports found (exceeded port 65535)');
    }
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available ports found after ${String(maxAttempts)} attempts starting from ${String(startPort)}`);
}

/**
 * Allocate available ports for servers, skipping ports that are in use
 */
export async function allocatePorts(
  serverCount: number,
  portBase: number,
  onPortSkipped?: (port: number, assignedPort: number) => void
): Promise<number[]> {
  const ports: number[] = [];
  let nextPort = portBase;

  for (let i = 0; i < serverCount; i++) {
    const availablePort = await findAvailablePort(nextPort);
    if (availablePort !== nextPort && onPortSkipped) {
      onPortSkipped(nextPort, availablePort);
    }
    ports.push(availablePort);
    nextPort = availablePort + 1;
  }

  return ports;
}

export function normalizeConfig(config: RawConfig): NormalizedConfig {
  const settings: Settings = { ...DEFAULT_SETTINGS, ...config.settings };
  settings.claudeConfigPath = expandPath(settings.claudeConfigPath);

  const mcpServers: Record<string, NormalizedServer> = {};
  let portIndex = 0;

  for (const [name, server] of Object.entries(config.mcpServers ?? {})) {
    if (server.disabled) {
      continue;
    }

    const normalized = normalizeServer(name, server, settings.portBase + portIndex, settings);
    mcpServers[name] = normalized;

    if (normalized.type === 'stdio') {
      portIndex++;
    }
  }

  return {
    settings,
    mcpServers,
    configPath: config.configPath,
  };
}

const DEFAULT_RESOURCE_LIMITS: ResourceLimits = {
  maxRestarts: 10,
  restartDelay: 1000,
};

function normalizeServer(
  name: string,
  server: RawServerConfig,
  internalPort: number,
  settings: Settings
): NormalizedServer {
  const type = server.type ?? ('command' in server ? 'stdio' : 'http');

  if (type === 'stdio') {
    if (!('command' in server) || !server.command) {
      throw new Error(`Server "${name}" is stdio type but missing command`);
    }

    return {
      type: 'stdio',
      command: server.command,
      args: server.args ?? [],
      env: server.env ?? {},
      internalPort,
      logLevel: server.logLevel ?? settings.logLevel,
      resourceLimits: { ...DEFAULT_RESOURCE_LIMITS, ...server.resourceLimits },
    };
  }

  // type is 'sse' or 'http'
  if (!('url' in server) || !server.url) {
    throw new Error(`Server "${name}" is ${type} type but missing url`);
  }

  return {
    type,
    url: server.url,
  };
}

export function getServerNames(
  config: NormalizedConfig,
  filter: string[] = []
): string[] {
  const allNames = Object.keys(config.mcpServers);

  if (filter.length === 0) {
    return allNames;
  }

  for (const name of filter) {
    if (!allNames.includes(name)) {
      throw new Error(
        `Unknown server: ${name}. Available: ${allNames.join(', ')}`
      );
    }
  }

  return filter;
}

export function getStdioServers(config: NormalizedConfig): NamedStdioServer[] {
  return Object.entries(config.mcpServers)
    .filter((entry): entry is [string, StdioServer] => entry[1].type === 'stdio')
    .map(([name, server]) => ({ name, ...server }));
}
