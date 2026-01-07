# mcp-compose

MCP server orchestration tool - manages multiple MCP servers through a unified Streamable HTTP gateway.

## Quick Start

```bash
npm install
node bin/mcp-compose.js up      # Start all servers
node bin/mcp-compose.js status  # Check status
node bin/mcp-compose.js down    # Stop all servers
```

## Architecture

- **stdio servers**: Wrapped with `supergateway` and managed via `pm2`
- **remote servers (sse/http)**: Passthrough proxy
- **Config sync**: Auto-generates `~/.mcp.json` for Claude Code

```
mcp-compose up
  └── For each stdio server:
        pm2 start "npx supergateway --stdio <cmd> --outputTransport streamableHttp --port <internal-port>"
  └── Write ~/.mcp.json with Streamable HTTP URLs
```

## Project Structure

```
bin/mcp-compose.js   # CLI entry point (commander.js)
src/
  config.js          # Load/validate mcp-compose.json, port allocation
  pm2.js             # pm2 wrapper (start/stop/restart/status/logs)
  supergateway.js    # Build supergateway command for stdio servers
  sync.js            # Generate/merge ~/.mcp.json for Claude Code
  index.js           # Module exports
```

## Configuration

Config file: `mcp-compose.json` or `mcp-compose.jsonc` (searches up directory tree)

```json
{
  "settings": {
    "portBase": 19100,
    "claudeConfigPath": "~/.mcp.json"
  },
  "mcpServers": {
    "server-name": {
      "type": "stdio",           // stdio | sse | http
      "command": "uvx",          // for stdio
      "args": ["package@latest"],
      "env": { "KEY": "value" }
    },
    "remote-server": {
      "type": "sse",
      "url": "https://example.com/sse"
    }
  }
}
```

## CLI Commands

| Command | Description |
|---------|-------------|
| `up [servers...]` | Start all or specific MCP servers |
| `down [servers...]` | Stop servers |
| `restart [servers...]` | Restart servers |
| `status` | Show running servers (PID, memory, restarts) |
| `logs [server] [-f]` | View logs (optional follow mode) |
| `startup` | Enable auto-start on system boot |
| `unstartup` | Disable auto-start |

## Dependencies

- **commander** - CLI parsing
- **pm2** - Process management with auto-restart
- **http-proxy** - Proxy for remote servers
- **supergateway** (via npx) - Converts stdio MCP to Streamable HTTP

## Key Implementation Notes

- Process names prefixed with `mcp-` for filtering
- Internal ports start at 19100 (configurable via `portBase`)
- Config sync merges with existing `~/.mcp.json` (non-destructive)
- pm2 provides auto-restart (max 10 retries, 1000ms delay)
