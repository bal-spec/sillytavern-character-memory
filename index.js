import {
    eventSource,
    event_types,
    generateQuietPrompt,
    saveSettingsDebounced,
    streamingProcessor,
    chat_metadata,
    characters,
    this_chid,
    substituteParamsExtended,
    getRequestHeaders,
} from '../../../../script.js';
import { getStringHash, getCharaFilename, convertTextToBase64 } from '../../../utils.js';
import {
    getContext,
    extension_settings,
    renderExtensionTemplateAsync,
    saveMetadataDebounced,
} from '../../../extensions.js';
import {
    getDataBankAttachmentsForSource,
    getFileAttachment,
    uploadFileAttachment,
    uploadFileAttachmentToServer,
    deleteAttachment,
    deleteFileFromServer,
} from '../../../chats.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { removeReasoningFromString } from '../../../reasoning.js';
import { callGenericPopup, POPUP_TYPE } from '../../../popup.js';
import { world_info, loadWorldInfo } from '../../../world-info.js';
import { isWebLlmSupported, generateWebLlmChatPrompt } from '../../shared.js';

const MODULE_NAME = 'charMemory';
const DEFAULT_FILE_NAME = 'char-memories.md';
const LOG_PREFIX = '[CharMemory]';

function getMemoryFileName() {
    const custom = extension_settings[MODULE_NAME]?.fileName;
    if (custom && custom !== DEFAULT_FILE_NAME) return custom;

    const charName = getCharacterName();
    if (!charName) return DEFAULT_FILE_NAME;

    const safeName = charName.replace(/[^a-zA-Z0-9_-]/g, '_');
    const perChat = extension_settings[MODULE_NAME]?.perChat;
    if (perChat) {
        const context = getContext();
        const chatId = context.chatId || 'default';
        return `${safeName}-chat${chatId}-memories.md`;
    }
    return `${safeName}-memories.md`;
}

let inApiCall = false;
let lastExtractionResult = null;
let consolidationBackup = null;
let lastExtractionTime = 0; // session-only, resets on page load

// ============ Activity Log ============

const MAX_LOG_ENTRIES = 500;
let activityLog = [];

function logActivity(message, type = 'info') {
    const now = new Date();
    const timestamp = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
    activityLog.unshift({ timestamp, message, type });
    if (activityLog.length > MAX_LOG_ENTRIES) activityLog.pop();
    updateActivityLogDisplay();
}

function updateActivityLogDisplay() {
    const $container = $('#charMemory_activityLog');
    if (!$container.length) return;

    if (activityLog.length === 0) {
        $container.html('<div class="charMemory_diagEmpty">No activity yet.</div>');
        return;
    }

    const html = activityLog.map(entry => {
        const typeClass = `charMemory_log_${entry.type}`;
        const isVerbose = entry.message.includes('\n');
        const msgHtml = isVerbose
            ? `<details><summary>${escapeHtml(entry.message.split('\n')[0])}</summary><pre class="charMemory_logVerbose">${escapeHtml(entry.message)}</pre></details>`
            : escapeHtml(entry.message);
        return `<div class="charMemory_logEntry ${typeClass}"><span class="charMemory_logTime">${entry.timestamp}</span> ${msgHtml}</div>`;
    }).join('');
    $container.html(html);
}

const defaultExtractionPrompt = `You are a memory extraction assistant. Read the recent chat messages and identify the most significant facts, events, and developments worth remembering long-term.

Character name: {{charName}}

===== CHARACTER CARD (baseline knowledge — do NOT extract anything already described here) =====
{{charCard}}
===== END CHARACTER CARD =====

===== EXISTING MEMORIES (reference only — do NOT repeat, rephrase, or remix these) =====
{{existingMemories}}
===== END EXISTING MEMORIES =====

===== RECENT CHAT MESSAGES (extract ONLY from this section) =====
{{recentMessages}}
===== END RECENT CHAT MESSAGES =====

CRITICAL: Only extract memories from the RECENT CHAT MESSAGES section above. The CHARACTER CARD section defines what is already known about {{charName}} — do not re-extract any of it. The EXISTING MEMORIES section shows what has already been recorded — do not restate, paraphrase, or recombine anything from it.

INSTRUCTIONS:
1. Extract only NEW facts, events, relationships, or character developments NOT already covered by the character card or existing memories.
2. Write in past tense, third person. Do NOT quote dialogue verbatim.
3. Do NOT use emojis.
4. Wrap output in <memory></memory> tags with a markdown bulleted list (lines starting with "- ").
5. Use ONE <memory> block per encounter or event. Everything in the same scene = one block.
6. HARD LIMIT: No more than 8 bullet points TOTAL. If you have more, you are being too granular — cut the least significant ones.
7. If nothing genuinely new or significant, respond with exactly: NO_NEW_MEMORIES
8. Write about WHAT HAPPENED, not about the conversation itself. Never write "she told him about X" or "she described her X" or "she admitted Y" — instead write the actual fact: "X happened" or "she did Y."

WHAT TO EXTRACT — ask for each item: "Would {{char}} bring this up unprompted weeks or months later?"
- Backstory reveals, personal history, goals, fears (only if NOT already in the character card)
- Relationship changes (new connections, betrayals, shifts in feeling)
- Significant events and their outcomes (not the step-by-step process)
- Skills, possessions, or status changes
- Emotional turning points

DO NOT EXTRACT:
- Anything already described in the CHARACTER CARD above — traits, profession, appearance, personality, habits, preferences, or abilities that are baseline knowledge. This includes rephrasing card traits as discoveries (e.g. if the card says "exhibitionist", do not write "she admitted that being watched turns her on")
- Routine behaviors that simply confirm what the card already says (e.g. if the card says "smoker", don't extract "she smoked a cigarette"; if the card implies safe sex practices, don't extract "she insisted on a condom")
- Meta-narration about the conversation itself — do not write "she told him about X", "she described her past", "she discussed her career". Write the actual facts revealed, not the act of revealing them
- Preferences, opinions, or values that are already expressed or clearly implied by the character card
- Step-by-step accounts of what happened (this is the most common mistake — summarize outcomes, not processes)
- Individual actions, movements, or position changes during a scene
- Scene-setting details (room descriptions, weather, clothing, atmosphere)
- Temporary physical states ("leaned against him", "felt his warmth")
- Paraphrased dialogue or conversation filler
- Anything with no lasting significance beyond the immediate moment

NEGATIVE EXAMPLE — do NOT write memories like this:
<bad_example>
- She picked the lock on the warehouse side door using a tension wrench.
- She crept through the dark corridor and disabled the security camera.
- She found the safe behind a false panel in the office.
- She cracked the combination and retrieved the sealed envelope inside.
- She climbed out through a ventilation shaft to avoid the front entrance.
- She crossed two blocks on foot before reaching her getaway vehicle.
- She handed the envelope to her contact in the parking garage.
- Her contact opened it, confirmed the contents, and gave her a nod.
</bad_example>
This is a play-by-play scene summary. It narrates every step of the operation instead of capturing what matters.

POSITIVE EXAMPLE — the same scene extracted well:
<good_example>
- She broke into a warehouse and stole a sealed envelope from a hidden safe.
- She delivered the envelope to her contact, who confirmed it contained what they needed.
</good_example>
Two bullets capture the full encounter: what she accomplished and the outcome. No step-by-step process, no scene-setting.

NOTE: When content is explicit or violent, name the specific outcome — do not sanitize it into vague language. "She killed him with two shots to the chest" is a memory. "Violence occurred" is not. But this does NOT mean narrate each step leading up to it — summarize the outcome, not the process.

Each memory block should answer: "What from this encounter would stick with {{char}} — things they'd tell someone about months later, or that would surface unbidden in their own mind?"

Output ONLY <memory> blocks (or NO_NEW_MEMORIES). No headers, no commentary, no extra text.`;

const defaultGroupExtractionPrompt = `You are a memory extraction assistant for a GROUP CONVERSATION. Read the recent chat messages and identify the most significant facts, events, and developments worth remembering long-term about {{charName}}.

Character whose memories you are extracting: {{charName}}

===== {{charName}}'s CHARACTER CARD (baseline knowledge — do NOT extract anything already described here) =====
{{charCard}}
===== END CHARACTER CARD =====

===== OTHER PARTICIPANTS =====
{{participants}}
===== END OTHER PARTICIPANTS =====

===== EXISTING MEMORIES FOR {{charName}} (reference only — do NOT repeat, rephrase, or remix these) =====
{{existingMemories}}
===== END EXISTING MEMORIES =====

===== RECENT GROUP CHAT MESSAGES (extract ONLY from this section) =====
{{recentMessages}}
===== END RECENT CHAT MESSAGES =====

CRITICAL: Only extract memories from the RECENT GROUP CHAT MESSAGES section above. The CHARACTER CARD section defines what is already known about {{charName}} — do not re-extract any of it. The EXISTING MEMORIES section shows what has already been recorded — do not restate, paraphrase, or recombine anything from it.

INSTRUCTIONS:
1. Extract only NEW facts, events, relationships, or character developments about {{charName}} NOT already covered by the character card or existing memories.
2. Write in past tense, third person. Do NOT quote dialogue verbatim.
3. Do NOT use emojis.
4. Wrap output in <memory></memory> tags with a markdown bulleted list (lines starting with "- ").
5. Use ONE <memory> block per encounter or event. Everything in the same scene = one block.
6. HARD LIMIT: No more than 8 bullet points TOTAL. If you have more, you are being too granular — cut the least significant ones.
7. If nothing genuinely new or significant about {{charName}}, respond with exactly: NO_NEW_MEMORIES
8. Write about WHAT HAPPENED, not about the conversation itself. Never write "she told him about X" — instead write the actual fact: "X happened" or "she did Y."
9. IMPORTANT: Reference other participants by name. Include who was involved in events, who said what to whom, who was present. Names matter for group memory.
10. When possible, note approximate timeframes or sequencing of events mentioned in conversation.

WHAT TO EXTRACT — ask for each item: "Would {{charName}} remember this weeks or months later?"
- Backstory reveals, personal history, goals, fears (only if NOT already in the character card)
- Relationship changes with specific participants (new connections, conflicts, alliances, shifts in feeling)
- Significant events and their outcomes involving {{charName}} (not step-by-step)
- Skills, possessions, or status changes
- Emotional turning points
- Group dynamics: who allied with whom, who disagreed, power shifts

DO NOT EXTRACT:
- Anything already described in the CHARACTER CARD above
- Routine behaviors that simply confirm what the card already says
- Meta-narration about the conversation itself
- Step-by-step accounts (summarize outcomes, not processes)
- Scene-setting details, temporary physical states
- Paraphrased dialogue or conversation filler
- Anything with no lasting significance

Each memory block should answer: "What from this encounter would {{charName}} remember — things involving them or affecting them that they'd think about later?"

Output ONLY <memory> blocks (or NO_NEW_MEMORIES). No headers, no commentary, no extra text.`;

const EXTRACTION_SOURCE = {
    MAIN_LLM: 'main_llm',
    WEBLLM: 'webllm',
    PROVIDER: 'provider',
};

const PROVIDER_PRESETS = {
    openai: {
        name: 'OpenAI',
        baseUrl: 'https://api.openai.com/v1',
        authStyle: 'bearer',
        modelsEndpoint: 'standard',
        requiresApiKey: true,
        extraHeaders: {},
        defaultModel: 'gpt-4.1-nano',
        helpUrl: 'https://platform.openai.com/api-keys',
    },
    anthropic: {
        name: 'Anthropic',
        baseUrl: 'https://api.anthropic.com/v1',
        authStyle: 'x-api-key',
        modelsEndpoint: 'none',
        requiresApiKey: true,
        extraHeaders: { 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
        defaultModel: 'claude-sonnet-4-5-20250929',
        helpUrl: 'https://console.anthropic.com/settings/keys',
        isAnthropic: true,
    },
    openrouter: {
        name: 'OpenRouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        authStyle: 'bearer',
        modelsEndpoint: 'standard',
        requiresApiKey: true,
        extraHeaders: { 'HTTP-Referer': 'https://sillytavern.app', 'X-Title': 'SillyTavern CharMemory' },
        defaultModel: 'openai/gpt-4.1-nano',
        helpUrl: 'https://openrouter.ai/keys',
    },
    groq: {
        name: 'Groq',
        baseUrl: 'https://api.groq.com/openai/v1',
        authStyle: 'bearer',
        modelsEndpoint: 'standard',
        requiresApiKey: true,
        extraHeaders: {},
        defaultModel: 'llama-3.3-70b-versatile',
        helpUrl: 'https://console.groq.com/keys',
    },
    deepseek: {
        name: 'DeepSeek',
        baseUrl: 'https://api.deepseek.com',
        authStyle: 'bearer',
        modelsEndpoint: 'standard',
        requiresApiKey: true,
        extraHeaders: {},
        defaultModel: 'deepseek-chat',
        helpUrl: 'https://platform.deepseek.com/api_keys',
    },
    mistral: {
        name: 'Mistral',
        baseUrl: 'https://api.mistral.ai/v1',
        authStyle: 'bearer',
        modelsEndpoint: 'standard',
        requiresApiKey: true,
        extraHeaders: {},
        defaultModel: 'mistral-small-latest',
        helpUrl: 'https://console.mistral.ai/api-keys',
    },
    xai: {
        name: 'xAI (Grok)',
        baseUrl: 'https://api.x.ai/v1',
        authStyle: 'bearer',
        modelsEndpoint: 'standard',
        requiresApiKey: true,
        extraHeaders: {},
        defaultModel: 'grok-3-mini-fast',
        helpUrl: 'https://console.x.ai',
    },
    nanogpt: {
        name: 'NanoGPT',
        baseUrl: 'https://nano-gpt.com/api/v1',
        authStyle: 'bearer',
        modelsEndpoint: 'custom',
        requiresApiKey: true,
        extraHeaders: {},
        defaultModel: '',
        helpUrl: 'https://nano-gpt.com/api',
    },
    ollama: {
        name: 'Ollama (local)',
        baseUrl: 'http://localhost:11434/v1',
        authStyle: 'none',
        modelsEndpoint: 'standard',
        requiresApiKey: false,
        extraHeaders: {},
        defaultModel: '',
        helpUrl: 'https://ollama.com',
    },
    nvidia: {
        name: 'NVIDIA',
        baseUrl: 'https://integrate.api.nvidia.com/v1',
        authStyle: 'bearer',
        modelsEndpoint: 'standard',
        requiresApiKey: true,
        extraHeaders: {},
        defaultModel: '',
        helpUrl: 'https://build.nvidia.com/',
        useProxy: true,
    },
    pollinations: {
        name: 'Pollinations (free)',
        baseUrl: 'https://text.pollinations.ai/openai',
        authStyle: 'none',
        modelsEndpoint: 'none',
        requiresApiKey: false,
        extraHeaders: {},
        defaultModel: 'openai',
        helpUrl: 'https://pollinations.ai',
    },
    custom: {
        name: 'Custom (OpenAI-compatible)',
        baseUrl: '',
        authStyle: 'bearer',
        modelsEndpoint: 'standard',
        requiresApiKey: true,
        extraHeaders: {},
        defaultModel: '',
        helpUrl: '',
        allowCustomUrl: true,
    },
};

const defaultSettings = {
    enabled: true,
    interval: 20,
    maxMessagesPerExtraction: 20,
    responseLength: 1000,
    extractionPrompt: defaultExtractionPrompt,
    source: EXTRACTION_SOURCE.PROVIDER,
    fileName: DEFAULT_FILE_NAME,
    perChat: false,
    selectedProvider: 'openrouter',
    providers: {},
    // Legacy NanoGPT fields kept for migration
    nanogptApiKey: '',
    nanogptModel: '',
    nanogptSystemPrompt: '',
    nanogptFilterSubscription: false,
    nanogptFilterOpenSource: false,
    nanogptFilterRoleplay: false,
    nanogptFilterReasoning: false,
    minCooldownMinutes: 10,
    verboseLogging: false,
    groupExtractionMode: 'per-character',
    groupExtractionPrompt: defaultGroupExtractionPrompt,
    characterFileNames: {},
};

/**
 * Get (or lazily initialize) provider-specific settings.
 * @param {string} providerKey Key from PROVIDER_PRESETS.
 * @returns {{apiKey: string, model: string, systemPrompt: string, customBaseUrl: string, nanogptFilterSubscription?: boolean, nanogptFilterOpenSource?: boolean, nanogptFilterRoleplay?: boolean, nanogptFilterReasoning?: boolean}}
 */
function getProviderSettings(providerKey) {
    const s = extension_settings[MODULE_NAME];
    if (!s.providers) s.providers = {};
    if (!s.providers[providerKey]) {
        const preset = PROVIDER_PRESETS[providerKey];
        s.providers[providerKey] = {
            apiKey: '',
            model: preset?.defaultModel || '',
            systemPrompt: '',
            customBaseUrl: '',
        };
    }
    return s.providers[providerKey];
}

// ============ Structured Memory Helpers ============

/**
 * Parse <memory> tag blocks into an array of memory objects.
 * @param {string} content Raw file content.
 * @returns {{chat: string, date: string, bullets: string[]}[]}
 */
function parseMemories(content) {
    if (!content || !content.trim()) return [];

    const blocks = [];
    const regex = /<memory\b([^>]*)>([\s\S]*?)<\/memory>/gi;
    let match;

    while ((match = regex.exec(content)) !== null) {
        const attrs = match[1];
        const body = match[2];

        // Extract chat and date attributes
        const chatMatch = attrs.match(/chat="([^"]*)"/);
        const dateMatch = attrs.match(/date="([^"]*)"/);
        const chat = chatMatch ? chatMatch[1] : 'unknown';
        const date = dateMatch ? dateMatch[1] : '';

        // Extract bullets (lines starting with "- ")
        const bullets = body.split('\n')
            .map(line => line.trim())
            .filter(line => line.startsWith('- '))
            .map(line => line.slice(2).trim())
            .filter(Boolean);

        if (bullets.length > 0) {
            blocks.push({ chat, date, bullets });
        }
    }

    return blocks;
}

/**
 * Count total individual memories (bullets) across all blocks.
 * @param {{bullets: string[]}[]} blocks Parsed memory blocks.
 * @returns {number}
 */
function countMemories(blocks) {
    return blocks.reduce((sum, b) => sum + b.bullets.length, 0);
}

/**
 * Serialize an array of memory blocks back to <memory> tag format.
 * @param {{chat: string, date: string, bullets: string[]}[]} blocks
 * @returns {string}
 */
