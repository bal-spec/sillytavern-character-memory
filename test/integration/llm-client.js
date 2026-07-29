// Shared LLM client for the live-integration tier.
//
// Both live suites previously carried their own copy of this logic, and both were
// written for non-reasoning models: they read only `choices[0].message.content` and
// capped generation at a budget a reasoning model spends entirely on its chain of
// thought before emitting a single visible token. The result was an empty string, a
// zero-block parse, and an assertion failure that pointed at the parser rather than
// the budget.
//
// Environment:
//   TEST_LLM_URL         endpoint (default http://127.0.0.1:1234/v1)
//   TEST_LLM_MODEL       model id (default: auto-discover the first available)
//   TEST_LLM_KEY         bearer token for authenticated endpoints (default: none)
//   TEST_LLM_MAX_TOKENS  generation budget (default 6000)
//   TEST_LLM_TIMEOUT     per-request timeout in ms (default 180000)
//   TEST_LLM_TEMPERATURE sampling temperature (default 0.3; use 0 for reproducibility)
//   TEST_LLM_NO_THINK    set to 1 to ask reasoning models to skip thinking

export const LLM_URL = process.env.TEST_LLM_URL || 'http://127.0.0.1:1234/v1';
export const LLM_KEY = process.env.TEST_LLM_KEY || '';

// 2000 was the old hardcoded value and is not enough for a reasoning model: measured
// against gemma-4-26b-a4b-qat on this fixture, 1997 of 2000 tokens went to reasoning
// and `content` came back empty. 6000 leaves comfortable room for both.
export const MAX_TOKENS = Number(process.env.TEST_LLM_MAX_TOKENS || 6000);

// Reasoning models are slow — a 32B thinking model needs well over a minute for a
// single extraction chunk, and the chunked-consolidation flow issues several calls.
export const TIMEOUT_MS = Number(process.env.TEST_LLM_TIMEOUT || 180_000);

// 0.3 matches what the extension sends, so the default run exercises production-like
// behaviour. Set to 0 for a more reproducible run when investigating a flaky failure.
export const TEMPERATURE = Number(process.env.TEST_LLM_TEMPERATURE ?? 0.3);

const NO_THINK = process.env.TEST_LLM_NO_THINK === '1';

let resolvedModel = process.env.TEST_LLM_MODEL || '';

function authHeaders() {
    const headers = { 'Content-Type': 'application/json' };
    if (LLM_KEY) headers['Authorization'] = `Bearer ${LLM_KEY}`;
    return headers;
}

/** Resolve the model id once, auto-discovering the first available if unset. */
export async function resolveModel() {
    if (resolvedModel) return resolvedModel;
    const res = await fetch(`${LLM_URL}/models`, { headers: authHeaders() });
    if (!res.ok) throw new Error(`Could not list models at ${LLM_URL}: HTTP ${res.status}`);
    const data = await res.json();
    resolvedModel = data.data?.[0]?.id || '';
    if (!resolvedModel) throw new Error(`No models available at ${LLM_URL}`);
    return resolvedModel;
}

/**
 * Strip inline thinking tags. Still needed alongside the reasoning_content fallback
 * below: whether a provider inlines its chain of thought into `content` or splits it
 * into a separate field is provider- and version-specific. LM Studio splits it; others
 * emit <think> blocks inline.
 */
export function stripThinkingTags(text) {
    return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

/**
 * Call the configured LLM and return its visible text.
 *
 * @param {string} prompt User message.
 * @param {{system?: string, maxTokens?: number}} [options]
 * @returns {Promise<string>} Response content with thinking stripped.
 */
export async function callTestLLM(prompt, { system = 'You are a memory extraction assistant.', maxTokens = MAX_TOKENS } = {}) {
    const model = await resolveModel();

    const body = {
        model,
        messages: [
            { role: 'system', content: system },
            { role: 'user', content: prompt },
        ],
        max_tokens: maxTokens,
        temperature: TEMPERATURE,
    };
    // Honoured by llama.cpp/LM Studio for Qwen3-style templates; harmless elsewhere.
    if (NO_THINK) body.chat_template_kwargs = { enable_thinking: false };

    let response;
    try {
        response = await fetch(`${LLM_URL}/chat/completions`, {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
    } catch (err) {
        if (err.name === 'TimeoutError' || err.name === 'AbortError') {
            throw new Error(
                `LLM request to ${model} exceeded TEST_LLM_TIMEOUT (${TIMEOUT_MS}ms). ` +
                'Reasoning models are slow — raise TEST_LLM_TIMEOUT or use a smaller model.',
            );
        }
        throw err;
    }

    if (!response.ok) {
        throw new Error(`LLM error: ${response.status} ${await response.text()}`);
    }

    const data = await response.json();
    const choice = data.choices?.[0];
    const message = choice?.message ?? {};

    const content = message.content || '';
    const reasoning = message.reasoning_content || '';

    // Check budget exhaustion BEFORE the reasoning_content fallback below. A reasoning
    // model that ran out of tokens mid-thought has an empty `content` and a *full*
    // `reasoning_content`, so falling back first would hand the caller a wall of
    // chain-of-thought, parse zero blocks from it, and surface as "expected 0 to be
    // greater than or equal to 1" — pointing at the parser instead of the budget.
    if (!content && choice?.finish_reason === 'length') {
        const spent = data.usage?.completion_tokens_details?.reasoning_tokens;
        throw new Error(
            `${model} used its entire ${maxTokens}-token budget` +
            (spent ? ` (${spent} of them on reasoning)` : '') +
            ' without emitting any content. Raise TEST_LLM_MAX_TOKENS, set ' +
            'TEST_LLM_NO_THINK=1, or use a non-reasoning model.',
        );
    }

    // Mirrors index.js's generateOpenAICompatibleResponse: some providers return a
    // completed answer only in reasoning_content. Testing against a stricter contract
    // than the extension itself honours would fail runs the extension handles fine.
    return stripThinkingTags(content || reasoning);
}
