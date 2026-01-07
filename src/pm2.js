import pm2 from 'pm2';
import { buildSupergatewayCmdForServer } from './supergateway.js';

const PM2_PREFIX = 'mcp-';

function pm2Connect() {
  return new Promise((resolve, reject) => {
    pm2.connect((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function pm2Disconnect() {
  pm2.disconnect();
}

function pm2Start(options) {
  return new Promise((resolve, reject) => {
    pm2.start(options, (err, apps) => {
      if (err) reject(err);
      else resolve(apps);
    });
  });
}

function pm2Delete(name) {
  return new Promise((resolve, reject) => {
    pm2.delete(name, (err, proc) => {
      if (err && !err.message?.includes('not found')) {
        reject(err);
      } else {
        resolve(proc);
      }
    });
  });
}

function pm2List() {
  return new Promise((resolve, reject) => {
    pm2.list((err, list) => {
      if (err) reject(err);
      else resolve(list);
    });
  });
}

function pm2Restart(name) {
  return new Promise((resolve, reject) => {
    pm2.restart(name, (err, proc) => {
      if (err) reject(err);
      else resolve(proc);
    });
  });
}

export function getProcessName(serverName) {
  return `${PM2_PREFIX}${serverName}`;
}

export async function startServer(serverName, server) {
  await pm2Connect();
  try {
    const processName = getProcessName(serverName);
    const cmd = buildSupergatewayCmdForServer(server);

    await pm2Delete(processName);

    const options = {
      name: processName,
      script: cmd.script,
      args: cmd.args,
      env: server.env || {},
      autorestart: true,
      max_restarts: 10,
      restart_delay: 1000
    };

    await pm2Start(options);
    return { name: serverName, processName, port: server.internalPort };
  } finally {
    pm2Disconnect();
  }
}

export async function startServers(servers) {
  await pm2Connect();
  try {
    const results = [];

    for (const { name, ...server } of servers) {
      const processName = getProcessName(name);
      const cmd = buildSupergatewayCmdForServer(server);

      await pm2Delete(processName);

      const options = {
        name: processName,
        script: cmd.script,
        args: cmd.args,
        env: server.env || {},
        autorestart: true,
        max_restarts: 10,
        restart_delay: 1000
      };

      await pm2Start(options);
      results.push({ name, processName, port: server.internalPort });
    }

    return results;
  } finally {
    pm2Disconnect();
  }
}

export async function stopServer(serverName) {
  await pm2Connect();
  try {
    const processName = getProcessName(serverName);
    await pm2Delete(processName);
  } finally {
    pm2Disconnect();
  }
}

export async function stopServers(serverNames) {
  await pm2Connect();
  try {
    for (const name of serverNames) {
      const processName = getProcessName(name);
      await pm2Delete(processName);
    }
  } finally {
    pm2Disconnect();
  }
}

export async function stopAllMcpServers() {
  await pm2Connect();
  try {
    const list = await pm2List();
    const mcpProcesses = list.filter(p => p.name.startsWith(PM2_PREFIX));

    for (const proc of mcpProcesses) {
      await pm2Delete(proc.name);
    }

    return mcpProcesses.length;
  } finally {
    pm2Disconnect();
  }
}

export async function restartServer(serverName) {
  await pm2Connect();
  try {
    const processName = getProcessName(serverName);
    await pm2Restart(processName);
  } finally {
    pm2Disconnect();
  }
}

export async function restartServers(serverNames) {
  await pm2Connect();
  try {
    for (const name of serverNames) {
      const processName = getProcessName(name);
      await pm2Restart(processName);
    }
  } finally {
    pm2Disconnect();
  }
}

export async function getStatus() {
  await pm2Connect();
  try {
    const list = await pm2List();
    return list
      .filter(p => p.name.startsWith(PM2_PREFIX))
      .map(p => ({
        name: p.name.replace(PM2_PREFIX, ''),
        processName: p.name,
        pid: p.pid,
        status: p.pm2_env?.status || 'unknown',
        uptime: p.pm2_env?.pm_uptime,
        restarts: p.pm2_env?.restart_time || 0,
        memory: p.monit?.memory,
        cpu: p.monit?.cpu
      }));
  } finally {
    pm2Disconnect();
  }
}

export async function getLogs(serverName, lines = 50) {
  const processName = serverName ? getProcessName(serverName) : undefined;

  return new Promise((resolve, reject) => {
    const args = ['logs', '--nostream', '--lines', String(lines)];
    if (processName) {
      args.push(processName);
    }

    const { spawn } = require('child_process');
    const proc = spawn('npx', ['pm2', ...args], { stdio: 'inherit' });

    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`pm2 logs exited with code ${code}`));
    });
  });
}

export async function streamLogs(serverName) {
  const processName = serverName ? getProcessName(serverName) : undefined;

  const args = ['logs'];
  if (processName) {
    args.push(processName);
  }

  const { spawn } = await import('child_process');
  const proc = spawn('npx', ['pm2', ...args], { stdio: 'inherit' });

  return proc;
}

export async function setupStartup() {
  const { spawn } = await import('child_process');

  return new Promise((resolve, reject) => {
    const proc = spawn('npx', ['pm2', 'startup'], { stdio: 'inherit' });
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`pm2 startup failed with code ${code}`));
    });
  });
}

export async function saveProcessList() {
  const { spawn } = await import('child_process');

  return new Promise((resolve, reject) => {
    const proc = spawn('npx', ['pm2', 'save'], { stdio: 'inherit' });
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`pm2 save failed with code ${code}`));
    });
  });
}

export async function unstartup() {
  const { spawn } = await import('child_process');

  return new Promise((resolve, reject) => {
    const proc = spawn('npx', ['pm2', 'unstartup'], { stdio: 'inherit' });
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`pm2 unstartup failed with code ${code}`));
    });
  });
}