function serializeMemories(blocks) {
    return blocks.map(b => {
        const bulletsText = b.bullets.map(bullet => `- ${bullet}`).join('\n');
        return `<memory chat="${b.chat}" date="${b.date}">\n${bulletsText}\n</memory>`;
    }).join('\n\n');
}

/**
 * Merge memory blocks that share the same chat ID and date into single blocks.
 * Preserves ordering — merged block appears at the position of the first occurrence.
 * @param {{chat: string, date: string, bullets: string[]}[]} blocks
 * @returns {{chat: string, date: string, bullets: string[]}[]}
 */
function mergeMemoryBlocks(blocks) {
    const merged = [];
    const seen = new Map();
    for (const block of blocks) {
        const key = block.chat;
        if (seen.has(key)) {
            seen.get(key).bullets.push(...block.bullets);
        } else {
            const copy = { chat: block.chat, date: block.date, bullets: [...block.bullets] };
            seen.set(key, copy);
            merged.push(copy);
        }
    }
    return merged;
}

/**
 * Migrate old memory formats to <memory> tag format if needed.
 * @param {string} content Existing file content.
 * @returns {string} Content in <memory> tag format.
 */
function migrateMemoriesIfNeeded(content) {
    if (!content || !content.trim()) return content;

    // Already in <memory> tag format?
    if (/<memory\b[^>]*>/i.test(content)) return content;

    const now = new Date();
    const timestamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    // Old ## Memory N format?
    if (/^## Memory \d+/m.test(content)) {
        const parts = content.split(/^## Memory \d+\s*$/m);
        const blocks = [];

        for (let i = 1; i < parts.length; i++) {
            const part = parts[i].trim();
            if (!part) continue;

            let date = timestamp;
            let text = part;

            // Extract old timestamp: _Extracted: ..._
            const tsMatch = part.match(/^_Extracted:\s*(.+?)_\s*\n/);
            if (tsMatch) {
                date = tsMatch[1].trim();
                text = part.slice(tsMatch[0].length).trim();
            }

            // Extract bullets or wrap plain text as a single bullet
            const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
            const bullets = lines.filter(l => l.startsWith('- ')).map(l => l.slice(2).trim());
            if (bullets.length === 0 && text.trim()) {
                bullets.push(text.trim());
            }

            if (bullets.length > 0) {
                blocks.push({ chat: 'unknown', date, bullets });
            }
        }

        return serializeMemories(blocks);
    }

    // Completely flat text — wrap as a single block
    const lines = content.trim().split('\n').map(l => l.trim()).filter(Boolean);
    const bullets = lines.filter(l => l.startsWith('- ')).map(l => l.slice(2).trim());
    if (bullets.length === 0) {
        bullets.push(content.trim());
    }
    return serializeMemories([{ chat: 'unknown', date: timestamp, bullets }]);
}

// Diagnostics state (session-only, not persisted)
let lastDiagnostics = {
    worldInfoEntries: [],
    extensionPrompts: {},
    timestamp: null,
};
let diagnosticsHistory = [];

/**
 * Toggle provider settings panel visibility.
 * @param {string} source Current extraction source value.
 */
function toggleProviderSettings(source) {
    const isProvider = source === EXTRACTION_SOURCE.PROVIDER;
    $('#charMemory_providerSettings').toggle(isProvider);
    if (isProvider) {
        updateProviderUI();
    }
}

/**
 * Populate the provider preset dropdown from PROVIDER_PRESETS.
 */
function populateProviderDropdown() {
    const $select = $('#charMemory_providerSelect');
    $select.empty();
    for (const [key, preset] of Object.entries(PROVIDER_PRESETS)) {
        $select.append(`<option value="${escapeHtml(key)}">${escapeHtml(preset.name)}</option>`);
    }
    $select.val(extension_settings[MODULE_NAME].selectedProvider || 'openrouter');
}

/**
 * Update the provider panel UI based on the currently selected preset.
 * Shows/hides rows and populates fields from the provider's saved settings.
 */
function updateProviderUI() {
    const providerKey = extension_settings[MODULE_NAME].selectedProvider;
    const preset = PROVIDER_PRESETS[providerKey];
    if (!preset) return;

    const providerSettings = getProviderSettings(providerKey);

    // API Key row: show/hide based on requiresApiKey
    $('#charMemory_providerApiKeyRow').toggle(!!preset.requiresApiKey);
    $('#charMemory_providerApiKey').val(providerSettings.apiKey || '');

    // Help link
    if (preset.helpUrl) {
        $('#charMemory_providerHelpLink').attr('href', preset.helpUrl).show();
    } else {
        $('#charMemory_providerHelpLink').hide();
    }

    // Custom base URL row
    $('#charMemory_providerBaseUrlRow').toggle(!!preset.allowCustomUrl);
    $('#charMemory_providerBaseUrl').val(providerSettings.customBaseUrl || '');

    // Model: dropdown vs text input
    const useDropdown = preset.modelsEndpoint === 'standard' || preset.modelsEndpoint === 'custom';
    $('#charMemory_providerModelDropdownRow').toggle(useDropdown);
    $('#charMemory_providerModelInputRow').toggle(!useDropdown);

    // NanoGPT-specific filters
    const isNanoGpt = providerKey === 'nanogpt';
    $('#charMemory_nanogptFilters').toggle(isNanoGpt);
    if (isNanoGpt) {
        $('#charMemory_nanogptFilterSub').prop('checked', !!providerSettings.nanogptFilterSubscription);
        $('#charMemory_nanogptFilterOS').prop('checked', !!providerSettings.nanogptFilterOpenSource);
        $('#charMemory_nanogptFilterRP').prop('checked', !!providerSettings.nanogptFilterRoleplay);
        $('#charMemory_nanogptFilterReasoning').prop('checked', !!providerSettings.nanogptFilterReasoning);
    }

    if (useDropdown) {
        populateProviderModels(providerKey);
    } else {
        $('#charMemory_providerModelInput').val(providerSettings.model || '');
    }

    // System prompt
    $('#charMemory_providerSystemPrompt').val(providerSettings.systemPrompt || '');
}

/**
 * Filter NanoGPT models based on active filter toggles.
 * @param {object[]} models Full model list.
 * @param {object} providerSettings NanoGPT provider settings.
 * @returns {object[]} Filtered model list.
 */
function getFilteredNanoGptModels(models, providerSettings) {
    const s = providerSettings;
    const hasAnyFilter = s.nanogptFilterSubscription || s.nanogptFilterOpenSource || s.nanogptFilterRoleplay || s.nanogptFilterReasoning;
    if (!hasAnyFilter) return models;

    return models.filter(m => {
        if (s.nanogptFilterSubscription && m.subscription !== true) return false;
        if (s.nanogptFilterOpenSource && m.isOpenSource !== true) return false;
        if (s.nanogptFilterRoleplay && m.category !== 'Roleplay/storytelling models') return false;
        if (s.nanogptFilterReasoning && !m.capabilities.includes('reasoning')) return false;
        return true;
    });
}

/**
 * Populate the model dropdown for a provider.
 * @param {string} providerKey Provider key.
 * @param {boolean} [forceRefresh=false] Force refresh from API.
 */
async function populateProviderModels(providerKey, forceRefresh = false) {
    const $select = $('#charMemory_providerModel');
    const preset = PROVIDER_PRESETS[providerKey];
    if (!preset) return;

    if (forceRefresh) {
        clearModelCache(providerKey);
    }

    const providerSettings = getProviderSettings(providerKey);

    // Early exit if API key required but missing
    if (preset.requiresApiKey && !providerSettings.apiKey) {
        $select.empty().append('<option value="">-- Enter API key, then click Connect --</option>');
        $('#charMemory_providerModelInfo').text('');
        return;
    }

    try {
        if (providerKey === 'nanogpt') {
            // NanoGPT uses its own rich model list with optgroups
            const models = await fetchNanoGptModels();
            const filtered = getFilteredNanoGptModels(models, providerSettings);
            const currentVal = $select.val() || providerSettings.model;

            $select.empty().append('<option value="">-- Select model --</option>');

            const byProvider = {};
            for (const m of filtered) {
                if (!byProvider[m.provider]) byProvider[m.provider] = [];
                byProvider[m.provider].push(m);
            }

            for (const [provider, providerModels] of Object.entries(byProvider)) {
                const $group = $(`<optgroup label="${escapeHtml(provider)}">`);
                for (const m of providerModels) {
                    const subTag = m.subscription ? ' [Sub]' : '';
                    $group.append(`<option value="${escapeHtml(m.id)}">${escapeHtml(m.name)} (${m.cost})${subTag}</option>`);
                }
                $select.append($group);
            }

            if (currentVal && filtered.some(m => m.id === currentVal)) {
                $select.val(currentVal);
                updateProviderModelInfo(models, currentVal);
            } else {
                $select.val('');
                providerSettings.model = '';
                saveSettingsDebounced();
                $('#charMemory_providerModelInfo').text('');
            }
        } else {
            // Standard OpenAI-compatible model list
            const models = await fetchProviderModels(providerKey);
            const currentVal = $select.val() || providerSettings.model;

            $select.empty().append('<option value="">-- Select model --</option>');
            for (const m of models) {
                $select.append(`<option value="${escapeHtml(m.id)}">${escapeHtml(m.name)}</option>`);
            }

            if (currentVal && models.some(m => m.id === currentVal)) {
                $select.val(currentVal);
            } else if (providerSettings.model) {
                // Model may not be in list yet (e.g. typed manually before)
                $select.val('');
            }
            $('#charMemory_providerModelInfo').text('');
        }
    } catch (err) {
        console.error(LOG_PREFIX, `Failed to fetch models for ${preset.name}:`, err);
        throw err;
    }
}

/**
 * Update the model info text below the dropdown (NanoGPT-specific).
 * @param {object[]} models NanoGPT model list.
 * @param {string} modelId Selected model ID.
 */
function updateProviderModelInfo(models, modelId) {
    const info = models.find(m => m.id === modelId);
    if (info) {
        const parts = [`Provider: ${info.provider}`, `Cost: ${info.cost}`];
        if (info.maxInputTokens) parts.push(`Input: ${info.maxInputTokens.toLocaleString()} tokens`);
        if (info.maxOutputTokens) parts.push(`Output: ${info.maxOutputTokens.toLocaleString()} tokens`);
        parts.push(info.subscription ? 'Included in subscription' : 'Pay-per-use');
        $('#charMemory_providerModelInfo').text(parts.join(' | '));
    } else {
        $('#charMemory_providerModelInfo').text('');
    }
}

function loadSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = {};
    }

    for (const key of Object.keys(defaultSettings)) {
        if (extension_settings[MODULE_NAME][key] === undefined) {
            extension_settings[MODULE_NAME][key] = defaultSettings[key];
        }
    }

    // Migrate old default prompts to current version
    const savedPrompt = extension_settings[MODULE_NAME].extractionPrompt || '';
    if (savedPrompt.includes('Separate each memory with a line containing only') ||
        savedPrompt.includes('FOCUS ON these categories:')) {
        extension_settings[MODULE_NAME].extractionPrompt = defaultExtractionPrompt;
        saveSettingsDebounced();
    }

    // Clamp maxMessagesPerExtraction to new minimum
    if (extension_settings[MODULE_NAME].maxMessagesPerExtraction < 10) {
        extension_settings[MODULE_NAME].maxMessagesPerExtraction = 10;
        saveSettingsDebounced();
    }

    // Migrate old hardcoded default fileName so auto-naming kicks in
    if (extension_settings[MODULE_NAME].fileName === DEFAULT_FILE_NAME) {
        extension_settings[MODULE_NAME].fileName = '';
        saveSettingsDebounced();
    }

    // Migrate NanoGPT source → provider system
    if (extension_settings[MODULE_NAME].source === 'nanogpt') {
        extension_settings[MODULE_NAME].source = EXTRACTION_SOURCE.PROVIDER;
        extension_settings[MODULE_NAME].selectedProvider = 'nanogpt';
        const nanoSettings = getProviderSettings('nanogpt');
        if (extension_settings[MODULE_NAME].nanogptApiKey) {
            nanoSettings.apiKey = extension_settings[MODULE_NAME].nanogptApiKey;
        }
        if (extension_settings[MODULE_NAME].nanogptModel) {
            nanoSettings.model = extension_settings[MODULE_NAME].nanogptModel;
        }
        if (extension_settings[MODULE_NAME].nanogptSystemPrompt) {
            nanoSettings.systemPrompt = extension_settings[MODULE_NAME].nanogptSystemPrompt;
        }
        nanoSettings.nanogptFilterSubscription = !!extension_settings[MODULE_NAME].nanogptFilterSubscription;
        nanoSettings.nanogptFilterOpenSource = !!extension_settings[MODULE_NAME].nanogptFilterOpenSource;
        nanoSettings.nanogptFilterRoleplay = !!extension_settings[MODULE_NAME].nanogptFilterRoleplay;
        nanoSettings.nanogptFilterReasoning = !!extension_settings[MODULE_NAME].nanogptFilterReasoning;
        saveSettingsDebounced();
    }

    // Bind UI elements to settings
    $('#charMemory_enabled').prop('checked', extension_settings[MODULE_NAME].enabled);
    $('#charMemory_perChat').prop('checked', extension_settings[MODULE_NAME].perChat);
    $('#charMemory_interval').val(extension_settings[MODULE_NAME].interval);
    $('#charMemory_intervalCounter').val(extension_settings[MODULE_NAME].interval);
    $('#charMemory_maxMessages').val(extension_settings[MODULE_NAME].maxMessagesPerExtraction);
    $('#charMemory_maxMessagesCounter').val(extension_settings[MODULE_NAME].maxMessagesPerExtraction);
    $('#charMemory_responseLength').val(extension_settings[MODULE_NAME].responseLength);
    $('#charMemory_responseLengthCounter').val(extension_settings[MODULE_NAME].responseLength);
    $('#charMemory_minCooldown').val(extension_settings[MODULE_NAME].minCooldownMinutes);
    $('#charMemory_minCooldownCounter').val(extension_settings[MODULE_NAME].minCooldownMinutes);
    $('#charMemory_extractionPrompt').val(extension_settings[MODULE_NAME].extractionPrompt);
    $('#charMemory_groupMode').val(extension_settings[MODULE_NAME].groupExtractionMode);
    $('#charMemory_groupExtractionPrompt').val(extension_settings[MODULE_NAME].groupExtractionPrompt);
    $('#charMemory_source').val(extension_settings[MODULE_NAME].source);
    $('#charMemory_fileName').val(extension_settings[MODULE_NAME].fileName);
    $('#charMemory_verboseLog').prop('checked', extension_settings[MODULE_NAME].verboseLogging);

    // Provider settings
    populateProviderDropdown();
    toggleProviderSettings(extension_settings[MODULE_NAME].source);

    updateStatusDisplay();
}

function ensureMetadata() {
    if (!chat_metadata[MODULE_NAME]) {
        chat_metadata[MODULE_NAME] = {
            lastExtractedIndex: -1,
            messagesSinceExtraction: 0,
        };
    }
}

let cooldownTimerInterval = null;

function updateStatusDisplay() {
    ensureMetadata();

    // Stats bar: file name
    if (isGroupChat()) {
        const members = getGroupMembers();
        const label = `Group (${members.length} characters)`;
        $('#charMemory_statFile').text(label).attr('title', members.map(m => m.name).join(', '));
    } else {
        const charName = getCharacterName();
        if (charName) {
            const fileName = getMemoryFileName();
            $('#charMemory_statFile').text(fileName).attr('title', fileName);
        } else {
            $('#charMemory_statFile').text('No character').attr('title', 'No character selected');
        }
    }

    // Stats bar: memory count (total bullets, async)
    if (isGroupChat()) {
        // Sum memories across all group members
        const members = getGroupMembers();
        let totalCount = 0;
        let loaded = 0;
        if (members.length === 0) {
            $('#charMemory_statCount').text('0 memories');
        } else {
            for (const member of members) {
                const memFileName = getMemoryFileNameForCharacter(member.name, member.avatar);
                readMemoriesForCharacter(member.avatar, memFileName).then(content => {
                    const blocks = parseMemories(content || '');
                    totalCount += countMemories(blocks);
                    loaded++;
                    if (loaded === members.length) {
                        $('#charMemory_statCount').text(`${totalCount} memor${totalCount === 1 ? 'y' : 'ies'}`);
                    }
                }).catch(() => { loaded++; });
            }
        }
    } else {
        const attachment = findMemoryAttachment();
        if (attachment) {
            getFileAttachment(attachment.url).then(content => {
                const blocks = parseMemories(content || '');
                const count = countMemories(blocks);
                $('#charMemory_statCount').text(`${count} memor${count === 1 ? 'y' : 'ies'}`);
            }).catch(() => {
                $('#charMemory_statCount').text('? memories');
            });
        } else {
            $('#charMemory_statCount').text('0 memories');
        }
    }

    // Stats bar: extraction progress
    const msgsSince = chat_metadata[MODULE_NAME]?.messagesSinceExtraction || 0;
    const interval = extension_settings[MODULE_NAME]?.interval || 10;
    $('#charMemory_statProgress').text(`${msgsSince}/${interval} msgs`);

    // Stats bar: cooldown timer
    updateCooldownDisplay();
    startCooldownTimer();
    updateChatTypeVisibility();
    updateGroupMembersList();

    // Show resolved filename for 1:1 chats
    if (!isGroupChat()) {
        const charName = getCharacterName();
        $('#charMemory_resolvedFileName').text(charName ? getMemoryFileName() : '—');
    }
}

/**
 * Show/hide the 1:1 and Group Chat settings sections based on current chat type.
 */
function updateChatTypeVisibility() {
    const group = isGroupChat();
    $('#charMemory_section1v1').toggle(!group);
    $('#charMemory_sectionGroup').toggle(group);
}

/**
 * Populate the group members filename list in settings UI.
 * Shows each group member with their resolved memory filename (editable).
 */
function updateGroupMembersList() {
    const $container = $('#charMemory_groupMembersList');
    if (!$container.length) return;

    if (!isGroupChat()) {
        $container.html('<small class="charMemory_helperText">Open a group chat to see members.</small>');
        return;
    }

    const members = getGroupMembers();
    if (members.length === 0) {
        $container.html('<small class="charMemory_helperText">No active members in this group.</small>');
        return;
    }

    const rows = members.map(member => {
        const resolved = getMemoryFileNameForCharacter(member.name, member.avatar);
        const override = extension_settings[MODULE_NAME]?.characterFileNames?.[member.avatar] || '';
        return `<div class="charMemory_groupMemberRow">
            <span class="charMemory_groupMemberName">${escapeHtml(member.name)}</span>
            <input type="text" class="text_pole charMemory_groupMemberFile"
                   data-avatar="${escapeHtml(member.avatar)}"
                   data-charname="${escapeHtml(member.name)}"
                   value="${escapeHtml(override)}"
                   placeholder="${escapeHtml(resolved)}"
                   title="Current file: ${escapeHtml(resolved)}" />
        </div>`;
    }).join('');

    $container.html(rows);
}

