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
mcp-compose up [servers...]      Start all or specific servers
mcp-compose down [servers...]    Stop servers
mcp-compose restart [servers...] Restart servers
mcp-compose status               Show running servers
mcp-compose logs [server] [-f]   View logs (follow with -f)
mcp-compose startup              Enable auto-start on boot
mcp-compose unstartup            Disable auto-start
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
