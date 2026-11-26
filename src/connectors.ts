import type { McpDispatchContext, McpServerRegistry } from './server-registry.js';

export type EcosystemServiceId =
  | 'mw-xv'
  | 'mw-cp'
  | 'mw-isp'
  | 'mw-corpus'
  | 'mw-echo'
  | 'mw-rid';

export const ECOSYSTEM_SERVICE_IDS: readonly EcosystemServiceId[] = [
  'mw-xv',
  'mw-cp',
  'mw-isp',
  'mw-corpus',
  'mw-echo',
  'mw-rid',
] as const;

export const DEFAULT_ECOSYSTEM_URLS: Readonly<Record<EcosystemServiceId, string>> = Object.freeze({
  'mw-xv': 'http://127.0.0.1:3001',
  'mw-cp': 'http://127.0.0.1:4440',
  'mw-isp': 'http://127.0.0.1:8091',
  'mw-corpus': 'http://127.0.0.1:4420',
  'mw-echo': 'http://127.0.0.1:4310',
  'mw-rid': 'http://127.0.0.1:4480',
});

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface EcosystemConnectorConfig {
  readonly urls: Readonly<Record<EcosystemServiceId, string>>;
  readonly timeoutMs: number;
  readonly defaultBearerToken?: string;
}

export interface EcosystemConnectorsOptions {
  readonly urls?: Partial<Readonly<Record<EcosystemServiceId, string>>>;
  readonly timeoutMs?: number;
  readonly defaultBearerToken?: string;
  readonly fetchImpl?: FetchLike;
}

export interface ConnectorRequestOptions {
  readonly method?: HttpMethod;
  readonly path: string;
  readonly query?: Readonly<Record<string, string | number | boolean>>;
  readonly body?: unknown;
  readonly bearerToken?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}

export interface ConnectorResponse<T = unknown> {
  readonly ok: boolean;
  readonly service: EcosystemServiceId;
  readonly status: number;
  readonly url: string;
  readonly durationMs: number;
  readonly data: T | null;
  readonly error?: string;
}

export class ConnectorValidationError extends Error {
  readonly code = 'CONNECTOR_VALIDATION_ERROR' as const;

  constructor(message: string) {
    super(message);
    this.name = 'ConnectorValidationError';
  }
}

const DEFAULT_TIMEOUT_MS = 10_000;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 60_000;
const ALLOWED_HTTP_METHODS: ReadonlySet<string> = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const SAFE_HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;
const FORBIDDEN_FORWARD_HEADERS: ReadonlySet<string> = new Set([
  'host',
  'authorization',
  'content-length',
  'connection',
  'transfer-encoding',
]);

