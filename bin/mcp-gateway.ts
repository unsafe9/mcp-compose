#!/usr/bin/env node

import { createGateway } from '../src/gateway.js';
import type { GatewayOptions } from '../src/gateway.js';
import { loadConfig } from '../src/config.js';
import type { AuthMode, LogLevel } from '../src/types.js';

interface CliArgs {
  configPath?: string;
  serverName?: string;
  command?: string;
  commandArgs: string[];
  url?: string;
  transport?: string;
  headers?: string;
  authMode?: string;
  port?: string;
  logLevel?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const parsed: CliArgs = { commandArgs: [] };

  for (let i = 0; i < argv.length; i++) {
    const name = argv[i];
    if (!name?.startsWith('--')) continue;

    const value = argv[i + 1];
    if (value === undefined) break;

    switch (name) {
      case '--config':
        parsed.configPath = value;
        break;
      case '--server':
        parsed.serverName = value;
        break;
      case '--command':
        parsed.command = value;
        break;
      case '--command-arg':
        parsed.commandArgs.push(value);
        break;
      case '--url':
        parsed.url = value;
        break;
      case '--transport':
        parsed.transport = value;
        break;
      case '--headers':
        parsed.headers = value;
        break;
      case '--auth-mode':
        parsed.authMode = value;
        break;
      case '--port':
        parsed.port = value;
        break;
      case '--log-level':
        parsed.logLevel = value;
        break;
      default:
        break;
    }

    i++;
  }

  return parsed;
}

function parseHeaders(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Invalid --headers JSON: ${msg}\n`);
    process.exit(1);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    process.stderr.write('--headers must be a JSON object of string values\n');
    process.exit(1);
  }
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v !== 'string') {
      process.stderr.write(`--headers value for "${k}" must be a string\n`);
      process.exit(1);
    }
    result[k] = v;
  }
  return result;
}

const cliArgs = parseArgs(process.argv.slice(2));

function parsePort(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  return parseInt(raw, 10);
}

let options: GatewayOptions;

if (cliArgs.configPath || cliArgs.serverName) {
  if (!cliArgs.configPath || !cliArgs.serverName) {
    process.stderr.write('--config and --server must be provided together\n');
    process.exit(1);
  }

  const config = loadConfig(cliArgs.configPath);
  const server = config.mcpServers[cliArgs.serverName];
  if (!server) {
    process.stderr.write(`Unknown server "${cliArgs.serverName}" in ${cliArgs.configPath}\n`);
    process.exit(1);
  }

  if (server.type !== 'proxy') {
    process.stderr.write(`--server "${cliArgs.serverName}" must select a proxy server\n`);
    process.exit(1);
  }

  options = {
    mode: 'proxy',
    port: parsePort(cliArgs.port, server.internalPort),
    url: server.url,
    transport: server.transport,
    headers: server.headers,
    authMode: server.authMode,
    logLevel: server.logLevel,
  };
} else if (cliArgs.command !== undefined) {
  const port = parsePort(cliArgs.port, 19100);
  const logLevel = (cliArgs.logLevel ?? 'info') as LogLevel;
  const command = cliArgs.command;
  options = { mode: 'stdio', port, command, args: cliArgs.commandArgs, logLevel };
} else if (cliArgs.url) {
  const port = parsePort(cliArgs.port, 19100);
  const logLevel = (cliArgs.logLevel ?? 'info') as LogLevel;
  const url = cliArgs.url;
  const transport = (cliArgs.transport ?? 'http') as 'http' | 'sse';
  const headers = parseHeaders(cliArgs.headers);
  const rawAuthMode = cliArgs.authMode ?? 'managed';
  if (rawAuthMode !== 'managed' && rawAuthMode !== 'passthrough') {
    process.stderr.write(`--auth-mode must be "managed" or "passthrough", got "${rawAuthMode}"\n`);
    process.exit(1);
  }
  const authMode: AuthMode = rawAuthMode;
  options = { mode: 'proxy', port, url, transport, headers, authMode, logLevel };
} else {
  process.stderr.write(
    'Usage:\n' +
    '  mcp-gateway --command <cmd> [--command-arg <arg> ...] --port <port> [--log-level debug|info|none]\n' +
    '  mcp-gateway --config <path> --server <name> [--port <port>]\n' +
    '  mcp-gateway --url <url> --port <port> [--transport http|sse] [--headers \'{"k":"v"}\'] [--auth-mode managed|passthrough] [--log-level debug|info|none]\n'
  );
  process.exit(1);
}

const gateway = createGateway(options);

gateway.start().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`Failed to start gateway: ${msg}\n`);
  process.exit(1);
});

function shutdown(): void {
  gateway.stop().then(
    () => { process.exit(0); },
    () => { process.exit(1); },
  );
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