function updateCooldownDisplay() {
    const cooldownMs = (extension_settings[MODULE_NAME]?.minCooldownMinutes || 0) * 60000;
    if (cooldownMs <= 0 || lastExtractionTime === 0) {
        $('#charMemory_statCooldown').text('Ready');
        return;
    }
    const elapsed = Date.now() - lastExtractionTime;
    if (elapsed >= cooldownMs) {
        $('#charMemory_statCooldown').text('Ready');
    } else {
        const remaining = Math.ceil((cooldownMs - elapsed) / 60000);
        $('#charMemory_statCooldown').text(`${remaining}m cooldown`);
    }
}

function startCooldownTimer() {
    if (cooldownTimerInterval) return;
    cooldownTimerInterval = setInterval(() => {
        updateCooldownDisplay();
        // Stop the timer once cooldown has elapsed
        const cooldownMs = (extension_settings[MODULE_NAME]?.minCooldownMinutes || 0) * 60000;
        if (cooldownMs <= 0 || lastExtractionTime === 0 || Date.now() - lastExtractionTime >= cooldownMs) {
            clearInterval(cooldownTimerInterval);
            cooldownTimerInterval = null;
        }
    }, 15000);
}

function getCharacterName() {
    const context = getContext();
    if (context.characterId === undefined) return null;
    return context.name2 || characters[this_chid]?.name || 'Character';
}

/**
 * Get the character card text (description + personality) for the current character.
 * @returns {string} Combined card text, or empty string if unavailable.
 */
function getCharacterCardText() {
    const character = characters[this_chid];
    if (!character) return '';

    const parts = [];
    const desc = character.data?.description || character.description || '';
    const pers = character.data?.personality || character.personality || '';
    if (desc.trim()) parts.push(desc.trim());
    if (pers.trim()) parts.push(pers.trim());
    return parts.join('\n\n');
}

// ============ Group Chat Helpers ============

/**
 * Check if the current chat is a group chat.
 * @returns {boolean}
 */
function isGroupChat() {
    return !!getContext().groupId;
}

/**
 * Get active (non-disabled) members of the current group chat.
 * Returns only NPC characters — the user's persona is not in group.members.
 * @returns {{name: string, avatar: string, charIndex: number}[]}
 */
function getGroupMembers() {
    const context = getContext();
    if (!context.groupId) return [];
    const group = context.groups?.find(g => g.id === context.groupId);
    if (!group) return [];
    return group.members
        .filter(avatar => !group.disabled_members?.includes(avatar))
        .map(avatar => {
            const charIndex = characters.findIndex(c => c.avatar === avatar);
            const char = characters[charIndex];
            return char ? { name: char.name, avatar, charIndex } : null;
        })
        .filter(Boolean);
}

/**
 * Get character card text for a specific character by index.
 * @param {number} charIndex Index into the characters array.
 * @returns {string} Combined card text, or empty string if unavailable.
 */
function getCharacterCardTextFor(charIndex) {
    const character = characters[charIndex];
    if (!character) return '';
    const parts = [];
    const desc = character.data?.description || character.description || '';
    const pers = character.data?.personality || character.personality || '';
    if (desc.trim()) parts.push(desc.trim());
    if (pers.trim()) parts.push(pers.trim());
    return parts.join('\n\n');
}

// ============ Per-Character Data Bank Operations ============

/**
 * Ensure extension_settings.character_attachments[avatar] exists as an array.
 * @param {string} avatar Character avatar filename (e.g. "Laura.png").
 */
function ensureCharacterAttachments(avatar) {
    if (!extension_settings.character_attachments) {
        extension_settings.character_attachments = {};
    }
    if (!Array.isArray(extension_settings.character_attachments[avatar])) {
        extension_settings.character_attachments[avatar] = [];
    }
}

/**
 * Get memory filename for a specific character (not dependent on this_chid).
 * Detection cascade:
 *   1. Manual override in characterFileNames[avatar]
 *   2. Auto-detect existing *-memories.md in character's Data Bank
 *   3. Fall back to {SafeName}-memories.md
 *
 * @param {string} charName Character name.
 * @param {string} [avatar] Character avatar filename (for override lookup and auto-detect).
 * @returns {string} The memory filename.
 */
function getMemoryFileNameForCharacter(charName, avatar) {
    // 1. Check manual override
    if (avatar) {
        const override = extension_settings[MODULE_NAME]?.characterFileNames?.[avatar];
        if (override) return override;
    }

    const perChat = extension_settings[MODULE_NAME]?.perChat;
    const context = getContext();
    const chatId = context.chatId || 'default';

    // 2. Auto-detect existing memory file in character's Data Bank
    if (avatar) {
        ensureCharacterAttachments(avatar);
        const attachments = extension_settings.character_attachments[avatar];
        if (perChat) {
            // Look for a per-chat file matching this chat ID first
            const perChatFile = attachments.find(a => a.name && a.name.includes(`-chat${chatId}-`) && a.name.endsWith('-memories.md'));
            if (perChatFile) return perChatFile.name;
        } else {
            // Look for a shared (non-per-chat) memory file
            const existing = attachments.find(a => a.name && a.name.endsWith('-memories.md') && !a.name.includes('-chat'));
            if (existing) return existing.name;
        }
    }

    // 3. Fall back to auto-generated name
    const safeName = charName.replace(/[^a-zA-Z0-9_-]/g, '_');
    if (perChat) {
        return `${safeName}-chat${chatId}-memories.md`;
    }
    return `${safeName}-memories.md`;
}

/**
 * Find memory attachment in a specific character's Data Bank.
 * @param {string} avatar Character avatar filename.
 * @param {string} fileName Memory filename to look for.
 * @returns {object|null} The attachment object or null.
 */
function findMemoryAttachmentForCharacter(avatar, fileName) {
    ensureCharacterAttachments(avatar);
    return extension_settings.character_attachments[avatar]
        .find(a => a.name === fileName) || null;
}

/**
 * Read memories from a specific character's Data Bank.
 * @param {string} avatar Character avatar filename.
 * @param {string} fileName Memory filename.
 * @returns {Promise<string>} The file content or empty string.
 */
async function readMemoriesForCharacter(avatar, fileName) {
    const attachment = findMemoryAttachmentForCharacter(avatar, fileName);
    if (!attachment) return '';
    try {
        return (await getFileAttachment(attachment.url)) || '';
    } catch (err) {
        console.error(LOG_PREFIX, `Failed to read memories for ${avatar}:`, err);
        return '';
    }
}

/**
 * Write memories to a specific character's Data Bank (bypasses this_chid).
 * @param {string} content The full memory content.
 * @param {string} avatar Character avatar filename.
 * @param {string} fileName Memory filename.
 */
async function writeMemoriesForCharacter(content, avatar, fileName) {
    ensureCharacterAttachments(avatar);

    // Delete existing file if present
    const existing = findMemoryAttachmentForCharacter(avatar, fileName);
    if (existing) {
        await deleteFileFromServer(existing.url, true);
        extension_settings.character_attachments[avatar] =
            extension_settings.character_attachments[avatar].filter(a => a.url !== existing.url);
    }

    // Upload new file
    const base64Data = convertTextToBase64(content);
    const slug = getStringHash(fileName);
    const uniqueFileName = `${Date.now()}_${slug}.txt`;
    const fileUrl = await uploadFileAttachment(uniqueFileName, base64Data);
    if (!fileUrl) return;

    extension_settings.character_attachments[avatar].push({
        url: fileUrl,
        size: content.length,
        name: fileName,
        created: Date.now(),
    });
    saveSettingsDebounced();
}

// ============ Data Bank Operations (1:1 Chat) ============

/**
 * Find the char-memories.md attachment in character Data Bank.
 * @returns {object|null} The attachment object or null.
 */
function findMemoryAttachment() {
    const attachments = getDataBankAttachmentsForSource('character');
    return attachments.find(a => a.name === getMemoryFileName()) || null;
}

/**
 * Read existing memories from the Data Bank file.
 * @returns {Promise<string>} The file content or empty string.
 */
async function readMemories() {
    const attachment = findMemoryAttachment();
    if (!attachment) return '';

    try {
        let content = await getFileAttachment(attachment.url);
        content = content || '';

        // Auto-migrate flat text to structured format
        const migrated = migrateMemoriesIfNeeded(content);
        if (migrated !== content) {
            console.log(LOG_PREFIX, 'Migrating memories to structured format');
            await writeMemories(migrated);
            return migrated;
        }

        return content;
    } catch (err) {
        console.error(LOG_PREFIX, 'Failed to read memories file:', err);
        return '';
    }
}

/**
 * Write memories to the Data Bank file (delete old, upload new).
 * @param {string} content The full content to write.
 */
async function writeMemories(content) {
    // Delete existing file if present
    const existing = findMemoryAttachment();
    if (existing) {
        await deleteAttachment(existing, 'character', () => {}, false);
    }

    // Upload new file
    const file = new File([content], getMemoryFileName(), { type: 'text/plain' });
    await uploadFileAttachmentToServer(file, 'character');
}

/**
 * Collect recent messages for extraction.
 * @param {Object} options
 * @param {number|null} options.endIndex Optional end message index (inclusive). Defaults to last message.
 * @param {Array|null} options.chatArray Optional external chat array. Defaults to context.chat.
 * @param {number|null} options.lastExtractedIdx Optional last extracted index. Defaults to metadata value.
 * @returns {{ text: string, startIndex: number, endIndex: number }} Formatted messages string and index range.
 */
function collectRecentMessages({ endIndex = null, chatArray = null, lastExtractedIdx = null } = {}) {
    const context = getContext();
    const chat = chatArray || context.chat;
    const lastExtracted = lastExtractedIdx !== null ? lastExtractedIdx : (function () {
        ensureMetadata();
        return chat_metadata[MODULE_NAME].lastExtractedIndex ?? -1;
    })();

    if (!chat || chat.length === 0) return { text: '', startIndex: -1, endIndex: -1 };

    const startIndex = Math.max(0, lastExtracted + 1);
    const maxMessages = extension_settings[MODULE_NAME].maxMessagesPerExtraction;
    const end = endIndex !== null ? endIndex + 1 : chat.length;

    if (startIndex >= end) return { text: '', startIndex: -1, endIndex: -1 };

    logActivity(`collectRecentMessages: lastExtracted=${lastExtracted}, startIndex=${startIndex}, end=${end}, chatLength=${chat.length}`);

    // Take a chunk of maxMessages starting from startIndex (NOT from end)
    const sliceEnd = Math.min(startIndex + maxMessages, end);
    const slice = chat.slice(startIndex, sliceEnd);

    const lines = [];
    for (const msg of slice) {
        if (!msg.mes) continue;
        // Skip true system messages (narrator/UI messages with no real content)
        if (msg.is_system && !msg.is_user && !msg.name) continue;
        // Strip non-diegetic content: markdown tables, code blocks (image prompts), HTML tags
        let text = msg.mes;
        text = text.replace(/```[\s\S]*?```/g, '');                    // code blocks (image prompts)
        text = text.replace(/<details[\s\S]*?<\/details>/gi, '');      // collapsed details sections
        text = text.replace(/\|[^\n]*\|(?:\n\|[^\n]*\|)*/g, '');       // markdown tables
        text = text.replace(/<[^>]*>/g, '');                           // HTML tags
        text = text.replace(/\n{3,}/g, '\n\n').trim();                 // collapse whitespace
        if (!text) continue;
        lines.push(`${msg.name}: ${text}`);
    }

    logActivity(`Collected ${lines.length} messages (indices ${startIndex}-${sliceEnd - 1})`);
    return { text: lines.join('\n\n'), startIndex, endIndex: sliceEnd - 1 };
}

// ============ Server API Helpers ============

/**
 * Fetch all chats for the current character from the server.
 * @returns {Promise<Array>} Array of chat objects with file_name, chat_items, last_mes, etc.
 */
async function fetchCharacterChats() {
    const context = getContext();
    if (context.characterId === undefined) return [];

    const avatar = characters[this_chid]?.avatar;
    if (!avatar) return [];

    const response = await fetch('/api/characters/chats', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ avatar_url: avatar, simple: false }),
    });

    if (!response.ok) {
        console.error(LOG_PREFIX, 'Failed to fetch character chats:', response.status);
        return [];
    }

    const chats = await response.json();
    if (!Array.isArray(chats)) return [];
    return chats;
}

/**
 * Fetch full message history for a specific chat file from the server.
 * @param {string} fileName - Chat filename (with or without .jsonl extension)
 * @returns {Promise<{metadata: object, messages: object[]}|null>}
 */
async function fetchChatMessages(fileName) {
    const avatar = characters[this_chid]?.avatar;
    const charName = getCharacterName();
    if (!avatar || !charName) return null;

    const response = await fetch('/api/chats/get', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            avatar_url: avatar,
            file_name: fileName.replace('.jsonl', ''),
            ch_name: charName,
        }),
    });

    if (!response.ok) {
        console.error(LOG_PREFIX, 'Failed to fetch chat:', fileName, response.status);
        return null;
    }

    const data = await response.json();
    if (!Array.isArray(data) || data.length === 0) return null;

    return {
        metadata: data[0]?.chat_metadata || {},
        messages: data.slice(1),
    };
}

// ============ Provider API Helpers ============

let cachedNanoGptModels = null;
const modelCache = {};

/**
 * Fetch available text models from NanoGPT, with subscription status.
 * @returns {Promise<{id: string, name: string, cost: string, provider: string, subscription: boolean, maxInputTokens: number, maxOutputTokens: number}[]>}
 */
async function fetchNanoGptModels() {
    if (cachedNanoGptModels) return cachedNanoGptModels;

    // Fetch full model list and subscription model list in parallel
    const [modelsResponse, subResponse] = await Promise.all([
        fetch('https://nano-gpt.com/api/models'),
        fetch('https://nano-gpt.com/api/subscription/v1/models').catch(() => null),
    ]);

    if (!modelsResponse.ok) {
        throw new Error(`Failed to fetch NanoGPT models: ${modelsResponse.status} ${modelsResponse.statusText}`);
    }

    const data = await modelsResponse.json();
    const textModels = data?.models?.text;
    if (!textModels || typeof textModels !== 'object') {
        throw new Error('Unexpected NanoGPT models response format');
    }

    // Build set of subscription model IDs
    const subscriptionIds = new Set();
    if (subResponse && subResponse.ok) {
        try {
            const subData = await subResponse.json();
            const subModels = subData?.data || [];
            for (const m of subModels) {
                if (m.id) subscriptionIds.add(m.id);
            }
        } catch { /* ignore parse error */ }
    }

    const models = [];
    for (const [id, info] of Object.entries(textModels)) {
        if (!info.visible) continue;
        models.push({
            id,
            name: info.name || id,
            cost: info.inputCost != null ? `$${info.inputCost}/${info.outputCost}` : 'N/A',
            provider: info.provider || 'unknown',
            maxInputTokens: info.maxInputTokens || 0,
            maxOutputTokens: info.maxOutputTokens || 0,
            subscription: subscriptionIds.has(id),
            isOpenSource: !!info.isOpenSource,
            category: info.category || '',
            capabilities: Array.isArray(info.capabilities) ? info.capabilities : [],
            costEstimate: info.costEstimate || 0,
        });
    }

    models.sort((a, b) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name));
    cachedNanoGptModels = models;
    return models;
}

/**
 * Build auth headers for a provider preset.
 * @param {object} preset Provider preset from PROVIDER_PRESETS.
 * @param {string} apiKey API key for the provider.
 * @returns {object} Headers object.
 */
function buildProviderHeaders(preset, apiKey) {
    const headers = { 'Content-Type': 'application/json', ...preset.extraHeaders };
    if (preset.authStyle === 'bearer' && apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
    } else if (preset.authStyle === 'x-api-key' && apiKey) {
        headers['x-api-key'] = apiKey;
    }
    return headers;
}

/**
 * Resolve the base URL for a provider, considering custom URLs.
 * @param {object} preset Provider preset.
 * @param {object} providerSettings Provider-specific settings.
 * @returns {string} Base URL.
 */
function resolveBaseUrl(preset, providerSettings) {
    if (preset.allowCustomUrl && providerSettings.customBaseUrl) {
        return providerSettings.customBaseUrl.replace(/\/+$/, '');
    }
    return preset.baseUrl;
}

/**
 * Generate a response using an OpenAI-compatible API.
 * @param {string} baseUrl Base URL for the API.
 * @param {string} apiKey API key.
 * @param {string} model Model identifier.
 * @param {{role: string, content: string}[]} messages Chat messages.
 * @param {number} maxTokens Max tokens for response.
 * @param {object} preset Provider preset.
 * @returns {Promise<string>} The assistant's response content.
 */
