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

export interface GatewayLaunchOptions {
  configPath?: string | undefined;
  serverName?: string | undefined;
}

export function buildGatewayCmdForServer(
  server: StdioServer | ProxyServer,
  options: GatewayLaunchOptions = {}
): GatewayCommand {
  if (server.type === 'stdio') {
    return buildStdioGatewayCmd(server);
  }
  return buildProxyGatewayCmd(server, options);
}

function buildStdioGatewayCmd(server: StdioServer): GatewayCommand {
  const stdioArgs = server.args.map((arg) => {
    if (arg.includes('~')) {
      return expandPath(arg);
    }
    return arg;
  });

  return {
    script: resolveGatewayBin(),
    args: [
      '--command',
      server.command,
      ...stdioArgs.flatMap((arg) => ['--command-arg', arg]),
      '--port',
      String(server.internalPort),
      '--log-level',
      server.logLevel,
    ],
  };
}

function buildProxyGatewayCmd(server: ProxyServer, options: GatewayLaunchOptions): GatewayCommand {
  if (options.configPath && options.serverName) {
    return {
      script: resolveGatewayBin(),
      args: [
        '--config',
        options.configPath,
        '--server',
        options.serverName,
        '--port',
        String(server.internalPort),
      ],
    };
  }

  const args = [
    '--url',
    server.url,
    '--port',
    String(server.internalPort),
    '--transport',
    server.transport,
    '--auth-mode',
    server.authMode,
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
