# CLAUDE.md

MCP server orchestration tool - manages multiple MCP servers through a unified Streamable HTTP gateway.

## Project Structure

```
bin/mcp-compose.ts   # CLI entry point (commander.js)
src/
  config.ts          # Config loading, validation, port allocation
  pm2.ts             # pm2 wrapper (start/stop/restart/status/logs)
  supergateway.ts    # Build supergateway command for stdio servers
  sync.ts            # Generate/merge ~/.mcp.json for Claude Code
  validation.ts      # JSON config validation
  types.ts           # TypeScript type definitions
```

## Key Patterns

- Process names prefixed with `mcp-` for pm2 filtering
- Ports start at 19100, auto-skip if in use
- Config sync merges with existing `~/.mcp.json` (non-destructive)
- stdio servers wrapped via `npx supergateway --outputTransport streamableHttp`

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
