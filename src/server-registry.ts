export interface JsonSchemaProperty {
  readonly type: 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array';
  readonly description?: string;
  readonly enum?: readonly (string | number | boolean)[];
  readonly items?: JsonSchemaProperty;
  readonly properties?: Readonly<Record<string, JsonSchemaProperty>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
}

export interface McpToolSchema {
  readonly type: 'object';
  readonly properties?: Readonly<Record<string, JsonSchemaProperty>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
}

export type McpRiskTier = 'R0' | 'R1' | 'R2' | 'R3' | 'R4';

export interface McpDispatchContext {
  readonly bearerToken?: string;
  readonly requestId?: string | number | null;
}

export interface McpToolMetadata {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: McpToolSchema;
  readonly riskTier?: McpRiskTier;
  readonly readOnly?: boolean;
  readonly service?: string;
}

export interface McpToolEntry<TInput = Record<string, unknown>, TOutput = unknown>
  extends McpToolMetadata {
  readonly handler: (input: TInput, context?: McpDispatchContext) => Promise<TOutput> | TOutput;
}

export interface McpResourceMetadata {
  readonly uri: string;
  readonly name: string;
  readonly description?: string;
  readonly mimeType?: string;
}

export interface McpResourceEntry extends McpResourceMetadata {
  readonly reader: (context?: McpDispatchContext) => Promise<string | Uint8Array> | string | Uint8Array;
}

export interface McpPromptArgument {
  readonly name: string;
  readonly description?: string;
  readonly required?: boolean;
}

export interface McpPromptMetadata {
  readonly name: string;
  readonly description?: string;
  readonly arguments?: readonly McpPromptArgument[];
}

export interface McpPromptEntry extends McpPromptMetadata {
  readonly render: (args: Readonly<Record<string, string>>) => Promise<string> | string;
}

export type McpRegistryErrorCode = 'DUPLICATE_ENTRY' | 'NOT_FOUND' | 'VALIDATION_ERROR';

export class McpRegistryError extends Error {
  readonly code: McpRegistryErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    code: McpRegistryErrorCode,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'McpRegistryError';
    this.code = code;
    this.details = details;
  }
}

export interface SchemaValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validatePropertyValue(
  value: unknown,
  schema: JsonSchemaProperty,
  path: string,
  errors: string[],
): void {
  if (schema.enum && !schema.enum.includes(value as string | number | boolean)) {
    errors.push(`${path}: value must be one of [${schema.enum.join(', ')}]`);
    return;
  }

  switch (schema.type) {
    case 'string':
      if (typeof value !== 'string') {
        errors.push(`${path}: expected string`);
      }
      break;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        errors.push(`${path}: expected number`);
      }
      break;
    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        errors.push(`${path}: expected integer`);
      }
      break;
    case 'boolean':
      if (typeof value !== 'boolean') {
        errors.push(`${path}: expected boolean`);
      }
      break;
    case 'array':
      if (!Array.isArray(value)) {
        errors.push(`${path}: expected array`);
      } else if (schema.items) {
        const itemSchema = schema.items;
        value.forEach((entry, idx) => validatePropertyValue(entry, itemSchema, `${path}[${idx}]`, errors));
      }
      break;
    case 'object':
      if (!isPlainObject(value)) {
        errors.push(`${path}: expected object`);
      } else {
        for (const req of schema.required ?? []) {
          if (value[req] === undefined) {
            errors.push(`${path}.${req}: is required`);
          }
        }
        const props = schema.properties ?? {};
        for (const [key, propVal] of Object.entries(value)) {
          const propSchema = props[key];
          if (!propSchema) {
            if (schema.additionalProperties === false) {
              errors.push(`${path}.${key}: additional property not allowed`);
            }
            continue;
          }
          if (propVal !== undefined) {
            validatePropertyValue(propVal, propSchema, `${path}.${key}`, errors);
          }
        }
      }
      break;
  }
}

export function validateAgainstSchema(value: unknown, schema: McpToolSchema): SchemaValidationResult {
  const errors: string[] = [];
  if (!isPlainObject(value)) {
    return { valid: false, errors: ['input: expected object'] };
  }

  for (const req of schema.required ?? []) {
    if (value[req] === undefined) {
      errors.push(`${req}: is required`);
    }
  }

  const props = schema.properties ?? {};
  for (const [key, val] of Object.entries(value)) {
    const propSchema = props[key];
    if (!propSchema) {
      if (schema.additionalProperties === false) {
        errors.push(`${key}: additional property not allowed`);
      }
      continue;
    }
    if (val !== undefined) {
      validatePropertyValue(val, propSchema, key, errors);
    }
  }

  return { valid: errors.length === 0, errors };
}

