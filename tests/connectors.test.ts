import { describe, expect, it } from 'bun:test';
import {
  ConnectorValidationError,
  DEFAULT_ECOSYSTEM_URLS,
  ECOSYSTEM_SERVICE_IDS,
  EcosystemConnectors,
  loadConnectorConfig,
  normalizeConnectorPath,
  registerEcosystemTools,
  type EcosystemServiceId,
  type FetchLike,
} from '../src/connectors.js';
import { McpServerRegistry } from '../src/server-registry.js';

interface RecordedCall {
  readonly url: string;
  readonly method: string;
  readonly authorization: string | null;
  readonly body: string | null;
}

function createMockFetch(
  recorded: RecordedCall[],
  responder?: (url: string, init?: RequestInit) => Response | Promise<Response>,
): FetchLike {
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === 'string' ? init.body : null;
    recorded.push({
      url,
      method: init?.method ?? 'GET',
      authorization: headers.get('authorization'),
      body,
    });
    if (responder) {
      return responder(url, init);
    }
    return new Response(JSON.stringify({ ok: true, url }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}

describe('EcosystemConnectors', () => {
  it('configures exact default ports for all 6 MoonWitness ecosystem services', () => {
    expect(DEFAULT_ECOSYSTEM_URLS).toEqual({
      'mw-xv': 'http://127.0.0.1:3001',
      'mw-cp': 'http://127.0.0.1:4440',
      'mw-isp': 'http://127.0.0.1:8091',
      'mw-corpus': 'http://127.0.0.1:4420',
      'mw-echo': 'http://127.0.0.1:4310',
      'mw-rid': 'http://127.0.0.1:4480',
    });

    const loaded = loadConnectorConfig({
      MW_XV_URL: 'http://127.0.0.1:13001/',
      ROCKSOUL_MCP_TIMEOUT_MS: '2500',
      ROCKSOUL_MCP_DEFAULT_BEARER_TOKEN: 'Bearer env-token-abc',
    });
    expect(loaded.urls['mw-xv']).toBe('http://127.0.0.1:13001');
    expect(loaded.urls['mw-echo']).toBe('http://127.0.0.1:4310');
    expect(loaded.timeoutMs).toBe(2500);
    expect(loaded.defaultBearerToken).toBe('env-token-abc');
  });

  it('forwards Bearer tokens and probes health across all 6 services via standard fetch', async () => {
    const calls: RecordedCall[] = [];
    const connectors = new EcosystemConnectors({
      fetchImpl: createMockFetch(calls),
    });

    const summary = await connectors.probeAllHealth('rid-live-token-xyz');
    expect(Object.keys(summary).sort()).toEqual([...ECOSYSTEM_SERVICE_IDS].sort());
    expect(calls).toHaveLength(6);

    for (const service of ECOSYSTEM_SERVICE_IDS) {
      expect(summary[service].ok).toBe(true);
      expect(summary[service].status).toBe(200);
      expect(summary[service].url).toBe(`${DEFAULT_ECOSYSTEM_URLS[service]}/health`);
    }

    for (const call of calls) {
      expect(call.authorization).toBe('Bearer rid-live-token-xyz');
      expect(call.method).toBe('GET');
    }
  });

  it('supports query params, JSON POST bodies, and per-call Bearer override over default token', async () => {
    const calls: RecordedCall[] = [];
    const connectors = new EcosystemConnectors({
      defaultBearerToken: 'default-tok',
      fetchImpl: createMockFetch(calls),
    });

    const postResp = await connectors.request('mw-cp', {
      method: 'POST',
      path: '/api/services/scale',
      query: { dryRun: true, limit: 5 },
      body: { replicas: 2 },
      bearerToken: 'Bearer override-tok',
    });

    expect(postResp.ok).toBe(true);
    expect(calls[0]?.url).toBe('http://127.0.0.1:4440/api/services/scale?dryRun=true&limit=5');
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.authorization).toBe('Bearer override-tok');
    expect(calls[0]?.body).toBe('{"replicas":2}');

    await connectors.ridMe();
    expect(calls[1]?.url).toBe('http://127.0.0.1:4480/me');
    expect(calls[1]?.authorization).toBe('Bearer default-tok');
  });

  it('rejects path traversal, host override SSRF, and control-character tokens', async () => {
    expect(() => normalizeConnectorPath('/../etc/passwd')).toThrow(ConnectorValidationError);
    expect(() => normalizeConnectorPath('/%2e%2e/secret')).toThrow(ConnectorValidationError);
    expect(() => normalizeConnectorPath('http://evil.local/pwn')).toThrow(ConnectorValidationError);
    expect(() => normalizeConnectorPath('//evil.local/pwn')).toThrow(ConnectorValidationError);
    expect(() => normalizeConnectorPath('/foo@evil.local')).toThrow(ConnectorValidationError);

    const connectors = new EcosystemConnectors({
      fetchImpl: createMockFetch([]),
    });
    await expect(
      connectors.request('mw-xv', { path: '/health', bearerToken: 'bad\r\nX-Injected: 1' }),
    ).rejects.toThrow(ConnectorValidationError);
  });

  it('registers ecosystem tools on McpServerRegistry and dispatches with Bearer forwarding', async () => {
    const calls: RecordedCall[] = [];
    const connectors = new EcosystemConnectors({ fetchImpl: createMockFetch(calls) });
    const registry = registerEcosystemTools(new McpServerRegistry(), connectors);

    const toolNames = registry.listTools().map((t) => t.name);
    for (const expected of [
      'ecosystem.health',
      'mw_xv.health',
      'mw_xv.board',
      'mw_xv.request',
      'mw_cp.health',
      'mw_cp.request',
      'mw_isp.health',
      'mw_isp.request',
      'mw_corpus.health',
      'mw_corpus.request',
      'mw_echo.health',
      'mw_echo.stats',
      'mw_echo.observatory_services',
      'mw_echo.request',
      'mw_rid.health',
      'mw_rid.openid_config',
      'mw_rid.jwks',
      'mw_rid.me',
      'mw_rid.request',
    ]) {
      expect(toolNames).toContain(expected);
    }

    const res = await registry.dispatchTool<{ ok: boolean; service: EcosystemServiceId }>(
      'mw_rid.me',
      {},
      { bearerToken: 'caller-jwt-999' },
    );
    expect(res.ok).toBe(true);
    expect(res.service).toBe('mw-rid');
    expect(calls[0]?.authorization).toBe('Bearer caller-jwt-999');
  });

  it('handles upstream HTTP failures and network timeouts cleanly without throwing', async () => {
    const connectors = new EcosystemConnectors({
      timeoutMs: 100,
      fetchImpl: async () => new Response(JSON.stringify({ detail: 'denied' }), { status: 403 }),
    });
    const denied = await connectors.health('mw-isp');
    expect(denied.ok).toBe(false);
    expect(denied.status).toBe(403);
    expect(denied.error).toContain('403');

    const slowConnectors = new EcosystemConnectors({
      timeoutMs: 100,
      fetchImpl: async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(init.signal?.reason ?? new Error('aborted'));
          });
        }),
    });
    const timedOut = await slowConnectors.health('mw-corpus');
    expect(timedOut.ok).toBe(false);
    expect(timedOut.status).toBe(0);
    expect(timedOut.error).toContain('timed out');
  });
});