async function generateOpenAICompatibleResponse(baseUrl, apiKey, model, messages, maxTokens, preset) {
    const verbose = extension_settings[MODULE_NAME].verboseLogging;

    // Route through ST server proxy if provider requires it (CORS bypass)
    if (preset.useProxy) {
        const response = await fetch('/api/backends/chat-completions/generate', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                chat_completion_source: 'custom',
                custom_url: baseUrl,
                custom_include_headers: `Authorization: Bearer ${apiKey}`,
                model,
                messages,
                max_tokens: maxTokens,
                temperature: 0.3,
                stream: false,
            }),
        });

        if (!response.ok) {
            const presetName = preset.name || 'API';
            let errorMsg = `${presetName} error: ${response.status}`;
            try {
                const errorBody = await response.json();
                errorMsg += ` — ${errorBody.error?.message || JSON.stringify(errorBody)}`;
            } catch { /* ignore parse error */ }
            if (verbose) logActivity(`Generate (proxy) HTTP ${response.status} — ST server error`, 'error');
            throw new Error(errorMsg);
        }

        const data = await response.json();

        const msg = data.choices?.[0]?.message;

        if (verbose) {
            if (data.error) {
                logActivity(`Generate (proxy) HTTP ${response.status} — upstream error: ${JSON.stringify(data.error)}`, 'error');
            } else {
                const usage = data.usage;
                const tokens = usage ? `${usage.prompt_tokens} prompt + ${usage.completion_tokens} completion` : 'no usage data';
                const hasReasoning = msg?.reasoning_content ? ` [reasoning: ${msg.reasoning_content.length} chars]` : '';
                logActivity(`Generate (proxy) HTTP ${response.status}, model=${data.model || model}, finish=${data.choices?.[0]?.finish_reason || '?'}, ${tokens}${hasReasoning}`);
            }
        }

        // ST proxy returns 200 even for upstream errors — detect error in body
        if (data.error) {
            const errorMsg = data.error.message || JSON.stringify(data.error);
            throw new Error(`${preset.name || 'API'} error (via proxy): ${errorMsg}`);
        }

        // Fall back to reasoning_content for models that use thinking tokens
        return msg?.content || msg?.reasoning_content || '';
    }

    const headers = buildProviderHeaders(preset, apiKey);
    const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
            model,
            messages,
            max_tokens: maxTokens,
            temperature: 0.3,
        }),
    });

    if (!response.ok) {
        const presetName = preset.name || 'API';
        let errorMsg = `${presetName} error: ${response.status}`;
        try {
            const errorBody = await response.json();
            errorMsg += ` — ${errorBody.error?.message || JSON.stringify(errorBody)}`;
        } catch { /* ignore parse error */ }
        if (verbose) logActivity(`Generate (direct) HTTP ${response.status} — ${errorMsg}`, 'error');
        throw new Error(errorMsg);
    }

    const data = await response.json();
    const msg = data.choices?.[0]?.message;

    if (verbose) {
        const usage = data.usage;
        const tokens = usage ? `${usage.prompt_tokens} prompt + ${usage.completion_tokens} completion` : 'no usage data';
        const hasReasoning = msg?.reasoning_content ? ` [reasoning: ${msg.reasoning_content.length} chars]` : '';
        logActivity(`Generate (direct) HTTP ${response.status}, model=${data.model || model}, finish=${data.choices?.[0]?.finish_reason || '?'}, ${tokens}${hasReasoning}`);
    }

    // Fall back to reasoning_content for models that use thinking tokens
    return msg?.content || msg?.reasoning_content || '';
}

/**
 * Generate a response using the Anthropic native Messages API.
 * @param {string} baseUrl Base URL for the API.
 * @param {string} apiKey API key.
 * @param {string} model Model identifier.
 * @param {{role: string, content: string}[]} messages Chat messages (OpenAI format).
 * @param {number} maxTokens Max tokens for response.
 * @param {object} preset Provider preset.
 * @returns {Promise<string>} The assistant's response content.
 */
async function generateAnthropicResponse(baseUrl, apiKey, model, messages, maxTokens, preset) {
    const headers = buildProviderHeaders(preset, apiKey);

    // Extract system message and convert to Anthropic format
    let system = '';
    const anthropicMessages = [];
    for (const msg of messages) {
        if (msg.role === 'system') {
            system += (system ? '\n' : '') + msg.content;
        } else {
            anthropicMessages.push({ role: msg.role, content: msg.content });
        }
    }

    // Anthropic requires at least one user message
    if (anthropicMessages.length === 0 || anthropicMessages[0].role !== 'user') {
        anthropicMessages.unshift({ role: 'user', content: 'Please proceed.' });
    }

    const body = {
        model,
        max_tokens: maxTokens,
        messages: anthropicMessages,
    };
    if (system) body.system = system;

    const verbose = extension_settings[MODULE_NAME].verboseLogging;

    const response = await fetch(`${baseUrl}/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
    });

    if (!response.ok) {
        let errorMsg = `Anthropic error: ${response.status}`;
        try {
            const errorBody = await response.json();
            errorMsg += ` — ${errorBody.error?.message || JSON.stringify(errorBody)}`;
        } catch { /* ignore parse error */ }
        if (verbose) logActivity(`Generate (Anthropic) HTTP ${response.status} — ${errorMsg}`, 'error');
        throw new Error(errorMsg);
    }

    const data = await response.json();

    if (verbose) {
        const usage = data.usage;
        const tokens = usage ? `${usage.input_tokens} in + ${usage.output_tokens} out` : 'no usage data';
        logActivity(`Generate (Anthropic) HTTP ${response.status}, model=${data.model || model}, stop=${data.stop_reason || '?'}, ${tokens}`);
    }

    return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('') || '';
}

/**
 * Route a request to the correct provider API.
 * @param {{role: string, content: string}[]} messages Chat messages.
 * @param {number} maxTokens Max tokens for response.
 * @returns {Promise<string>} The assistant's response content.
 */
async function generateProviderResponse(messages, maxTokens) {
    const providerKey = extension_settings[MODULE_NAME].selectedProvider;
    const preset = PROVIDER_PRESETS[providerKey];
    if (!preset) throw new Error(`Unknown provider: ${providerKey}`);

    const providerSettings = getProviderSettings(providerKey);
    const apiKey = providerSettings.apiKey;
    const model = providerSettings.model;
    const baseUrl = resolveBaseUrl(preset, providerSettings);

    if (preset.requiresApiKey && !apiKey) {
        throw new Error(`${preset.name} API key is not set. Configure it in Character Memory settings.`);
    }
    if (!model) {
        throw new Error(`${preset.name} model is not selected. Choose a model in Character Memory settings.`);
    }
    if (preset.allowCustomUrl && !baseUrl) {
        throw new Error('Custom base URL is not set. Configure it in Character Memory settings.');
    }

    if (preset.isAnthropic) {
        return generateAnthropicResponse(baseUrl, apiKey, model, messages, maxTokens, preset);
    }
    return generateOpenAICompatibleResponse(baseUrl, apiKey, model, messages, maxTokens, preset);
}

/**
 * Get a human-readable label for the current source.
 * @returns {string}
 */
function getSourceLabel() {
    const source = extension_settings[MODULE_NAME].source;
    if (source === EXTRACTION_SOURCE.WEBLLM) return 'WebLLM';
    if (source === EXTRACTION_SOURCE.PROVIDER) {
        const key = extension_settings[MODULE_NAME].selectedProvider;
        return PROVIDER_PRESETS[key]?.name || key;
    }
    return 'main LLM';
}

/**
 * Unified LLM dispatch: routes to Provider API, WebLLM, or Main LLM.
 * @param {string} userPrompt The user prompt to send.
 * @param {number} maxTokens Max tokens for the response.
 * @param {string} [defaultSystemPrompt='You are a memory extraction assistant.'] Fallback system prompt.
 * @returns {Promise<string>} The LLM response.
 */
async function callLLM(userPrompt, maxTokens, defaultSystemPrompt = 'You are a memory extraction assistant.') {
    const source = extension_settings[MODULE_NAME].source;
    if (source === EXTRACTION_SOURCE.PROVIDER) {
        const providerSettings = getProviderSettings(extension_settings[MODULE_NAME].selectedProvider);
        const systemPrompt = providerSettings.systemPrompt || defaultSystemPrompt;
        return generateProviderResponse(
            [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
            maxTokens,
        );
    }
    if (source === EXTRACTION_SOURCE.WEBLLM) {
        if (!isWebLlmSupported()) throw new Error('WebLLM is not available in this browser.');
        return generateWebLlmChatPrompt(
            [{ role: 'system', content: defaultSystemPrompt }, { role: 'user', content: userPrompt }],
            { max_tokens: maxTokens },
        );
    }
    return generateQuietPrompt({ quietPrompt: userPrompt, skipWIAN: true, responseLength: maxTokens });
}

/**
 * Fetch models for a provider (standard OpenAI-compatible /models endpoint).
 * @param {string} providerKey Provider key from PROVIDER_PRESETS.
 * @returns {Promise<{id: string, name: string}[]>} Model list.
 */
async function fetchProviderModels(providerKey) {
    if (modelCache[providerKey]) return modelCache[providerKey];

    const preset = PROVIDER_PRESETS[providerKey];
    if (!preset) return [];

    if (preset.modelsEndpoint === 'none') return [];
    if (preset.modelsEndpoint === 'custom') {
        // NanoGPT uses its own rich model fetcher
        const models = await fetchNanoGptModels();
        return models.map(m => ({ id: m.id, name: m.name, _raw: m }));
    }

    const verbose = extension_settings[MODULE_NAME].verboseLogging;
    const providerSettings = getProviderSettings(providerKey);
    const baseUrl = resolveBaseUrl(preset, providerSettings);
    if (!baseUrl) return [];

    // Route through ST server proxy if provider requires it (CORS bypass)
    if (preset.useProxy) {
        const response = await fetch('/api/backends/chat-completions/status', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                chat_completion_source: 'custom',
                custom_url: baseUrl,
                custom_include_headers: `Authorization: Bearer ${providerSettings.apiKey}`,
            }),
        });
        if (!response.ok) {
            if (verbose) logActivity(`Models (proxy) HTTP ${response.status} — ST server error`, 'error');
            throw new Error(`Failed to fetch models from ${preset.name}: ${response.status}`);
        }
        const data = await response.json();

        // ST proxy returns 200 even for upstream errors — detect error in body
        if (data.error) {
            const errorMsg = data.error.message || JSON.stringify(data.error);
            if (verbose) logActivity(`Models (proxy) HTTP ${response.status} — upstream error: ${JSON.stringify(data.error)}`, 'error');
            throw new Error(`Failed to fetch models from ${preset.name}: ${errorMsg}`);
        }

        const rawModels = data?.data || [];
        const models = rawModels
            .map(m => ({ id: m.id, name: m.id }))
            .sort((a, b) => a.name.localeCompare(b.name));
        if (verbose) logActivity(`Models (proxy) HTTP ${response.status}, ${models.length} models loaded from ${preset.name}`);
        modelCache[providerKey] = models;
        return models;
    }

    const headers = buildProviderHeaders(preset, providerSettings.apiKey);
    delete headers['Content-Type']; // GET request

    const response = await fetch(`${baseUrl}/models`, { headers });
    if (!response.ok) {
        if (verbose) logActivity(`Models (direct) HTTP ${response.status} from ${baseUrl}/models`, 'error');
        throw new Error(`Failed to fetch models from ${preset.name}: ${response.status}`);
    }

    const data = await response.json();
    const rawModels = data?.data || [];
    const models = rawModels
        .map(m => ({ id: m.id, name: m.id }))
        .sort((a, b) => a.name.localeCompare(b.name));
    if (verbose) logActivity(`Models (direct) HTTP ${response.status}, ${models.length} models loaded from ${preset.name}`);

    modelCache[providerKey] = models;
    return models;
}

/**
 * Clear cached models for a provider.
 * @param {string} providerKey Provider key.
 */
function clearModelCache(providerKey) {
    delete modelCache[providerKey];
    if (providerKey === 'nanogpt') {
        cachedNanoGptModels = null;
    }
}

/**
 * Test the current provider's API connection with a minimal request.
 */
async function testProviderConnection() {
    const providerKey = extension_settings[MODULE_NAME].selectedProvider;
    const preset = PROVIDER_PRESETS[providerKey];
    const $status = $('#charMemory_providerTestStatus');

    if (!preset) {
        $status.text('Unknown provider selected.').css('color', '#e74c3c').show();
        return;
    }

    const providerSettings = getProviderSettings(providerKey);
    if (preset.requiresApiKey && !providerSettings.apiKey) {
        $status.text('Enter an API key first.').css('color', '#e74c3c').show();
        return;
    }

    const $btn = $('#charMemory_providerTest');
    $btn.prop('disabled', true).val('Testing...');
    $status.text('Testing model...').css('color', '').show();

    try {
        const baseUrl = resolveBaseUrl(preset, providerSettings);
        const testModel = providerSettings.model || preset.defaultModel;
        if (!testModel) {
            $status.text('Select a model first, then test.').css('color', '#e67e22').show();
            return;
        }
        const testMessages = [{ role: 'user', content: 'Respond with exactly: CHARMMEMORY_TEST_OK' }];

        const t0 = performance.now();
        let response;
        if (preset.isAnthropic) {
            response = await generateAnthropicResponse(baseUrl, providerSettings.apiKey, testModel, testMessages, 20, preset);
        } else {
            response = await generateOpenAICompatibleResponse(baseUrl, providerSettings.apiKey, testModel, testMessages, 20, preset);
        }
        const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
        const reply = (response || '').trim();
        const passed = reply.includes('CHARMMEMORY_TEST_OK');

        logActivity(`${preset.name} model test: model=${testModel}, reply="${reply}", ${elapsed}s`, passed ? 'success' : 'warn');
        const modelShort = testModel.length > 30 ? testModel.slice(0, 30) + '…' : testModel;
        if (passed) {
            $status.text(`\u2714 ${modelShort} responded correctly (${elapsed}s)`).css('color', '#2ecc71').show();
        } else {
            $status.html(`\u26A0 ${escapeHtml(modelShort)} responded but didn't follow the test instruction (${elapsed}s). Reply: "<b>${escapeHtml(reply.slice(0, 80))}</b>". It may still work for extraction.`).css('color', '#e67e22').show();
        }
    } catch (err) {
        logActivity(`${preset.name} model test failed: ${err.message}`, 'error');
        $status.text(`\u2718 ${err.message || 'Test failed'}`).css('color', '#e74c3c').show();
    } finally {
        $btn.prop('disabled', false).val('Test Model');
    }
}

// Approximate character limit for WebLLM prompt content (leaves room for response)
const WEBLLM_MAX_PROMPT_CHARS = 6000;

/**
 * Truncate a string to a maximum character count, breaking at a newline boundary.
 * @param {string} text The text to truncate.
 * @param {number} maxChars Maximum characters.
 * @returns {string}
 */
function truncateText(text, maxChars) {
    if (!text || text.length <= maxChars) return text;
    const truncated = text.slice(0, maxChars);
    const lastNewline = truncated.lastIndexOf('\n');
    return (lastNewline > maxChars * 0.5 ? truncated.slice(0, lastNewline) : truncated) + '\n[...truncated]';
}

/**
 * Build the extraction prompt with substitutions.
 * @param {string} existingMemories Current memories content.
 * @param {string} recentMessages Formatted recent messages.
 * @returns {string} The final prompt.
 */
function buildExtractionPrompt(existingMemories, recentMessages) {
    const charName = getCharacterName() || '{{char}}';
    let prompt = extension_settings[MODULE_NAME].extractionPrompt;
    const isWebLlm = extension_settings[MODULE_NAME].source === EXTRACTION_SOURCE.WEBLLM;

    let memories = existingMemories || '(none yet)';
    let messages = recentMessages;
    const charCard = getCharacterCardText() || '(not available)';

    // Truncate content for WebLLM's smaller context window
    if (isWebLlm) {
        const templateLength = prompt.replace(/\{\{charName\}\}/g, charName)
            .replace(/\{\{charCard\}\}/g, '')
            .replace(/\{\{existingMemories\}\}/g, '')
            .replace(/\{\{recentMessages\}\}/g, '').length;
        const available = Math.max(WEBLLM_MAX_PROMPT_CHARS - templateLength, 1000);
        // Give 1/3 to existing memories, 2/3 to recent messages
        const memoriesBudget = Math.floor(available / 3);
        const messagesBudget = available - memoriesBudget;
        memories = truncateText(memories, memoriesBudget);
        messages = truncateText(messages, messagesBudget);
    }

    // Do our custom replacements first
    prompt = prompt.replace(/\{\{charName\}\}/g, charName);
    prompt = prompt.replace(/\{\{charCard\}\}/g, charCard);
    prompt = prompt.replace(/\{\{existingMemories\}\}/g, memories);
    prompt = prompt.replace(/\{\{recentMessages\}\}/g, messages);

    // Then let ST handle {{char}}, {{user}}, etc.
    prompt = substituteParamsExtended(prompt);

    return prompt;
}

/**
 * Build extraction prompt for a specific group chat character.
 * @param {string} charName Name of the character to extract memories for.
 * @param {number} charIndex Index into characters array.
 * @param {string} existingMemories Current memories for this character.
 * @param {string} recentMessages Formatted recent group chat messages.
 * @param {{name: string}[]} allMembers All group members (for participants list).
 * @returns {string} The completed prompt.
 */
function buildGroupExtractionPrompt(charName, charIndex, existingMemories, recentMessages, allMembers) {
    let prompt = extension_settings[MODULE_NAME].groupExtractionPrompt;
    const memories = existingMemories || '(none yet)';
    const charCard = getCharacterCardTextFor(charIndex) || '(not available)';

    // Build participants list (everyone except the target character)
    const context = getContext();
    const userName = context.name1 || 'User';
    const otherNames = allMembers
        .filter(m => m.name !== charName)
        .map(m => m.name);
    otherNames.unshift(`${userName} (user)`);
    const participants = otherNames.join(', ');

    prompt = prompt.replace(/\{\{charName\}\}/g, charName);
    prompt = prompt.replace(/\{\{charCard\}\}/g, charCard);
    prompt = prompt.replace(/\{\{existingMemories\}\}/g, memories);
    prompt = prompt.replace(/\{\{recentMessages\}\}/g, recentMessages);
    prompt = prompt.replace(/\{\{participants\}\}/g, participants);

    // Let ST handle {{char}}, {{user}}, etc.
    prompt = substituteParamsExtended(prompt);

    return prompt;
}

/**
 * Run memory extraction for group chats — extracts per-character memories.
 * Each NPC character in the group gets their own extraction call and their
 * memories are written to their own Data Bank file.
 *
 * @param {Object} options
 * @param {boolean} options.force If true, bypass interval check.
 * @param {number|null} options.endIndex Optional end message index (inclusive).
 * @param {function|null} options.onProgress Progress callback.
 * @param {AbortSignal|null} options.abortSignal Abort signal for cancellation.
 * @param {string|null} options.progressLabel Label prefix for toast messages.
 * @returns {Promise<{totalMemories: number, chunksProcessed: number, lastExtractedIndex: number}>}
 */
