import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import type {
  NormalizedConfig,
  ClaudeConfig,
  ClaudeServerConfig,
  CodexConfig,
  CodexServerConfig,
  SyncResult,
  RemoveResult,
} from './types.js';

function generateClaudeConfig(
  config: NormalizedConfig
): Record<string, ClaudeServerConfig> {
  const { mcpServers } = config;
  const claudeConfig: Record<string, ClaudeServerConfig> = {};

  for (const [name, server] of Object.entries(mcpServers)) {
    if (server.type === 'stdio' || server.type === 'proxy') {
      claudeConfig[name] = {
        type: 'http',
        url: `http://localhost:${String(server.internalPort)}/mcp`,
      };
    } else {
      claudeConfig[name] = {
        type: server.type,
        url: server.url,
      };
    }
  }

  return claudeConfig;
}

export function syncToClaudeConfig(config: NormalizedConfig): SyncResult {
  const { settings } = config;
  const claudeConfigPath = settings.claudeConfigPath;

  let existingConfig: ClaudeConfig = {};
  if (existsSync(claudeConfigPath)) {
    try {
      const content = readFileSync(claudeConfigPath, 'utf-8');
      existingConfig = JSON.parse(content) as ClaudeConfig;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Warning: Failed to parse ${claudeConfigPath}: ${message}`);
      console.error('  Existing config will be overwritten.');
      existingConfig = {};
    }
  }

  const newServers = generateClaudeConfig(config);

  const mergedConfig: ClaudeConfig = { ...existingConfig };
  mergedConfig.mcpServers = { ...(existingConfig.mcpServers ?? {}) };
  for (const [name, serverConfig] of Object.entries(newServers)) {
    mergedConfig.mcpServers[name] = serverConfig;
  }

  writeFileSync(
    claudeConfigPath,
    JSON.stringify(mergedConfig, null, 2) + '\n'
  );

  return {
    path: claudeConfigPath,
    servers: Object.keys(newServers),
    merged: Object.keys(existingConfig.mcpServers ?? {}).length > 0,
  };
}

export function removeFromClaudeConfig(
  config: NormalizedConfig,
  serverNames: string[] | null = null
): RemoveResult {
  const { settings, mcpServers } = config;
  const claudeConfigPath = settings.claudeConfigPath;

  if (!existsSync(claudeConfigPath)) {
    return { path: claudeConfigPath, removed: [] };
  }

  let existingConfig: ClaudeConfig;
  try {
    const content = readFileSync(claudeConfigPath, 'utf-8');
    existingConfig = JSON.parse(content) as ClaudeConfig;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Warning: Failed to parse ${claudeConfigPath}: ${message}`);
    return { path: claudeConfigPath, removed: [] };
  }

  if (!existingConfig.mcpServers) {
    return { path: claudeConfigPath, removed: [] };
  }

  const toRemove = serverNames ?? Object.keys(mcpServers);
  const removed: string[] = [];

  for (const name of toRemove) {
    if (existingConfig.mcpServers[name]) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete existingConfig.mcpServers[name];
      removed.push(name);
    }
  }

  writeFileSync(
    claudeConfigPath,
    JSON.stringify(existingConfig, null, 2) + '\n'
  );

  return {
    path: claudeConfigPath,
    removed,
  };
}

function generateCodexConfig(
  config: NormalizedConfig
): { servers: Record<string, CodexServerConfig>; skipped: string[] } {
  const { mcpServers } = config;
  const servers: Record<string, CodexServerConfig> = {};
  const skipped: string[] = [];

  for (const [name, server] of Object.entries(mcpServers)) {
    if (server.type === 'stdio' || server.type === 'proxy') {
      servers[name] = {
        url: `http://localhost:${String(server.internalPort)}/mcp`,
      };
    } else if (server.type === 'http') {
      servers[name] = { url: server.url };
    } else {
      // codex's `url` field targets streamable HTTP only; SSE remotes need `proxy: true`
      skipped.push(name);
    }
  }

  return { servers, skipped };
}

export function syncToCodexConfig(config: NormalizedConfig): SyncResult & { skipped: string[] } {
  const { settings } = config;
  const codexConfigPath = settings.codexConfigPath;

  let existingConfig: CodexConfig = {};
  if (existsSync(codexConfigPath)) {
    try {
      const content = readFileSync(codexConfigPath, 'utf-8');
      existingConfig = parseToml(content) as CodexConfig;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Warning: Failed to parse ${codexConfigPath}: ${message}`);
      console.error('  Existing config will be overwritten.');
      existingConfig = {};
    }
  }

  const { servers: newServers, skipped } = generateCodexConfig(config);

  const mergedConfig: CodexConfig = { ...existingConfig };
  mergedConfig.mcp_servers = { ...(existingConfig.mcp_servers ?? {}) };
  for (const [name, serverConfig] of Object.entries(newServers)) {
    mergedConfig.mcp_servers[name] = serverConfig;
  }

  mkdirSync(dirname(codexConfigPath), { recursive: true });
  writeFileSync(codexConfigPath, stringifyToml(mergedConfig) + '\n');

  return {
    path: codexConfigPath,
    servers: Object.keys(newServers),
    merged: Object.keys(existingConfig.mcp_servers ?? {}).length > 0,
    skipped,
  };
}

export function removeFromCodexConfig(
  config: NormalizedConfig,
  serverNames: string[] | null = null
): RemoveResult {
  const { settings, mcpServers } = config;
  const codexConfigPath = settings.codexConfigPath;

  if (!existsSync(codexConfigPath)) {
    return { path: codexConfigPath, removed: [] };
  }

  let existingConfig: CodexConfig;
  try {
    const content = readFileSync(codexConfigPath, 'utf-8');
    existingConfig = parseToml(content) as CodexConfig;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Warning: Failed to parse ${codexConfigPath}: ${message}`);
    return { path: codexConfigPath, removed: [] };
  }

  if (!existingConfig.mcp_servers) {
    return { path: codexConfigPath, removed: [] };
  }

  const toRemove = serverNames ?? Object.keys(mcpServers);
  const removed: string[] = [];

  for (const name of toRemove) {
    if (existingConfig.mcp_servers[name]) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete existingConfig.mcp_servers[name];
      removed.push(name);
    }
  }

  writeFileSync(codexConfigPath, stringifyToml(existingConfig) + '\n');

  return {
    path: codexConfigPath,
    removed,
  };
}
