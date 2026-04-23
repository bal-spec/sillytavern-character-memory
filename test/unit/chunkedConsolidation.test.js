import { describe, it, expect, vi } from 'vitest';
import { runChunkedConsolidation } from '../../consolidation.js';

const b = (n) => ({ chat: `c${n}`, date: '2024-01-01', bullets: [`bullet ${n}`] });

function makeDeps(overrides = {}) {
    return {
        runLLM: vi.fn(async (blocks) => `<memory chat="out">\n- processed ${blocks.length} blocks\n</memory>`),
        logProgress: vi.fn(),
        isCancelled: vi.fn(() => false),
        // Splits into two chunks at index 2. Assumes >= 3 input blocks in
        // tests (so the tail slice is non-empty); we .filter out the empty
        // trailing chunk defensively just in case.
        packChunks: (mems) => [mems.slice(0, 2), mems.slice(2)].filter(c => c.length > 0),
        parseOutput: (text) => [{ chat: 'parsed', date: '', bullets: [text] }],
        maxRetries: 1,
        ...overrides,
    };
}

describe('runChunkedConsolidation', () => {
    it('runs map phase for each chunk then reduces', async () => {
        const deps = makeDeps();
        const result = await runChunkedConsolidation([b(1), b(2), b(3)], deps);
        expect(deps.runLLM).toHaveBeenCalledTimes(3); // 2 map + 1 reduce
        expect(result).toContain('<memory');
    });

    it('logs progress for start and each chunk', async () => {
        const deps = makeDeps();
        await runChunkedConsolidation([b(1), b(2), b(3)], deps);
        const logs = deps.logProgress.mock.calls.map(c => c[0]).join('\n');
        expect(logs).toContain('starting chunked mode');
        expect(logs).toContain('chunk 1/2');
        expect(logs).toContain('chunk 2/2');
        expect(logs).toContain('reduce');
    });

    it('aborts and returns null when cancel flag is set before next chunk', async () => {
        const calls = { n: 0 };
        const deps = makeDeps({
            isCancelled: () => calls.n++ >= 1,
        });
        const result = await runChunkedConsolidation([b(1), b(2), b(3)], deps);
        expect(result).toBeNull();
    });

    it('retries a failing chunk once and succeeds', async () => {
        let attempts = 0;
        const runLLM = vi.fn(async () => {
            attempts++;
            if (attempts === 1) throw new Error('network blip');
            return '<memory chat="ok">\n- ok\n</memory>';
        });
        const deps = makeDeps({ runLLM });
        const result = await runChunkedConsolidation([b(1), b(2), b(3)], deps);
        expect(result).not.toBeNull();
        // 1 fail + 1 retry for chunk 1 = 2 calls, + chunk 2 (1) + reduce (1) = 4 total
        expect(runLLM.mock.calls.length).toBe(4);
    });

    it('aborts with null after second consecutive failure', async () => {
        const runLLM = vi.fn(async () => { throw new Error('persistent fail'); });
        const deps = makeDeps({ runLLM });
        const result = await runChunkedConsolidation([b(1), b(2), b(3)], deps);
        expect(result).toBeNull();
    });

    it('skips empty chunk output without aborting', async () => {
        let n = 0;
        const runLLM = vi.fn(async () => {
            n++;
            if (n === 1) return '';                    // empty map
            return '<memory chat="ok">\n- ok\n</memory>';
        });
        const deps = makeDeps({ runLLM });
        const result = await runChunkedConsolidation([b(1), b(2), b(3)], deps);
        expect(result).not.toBeNull();
        // 2 map calls (chunk 1 empty, chunk 2 ok) + 1 reduce call = 3 total
        expect(runLLM.mock.calls.length).toBe(3);
    });

    it('aborts when reduce pass returns null', async () => {
        let n = 0;
        const runLLM = vi.fn(async () => {
            n++;
            if (n <= 2) return '<memory chat="ok">\n- ok\n</memory>';
            return null; // reduce pass fails
        });
        const deps = makeDeps({ runLLM });
        const result = await runChunkedConsolidation([b(1), b(2), b(3)], deps);
        expect(result).toBeNull();
    });

    it('aborts when all map outputs are empty', async () => {
        const deps = makeDeps({ runLLM: vi.fn(async () => '') });
        const result = await runChunkedConsolidation([b(1), b(2), b(3)], deps);
        expect(result).toBeNull();
    });
});