async function extractGroupMemories({
    force = false,
    endIndex = null,
    onProgress = null,
    abortSignal = null,
    progressLabel = null,
} = {}) {
    const context = getContext();
    const members = getGroupMembers();
    const noopResult = { totalMemories: 0, chunksProcessed: 0, lastExtractedIndex: -1 };

    if (members.length === 0) {
        logActivity('Group extraction: no active group members found', 'warning');
        return noopResult;
    }

    const mode = extension_settings[MODULE_NAME].groupExtractionMode || 'per-character';
    if (mode !== 'per-character') {
        logActivity(`Group extraction mode "${mode}" is not yet implemented, falling back to per-character`, 'warning');
    }

    logActivity(`Group extraction starting for ${members.length} characters: ${members.map(m => m.name).join(', ')}`);

    // Use shared lastExtractedIndex from chat_metadata
    ensureMetadata();
    let currentLastExtracted = chat_metadata[MODULE_NAME].lastExtractedIndex ?? -1;

    const chat = context.chat;
    const effectiveEnd = endIndex !== null ? endIndex + 1 : chat.length;
    const totalUnprocessed = effectiveEnd - (currentLastExtracted + 1);

    if (totalUnprocessed <= 0) {
        logActivity('Group extraction: no new messages to extract', 'warning');
        if (force) {
            toastr.info('No unprocessed messages. Use "Reset Extraction State" to re-read from the beginning.', 'CharMemory', { timeOut: 5000 });
        }
        return noopResult;
    }

    const chunkSize = extension_settings[MODULE_NAME].maxMessagesPerExtraction;
    const totalChunks = Math.ceil(totalUnprocessed / chunkSize);
    const totalSteps = totalChunks * members.length;

    logActivity(`Group extraction: ${totalUnprocessed} messages, ${totalChunks} chunk(s), ${members.length} characters = ${totalSteps} LLM calls`);

    const savedChatId = context.chatId;
    const effectiveChatId = context.chatId || 'unknown';
    const source = extension_settings[MODULE_NAME].source;
    const sourceLabel = getSourceLabel();

    let totalMemories = 0;
    let chunksProcessed = 0;
    let stepsCompleted = 0;

    try {
        inApiCall = true;
        lastExtractionTime = Date.now();

        // Confirmation for large extractions (inside try so inApiCall is set)
        if (force && totalSteps > 6 && !abortSignal) {
            const confirmed = await callGenericPopup(
                `This will process ${totalUnprocessed} messages for ${members.length} characters (${totalSteps} LLM calls). This may take a while. Continue?`,
                POPUP_TYPE.CONFIRM,
            );
            if (!confirmed) {
                logActivity('Group extraction cancelled by user', 'warning');
                return noopResult;
            }
        }

        for (let chunk = 0; chunk < totalChunks; chunk++) {
            if (abortSignal?.aborted) {
                logActivity(`Group extraction aborted after ${chunksProcessed} chunk(s)`, 'warning');
                break;
            }

            // Collect messages for this chunk
            const { text: recentMessages, endIndex: chunkEndIndex } = collectRecentMessages({
                endIndex,
                lastExtractedIdx: currentLastExtracted,
            });

            if (!recentMessages) {
                logActivity(`Chunk ${chunk + 1}: no messages returned, stopping`, 'warning');
                break;
            }

            // Per-character extraction loop
            let chunkAborted = false;
            for (const member of members) {
                if (abortSignal?.aborted) {
                    chunkAborted = true;
                    break;
                }

                stepsCompleted++;
                const prefix = progressLabel ? `${progressLabel} — ` : '';
                const stepInfo = `${member.name} (${stepsCompleted}/${totalSteps})`;
                toastr.info(`${prefix}Extracting for ${stepInfo} via ${sourceLabel}...`, 'CharMemory', { timeOut: 3000 });

                if (onProgress) {
                    onProgress({ chunk: chunk + 1, totalChunks, chunksProcessed, totalMemories, character: member.name, step: stepsCompleted, totalSteps });
                }

                // Read this character's existing memories
                const memFileName = getMemoryFileNameForCharacter(member.name, member.avatar);
                const existingMemories = await readMemoriesForCharacter(member.avatar, memFileName);

                // Build per-character prompt
                const prompt = buildGroupExtractionPrompt(
                    member.name, member.charIndex, existingMemories, recentMessages, members,
                );

                const verbose = extension_settings[MODULE_NAME].verboseLogging;
                if (verbose) {
                    logActivity(`[${member.name}] Prompt (${prompt.length} chars):\n${prompt}`);
                }

                logActivity(`[${member.name}] Sending to ${sourceLabel}...`);
                const llmStartTime = Date.now();
                let result;
                try {
                    result = await callLLM(prompt, extension_settings[MODULE_NAME].responseLength, 'You are a memory extraction assistant.');
                } catch (llmErr) {
                    logActivity(`[${member.name}] LLM error: ${llmErr.message}`, 'error');
                    continue; // Skip this character, try next
                }

                const llmElapsed = ((Date.now() - llmStartTime) / 1000).toFixed(1);
                logActivity(`[${member.name}] Response in ${llmElapsed}s (${(result || '').length} chars)`);
                if (verbose && result) {
                    logActivity(`[${member.name}] Raw response:\n${result}`);
                }

                // Verify context hasn't changed
                const newContext = getContext();
                if (newContext.chatId !== savedChatId) {
                    logActivity('Context changed during group extraction, aborting', 'warning');
                    return { totalMemories, chunksProcessed, lastExtractedIndex: currentLastExtracted };
                }

                let cleanResult = removeReasoningFromString(result);
                cleanResult = cleanResult.trim();

                if (!cleanResult || cleanResult === 'NO_NEW_MEMORIES') {
                    logActivity(`[${member.name}] No new memories for this chunk`);
                    continue;
                }

                // Parse and save memories to this character's Data Bank
                const currentMemories = await readMemoriesForCharacter(member.avatar, memFileName);
                const existing = parseMemories(currentMemories);
                const now = new Date();
                const timestamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

                const memoryRegex = /<memory>([\s\S]*?)<\/memory>/gi;
                const matches = [...cleanResult.matchAll(memoryRegex)];
                const rawEntries = matches.length > 0
                    ? matches.map(m => m[1].trim()).filter(Boolean)
                    : [cleanResult.trim()].filter(Boolean);

                let newBulletCount = 0;
                for (const entry of rawEntries) {
                    const bullets = entry.split('\n')
                        .map(l => l.trim())
                        .filter(l => l.startsWith('- '))
                        .map(l => l.slice(2).trim())
                        .filter(Boolean);
                    const finalBullets = bullets.length > 0 ? bullets : [entry];
                    existing.push({ chat: effectiveChatId, date: timestamp, bullets: finalBullets });
                    newBulletCount += finalBullets.length;
                }

                await writeMemoriesForCharacter(serializeMemories(existing), member.avatar, memFileName);
                totalMemories += newBulletCount;
                logActivity(`[${member.name}] Saved ${newBulletCount} new memor${newBulletCount === 1 ? 'y' : 'ies'}`, 'success');
            }

            // Don't advance index if abort interrupted the character loop
            if (chunkAborted) {
                logActivity(`Chunk ${chunk + 1} aborted mid-character — not advancing index`, 'warning');
                break;
            }

            // Advance lastExtractedIndex after each complete chunk (shared across all characters)
            currentLastExtracted = chunkEndIndex !== -1 ? chunkEndIndex : effectiveEnd - 1;
            ensureMetadata();
            chat_metadata[MODULE_NAME].lastExtractedIndex = currentLastExtracted;
            saveMetadataDebounced();
            logActivity(`Advanced lastExtractedIndex to ${currentLastExtracted}`);

            chunksProcessed++;
        }

        // Merge blocks with same chat+date per character
        if (chunksProcessed > 1 && totalMemories > 0) {
            for (const member of members) {
                const memFileName = getMemoryFileNameForCharacter(member.name, member.avatar);
                const content = await readMemoriesForCharacter(member.avatar, memFileName);
                const allBlocks = parseMemories(content);
                const merged = mergeMemoryBlocks(allBlocks);
                if (merged.length < allBlocks.length) {
                    await writeMemoriesForCharacter(serializeMemories(merged), member.avatar, memFileName);
                    logActivity(`[${member.name}] Merged ${allBlocks.length} blocks → ${merged.length}`);
                }
            }
        }

        // Reset counter
        ensureMetadata();
        chat_metadata[MODULE_NAME].messagesSinceExtraction = 0;
        saveMetadataDebounced();

        updateStatusDisplay();
        updateAllIndicators();

        if (totalMemories > 0) {
            toastr.success(`${totalMemories} memor${totalMemories === 1 ? 'y' : 'ies'} saved across ${members.length} characters from ${chunksProcessed} chunk(s).`, 'CharMemory');
        } else if (chunksProcessed > 0) {
            toastr.info('No new memories found for any group member.', 'CharMemory');
        }

        return { totalMemories, chunksProcessed, lastExtractedIndex: currentLastExtracted };
    } catch (err) {
        console.error(LOG_PREFIX, 'Group extraction failed:', err);
        logActivity(`Group extraction failed: ${err.message}`, 'error');
        toastr.error('Group memory extraction failed. Check console for details.', 'CharMemory');
        return { totalMemories, chunksProcessed, lastExtractedIndex: currentLastExtracted };
    } finally {
        inApiCall = false;
    }
}

/**
 * Run memory extraction.
 * @param {boolean} force If true, ignore interval check.
 * @param {number|null} endIndex Optional end message index (inclusive). Defaults to last message.
 */
async function extractMemories({
    force = false,
    endIndex = null,
    chatArray = null,
    chatId = null,
    lastExtractedIdx = null,
    onProgress = null,
    abortSignal = null,
    progressLabel = null,
} = {}) {
    const noopResult = { totalMemories: 0, chunksProcessed: 0, lastExtractedIndex: lastExtractedIdx ?? -1 };

    if (inApiCall) {
        console.log(LOG_PREFIX, 'Already in API call, skipping');
        return noopResult;
    }

    if (!extension_settings[MODULE_NAME].enabled && !force) {
        return noopResult;
    }

    const context = getContext();
    const isActiveChat = !chatArray;

    if (isActiveChat && context.characterId === undefined && !context.groupId) {
        console.log(LOG_PREFIX, 'No character or group selected');
        return noopResult;
    }

    // Check streaming (only relevant for active chat)
    if (isActiveChat && streamingProcessor && !streamingProcessor.isFinished) {
        console.log(LOG_PREFIX, 'Streaming in progress, skipping');
        return noopResult;
    }

    // Group chat: delegate to per-character extraction
    if (isActiveChat && isGroupChat()) {
        return await extractGroupMemories({ force, endIndex, onProgress, abortSignal, progressLabel });
    }

    // Determine current lastExtractedIndex
    let currentLastExtracted;
    if (lastExtractedIdx !== null) {
        currentLastExtracted = lastExtractedIdx;
    } else {
        ensureMetadata();
        currentLastExtracted = chat_metadata[MODULE_NAME].lastExtractedIndex ?? -1;
    }

    // Calculate total unprocessed messages and chunks
    const chat = chatArray || context.chat;
    const effectiveEnd = endIndex !== null ? endIndex + 1 : chat.length;
    const totalUnprocessed = effectiveEnd - (currentLastExtracted + 1);

    if (totalUnprocessed <= 0) {
        console.log(LOG_PREFIX, 'No new messages to extract');
        logActivity('No new messages to extract — nothing unprocessed', 'warning');
        if (force) {
            toastr.info('No unprocessed messages. Use "Reset Extraction State" to re-read from the beginning.', 'CharMemory', { timeOut: 5000 });
        } else {
            toastr.info('No new messages to extract.', 'CharMemory');
        }
        return noopResult;
    }

    const chunkSize = extension_settings[MODULE_NAME].maxMessagesPerExtraction;
    const totalChunks = Math.ceil(totalUnprocessed / chunkSize);

    logActivity(`Extraction triggered (${force ? 'manual' : 'auto'}), endIndex=${endIndex ?? 'last'}, totalUnprocessed=${totalUnprocessed}, chunks=${totalChunks}`);

    // Confirmation for large manual extractions (>3 chunks, only when force=true)
    if (force && totalChunks > 3 && !abortSignal) {
        const confirmed = await callGenericPopup(
            `This will process ${totalUnprocessed} messages in ${totalChunks} chunks. This may take a while. Continue?`,
            POPUP_TYPE.CONFIRM,
        );
        if (!confirmed) {
            logActivity('Large extraction cancelled by user', 'warning');
            return;
        }
    }

    // Save context identifiers to check for changes after async calls
    const savedCharId = context.characterId;
    const savedChatId = context.chatId;
    const effectiveChatId = chatId || context.chatId || 'unknown';

    const source = extension_settings[MODULE_NAME].source;
    const sourceLabel = getSourceLabel();

    let totalMemories = 0;
    let chunksProcessed = 0;

    try {
        inApiCall = true;
        lastExtractionTime = Date.now();

        for (let chunk = 0; chunk < totalChunks; chunk++) {
            // Check abort signal
            if (abortSignal && abortSignal.aborted) {
                logActivity(`Extraction aborted after ${chunksProcessed} chunk(s)`, 'warning');
                toastr.warning(`Extraction stopped after ${chunksProcessed} of ${totalChunks} chunks.`, 'CharMemory');
                break;
            }

            // Show progress toast
            const prefix = progressLabel ? `${progressLabel} — ` : '';
            const chunkInfo = totalChunks > 1 ? ` (chunk ${chunk + 1}/${totalChunks})` : '';
            toastr.info(`${prefix}Extracting via ${sourceLabel}${chunkInfo}...`, 'CharMemory', { timeOut: 3000 });

            // Call onProgress callback
            if (onProgress) {
                onProgress({ chunk: chunk + 1, totalChunks, chunksProcessed, totalMemories });
            }

            // Collect messages for this chunk
            const { text: recentMessages, endIndex: chunkEndIndex } = collectRecentMessages({
                endIndex: endIndex,
                chatArray: chatArray,
                lastExtractedIdx: currentLastExtracted,
            });

            if (!recentMessages) {
                logActivity(`Chunk ${chunk + 1}: no messages returned, stopping`, 'warning');
                break;
            }

            // Build prompt with current memories (re-read each chunk to include newly extracted)
            const existingMemories = await readMemories();
            const prompt = buildExtractionPrompt(existingMemories, recentMessages);

            const verbose = extension_settings[MODULE_NAME].verboseLogging;
            if (verbose) {
                logActivity(`Prompt sent to ${sourceLabel} (${prompt.length} chars):\n${prompt}`);
            }

            // Call the appropriate LLM
            logActivity(`Sending to ${sourceLabel}... waiting for response`);
            const llmStartTime = Date.now();
            let result;
            try {
                result = await callLLM(prompt, extension_settings[MODULE_NAME].responseLength, 'You are a memory extraction assistant.');
            } catch (llmErr) {
                if (llmErr.message?.includes('WebLLM is not available')) {
                    toastr.error('WebLLM is not available in this browser.', 'CharMemory');
                    return { totalMemories, chunksProcessed, lastExtractedIndex: currentLastExtracted };
                }
                throw llmErr;
            }

            const llmElapsed = ((Date.now() - llmStartTime) / 1000).toFixed(1);
            logActivity(`Response received from ${sourceLabel} in ${llmElapsed}s (${(result || '').length} chars)`);
            if (verbose && result) {
                logActivity(`Raw LLM response:\n${result}`);
            }

            // For active chats: verify context hasn't changed
            if (isActiveChat) {
                const newContext = getContext();
                if (newContext.characterId !== savedCharId || newContext.chatId !== savedChatId) {
                    console.log(LOG_PREFIX, 'Context changed during extraction, discarding result');
                    return { totalMemories, chunksProcessed, lastExtractedIndex: currentLastExtracted };
                }
            }

            let cleanResult = removeReasoningFromString(result);
            cleanResult = cleanResult.trim();

            lastExtractionResult = cleanResult || null;

            if (!cleanResult || cleanResult === 'NO_NEW_MEMORIES') {
                logActivity(`Chunk ${chunk + 1}: LLM returned NO_NEW_MEMORIES — advancing index anyway`);
            } else {
                // Parse existing memory blocks (re-read to get latest)
                const currentMemories = await readMemories();
                const existing = parseMemories(currentMemories);
                const now = new Date();
                const timestamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

                // Parse <memory> blocks from LLM response; fallback: treat entire result as one block
                const memoryRegex = /<memory>([\s\S]*?)<\/memory>/gi;
                const matches = [...cleanResult.matchAll(memoryRegex)];
                const rawEntries = matches.length > 0
                    ? matches.map(m => m[1].trim()).filter(Boolean)
                    : [cleanResult.trim()].filter(Boolean);

                let newBulletCount = 0;
                for (const entry of rawEntries) {
                    const bullets = entry.split('\n')
                        .map(l => l.trim())
                        .filter(l => l.startsWith('- '))
                        .map(l => l.slice(2).trim())
                        .filter(Boolean);
                    // If no bullets found, treat the whole entry as a single bullet
                    const finalBullets = bullets.length > 0 ? bullets : [entry];
                    existing.push({ chat: effectiveChatId, date: timestamp, bullets: finalBullets });
                    newBulletCount += finalBullets.length;
                }

                await writeMemories(serializeMemories(existing));
                totalMemories += newBulletCount;
                logActivity(`Chunk ${chunk + 1}: saved ${newBulletCount} new memor${newBulletCount === 1 ? 'y' : 'ies'}`, 'success');
            }

            // Advance lastExtractedIndex after each chunk
            currentLastExtracted = chunkEndIndex !== -1 ? chunkEndIndex : effectiveEnd - 1;

            // For active chats: save to chat_metadata
            if (isActiveChat) {
                ensureMetadata();
                chat_metadata[MODULE_NAME].lastExtractedIndex = currentLastExtracted;
                saveMetadataDebounced();
                logActivity(`Advanced lastExtractedIndex to ${currentLastExtracted}`);
            }

            chunksProcessed++;
        }

        // Merge blocks with the same chat ID + date (from multi-chunk extraction)
        if (chunksProcessed > 1 && totalMemories > 0) {
            const allBlocks = parseMemories(await readMemories());
            const merged = mergeMemoryBlocks(allBlocks);
            if (merged.length < allBlocks.length) {
                await writeMemories(serializeMemories(merged));
                logActivity(`Merged ${allBlocks.length} blocks → ${merged.length} (combined same-chat chunks)`);
            }
        }

        // Final status updates
        if (isActiveChat) {
            ensureMetadata();
            chat_metadata[MODULE_NAME].messagesSinceExtraction = 0;
            saveMetadataDebounced();
        }

        updateStatusDisplay();
        updateAllIndicators();

        if (totalMemories > 0) {
            toastr.success(`${totalMemories} memor${totalMemories === 1 ? 'y' : 'ies'} saved from ${chunksProcessed} chunk(s).`, 'CharMemory');
        } else if (chunksProcessed > 0) {
            toastr.info('No new memories found.', 'CharMemory');
        }

        return { totalMemories, chunksProcessed, lastExtractedIndex: currentLastExtracted };
    } catch (err) {
        console.error(LOG_PREFIX, 'Extraction failed:', err);
        logActivity(`Extraction failed: ${err.message}`, 'error');
        toastr.error('Memory extraction failed. Check console for details.', 'CharMemory');
        return { totalMemories, chunksProcessed, lastExtractedIndex: currentLastExtracted };
    } finally {
        inApiCall = false;
    }
}

