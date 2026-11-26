import type { Readable, Writable } from 'node:stream';
import {
  ConnectorValidationError,
  ECOSYSTEM_SERVICE_IDS,
  EcosystemConnectors,
  loadConnectorConfig,
  registerEcosystemTools,
  sanitizeBearerToken,
  type EcosystemConnectorsOptions,
} from './connectors.js';
import {
  McpRegistryError,
  McpServerRegistry,
  type McpDispatchContext,
} from './server-registry.js';
import { registerFreeTierTools, type FreeTierToolsOptions } from './free-tools.js';

export const DEFAULT_MCP_PORT = 4530;
export const DEFAULT_MCP_HOST = '127.0.0.1';
export const MCP_PROTOCOL_VERSION = '2025-03-26';
export const MCP_SERVER_NAME = '@moonwitness/rocksoul-mcp';
export const MCP_SERVER_VERSION = '1.0.0';
const MAX_RPC_BODY_BYTES = 1_048_576;

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  readonly jsonrpc: '2.0';
  readonly id?: JsonRpcId;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

export interface JsonRpcErrorObject {
  readonly code: number;
  readonly message: string;
  readonly data?: Record<string, unknown>;
}

export interface JsonRpcSuccessResponse {
  readonly jsonrpc: '2.0';
  readonly id: JsonRpcId;
  readonly result: Record<string, unknown>;
}

export interface JsonRpcErrorResponse {
  readonly jsonrpc: '2.0';
  readonly id: JsonRpcId;
  readonly error: JsonRpcErrorObject;
}

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

export interface McpServerConfig {
  readonly host: string;
  readonly port: number;
  readonly transport: 'http' | 'stdio';
  readonly connectors: EcosystemConnectorsOptions;
}

export interface McpApplication {
  readonly registry: McpServerRegistry;
  readonly connectors: EcosystemConnectors;
  readonly serverName: string;
  readonly serverVersion: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasForbiddenKeys(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  for (const key of Object.keys(value)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      return true;
    }
    if (hasForbiddenKeys(value[key])) {
      return true;
    }
  }
  return false;
}

function jsonRpcError(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: Record<string, unknown>,
): JsonRpcErrorResponse {
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code,
      message,
      ...(data !== undefined ? { data } : {}),
    },
  };
}

function jsonRpcSuccess(id: JsonRpcId, result: Record<string, unknown>): JsonRpcSuccessResponse {
  return {
    jsonrpc: '2.0',
    id,
    result,
  };
}

export function extractBearerToken(authorizationHeader: string | null | undefined): string | undefined {
  if (typeof authorizationHeader !== 'string') return undefined;
  if (!authorizationHeader.trim().toLowerCase().startsWith('bearer ')) return undefined;
  return sanitizeBearerToken(authorizationHeader);
}

export function createMcpApplication(options: {
  readonly connectors?: EcosystemConnectorsOptions;
  readonly registry?: McpServerRegistry;
  readonly freeTools?: FreeTierToolsOptions;
} = {}): McpApplication {
  const connectors = new EcosystemConnectors(options.connectors);
  const registry = options.registry ?? new McpServerRegistry();
  registerEcosystemTools(registry, connectors);
  registerFreeTierTools(registry, options.freeTools);
  return {
    registry,
    connectors,
    serverName: MCP_SERVER_NAME,
    serverVersion: MCP_SERVER_VERSION,
  };
}

