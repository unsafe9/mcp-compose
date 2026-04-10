import { execSync } from 'child_process';
import { expandPath } from './config.js';
import type { StdioServer, SupergatewayCommand } from './types.js';

/**
 * Install an npm package (if needed) and return the resolved binary path.
 * Uses npx to install, then resolves the real path so pm2 can launch
 * the binary directly without the npx wrapper process.
 */
function resolveNpxBinary(packageName: string): string {
  const binName = packageName.replace(/@.*$/, '');
  const bin = execSync(`npx -y -p ${packageName} -c "which ${binName}"`, {
    encoding: 'utf-8',
    timeout: 60_000,
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();

  if (!bin) {
    throw new Error(`Failed to resolve ${binName} binary path`);
  }

  return bin;
}

export function resolveSupergatewayBin(): string {
  return resolveNpxBinary('supergateway@latest');
}

export function resolveMcpRemoteBin(): string {
  return resolveNpxBinary('mcp-remote@latest');
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

