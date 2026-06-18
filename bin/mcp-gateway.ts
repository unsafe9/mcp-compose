#!/usr/bin/env node

import { createGateway } from '../src/gateway.js';
import type { GatewayOptions } from '../src/gateway.js';
import type { AuthMode, LogLevel } from '../src/types.js';

interface CliArgs {
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
const port = parseInt(cliArgs.port ?? '19100', 10);
const logLevel = (cliArgs.logLevel ?? 'info') as LogLevel;

// Detect mode from arguments
const { command, url } = cliArgs;

let options: GatewayOptions;

if (command !== undefined) {
  options = { mode: 'stdio', port, command, args: cliArgs.commandArgs, logLevel };
} else if (url) {
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
