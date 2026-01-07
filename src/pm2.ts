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

// Environment variable marker to identify mcp-compose managed processes
const MCP_COMPOSE_MARKER = '__MCP_COMPOSE__';

interface Pm2EnvWithMarker {
  [MCP_COMPOSE_MARKER]?: string;
  status?: string;
  pm_uptime?: number;
  restart_time?: number;
}

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
      // Ignore "not found" errors (process already stopped)
      if (err && !err.message.includes('not found')) {
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

function getProcessName(serverName: string, prefix: string): string {
  return `${prefix}${serverName}`;
}

/**
 * Check if a process is managed by mcp-compose by looking for the marker env var
 */
function isManagedProcess(p: ProcessDescription): p is ProcessDescription & { name: string; pm2_env: Pm2EnvWithMarker } {
  const env = p.pm2_env as Pm2EnvWithMarker | undefined;
  return typeof p.name === 'string' && env?.[MCP_COMPOSE_MARKER] !== undefined;
}

/**
 * Get the server name from a managed process (stored in the marker env var)
 */
function getServerNameFromProcess(p: ProcessDescription & { name: string; pm2_env: Pm2EnvWithMarker }): string {
  return p.pm2_env[MCP_COMPOSE_MARKER] ?? p.name;
}

export function startServers(
  servers: NamedStdioServer[],
  prefix: string,
  onProgress?: ProgressCallback
): Promise<StartResult[]> {
  return withPm2(async () => {
    const results: StartResult[] = [];
    const total = servers.length;
    let current = 0;

    for (const serverEntry of servers) {
      current++;
      const { name, resourceLimits, ...server } = serverEntry;
      const processName = getProcessName(name, prefix);
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
        env: {
          ...server.env,
          [MCP_COMPOSE_MARKER]: name, // Mark as managed and store server name
        },
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
  prefix: string,
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

      await pm2Delete(getProcessName(name, prefix));

      onProgress?.({
        type: 'stopped',
        server: name,
        current,
        total,
      });
    }
  });
}

export function stopAllManagedServers(): Promise<number> {
  return withPm2(async () => {
    const list = await pm2List();
    const managedProcesses = list.filter(isManagedProcess);

    for (const proc of managedProcesses) {
      await pm2Delete(proc.name);
    }

    return managedProcesses.length;
  });
}

export function restartServers(serverNames: string[], prefix: string): Promise<void> {
  return withPm2(async () => {
    for (const name of serverNames) {
      await pm2Restart(getProcessName(name, prefix));
    }
  });
}

export function getStatus(): Promise<ServerStatus[]> {
  return withPm2(async () => {
    const list = await pm2List();
    return list.filter(isManagedProcess).map((p) => ({
      name: getServerNameFromProcess(p),
      processName: p.name,
      pid: p.pid,
      status: p.pm2_env.status ?? 'unknown',
      uptime: p.pm2_env.pm_uptime,
      restarts: p.pm2_env.restart_time ?? 0,
      memory: p.monit?.memory,
      cpu: p.monit?.cpu,
    }));
  });
}

export function streamLogs(serverName?: string, prefix?: string): ReturnType<typeof spawn> {
  const args = ['pm2', 'logs'];
  if (serverName && prefix) {
    args.push(getProcessName(serverName, prefix));
  }
  return spawn('npx', args, { stdio: 'inherit' });
}
