# mw-rocksoul-mcp

Standalone RockSoul Model Context Protocol (MCP) host and HTTP-only MoonWitness ecosystem connector server (TypeScript/Bun, default port `4530`).

## Architecture & Invariants

- **Zero ORM imports**: Strictly forbids `@moonwitness/orm-*` imports under `src/` (enforced by `node scripts/check-zero-orm-imports.mjs`).
- **Zero `any` types**: Strict TypeScript schema validation and typed connector contracts.
- **Dual transport**: Supports both HTTP (`GET /health`, `GET /mcp/tools`, `POST /mcp/rpc`) and stdio newline-delimited JSON-RPC 2.0 (`--stdio` or `ROCKSOUL_MCP_TRANSPORT=stdio`).
- **HTTP-only ecosystem connectors**: Uses standard `fetch` with Bearer token forwarding and SSRF-safe relative path validation across:
  - `mw-xv` (`http://127.0.0.1:3001`, `MW_XV_URL`)
  - `mw-cp` (`http://127.0.0.1:4440`, `MW_CP_URL`)
  - `mw-isp` (`http://127.0.0.1:8091`, `MW_ISP_URL`)
  - `mw-corpus` (`http://127.0.0.1:4420`, `MW_CORPUS_URL`)
  - `mw-echo` (`http://127.0.0.1:4310`, `MW_ECHO_URL`)
  - `mw-rid` (`http://127.0.0.1:4480`, `MW_RID_URL`)

## Commands

```bash
bun run start          # Start HTTP server on :4530
bun run start:stdio    # Start stdio JSON-RPC 2.0 server
bun test               # Run unit & integration test suite
node scripts/check-zero-orm-imports.mjs
```

## HTTP Endpoints

- `GET /health` — Service health, transport mode, registered tools/resources/prompts counts, and configured connector targets.
- `GET /mcp/tools` — Lists registered MCP tools and JSON schemas.
- `POST /mcp/rpc` — JSON-RPC 2.0 MCP endpoint (`initialize`, `ping`, `tools/list`, `tools/call`, `resources/list`, `resources/read`, `prompts/list`, `prompts/get`). Forwards incoming `Authorization: Bearer <token>` headers to downstream ecosystem connectors.
