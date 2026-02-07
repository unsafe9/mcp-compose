import pm2 from 'pm2';
import type { ProcessDescription, StartOptions, Proc } from 'pm2';
import { basename } from 'path';
import { spawn, execSync } from 'child_process';
import { buildSupergatewayCmdForServer } from './supergateway.js';
import { isPortAvailable } from './config.js';
import type { NamedStdioServer, StartResult, ServerStatus } from './types.js';

export type ProgressCallback = (event: ProgressEvent) => void;

export interface ProgressEvent {
  type: 'starting' | 'started' | 'recreating' | 'recreated' | 'up_to_date' | 'stopping' | 'stopped' | 'port_skipped' | 'checking_ports';
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
  pm_exec_path?: string;
  args?: string[];
  env?: Record<string, string>;
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
 * Get a running process by name
 */
async function getRunningProcess(processName: string): Promise<ProcessDescription | null> {
  const list = await pm2List();
  return list.find((p) => p.name === processName) ?? null;
}

/**
 * Extract the port number from a running process's args (--port <number>)
 */
function extractPortFromProcess(process: ProcessDescription): number | null {
  const pm2Env = process.pm2_env as Pm2EnvWithMarker | undefined;
  if (!pm2Env) return null;

  const args = pm2Env.args ?? [];
  const portIndex = args.indexOf('--port');
  if (portIndex === -1 || portIndex + 1 >= args.length) return null;

  const portStr = args[portIndex + 1];
  if (portStr === undefined) return null;

  const port = parseInt(portStr, 10);
  return isNaN(port) ? null : port;
}

/**
 * Check if the process configuration matches the desired configuration
 */
function isProcessConfigMatch(
  process: ProcessDescription,
  script: string,
  args: string[],
  env: Record<string, string>
): boolean {
  const pm2Env = process.pm2_env as Pm2EnvWithMarker | undefined;
  if (!pm2Env) return false;

  // Check if process is online
  if (pm2Env.status !== 'online') return false;

  // Check script path (pm2 resolves to full path, so compare basenames)
  const currentScript = pm2Env.pm_exec_path ?? '';
  if (currentScript !== script && basename(currentScript) !== basename(script)) {
    return false;
  }

  // Check args (pm2 stores them as array)
  const currentArgs = pm2Env.args ?? [];
  if (currentArgs.length !== args.length) return false;
  for (let i = 0; i < args.length; i++) {
    if (currentArgs[i] !== args[i]) return false;
  }

  // Check env vars (only the ones we care about, excluding MCP_COMPOSE_MARKER)
  const currentEnv = pm2Env.env ?? {};
  for (const [key, value] of Object.entries(env)) {
    if (key === MCP_COMPOSE_MARKER) continue;
    if (currentEnv[key] !== value) return false;
  }

  return true;
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

/**
 * Recursively collect all descendant PIDs of a given PID.
 * Uses pgrep -P to find children at each level.
 */
function getDescendantPids(pid: number): number[] {
  const descendants: number[] = [];
  try {
    const output = execSync(`pgrep -P ${String(pid)}`, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!output) return descendants;

    for (const line of output.split('\n')) {
      const childPid = parseInt(line, 10);
      if (!isNaN(childPid)) {
        descendants.push(childPid);
        descendants.push(...getDescendantPids(childPid));
      }
    }
  } catch {
    // pgrep exits with 1 when no children found
  }
  return descendants;
}

/**
 * Collect all descendant PIDs from a pm2-managed process.
 * Must be called BEFORE pm2Delete so the process tree is still alive.
 */
function collectDescendantPids(proc: ProcessDescription | null): number[] {
  if (!proc?.pid) return [];
  return getDescendantPids(proc.pid);
}

/**
 * Kill specific PIDs that survived after their parent was stopped.
 * Only targets exact PIDs collected from the process tree — safe
 * against killing unrelated processes.
 */
function killSurvivorPids(pids: number[]): void {
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Process already dead
    }
  }
}

