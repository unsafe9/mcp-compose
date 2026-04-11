# CLAUDE.md

MCP server orchestration tool - manages multiple MCP servers through a unified Streamable HTTP gateway.

## Project Structure

```
bin/mcp-compose.ts   # CLI entry point (commander.js)
bin/mcp-gateway.ts   # Gateway process entry point (managed by pm2)
src/
  command.ts         # Build gateway CLI commands for pm2
  config.ts          # Config loading, validation, port allocation
  gateway.ts         # HTTP server: stdio↔HTTP bridge, proxy with OAuth
  oauth.ts           # OAuth 2.0 client (PKCE, discovery, token management)
  pm2.ts             # pm2 wrapper (start/stop/restart/status/logs)
  sync.ts            # Generate/merge ~/.mcp.json for Claude Code
  validation.ts      # JSON config validation
  types.ts           # TypeScript type definitions
```

## Key Patterns

- Process names prefixed with `mcp-compose-` (configurable via `settings.processPrefix`)
- Managed processes identified by `__MCP_COMPOSE__` env var (stores server name)
- Ports start at 19100, auto-skip if in use
- Config sync merges with existing `~/.mcp.json` (non-destructive)
- stdio servers bridged to Streamable HTTP via built-in gateway
- proxy servers connect directly to remote HTTP/SSE with OAuth lifecycle

## Commands

```bash
npm run build        # Compile TypeScript
npm run lint         # ESLint check
npm run typecheck    # Type check only
```

## Development Guide

After making changes, run:
```bash
npm run lint:fix && npm run build && npm run lint
```

## Release

1. Bump npm version
2. Create github release
3. Github action will trigger npm publish
