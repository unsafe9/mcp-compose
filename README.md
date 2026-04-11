# mcp-compose

Run MCP servers once, share them across all Claude Code sessions.

Claude Code launches stdio MCP servers per session by default. mcp-compose converts them to persistent HTTP endpoints using a built-in gateway and manages them with [pm2](https://github.com/Unitech/pm2), so multiple sessions can connect to the same running servers.

Servers run directly on your system without containerization, preserving full access to local dependencies that some MCP servers require.

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
| `portBase` | number | `19100` | Starting port for managed servers. Ports are allocated sequentially. |
| `claudeConfigPath` | string | `~/.mcp.json` | Path to Claude Code's MCP config file. Supports `~` for home directory. |
| `logLevel` | string | `"info"` | Default log level for gateway processes. Options: `"debug"`, `"info"`, `"none"` |

### Server Types

#### stdio - Local Command Server

Runs a local command and exposes it as an HTTP endpoint via the built-in gateway.

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

Passthrough to remote MCP servers. No local process is started by default.

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
| `proxy` | boolean | No | Enable local proxy with OAuth support (see below) |
| `headers` | object | No | Custom headers to send to the remote server (proxy mode only) |
| `logLevel` | string | No | Override log level (proxy mode only) |
| `resourceLimits` | object | No | Process resource limits (proxy mode only) |

#### Remote Server with OAuth Proxy

Remote servers with `"proxy": true` are proxied through a local gateway process that handles the full OAuth 2.0 lifecycle automatically. This solves the common issue where OAuth tokens expire and break MCP connections between sessions.

```json
{
  "notion": {
    "type": "http",
    "url": "https://mcp.notion.so/mcp",
    "proxy": true
  }
}
```

When proxy is enabled:
- A local gateway process is started (managed by pm2, just like stdio servers)
- The gateway handles OAuth 2.0 (PKCE, browser-based consent, automatic token refresh)
- Tokens are cached at `~/.mcp-auth/mcp-compose/` and refreshed automatically when they expire
- The first connection opens a browser for OAuth consent; subsequent connections reuse cached tokens

You can also pass custom headers for API key authentication:

```json
{
  "my-api": {
    "type": "http",
    "url": "https://mcp.example.com/mcp",
    "proxy": true,
    "headers": {
      "Authorization": "Bearer ${API_KEY}"
    }
  }
}
```

### Resource Limits

Control pm2 process management behavior for managed servers.

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
    "notion": {
      "type": "http",
      "url": "https://mcp.notion.so/mcp",
      "proxy": true
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
mcp-compose up [servers...]      Start or update servers (only restarts changed configs)
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

1. **stdio servers**: Wrapped by a built-in gateway that bridges stdio to [MCP Streamable HTTP](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports#streamable-http), managed by pm2
2. **Remote servers**: Registered directly in Claude Code config (no local process)
3. **Remote servers with proxy**: Proxied through a local gateway with built-in OAuth 2.0 lifecycle management (PKCE, token refresh)
4. **Config sync**: Auto-updates `~/.mcp.json` for Claude Code integration
5. **Port allocation**: Automatically detects port conflicts and uses next available port

Each managed server gets an internal port starting from `portBase` (default 19100). If a port is in use, the next available port is automatically selected.

## Features

- **Zero external dependencies for transport**: Built-in MCP gateway replaces supergateway and mcp-remote
- **Built-in OAuth 2.0**: PKCE authorization, token refresh, and persistent token storage for remote servers
- **Incremental updates**: Only restarts servers with changed configurations
- **Automatic port conflict detection**: Skips ports in use and allocates next available
- **Config validation**: Validates configuration structure with helpful error messages
- **Resource limits**: Control memory usage and restart behavior per server
- **Process management**: Auto-restart with configurable limits via pm2
- **Non-destructive config sync**: Merges with existing Claude Code config

## Requirements

- Node.js 18+ (includes npx)

## License

MIT
