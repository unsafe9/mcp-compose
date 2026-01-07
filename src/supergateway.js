import { expandPath } from './config.js';

export function buildSupergatewayCmdForServer(server) {
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
      String(internalPort)
    ]
  };
}

function buildStdioCommand(command, args) {
  const expandedArgs = args.map(arg => {
    if (typeof arg === 'string' && arg.includes('~')) {
      return expandPath(arg);
    }
    return arg;
  });

  const allParts = [command, ...expandedArgs];

  return allParts
    .map(part => {
      if (/[\s"'\\]/.test(part)) {
        return `"${part.replace(/["\\]/g, '\\$&')}"`;
      }
      return part;
    })
    .join(' ');
}

export function buildSupergatewayCmdString(server) {
  const cmd = buildSupergatewayCmdForServer(server);
  return `${cmd.script} ${cmd.args.join(' ')}`;
}
