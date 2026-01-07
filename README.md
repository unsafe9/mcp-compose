# mcp-compose

Orchestrate multiple MCP servers through a unified Streamable HTTP gateway. Converts stdio-based MCP servers to Streamable HTTP endpoints and manages them with pm2.

## Quick Start

```bash
# Create config file (mcp-compose.json)
npx mcp-compose up       # Start servers
npx mcp-compose status   # Check status
npx mcp-compose down     # Stop servers
```

No installation required - just use `npx`.

Or install globally:

```bash
npm install -g mcp-compose
```

## Configuration

Create `mcp-compose.json` (or `mcp-compose.jsonc`) in:
- Current directory
- `~/.config/mcp-compose/`

### Config Structure

```json
{
  "settings": {
    "portBase": 19100,
    "claudeConfigPath": "~/.mcp.json"
  },
  "mcpServers": {
    "my-server": { ... }
  }
}
```

### Server Types

**stdio** - Local command wrapped with supergateway:

```json
{
  "my-server": {
    "type": "stdio",
    "command": "uvx",
    "args": ["package@latest"],
    "env": { "API_KEY": "xxx" }
  }
}
```

**sse/http** - Remote servers (passthrough):

```json
{
  "remote": {
    "type": "sse",
    "url": "https://example.com/sse"
  }
}
```

### Disabling Servers

Add `"disabled": true` to skip a server without removing its config.

## CLI Reference

```
npx mcp-compose up [servers...]      Start all or specific servers
npx mcp-compose down [servers...]    Stop servers
npx mcp-compose restart [servers...] Restart servers
npx mcp-compose status               Show running servers
npx mcp-compose logs [server] [-f]   View logs (follow with -f)
npx mcp-compose startup              Enable auto-start on boot
npx mcp-compose unstartup            Disable auto-start
```

Options:
- `-c, --config <path>` - Specify config file path

## How It Works

1. **stdio servers**: Started via pm2 using `supergateway` to expose Streamable HTTP endpoints
2. **Remote servers**: Registered directly (no local process)
3. **Config sync**: Auto-updates `~/.mcp.json` for Claude Code integration

Each stdio server gets an internal port starting from `portBase` (default 19100).

## Requirements

- Node.js 18+ (includes npx)

## License

MIT
