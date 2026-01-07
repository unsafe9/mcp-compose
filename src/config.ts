import { readFileSync, existsSync } from 'fs';
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
} from './types.js';

const DEFAULT_SETTINGS: Settings = {
  portBase: 19100,
  claudeConfigPath: '~/.mcp.json',
  logLevel: 'info',
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
  const config = JSON.parse(content) as RawConfig;

  return normalizeConfig(config);
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