function normalizeBaseUrl(rawUrl: string, service: EcosystemServiceId): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new ConnectorValidationError(`Invalid base URL configured for ${service}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ConnectorValidationError(`Base URL for ${service} must use http or https`);
  }
  return parsed.origin + parsed.pathname.replace(/\/+$/u, '');
}

export function normalizeConnectorPath(rawPath: string): string {
  if (typeof rawPath !== 'string' || rawPath.length === 0 || rawPath.length > 2048) {
    throw new ConnectorValidationError('Connector path must be a bounded non-empty string');
  }
  if (!rawPath.startsWith('/') || rawPath.startsWith('//')) {
    throw new ConnectorValidationError('Connector path must start with a single "/"');
  }
  if (/[\r\n\0\\]/u.test(rawPath)) {
    throw new ConnectorValidationError('Connector path contains forbidden characters');
  }
  if (rawPath.includes('://') || rawPath.includes('@')) {
    throw new ConnectorValidationError('Connector path must not override host or authority');
  }
  const pathOnly = rawPath.split('?')[0] ?? rawPath;
  const decoded = decodeURIComponent(pathOnly);
  if (decoded.split('/').some((segment) => segment === '..')) {
    throw new ConnectorValidationError('Connector path must not contain traversal segments ("..")');
  }
  return rawPath;
}

export function sanitizeBearerToken(rawToken: string | undefined): string | undefined {
  if (typeof rawToken !== 'string') return undefined;
  const trimmed = rawToken.trim();
  if (trimmed.length === 0) return undefined;
  const stripped = trimmed.toLowerCase().startsWith('bearer ')
    ? trimmed.slice('bearer '.length).trim()
    : trimmed;
  if (stripped.length === 0) return undefined;
  if (/[\r\n\0]/u.test(stripped)) {
    throw new ConnectorValidationError('Bearer token contains forbidden control characters');
  }
  return stripped;
}

function clampTimeoutMs(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) {
    throw new ConnectorValidationError('timeoutMs must be a finite number');
  }
  return Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, Math.trunc(value)));
}

export function loadConnectorConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): EcosystemConnectorConfig {
  const urls: Record<EcosystemServiceId, string> = {
    'mw-xv': normalizeBaseUrl(env.MW_XV_URL ?? DEFAULT_ECOSYSTEM_URLS['mw-xv'], 'mw-xv'),
    'mw-cp': normalizeBaseUrl(env.MW_CP_URL ?? DEFAULT_ECOSYSTEM_URLS['mw-cp'], 'mw-cp'),
    'mw-isp': normalizeBaseUrl(env.MW_ISP_URL ?? DEFAULT_ECOSYSTEM_URLS['mw-isp'], 'mw-isp'),
    'mw-corpus': normalizeBaseUrl(
      env.MW_CORPUS_URL ?? DEFAULT_ECOSYSTEM_URLS['mw-corpus'],
      'mw-corpus',
    ),
    'mw-echo': normalizeBaseUrl(env.MW_ECHO_URL ?? DEFAULT_ECOSYSTEM_URLS['mw-echo'], 'mw-echo'),
    'mw-rid': normalizeBaseUrl(env.MW_RID_URL ?? DEFAULT_ECOSYSTEM_URLS['mw-rid'], 'mw-rid'),
  };

  const parsedTimeout = env.ROCKSOUL_MCP_TIMEOUT_MS
    ? Number(env.ROCKSOUL_MCP_TIMEOUT_MS)
    : DEFAULT_TIMEOUT_MS;
  const timeoutMs = Number.isFinite(parsedTimeout)
    ? clampTimeoutMs(parsedTimeout, DEFAULT_TIMEOUT_MS)
    : DEFAULT_TIMEOUT_MS;
  const defaultBearerToken = sanitizeBearerToken(env.ROCKSOUL_MCP_DEFAULT_BEARER_TOKEN);

  return {
    urls,
    timeoutMs,
    ...(defaultBearerToken !== undefined ? { defaultBearerToken } : {}),
  };
}

export class EcosystemConnectors {
  private readonly urls: Readonly<Record<EcosystemServiceId, string>>;
  private readonly timeoutMs: number;
  private readonly defaultBearerToken?: string;
  private readonly fetchImpl: FetchLike;

  constructor(options: EcosystemConnectorsOptions = {}) {
    const merged: Record<EcosystemServiceId, string> = {
      'mw-xv': normalizeBaseUrl(options.urls?.['mw-xv'] ?? DEFAULT_ECOSYSTEM_URLS['mw-xv'], 'mw-xv'),
      'mw-cp': normalizeBaseUrl(options.urls?.['mw-cp'] ?? DEFAULT_ECOSYSTEM_URLS['mw-cp'], 'mw-cp'),
      'mw-isp': normalizeBaseUrl(
        options.urls?.['mw-isp'] ?? DEFAULT_ECOSYSTEM_URLS['mw-isp'],
        'mw-isp',
      ),
      'mw-corpus': normalizeBaseUrl(
        options.urls?.['mw-corpus'] ?? DEFAULT_ECOSYSTEM_URLS['mw-corpus'],
        'mw-corpus',
      ),
      'mw-echo': normalizeBaseUrl(
        options.urls?.['mw-echo'] ?? DEFAULT_ECOSYSTEM_URLS['mw-echo'],
        'mw-echo',
      ),
      'mw-rid': normalizeBaseUrl(
        options.urls?.['mw-rid'] ?? DEFAULT_ECOSYSTEM_URLS['mw-rid'],
        'mw-rid',
      ),
    };
    this.urls = Object.freeze(merged);
    this.timeoutMs = clampTimeoutMs(options.timeoutMs, DEFAULT_TIMEOUT_MS);
    this.defaultBearerToken = sanitizeBearerToken(options.defaultBearerToken);
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  getServiceUrl(service: EcosystemServiceId): string {
    return this.urls[service];
  }

  listServices(): Readonly<Record<EcosystemServiceId, string>> {
    return this.urls;
  }

  async request<T = unknown>(
    service: EcosystemServiceId,
    options: ConnectorRequestOptions,
  ): Promise<ConnectorResponse<T>> {
    const method = options.method ?? 'GET';
    if (!ALLOWED_HTTP_METHODS.has(method)) {
      throw new ConnectorValidationError(`Unsupported HTTP method "${method}"`);
    }

    const safePath = normalizeConnectorPath(options.path);
    const baseUrl = this.urls[service];
    const targetUrl = new URL(`${baseUrl}${safePath}`);

    if (options.query) {
      for (const [key, value] of Object.entries(options.query)) {
        targetUrl.searchParams.set(key, String(value));
      }
    }

    const headers = new Headers();
    headers.set('accept', 'application/json');
    headers.set('user-agent', 'mw-rocksoul-mcp/1.0.0');

    if (options.headers) {
      for (const [name, value] of Object.entries(options.headers)) {
        const lower = name.toLowerCase();
        if (FORBIDDEN_FORWARD_HEADERS.has(lower) || !SAFE_HEADER_NAME.test(lower)) {
          throw new ConnectorValidationError(`Header "${name}" is not allowed on connector request`);
        }
        if (/[\r\n\0]/u.test(value)) {
          throw new ConnectorValidationError(`Header "${name}" contains forbidden control characters`);
        }
        headers.set(lower, value);
      }
    }

    const resolvedToken = sanitizeBearerToken(options.bearerToken) ?? this.defaultBearerToken;
    if (resolvedToken !== undefined) {
      headers.set('authorization', `Bearer ${resolvedToken}`);
    }

    let serializedBody: string | undefined;
    if (options.body !== undefined && method !== 'GET') {
      headers.set('content-type', 'application/json; charset=utf-8');
      serializedBody = JSON.stringify(options.body);
    }

    const timeoutMs = clampTimeoutMs(options.timeoutMs, this.timeoutMs);
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new Error(`Connector request to ${service} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const startedAt = Date.now();
    try {
      const response = await this.fetchImpl(targetUrl.toString(), {
        method,
        headers,
        ...(serializedBody !== undefined ? { body: serializedBody } : {}),
        signal: controller.signal,
      });

      const rawText = await response.text();
      let parsed: T | null = null;
      if (rawText.length > 0) {
        const contentType = response.headers.get('content-type') ?? '';
        if (contentType.includes('application/json') || rawText.trim().startsWith('{') || rawText.trim().startsWith('[')) {
          try {
            parsed = JSON.parse(rawText) as T;
          } catch {
            parsed = { text: rawText } as T;
          }
        } else {
          parsed = { text: rawText } as T;
        }
      }

      return {
        ok: response.ok,
        service,
        status: response.status,
        url: targetUrl.toString(),
        durationMs: Math.max(0, Date.now() - startedAt),
        data: parsed,
        ...(response.ok ? {} : { error: `HTTP ${response.status} from ${service}` }),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        service,
        status: 0,
        url: targetUrl.toString(),
        durationMs: Math.max(0, Date.now() - startedAt),
        data: null,
        error: message,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  health(service: EcosystemServiceId, bearerToken?: string): Promise<ConnectorResponse> {
    return this.request(service, { method: 'GET', path: '/health', bearerToken });
  }

  async probeAllHealth(
    bearerToken?: string,
  ): Promise<Readonly<Record<EcosystemServiceId, ConnectorResponse>>> {
    const entries = await Promise.all(
      ECOSYSTEM_SERVICE_IDS.map(
        async (service) => [service, await this.health(service, bearerToken)] as const,
      ),
    );
    return Object.fromEntries(entries) as Readonly<Record<EcosystemServiceId, ConnectorResponse>>;
  }

  xvGetBoard(bearerToken?: string): Promise<ConnectorResponse> {
    return this.request('mw-xv', { method: 'GET', path: '/api/board', bearerToken });
  }

  echoGetStats(bearerToken?: string): Promise<ConnectorResponse> {
    return this.request('mw-echo', { method: 'GET', path: '/api/stats', bearerToken });
  }

  echoListObservatoryServices(bearerToken?: string): Promise<ConnectorResponse> {
    return this.request('mw-echo', {
      method: 'GET',
      path: '/api/observatory/services',
      bearerToken,
    });
  }

  ridOpenIdConfiguration(bearerToken?: string): Promise<ConnectorResponse> {
    return this.request('mw-rid', {
      method: 'GET',
      path: '/.well-known/openid-configuration',
      bearerToken,
    });
  }

  ridJwks(bearerToken?: string): Promise<ConnectorResponse> {
    return this.request('mw-rid', { method: 'GET', path: '/jwks', bearerToken });
  }

  ridMe(bearerToken?: string): Promise<ConnectorResponse> {
    return this.request('mw-rid', { method: 'GET', path: '/me', bearerToken });
  }
}

interface ServiceRequestToolInput {
  readonly method?: HttpMethod;
  readonly path: string;
  readonly query?: Readonly<Record<string, string | number | boolean>>;
  readonly body?: unknown;
}

function registerServiceRequestTool(
  registry: McpServerRegistry,
  connectors: EcosystemConnectors,
  service: EcosystemServiceId,
  toolName: string,
  description: string,
): void {
  registry.registerTool<ServiceRequestToolInput, ConnectorResponse>({
    name: toolName,
    description,
    service,
    riskTier: 'R1',
    readOnly: false,
    inputSchema: {
      type: 'object',
      required: ['path'],
      additionalProperties: false,
      properties: {
        method: {
          type: 'string',
          enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
          description: 'HTTP method (defaults to GET)',
        },
        path: {
          type: 'string',
          description: 'Relative endpoint path starting with "/"',
        },
        query: {
          type: 'object',
          description: 'Optional query string key/value parameters',
        },
        body: {
          type: 'object',
          description: 'Optional JSON request body for non-GET methods',
        },
      },
    },
    handler: async (input, context?: McpDispatchContext) =>
      connectors.request(service, {
        method: input.method ?? 'GET',
        path: input.path,
        query: input.query,
        body: input.body,
        bearerToken: context?.bearerToken,
      }),
  });
}

function registerServiceHealthTool(
  registry: McpServerRegistry,
  connectors: EcosystemConnectors,
  service: EcosystemServiceId,
  toolName: string,
): void {
  registry.registerTool<Record<string, never>, ConnectorResponse>({
    name: toolName,
    description: `Check HTTP /health status of ${service}.`,
    service,
    riskTier: 'R0',
    readOnly: true,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    handler: async (_input, context?: McpDispatchContext) =>
      connectors.health(service, context?.bearerToken),
  });
}

export function registerEcosystemTools(
  registry: McpServerRegistry,
  connectors: EcosystemConnectors,
): McpServerRegistry {
  registry.registerTool<{ readonly service?: EcosystemServiceId }, unknown>({
    name: 'ecosystem.health',
    description:
      'Probe HTTP /health endpoints across all 6 MoonWitness ecosystem services (or a single target service).',
    service: 'ecosystem',
    riskTier: 'R0',
    readOnly: true,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        service: {
          type: 'string',
          enum: ECOSYSTEM_SERVICE_IDS,
          description: 'Optional single service ID to probe',
        },
      },
    },
    handler: async (input, context?: McpDispatchContext) => {
      if (input.service) {
        return connectors.health(input.service, context?.bearerToken);
      }
      const results = await connectors.probeAllHealth(context?.bearerToken);
      const healthyCount = Object.values(results).filter((entry) => entry.ok).length;
      return {
        allHealthy: healthyCount === ECOSYSTEM_SERVICE_IDS.length,
        healthyCount,
        totalServices: ECOSYSTEM_SERVICE_IDS.length,
        services: results,
      };
    },
  });

  // mw-xv (:3001)
  registerServiceHealthTool(registry, connectors, 'mw-xv', 'mw_xv.health');
  registry.registerTool<Record<string, never>, ConnectorResponse>({
    name: 'mw_xv.board',
    description: 'Fetch project board snapshot from mw-xv (:3001 GET /api/board).',
    service: 'mw-xv',
    riskTier: 'R0',
    readOnly: true,
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    handler: async (_input, context?: McpDispatchContext) =>
      connectors.xvGetBoard(context?.bearerToken),
  });
  registerServiceRequestTool(
    registry,
    connectors,
    'mw-xv',
    'mw_xv.request',
    'Execute an authenticated HTTP request against mw-xv (:3001).',
  );

  // mw-cp (:4440)
  registerServiceHealthTool(registry, connectors, 'mw-cp', 'mw_cp.health');
  registerServiceRequestTool(
    registry,
    connectors,
    'mw-cp',
    'mw_cp.request',
    'Execute an authenticated HTTP request against mw-cp control-plane (:4440).',
  );

  // mw-isp (:8091)
  registerServiceHealthTool(registry, connectors, 'mw-isp', 'mw_isp.health');
  registerServiceRequestTool(
    registry,
    connectors,
    'mw-isp',
    'mw_isp.request',
    'Execute an authenticated HTTP request against mw-isp (:8091).',
  );

  // mw-corpus (:4420)
  registerServiceHealthTool(registry, connectors, 'mw-corpus', 'mw_corpus.health');
  registerServiceRequestTool(
    registry,
    connectors,
    'mw-corpus',
    'mw_corpus.request',
    'Execute an authenticated HTTP request against mw-corpus epistemic archive (:4420).',
  );

  // mw-echo (:4310)
  registerServiceHealthTool(registry, connectors, 'mw-echo', 'mw_echo.health');
  registry.registerTool<Record<string, never>, ConnectorResponse>({
    name: 'mw_echo.stats',
    description: 'Read operational statistics from mw-echo (:4310 GET /api/stats).',
    service: 'mw-echo',
    riskTier: 'R0',
    readOnly: true,
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    handler: async (_input, context?: McpDispatchContext) =>
      connectors.echoGetStats(context?.bearerToken),
  });
  registry.registerTool<Record<string, never>, ConnectorResponse>({
    name: 'mw_echo.observatory_services',
    description: 'List observed services from mw-echo observatory (:4310 GET /api/observatory/services).',
    service: 'mw-echo',
    riskTier: 'R0',
    readOnly: true,
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    handler: async (_input, context?: McpDispatchContext) =>
      connectors.echoListObservatoryServices(context?.bearerToken),
  });
  registerServiceRequestTool(
    registry,
    connectors,
    'mw-echo',
    'mw_echo.request',
    'Execute an authenticated HTTP request against mw-echo (:4310).',
  );

  // mw-rid (:4480)
  registerServiceHealthTool(registry, connectors, 'mw-rid', 'mw_rid.health');
  registry.registerTool<Record<string, never>, ConnectorResponse>({
    name: 'mw_rid.openid_config',
    description: 'Read OIDC discovery document from mw-rid (:4480 GET /.well-known/openid-configuration).',
    service: 'mw-rid',
    riskTier: 'R0',
    readOnly: true,
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    handler: async (_input, context?: McpDispatchContext) =>
      connectors.ridOpenIdConfiguration(context?.bearerToken),
  });
  registry.registerTool<Record<string, never>, ConnectorResponse>({
    name: 'mw_rid.jwks',
    description: 'Read JSON Web Key Set from mw-rid (:4480 GET /jwks).',
    service: 'mw-rid',
    riskTier: 'R0',
    readOnly: true,
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    handler: async (_input, context?: McpDispatchContext) =>
      connectors.ridJwks(context?.bearerToken),
  });
  registry.registerTool<Record<string, never>, ConnectorResponse>({
    name: 'mw_rid.me',
    description: 'Inspect authenticated principal profile via mw-rid (:4480 GET /me) with Bearer forwarding.',
    service: 'mw-rid',
    riskTier: 'R0',
    readOnly: true,
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    handler: async (_input, context?: McpDispatchContext) =>
      connectors.ridMe(context?.bearerToken),
  });
  registerServiceRequestTool(
    registry,
    connectors,
    'mw-rid',
    'mw_rid.request',
    'Execute an authenticated HTTP request against mw-rid (:4480).',
  );

  // Ecosystem manifest resource & diagnostics prompt
  registry.registerResource({
    uri: 'rocksoul://ecosystem/services',
    name: 'ecosystem-services',
    description: 'Configured HTTP target endpoints for MoonWitness ecosystem connectors.',
    mimeType: 'application/json',
    reader: () => JSON.stringify({ services: connectors.listServices() }, null, 2),
  });

  registry.registerPrompt({
    name: 'ecosystem.diagnostics',
    description: 'Generate a diagnostic checklist prompt for a target MoonWitness ecosystem service.',
    arguments: [{ name: 'service', description: 'Target ecosystem service ID', required: true }],
    render: ({ service }) =>
      `Inspect health, latency, and authentication posture for MoonWitness service "${service}" via MCP connectors.`,
  });

  return registry;
}
