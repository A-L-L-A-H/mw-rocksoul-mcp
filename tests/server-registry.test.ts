import { describe, expect, it } from 'bun:test';
import {
  McpRegistryError,
  McpServerRegistry,
  validateAgainstSchema,
} from '../src/server-registry.js';

describe('McpServerRegistry & validateAgainstSchema', () => {
  it('validates primitive, nested object, array, enum, and additionalProperties constraints', () => {
    const schema = {
      type: 'object' as const,
      required: ['query', 'mode'],
      additionalProperties: false,
      properties: {
        query: { type: 'string' as const },
        limit: { type: 'integer' as const },
        mode: { type: 'string' as const, enum: ['fast', 'deep'] as const },
        tags: { type: 'array' as const, items: { type: 'string' as const } },
        nested: {
          type: 'object' as const,
          required: ['enabled'],
          additionalProperties: false,
          properties: {
            enabled: { type: 'boolean' as const },
            weight: { type: 'number' as const },
          },
        },
      },
    };

    expect(
      validateAgainstSchema(
        {
          query: 'moonwitness',
          mode: 'fast',
          limit: 10,
          tags: ['a', 'b'],
          nested: { enabled: true, weight: 0.75 },
        },
        schema,
      ),
    ).toEqual({ valid: true, errors: [] });

    const invalid = validateAgainstSchema(
      {
        mode: 'invalid',
        limit: 1.5,
        tags: [42],
        extra: true,
        nested: { weight: Number.NaN, bogus: 1 },
      },
      schema,
    );
    expect(invalid.valid).toBe(false);
    expect(invalid.errors.some((e) => e.includes('query: is required'))).toBe(true);
    expect(invalid.errors.some((e) => e.includes('mode: value must be one of'))).toBe(true);
    expect(invalid.errors.some((e) => e.includes('limit: expected integer'))).toBe(true);
    expect(invalid.errors.some((e) => e.includes('tags[0]: expected string'))).toBe(true);
    expect(invalid.errors.some((e) => e.includes('extra: additional property not allowed'))).toBe(true);
    expect(invalid.errors.some((e) => e.includes('nested.enabled: is required'))).toBe(true);
    expect(invalid.errors.some((e) => e.includes('nested.weight: expected number'))).toBe(true);
    expect(
      invalid.errors.some((e) => e.includes('nested.bogus: additional property not allowed')),
    ).toBe(true);
  });

  it('registers, prevents duplicates unless override=true, and dispatches tools with context', async () => {
    const registry = new McpServerRegistry();
    registry.registerTool({
      name: 'echo.text',
      description: 'Echoes text and forwards bearer presence',
      riskTier: 'R0',
      readOnly: true,
      inputSchema: {
        type: 'object',
        required: ['text'],
        additionalProperties: false,
        properties: { text: { type: 'string' } },
      },
      handler: (input: { text: string }, ctx) => ({
        echoed: input.text,
        hasToken: Boolean(ctx?.bearerToken),
      }),
    });

    expect(registry.hasTool('echo.text')).toBe(true);
    expect(registry.listTools().map((t) => t.name)).toEqual(['echo.text']);

    expect(() =>
      registry.registerTool({
        name: 'echo.text',
        description: 'Duplicate',
        inputSchema: { type: 'object' },
        handler: () => ({}),
      }),
    ).toThrow(McpRegistryError);

    const out = await registry.dispatchTool<{ echoed: string; hasToken: boolean }>(
      'echo.text',
      { text: 'hello' },
      { bearerToken: 'tok-123' },
    );
    expect(out).toEqual({ echoed: 'hello', hasToken: true });

    registry.registerTool(
      {
        name: 'echo.text',
        description: 'Overridden',
        inputSchema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } },
        handler: (input: { text: string }) => ({ echoed: input.text.toUpperCase() }),
      },
      { override: true },
    );
    expect(await registry.dispatchTool('echo.text', { text: 'ok' })).toEqual({ echoed: 'OK' });

    await expect(registry.dispatchTool('echo.text', {})).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    await expect(registry.dispatchTool('missing.tool', {})).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('registers and serves resources and prompts with validation', async () => {
    const registry = new McpServerRegistry();
    registry.registerResource({
      uri: 'rocksoul://status',
      name: 'status',
      mimeType: 'text/plain',
      reader: () => 'ready',
    });
    registry.registerPrompt({
      name: 'diagnose',
      arguments: [{ name: 'target', required: true }],
      render: ({ target }) => `Diagnose ${target}`,
    });

    expect(registry.hasResource('rocksoul://status')).toBe(true);
    expect(registry.hasPrompt('diagnose')).toBe(true);
    expect(await registry.readResource('rocksoul://status')).toEqual({
      uri: 'rocksoul://status',
      mimeType: 'text/plain',
      content: 'ready',
    });
    expect(await registry.renderPrompt('diagnose', { target: 'mw-echo' })).toBe(
      'Diagnose mw-echo',
    );
    await expect(registry.renderPrompt('diagnose', {})).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    await expect(registry.readResource('rocksoul://unknown')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});