export async function handleJsonRpcRequest(
  app: McpApplication,
  payload: unknown,
  context: McpDispatchContext = {},
): Promise<JsonRpcResponse | null> {
  if (!isPlainObject(payload) || hasForbiddenKeys(payload)) {
    return jsonRpcError(null, -32600, 'Invalid JSON-RPC 2.0 request object');
  }

  const hasId = Object.hasOwn(payload, 'id');
  const rawId = payload.id;
  if (
    hasId &&
    rawId !== null &&
    typeof rawId !== 'string' &&
    typeof rawId !== 'number'
  ) {
    return jsonRpcError(null, -32600, 'JSON-RPC id must be a string, number, or null');
  }
  const id: JsonRpcId = hasId ? (rawId as JsonRpcId) : null;

  if (payload.jsonrpc !== '2.0' || typeof payload.method !== 'string' || payload.method.length === 0) {
    return jsonRpcError(id, -32600, 'Invalid JSON-RPC version or method');
  }

  const params = payload.params === undefined ? {} : payload.params;
  if (!isPlainObject(params)) {
    return jsonRpcError(id, -32602, 'JSON-RPC params must be an object');
  }

  // Notifications carry no `id` and expect no response once accepted.
  const isNotification = !hasId;

  const dispatchCtx: McpDispatchContext = {
    ...(context.bearerToken !== undefined ? { bearerToken: context.bearerToken } : {}),
    requestId: id,
  };

  try {
    switch (payload.method) {
      case 'initialize': {
        if (isNotification) return null;
        const requestedProtocol =
          typeof params.protocolVersion === 'string' && params.protocolVersion.trim() !== ''
            ? params.protocolVersion.trim()
            : MCP_PROTOCOL_VERSION;
        return jsonRpcSuccess(id, {
          protocolVersion: requestedProtocol,
          capabilities: {
            tools: { listChanged: false },
            resources: { subscribe: false, listChanged: false },
            prompts: { listChanged: false },
          },
          serverInfo: {
            name: app.serverName,
            version: app.serverVersion,
          },
        });
      }

      case 'notifications/initialized': {
        return isNotification ? null : jsonRpcSuccess(id, {});
      }

      case 'ping': {
        return isNotification ? null : jsonRpcSuccess(id, {});
      }

      case 'tools/list': {
        if (isNotification) return null;
        return jsonRpcSuccess(id, {
          tools: app.registry.listTools(),
        });
      }

      case 'tools/call': {
        const toolName = typeof params.name === 'string' ? params.name : '';
        if (toolName.trim() === '') {
          return isNotification ? null : jsonRpcError(id, -32602, 'tools/call requires a non-empty tool name');
        }
        const toolArgs = params.arguments === undefined ? {} : params.arguments;
        const output = await app.registry.dispatchTool(toolName, toolArgs, dispatchCtx);
        if (isNotification) return null;
        return jsonRpcSuccess(id, {
          content: [{ type: 'text', text: JSON.stringify(output) }],
          structuredContent: output,
          isError: false,
        });
      }

      case 'resources/list': {
        if (isNotification) return null;
        return jsonRpcSuccess(id, {
          resources: app.registry.listResources(),
        });
      }

      case 'resources/read': {
        const uri = typeof params.uri === 'string' ? params.uri : '';
        if (uri.trim() === '') {
          return isNotification ? null : jsonRpcError(id, -32602, 'resources/read requires a non-empty uri');
        }
        const resource = await app.registry.readResource(uri, dispatchCtx);
        if (isNotification) return null;
        const textContent =
          typeof resource.content === 'string'
            ? resource.content
            : Buffer.from(resource.content).toString('base64');
        return jsonRpcSuccess(id, {
          contents: [
            {
              uri: resource.uri,
              ...(resource.mimeType !== undefined ? { mimeType: resource.mimeType } : {}),
              ...(typeof resource.content === 'string' ? { text: textContent } : { blob: textContent }),
            },
          ],
        });
      }

      case 'prompts/list': {
        if (isNotification) return null;
        return jsonRpcSuccess(id, {
          prompts: app.registry.listPrompts(),
        });
      }

      case 'prompts/get': {
        const promptName = typeof params.name === 'string' ? params.name : '';
        if (promptName.trim() === '') {
          return isNotification ? null : jsonRpcError(id, -32602, 'prompts/get requires a non-empty name');
        }
        const rawArgs = isPlainObject(params.arguments) ? params.arguments : {};
        const stringArgs: Record<string, string> = {};
        for (const [k, v] of Object.entries(rawArgs)) {
          if (typeof v === 'string') {
            stringArgs[k] = v;
          }
        }
        const rendered = await app.registry.renderPrompt(promptName, stringArgs);
        if (isNotification) return null;
        return jsonRpcSuccess(id, {
          messages: [
            {
              role: 'user',
              content: { type: 'text', text: rendered },
            },
          ],
        });
      }

      default:
        return isNotification ? null : jsonRpcError(id, -32601, `Method not found: "${payload.method}"`);
    }
  } catch (error) {
    if (isNotification) return null;
    if (error instanceof McpRegistryError) {
      const code = error.code === 'NOT_FOUND' ? -32004 : -32602;
      return jsonRpcError(id, code, error.message, error.details ? { ...error.details } : undefined);
    }
    if (error instanceof ConnectorValidationError) {
      return jsonRpcError(id, -32602, error.message, { code: error.code });
    }
    const message = error instanceof Error ? error.message : String(error);
    return jsonRpcError(id, -32603, `Internal MCP error: ${message}`);
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

export function createHttpFetchHandler(
  app: McpApplication,
  meta: { readonly port: number },
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const pathname = url.pathname;

    if (request.method === 'GET' && pathname === '/health') {
      return jsonResponse({
        ok: true,
        service: 'mw-rocksoul-mcp',
        name: app.serverName,
        version: app.serverVersion,
        protocolVersion: MCP_PROTOCOL_VERSION,
        mode: 'http',
        port: meta.port,
        toolsCount: app.registry.listTools().length,
        resourcesCount: app.registry.listResources().length,
        promptsCount: app.registry.listPrompts().length,
        connectors: ECOSYSTEM_SERVICE_IDS,
      });
    }

    if (request.method === 'GET' && pathname === '/mcp/tools') {
      const tools = app.registry.listTools();
      return jsonResponse({
        tools,
        count: tools.length,
      });
    }

    if (request.method === 'POST' && pathname === '/mcp/rpc') {
      const rawBody = await request.text();
      if (Buffer.byteLength(rawBody, 'utf8') > MAX_RPC_BODY_BYTES) {
        return jsonResponse(jsonRpcError(null, -32600, 'RPC payload exceeds 1 MiB limit'), 413);
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        return jsonResponse(jsonRpcError(null, -32700, 'Parse error: invalid JSON body'), 400);
      }

      let bearerToken: string | undefined;
      try {
        bearerToken = extractBearerToken(request.headers.get('authorization'));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return jsonResponse(jsonRpcError(null, -32600, message), 400);
      }

      const rpcResponse = await handleJsonRpcRequest(app, parsed, { bearerToken });
      if (rpcResponse === null) {
        return new Response(null, {
          status: 204,
          headers: {
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
          },
        });
      }
      return jsonResponse(rpcResponse, 200);
    }

    if (pathname === '/health' || pathname === '/mcp/tools' || pathname === '/mcp/rpc') {
      return jsonResponse({ ok: false, error: 'Method not allowed' }, 405);
    }

    return jsonResponse({ ok: false, error: 'Not found' }, 404);
  };
}

export interface RunningMcpHttpServer {
  readonly port: number;
  readonly hostname: string;
  readonly url: string;
  readonly stop: () => void;
}

export function startHttpServer(
  app: McpApplication,
  options: { readonly host?: string; readonly port?: number } = {},
): RunningMcpHttpServer {
  const host = options.host ?? DEFAULT_MCP_HOST;
  const requestedPort = options.port ?? DEFAULT_MCP_PORT;

  let actualPort = requestedPort;
  const server = Bun.serve({
    hostname: host,
    port: requestedPort,
    fetch: (request) => createHttpFetchHandler(app, { port: actualPort })(request),
  });
  actualPort = server.port ?? requestedPort;

  return {
    port: actualPort,
    hostname: server.hostname ?? host,
    url: `http://${server.hostname ?? host}:${actualPort}`,
    stop: () => {
      server.stop(true);
    },
  };
}

export function createStdioLineProcessor(
  app: McpApplication,
  options: { readonly bearerToken?: string } = {},
): (line: string) => Promise<string | null> {
  const bearerToken = sanitizeBearerToken(options.bearerToken);
  return async (line: string): Promise<string | null> => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return JSON.stringify(jsonRpcError(null, -32700, 'Parse error: invalid JSON line'));
    }

    const response = await handleJsonRpcRequest(app, parsed, { bearerToken });
    return response === null ? null : JSON.stringify(response);
  };
}