interface RegisteredTool {
  readonly metadata: McpToolMetadata;
  readonly invoke: (input: unknown, context?: McpDispatchContext) => Promise<unknown>;
}

export class McpServerRegistry {
  private readonly tools = new Map<string, RegisteredTool>();
  private readonly resources = new Map<string, McpResourceEntry>();
  private readonly prompts = new Map<string, McpPromptEntry>();

  registerTool<TInput = Record<string, unknown>, TOutput = unknown>(
    entry: McpToolEntry<TInput, TOutput>,
    options?: { readonly override?: boolean },
  ): this {
    if (!options?.override && this.tools.has(entry.name)) {
      throw new McpRegistryError('DUPLICATE_ENTRY', `Tool "${entry.name}" is already registered.`, {
        name: entry.name,
      });
    }
    const metadata: McpToolMetadata = {
      name: entry.name,
      description: entry.description,
      inputSchema: entry.inputSchema,
      ...(entry.riskTier !== undefined ? { riskTier: entry.riskTier } : {}),
      ...(entry.readOnly !== undefined ? { readOnly: entry.readOnly } : {}),
      ...(entry.service !== undefined ? { service: entry.service } : {}),
    };
    this.tools.set(entry.name, {
      metadata,
      invoke: async (input: unknown, context?: McpDispatchContext): Promise<unknown> =>
        await entry.handler(input as TInput, context),
    });
    return this;
  }

  registerResource(entry: McpResourceEntry, options?: { readonly override?: boolean }): this {
    if (!options?.override && this.resources.has(entry.uri)) {
      throw new McpRegistryError(
        'DUPLICATE_ENTRY',
        `Resource "${entry.uri}" is already registered.`,
        { uri: entry.uri },
      );
    }
    this.resources.set(entry.uri, entry);
    return this;
  }

  registerPrompt(entry: McpPromptEntry, options?: { readonly override?: boolean }): this {
    if (!options?.override && this.prompts.has(entry.name)) {
      throw new McpRegistryError('DUPLICATE_ENTRY', `Prompt "${entry.name}" is already registered.`, {
        name: entry.name,
      });
    }
    this.prompts.set(entry.name, entry);
    return this;
  }

  hasTool(name: string): boolean {
    return this.tools.has(name);
  }

  hasResource(uri: string): boolean {
    return this.resources.has(uri);
  }

  hasPrompt(name: string): boolean {
    return this.prompts.has(name);
  }

  listTools(): McpToolMetadata[] {
    return [...this.tools.values()].map((entry) => entry.metadata);
  }

  listResources(): McpResourceMetadata[] {
    return [...this.resources.values()].map(({ reader: _reader, ...meta }) => meta);
  }

  listPrompts(): McpPromptMetadata[] {
    return [...this.prompts.values()].map(({ render: _render, ...meta }) => meta);
  }

  async dispatchTool<TOutput = unknown>(
    name: string,
    input: unknown = {},
    context?: McpDispatchContext,
  ): Promise<TOutput> {
    const entry = this.tools.get(name);
    if (!entry) {
      throw new McpRegistryError('NOT_FOUND', `Unknown MCP tool "${name}".`, { name });
    }
    const validation = validateAgainstSchema(input, entry.metadata.inputSchema);
    if (!validation.valid) {
      throw new McpRegistryError(
        'VALIDATION_ERROR',
        `Invalid input for tool "${name}": ${validation.errors.join('; ')}`,
        { name, errors: validation.errors },
      );
    }
    return (await entry.invoke(input, context)) as TOutput;
  }

  async readResource(
    uri: string,
    context?: McpDispatchContext,
  ): Promise<{ readonly uri: string; readonly mimeType?: string; readonly content: string | Uint8Array }> {
    const entry = this.resources.get(uri);
    if (!entry) {
      throw new McpRegistryError('NOT_FOUND', `Unknown MCP resource "${uri}".`, { uri });
    }
    const content = await entry.reader(context);
    return {
      uri: entry.uri,
      ...(entry.mimeType !== undefined ? { mimeType: entry.mimeType } : {}),
      content,
    };
  }

  async renderPrompt(name: string, args: Readonly<Record<string, string>> = {}): Promise<string> {
    const entry = this.prompts.get(name);
    if (!entry) {
      throw new McpRegistryError('NOT_FOUND', `Unknown MCP prompt "${name}".`, { name });
    }
    for (const arg of entry.arguments ?? []) {
      const value = args[arg.name];
      if (arg.required && (value === undefined || value === '')) {
        throw new McpRegistryError(
          'VALIDATION_ERROR',
          `Missing required argument "${arg.name}" for prompt "${name}".`,
          { name, argument: arg.name },
        );
      }
    }
    return await entry.render(args);
  }
}
