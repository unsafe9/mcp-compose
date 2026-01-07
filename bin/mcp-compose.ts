#!/usr/bin/env node

import { Command } from 'commander';
import { loadConfig, getStdioServers, getServerNames } from '../src/config.js';
import {
  startServers,
  stopServers,
  stopAllMcpServers,
  restartServers,
  getStatus,
  streamLogs,
  setupStartup,
  saveProcessList,
  unstartup,
} from '../src/pm2.js';
import { syncToClaudeConfig, removeFromClaudeConfig } from '../src/sync.js';

const program = new Command();

function getConfigPath(cmd: Command): string | undefined {
  return cmd.parent?.opts<{ config?: string }>().config;
}

function handleError(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err);
  console.error('Error:', message);
  process.exit(1);
}

program
  .name('mcp-compose')
  .description('MCP server orchestration tool')
  .version('0.1.0')
  .option('-c, --config <path>', 'Path to config file');

program
  .command('up')
  .description('Start MCP servers')
  .argument('[servers...]', 'Specific servers to start (default: all)')
  .action(async (servers: string[], _options: unknown, cmd: Command) => {
    try {
      const config = loadConfig(getConfigPath(cmd));
      const stdioServers = getStdioServers(config);
      const filteredServers =
        servers.length > 0
          ? stdioServers.filter((s) => servers.includes(s.name))
          : stdioServers;

      if (filteredServers.length === 0 && servers.length > 0) {
        console.log(
          'No stdio servers match the filter. Remote servers are synced directly.'
        );
      }

      if (filteredServers.length > 0) {
        console.log(`Starting ${String(filteredServers.length)} stdio server(s)...`);
        const results = await startServers(filteredServers);
        for (const r of results) {
          console.log(`  ✓ ${r.name} → http://localhost:${String(r.port)}/sse`);
        }
      }

      console.log('\nSyncing to Claude Code config...');
      const syncResult = syncToClaudeConfig(config);
      console.log(`  ✓ Updated ${syncResult.path}`);
      console.log(`    Servers: ${syncResult.servers.join(', ')}`);

      console.log('\nMCP servers are running via pm2.');
      console.log('Use "mcp-compose status" to check status.');
      console.log('Use "mcp-compose logs" to view logs.');
    } catch (err) {
      handleError(err);
    }
  });

program
  .command('down')
  .description('Stop MCP servers')
  .argument('[servers...]', 'Specific servers to stop (default: all)')
  .action(async (servers: string[], _options: unknown, cmd: Command) => {
    try {
      const config = loadConfig(getConfigPath(cmd));

      if (servers.length > 0) {
        const validServers = getServerNames(config, servers);
        console.log(`Stopping ${String(validServers.length)} server(s)...`);
        await stopServers(validServers);
        for (const name of validServers) {
          console.log(`  ✓ ${name} stopped`);
        }
      } else {
        console.log('Stopping all MCP servers...');
        const count = await stopAllMcpServers();
        console.log(`  ✓ Stopped ${String(count)} server(s)`);
      }

      console.log('\nRemoving from Claude Code config...');
      const removeResult = removeFromClaudeConfig(
        config,
        servers.length > 0 ? servers : null
      );
      if (removeResult.removed.length > 0) {
        console.log(`  ✓ Removed: ${removeResult.removed.join(', ')}`);
      } else {
        console.log('  (no changes)');
      }
    } catch (err) {
      handleError(err);
    }
  });

program
  .command('restart')
  .description('Restart MCP servers')
  .argument('[servers...]', 'Specific servers to restart (default: all)')
  .action(async (servers: string[], _options: unknown, cmd: Command) => {
    try {
      const config = loadConfig(getConfigPath(cmd));
      const stdioServers = getStdioServers(config);
      const serverNames =
        servers.length > 0 ? servers : stdioServers.map((s) => s.name);

      console.log(`Restarting ${String(serverNames.length)} server(s)...`);
      await restartServers(serverNames);
      for (const name of serverNames) {
        console.log(`  ✓ ${name} restarted`);
      }
    } catch (err) {
      handleError(err);
    }
  });

program
  .command('status')
  .description('Show status of MCP servers')
  .action(async () => {
    try {
      const status = await getStatus();

      if (status.length === 0) {
        console.log('No MCP servers running.');
        return;
      }

      console.log('MCP Servers:\n');
      console.log(
        '  Name                 Status     PID      Memory     Restarts'
      );
      console.log('  ' + '-'.repeat(65));

      for (const s of status) {
        const memory = s.memory
          ? `${String(Math.round(s.memory / 1024 / 1024))}MB`
          : '-';
        const statusColor = s.status === 'online' ? '\x1b[32m' : '\x1b[31m';
        const reset = '\x1b[0m';
        console.log(
          `  ${s.name.padEnd(20)} ${statusColor}${s.status.padEnd(10)}${reset} ${String(s.pid ?? '-').padEnd(8)} ${memory.padEnd(10)} ${String(s.restarts)}`
        );
      }
    } catch (err) {
      handleError(err);
    }
  });

program
  .command('logs')
  .description('View server logs')
  .argument('[server]', 'Server name (default: all)')
  .option('-f, --follow', 'Follow log output')
  .action((server?: string) => {
    try {
      streamLogs(server);
    } catch (err) {
      handleError(err);
    }
  });

program
  .command('startup')
  .description('Enable auto-start on system boot')
  .action(async () => {
    try {
      console.log('Setting up pm2 startup...');
      await setupStartup();
      console.log('\nSaving current process list...');
      await saveProcessList();
      console.log('\n✓ Auto-start enabled. MCP servers will start on boot.');
    } catch (err) {
      handleError(err);
    }
  });

program
  .command('unstartup')
  .description('Disable auto-start on system boot')
  .action(async () => {
    try {
      console.log('Removing pm2 startup...');
      await unstartup();
      console.log('\n✓ Auto-start disabled.');
    } catch (err) {
      handleError(err);
    }
  });

program.parse();