/**
 * Event handler for CHARACTER_MESSAGE_RENDERED.
 */
function onCharacterMessageRendered() {
    if (!extension_settings[MODULE_NAME].enabled) return;

    const context = getContext();
    if (context.characterId === undefined && !context.groupId) return;

    ensureMetadata();
    chat_metadata[MODULE_NAME].messagesSinceExtraction = (chat_metadata[MODULE_NAME].messagesSinceExtraction || 0) + 1;
    saveMetadataDebounced();
    updateStatusDisplay();

    const count = chat_metadata[MODULE_NAME].messagesSinceExtraction;
    const interval = extension_settings[MODULE_NAME].interval;

    if (count >= interval) {
        const cooldownMs = (extension_settings[MODULE_NAME].minCooldownMinutes || 0) * 60000;
        const elapsed = Date.now() - lastExtractionTime;
        if (cooldownMs > 0 && elapsed < cooldownMs) {
            const remaining = Math.ceil((cooldownMs - elapsed) / 60000);
            logActivity(`Extraction skipped: cooldown active (${remaining}m remaining)`, 'warning');
            return;
        }
        extractMemories({ force: false });
    }
}

/**
 * Event handler for CHAT_CHANGED — reset status display.
 */
async function onChatChanged() {
    const context = getContext();
    const chatId = context.chatId || '(none)';
    const charName = getCharacterName() || '(none)';
    const msgCount = context.chat ? context.chat.length : 0;

    logActivity(`Chat changed: "${charName}" chat=${chatId} (${msgCount} messages)`);

    if (context.groupId) {
        const members = getGroupMembers();
        logActivity(`Group chat detected: ${members.map(m => m.name).join(', ')} (${members.length} characters)`);
    }

    ensureMetadata();
    const meta = chat_metadata[MODULE_NAME];
    const lastIdx = meta.lastExtractedIndex ?? -1;

    // Detect stale metadata: lastExtractedIndex is set but no memories exist
    // for this chat. This happens when old code advanced the index even on
    // NO_NEW_MEMORIES. Auto-reset so extraction can run.
    if (lastIdx >= 0) {
        try {
            let hasMemoriesForChat = false;
            if (context.groupId) {
                // For group chats, check any member's Data Bank
                const members = getGroupMembers();
                for (const member of members) {
                    const memFileName = getMemoryFileNameForCharacter(member.name, member.avatar);
                    const content = await readMemoriesForCharacter(member.avatar, memFileName);
                    const blocks = parseMemories(content);
                    if (blocks.some(b => b.chat === chatId || b.chat === 'consolidated' || b.chat === 'unknown')) {
                        hasMemoriesForChat = true;
                        break;
                    }
                }
            } else {
                const content = await readMemories();
                const blocks = parseMemories(content);
                hasMemoriesForChat = blocks.some(b => b.chat === chatId || b.chat === 'consolidated' || b.chat === 'unknown');
            }
            if (!hasMemoriesForChat) {
                meta.lastExtractedIndex = -1;
                saveMetadataDebounced();
                logActivity(`Auto-reset lastExtractedIndex: was ${lastIdx} but no memories found for chat="${chatId}" — stale metadata`, 'warning');
            }
        } catch { /* ignore read errors */ }
    }

    const effectiveLastIdx = meta.lastExtractedIndex ?? -1;
    const unextracted = msgCount > 0 ? msgCount - 1 - effectiveLastIdx : 0;

    logActivity(`Extraction state: lastExtractedIndex=${effectiveLastIdx}, messagesSinceExtraction=${meta.messagesSinceExtraction}, unextracted=${unextracted}`);

    // Seed messagesSinceExtraction with unextracted message count so
    // automatic extraction triggers correctly after switching chats.
    if (unextracted > 0 && meta.messagesSinceExtraction < unextracted) {
        meta.messagesSinceExtraction = unextracted;
        saveMetadataDebounced();
        logActivity(`Seeded messagesSinceExtraction=${unextracted}`);
    }

    updateStatusDisplay();
    updateAllIndicators();

    // Inject buttons on already-rendered messages (with a small delay to
    // ensure the DOM has finished rendering the chat)
    setTimeout(addButtonsToExistingMessages, 500);
}

// ============ Diagnostics ============

/**
 * Capture diagnostics data from WORLD_INFO_ACTIVATED event.
 */
function onWorldInfoActivated(entries) {
    lastDiagnostics.worldInfoEntries = Array.isArray(entries) ? entries.map(e => ({
        comment: e.comment || e.key?.join(', ') || '(unnamed)',
        keys: Array.isArray(e.key) ? e.key : [],
        content: e.content ? e.content.substring(0, 200) : '',
        uid: e.uid,
    })) : [];
}

/**
 * Capture diagnostics from extension prompts after generation.
 */
function captureDiagnostics() {
    const context = getContext();
    lastDiagnostics.extensionPrompts = {};
    lastDiagnostics.timestamp = new Date().toLocaleTimeString();

    if (context.extensionPrompts) {
        for (const [key, value] of Object.entries(context.extensionPrompts)) {
            if (value && value.value) {
                const maxLen = key === '4_vectors_data_bank' ? 2000 : 300;
                lastDiagnostics.extensionPrompts[key] = {
                    label: key,
                    content: typeof value.value === 'string' ? value.value.substring(0, maxLen) : String(value.value).substring(0, maxLen),
                    position: value.position,
                    depth: value.depth,
                };
            }
        }
    }

    // Store in history (keep last 5)
    diagnosticsHistory.unshift({ ...lastDiagnostics, worldInfoEntries: [...lastDiagnostics.worldInfoEntries] });
    if (diagnosticsHistory.length > 5) diagnosticsHistory.pop();

    updateDiagnosticsDisplay();
}

/**
 * Check vectorization status for a file URL.
 * @param {string} fileUrl The attachment URL.
 * @returns {Promise<{chunks: number, source: string, model: string}|false|null>}
 */
async function checkVectorizationStatus(fileUrl) {
    try {
        const vecSettings = extension_settings.vectors;
        if (!vecSettings || !vecSettings.enabled_files) return null;

        const source = vecSettings.source || 'transformers';
        const modelKey = `${source === 'palm' || source === 'vertexai' ? 'google' : source}_model`;
        const model = vecSettings[modelKey] || '';

        const collectionId = `file_${getStringHash(fileUrl)}`;
        const body = { collectionId, source };
        if (model) body.model = model;

        const response = await fetch('/api/vector/list', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(body),
        });
        if (!response.ok) return null;
        const hashes = await response.json();
        return hashes.length > 0 ? { chunks: hashes.length, source, model } : false;
    } catch {
        return null;
    }
}

/**
 * Fetch lorebooks bound to the current character.
 * @returns {Promise<{name: string, entries: {uid: number, keys: string[], content: string}[]}[]>}
 */
async function fetchCharacterLorebooks() {
    const character = characters[this_chid];
    if (!character) return [];

    const bookNames = new Set();

    const primaryWorld = character.data?.extensions?.world;
    if (primaryWorld) bookNames.add(primaryWorld);

    const fileName = getCharaFilename(this_chid);
    const extraCharLore = world_info.charLore?.find(e => e.name === fileName);
    if (extraCharLore?.extraBooks) {
        for (const book of extraCharLore.extraBooks) bookNames.add(book);
    }

    if (bookNames.size === 0) return [];

    const results = [];
    for (const name of bookNames) {
        try {
            const data = await loadWorldInfo(name);
            if (!data?.entries) continue;
            const entries = Object.values(data.entries).map(e => ({
                uid: e.uid,
                keys: Array.isArray(e.key) ? e.key.filter(Boolean) : [],
                content: e.content ? e.content.substring(0, 150) : '',
            }));
            results.push({ name, entries });
        } catch (err) {
            console.error('[CharMemory]', `Failed to load lorebook "${name}":`, err);
        }
    }
    return results;
}

