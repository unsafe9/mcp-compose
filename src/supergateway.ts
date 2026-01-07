import { expandPath } from './config.js';
import type { StdioServer, SupergatewayCommand } from './types.js';

export function buildSupergatewayCmdForServer(server: StdioServer): SupergatewayCommand {
  const { command, args, internalPort } = server;

  const stdioCmd = buildStdioCommand(command, args);

  return {
    script: 'npx',
    args: [
      '-y',
      'supergateway@latest',
      '--stdio',
      stdioCmd,
      '--port',
      String(internalPort),
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

