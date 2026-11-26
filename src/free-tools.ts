import { ConnectorValidationError, sanitizeBearerToken, type FetchLike } from './connectors.js';
import type { McpDispatchContext, McpServerRegistry } from './server-registry.js';

export interface FreeTierToolsOptions {
  readonly fetchImpl?: FetchLike;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly allowLoopbackUrlsInTests?: boolean;
  readonly jinaBaseUrl?: string;
  readonly context7BaseUrl?: string;
  readonly firecrawlBaseUrl?: string;
  readonly tavilyBaseUrl?: string;
  readonly llamaParseBaseUrl?: string;
  readonly googleDriveBaseUrl?: string;
  readonly gmailBaseUrl?: string;
  readonly googleCalendarBaseUrl?: string;
  readonly googleSheetsBaseUrl?: string;
}

const DEFAULT_TIMEOUT_MS = 15_000;

const PRIVATE_HOST_PATTERNS: readonly RegExp[] = [
  /^localhost$/iu,
  /^127\./u,
  /^10\./u,
  /^192\.168\./u,
  /^172\.(1[6-9]|2\d|3[0-1])\./u,
  /^169\.254\./u,
  /^0\.0\.0\.0$/u,
  /^\[?::1\]?$/u,
];

function validateExternalTargetUrl(rawUrl: string, allowLoopback: boolean): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new ConnectorValidationError('targetUrl must be a valid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ConnectorValidationError('targetUrl must use http or https');
  }
  if (!allowLoopback && PRIVATE_HOST_PATTERNS.some((re) => re.test(parsed.hostname))) {
    throw new ConnectorValidationError(`targetUrl host "${parsed.hostname}" is blocked (private/loopback)`);
  }
  return parsed;
}

function readEnvSecret(
  env: Readonly<Record<string, string | undefined>>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const val = env[key]?.trim();
    if (val) return val;
  }
  return undefined;
}

async function fetchJsonOrText(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit = {},
): Promise<{ readonly ok: boolean; readonly status: number; readonly data: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    const rawText = await response.text();
    let data: unknown = rawText;
    try {
      data = rawText.length > 0 ? (JSON.parse(rawText) as unknown) : null;
    } catch {
      data = rawText;
    }
    return { ok: response.ok, status: response.status, data };
  } finally {
    clearTimeout(timer);
  }
}

function resolveGoogleBearer(
  input: Readonly<Record<string, unknown>>,
  context: McpDispatchContext | undefined,
  env: Readonly<Record<string, string | undefined>>,
): string {
  const rawArg = typeof input.accessToken === 'string' ? input.accessToken : undefined;
  const token =
    sanitizeBearerToken(rawArg) ??
    sanitizeBearerToken(context?.bearerToken) ??
    sanitizeBearerToken(readEnvSecret(env, ['GOOGLE_ACCESS_TOKEN', 'GOOGLE_OAUTH_TOKEN']));
  if (!token) {
    throw new ConnectorValidationError(
      'Google OAuth access token required (pass Bearer header, accessToken, or GOOGLE_ACCESS_TOKEN)',
    );
  }
  return token;
}