export function startServers(
  servers: NamedStdioServer[],
  prefix: string,
  portBase: number,
  onProgress?: ProgressCallback
): Promise<StartResult[]> {
  return withPm2(async () => {
    const total = servers.length;

    // Phase 1: Check which servers are up-to-date vs need (re)starting
    interface ServerState {
      server: NamedStdioServer;
      existingProcess: ProcessDescription | null;
      upToDate: boolean;
      port: number;
    }

    const serverStates: ServerState[] = [];

    for (const serverEntry of servers) {
      const { name, resourceLimits, ...server } = serverEntry;
      const processName = getProcessName(name, prefix);
      const existingProcess = await getRunningProcess(processName);

      if (existingProcess) {
        const existingPort = extractPortFromProcess(existingProcess);

        if (existingPort !== null) {
          // Compare config using the existing port (not the newly suggested one)
          const cmdForComparison = buildSupergatewayCmdForServer({
            ...server,
            internalPort: existingPort,
            resourceLimits,
          });
          const envWithMarker = {
            ...server.env,
            [MCP_COMPOSE_MARKER]: name,
          };

          if (isProcessConfigMatch(existingProcess, cmdForComparison.script, cmdForComparison.args, envWithMarker)) {
            serverStates.push({
              server: serverEntry,
              existingProcess,
              upToDate: true,
              port: existingPort,
            });
            continue;
          }
        }
      }

      serverStates.push({
        server: serverEntry,
        existingProcess,
        upToDate: false,
        port: 0, // will be allocated in phase 2
      });
    }

    // Phase 2: Allocate ports only for servers that need (re)starting
    const usedPorts = new Set(
      serverStates.filter((s) => s.upToDate).map((s) => s.port)
    );
    let nextPort = portBase;

    for (const state of serverStates) {
      if (state.upToDate) continue;

      // Find next available port, skipping ports used by up-to-date servers
      while (usedPorts.has(nextPort) || !(await isPortAvailable(nextPort))) {
        nextPort++;
        if (nextPort > 65535) {
          throw new Error('No available ports found');
        }
      }

      if (nextPort !== state.server.internalPort) {
        onProgress?.({
          type: 'port_skipped',
          server: state.server.name,
          originalPort: state.server.internalPort,
          port: nextPort,
        });
      }

      state.port = nextPort;
      usedPorts.add(nextPort);
      nextPort++;
    }

    // Phase 3: Apply changes
    const results: StartResult[] = [];
    let current = 0;

    for (const state of serverStates) {
      current++;
      const { name, resourceLimits, ...server } = state.server;
      const processName = getProcessName(name, prefix);

      if (state.upToDate) {
        onProgress?.({
          type: 'up_to_date',
          server: name,
          port: state.port,
          current,
          total,
        });
        results.push({ name, processName, port: state.port });
        continue;
      }

      const isRecreate = state.existingProcess !== null;

      onProgress?.({
        type: isRecreate ? 'recreating' : 'starting',
        server: name,
        port: state.port,
        current,
        total,
      });

      const descendantPids = collectDescendantPids(state.existingProcess);
      await pm2Delete(processName);
      killSurvivorPids(descendantPids);

      const cmd = buildSupergatewayCmdForServer({
        ...server,
        internalPort: state.port,
        resourceLimits,
      });

      const envWithMarker = {
        ...server.env,
        [MCP_COMPOSE_MARKER]: name,
      };

      const startOptions: StartOptions = {
        name: processName,
        script: cmd.script,
        args: cmd.args,
        env: envWithMarker,
        autorestart: true,
        max_restarts: resourceLimits.maxRestarts ?? 10,
        restart_delay: resourceLimits.restartDelay ?? 1000,
      };

      if (resourceLimits.maxMemory !== undefined) {
        const maxMemory = parseMemoryLimit(resourceLimits.maxMemory);
        if (maxMemory) {
          startOptions.max_memory_restart = maxMemory;
        }
      }

      await pm2Start(startOptions);

      onProgress?.({
        type: isRecreate ? 'recreated' : 'started',
        server: name,
        port: state.port,
        current,
        total,
      });

      results.push({ name, processName, port: state.port });
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
      const processName = getProcessName(name, prefix);

      onProgress?.({
        type: 'stopping',
        server: name,
        current,
        total,
      });

      const proc = await getRunningProcess(processName);
      const descendantPids = collectDescendantPids(proc);
      await pm2Delete(processName);
      killSurvivorPids(descendantPids);

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

    // Collect all descendant PIDs before deleting
    const allDescendantPids = managedProcesses.flatMap(collectDescendantPids);

    for (const proc of managedProcesses) {
      await pm2Delete(proc.name);
    }

    killSurvivorPids(allDescendantPids);

    return managedProcesses.length;
  });
}

/**
 * Stop managed processes that are not in the given server list.
 * Returns the names of stopped orphaned processes.
 */
export function stopOrphanedServers(
  activeServerNames: string[],
  prefix: string,
  onProgress?: ProgressCallback
): Promise<string[]> {
  return withPm2(async () => {
    const list = await pm2List();
    const managedProcesses = list.filter(isManagedProcess);

    const activeProcessNames = new Set(
      activeServerNames.map((name) => getProcessName(name, prefix))
    );

    const orphaned: string[] = [];
    for (const proc of managedProcesses) {
      if (!activeProcessNames.has(proc.name)) {
        const serverName = getServerNameFromProcess(proc);
        onProgress?.({
          type: 'stopping',
          server: serverName,
        });
        await pm2Delete(proc.name);
        onProgress?.({
          type: 'stopped',
          server: serverName,
        });
        orphaned.push(serverName);
      }
    }

    return orphaned;
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

export function streamLogs(
  serverName?: string,
  prefix?: string,
  options?: { follow?: boolean | undefined; err?: boolean | undefined }
): ReturnType<typeof spawn> {
  const args = ['pm2', 'logs'];
  if (serverName && prefix) {
    args.push(getProcessName(serverName, prefix));
  }
  if (!options?.follow) {
    args.push('--nostream');
  }
  if (options?.err) {
    args.push('--err');
  }
  return spawn('npx', args, { stdio: 'inherit' });
}
