/**
 * Orchestrator for chunked (map-reduce) memory consolidation.
 *
 * Pure orchestration — no SillyTavern or DOM imports. All side-effectful
 * dependencies are injected via `deps`, which keeps this module testable
 * with deterministic fakes.
 */

/**
 * @typedef {{chat:string, date:string, bullets:string[]}} MemoryBlock
 *
 * @typedef {Object} ChunkedDeps
 * @property {(chunk: MemoryBlock[]) => Promise<string|null>} runLLM
 *           Runs one consolidation LLM call. Return serialized memory text
 *           (the same shape runConsolidationLLM produces) on success. Return
 *           null or empty string for a "soft" no-content result (skip and
 *           continue). THROW for retriable failures (network error, timeout,
 *           provider 5xx) — the orchestrator's retry loop only activates on
 *           thrown errors, not on empty/null returns.
 * @property {(msg: string) => void} logProgress
 * @property {() => boolean} isCancelled  Checked between chunks.
 * @property {(memories: MemoryBlock[]) => MemoryBlock[][]} packChunks
 * @property {(text: string) => MemoryBlock[]} parseOutput
 * @property {number} [maxRetries]  Default 1 (one retry per chunk).
 */

/**
 * @param {MemoryBlock[]} memories
 * @param {ChunkedDeps} deps
 * @returns {Promise<string|null>} Serialized memory text, or null on abort/failure.
 */
export async function runChunkedConsolidation(memories, deps) {
    const {
        runLLM,
        logProgress,
        isCancelled,
        packChunks,
        parseOutput,
        maxRetries = 1,
    } = deps;

    const chunks = packChunks(memories);
    logProgress(`Consolidation: starting chunked mode (${chunks.length} chunks)`);

    const mapOutputs = [];
    for (let i = 0; i < chunks.length; i++) {
        if (isCancelled()) {
            logProgress('Consolidation cancelled by user');
            return null;
        }

        logProgress(`Consolidating chunk ${i + 1}/${chunks.length}...`);

        let result = null;
        let lastErr = null;
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                result = await runLLM(chunks[i]);
                lastErr = null;
                break;
            } catch (err) {
                lastErr = err;
                if (attempt < maxRetries) {
                    logProgress(`Chunk ${i + 1} failed (${err.message}), retrying…`);
                }
            }
        }

        if (lastErr) {
            const retryNote = maxRetries > 0 ? ` after ${maxRetries} retry${maxRetries === 1 ? '' : 's'}` : '';
            logProgress(`Chunk ${i + 1} failed${retryNote}: ${lastErr.message}`);
            return null;
        }

        if (!result) {
            logProgress(`Chunk ${i + 1} returned empty result, skipping`);
            continue;
        }

        mapOutputs.push(result);
    }

    if (mapOutputs.length === 0) {
        logProgress('All chunks returned empty; aborting consolidation');
        return null;
    }

    logProgress('Running reduce pass…');
    const combinedBlocks = [];
    mapOutputs.forEach((out, i) => {
        const parsed = parseOutput(out);
        if (parsed.length === 0) {
            logProgress(`Map output ${i + 1} produced no parseable blocks; excluding from reduce`);
        }
        combinedBlocks.push(...parsed);
    });
    if (combinedBlocks.length === 0) {
        logProgress('No blocks parsed from map outputs; aborting consolidation');
        return null;
    }

    let reduceResult;
    try {
        reduceResult = await runLLM(combinedBlocks);
    } catch (err) {
        logProgress(`Reduce pass failed: ${err.message}`);
        return null;
    }
    if (!reduceResult) {
        logProgress('Reduce pass returned empty');
        return null;
    }
    return reduceResult;
}
