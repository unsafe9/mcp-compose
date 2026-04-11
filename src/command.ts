import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { expandPath } from './config.js';
import type { StdioServer, ProxyServer, GatewayCommand } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const GATEWAY_BIN = join(__dirname, '..', 'bin', 'mcp-gateway.js');

export function resolveGatewayBin(): string {
  return GATEWAY_BIN;
}

export function buildGatewayCmdForServer(server: StdioServer | ProxyServer): GatewayCommand {
  if (server.type === 'stdio') {
    return buildStdioGatewayCmd(server);
  }
  return buildProxyGatewayCmd(server);
}

function buildStdioGatewayCmd(server: StdioServer): GatewayCommand {
  const stdioCmd = buildStdioCommand(server.command, server.args);

  return {
    script: resolveGatewayBin(),
    args: [
      '--command',
      stdioCmd,
      '--port',
      String(server.internalPort),
      '--log-level',
      server.logLevel,
    ],
  };
}

function buildProxyGatewayCmd(server: ProxyServer): GatewayCommand {
  const args = [
    '--url',
    server.url,
    '--port',
    String(server.internalPort),
    '--transport',
    server.transport,
    '--log-level',
    server.logLevel,
  ];

  if (Object.keys(server.headers).length > 0) {
    args.push('--headers', JSON.stringify(server.headers));
  }

  return {
    script: resolveGatewayBin(),
    args,
  };
}

function buildStdioCommand(command: string, args: string[]): string {
  const expandedArgs = args.map((arg) => {
    if (arg.includes('~')) {
      return expandPath(arg);
    }
    return arg;
  });

  const allParts = [command, ...expandedArgs];

  return allParts
    .map((part) => {
      if (/[\s"'\\]/.test(part)) {
        return `"${part.replace(/["\\]/g, '\\$&')}"`;
      }
      return part;
    })
    .join(' ');
}