export function startStdioServer(
  app: McpApplication,
  options: {
    readonly input?: Readable;
    readonly output?: Writable;
    readonly bearerToken?: string;
  } = {},
): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const processLine = createStdioLineProcessor(app, { bearerToken: options.bearerToken });

  return new Promise<void>((resolve, reject) => {
    let buffer = '';
    let chain: Promise<void> = Promise.resolve();

    const enqueueLine = (line: string): void => {
      chain = chain.then(async () => {
        const reply = await processLine(line);
        if (reply !== null) {
          output.write(`${reply}\n`);
        }
      });
    };

    input.setEncoding('utf8');
    input.on('data', (chunk: string) => {
      buffer += chunk;
      let newlineIdx = buffer.indexOf('\n');
      while (newlineIdx !== -1) {
        const line = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);
        enqueueLine(line);
        newlineIdx = buffer.indexOf('\n');
      }
    });

    input.on('end', () => {
      if (buffer.trim().length > 0) {
        enqueueLine(buffer);
        buffer = '';
      }
      chain.then(() => resolve(), reject);
    });

    input.on('error', reject);
  });
}

export function loadMcpServerConfig(
  argv: readonly string[] = process.argv.slice(2),
  env: Readonly<Record<string, string | undefined>> = process.env,
): McpServerConfig {
  const isStdio = argv.includes('--stdio') || env.ROCKSOUL_MCP_TRANSPORT === 'stdio';
  const host = env.ROCKSOUL_MCP_HOST ?? DEFAULT_MCP_HOST;
  const rawPort = Number(env.ROCKSOUL_MCP_PORT ?? env.PORT ?? DEFAULT_MCP_PORT);
  const port = Number.isInteger(rawPort) && rawPort >= 0 && rawPort <= 65535 ? rawPort : DEFAULT_MCP_PORT;
  const connectorConfig = loadConnectorConfig(env);

  return {
    host,
    port,
    transport: isStdio ? 'stdio' : 'http',
    connectors: connectorConfig,
  };
}

if (import.meta.main) {
  const config = loadMcpServerConfig();
  const app = createMcpApplication({ connectors: config.connectors });

  if (config.transport === 'stdio') {
    void startStdioServer(app, {
      bearerToken: config.connectors.defaultBearerToken,
    }).catch((error: unknown) => {
      process.stderr.write(
        `mw-rocksoul-mcp stdio error: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    });
  } else {
    const running = startHttpServer(app, { host: config.host, port: config.port });
    process.stderr.write(`mw-rocksoul-mcp listening on ${running.url}\n`);
    const shutdown = (): void => {
      running.stop();
      process.exit(0);
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
  }
}
