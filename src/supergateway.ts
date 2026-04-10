import { execSync } from 'child_process';
import { expandPath } from './config.js';
import type { StdioServer, SupergatewayCommand } from './types.js';

/**
 * Ensure supergateway is installed and return the resolved binary path.
 * Uses npx to install if needed, then resolves the real path so pm2 can
 * launch the binary directly without the npx wrapper process.
 */
export function resolveSupergatewayBin(): string {
  const bin = execSync('npx -y -p supergateway@latest -c "which supergateway"', {
    encoding: 'utf-8',
    timeout: 60_000,
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();

  if (!bin) {
    throw new Error('Failed to resolve supergateway binary path');
  }

  return bin;
}

/**
 * Ensure mcp-remote is installed and return the resolved binary path.
 * Used for proxying remote MCP servers with OAuth token lifecycle management.
 */
export function resolveMcpRemoteBin(): string {
  const bin = execSync('npx -y -p mcp-remote@latest -c "which mcp-remote"', {
    encoding: 'utf-8',
    timeout: 60_000,
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();

  if (!bin) {
    throw new Error('Failed to resolve mcp-remote binary path');
  }

  return bin;
}

export function buildSupergatewayCmdForServer(server: StdioServer, supergatewayBin: string): SupergatewayCommand {
  const { command, args, internalPort, logLevel } = server;

  const stdioCmd = buildStdioCommand(command, args);

  return {
    script: supergatewayBin,
    args: [
      '--stdio',
      stdioCmd,
      '--outputTransport',
      'streamableHttp',
      '--port',
      String(internalPort),
      '--logLevel',
      logLevel,
      '--stateful',
    ],
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

