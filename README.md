# mw-rocksoul-mcp — HTTP-only MCP host and MoonWitness ecosystem connector server.

**Repository:** [`A-L-L-A-H/mw-rocksoul-mcp`](https://github.com/A-L-L-A-H/mw-rocksoul-mcp) · **Stack:** TypeScript · Bun

## What it does

Exposes MCP tools, resources, and prompts over HTTP or stdio with strict schemas, zero ORM imports, and no any types.

## Quick start

```bash
bun install
bun run start
bun run start:stdio
```

## Verify

```bash
bun run check:zero-orm
bun run typecheck
bun test
```

## Configuration

- **Port:** 4530
- **Key configuration:** ROCKSOUL_MCP_PORT · ROCKSOUL_MCP_TRANSPORT

## Notes

Bearer tokens from callers are forwarded to configured ecosystem connectors.
