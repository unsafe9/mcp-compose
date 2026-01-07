import pm2 from 'pm2';
import type { ProcessDescription, StartOptions, Proc } from 'pm2';
import { spawn } from 'child_process';
import { buildSupergatewayCmdForServer } from './supergateway.js';
import type { NamedStdioServer, StartResult, ServerStatus } from './types.js';

export type ProgressCallback = (event: ProgressEvent) => void;

export interface ProgressEvent {
  type: 'starting' | 'started' | 'stopping' | 'stopped' | 'port_skipped' | 'checking_ports';
  server: string;
  port?: number;
  originalPort?: number;
  current?: number;
  total?: number;
}

const PM2_PREFIX = 'mcp-';

/**
 * Parse memory limit string (e.g., "512M", "1G") to bytes
 */
function parseMemoryLimit(limit: string | number): number | undefined {
  if (typeof limit === 'number') return limit;

  const regex = /^(\d+)([KMG])?$/i;
  const match = regex.exec(limit);
  if (!match?.[1]) return undefined;

  const value = parseInt(match[1], 10);
  const unit = (match[2] ?? '').toUpperCase();

  switch (unit) {
    case 'K': return value * 1024;
    case 'M': return value * 1024 * 1024;
    case 'G': return value * 1024 * 1024 * 1024;
    default: return value;
  }
}

// Note: pm2's types incorrectly define callbacks as (err: Error) instead of (err: Error | null)
// We use type assertions to handle this properly

function pm2Connect(): Promise<void> {
  return new Promise((resolve, reject) => {
    pm2.connect((err: Error | null) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function pm2Start(options: StartOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    pm2.start(options, ((err: Error | null) => {
      if (err) reject(err);
      else resolve();
    }) as (err: Error, proc: Proc) => void);
  });
}

function pm2Delete(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    pm2.delete(name, ((err: Error | null) => {
      if (err?.message.includes('not found') === false) {
        reject(err);
      } else {
        resolve();
      }
    }) as (err: Error, proc: Proc) => void);
  });
}

function pm2List(): Promise<ProcessDescription[]> {
  return new Promise((resolve, reject) => {
    pm2.list(((err: Error | null, list?: ProcessDescription[]) => {
      if (err) reject(err);
      else resolve(list ?? []);
    }) as (err: Error, list: ProcessDescription[]) => void);
  });
}

function pm2Restart(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    pm2.restart(name, ((err: Error | null) => {
      if (err) reject(err);
      else resolve();
    }) as (err: Error, proc: Proc) => void);
  });
}

async function withPm2<T>(fn: () => Promise<T>): Promise<T> {
  await pm2Connect();
  try {
    return await fn();
  } finally {
    pm2.disconnect();
  }
}

function execPm2Command(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('npx', ['pm2', ...args], { stdio: 'inherit' });
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`pm2 ${args.join(' ')} failed with code ${String(code)}`));
    });
  });
}

function getProcessName(serverName: string): string {
  return `${PM2_PREFIX}${serverName}`;
}

function isMcpProcess(p: ProcessDescription): p is ProcessDescription & { name: string } {
  return typeof p.name === 'string' && p.name.startsWith(PM2_PREFIX);
}

export function startServers(
  servers: NamedStdioServer[],
  onProgress?: ProgressCallback
): Promise<StartResult[]> {
  return withPm2(async () => {
    const results: StartResult[] = [];
    const total = servers.length;
    let current = 0;

    for (const serverEntry of servers) {
      current++;
      const { name, resourceLimits, ...server } = serverEntry;
      const processName = getProcessName(name);
      const cmd = buildSupergatewayCmdForServer({ ...server, resourceLimits });

      onProgress?.({
        type: 'starting',
        server: name,
        port: server.internalPort,
        current,
        total,
      });

      await pm2Delete(processName);

      const startOptions: StartOptions = {
        name: processName,
        script: cmd.script,
        args: cmd.args,
        env: server.env,
        autorestart: true,
        max_restarts: resourceLimits.maxRestarts ?? 10,
        restart_delay: resourceLimits.restartDelay ?? 1000,
      };

      // Add memory limit if specified
      if (resourceLimits.maxMemory !== undefined) {
        const maxMemory = parseMemoryLimit(resourceLimits.maxMemory);
        if (maxMemory) {
          startOptions.max_memory_restart = maxMemory;
        }
      }

      await pm2Start(startOptions);

      onProgress?.({
        type: 'started',
        server: name,
        port: server.internalPort,
        current,
        total,
      });

      results.push({ name, processName, port: server.internalPort });
    }

    return results;
  });
}

export function stopServers(
  serverNames: string[],
  onProgress?: ProgressCallback
): Promise<void> {
  return withPm2(async () => {
    const total = serverNames.length;
    let current = 0;

    for (const name of serverNames) {
      current++;
      onProgress?.({
        type: 'stopping',
        server: name,
        current,
        total,
      });

      await pm2Delete(getProcessName(name));

      onProgress?.({
        type: 'stopped',
        server: name,
        current,
        total,
      });
    }
  });
}

export function stopAllMcpServers(): Promise<number> {
  return withPm2(async () => {
    const list = await pm2List();
    const mcpProcesses = list.filter(isMcpProcess);

    for (const proc of mcpProcesses) {
      await pm2Delete(proc.name);
    }

    return mcpProcesses.length;
  });
}

export function restartServers(serverNames: string[]): Promise<void> {
  return withPm2(async () => {
    for (const name of serverNames) {
      await pm2Restart(getProcessName(name));
    }
  });
}

export function getStatus(): Promise<ServerStatus[]> {
  return withPm2(async () => {
    const list = await pm2List();
    return list.filter(isMcpProcess).map((p) => ({
      name: p.name.replace(PM2_PREFIX, ''),
      processName: p.name,
      pid: p.pid,
      status: p.pm2_env?.status ?? 'unknown',
      uptime: p.pm2_env?.pm_uptime,
      restarts: p.pm2_env?.restart_time ?? 0,
      memory: p.monit?.memory,
      cpu: p.monit?.cpu,
    }));
  });
}

export function streamLogs(serverName?: string): ReturnType<typeof spawn> {
  const args = ['pm2', 'logs'];
  if (serverName) {
    args.push(getProcessName(serverName));
  }
  return spawn('npx', args, { stdio: 'inherit' });
}

export function setupStartup(): Promise<void> {
  return execPm2Command(['startup']);
}

export function saveProcessList(): Promise<void> {
  return execPm2Command(['save']);
}

export function unstartup(): Promise<void> {
  return execPm2Command(['unstartup']);
}
