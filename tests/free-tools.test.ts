import { describe, expect, test } from 'bun:test';
import { createMcpApplication, handleJsonRpcRequest } from '../src/server.js';
import type { FetchLike } from '../src/connectors.js';

describe('free-tier & google workspace MCP tools', () => {
  test('registers all 9 free-tier + google workspace tools and blocks SSRF loopback URLs', async () => {
    const calls: { url: string; method: string; auth?: string }[] = [];
    const mockFetch: FetchLike = async (input, init) => {
      const headers = new Headers(init?.headers);
      calls.push({
        url: String(input),
        method: init?.method ?? 'GET',
        auth: headers.get('Authorization') ?? undefined,
      });
      return new Response(JSON.stringify({ ok: true, markdown: '# Hello' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const app = createMcpApplication({
      freeTools: {
        fetchImpl: mockFetch,
        env: {
          TAVILY_API_KEY: 'tvly-test',
          LLAMA_CLOUD_API_KEY: 'llx-test',
          GOOGLE_ACCESS_TOKEN: 'ya29-env-token',
        },
      },
    });

    const listed = app.registry.listTools().map((t) => t.name);
    for (const expected of [
      'web.jina_read',
      'docs.context7_query',
      'web.firecrawl_scrape',
      'web.tavily_search',
      'ocr.llamaparse_parse',
      'google.drive.list',
      'google.gmail.list_messages',
      'google.calendar.list_events',
      'google.sheets.append_row',
    ]) {
      expect(listed).toContain(expected);
    }

    const ssrf = await handleJsonRpcRequest(app, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'web.jina_read', arguments: { targetUrl: 'http://127.0.0.1:4510/health' } },
    });
    expect(ssrf && 'error' in ssrf).toBe(true);

    const jina = await app.registry.dispatchTool('web.jina_read', { targetUrl: 'https://example.com/docs' });
    expect((jina as { ok: boolean }).ok).toBe(true);

    await app.registry.dispatchTool('docs.context7_query', { libraryId: 'vercel/next.js', topic: 'routing' });
    await app.registry.dispatchTool('web.tavily_search', { query: 'moonwitness' });
    await app.registry.dispatchTool('ocr.llamaparse_parse', { documentUrl: 'https://example.com/invoice.pdf' });
    await app.registry.dispatchTool('google.drive.list', { pageSize: 5 });
    await app.registry.dispatchTool('google.sheets.append_row', {
      spreadsheetId: 'sheet-1',
      range: 'Sheet1!A1',
      values: ['INV-1', '100'],
    });

    expect(calls[0]?.url).toBe('https://r.jina.ai/https://example.com/docs');
    expect(calls[4]?.auth).toBe('Bearer ya29-env-token');
    expect(calls[5]?.method).toBe('POST');
  });

  test('fails closed when required Tavily, LlamaParse, or Google tokens are missing', async () => {
    const app = createMcpApplication({
      freeTools: { env: {} },
    });

    await expect(app.registry.dispatchTool('web.tavily_search', { query: 'test' })).rejects.toThrow(
      /TAVILY_API_KEY/,
    );
    await expect(
      app.registry.dispatchTool('ocr.llamaparse_parse', { documentUrl: 'https://example.com/a.pdf' }),
    ).rejects.toThrow(/LLAMA_CLOUD_API_KEY/);
    await expect(app.registry.dispatchTool('google.drive.list', {})).rejects.toThrow(/Google OAuth/);
  });
});