function updateDiagnosticsDisplay() {
    const container = $('#charMemory_diagnosticsContent');
    if (!container.length) return;

    let html = '';

    // Timestamp
    if (lastDiagnostics.timestamp) {
        html += `<div class="charMemory_diagTimestamp">Last capture: ${lastDiagnostics.timestamp}</div>`;
    }

    // Memory Info
    html += '<div class="charMemory_diagSection"><strong>Memories</strong>';
    const memFileName = getMemoryFileName();
    const memAttachment = findMemoryAttachment();
    html += `<div class="charMemory_diagCard">
        <div class="charMemory_diagCardTitle">Active file name</div>
        <div class="charMemory_diagCardContent">${escapeHtml(memFileName)}</div>
    </div>`;
    html += `<div class="charMemory_diagCard">
        <div class="charMemory_diagCardTitle">File status</div>
        <div class="charMemory_diagCardContent">${memAttachment ? 'Exists in Data Bank' : 'Not found in Data Bank'}</div>
    </div>`;

    if (memAttachment) {
        // Async read and update when available
        getFileAttachment(memAttachment.url).then(content => {
            const blocks = parseMemories(content || '');
            const count = countMemories(blocks);
            const countEl = document.getElementById('charMemory_diagMemoryCount');
            if (countEl) countEl.textContent = `${count} (in ${blocks.length} block${blocks.length === 1 ? '' : 's'})`;
        }).catch(() => {});

        // Vectorization status (async)
        checkVectorizationStatus(memAttachment.url).then(result => {
            const vecEl = document.getElementById('charMemory_diagVectorization');
            if (!vecEl) return;
            if (result === null) {
                vecEl.textContent = 'N/A (vectors not enabled for files)';
            } else if (result === false) {
                vecEl.textContent = 'No';
            } else {
                const via = result.model ? `${result.source}/${result.model}` : result.source;
                vecEl.textContent = `Yes (${result.chunks} chunk${result.chunks === 1 ? '' : 's'}) via ${via}`;
            }
        }).catch(() => {});
    }
    const countDisplay = memAttachment ? '...' : '0';
    html += `<div class="charMemory_diagCard">
        <div class="charMemory_diagCardTitle">Memory count</div>
        <div class="charMemory_diagCardContent" id="charMemory_diagMemoryCount">${countDisplay}</div>
    </div>`;
    html += `<div class="charMemory_diagCard">
        <div class="charMemory_diagCardTitle">Vectorization</div>
        <div class="charMemory_diagCardContent" id="charMemory_diagVectorization">${memAttachment ? '...' : 'N/A'}</div>
    </div>`;

    if (lastExtractionResult) {
        const truncated = lastExtractionResult.length > 500
            ? lastExtractionResult.substring(0, 500) + '...'
            : lastExtractionResult;
        html += `<div class="charMemory_diagCard">
            <div class="charMemory_diagCardTitle">Last extraction result</div>
            <div class="charMemory_diagCardContent">${escapeHtml(truncated)}</div>
        </div>`;
    }
    html += '</div>';

    // Injected Memories — last generation
    const dbPrompt = lastDiagnostics.extensionPrompts?.['4_vectors_data_bank'];
    html += '<div class="charMemory_diagSection"><strong>Injected Memories — Last Generation</strong>';
    if (dbPrompt && dbPrompt.content) {
        html += '<div id="charMemory_diagInjected"><div class="charMemory_diagEmpty">Matching...</div></div></div>';
    } else {
        html += '<div class="charMemory_diagEmpty">No memory chunks injected yet (generate a message first)</div></div>';
    }

    if (dbPrompt && dbPrompt.content) {
        // Extract bullet lines directly from injected text — works regardless of
        // chunk boundaries splitting <memory> tags or Injection Template wrappers
        const bullets = dbPrompt.content.split('\n')
            .map(line => line.trim())
            .filter(line => line.startsWith('- '))
            .map(line => line.slice(2).trim())
            .filter(Boolean);

        setTimeout(() => {
            const el = document.getElementById('charMemory_diagInjected');
            if (!el) return;

            if (bullets.length > 0) {
                let bulletHtml = `<div class="charMemory_diagCard"><div class="charMemory_diagCardTitle">${bullets.length} memor${bullets.length === 1 ? 'y' : 'ies'} injected</div>`;
                for (const bullet of bullets) {
                    bulletHtml += `<div class="charMemory_diagCardContent">- ${escapeHtml(bullet)}</div>`;
                }
                bulletHtml += '</div>';
                el.innerHTML = bulletHtml;
            } else {
                const preview = dbPrompt.content.length > 800 ? dbPrompt.content.substring(0, 800) + '...' : dbPrompt.content;
                let fallbackHtml = '<div class="charMemory_diagCard">';
                fallbackHtml += '<div class="charMemory_diagCardTitle">Injected text (no memory bullets found):</div>';
                fallbackHtml += `<div class="charMemory_diagCardContent" style="white-space:pre-wrap;">${escapeHtml(preview)}</div>`;
                fallbackHtml += '</div>';
                el.innerHTML = fallbackHtml;
            }
        }, 0);
    }

    // Character Lorebooks (static)
    html += '<div class="charMemory_diagSection"><strong>Character Lorebooks</strong>';
    html += '<div id="charMemory_diagLorebooks"><div class="charMemory_diagEmpty">Loading...</div></div></div>';

    fetchCharacterLorebooks().then(books => {
        const el = document.getElementById('charMemory_diagLorebooks');
        if (!el) return;
        if (books.length === 0) {
            el.textContent = 'No lorebooks bound to this character';
            el.classList.add('charMemory_diagEmpty');
            return;
        }
        let booksHtml = '';
        for (const book of books) {
            booksHtml += `<div class="charMemory_diagCard">
                <div class="charMemory_diagCardTitle">${escapeHtml(book.name)} (${book.entries.length} entries)</div>`;
            for (const entry of book.entries) {
                const keysStr = entry.keys.length > 0 ? entry.keys.join(', ') : '(no keys)';
                booksHtml += `<div class="charMemory_diagCardKeys">Keys: ${escapeHtml(keysStr)}</div>`;
            }
            booksHtml += '</div>';
        }
        el.innerHTML = booksHtml;
    }).catch(() => {
        const el = document.getElementById('charMemory_diagLorebooks');
        if (el) {
            el.textContent = 'Failed to load lorebooks';
            el.classList.add('charMemory_diagEmpty');
        }
    });

    // Activated Lorebook Entries (runtime)
    const wiEntries = lastDiagnostics.worldInfoEntries;
    html += `<div class="charMemory_diagSection"><strong>Activated Entries — Last Generation (${wiEntries.length})</strong>`;
    if (wiEntries.length > 0) {
        for (const entry of wiEntries) {
            const keysStr = entry.keys.length > 0 ? entry.keys.join(', ') : '(no keys)';
            html += `<div class="charMemory_diagCard">
                <div class="charMemory_diagCardTitle">${escapeHtml(entry.comment)}</div>
                <div class="charMemory_diagCardKeys">Keys: ${escapeHtml(keysStr)}</div>
                <div class="charMemory_diagCardContent">${escapeHtml(entry.content)}${entry.content.length >= 200 ? '...' : ''}</div>
            </div>`;
        }
    } else {
        html += '<div class="charMemory_diagEmpty">No entries activated yet (generate a message first)</div>';
    }
    html += '</div>';

    // Extension Prompts
    const prompts = lastDiagnostics.extensionPrompts;
    const promptKeys = Object.keys(prompts);
    html += `<div class="charMemory_diagSection"><strong>Extension Prompts (${promptKeys.length})</strong>`;
    if (promptKeys.length > 0) {
        for (const key of promptKeys) {
            const p = prompts[key];
            html += `<div class="charMemory_diagCard">
                <div class="charMemory_diagCardTitle">${escapeHtml(p.label)}</div>
                <div class="charMemory_diagCardContent">${escapeHtml(p.content)}${p.content.length >= 300 ? '...' : ''}</div>
            </div>`;
        }
    } else {
        html += '<div class="charMemory_diagEmpty">No extension prompts active</div>';
    }
    html += '</div>';

    container.html(html);
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ============ Memory Manager ============

async function showMemoryManager() {
    const content = await readMemories();
    const blocks = parseMemories(content);

    if (blocks.length === 0) {
        callGenericPopup('No memories yet.', POPUP_TYPE.TEXT);
        return;
    }

    let html = '<div class="charMemory_manager">';
    for (let bi = 0; bi < blocks.length; bi++) {
        const b = blocks[bi];
        const chatLabel = b.chat.length > 16 ? b.chat.slice(0, 16) + '...' : b.chat;
        html += `<div class="charMemory_card" data-block="${bi}">
            <div class="charMemory_cardHeader">
                <span class="charMemory_cardTitle">${escapeHtml(chatLabel)}</span>
                <span class="charMemory_cardTimestamp">${escapeHtml(b.date)}</span>
                <span class="charMemory_cardActions">
                    <button class="charMemory_deleteBlockBtn menu_button menu_button_icon" data-block="${bi}" title="Delete all memories from this chat"><i class="fa-solid fa-trash"></i></button>
                </span>
            </div>
            <div class="charMemory_cardBullets">`;
        for (let bui = 0; bui < b.bullets.length; bui++) {
            html += `<div class="charMemory_bulletRow" data-block="${bi}" data-bullet="${bui}">
                <span class="charMemory_bulletText">- ${escapeHtml(b.bullets[bui])}</span>
                <span class="charMemory_bulletActions">
                    <button class="charMemory_editBtn menu_button menu_button_icon" data-block="${bi}" data-bullet="${bui}" title="Edit"><i class="fa-solid fa-pencil"></i></button>
                    <button class="charMemory_deleteBtn menu_button menu_button_icon" data-block="${bi}" data-bullet="${bui}" title="Delete"><i class="fa-solid fa-trash"></i></button>
                </span>
            </div>`;
        }
        html += '</div></div>';
    }
    html += '</div>';

    const popup = callGenericPopup(html, POPUP_TYPE.TEXT, '', { wide: true, allowVerticalScrolling: true });

    // Wire up event handlers using delegation
    $(document).off('click.charMemoryManager').on('click.charMemoryManager', '.charMemory_editBtn', async function (e) {
        e.stopPropagation();
        const blockIdx = Number($(this).data('block'));
        const bulletIdx = Number($(this).data('bullet'));
        await editMemory(blockIdx, bulletIdx);
    });

    $(document).off('click.charMemoryDelete').on('click.charMemoryDelete', '.charMemory_deleteBtn', async function (e) {
        e.stopPropagation();
        const blockIdx = Number($(this).data('block'));
        const bulletIdx = Number($(this).data('bullet'));
        await deleteMemory(blockIdx, bulletIdx);
    });

    $(document).off('click.charMemoryDeleteBlock').on('click.charMemoryDeleteBlock', '.charMemory_deleteBlockBtn', async function (e) {
        e.stopPropagation();
        const blockIdx = Number($(this).data('block'));
        await deleteBlock(blockIdx);
    });

    // Clean up when popup closes
    popup.finally(() => {
        $(document).off('click.charMemoryManager');
        $(document).off('click.charMemoryDelete');
        $(document).off('click.charMemoryDeleteBlock');
    });
}

function reindexManager() {
    $('.charMemory_manager .charMemory_card').each(function (ci) {
        $(this).attr('data-block', ci);
        $(this).find('.charMemory_deleteBlockBtn').attr('data-block', ci);
        $(this).find('.charMemory_bulletRow').each(function (ri) {
            $(this).attr('data-block', ci).attr('data-bullet', ri);
            $(this).find('.charMemory_editBtn, .charMemory_deleteBtn').attr('data-block', ci).attr('data-bullet', ri);
        });
    });
}

async function editMemory(blockIndex, bulletIndex) {
    const content = await readMemories();
    const blocks = parseMemories(content);

    if (blockIndex < 0 || blockIndex >= blocks.length) return;
    const block = blocks[blockIndex];
    if (bulletIndex < 0 || bulletIndex >= block.bullets.length) return;

    const edited = await callGenericPopup('Edit memory:', POPUP_TYPE.INPUT, block.bullets[bulletIndex], { rows: 3 });

    if (edited === null || edited === false) return; // cancelled

    const newText = String(edited).trim();
    block.bullets[bulletIndex] = newText;
    await writeMemories(serializeMemories(blocks));
    toastr.success('Memory updated.', 'CharMemory');

    // Update DOM in place
    const $row = $(`.charMemory_bulletRow[data-block="${blockIndex}"][data-bullet="${bulletIndex}"]`);
    $row.find('.charMemory_bulletText').text('- ' + newText);
}

async function deleteMemory(blockIndex, bulletIndex) {
    const content = await readMemories();
    const blocks = parseMemories(content);

    if (blockIndex < 0 || blockIndex >= blocks.length) return;
    const block = blocks[blockIndex];
    if (bulletIndex < 0 || bulletIndex >= block.bullets.length) return;

    const confirm = await callGenericPopup(`Delete this memory?\n\n- ${block.bullets[bulletIndex]}`, POPUP_TYPE.CONFIRM);
    if (!confirm) return;

    block.bullets.splice(bulletIndex, 1);

    // Remove block entirely if no bullets remain
    if (block.bullets.length === 0) {
        blocks.splice(blockIndex, 1);
    }

    await writeMemories(serializeMemories(blocks));
    toastr.success('Memory deleted.', 'CharMemory');

    // Update DOM in place
    const $row = $(`.charMemory_bulletRow[data-block="${blockIndex}"][data-bullet="${bulletIndex}"]`);
    const $card = $row.closest('.charMemory_card');
    $row.remove();

    if ($card.find('.charMemory_bulletRow').length === 0) {
        $card.remove();
    }

    if ($('.charMemory_manager .charMemory_card').length === 0) {
        $('.charMemory_manager').html('<div style="text-align:center;padding:1em;">No memories yet.</div>');
    }

    reindexManager();
}

async function deleteBlock(blockIndex) {
    const content = await readMemories();
    const blocks = parseMemories(content);

    if (blockIndex < 0 || blockIndex >= blocks.length) return;
    const block = blocks[blockIndex];

    const confirm = await callGenericPopup(`Delete all ${block.bullets.length} memories from this chat?`, POPUP_TYPE.CONFIRM);
    if (!confirm) return;

    blocks.splice(blockIndex, 1);
    await writeMemories(serializeMemories(blocks));
    toastr.success('Chat memories deleted.', 'CharMemory');

    // Update DOM in place
    $(`.charMemory_card[data-block="${blockIndex}"]`).remove();

    if ($('.charMemory_manager .charMemory_card').length === 0) {
        $('.charMemory_manager').html('<div style="text-align:center;padding:1em;">No memories yet.</div>');
    }

    reindexManager();
}

// ============ Consolidation ============

function buildConsolidationPreview(beforeBlocks, afterBlocks, beforeCount, afterCount) {
    const renderSection = (title, blocks, count) => {
        const cards = blocks.map(b => {
            const bullets = b.bullets.map(bullet => `<li>${escapeHtml(bullet)}</li>`).join('');
            return `<div class="charMemory_card">
                <div class="charMemory_cardHeader"><strong>${escapeHtml(b.chat)}</strong> <span class="charMemory_cardDate">${escapeHtml(b.date)}</span></div>
                <ul>${bullets}</ul>
            </div>`;
        }).join('');
        return `<h3>${title} (${count} memories)</h3>${cards}`;
    };
    return `<div style="display:flex;gap:1em;">
        <div style="flex:1;overflow-y:auto;max-height:60vh;">${renderSection('Before', beforeBlocks, beforeCount)}</div>
        <div style="flex:1;overflow-y:auto;max-height:60vh;">${renderSection('After', afterBlocks, afterCount)}</div>
    </div>`;
}

async function undoConsolidation() {
    if (!consolidationBackup) {
        toastr.warning('No consolidation to undo.', 'CharMemory');
        return;
    }
    const confirm = await callGenericPopup('Undo the last consolidation and restore previous memories?', POPUP_TYPE.CONFIRM);
    if (!confirm) return;
    await writeMemories(consolidationBackup);
    consolidationBackup = null;
    $('#charMemory_undoConsolidate').prop('disabled', true);
    toastr.success('Consolidation undone. Memories restored.', 'CharMemory');
    updateStatusDisplay();
}

const consolidationPrompt = `You are a memory consolidation assistant. Review the following character memories and consolidate them.

RULES:
1. Merge duplicate or near-duplicate memories into one.
2. Combine closely related facts about the same event or topic.
3. Preserve all unique information — do NOT discard distinct memories.
4. Summarize in third person. Do NOT copy text verbatim from the input.
5. Do NOT use emojis anywhere in the output.
6. Each consolidated memory must be wrapped in <memory></memory> tags.
7. Inside each <memory> block, use a markdown bulleted list (lines starting with "- ").

MEMORIES TO CONSOLIDATE:
{{memories}}

Output ONLY <memory> blocks. No headers, no commentary, no extra text.`;

async function consolidateMemories() {
    if (inApiCall) {
        toastr.warning('An API call is already in progress.', 'CharMemory');
        return;
    }

    const content = await readMemories();
    const memories = parseMemories(content);

    if (memories.length < 2) {
        toastr.info('Not enough memories to consolidate.', 'CharMemory');
        return;
    }

    const beforeCount = countMemories(memories);
    logActivity(`Consolidation started: ${beforeCount} memories in ${memories.length} blocks`);

    let memoriesText = memories.map((b, i) =>
        `[Block ${i + 1}]\n${b.bullets.map(bullet => `- ${bullet}`).join('\n')}`,
    ).join('\n\n');

    // Truncate for WebLLM's smaller context window
    const isWebLlm = extension_settings[MODULE_NAME].source === EXTRACTION_SOURCE.WEBLLM;
    if (isWebLlm) {
        const templateLength = consolidationPrompt.replace('{{memories}}', '').length;
        const available = Math.max(WEBLLM_MAX_PROMPT_CHARS - templateLength, 1000);
        memoriesText = truncateText(memoriesText, available);
    }

    let prompt = consolidationPrompt.replace('{{memories}}', memoriesText);
    prompt = substituteParamsExtended(prompt);

    try {
        inApiCall = true;
        const sourceLabel = getSourceLabel();
        toastr.info(`Consolidating ${beforeCount} memories via ${sourceLabel}...`, 'CharMemory', { timeOut: 3000 });

        const verbose = extension_settings[MODULE_NAME].verboseLogging;
        if (verbose) {
            logActivity(`Consolidation prompt sent to ${sourceLabel} (${prompt.length} chars):\n${prompt}`);
        }

        logActivity(`Sending consolidation to ${sourceLabel}... waiting for response`);
        const llmStartTime = Date.now();
        const result = await callLLM(
            prompt,
            extension_settings[MODULE_NAME].responseLength * 2,
            'You are a memory consolidation assistant.',
        );

        const llmElapsed = ((Date.now() - llmStartTime) / 1000).toFixed(1);
        logActivity(`Consolidation response received from ${sourceLabel} in ${llmElapsed}s (${(result || '').length} chars)`);
        if (verbose && result) {
            logActivity(`Raw consolidation response:\n${result}`);
        }

        let cleanResult = removeReasoningFromString(result);
        cleanResult = cleanResult.trim();

        if (!cleanResult) {
            logActivity('Consolidation returned empty result', 'warning');
            toastr.warning('Consolidation returned empty result. Memories unchanged.', 'CharMemory');
            return;
        }

        const now = new Date();
        const timestamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

        const consolidationRegex = /<memory>([\s\S]*?)<\/memory>/gi;
        const consolidationMatches = [...cleanResult.matchAll(consolidationRegex)];
        const rawEntries = consolidationMatches.length > 0
            ? consolidationMatches.map(m => m[1].trim()).filter(Boolean)
            : [cleanResult.trim()].filter(Boolean);

        const consolidated = rawEntries.map(entry => {
            const bullets = entry.split('\n')
                .map(l => l.trim())
                .filter(l => l.startsWith('- '))
                .map(l => l.slice(2).trim())
                .filter(Boolean);
            return { chat: 'consolidated', date: timestamp, bullets: bullets.length > 0 ? bullets : [entry] };
        });

        const afterCount = countMemories(consolidated);
        const previewHtml = buildConsolidationPreview(memories, consolidated, beforeCount, afterCount);
        const confirmed = await callGenericPopup(previewHtml, POPUP_TYPE.CONFIRM, '', { wide: true, allowVerticalScrolling: true });
        if (!confirmed) {
            logActivity('Consolidation cancelled by user');
            toastr.info('Consolidation cancelled.', 'CharMemory');
            return;
        }

        consolidationBackup = content;
        await writeMemories(serializeMemories(consolidated));
        $('#charMemory_undoConsolidate').prop('disabled', false);
        logActivity(`Consolidation complete: ${beforeCount} → ${afterCount} memories`, 'success');
        toastr.success(`Consolidated ${beforeCount} → ${afterCount} memories.`, 'CharMemory');
        updateStatusDisplay();
    } catch (err) {
        console.error(LOG_PREFIX, 'Consolidation failed:', err);
        logActivity(`Consolidation failed: ${err.message}`, 'error');
        toastr.error('Memory consolidation failed. Check console for details.', 'CharMemory');
    } finally {
        inApiCall = false;
    }
}

// ============ Slash Commands ============

function registerSlashCommands() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'extract-memories',
        callback: async () => {
            await extractMemories({ force: true });
            return '';
        },
        helpString: 'Force memory extraction from recent chat messages.',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'consolidate-memories',
        callback: async () => {
            await consolidateMemories();
            return '';
        },
        helpString: 'Consolidate character memories by merging duplicates and related entries.',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'charmemory-debug',
        callback: async () => {
            captureDiagnostics();
            console.log(LOG_PREFIX, 'Diagnostics:', lastDiagnostics);
            console.log(LOG_PREFIX, 'History:', diagnosticsHistory);
            toastr.info('Diagnostics captured. Check console and Diagnostics panel.', 'CharMemory');
            return '';
        },
        helpString: 'Capture and display CharMemory diagnostics data.',
    }));
}

// ============ UI Setup ============

