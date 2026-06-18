import { execFileSync } from 'node:child_process';

function parsePidLines(output: string): number[] {
  return output
    .split(/\r?\n/)
    .map((line) => parseInt(line.trim(), 10))
    .filter((pid) => !isNaN(pid));
}

function getPosixChildPids(pid: number): number[] {
  try {
    const output = execFileSync('pgrep', ['-P', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return parsePidLines(output);
  } catch {
    return [];
  }
}

function getWindowsChildPids(pid: number): number[] {
  try {
    const output = execFileSync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Get-CimInstance Win32_Process -Filter "ParentProcessId = ${String(pid)}" | Select-Object -ExpandProperty ProcessId`,
    ], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    return parsePidLines(output);
  } catch {
    return [];
  }
}

function getChildPids(pid: number): number[] {
  return process.platform === 'win32'
    ? getWindowsChildPids(pid)
    : getPosixChildPids(pid);
}

export function getDescendantPids(pid: number): number[] {
  const descendants: number[] = [];
  for (const childPid of getChildPids(pid)) {
    descendants.push(childPid);
    descendants.push(...getDescendantPids(childPid));
  }
  return descendants;
}

export function killPid(pid: number, signal: NodeJS.Signals = 'SIGTERM'): void {
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      return;
    }
    process.kill(pid, signal);
  } catch {
    // Process already exited or is otherwise unavailable.
  }
}

export function killProcessTree(pid: number, signal: NodeJS.Signals = 'SIGTERM'): void {
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      return;
    }
    process.kill(-pid, signal);
  } catch {
    killPid(pid, signal);
  }
}
