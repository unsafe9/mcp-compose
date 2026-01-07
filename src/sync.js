import { readFileSync, writeFileSync, existsSync } from 'fs';

export function generateClaudeConfig(config) {
  const { mcpServers } = config;
  const claudeConfig = {};

  for (const [name, server] of Object.entries(mcpServers)) {
    if (server.type === 'stdio') {
      claudeConfig[name] = {
        type: 'sse',
        url: `http://localhost:${server.internalPort}/sse`
      };
    } else {
      claudeConfig[name] = {
        type: server.type,
        url: server.url
      };
    }
  }

  return claudeConfig;
}

export function syncToClaudeConfig(config) {
  const { settings } = config;
  const claudeConfigPath = settings.claudeConfigPath;

  let existingConfig = {};
  if (existsSync(claudeConfigPath)) {
    try {
      const content = readFileSync(claudeConfigPath, 'utf-8');
      existingConfig = JSON.parse(content);
    } catch {
      existingConfig = {};
    }
  }

  const newServers = generateClaudeConfig(config);

  const mergedConfig = { ...existingConfig };
  mergedConfig.mcpServers = { ...existingConfig.mcpServers };
  for (const [name, serverConfig] of Object.entries(newServers)) {
    mergedConfig.mcpServers[name] = serverConfig;
  }

  writeFileSync(claudeConfigPath, JSON.stringify(mergedConfig, null, 2) + '\n');

  return {
    path: claudeConfigPath,
    servers: Object.keys(newServers),
    merged: Object.keys(existingConfig.mcpServers || {}).length > 0
  };
}

export function removeFromClaudeConfig(config, serverNames = null) {
  const { settings, mcpServers } = config;
  const claudeConfigPath = settings.claudeConfigPath;

  if (!existsSync(claudeConfigPath)) {
    return { path: claudeConfigPath, removed: [] };
  }

  let existingConfig;
  try {
    const content = readFileSync(claudeConfigPath, 'utf-8');
    existingConfig = JSON.parse(content);
  } catch {
    return { path: claudeConfigPath, removed: [] };
  }

  if (!existingConfig.mcpServers) {
    return { path: claudeConfigPath, removed: [] };
  }

  const toRemove = serverNames || Object.keys(mcpServers);
  const removed = [];

  for (const name of toRemove) {
    if (existingConfig.mcpServers[name]) {
      delete existingConfig.mcpServers[name];
      removed.push(name);
    }
  }

  writeFileSync(claudeConfigPath, JSON.stringify(existingConfig, null, 2) + '\n');

  return {
    path: claudeConfigPath,
    removed
  };
}
