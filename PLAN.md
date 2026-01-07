# mcp-compose: MCP Server Orchestration Tool

## Goal
Migrate from 1mcp to a self-made tool that:
- Exposes all MCP servers as remote (SSE) endpoints for sharing across sessions
- Uses supergateway to convert stdio servers to remote
- Manages processes centrally
- **JavaScript implementation** (runnable via `npx mcp-compose`)
- **JSON config format** similar to 1mcp.json / Claude Code style
- **Auto port assignment** when port not specified
- **Auto sync** to Claude Code's `.mcp.json`

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      mcp-compose                             │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌─────────────────────────────────────────────────────────┐│
│  │                 Built-in Gateway                        ││
│  │                 http://localhost:9100                   ││
│  │                                                         ││
│  │  /arxiv/sse     → supergateway → uvx arxiv-mcp          ││
│  │  /aws-api/sse   → supergateway → uvx aws-api-mcp        ││
│  │  /chrome/sse    → supergateway → npx chrome-devtools    ││
│  │  /docker-mcp/sse→ supergateway → docker run -i image    ││
│  │                                                         ││
│  │  Remote servers (passthrough proxy):                    ││
│  │  /aws-knowledge/*  → proxy to https://...               ││
│  │  /notion/*         → proxy to https://...               ││
│  │  /atlassian/*      → proxy to https://...               ││
│  └─────────────────────────────────────────────────────────┘│
│                            ↓                                 │
│  Auto-sync to ~/.mcp.json (Claude Code config)              │
│  { "arxiv": { "url": "http://localhost:9100/arxiv/sse" } }  │
└─────────────────────────────────────────────────────────────┘
```

### Single Port Benefits
- One port to remember and configure
- Cleaner firewall rules
- Easier to share/proxy
- Path-based routing: `/:serverName/sse`

## MCP Server Types

| Type | Description | Process Management |
|------|-------------|-------------------|
| **stdio** | Any command (npx, uvx, docker, etc.) via supergateway | PID file, spawn |
| **sse/http** | Already remote, passthrough | None (config only) |

### Stdio Servers (including Docker)
Any command that speaks MCP over stdio:
```json
{
  "aws-api": {
    "type": "stdio",
    "command": "uvx",
    "args": ["awslabs.aws-api-mcp-server@latest"],
    "env": {"AWS_REGION": "ap-northeast-1"}
  },
  "docker-mcp": {
    "type": "stdio",
    "command": "docker",
    "args": ["run", "-i", "--rm", "my-mcp-image:latest"]
  }
}
```

All stdio servers get wrapped with supergateway:
```bash
npx supergateway --stdio "uvx mcp-server" --port 9100
npx supergateway --stdio "docker run -i --rm image" --port 9101
```

## Key Design Decisions

1. **JavaScript/Node.js**: Publishable to npm, run via `npx mcp-compose`
2. **JSON config**: Extends 1mcp.json format
3. **Single port gateway**: All servers on one port (9100) with path-based routing
4. **Use supergateway**: Each stdio server wrapped on internal port, gateway routes to it
5. **Use pm2 internally**: Battle-tested process management, auto-restart, logging
6. **Auto sync**: Write generated config to `~/.mcp.json` for Claude Code
7. **pm2 startup**: Cross-platform auto-start (uses launchd on macOS internally)

## How It Works

```
mcp-compose up
     │
     ├── Start gateway HTTP server on port 9100
     │
     ├── For each stdio server:
     │   └── pm2.start({
     │         name: "mcp-<server>",
     │         script: "npx",
     │         args: ["supergateway", "--stdio", "<cmd>", "--port", "<internal-port>"]
     │       })
     │   └── Gateway routes /<server>/sse → localhost:<internal-port>/sse
     │
     ├── For each remote server (sse/http):
     │   └── Gateway proxies /<server>/* → remote URL
     │
     └── Write ~/.mcp.json:
         { "arxiv": { "url": "http://localhost:9100/arxiv/sse" } }

mcp-compose down
     └── pm2.delete("mcp-*") + stop gateway

mcp-compose status
     └── Show gateway status + pm2.list() filtered by "mcp-*"

mcp-compose logs [server]
     └── pm2.logs("mcp-<server>")

mcp-compose startup
     └── pm2.startup() + pm2.save() (includes gateway)
```

### Internal Port Allocation
- Gateway: port 9100 (user-facing)
- Supergateway instances: ports 19100, 19101, 19102, ... (internal only)

## Files to Create

```
mcp-compose/
├── package.json
├── bin/
│   └── mcp-compose.js          # CLI entry point
├── src/
│   ├── index.js                # Main module
│   ├── config.js               # Config loading/validation
│   ├── gateway.js              # HTTP gateway server (routes to supergateway instances)
│   ├── pm2.js                  # pm2 wrapper (start/stop/status/logs)
│   ├── supergateway.js         # Build supergateway command
│   └── sync.js                 # Claude Code config sync
```

## Config Format (JSON, extends 1mcp.json style)

```json
{
  "settings": {
    "port": 9100,
    "internalPortBase": 19100,
    "claudeConfigPath": "~/.mcp.json"
  },
  "mcpServers": {
    "arxiv": {
      "type": "stdio",
      "command": "uvx",
      "args": ["arxiv-mcp-server@latest", "--storage-path", "~/workspace/arxiv-papers/"]
    },
    "aws-api-runson": {
      "type": "stdio",
      "command": "uvx",
      "args": ["awslabs.aws-api-mcp-server@latest"],
      "env": {
        "AWS_API_MCP_PROFILE_NAME": "runson",
        "AWS_REGION": "ap-northeast-1"
      }
    },
    "dynamodb-local": {
      "type": "stdio",
      "command": "uvx",
      "args": ["awslabs.dynamodb-mcp-server@latest"],
      "env": {
        "AWS_ENDPOINT_URL_DYNAMODB": "http://localhost:8000"
      }
    },
    "valkey-local": {
      "type": "stdio",
      "command": "uvx",
      "args": ["awslabs.valkey-mcp-server@latest"],
      "env": {
        "VALKEY_HOST": "127.0.0.1",
        "VALKEY_PORT": "6379"
      }
    },
    "docker-mcp-example": {
      "type": "stdio",
      "command": "docker",
      "args": ["run", "-i", "--rm", "-v", "~/.config:/config:ro", "ghcr.io/example/mcp-server:latest"]
    },
    "aws-knowledge": {
      "type": "http",
      "url": "https://knowledge-mcp.global.api.aws"
    },
    "atlassian": {
      "type": "sse",
      "url": "https://mcp.atlassian.com/v1/sse"
    }
  }
}
```

### Auto Sync to Claude Code
On `mcp-compose up`, generates `~/.mcp.json`:
```json
{
  "arxiv": {"type": "sse", "url": "http://localhost:9100/arxiv/sse"},
  "aws-api-runson": {"type": "sse", "url": "http://localhost:9100/aws-api-runson/sse"},
  "aws-knowledge": {"type": "sse", "url": "http://localhost:9100/aws-knowledge/sse"}
}
```
Note: Even remote servers get proxied through the gateway for unified access.

## CLI Commands

```bash
mcp-compose up [server...]      # Start all or specific servers (via pm2)
mcp-compose down [server...]    # Stop servers
mcp-compose restart [server...] # Restart servers
mcp-compose status              # Show status (pm2 list filtered)
mcp-compose logs [server] [-f]  # View logs (pm2 logs)
mcp-compose startup             # Enable auto-start on boot (pm2 startup + save)
mcp-compose unstartup           # Disable auto-start
```

## Implementation Steps

### Phase 1: Project Setup
1. Create `mcp-compose/` directory with npm package structure
2. Set up `package.json` with bin entry and dependencies
3. Create `mcp-compose.json` config from existing `1mcp.json`

### Phase 2: Gateway
1. `src/gateway.js` - HTTP server with path-based routing
2. Route `/:server/sse` → internal supergateway port
3. Route `/:server/message` → internal supergateway port
4. Proxy remote servers through gateway

### Phase 3: Process Management
1. `src/pm2.js` - pm2 programmatic API wrapper
2. `src/supergateway.js` - Build supergateway commands
3. Start gateway + all supergateway instances via pm2

### Phase 4: Claude Code Sync
1. `src/sync.js` - Generate `~/.mcp.json` on up/down
2. All servers point to gateway: `http://localhost:9100/<server>/sse`

### Phase 5: CLI
1. `bin/mcp-compose.js` - CLI with commander.js
2. Commands: up, down, restart, status, logs, startup

## Files to Create

| File | Purpose |
|------|---------|
| `mcp-compose/package.json` | npm package, deps: commander, pm2, http-proxy |
| `mcp-compose/bin/mcp-compose.js` | CLI entry point |
| `mcp-compose/src/index.js` | Main exports |
| `mcp-compose/src/config.js` | Config loading, validation |
| `mcp-compose/src/gateway.js` | HTTP gateway with path-based routing |
| `mcp-compose/src/pm2.js` | pm2 programmatic API wrapper |
| `mcp-compose/src/supergateway.js` | Build supergateway command |
| `mcp-compose/src/sync.js` | Claude Code config sync |
| `mcp-compose.json` | Server configuration |

## Dependencies (npm)

- `commander` - CLI argument parsing
- `pm2` - Process management (programmatic API)
- `http-proxy` or `http-proxy-middleware` - Proxy requests to supergateway instances
- `chalk` - Terminal colors (optional)
- `supergateway` - Called via npx, not direct dependency
