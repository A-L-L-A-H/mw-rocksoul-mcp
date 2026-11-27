import { describe, expect, it } from 'bun:test';
import { McpServerRegistry } from '../src/server-registry.js';
import { registerEpistemicTools } from '../src/epistemic-tools.js';
import { registerTaskOSBridgeTools } from '../src/taskos-bridge.js';

describe('Epistemic and TaskOS Bridge Tools', () => {
  it('registers and dispatches nexus.verify_claim, corpus.semantic_search, lore.get_provenance', async () => {
    const registry = new McpServerRegistry();
    registerEpistemicTools({ registry });

    const tools = registry.listTools();
    expect(tools.some((t) => t.name === 'nexus.verify_claim')).toBe(true);
    expect(tools.some((t) => t.name === 'corpus.semantic_search')).toBe(true);
    expect(tools.some((t) => t.name === 'lore.get_provenance')).toBe(true);

    const verifyRes = await registry.dispatchTool<{ verified: boolean; claim: string }>('nexus.verify_claim', { claim: 'Rocksoul is zero-orm' });
    expect(verifyRes.verified).toBe(true);

    const searchRes = await registry.dispatchTool<{ count: number; matches: Array<{ title: string }> }>('corpus.semantic_search', { query: 'TaskOS DAG' });
    expect(searchRes.count).toBeGreaterThan(0);
    expect(searchRes.matches[0]?.title).toContain('Corpus match: TaskOS DAG');

    const provRes = await registry.dispatchTool<{ authority: string }>('lore.get_provenance', { target: 'src/server.ts' });
    expect(provRes.authority).toBe('mw-lore-service');
  });

  it('registers and dispatches plan.dag, plan.next, plan.recall, plan.impact', async () => {
    const registry = new McpServerRegistry();
    registerTaskOSBridgeTools({ registry });

    const tools = registry.listTools();
    expect(tools.some((t) => t.name === 'plan.dag')).toBe(true);
    expect(tools.some((t) => t.name === 'plan.next')).toBe(true);
    expect(tools.some((t) => t.name === 'plan.recall')).toBe(true);
    expect(tools.some((t) => t.name === 'plan.impact')).toBe(true);

    const dagRes = await registry.dispatchTool<{ totalTasks: number }>('plan.dag', { plan_id: 'p-1' });
    expect(dagRes.totalTasks).toBe(44);

    const nextRes = await registry.dispatchTool<{ hasReadyTask: boolean }>('plan.next', {});
    expect(nextRes.hasReadyTask).toBe(false);

    const recallRes = await registry.dispatchTool<{ query: string; recalledEpisodes: unknown[] }>('plan.recall', { query: 'episodic memory' });
    expect(recallRes.recalledEpisodes.length).toBeGreaterThan(0);

    const impactRes = await registry.dispatchTool<{ blastRadiusCount: number }>('plan.impact', { paths: ['src/index.ts'] });
    expect(impactRes.blastRadiusCount).toBe(2);
  });
});
