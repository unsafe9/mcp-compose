#!/usr/bin/env node

import { createGateway } from '../src/gateway.js';
import type { GatewayOptions } from '../src/gateway.js';
import type { LogLevel } from '../src/types.js';

function getArg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= process.argv.length) return undefined;
  return process.argv[idx + 1];
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
  const headersStr = getArg('headers');
  const headers = headersStr ? JSON.parse(headersStr) as Record<string, string> : {};
  options = { mode: 'proxy', port, url, transport, headers, logLevel };
} else {
  process.stderr.write(
    'Usage:\n' +
    '  mcp-gateway --command <cmd> --port <port> [--log-level debug|info|none]\n' +
    '  mcp-gateway --url <url> --port <port> [--transport http|sse] [--headers \'{"k":"v"}\'] [--log-level debug|info|none]\n'
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
