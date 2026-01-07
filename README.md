# mcp-compose

Orchestrate multiple MCP servers through a unified Streamable HTTP gateway. Converts stdio-based MCP servers to Streamable HTTP endpoints and manages them with pm2.

## Installation

No installation required - use `npx`. (RECOMMENDED)

```bash
npx -y mcp-compose status
```

You can add an alias to `~/.bashrc` or `~/.zshrc`:

```bash
alias mcp-compose='npx -y mcp-compose'
```

Or install globally:

```bash
npm install -g mcp-compose
```

## Quick Start

```bash
# Create config file (mcp-compose.json)
mcp-compose up       # Start servers
mcp-compose status   # Check status
mcp-compose down     # Stop servers
```

## Configuration

Create `mcp-compose.json` (or `mcp-compose.jsonc`) in:
- Current directory
- `~/.config/mcp-compose/`

### Full Configuration Reference

```json
{
  "settings": {
    "portBase": 19100,
    "claudeConfigPath": "~/.mcp.json",
    "logLevel": "info"
  },
  "mcpServers": {
    "my-server": { ... }
  }
}
```

### Settings

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `portBase` | number | `19100` | Starting port for stdio servers. Ports are allocated sequentially. |
| `claudeConfigPath` | string | `~/.mcp.json` | Path to Claude Code's MCP config file. Supports `~` for home directory. |
| `logLevel` | string | `"info"` | Default log level for supergateway. Options: `"debug"`, `"info"`, `"none"` |

### Server Types

#### stdio - Local Command Server

Runs a local command and wraps it with supergateway to expose as HTTP.

```json
{
  "my-server": {
    "type": "stdio",
    "command": "uvx",
    "args": ["package@latest"],
    "env": {
      "API_KEY": "xxx"
    },
    "logLevel": "info",
    "resourceLimits": {
      "maxMemory": "512M",
      "maxRestarts": 10,
      "restartDelay": 1000
    }
  }
}
```

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `type` | `"stdio"` | No | Auto-detected if `command` is present |
| `command` | string | Yes | The command to execute |
| `args` | string[] | No | Command arguments |
| `env` | object | No | Environment variables |
| `disabled` | boolean | No | Skip this server when starting |
| `logLevel` | string | No | Override log level: `"debug"`, `"info"`, `"none"` |
| `resourceLimits` | object | No | Process resource limits (see below) |

#### sse/http - Remote Server

Passthrough to remote MCP servers. No local process is started.

```json
{
  "remote-server": {
    "type": "sse",
    "url": "https://example.com/sse"
  }
}
```

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `type` | `"sse"` or `"http"` | Yes | Server type |
| `url` | string | Yes | Remote server URL |
| `disabled` | boolean | No | Skip this server |

### Resource Limits

Control pm2 process management behavior for stdio servers.

```json
{
  "resourceLimits": {
    "maxMemory": "512M",
    "maxRestarts": 10,
    "restartDelay": 1000
  }
}
```

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `maxMemory` | string or number | - | Memory limit before restart. String: `"512M"`, `"1G"`. Number: bytes. |
| `maxRestarts` | number | `10` | Maximum restart attempts before giving up |
| `restartDelay` | number | `1000` | Delay between restarts in milliseconds |

### Disabling Servers

Add `"disabled": true` to skip a server without removing its config:

```json
{
  "my-server": {
    "command": "uvx",
    "args": ["some-package"],
    "disabled": true
  }
}
```

### Example Configuration

```json
{
  "settings": {
    "portBase": 19100,
    "claudeConfigPath": "~/.mcp.json",
    "logLevel": "info"
  },
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@anthropic/mcp-server-filesystem", "/home/user/documents"],
      "resourceLimits": {
        "maxMemory": "256M"
      }
    },
    "github": {
      "command": "uvx",
      "args": ["mcp-server-github"],
      "env": {
        "GITHUB_TOKEN": "ghp_xxx"
      }
    },
    "aws-docs": {
      "type": "http",
      "url": "https://mcp.aws.example.com/mcp"
    },
    "experimental": {
      "command": "node",
      "args": ["./my-experimental-server.js"],
      "disabled": true
    }
  }
}
```

## CLI Reference

```
mcp-compose up [servers...]      Start all or specific servers
mcp-compose down [servers...]    Stop servers
mcp-compose restart [servers...] Restart servers
mcp-compose status               Show running servers
mcp-compose logs [server] [-f]   View logs (follow with -f)
```

### Options

| Option | Description |
|--------|-------------|
| `-c, --config <path>` | Specify config file path |
| `-V, --version` | Show version |
| `-h, --help` | Show help |

### Examples

```bash
# Start all servers
mcp-compose up

# Start specific servers
mcp-compose up github filesystem

# Stop specific servers
mcp-compose down github

# Stop all servers
mcp-compose down

# Use custom config file
mcp-compose -c ./custom-config.json up

# View logs for specific server
mcp-compose logs github

# Follow all logs
mcp-compose logs -f
```

## How It Works

1. **stdio servers**: Started via pm2 using `supergateway` to expose Streamable HTTP endpoints
2. **Remote servers**: Registered directly (no local process)
3. **Config sync**: Auto-updates `~/.mcp.json` for Claude Code integration
4. **Port allocation**: Automatically detects port conflicts and uses next available port

Each stdio server gets an internal port starting from `portBase` (default 19100). If a port is in use, the next available port is automatically selected.

## Features

- **Automatic port conflict detection**: Skips ports in use and allocates next available
- **Config validation**: Validates configuration structure with helpful error messages
- **Progress feedback**: Shows real-time progress during server operations
- **Resource limits**: Control memory usage and restart behavior per server
- **Process management**: Auto-restart with configurable limits via pm2
- **Non-destructive config sync**: Merges with existing Claude Code config

## Requirements

- Node.js 18+ (includes npx)

## License

MIT
