import type { RawConfig, LogLevel } from './types.js';

export interface ValidationError {
  path: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

const VALID_LOG_LEVELS: LogLevel[] = ['debug', 'info', 'none'];
const VALID_SERVER_TYPES = ['stdio', 'sse', 'http'] as const;

function addError(errors: ValidationError[], path: string, message: string): void {
  errors.push({ path, message });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateSettings(
  settings: unknown,
  errors: ValidationError[]
): void {
  if (settings === undefined) return;

  if (!isObject(settings)) {
    addError(errors, 'settings', 'must be an object');
    return;
  }

  if ('portBase' in settings) {
    const portBase = settings['portBase'];
    if (typeof portBase !== 'number') {
      addError(errors, 'settings.portBase', 'must be a number');
    } else if (portBase < 1 || portBase > 65535) {
      addError(errors, 'settings.portBase', 'must be between 1 and 65535');
    }
  }

  if ('claudeConfigPath' in settings) {
    if (typeof settings['claudeConfigPath'] !== 'string') {
      addError(errors, 'settings.claudeConfigPath', 'must be a string');
    }
  }

  if ('logLevel' in settings) {
    if (!VALID_LOG_LEVELS.includes(settings['logLevel'] as LogLevel)) {
      addError(
        errors,
        'settings.logLevel',
        `must be one of: ${VALID_LOG_LEVELS.join(', ')}`
      );
    }
  }
}

function validateResourceLimits(
  limits: unknown,
  path: string,
  errors: ValidationError[]
): void {
  if (!isObject(limits)) {
    addError(errors, path, 'must be an object');
    return;
  }

  if ('maxMemory' in limits) {
    const mem = limits['maxMemory'];
    if (typeof mem !== 'string' && typeof mem !== 'number') {
      addError(errors, `${path}.maxMemory`, 'must be a string (e.g., "512M") or number (bytes)');
    } else if (typeof mem === 'string' && !/^\d+[KMG]?$/i.test(mem)) {
      addError(errors, `${path}.maxMemory`, 'invalid format, use number or string like "512M", "1G"');
    }
  }

  if ('maxRestarts' in limits) {
    const maxRestarts = limits['maxRestarts'];
    if (typeof maxRestarts !== 'number' || maxRestarts < 0) {
      addError(errors, `${path}.maxRestarts`, 'must be a non-negative number');
    }
  }

  if ('restartDelay' in limits) {
    const restartDelay = limits['restartDelay'];
    if (typeof restartDelay !== 'number' || restartDelay < 0) {
      addError(errors, `${path}.restartDelay`, 'must be a non-negative number (milliseconds)');
    }
  }
}

function validateStdioServer(
  server: Record<string, unknown>,
  path: string,
  errors: ValidationError[]
): void {
  const command = server['command'];
  if (!('command' in server) || typeof command !== 'string') {
    addError(errors, `${path}.command`, 'is required and must be a string');
  } else if (command.trim() === '') {
    addError(errors, `${path}.command`, 'cannot be empty');
  }

  if ('args' in server) {
    const args = server['args'];
    if (!Array.isArray(args)) {
      addError(errors, `${path}.args`, 'must be an array');
    } else {
      for (let i = 0; i < args.length; i++) {
        if (typeof args[i] !== 'string') {
          addError(errors, `${path}.args[${String(i)}]`, 'must be a string');
        }
      }
    }
  }

  if ('env' in server) {
    const env = server['env'];
    if (!isObject(env)) {
      addError(errors, `${path}.env`, 'must be an object');
    } else {
      for (const [key, value] of Object.entries(env)) {
        if (typeof value !== 'string') {
          addError(errors, `${path}.env.${key}`, 'must be a string');
        }
      }
    }
  }

  if ('logLevel' in server) {
    if (!VALID_LOG_LEVELS.includes(server['logLevel'] as LogLevel)) {
      addError(
        errors,
        `${path}.logLevel`,
        `must be one of: ${VALID_LOG_LEVELS.join(', ')}`
      );
    }
  }

  if ('resourceLimits' in server) {
    validateResourceLimits(server['resourceLimits'], `${path}.resourceLimits`, errors);
  }
}

function validateRemoteServer(
  server: Record<string, unknown>,
  path: string,
  errors: ValidationError[]
): void {
  const url = server['url'];
  if (!('url' in server) || typeof url !== 'string') {
    addError(errors, `${path}.url`, 'is required and must be a string');
  } else {
    try {
      new URL(url);
    } catch {
      addError(errors, `${path}.url`, 'must be a valid URL');
    }
  }
}

function validateServer(
  name: string,
  server: unknown,
  errors: ValidationError[]
): void {
  const path = `mcpServers.${name}`;

  if (!isObject(server)) {
    addError(errors, path, 'must be an object');
    return;
  }

  // Validate disabled field
  if ('disabled' in server && typeof server['disabled'] !== 'boolean') {
    addError(errors, `${path}.disabled`, 'must be a boolean');
  }

  // Determine type
  const explicitType = server['type'] as string | undefined;
  const inferredType = 'command' in server ? 'stdio' : 'http';
  const type = explicitType ?? inferredType;

  if (explicitType !== undefined && !VALID_SERVER_TYPES.includes(explicitType as typeof VALID_SERVER_TYPES[number])) {
    addError(
      errors,
      `${path}.type`,
      `must be one of: ${VALID_SERVER_TYPES.join(', ')}`
    );
    return;
  }

  if (type === 'stdio') {
    validateStdioServer(server, path, errors);
  } else {
    validateRemoteServer(server, path, errors);
  }
}

function validateMcpServers(
  mcpServers: unknown,
  errors: ValidationError[]
): void {
  if (mcpServers === undefined) return;

  if (!isObject(mcpServers)) {
    addError(errors, 'mcpServers', 'must be an object');
    return;
  }

  if (Object.keys(mcpServers).length === 0) {
    addError(errors, 'mcpServers', 'must contain at least one server');
    return;
  }

  for (const [name, server] of Object.entries(mcpServers)) {
    // Validate server name
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      addError(
        errors,
        `mcpServers.${name}`,
        'server name must contain only alphanumeric characters, hyphens, and underscores'
      );
    }
    validateServer(name, server, errors);
  }
}

export function validateConfig(config: unknown): ValidationResult {
  const errors: ValidationError[] = [];

  if (!isObject(config)) {
    return {
      valid: false,
      errors: [{ path: '', message: 'config must be an object' }],
    };
  }

  // Check for unknown top-level keys
  const knownKeys = ['settings', 'mcpServers', 'configPath'];
  for (const key of Object.keys(config)) {
    if (!knownKeys.includes(key)) {
      addError(errors, key, `unknown configuration key "${key}"`);
    }
  }

  validateSettings(config['settings'], errors);
  validateMcpServers(config['mcpServers'], errors);

  return {
    valid: errors.length === 0,
    errors,
  };
}

export function formatValidationErrors(errors: ValidationError[]): string {
  return errors
    .map((e) => `  - ${e.path ? `${e.path}: ` : ''}${e.message}`)
    .join('\n');
}

export function assertValidConfig(config: unknown): asserts config is RawConfig {
  const result = validateConfig(config);
  if (!result.valid) {
    throw new Error(
      `Invalid configuration:\n${formatValidationErrors(result.errors)}`
    );
  }
}
