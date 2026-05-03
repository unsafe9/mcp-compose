#!/usr/bin/env node

import { createGateway } from '../src/gateway.js';
import type { GatewayOptions } from '../src/gateway.js';
import type { AuthMode, LogLevel } from '../src/types.js';

function getArg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= process.argv.length) return undefined;
  return process.argv[idx + 1];
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

const port = parseInt(getArg('port') ?? '19100', 10);
const logLevel = (getArg('log-level') ?? 'info') as LogLevel;

// Detect mode from arguments
const command = getArg('command');
const url = getArg('url');

let options: GatewayOptions;

if (command) {
  options = { mode: 'stdio', port, command, logLevel };
} else if (url) {
  const transport = (getArg('transport') ?? 'http') as 'http' | 'sse';
  const headers = parseHeaders(getArg('headers'));
  const rawAuthMode = getArg('auth-mode') ?? 'managed';
  if (rawAuthMode !== 'managed' && rawAuthMode !== 'passthrough') {
    process.stderr.write(`--auth-mode must be "managed" or "passthrough", got "${rawAuthMode}"\n`);
    process.exit(1);
  }
  const authMode: AuthMode = rawAuthMode;
  options = { mode: 'proxy', port, url, transport, headers, authMode, logLevel };
} else {
  process.stderr.write(
    'Usage:\n' +
    '  mcp-gateway --command <cmd> --port <port> [--log-level debug|info|none]\n' +
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