function setupListeners() {
    $('#charMemory_enabled').off('change').on('change', function () {
        extension_settings[MODULE_NAME].enabled = !!$(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#charMemory_interval').off('input').on('input', function () {
        const val = Number($(this).val());
        extension_settings[MODULE_NAME].interval = val;
        $('#charMemory_intervalCounter').val(val);
        saveSettingsDebounced();
        updateStatusDisplay();
    });

    $('#charMemory_maxMessages').off('input').on('input', function () {
        const val = Number($(this).val());
        extension_settings[MODULE_NAME].maxMessagesPerExtraction = val;
        $('#charMemory_maxMessagesCounter').val(val);
        saveSettingsDebounced();
    });

    $('#charMemory_minCooldown').off('input').on('input', function () {
        const val = Number($(this).val());
        extension_settings[MODULE_NAME].minCooldownMinutes = val;
        $('#charMemory_minCooldownCounter').val(val);
        saveSettingsDebounced();
    });

    $('#charMemory_responseLength').off('input').on('input', function () {
        const val = Number($(this).val());
        extension_settings[MODULE_NAME].responseLength = val;
        $('#charMemory_responseLengthCounter').val(val);
        saveSettingsDebounced();
    });

    $('#charMemory_source').off('change').on('change', function () {
        const val = String($(this).val());
        extension_settings[MODULE_NAME].source = val;
        saveSettingsDebounced();
        toggleProviderSettings(val);
    });

    $('#charMemory_providerSelect').off('change').on('change', function () {
        extension_settings[MODULE_NAME].selectedProvider = String($(this).val());
        saveSettingsDebounced();
        $('#charMemory_providerTestStatus').hide().text('');
        $('#charMemory_providerConnectStatus').hide().text('');
        updateProviderUI();
    });

    $('#charMemory_providerApiKey').off('input').on('input', function () {
        const providerKey = extension_settings[MODULE_NAME].selectedProvider;
        const providerSettings = getProviderSettings(providerKey);
        providerSettings.apiKey = String($(this).val());
        saveSettingsDebounced();
    });

    $('#charMemory_providerConnect').off('click').on('click', async function () {
        const providerKey = extension_settings[MODULE_NAME].selectedProvider;
        const preset = PROVIDER_PRESETS[providerKey];
        const providerSettings = getProviderSettings(providerKey);
        const $btn = $(this);
        const $status = $('#charMemory_providerConnectStatus');

        if (preset?.requiresApiKey && !providerSettings.apiKey) {
            $status.text('Enter an API key first.').css('color', '#e74c3c').show();
            return;
        }

        $btn.prop('disabled', true).val('Connecting...');
        $status.text('Fetching models...').css('color', '').show();

        try {
            await populateProviderModels(providerKey, true);
            const modelCount = $('#charMemory_providerModel option').length - 1; // minus placeholder
            if (modelCount > 0) {
                $status.text(`Connected — ${modelCount} model${modelCount !== 1 ? 's' : ''} available.`).css('color', '#27ae60').show();
            } else {
                $status.text('Connected, but no models returned.').css('color', '#e67e22').show();
            }
        } catch (err) {
            $status.text(`Connection failed: ${err.message}`).css('color', '#e74c3c').show();
        } finally {
            $btn.prop('disabled', false).val('Connect');
        }
    });

    $('#charMemory_providerModel').off('change').on('change', async function () {
        const val = String($(this).val());
        const providerKey = extension_settings[MODULE_NAME].selectedProvider;
        const providerSettings = getProviderSettings(providerKey);
        providerSettings.model = val;
        saveSettingsDebounced();
        if (providerKey === 'nanogpt' && cachedNanoGptModels) {
            updateProviderModelInfo(cachedNanoGptModels, val);
        }
    });

    $('#charMemory_providerModelInput').off('input').on('input', function () {
        const providerSettings = getProviderSettings(extension_settings[MODULE_NAME].selectedProvider);
        providerSettings.model = String($(this).val());
        saveSettingsDebounced();
    });

    $('#charMemory_providerRefreshModels').off('click').on('click', function () {
        populateProviderModels(extension_settings[MODULE_NAME].selectedProvider, true);
    });

    $('#charMemory_providerBaseUrl').off('input').on('input', function () {
        const providerSettings = getProviderSettings(extension_settings[MODULE_NAME].selectedProvider);
        providerSettings.customBaseUrl = String($(this).val());
        saveSettingsDebounced();
    });

    $('#charMemory_providerSystemPrompt').off('input').on('input', function () {
        const providerSettings = getProviderSettings(extension_settings[MODULE_NAME].selectedProvider);
        providerSettings.systemPrompt = String($(this).val());
        saveSettingsDebounced();
    });

    $('#charMemory_providerApiKeyReveal').off('click').on('click', function () {
        const $input = $('#charMemory_providerApiKey');
        const $icon = $(this).find('i');
        const $btn = $(this);
        clearTimeout($btn.data('revealTimer'));
        if ($input.attr('type') === 'password') {
            $input.attr('type', 'text');
            $icon.removeClass('fa-eye').addClass('fa-eye-slash');
            $btn.data('revealTimer', setTimeout(() => {
                $input.attr('type', 'password');
                $icon.removeClass('fa-eye-slash').addClass('fa-eye');
            }, 10000));
        } else {
            $input.attr('type', 'password');
            $icon.removeClass('fa-eye-slash').addClass('fa-eye');
        }
    });

    $('#charMemory_providerTest').off('click').on('click', () => testProviderConnection());

    $('#charMemory_nanogptFilterSub').off('change').on('change', function () {
        const providerSettings = getProviderSettings('nanogpt');
        providerSettings.nanogptFilterSubscription = !!$(this).prop('checked');
        saveSettingsDebounced();
        populateProviderModels('nanogpt', true);
    });

    $('#charMemory_nanogptFilterOS').off('change').on('change', function () {
        const providerSettings = getProviderSettings('nanogpt');
        providerSettings.nanogptFilterOpenSource = !!$(this).prop('checked');
        saveSettingsDebounced();
        populateProviderModels('nanogpt', true);
    });

    $('#charMemory_nanogptFilterRP').off('change').on('change', function () {
        const providerSettings = getProviderSettings('nanogpt');
        providerSettings.nanogptFilterRoleplay = !!$(this).prop('checked');
        saveSettingsDebounced();
        populateProviderModels('nanogpt', true);
    });

    $('#charMemory_nanogptFilterReasoning').off('change').on('change', function () {
        const providerSettings = getProviderSettings('nanogpt');
        providerSettings.nanogptFilterReasoning = !!$(this).prop('checked');
        saveSettingsDebounced();
        populateProviderModels('nanogpt', true);
    });

    $('#charMemory_verboseLog').off('change').on('change', function () {
        extension_settings[MODULE_NAME].verboseLogging = !!$(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#charMemory_extractionPrompt').off('input').on('input', function () {
        extension_settings[MODULE_NAME].extractionPrompt = String($(this).val());
        saveSettingsDebounced();
    });

    $('#charMemory_restorePrompt').off('click').on('click', function () {
        extension_settings[MODULE_NAME].extractionPrompt = defaultExtractionPrompt;
        $('#charMemory_extractionPrompt').val(defaultExtractionPrompt);
        saveSettingsDebounced();
        toastr.info('Extraction prompt restored to default.', 'CharMemory');
    });

    $('#charMemory_groupMode').off('change').on('change', function () {
        extension_settings[MODULE_NAME].groupExtractionMode = String($(this).val());
        saveSettingsDebounced();
    });

    $('#charMemory_groupExtractionPrompt').off('input').on('input', function () {
        extension_settings[MODULE_NAME].groupExtractionPrompt = String($(this).val());
        saveSettingsDebounced();
    });

    $('#charMemory_restoreGroupPrompt').off('click').on('click', function () {
        extension_settings[MODULE_NAME].groupExtractionPrompt = defaultGroupExtractionPrompt;
        $('#charMemory_groupExtractionPrompt').val(defaultGroupExtractionPrompt);
        saveSettingsDebounced();
        toastr.info('Group extraction prompt restored to default.', 'CharMemory');
    });

    // Group member filename overrides (event delegation for dynamic inputs)
    $(document).on('input', '.charMemory_groupMemberFile', function () {
        const avatar = $(this).data('avatar');
        const value = String($(this).val()).trim();
        if (!extension_settings[MODULE_NAME].characterFileNames) {
            extension_settings[MODULE_NAME].characterFileNames = {};
        }
        if (value) {
            extension_settings[MODULE_NAME].characterFileNames[avatar] = value;
        } else {
            delete extension_settings[MODULE_NAME].characterFileNames[avatar];
        }
        saveSettingsDebounced();
    });

    $('#charMemory_extractNow').off('click').on('click', function () {
        extractMemories({ force: true });
    });

    $('#charMemory_resetTracking').off('click').on('click', function () {
        ensureMetadata();
        chat_metadata[MODULE_NAME].lastExtractedIndex = -1;
        chat_metadata[MODULE_NAME].messagesSinceExtraction = 0;
        saveMetadataDebounced();

        // Also clear batch state for all chats of this character
        const charName = getCharacterName();
        if (charName && extension_settings[MODULE_NAME].batchState) {
            const prefix = `${charName}:`;
            for (const key of Object.keys(extension_settings[MODULE_NAME].batchState)) {
                if (key.startsWith(prefix)) {
                    delete extension_settings[MODULE_NAME].batchState[key];
                }
            }
            saveSettingsDebounced();
        }

        updateStatusDisplay();
        toastr.success('Extraction state reset for all chats. Next extraction will re-read all messages.', 'CharMemory');
    });

    $('#charMemory_resetExtraction').off('click').on('click', async function () {
        ensureMetadata();
        chat_metadata[MODULE_NAME].lastExtractedIndex = -1;
        chat_metadata[MODULE_NAME].messagesSinceExtraction = 0;
        saveMetadataDebounced();

        // Also clear batch state for all chats of this character
        const charName = getCharacterName();
        if (charName && extension_settings[MODULE_NAME].batchState) {
            const prefix = `${charName}:`;
            for (const key of Object.keys(extension_settings[MODULE_NAME].batchState)) {
                if (key.startsWith(prefix)) {
                    delete extension_settings[MODULE_NAME].batchState[key];
                }
            }
            saveSettingsDebounced();
        }

        // Also clear stored memories so re-extraction starts fresh
        const existing = findMemoryAttachment();
        if (existing) {
            await deleteAttachment(existing, 'character', () => {}, false);
        }

        // Immediately update stats bar to avoid stale async reads
        $('#charMemory_statCount').text('0 memories');
        $('#charMemory_statProgress').text(`0/${extension_settings[MODULE_NAME].interval} msgs`);
        updateStatusDisplay();
        toastr.success('Memories cleared and extraction state reset for all chats. Next extraction will start from the beginning.', 'CharMemory');
    });

    $('#charMemory_fileName').off('input').on('input', function () {
        const val = String($(this).val()).trim();
        extension_settings[MODULE_NAME].fileName = val;
        saveSettingsDebounced();
    });

    $('#charMemory_perChat').off('change').on('change', function () {
        extension_settings[MODULE_NAME].perChat = !!$(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#charMemory_manageMemories').off('click').on('click', () => showMemoryManager());

    $('#charMemory_consolidate').off('click').on('click', () => consolidateMemories());
    $('#charMemory_undoConsolidate').off('click').on('click', () => undoConsolidation());

    // Tab switching for Activity, Diagnostics & Batch panels
    $('.charMemory_tab').off('click').on('click', function () {
        const tab = $(this).data('tab');
        $('.charMemory_tab').removeClass('active');
        $(this).addClass('active');
        $('.charMemory_tabContent').hide();
        const capName = tab.charAt(0).toUpperCase() + tab.slice(1);
        $(`#charMemory_tab${capName}`).show();
        if (tab === 'batch') loadBatchChatList();
    });

    $('#charMemory_refreshDiag').off('click').on('click', function () {
        captureDiagnostics();
        toastr.info('Diagnostics refreshed.', 'CharMemory');
    });

    $('#charMemory_clearLog').off('click').on('click', function () {
        activityLog = [];
        updateActivityLogDisplay();
    });

    $('#charMemory_saveLog').off('click').on('click', function () {
        if (activityLog.length === 0) {
            toastr.info('Activity log is empty.', 'CharMemory');
            return;
        }
        const lines = activityLog.map(e => `[${e.timestamp}] [${e.type}] ${e.message}`).join('\n');
        const blob = new Blob([lines], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `charMemory-log-${new Date().toISOString().slice(0, 19).replace(/:/g, '')}.txt`;
        a.click();
        URL.revokeObjectURL(url);
    });

    // Batch Extract tab
    $('#charMemory_batchRefresh').off('click').on('click', loadBatchChatList);
    $('#charMemory_batchExtract').off('click').on('click', runBatchExtraction);
    $('#charMemory_batchStop').off('click').on('click', function () {
        if (batchAbortController) batchAbortController.abort();
    });
    $('#charMemory_batchSelectAll').off('change').on('change', function () {
        const checked = $(this).prop('checked');
        $('.charMemory_batchChatCheck').prop('checked', checked);
        updateBatchButtons();
    });
    $(document).off('change', '.charMemory_batchChatCheck').on('change', '.charMemory_batchChatCheck', updateBatchButtons);
}

// ============ Per-Message Buttons & Indicators ============

/**
 * Update the memory-extracted indicator on a single message element.
 * @param {jQuery} mesElement The .mes element.
 * @param {number} messageIndex The message index in chat.
 */
function updateIndicatorForMessage(mesElement, messageIndex) {
    const $mes = $(mesElement);
    const $nameBlock = $mes.find('.ch_name');
    // Remove any existing indicator
    $nameBlock.find('.charMemory_extractedIndicator').remove();

    ensureMetadata();
    const lastIdx = chat_metadata[MODULE_NAME]?.lastExtractedIndex ?? -1;
    if (messageIndex <= lastIdx && messageIndex >= 0) {
        $nameBlock.append('<span class="charMemory_extractedIndicator" title="Memory extracted"><i class="fa-solid fa-brain fa-xs"></i></span>');
    }
}

/**
 * Update indicators on all rendered messages.
 */
function updateAllIndicators() {
    ensureMetadata();
    $('#chat .mes').each(function () {
        const mesId = Number($(this).attr('mesid'));
        if (isNaN(mesId)) return;

        const context = getContext();
        const msg = context.chat[mesId];
        // Only show indicator on character messages
        if (!msg || msg.is_user || msg.is_system) return;

        updateIndicatorForMessage(this, mesId);
    });
}

/**
 * Inject per-message buttons on all already-rendered messages.
 * Called on chat load/switch since MESSAGE_RENDERED events only fire for new messages.
 */
function addButtonsToExistingMessages() {
    const context = getContext();
    if (context.characterId === undefined) return;

    $('#chat .mes').each(function () {
        const mesId = Number($(this).attr('mesid'));
        if (isNaN(mesId)) return;

        const msg = context.chat[mesId];
        if (!msg || msg.is_system) return;

        const $extraBtns = $(this).find('.extraMesButtons');
        if (!$extraBtns.length) return;

        // Skip if already injected
        if ($extraBtns.find('.charMemory_extractHereBtn, .charMemory_pinMemoryBtn').length) return;

        // Pin as memory — all non-system messages
        $extraBtns.prepend(`<div class="mes_button charMemory_pinMemoryBtn" data-mesid="${mesId}" title="Pin as memory"><i class="fa-solid fa-bookmark"></i></div>`);

        // Extract from here — character messages only
        if (!msg.is_user) {
            $extraBtns.prepend(`<div class="mes_button charMemory_extractHereBtn" data-mesid="${mesId}" title="Extract memories up to here"><i class="fa-solid fa-brain"></i></div>`);
            updateIndicatorForMessage(this, mesId);
        }
    });
}

/**
 * Add per-message buttons and indicators when a message is rendered.
 * @param {number} messageIndex The index of the rendered message.
 */
function onMessageRenderedAddButtons(messageIndex) {
    const context = getContext();
    if (context.characterId === undefined) return;

    const msg = context.chat[messageIndex];
    if (!msg || msg.is_system) return;

    const $mes = $(`#chat .mes[mesid="${messageIndex}"]`);
    if (!$mes.length) return;

    const $extraBtns = $mes.find('.extraMesButtons');
    if (!$extraBtns.length) return;

    // Remove existing extension buttons to prevent duplicates
    $extraBtns.find('.charMemory_extractHereBtn, .charMemory_pinMemoryBtn').remove();

    // Pin as memory — available on all non-system messages (user + character)
    $extraBtns.prepend(`<div class="mes_button charMemory_pinMemoryBtn" data-mesid="${messageIndex}" title="Pin as memory"><i class="fa-solid fa-bookmark"></i></div>`);

    // Extract from here — character messages only
    if (!msg.is_user) {
        $extraBtns.prepend(`<div class="mes_button charMemory_extractHereBtn" data-mesid="${messageIndex}" title="Extract memories up to here"><i class="fa-solid fa-brain"></i></div>`);
        updateIndicatorForMessage($mes, messageIndex);
    }
}

/**
 * Click handler for "Extract from here" button.
 */
async function onExtractHereClick() {
    const messageIndex = Number($(this).data('mesid'));
    if (isNaN(messageIndex)) return;
    await extractMemories({ force: true, endIndex: messageIndex });
}

/**
 * Click handler for "Pin as memory" button.
 */
async function onPinMemoryClick() {
    const messageIndex = Number($(this).data('mesid'));
    if (isNaN(messageIndex)) return;

    const context = getContext();
    const msg = context.chat[messageIndex];
    if (!msg) return;

    // Strip HTML tags from message text
    const plainText = msg.mes.replace(/<[^>]*>/g, '').trim();
    if (!plainText) {
        toastr.warning('Message has no text content.', 'CharMemory');
        return;
    }

    const edited = await callGenericPopup('Edit text to save as a memory:', POPUP_TYPE.INPUT, plainText, { rows: 6 });
    if (edited === null || edited === false) return; // cancelled

    const text = String(edited).trim();
    if (!text) return;

    // Parse lines into bullets
    const bullets = text.split('\n')
        .map(l => l.trim())
        .filter(Boolean)
        .map(l => l.startsWith('- ') ? l.slice(2).trim() : l)
        .filter(Boolean);

    if (bullets.length === 0) return;

    const now = new Date();
    const timestamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const chatId = context.chatId || 'unknown';

    const existingContent = await readMemories();
    const blocks = parseMemories(existingContent);
    blocks.push({ chat: chatId, date: timestamp, bullets });
    await writeMemories(serializeMemories(blocks));

    toastr.success(`${bullets.length} memor${bullets.length === 1 ? 'y' : 'ies'} pinned!`, 'CharMemory');
    updateStatusDisplay();
}

// ============ Batch Extraction ============

let batchAbortController = null;

async function loadBatchChatList() {
    const $list = $('#charMemory_batchChatList');
    $list.html('<div class="charMemory_diagEmpty">Loading...</div>');

    const chats = await fetchCharacterChats();
    if (chats.length === 0) {
        $list.html('<div class="charMemory_diagEmpty">No chats found for this character.</div>');
        return;
    }

    const context = getContext();
    const currentChatId = context.chatId;

    const html = chats.map(chat => {
        const name = chat.file_name.replace('.jsonl', '');
        const count = chat.chat_items || '?';
        const isCurrent = name === currentChatId;
        const label = isCurrent ? `${name} (current)` : name;
        let lastMsg = '';
        if (chat.last_mes) {
            const d = new Date(chat.last_mes);
            if (!isNaN(d.getTime())) lastMsg = d.toLocaleDateString();
        }

        const safeName = name.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
        const safeLabel = label.replace(/&/g, '&amp;').replace(/</g, '&lt;');
        return `<div class="charMemory_batchChatItem">
            <label class="checkbox_label">
                <input type="checkbox" class="charMemory_batchChatCheck" data-filename="${safeName}" checked />
                <span class="charMemory_batchChatName" title="${safeName}">${safeLabel}</span>
            </label>
            <span class="charMemory_batchChatMeta">${count} msgs${lastMsg ? ' | ' + lastMsg : ''}</span>
        </div>`;
    }).join('');

    $list.html(html);
    $('#charMemory_batchSelectAll').prop('checked', true);
    updateBatchButtons();
}

function updateBatchButtons() {
    const anyChecked = $('.charMemory_batchChatCheck:checked').length > 0;
    $('#charMemory_batchExtract').prop('disabled', !anyChecked);
}

async function runBatchExtraction() {
    const selected = [];
    $('.charMemory_batchChatCheck:checked').each(function () {
        selected.push(String($(this).data('filename')));
    });

    if (selected.length === 0) return;

    const confirmed = await callGenericPopup(
        `Extract memories from ${selected.length} chat(s)? This may make multiple API calls per chat.`,
        POPUP_TYPE.CONFIRM,
    );
    if (!confirmed) return;

    batchAbortController = new AbortController();
    const $progress = $('#charMemory_batchProgress');
    const $progressText = $progress.find('.charMemory_batchProgressText');
    const $progressFill = $progress.find('.charMemory_batchProgressFill');
    $progress.show();
    $progressFill.css('width', '0%');
    $('#charMemory_batchStop').show();
    $('#charMemory_batchExtract').prop('disabled', true);
    $('#charMemory_batchRefresh').prop('disabled', true);

    let totalMemories = 0;
    const context = getContext();
    const currentChatId = context.chatId;

    logActivity(`Batch extraction started: ${selected.length} chat(s) selected`);

    for (let i = 0; i < selected.length; i++) {
        if (batchAbortController.signal.aborted) break;

        const chatName = selected[i];
        const pct = Math.round((i / selected.length) * 100);
        $progressText.text(`Chat ${i + 1}/${selected.length}: ${chatName}`);
        $progressFill.css('width', `${pct}%`);

        logActivity(`Batch: starting chat "${chatName}" (${i + 1}/${selected.length})`);

        const batchProgressLabel = `Chat ${i + 1}/${selected.length}: ${chatName}`;

        // If this is the current chat, use the active context
        if (chatName === currentChatId) {
            const result = await extractMemories({
                force: true,
                abortSignal: batchAbortController.signal,
                progressLabel: batchProgressLabel,
                onProgress: ({ chunk, totalChunks }) => {
                    $progressText.text(`${batchProgressLabel} (chunk ${chunk}/${totalChunks})`);
                },
            });
            totalMemories += result.totalMemories;
            continue;
        }

        // Fetch chat from server
        const chatData = await fetchChatMessages(chatName);
        if (!chatData || chatData.messages.length === 0) {
            logActivity(`Batch: chat "${chatName}" has no messages, skipping`, 'warning');
            continue;
        }

        // Get batch extraction state for this chat
        const batchStateKey = `${getCharacterName()}:${chatName}`;
        if (!extension_settings[MODULE_NAME].batchState) {
            extension_settings[MODULE_NAME].batchState = {};
        }
        const lastIdx = extension_settings[MODULE_NAME].batchState[batchStateKey]?.lastExtractedIndex ?? -1;

        const result = await extractMemories({
            force: true,
            chatArray: chatData.messages,
            chatId: chatName,
            lastExtractedIdx: lastIdx,
            abortSignal: batchAbortController.signal,
            progressLabel: batchProgressLabel,
            onProgress: ({ chunk, totalChunks }) => {
                $progressText.text(`${batchProgressLabel} (chunk ${chunk}/${totalChunks})`);
            },
        });

        // Save batch state
        if (result.lastExtractedIndex !== undefined) {
            extension_settings[MODULE_NAME].batchState[batchStateKey] = {
                lastExtractedIndex: result.lastExtractedIndex,
            };
            saveSettingsDebounced();
        }

        totalMemories += result.totalMemories;
    }

    // Done
    $progressFill.css('width', '100%');
    const aborted = batchAbortController.signal.aborted;
    $progressText.text(aborted
        ? `Stopped. ${totalMemories} memories extracted before cancellation.`
        : `Done! ${totalMemories} memories extracted from ${selected.length} chat(s).`
    );
    $('#charMemory_batchStop').hide();
    $('#charMemory_batchExtract').prop('disabled', false);
    $('#charMemory_batchRefresh').prop('disabled', false);
    batchAbortController = null;

    logActivity(`Batch extraction ${aborted ? 'stopped' : 'complete'}: ${totalMemories} memories from ${selected.length} chats`, aborted ? 'warning' : 'success');
    updateStatusDisplay();
}

// ============ Init ============

jQuery(async function () {
    const settingsHtml = await renderExtensionTemplateAsync('third-party/sillytavern-character-memory', 'settings');
    $('#extensions_settings2').append(settingsHtml);

    loadSettings();
    setupListeners();
    registerSlashCommands();

    // Event hooks
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onCharacterMessageRendered);
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);

    // Per-message buttons and indicators
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onMessageRenderedAddButtons);
    eventSource.on(event_types.USER_MESSAGE_RENDERED, onMessageRenderedAddButtons);
    $(document).on('click', '.charMemory_extractHereBtn', onExtractHereClick);
    $(document).on('click', '.charMemory_pinMemoryBtn', onPinMemoryClick);

    // Diagnostics hooks
    eventSource.on(event_types.WORLD_INFO_ACTIVATED, onWorldInfoActivated);
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, captureDiagnostics);

    console.log(LOG_PREFIX, 'Extension loaded');
});
