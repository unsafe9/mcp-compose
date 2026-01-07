import { readFileSync, writeFileSync, existsSync } from 'fs';
import type {
  NormalizedConfig,
  ClaudeConfig,
  ClaudeServerConfig,
  SyncResult,
  RemoveResult,
} from './types.js';

function generateClaudeConfig(
  config: NormalizedConfig
): Record<string, ClaudeServerConfig> {
  const { mcpServers } = config;
  const claudeConfig: Record<string, ClaudeServerConfig> = {};

  for (const [name, server] of Object.entries(mcpServers)) {
    if (server.type === 'stdio') {
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