export function registerFreeTierTools(
  registry: McpServerRegistry,
  options: FreeTierToolsOptions = {},
): void {
  const env = options.env ?? process.env;
  const fetchImpl: FetchLike = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const allowLoopback = options.allowLoopbackUrlsInTests === true;

  const jinaBase = (options.jinaBaseUrl ?? 'https://r.jina.ai').replace(/\/+$/u, '');
  const context7Base = (options.context7BaseUrl ?? 'https://context7.com/api/v1').replace(/\/+$/u, '');
  const firecrawlBase = (options.firecrawlBaseUrl ?? 'https://api.firecrawl.dev/v1').replace(/\/+$/u, '');
  const tavilyBase = (options.tavilyBaseUrl ?? 'https://api.tavily.com').replace(/\/+$/u, '');
  const llamaParseBase = (options.llamaParseBaseUrl ?? 'https://api.cloud.llamaindex.ai/api/parsing').replace(
    /\/+$/u,
    '',
  );
  const driveBase = (options.googleDriveBaseUrl ?? 'https://www.googleapis.com/drive/v3').replace(/\/+$/u, '');
  const gmailBase = (options.gmailBaseUrl ?? 'https://gmail.googleapis.com/gmail/v1').replace(/\/+$/u, '');
  const calendarBase = (options.googleCalendarBaseUrl ?? 'https://www.googleapis.com/calendar/v3').replace(
    /\/+$/u,
    '',
  );
  const sheetsBase = (options.googleSheetsBaseUrl ?? 'https://sheets.googleapis.com/v4').replace(/\/+$/u, '');

  registry.registerTool(
    {
      name: 'web.jina_read',
      description: 'Fetch a public web page as clean LLM-ready Markdown via keyless Jina Reader (r.jina.ai)',
      service: 'free-web',
      riskTier: 'R0',
      readOnly: true,
      inputSchema: {
        type: 'object',
        properties: { targetUrl: { type: 'string' } },
        required: ['targetUrl'],
        additionalProperties: false,
      },
      handler: async (input) => {
        const target = validateExternalTargetUrl(String(input.targetUrl ?? ''), allowLoopback);
        return fetchJsonOrText(fetchImpl, `${jinaBase}/${target.toString()}`, {
          headers: { Accept: 'text/plain, text/markdown' },
        });
      },
    },
    { override: true },
  );

  registry.registerTool(
    {
      name: 'docs.context7_query',
      description: 'Query up-to-date library documentation via Context7 API',
      service: 'free-docs',
      riskTier: 'R0',
      readOnly: true,
      inputSchema: {
        type: 'object',
        properties: {
          libraryId: { type: 'string' },
          topic: { type: 'string' },
          tokens: { type: 'integer' },
        },
        required: ['libraryId'],
        additionalProperties: false,
      },
      handler: async (input) => {
        const libraryId = String(input.libraryId ?? '').trim().replace(/^\/+/u, '');
        if (!libraryId || libraryId.includes('..')) {
          throw new ConnectorValidationError('libraryId must be a valid Context7 library path');
        }
        const url = new URL(`${context7Base}/${libraryId}`);
        if (typeof input.topic === 'string' && input.topic.trim() !== '') {
          url.searchParams.set('topic', input.topic.trim());
        }
        if (typeof input.tokens === 'number' && Number.isFinite(input.tokens)) {
          url.searchParams.set('tokens', String(Math.trunc(input.tokens)));
        }
        return fetchJsonOrText(fetchImpl, url.toString());
      },
    },
    { override: true },
  );

  registry.registerTool(
    {
      name: 'web.firecrawl_scrape',
      description: 'Scrape a public URL to Markdown via Firecrawl (supports optional FIRECRAWL_API_KEY or keyless tier)',
      service: 'free-web',
      riskTier: 'R0',
      readOnly: true,
      inputSchema: {
        type: 'object',
        properties: { targetUrl: { type: 'string' } },
        required: ['targetUrl'],
        additionalProperties: false,
      },
      handler: async (input) => {
        const target = validateExternalTargetUrl(String(input.targetUrl ?? ''), allowLoopback);
        const apiKey = readEnvSecret(env, ['FIRECRAWL_API_KEY']);
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
        return fetchJsonOrText(fetchImpl, `${firecrawlBase}/scrape`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ url: target.toString(), formats: ['markdown'] }),
        });
      },
    },
    { override: true },
  );

  registry.registerTool(
    {
      name: 'web.tavily_search',
      description: 'Run AI web search via Tavily Search API (requires TAVILY_API_KEY)',
      service: 'free-web',
      riskTier: 'R0',
      readOnly: true,
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          maxResults: { type: 'integer' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      handler: async (input) => {
        const apiKey = readEnvSecret(env, ['TAVILY_API_KEY']);
        if (!apiKey) {
          throw new ConnectorValidationError('TAVILY_API_KEY is required for web.tavily_search');
        }
        const query = String(input.query ?? '').trim();
        if (!query) throw new ConnectorValidationError('query must be non-empty');
        return fetchJsonOrText(fetchImpl, `${tavilyBase}/search`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            api_key: apiKey,
            query,
            max_results: typeof input.maxResults === 'number' ? Math.trunc(input.maxResults) : 5,
          }),
        });
      },
    },
    { override: true },
  );

  registry.registerTool(
    {
      name: 'ocr.llamaparse_parse',
      description: 'Parse a document URL to clean Markdown via LlamaParse (requires LLAMA_CLOUD_API_KEY)',
      service: 'free-ocr',
      riskTier: 'R3',
      readOnly: false,
      inputSchema: {
        type: 'object',
        properties: { documentUrl: { type: 'string' } },
        required: ['documentUrl'],
        additionalProperties: false,
      },
      handler: async (input) => {
        const apiKey = readEnvSecret(env, ['LLAMA_CLOUD_API_KEY']);
        if (!apiKey) {
          throw new ConnectorValidationError('LLAMA_CLOUD_API_KEY is required for ocr.llamaparse_parse');
        }
        const target = validateExternalTargetUrl(String(input.documentUrl ?? ''), allowLoopback);
        return fetchJsonOrText(fetchImpl, `${llamaParseBase}/upload`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ input_url: target.toString(), result_type: 'markdown' }),
        });
      },
    },
    { override: true },
  );

  registry.registerTool(
    {
      name: 'google.drive.list',
      description: 'List files in Google Drive (free 15GB Workspace storage) via OAuth2 Bearer token',
      service: 'google-workspace',
      riskTier: 'R0',
      readOnly: true,
      inputSchema: {
        type: 'object',
        properties: {
          q: { type: 'string' },
          pageSize: { type: 'integer' },
          accessToken: { type: 'string' },
        },
        additionalProperties: false,
      },
      handler: async (input, context) => {
        const token = resolveGoogleBearer(input, context, env);
        const url = new URL(`${driveBase}/files`);
        url.searchParams.set('pageSize', String(typeof input.pageSize === 'number' ? input.pageSize : 20));
        if (typeof input.q === 'string' && input.q.trim() !== '') {
          url.searchParams.set('q', input.q.trim());
        }
        return fetchJsonOrText(fetchImpl, url.toString(), {
          headers: { Authorization: `Bearer ${token}` },
        });
      },
    },
    { override: true },
  );

  registry.registerTool(
    {
      name: 'google.gmail.list_messages',
      description: 'List Gmail messages via Gmail API v1 using OAuth2 Bearer token',
      service: 'google-workspace',
      riskTier: 'R0',
      readOnly: true,
      inputSchema: {
        type: 'object',
        properties: {
          q: { type: 'string' },
          maxResults: { type: 'integer' },
          accessToken: { type: 'string' },
        },
        additionalProperties: false,
      },
      handler: async (input, context) => {
        const token = resolveGoogleBearer(input, context, env);
        const url = new URL(`${gmailBase}/users/me/messages`);
        url.searchParams.set('maxResults', String(typeof input.maxResults === 'number' ? input.maxResults : 20));
        if (typeof input.q === 'string' && input.q.trim() !== '') {
          url.searchParams.set('q', input.q.trim());
        }
        return fetchJsonOrText(fetchImpl, url.toString(), {
          headers: { Authorization: `Bearer ${token}` },
        });
      },
    },
    { override: true },
  );

  registry.registerTool(
    {
      name: 'google.calendar.list_events',
      description: 'List upcoming Google Calendar events via Calendar API v3',
      service: 'google-workspace',
      riskTier: 'R0',
      readOnly: true,
      inputSchema: {
        type: 'object',
        properties: {
          calendarId: { type: 'string' },
          maxResults: { type: 'integer' },
          accessToken: { type: 'string' },
        },
        additionalProperties: false,
      },
      handler: async (input, context) => {
        const token = resolveGoogleBearer(input, context, env);
        const calendarId = encodeURIComponent(
          typeof input.calendarId === 'string' && input.calendarId.trim() !== ''
            ? input.calendarId.trim()
            : 'primary',
        );
        const url = new URL(`${calendarBase}/calendars/${calendarId}/events`);
        url.searchParams.set('maxResults', String(typeof input.maxResults === 'number' ? input.maxResults : 20));
        return fetchJsonOrText(fetchImpl, url.toString(), {
          headers: { Authorization: `Bearer ${token}` },
        });
      },
    },
    { override: true },
  );

  registry.registerTool(
    {
      name: 'google.sheets.append_row',
      description: 'Append a row to a Google Sheet via Sheets API v4',
      service: 'google-workspace',
      riskTier: 'R3',
      readOnly: false,
      inputSchema: {
        type: 'object',
        properties: {
          spreadsheetId: { type: 'string' },
          range: { type: 'string' },
          values: { type: 'array', items: { type: 'string' } },
          accessToken: { type: 'string' },
        },
        required: ['spreadsheetId', 'range', 'values'],
        additionalProperties: false,
      },
      handler: async (input, context) => {
        const token = resolveGoogleBearer(input, context, env);
        const spreadsheetId = String(input.spreadsheetId ?? '').trim();
        const range = String(input.range ?? '').trim();
        if (!spreadsheetId || !range) {
          throw new ConnectorValidationError('spreadsheetId and range are required');
        }
        const url = new URL(
          `${sheetsBase}/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}:append`,
        );
        url.searchParams.set('valueInputOption', 'USER_ENTERED');
        return fetchJsonOrText(fetchImpl, url.toString(), {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ values: [input.values] }),
        });
      },
    },
    { override: true },
  );
}
