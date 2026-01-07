import { readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { resolve, dirname } from 'path';

const DEFAULT_SETTINGS = {
  portBase: 19100,
  claudeConfigPath: '~/.mcp.json'
};

const CONFIG_FILENAMES = ['mcp-compose.json', 'mcp-compose.jsonc'];

export function expandPath(p) {
  if (p.startsWith('~/')) {
    return resolve(homedir(), p.slice(2));
  }
  return resolve(p);
}

export function findConfigFile(startDir = process.cwd()) {
  let dir = startDir;
  while (dir !== dirname(dir)) {
    for (const filename of CONFIG_FILENAMES) {
      const configPath = resolve(dir, filename);
      if (existsSync(configPath)) {
        return configPath;
      }
    }
    dir = dirname(dir);
  }
  return null;
}

export function loadConfig(configPath) {
  if (!configPath) {
    configPath = findConfigFile();
  }

  if (!configPath) {
    throw new Error('No mcp-compose.json found. Create one or specify path with --config');
  }

  if (!existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }

  const content = readFileSync(configPath, 'utf-8');
  const config = JSON.parse(content);

  return normalizeConfig(config);
}

export function normalizeConfig(config) {
  const settings = { ...DEFAULT_SETTINGS, ...config.settings };
  settings.claudeConfigPath = expandPath(settings.claudeConfigPath);

  const mcpServers = {};
  let portIndex = 0;

  for (const [name, server] of Object.entries(config.mcpServers || {})) {
    if (server.disabled) {
      continue;
    }

    const normalized = normalizeServer(name, server, settings.portBase + portIndex);
    mcpServers[name] = normalized;

    if (normalized.type === 'stdio') {
      portIndex++;
    }
  }

  return {
    settings,
    mcpServers,
    configPath: config.configPath
  };
}

function normalizeServer(name, server, internalPort) {
  const type = server.type || (server.command ? 'stdio' : 'http');

  if (type === 'stdio') {
    if (!server.command) {
      throw new Error(`Server "${name}" is stdio type but missing command`);
    }

    return {
      type: 'stdio',
      command: server.command,
      args: server.args || [],
      env: server.env || {},
      internalPort
    };
  }

  if (type === 'sse' || type === 'http') {
    if (!server.url) {
      throw new Error(`Server "${name}" is ${type} type but missing url`);
    }

    return {
      type,
      url: server.url
    };
  }

  throw new Error(`Server "${name}" has unknown type: ${type}`);
}

export function getServerNames(config, filter = []) {
  const allNames = Object.keys(config.mcpServers);

  if (filter.length === 0) {
    return allNames;
  }

  for (const name of filter) {
    if (!allNames.includes(name)) {
      throw new Error(`Unknown server: ${name}. Available: ${allNames.join(', ')}`);
    }
  }

  return filter;
}

export function getStdioServers(config) {
  return Object.entries(config.mcpServers)
    .filter(([_, server]) => server.type === 'stdio')
    .map(([name, server]) => ({ name, ...server }));
}

export function getRemoteServers(config) {
  return Object.entries(config.mcpServers)
    .filter(([_, server]) => server.type === 'sse' || server.type === 'http')
    .map(([name, server]) => ({ name, ...server }));
}
