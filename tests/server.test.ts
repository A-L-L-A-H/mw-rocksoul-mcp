import { describe, expect, it } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import {
  createMcpApplication,
  createStdioLineProcessor,
  startHttpServer,
  startStdioServer,
  type JsonRpcResponse,
} from '../src/server.js';

describe('mw-rocksoul-mcp HTTP & stdio server', () => {
  it('serves GET /health, GET /mcp/tools, and POST /mcp/rpc with Bearer forwarding to real HTTP upstream', async () => {
    const receivedAuthHeaders: string[] = [];
    const upstream = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: (req) => {
        receivedAuthHeaders.push(req.headers.get('authorization') ?? '');
        const pathname = new URL(req.url).pathname;
        return new Response(JSON.stringify({ ok: true, upstreamPath: pathname }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    const app = createMcpApplication({
      connectors: {
        urls: {
          'mw-xv': `http://127.0.0.1:${upstream.port}`,
          'mw-echo': `http://127.0.0.1:${upstream.port}`,
        },
      },
    });
    const server = startHttpServer(app, { host: '127.0.0.1', port: 0 });

    try {
      const healthRes = await fetch(`${server.url}/health`);
      expect(healthRes.status).toBe(200);
      const health = (await healthRes.json()) as {
        ok: boolean;
        service: string;
        toolsCount: number;
        connectors: string[];
      };
      expect(health.ok).toBe(true);
      expect(health.service).toBe('mw-rocksoul-mcp');
      expect(health.toolsCount).toBeGreaterThanOrEqual(19);
      expect(health.connectors).toHaveLength(6);

      const toolsRes = await fetch(`${server.url}/mcp/tools`);
      expect(toolsRes.status).toBe(200);
      const toolsBody = (await toolsRes.json()) as {
        tools: Array<{ name: string }>;
        count: number;
      };
      expect(toolsBody.count).toBe(toolsBody.tools.length);
      expect(toolsBody.tools.some((t) => t.name === 'mw_xv.board')).toBe(true);

      const initRes = await fetch(`${server.url}/mcp/rpc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      });
      expect(initRes.status).toBe(200);
      const initJson = (await initRes.json()) as {
        jsonrpc: string;
        id: number;
        result: { serverInfo: { name: string } };
      };
      expect(initJson.result.serverInfo.name).toBe('@moonwitness/rocksoul-mcp');

      const callRes = await fetch(`${server.url}/mcp/rpc`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer forwarded-secret-token',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'req-42',
          method: 'tools/call',
          params: { name: 'mw_xv.board', arguments: {} },
        }),
      });
      expect(callRes.status).toBe(200);
      const callJson = (await callRes.json()) as {
        id: string;
        result: { structuredContent: { ok: boolean; data: { upstreamPath: string } } };
      };
      expect(callJson.id).toBe('req-42');
      expect(callJson.result.structuredContent.ok).toBe(true);
      expect(callJson.result.structuredContent.data.upstreamPath).toBe('/api/board');
      expect(receivedAuthHeaders).toEqual(['Bearer forwarded-secret-token']);

      const badJsonRes = await fetch(`${server.url}/mcp/rpc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{invalid',
      });
      expect(badJsonRes.status).toBe(400);
      const badJson = (await badJsonRes.json()) as { error: { code: number } };
      expect(badJson.error.code).toBe(-32700);

      const unknownMethodRes = await fetch(`${server.url}/mcp/rpc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'unknown/method' }),
      });
      const unknownJson = (await unknownMethodRes.json()) as { error: { code: number } };
      expect(unknownJson.error.code).toBe(-32601);
    } finally {
      server.stop();
      upstream.stop(true);
    }
  });

  it('supports stdio JSON-RPC 2.0 transport including notifications, tools, resources, and prompts', async () => {
    const app = createMcpApplication({
      connectors: {
        fetchImpl: async (input) =>
          new Response(JSON.stringify({ ok: true, probed: String(input) }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      },
    });

    const processor = createStdioLineProcessor(app);
    expect(await processor('')).toBeNull();
    expect(
      await processor(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })),
    ).toBeNull();

    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: string[] = [];
    output.setEncoding('utf8');
    output.on('data', (chunk: string) => chunks.push(chunk));

    const done = startStdioServer(app, { input, output, bearerToken: 'stdio-tok' });
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'resources/read', params: { uri: 'rocksoul://ecosystem/services' } })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'prompts/get', params: { name: 'ecosystem.diagnostics', arguments: { service: 'mw-echo' } } })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'mw_echo.stats', arguments: {} } })}\n`);
    input.end();

    await done;
    const lines = chunks
      .join('')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as JsonRpcResponse);

    expect(lines).toHaveLength(4);
    expect(lines[0]).toEqual({ jsonrpc: '2.0', id: 1, result: {} });
    expect(lines[1]?.id).toBe(2);
    expect('result' in lines[1]! && Array.isArray(lines[1].result.contents)).toBe(true);
    expect(lines[2]?.id).toBe(3);
    expect(lines[3]?.id).toBe(4);
  });

  it('enforces zero @moonwitness/orm- imports via scripts/check-zero-orm-imports.mjs', async () => {
    const repoRoot = path.resolve(import.meta.dir, '..');
    const scriptPath = path.join(repoRoot, 'scripts', 'check-zero-orm-imports.mjs');

    const cleanProc = Bun.spawnSync(['node', scriptPath, '--root', repoRoot]);
    expect(cleanProc.exitCode).toBe(0);

    const tempDir = await mkdtemp(path.join(tmpdir(), 'rocksoul-mcp-orm-gate-'));
    try {
      await mkdir(path.join(tempDir, 'src'), { recursive: true });
      await writeFile(
        path.join(tempDir, 'src', 'bad.ts'),
        `import { forbidden } from '@moonwitness/orm-project';\nexport const x = forbidden;\n`,
        'utf8',
      );
      const failProc = Bun.spawnSync(['node', scriptPath, '--root', tempDir]);
      expect(failProc.exitCode).toBe(1);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
