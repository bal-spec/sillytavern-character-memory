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
// convertPreviewResult removed — conversion state now lives in the dialog closure
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
    if ($container.length) {
        if (activityLog.length === 0) {
            $container.html('<div class="charMemory_diagEmpty">No activity yet.</div>');
        } else {
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
    }

    // Update mini-log (last 3 entries, first line only)
    const $miniLog = $('#charMemory_miniLogContent');
    if (!$miniLog.length) return;

    if (activityLog.length === 0) {
        $miniLog.html('<div class="charMemory_diagEmpty charMemory_miniLogEmpty">No activity yet.</div>');
        return;
    }

    const miniEntries = activityLog.slice(0, 3);
    const miniHtml = miniEntries.map(entry => {
        const typeClass = `charMemory_log_${entry.type}`;
        const msgText = entry.message.split('\n')[0];
        return `<div class="charMemory_logEntry ${typeClass}"><span class="charMemory_logTime">${entry.timestamp}</span> ${escapeHtml(msgText)}</div>`;
    }).join('');
    $miniLog.html(miniHtml);
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
- Dates and times when mentioned or clearly implied in the conversation

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

const defaultConversionPrompt = `You are converting a text file into a structured memory format for {{charName}}.

The input contains facts, memories, or notes in an unstructured format. Your task is to restructure this into clean, organized memory blocks.

Rules:
1. Extract every distinct fact or piece of information as a bullet point starting with "- ".
2. Group related facts into <memory chat="[Topic Name]" date="[today]"> blocks where Topic Name is a short descriptive label (e.g. "Appearance", "Relationships", "Key Events").
3. Preserve ALL information — do not summarize, combine, or omit anything from the source.
4. Do not add facts, inferences, or details not explicitly stated in the source.
5. Clean up grammar and formatting, but do not change the meaning.
6. Skip formatting artifacts, HTML tags, and metadata that aren't actual memories.

Source text to restructure:
{{sourceText}}`;

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
    mergeChunks: false,
    extractionPrompt: defaultExtractionPrompt,
    consolidationStrategy: 'balanced',
    consolidationPrompts: {},
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
    groupExtractionPrompt: defaultGroupExtractionPrompt,
    characterFileNames: {},
    chunkBoundary: 'block',
    customSeparator: '\\n\\n',
    chunkMetadata: false,
    conversionPrompt: '',
    injectionDrawerOpen: false,
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
        const chat = chatMatch ? unescapeAttr(chatMatch[1]) : 'unknown';
        const date = dateMatch ? unescapeAttr(dateMatch[1]) : '';

        // Extract bullets (lines starting with "- " or metadata-prefixed "[...] - ")
        const bullets = body.split('\n')
            .map(line => line.trim())
            .filter(line => line.startsWith('- ') || /^\[.*?\]\s*-\s/.test(line))
            .map(line => {
                // Strip metadata prefix if present: "[date | chat] - text" → "text"
                const metaMatch = line.match(/^\[.*?\]\s*-\s+(.+)/);
                if (metaMatch) return metaMatch[1].trim();
                return line.slice(2).trim();
            })
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
function escapeAttr(text) {
    return String(text).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

function unescapeAttr(text) {
    return String(text).replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

/**
 * Get the current memory format options from settings.
 * @returns {{boundary: string, separator: string, metadata: boolean}}
 */
function getFormatOptions() {
    const s = extension_settings[MODULE_NAME] || {};
    const boundary = s.chunkBoundary || 'block';
    let separator = '\n\n';
    if (boundary === 'custom' && s.customSeparator) {
        separator = s.customSeparator.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
    }
    return { boundary, separator, metadata: !!s.chunkMetadata };
}

function serializeMemories(blocks, formatOverride) {
    const fmt = formatOverride || getFormatOptions();

    if (fmt.boundary === 'bullet') {
        // Bullet-level: \n\n between each bullet for VS chunking.
        // <memory> tags are preserved so parseMemories() can round-trip.
        return blocks.map(b => {
            const bulletsText = b.bullets.map(bullet => {
                if (fmt.metadata) {
                    return `[${b.date} | ${b.chat}] - ${bullet}`;
                }
                return `- ${bullet}`;
            }).join('\n\n');
            return `<memory chat="${escapeAttr(b.chat)}" date="${escapeAttr(b.date)}">\n${bulletsText}\n</memory>`;
        }).join('\n\n');
    }

    if (fmt.boundary === 'custom') {
        // Custom separator between blocks, optional metadata
        return blocks.map(b => {
            const bulletsText = b.bullets.map(bullet => {
                if (fmt.metadata) {
                    return `[${b.date} | ${b.chat}] - ${bullet}`;
                }
                return `- ${bullet}`;
            }).join('\n');
            return `<memory chat="${escapeAttr(b.chat)}" date="${escapeAttr(b.date)}">\n${bulletsText}\n</memory>`;
        }).join(fmt.separator);
    }

    // Default block-level: unchanged original behavior
    return blocks.map(b => {
        const bulletsText = b.bullets.map(bullet => `- ${bullet}`).join('\n');
        return `<memory chat="${escapeAttr(b.chat)}" date="${escapeAttr(b.date)}">\n${bulletsText}\n</memory>`;
    }).join('\n\n');
}

/**
 * Re-read, re-parse, and re-serialize a memory file with the active format settings.
 * @param {string} avatar Character avatar filename.
 * @param {string} fileName Memory filename.
 * @returns {Promise<{blocks: number, bullets: number}|null>} Counts, or null if no file found.
 */
async function reformatExistingMemories(avatar, fileName) {
    const content = await readMemoriesForCharacter(avatar, fileName);
    if (!content || !content.trim()) return null;

    const blocks = parseMemories(content);
    if (blocks.length === 0) return null;

    const reformatted = serializeMemories(blocks);
    await writeMemoriesForCharacter(reformatted, avatar, fileName);
    logActivity(`Reformatted ${countMemories(blocks)} memories in ${blocks.length} blocks to ${extension_settings[MODULE_NAME].chunkBoundary} format`);
    return { blocks: blocks.length, bullets: countMemories(blocks) };
}

/**
 * After a format setting change, offer to reformat existing memory files.
 */
async function offerReformat() {
    const targets = getMemoryTargets();
    if (targets.length === 0) return;

    let totalBullets = 0;
    let totalBlocks = 0;
    for (const target of targets) {
        const content = await readMemoriesForCharacter(target.avatar, target.fileName);
        if (content && content.trim()) {
            const blocks = parseMemories(content);
            totalBlocks += blocks.length;
            totalBullets += countMemories(blocks);
        }
    }

    if (totalBullets === 0) return;

    const result = await callGenericPopup(
        `Reformat existing memories to match the new format?\n\nThis will rewrite ${totalBullets} memories in ${totalBlocks} blocks.`,
        POPUP_TYPE.CONFIRM,
    );

    if (result) {
        for (const target of targets) {
            await reformatExistingMemories(target.avatar, target.fileName);
        }
        toastr.success(`Reformatted ${totalBullets} memories.`, 'CharMemory');
        updateStatusDisplay();
    }
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

/**
 * Detect the format of a Data Bank file's content.
 * @param {string} content Raw file content.
 * @returns {'memory_tags'|'memory_headings'|'bullets'|'numbered'|'markdown_headings'|'freeform'}
 */
function detectFileFormat(content) {
    if (!content || !content.trim()) return 'freeform';
    if (/<memory\b[^>]*>/i.test(content)) return 'memory_tags';
    if (/^## Memory \d+/m.test(content)) return 'memory_headings';
    const lines = content.split('\n').filter(l => l.trim());
    const bulletLines = lines.filter(l => /^\s*[-*]\s/.test(l));
    if (bulletLines.length > lines.length * 0.4) return 'bullets';
    const numberedLines = lines.filter(l => /^\s*\d+[\.\)]\s/.test(l));
    if (numberedLines.length > lines.length * 0.3) return 'numbered';
    if (/^#{1,3}\s+.+/m.test(content)) return 'markdown_headings';
    return 'freeform';
}

/**
 * Convert file content to <memory> tag format using heuristic parsing.
 * @param {string} content Raw file content.
 * @param {string} format Detected format from detectFileFormat().
 * @returns {{blocks: {chat: string, date: string, bullets: string[]}[], warnings: string[]}}
 */
function convertHeuristic(content, format) {
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const warnings = [];

    if (format === 'memory_tags') {
        warnings.push('Already in CharMemory format — no conversion needed.');
        return { blocks: parseMemories(content), warnings };
    }

    if (format === 'memory_headings') {
        const migrated = migrateMemoriesIfNeeded(content);
        return { blocks: parseMemories(migrated), warnings };
    }

    if (format === 'bullets') {
        const lines = content.split('\n');
        const bullets = [];
        for (const line of lines) {
            const match = line.match(/^\s*[-*]\s+(.+)/);
            if (match) bullets.push(match[1].trim());
        }
        return {
            blocks: [{ chat: 'imported', date: today, bullets }],
            warnings,
        };
    }

    if (format === 'numbered') {
        const lines = content.split('\n');
        const bullets = [];
        for (const line of lines) {
            const match = line.match(/^\s*\d+[\.\)]\s+(.+)/);
            if (match) bullets.push(match[1].trim());
        }
        return {
            blocks: [{ chat: 'imported', date: today, bullets }],
            warnings,
        };
    }

    if (format === 'markdown_headings') {
        const blocks = [];
        let currentHeading = 'imported';
        let currentBullets = [];
        for (const line of content.split('\n')) {
            const headingMatch = line.match(/^#{1,3}\s+(.+)/);
            if (headingMatch) {
                if (currentBullets.length > 0) {
                    blocks.push({ chat: currentHeading, date: today, bullets: currentBullets });
                    currentBullets = [];
                }
                currentHeading = headingMatch[1].trim();
                continue;
            }
            const bulletMatch = line.match(/^\s*[-*]\s+(.+)/);
            if (bulletMatch) {
                currentBullets.push(bulletMatch[1].trim());
            } else if (line.trim()) {
                currentBullets.push(line.trim());
            }
        }
        if (currentBullets.length > 0) {
            blocks.push({ chat: currentHeading, date: today, bullets: currentBullets });
        }
        return { blocks, warnings };
    }

    // Freeform: split on sentences
    const sentences = content.replace(/\n/g, ' ').split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);
    if (sentences.length === 0) {
        warnings.push('File appears empty.');
        return { blocks: [], warnings };
    }
    warnings.push('Freeform text detected — results may be rough. Consider using LLM restructuring for better quality.');
    return {
        blocks: [{ chat: 'imported', date: today, bullets: sentences }],
        warnings,
    };
}

/**
 * Convert file content to <memory> tag format using LLM.
 * @param {string} content Raw file content.
 * @param {string} charName Character name for prompt.
 * @returns {Promise<{blocks: {chat: string, date: string, bullets: string[]}[], warnings: string[]}>}
 */
async function convertWithLLM(content, charName) {
    const warnings = [];
    const prompt = (extension_settings[MODULE_NAME].conversionPrompt || defaultConversionPrompt)
        .replace(/\{\{charName\}\}/g, charName)
        .replace(/\{\{sourceText\}\}/g, content);

    let response;
    try {
        response = await callLLM(prompt, extension_settings[MODULE_NAME].responseLength || 2000, 'You are a text restructuring assistant. Preserve all information faithfully.');
    } catch (err) {
        console.error(LOG_PREFIX, 'LLM conversion failed:', err);
        return { blocks: [], warnings: [`LLM call failed: ${err.message || 'Unknown error'}`] };
    }

    if (!response || !response.trim()) {
        warnings.push('LLM returned an empty response.');
        return { blocks: [], warnings };
    }

    const blocks = parseMemories(response);
    if (blocks.length === 0) {
        // LLM may have returned plain bullets without <memory> tags — wrap them
        const lines = response.split('\n').map(l => l.trim()).filter(l => l.startsWith('- '));
        if (lines.length > 0) {
            const now = new Date();
            const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
            return {
                blocks: [{ chat: 'imported', date: today, bullets: lines.map(l => l.slice(2).trim()) }],
                warnings: ['LLM did not use <memory> tags — bullets wrapped automatically.'],
            };
        }
        warnings.push('LLM response could not be parsed into memories.');
    }

    return { blocks, warnings };
}

/**
 * Build the HTML for the conversion preview dialog.
 */
function buildConversionDialog(sourceContent, formatLabel, method, convertedBlocks, editingSet, useLLM) {
    const afterCount = countMemories(convertedBlocks);
    const hasEditing = editingSet.size > 0;
    const memoryFileName = getMemoryFileName();

    return `<div class="charMemory_consolidationDialog">
        <div class="charMemory_consolidationStats" id="charMemory_convStats">
            Detected: ${escapeHtml(formatLabel)} &bull; Method: <span id="charMemory_convMethod">${escapeHtml(method)}</span> &bull; Result: <span id="charMemory_convAfterCount">${afterCount}</span> memories in <span id="charMemory_convBlockCount">${convertedBlocks.length}</span> block(s)
        </div>
        <div class="charMemory_consolidationToolbar">
            <label class="checkbox_label" style="margin-right:8px;white-space:nowrap;">
                <input type="checkbox" id="charMemory_convDialogLLM" ${useLLM ? 'checked' : ''} />
                <span>Use LLM</span>
            </label>
            <input type="button" id="charMemory_rerunConversion" class="menu_button" value="Re-run" title="Re-parse the source file with current settings" />
            <input type="button" id="charMemory_undoConvRerun" class="menu_button" value="Undo" title="Revert to previous version" disabled />
            <span id="charMemory_convRerunSpinner" style="display:none;">Working...</span>
        </div>
        <div class="charMemory_consolidationPanes">
            <div class="charMemory_consolidationPane">
                <h4>Original File</h4>
                <div class="charMemory_consolidationContent"><pre class="charMemory_convertSourcePre">${escapeHtml(sourceContent)}</pre></div>
            </div>
            <div class="charMemory_consolidationPane">
                <h4>Converted Memories</h4>
                <div class="charMemory_consolidationContent" id="charMemory_convEditorPane">${renderConsolidatedCards(convertedBlocks, editingSet)}</div>
                <button class="charMemory_editorAddBlock menu_button ${hasEditing ? '' : 'charMemory_editorAddBlock--hidden'}" id="charMemory_convAddBlock"><i class="fa-solid fa-plus fa-xs"></i> Add Block</button>
            </div>
        </div>
        <div class="charMemory_convOutputSection">
            <div class="charMemory_convertWarning">
                <i class="fa-solid fa-triangle-exclamation fa-sm"></i>
                The original file will <b>not</b> be deleted. Hide or remove it from the Data Bank to avoid duplicate memories.
            </div>
            <div class="charMemory_convDestRow">
                <small><b>Output to:</b></small>
                <label class="radio_label">
                    <input type="radio" name="charMemory_convDest" value="auto" checked />
                    <span>CharMemory file (${escapeHtml(memoryFileName)})</span>
                </label>
                <label class="radio_label">
                    <input type="radio" name="charMemory_convDest" value="custom" />
                    <span>Custom:</span>
                    <input type="text" id="charMemory_convCustomName" class="text_pole" placeholder="my-memories.md" style="flex:1;max-width:200px;" disabled />
                </label>
            </div>
        </div>
    </div>`;
}

/**
 * Parse the selected source file and show an interactive conversion preview dialog.
 * The dialog uses the same editable-card pattern as the consolidation feature.
 */
async function previewConversion() {
    if (inApiCall) {
        toastr.warning('An API call is already in progress.', 'CharMemory');
        return;
    }

    const fileUrl = $('#charMemory_convertSource').val();
    if (!fileUrl) {
        toastr.warning('Select a source file first.', 'CharMemory');
        return;
    }

    let sourceContent;
    try {
        sourceContent = await getFileAttachment(fileUrl);
    } catch (err) {
        console.error(LOG_PREFIX, 'Failed to read source file:', err);
        toastr.error('Could not read the selected file.', 'CharMemory');
        return;
    }
    if (!sourceContent) {
        toastr.error('Could not read the selected file.', 'CharMemory');
        return;
    }

    const format = detectFileFormat(sourceContent);
    const formatLabels = {
        memory_tags: 'CharMemory <memory> tags',
        memory_headings: 'Old CharMemory (## Memory N)',
        bullets: 'Bullet list',
        numbered: 'Numbered list',
        markdown_headings: 'Markdown with headings',
        freeform: 'Freeform text',
    };

    const useLLM = $('#charMemory_convertUseLLM').prop('checked');
    let result;

    try {
        inApiCall = true;
        if (useLLM && format !== 'memory_tags') {
            const charName = getCharacterName() || 'Character';
            toastr.info('Sending to LLM for restructuring...', 'CharMemory', { timeOut: 3000 });
            result = await convertWithLLM(sourceContent, charName);
        } else {
            result = convertHeuristic(sourceContent, format);
        }
    } catch (err) {
        console.error(LOG_PREFIX, 'Conversion failed:', err);
        toastr.error(`Conversion failed: ${err.message || 'Unknown error'}`, 'CharMemory');
        return;
    } finally {
        inApiCall = false;
    }

    for (const w of result.warnings) {
        toastr.warning(w, 'CharMemory');
    }

    // memory_tags format needs no conversion — heuristic already warned the user
    if (format === 'memory_tags') {
        return;
    }

    if (result.blocks.length === 0) {
        toastr.warning('No memories could be extracted from the file.', 'CharMemory');
        return;
    }

    // === Editor state (lives in closure, survives popup DOM lifecycle) ===
    let editorBlocks = result.blocks.map(b => ({ ...b, bullets: [...b.bullets] }));
    const versionStack = [];
    const editingSet = new Set();
    let destType = 'auto';
    let destCustomName = '';
    let dialogClosed = false; // cancellation flag for in-flight re-run callbacks
    const cloneBlocks = (blocks) => blocks.map(b => ({ ...b, bullets: [...b.bullets] }));

    const refreshEditor = () => {
        $('#charMemory_convEditorPane').html(renderConsolidatedCards(editorBlocks, editingSet));
        $('#charMemory_convAfterCount').text(countMemories(editorBlocks));
        $('#charMemory_convBlockCount').text(editorBlocks.length);
        $('#charMemory_convAddBlock').toggleClass('charMemory_editorAddBlock--hidden', editingSet.size === 0);
    };

    // Build and show dialog
    const formatLabel = formatLabels[format] || format;
    const method = useLLM && format !== 'memory_tags' ? 'LLM' : 'Heuristic';
    const dialogHtml = buildConversionDialog(sourceContent, formatLabel, method, editorBlocks, editingSet, useLLM && format !== 'memory_tags');
    const popup = callGenericPopup(dialogHtml, POPUP_TYPE.CONFIRM, '', { wide: true, allowVerticalScrolling: true });

    // === Editor event delegation (same card classes as consolidation, different namespaces) ===

    $(document).off('click.charMemoryConvToggle').on('click.charMemoryConvToggle', '.charMemory_editorToggleEdit', function () {
        const bi = Number($(this).data('block'));
        if (editingSet.has(bi)) editingSet.delete(bi);
        else editingSet.add(bi);
        refreshEditor();
    });

    $(document).off('input.charMemoryConvBullet').on('input.charMemoryConvBullet', '.charMemory_editorBulletInput', function () {
        const bi = Number($(this).data('block'));
        const bui = Number($(this).data('bullet'));
        if (editorBlocks[bi]) editorBlocks[bi].bullets[bui] = $(this).val();
    });

    $(document).off('input.charMemoryConvTheme').on('input.charMemoryConvTheme', '.charMemory_editorThemeInput', function () {
        const bi = Number($(this).data('block'));
        if (editorBlocks[bi]) editorBlocks[bi].chat = $(this).val();
    });

    $(document).off('click.charMemoryConvDelBullet').on('click.charMemoryConvDelBullet', '.charMemory_editorDeleteBullet', function () {
        const bi = Number($(this).data('block'));
        const bui = Number($(this).data('bullet'));
        if (editorBlocks[bi]) {
            editorBlocks[bi].bullets.splice(bui, 1);
            if (editorBlocks[bi].bullets.length === 0) {
                editorBlocks.splice(bi, 1);
                reindexEditingSet(editingSet, bi);
            }
            refreshEditor();
        }
    });

    $(document).off('click.charMemoryConvDelBlock').on('click.charMemoryConvDelBlock', '.charMemory_editorDeleteBlock', function () {
        const bi = Number($(this).data('block'));
        editorBlocks.splice(bi, 1);
        reindexEditingSet(editingSet, bi);
        refreshEditor();
    });

    $(document).off('click.charMemoryConvAddBullet').on('click.charMemoryConvAddBullet', '.charMemory_editorAddBullet', function () {
        const bi = Number($(this).data('block'));
        if (editorBlocks[bi]) {
            editorBlocks[bi].bullets.push('');
            refreshEditor();
            $(`#charMemory_convEditorPane .charMemory_editorCard[data-block="${bi}"] .charMemory_editorBulletInput:last`).focus();
        }
    });

    $(document).off('click.charMemoryConvAddBlock').on('click.charMemoryConvAddBlock', '#charMemory_convAddBlock', function () {
        const now = new Date();
        const timestamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
        const newIdx = editorBlocks.length;
        editorBlocks.push({ chat: 'New Group', date: timestamp, bullets: [''] });
        editingSet.add(newIdx);
        refreshEditor();
        $('#charMemory_convEditorPane .charMemory_editorCard:last .charMemory_editorBulletInput:last').focus();
    });

    // === Destination controls (state captured in closure for after popup closes) ===

    $(document).off('change.charMemoryConvDest').on('change.charMemoryConvDest', 'input[name="charMemory_convDest"]', function () {
        destType = $(this).val();
        $('#charMemory_convCustomName').prop('disabled', destType !== 'custom');
    });

    $(document).off('input.charMemoryConvCustom').on('input.charMemoryConvCustom', '#charMemory_convCustomName', function () {
        destCustomName = $(this).val();
    });

    // === Re-run ===

    $('#charMemory_rerunConversion').off('click').on('click', async () => {
        if (inApiCall) return;
        const currentBlocks = cloneBlocks(editorBlocks);
        const llmChecked = $('#charMemory_convDialogLLM').prop('checked');

        $('#charMemory_convRerunSpinner').show();
        $('#charMemory_rerunConversion').prop('disabled', true);
        $('#charMemory_convEditorPane').addClass('charMemory_editorDisabled');

        let newResult;
        try {
            inApiCall = true;
            if (llmChecked && format !== 'memory_tags') {
                const charName = getCharacterName() || 'Character';
                newResult = await convertWithLLM(sourceContent, charName);
            } else {
                newResult = convertHeuristic(sourceContent, format);
            }
        } catch (err) {
            console.error(LOG_PREFIX, 'Re-run conversion failed:', err);
            toastr.error(`Re-run failed: ${err.message || 'Unknown error'}`, 'CharMemory');
            newResult = null;
        } finally {
            inApiCall = false;
        }

        // Bail out if the dialog was closed while the LLM call was in flight
        if (dialogClosed) return;

        $('#charMemory_convRerunSpinner').hide();
        $('#charMemory_rerunConversion').prop('disabled', false);
        $('#charMemory_convEditorPane').removeClass('charMemory_editorDisabled');

        if (newResult && newResult.blocks.length > 0) {
            versionStack.push(currentBlocks);
            $('#charMemory_undoConvRerun').prop('disabled', false);
            editorBlocks = newResult.blocks.map(b => ({ ...b, bullets: [...b.bullets] }));
            editingSet.clear();
            refreshEditor();
            for (const w of newResult.warnings) {
                toastr.warning(w, 'CharMemory');
            }
            const newMethod = llmChecked && format !== 'memory_tags' ? 'LLM' : 'Heuristic';
            $('#charMemory_convMethod').text(newMethod);
        }
    });

    // === Undo ===

    $('#charMemory_undoConvRerun').off('click').on('click', () => {
        if (versionStack.length === 0) return;
        editorBlocks = versionStack.pop();
        editingSet.clear();
        refreshEditor();
        if (versionStack.length === 0) $('#charMemory_undoConvRerun').prop('disabled', true);
    });

    // === Wait for dialog Accept/Cancel ===

    const confirmed = await popup;
    dialogClosed = true;

    // Clean up all event delegation
    $(document).off('click.charMemoryConvToggle');
    $(document).off('input.charMemoryConvBullet');
    $(document).off('input.charMemoryConvTheme');
    $(document).off('click.charMemoryConvDelBullet');
    $(document).off('click.charMemoryConvDelBlock');
    $(document).off('click.charMemoryConvAddBullet');
    $(document).off('click.charMemoryConvAddBlock');
    $(document).off('change.charMemoryConvDest');
    $(document).off('input.charMemoryConvCustom');

    if (!confirmed) {
        logActivity('Conversion cancelled by user');
        return;
    }

    // === Save converted memories ===

    const cleanBlocks = editorBlocks
        .map(b => ({ ...b, bullets: b.bullets.filter(bullet => bullet.trim() !== '') }))
        .filter(b => b.bullets.length > 0);

    if (cleanBlocks.length === 0) {
        toastr.warning('No memories to save.', 'CharMemory');
        return;
    }

    const context = getContext();
    const avatar = characters[context.characterId]?.avatar;
    if (!avatar) {
        toastr.error('No character selected.', 'CharMemory');
        return;
    }

    // destType and destCustomName are captured from closure (updated by event handlers)
    let destFileName;
    if (destType === 'custom') {
        destFileName = destCustomName.trim();
        if (!destFileName) {
            toastr.warning('Enter a filename for custom output.', 'CharMemory');
            return;
        }
    } else {
        destFileName = getMemoryFileName();
    }

    // If destination file already exists, append
    const existingContent = await readMemoriesForCharacter(avatar, destFileName);
    let existingBlocks = [];
    if (existingContent && existingContent.trim()) {
        existingBlocks = parseMemories(existingContent);
    }

    const allBlocks = [...existingBlocks, ...cleanBlocks];
    await writeMemoriesForCharacter(serializeMemories(allBlocks), avatar, destFileName);

    const count = countMemories(cleanBlocks);
    toastr.success(`Converted ${count} memories to ${destFileName}. Remember to hide or remove the original file from Data Bank to avoid duplicates.`, 'CharMemory', { timeOut: 8000 });
    logActivity(`Converted ${count} memories from Data Bank file to ${destFileName}`);

    // Refresh source dropdown so it reflects the new file state
    populateConvertSourceDropdown();
    updateStatusDisplay();
}

// Diagnostics state (session-only, not persisted)
let lastDiagnostics = {
    worldInfoEntries: [],
    extensionPrompts: {},
    timestamp: null,
};
let diagnosticsHistory = [];
let pendingDiagnosticsMessageIndex = null;

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
 * Update the consolidation strategy UI: show custom textarea or preset preview.
 */
function updateConsolidationStrategyUI() {
    const strategy = extension_settings[MODULE_NAME].consolidationStrategy || 'balanced';
    const overrides = extension_settings[MODULE_NAME].consolidationPrompts || {};
    const currentPrompt = overrides[strategy] || CONSOLIDATION_PRESETS[strategy]?.prompt || '';
    const isCustomized = !!overrides[strategy];

    $('#charMemory_consolidationPrompt').val(currentPrompt);
    $('#charMemory_restorePresetDefault').toggle(isCustomized);

    const previewText = isCustomized ? `${CONSOLIDATION_PRESETS[strategy]?.name} (customized)` : CONSOLIDATION_PRESETS[strategy]?.description || '';
    $('#charMemory_consolidationPreview').text(previewText);
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
 * Populate the Convert tool's source file dropdown with Data Bank files.
 * Verifies attachments against the server to prune stale entries.
 */
async function populateConvertSourceDropdown() {
    const $select = $('#charMemory_convertSource');
    $select.find('option:not(:first)').remove();

    const context = getContext();
    if (!context.characterId && context.characterId !== 0) return;

    const avatar = characters[context.characterId]?.avatar;
    if (!avatar) return;

    ensureCharacterAttachments(avatar);
    let attachments = extension_settings.character_attachments[avatar] || [];

    // Verify which files actually exist on disk and prune stale entries
    if (attachments.length > 0) {
        try {
            const urls = attachments.map(a => a.url);
            const response = await fetch('/api/files/verify', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ urls }),
            });
            if (response.ok) {
                const verifyMap = await response.json();
                const before = attachments.length;
                attachments = attachments.filter(a => verifyMap[a.url] !== false);
                if (attachments.length < before) {
                    extension_settings.character_attachments[avatar] = attachments;
                    saveSettingsDebounced();
                }
            }
        } catch (err) {
            console.warn(LOG_PREFIX, 'Could not verify attachments:', err);
        }
    }

    const memoryFileName = getMemoryFileName();

    for (const att of attachments) {
        // Skip the active CharMemory file
        if (att.name === memoryFileName) continue;
        const $opt = $('<option></option>').val(att.url).text(att.name || att.url);
        $select.append($opt);
    }
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
    const $search = $('#charMemory_modelSearch');
    const $hidden = $('#charMemory_providerModel');
    const preset = PROVIDER_PRESETS[providerKey];
    if (!preset) return;

    if (forceRefresh) {
        clearModelCache(providerKey);
    }

    const providerSettings = getProviderSettings(providerKey);

    // Early exit if API key required but missing
    if (preset.requiresApiKey && !providerSettings.apiKey) {
        currentModelList = [];
        $search.val('').attr('placeholder', 'Enter API key, then click Connect');
        $hidden.val('');
        renderModelDropdown('');
        $('#charMemory_providerModelInfo').text('');
        return;
    }

    try {
        currentModelList = [];

        if (providerKey === 'nanogpt') {
            // NanoGPT uses its own rich model list with groups
            const models = await fetchNanoGptModels();
            const filtered = getFilteredNanoGptModels(models, providerSettings);

            const byProvider = {};
            for (const m of filtered) {
                if (!byProvider[m.provider]) byProvider[m.provider] = [];
                byProvider[m.provider].push(m);
            }

            for (const [provider, providerModels] of Object.entries(byProvider)) {
                for (const m of providerModels) {
                    const subTag = m.subscription ? ' [Sub]' : '';
                    currentModelList.push({
                        id: m.id,
                        name: `${m.name} (${m.cost})${subTag}`,
                        group: provider,
                    });
                }
            }

            const currentVal = $hidden.val() || providerSettings.model;
            if (currentVal && filtered.some(m => m.id === currentVal)) {
                const match = currentModelList.find(m => m.id === currentVal);
                $hidden.val(currentVal);
                $search.val(match ? match.name : currentVal);
                updateProviderModelInfo(models, currentVal);
            } else {
                $hidden.val('');
                $search.val('');
                providerSettings.model = '';
                saveSettingsDebounced();
                $('#charMemory_providerModelInfo').text('');
            }
        } else {
            // Standard OpenAI-compatible model list
            const models = await fetchProviderModels(providerKey);

            for (const m of models) {
                currentModelList.push({ id: m.id, name: m.name });
            }

            const currentVal = $hidden.val() || providerSettings.model;
            if (currentVal && models.some(m => m.id === currentVal)) {
                const match = currentModelList.find(m => m.id === currentVal);
                $hidden.val(currentVal);
                $search.val(match ? match.name : currentVal);
            } else if (providerSettings.model) {
                $hidden.val('');
                $search.val('');
            }
            $('#charMemory_providerModelInfo').text('');
        }

        $search.attr('placeholder', 'Search models...');
        renderModelDropdown('');
    } catch (err) {
        console.error(LOG_PREFIX, `Failed to fetch models for ${preset.name}:`, err);
        throw err;
    }
}

/**
 * Render the model dropdown from currentModelList, filtered by query.
 * @param {string} filter — search string (case-insensitive substring match)
 */
function renderModelDropdown(filter) {
    const $dropdown = $('#charMemory_modelDropdown');
    $dropdown.empty();

    const lowerFilter = (filter || '').toLowerCase();
    const selectedId = $('#charMemory_providerModel').val();

    if (currentModelList.length === 0) {
        $dropdown.append('<div class="charMemory_modelEmpty">No models \u2014 click \u21bb to fetch</div>');
        return;
    }

    let hasResults = false;
    let lastGroup = null;

    for (const model of currentModelList) {
        if (lowerFilter && !model.id.toLowerCase().includes(lowerFilter) && !model.name.toLowerCase().includes(lowerFilter)) {
            continue;
        }

        // Render group header if this model's group differs from the last rendered
        if (model.group && model.group !== lastGroup) {
            $dropdown.append(`<div class="charMemory_modelGroup">${escapeHtml(model.group)}</div>`);
            lastGroup = model.group;
        }

        const selectedClass = model.id === selectedId ? ' selected' : '';
        $dropdown.append(
            `<div class="charMemory_modelOption${selectedClass}" data-model-id="${escapeHtml(model.id)}">${escapeHtml(model.name)}</div>`
        );
        hasResults = true;
    }

    if (!hasResults) {
        $dropdown.append('<div class="charMemory_modelEmpty">No matching models</div>');
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

function toggleChunkBoundaryUI(value) {
    $('#charMemory_customSeparatorRow').toggle(value === 'custom');
    $('#charMemory_chunkMetadataRow').toggle(value === 'bullet' || value === 'custom');
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

    // Migrate old consolidationPrompt to new per-preset system
    if (extension_settings[MODULE_NAME].consolidationPrompt) {
        const oldPrompt = extension_settings[MODULE_NAME].consolidationPrompt;
        const oldStrategy = extension_settings[MODULE_NAME].consolidationStrategy || 'balanced';
        if (!extension_settings[MODULE_NAME].consolidationPrompts) {
            extension_settings[MODULE_NAME].consolidationPrompts = {};
        }
        if (!extension_settings[MODULE_NAME].consolidationPrompts[oldStrategy]) {
            extension_settings[MODULE_NAME].consolidationPrompts[oldStrategy] = oldPrompt;
        }
        delete extension_settings[MODULE_NAME].consolidationPrompt;
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
    $('#charMemory_mergeChunks').prop('checked', extension_settings[MODULE_NAME].mergeChunks);
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
$('#charMemory_groupExtractionPrompt').val(extension_settings[MODULE_NAME].groupExtractionPrompt);
    $('#charMemory_consolidationStrategy').val(extension_settings[MODULE_NAME].consolidationStrategy || 'balanced');
    updateConsolidationStrategyUI();
    $('#charMemory_source').val(extension_settings[MODULE_NAME].source);
    $('#charMemory_fileName').val(extension_settings[MODULE_NAME].fileName);
    $('#charMemory_verboseLog').prop('checked', extension_settings[MODULE_NAME].verboseLogging);
    $('#charMemory_chunkBoundary').val(extension_settings[MODULE_NAME].chunkBoundary || 'block');
    $('#charMemory_customSeparator').val(extension_settings[MODULE_NAME].customSeparator || '\\n\\n');
    $('#charMemory_chunkMetadata').prop('checked', !!extension_settings[MODULE_NAME].chunkMetadata);
    toggleChunkBoundaryUI(extension_settings[MODULE_NAME].chunkBoundary || 'block');
    $('#charMemory_convertPrompt').val(extension_settings[MODULE_NAME].conversionPrompt || defaultConversionPrompt);

    // Provider settings
    populateProviderDropdown();
    toggleProviderSettings(extension_settings[MODULE_NAME].source);

    updateStatusDisplay();
    updateHealthIndicator();
}

function ensureMetadata() {
    if (!chat_metadata[MODULE_NAME]) {
        chat_metadata[MODULE_NAME] = {
            lastExtractedIndex: -1,
            messagesSinceExtraction: 0,
            injectionData: {},
        };
    }
    if (!chat_metadata[MODULE_NAME].injectionData) {
        chat_metadata[MODULE_NAME].injectionData = {};
    }
}

let cooldownTimerInterval = null;

function updateStatusDisplay() {
    ensureMetadata();

    const targets = getMemoryTargets();

    // Stats bar: file name (with avatars for group chats)
    if (targets.length > 1) {
        const avatarHtml = targets.map(t =>
            `<img class="charMemory_groupAvatar" src="/thumbnail?type=avatar&file=${encodeURIComponent(t.avatar)}" alt="${escapeHtml(t.name)}" onerror="this.style.display='none'" />`
        ).join('');
        const tooltipLines = targets.map(t => `${t.name} \u2192 ${t.fileName}`).join('\n');
        $('#charMemory_statFile').html(`Group: ${avatarHtml}`).attr('title', tooltipLines);
    } else if (targets.length === 1) {
        $('#charMemory_statFile').text(targets[0].fileName).attr('title', targets[0].fileName);
    } else {
        $('#charMemory_statFile').text('No character').attr('title', 'No character selected');
    }

    // Stats bar: memory count (total bullets across all targets, async)
    if (targets.length === 0) {
        $('#charMemory_statCount').text('0 memories');
    } else {
        let totalCount = 0;
        let loaded = 0;
        for (const target of targets) {
            readMemoriesForCharacter(target.avatar, target.fileName).then(content => {
                const blocks = parseMemories(content || '');
                totalCount += countMemories(blocks);
                loaded++;
                if (loaded === targets.length) {
                    $('#charMemory_statCount').text(`${totalCount} memor${totalCount === 1 ? 'y' : 'ies'}`);
                }
            }).catch(() => { loaded++; });
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

    const targets = getMemoryTargets();
    if (targets.length <= 1) {
        $container.html('<small class="charMemory_helperText">Open a group chat to see members.</small>');
        return;
    }

    const rows = targets.map(target => {
        const override = extension_settings[MODULE_NAME]?.characterFileNames?.[target.avatar] || '';
        return `<div class="charMemory_groupMemberRow">
            <span class="charMemory_groupMemberName">${escapeHtml(target.name)}</span>
            <input type="text" class="text_pole charMemory_groupMemberFile"
                   data-avatar="${escapeHtml(target.avatar)}"
                   data-charname="${escapeHtml(target.name)}"
                   value="${escapeHtml(override)}"
                   placeholder="${escapeHtml(target.fileName)}"
                   title="Current file: ${escapeHtml(target.fileName)}" />
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
 * Get unified memory targets for the current chat context.
 * In group chats, returns one target per active NPC character.
 * In 1:1 chats, returns a single-element array for the active character.
 * @returns {{name: string, avatar: string, charIndex: number, fileName: string}[]}
 */
function getMemoryTargets() {
    if (isGroupChat()) {
        return getGroupMembers().map(m => ({
            name: m.name,
            avatar: m.avatar,
            charIndex: m.charIndex,
            fileName: getMemoryFileNameForCharacter(m.name, m.avatar),
        }));
    }
    const char = characters[this_chid];
    if (!char) return [];
    return [{
        name: char.name,
        avatar: char.avatar,
        charIndex: this_chid,
        fileName: getMemoryFileName(),
    }];
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
        let content = (await getFileAttachment(attachment.url)) || '';

        // Auto-migrate flat text to structured format
        const migrated = migrateMemoriesIfNeeded(content);
        if (migrated !== content) {
            console.log(LOG_PREFIX, `Migrating memories to structured format for ${avatar}`);
            await writeMemoriesForCharacter(migrated, avatar, fileName);
            return migrated;
        }

        return content;
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
/** @type {Array<{id: string, name: string, group?: string}>} */
let currentModelList = [];

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
/**
 * Build extraction prompt for a specific target character.
 * Selects 1:1 vs group prompt template based on whether there are multiple targets.
 * @param {{name: string, charIndex: number}} target The character to extract for.
 * @param {string} existingMemories Current memories for this character.
 * @param {string} recentMessages Formatted recent messages.
 * @param {{name: string}[]} allTargets All memory targets (length > 1 = group).
 * @returns {string} The completed prompt.
 */
function buildExtractionPrompt(target, existingMemories, recentMessages, allTargets) {
    const charName = target.name || '{{char}}';
    const isGroup = allTargets.length > 1;
    let prompt = isGroup
        ? extension_settings[MODULE_NAME].groupExtractionPrompt
        : extension_settings[MODULE_NAME].extractionPrompt;
    const isWebLlm = extension_settings[MODULE_NAME].source === EXTRACTION_SOURCE.WEBLLM;

    let memories = existingMemories || '(none yet)';
    let messages = recentMessages;
    const charCard = getCharacterCardTextFor(target.charIndex) || '(not available)';

    // Truncate content for WebLLM's smaller context window (1:1 only)
    if (isWebLlm && !isGroup) {
        const templateLength = prompt.replace(/\{\{charName\}\}/g, charName)
            .replace(/\{\{charCard\}\}/g, '')
            .replace(/\{\{existingMemories\}\}/g, '')
            .replace(/\{\{recentMessages\}\}/g, '').length;
        const available = Math.max(WEBLLM_MAX_PROMPT_CHARS - templateLength, 1000);
        const memoriesBudget = Math.floor(available / 3);
        const messagesBudget = available - memoriesBudget;
        memories = truncateText(memories, memoriesBudget);
        messages = truncateText(messages, messagesBudget);
    }

    prompt = prompt.replace(/\{\{charName\}\}/g, charName);
    prompt = prompt.replace(/\{\{charCard\}\}/g, charCard);
    prompt = prompt.replace(/\{\{existingMemories\}\}/g, memories);
    prompt = prompt.replace(/\{\{recentMessages\}\}/g, messages);

    // Group-only: inject participants list (everyone except the target character)
    if (isGroup) {
        const context = getContext();
        const userName = context.name1 || 'User';
        const otherNames = allTargets
            .filter(t => t.name !== charName)
            .map(t => t.name);
        otherNames.unshift(`${userName} (user)`);
        prompt = prompt.replace(/\{\{participants\}\}/g, otherNames.join(', '));
    }

    // Let ST handle {{char}}, {{user}}, etc.
    prompt = substituteParamsExtended(prompt);

    return prompt;
}

/**
 * Run memory extraction — unified for both 1:1 and group chats.
 * Uses getMemoryTargets() to determine extraction targets. For 1:1 chats the
 * target loop runs once; for groups it runs once per active NPC character.
 *
 * @param {Object} options
 * @param {boolean} options.force If true, ignore interval check.
 * @param {number|null} options.endIndex Optional end message index (inclusive).
 * @param {Array|null} options.chatArray Optional external chat array (for batch extraction).
 * @param {string|null} options.chatId Optional chat ID (for batch extraction).
 * @param {number|null} options.lastExtractedIdx Optional override for lastExtractedIndex.
 * @param {function|null} options.onProgress Progress callback.
 * @param {AbortSignal|null} options.abortSignal Abort signal for cancellation.
 * @param {string|null} options.progressLabel Label prefix for toast messages.
 * @returns {Promise<{totalMemories: number, chunksProcessed: number, lastExtractedIndex: number}>}
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

    // Determine extraction targets
    const targets = getMemoryTargets();
    if (targets.length === 0) {
        logActivity('Extraction: no targets found', 'warning');
        return noopResult;
    }
    const isMultiTarget = targets.length > 1;

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
    const totalSteps = totalChunks * targets.length;

    if (isMultiTarget) {
        logActivity(`Extraction starting for ${targets.length} characters: ${targets.map(t => t.name).join(', ')}`);
        logActivity(`${totalUnprocessed} messages, ${totalChunks} chunk(s), ${targets.length} characters = ${totalSteps} LLM calls`);
    } else {
        logActivity(`Extraction triggered (${force ? 'manual' : 'auto'}), endIndex=${endIndex ?? 'last'}, totalUnprocessed=${totalUnprocessed}, chunks=${totalChunks}`);
    }

    // Confirmation for large manual extractions
    const confirmThreshold = isMultiTarget ? 6 : 3;
    if (force && totalSteps > confirmThreshold && !abortSignal) {
        const confirmMsg = isMultiTarget
            ? `This will process ${totalUnprocessed} messages for ${targets.length} characters (${totalSteps} LLM calls). This may take a while. Continue?`
            : `This will process ${totalUnprocessed} messages in ${totalChunks} chunks. This may take a while. Continue?`;
        const confirmed = await callGenericPopup(confirmMsg, POPUP_TYPE.CONFIRM);
        if (!confirmed) {
            logActivity('Extraction cancelled by user', 'warning');
            return noopResult;
        }
    }

    // Save context identifiers to check for changes after async calls
    const savedCharId = context.characterId;
    const savedChatId = context.chatId;
    const effectiveChatId = chatId || context.chatId || 'unknown';

    const sourceLabel = getSourceLabel();

    let totalMemories = 0;
    let chunksProcessed = 0;
    let stepsCompleted = 0;

    try {
        inApiCall = true;
        lastExtractionTime = Date.now();

        for (let chunk = 0; chunk < totalChunks; chunk++) {
            // Check abort signal
            if (abortSignal?.aborted) {
                logActivity(`Extraction aborted after ${chunksProcessed} chunk(s)`, 'warning');
                toastr.warning(`Extraction stopped after ${chunksProcessed} of ${totalChunks} chunks.`, 'CharMemory');
                break;
            }

            // Collect messages for this chunk (shared across all targets)
            const { text: recentMessages, endIndex: chunkEndIndex } = collectRecentMessages({
                endIndex: endIndex,
                chatArray: chatArray,
                lastExtractedIdx: currentLastExtracted,
            });

            if (!recentMessages) {
                logActivity(`Chunk ${chunk + 1}: no messages returned, stopping`, 'warning');
                break;
            }

            // Per-target extraction loop
            let chunkAborted = false;
            for (const target of targets) {
                if (abortSignal?.aborted) {
                    chunkAborted = true;
                    break;
                }

                stepsCompleted++;

                // Show progress toast
                const prefix = progressLabel ? `${progressLabel} — ` : '';
                if (isMultiTarget) {
                    const stepInfo = `${target.name} (${stepsCompleted}/${totalSteps})`;
                    toastr.info(`${prefix}Extracting for ${stepInfo} via ${sourceLabel}...`, 'CharMemory', { timeOut: 3000 });
                } else {
                    const chunkInfo = totalChunks > 1 ? ` (chunk ${chunk + 1}/${totalChunks})` : '';
                    toastr.info(`${prefix}Extracting via ${sourceLabel}${chunkInfo}...`, 'CharMemory', { timeOut: 3000 });
                }

                if (onProgress) {
                    onProgress({ chunk: chunk + 1, totalChunks, chunksProcessed, totalMemories, character: target.name, step: stepsCompleted, totalSteps });
                }

                // Read this target's existing memories
                const existingMemories = await readMemoriesForCharacter(target.avatar, target.fileName);

                // Build prompt
                const prompt = buildExtractionPrompt(target, existingMemories, recentMessages, targets);

                const verbose = extension_settings[MODULE_NAME].verboseLogging;
                const logLabel = isMultiTarget ? `[${target.name}]` : '';
                if (verbose) {
                    logActivity(`${logLabel} Prompt (${prompt.length} chars):\n${prompt}`);
                }

                logActivity(`${logLabel} Sending to ${sourceLabel}... waiting for response`);
                const llmStartTime = Date.now();
                let result;
                try {
                    result = await callLLM(prompt, extension_settings[MODULE_NAME].responseLength, 'You are a memory extraction assistant.');
                } catch (llmErr) {
                    if (isMultiTarget) {
                        logActivity(`${logLabel} LLM error: ${llmErr.message}`, 'error');
                        continue; // Skip this target, try next
                    }
                    if (llmErr.message?.includes('WebLLM is not available')) {
                        toastr.error('WebLLM is not available in this browser.', 'CharMemory');
                        return { totalMemories, chunksProcessed, lastExtractedIndex: currentLastExtracted };
                    }
                    throw llmErr;
                }

                const llmElapsed = ((Date.now() - llmStartTime) / 1000).toFixed(1);
                logActivity(`${logLabel} Response in ${llmElapsed}s (${(result || '').length} chars)`);
                if (verbose && result) {
                    logActivity(`${logLabel} Raw response:\n${result}`);
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
                    logActivity(`${logLabel} No new memories for this chunk`);
                    continue;
                }

                // Parse and save memories to this target's Data Bank
                const currentMemories = await readMemoriesForCharacter(target.avatar, target.fileName);
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

                await writeMemoriesForCharacter(serializeMemories(existing), target.avatar, target.fileName);
                totalMemories += newBulletCount;
                logActivity(`${logLabel} Saved ${newBulletCount} new memor${newBulletCount === 1 ? 'y' : 'ies'}`, 'success');
            }

            // Don't advance index if abort interrupted the target loop
            if (chunkAborted) {
                logActivity(`Chunk ${chunk + 1} aborted mid-extraction — not advancing index`, 'warning');
                break;
            }

            // Advance lastExtractedIndex after each complete chunk
            currentLastExtracted = chunkEndIndex !== -1 ? chunkEndIndex : effectiveEnd - 1;

            if (isActiveChat) {
                ensureMetadata();
                chat_metadata[MODULE_NAME].lastExtractedIndex = currentLastExtracted;
                saveMetadataDebounced();
                logActivity(`Advanced lastExtractedIndex to ${currentLastExtracted}`);
            }

            chunksProcessed++;
        }

        // Merge blocks with same chat per target (multi-chunk extraction)
        if (chunksProcessed > 1 && totalMemories > 0 && extension_settings[MODULE_NAME].mergeChunks) {
            for (const target of targets) {
                const content = await readMemoriesForCharacter(target.avatar, target.fileName);
                const allBlocks = parseMemories(content);
                const merged = mergeMemoryBlocks(allBlocks);
                if (merged.length < allBlocks.length) {
                    await writeMemoriesForCharacter(serializeMemories(merged), target.avatar, target.fileName);
                    logActivity(`${isMultiTarget ? `[${target.name}] ` : ''}Merged ${allBlocks.length} blocks → ${merged.length}`);
                }
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
            const suffix = isMultiTarget ? ` across ${targets.length} characters` : '';
            toastr.success(`${totalMemories} memor${totalMemories === 1 ? 'y' : 'ies'} saved${suffix} from ${chunksProcessed} chunk(s).`, 'CharMemory');
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

    // Clear injection drawer on chat switch
    $('#charMemory_drawerBody').html('<div class="charMemory_diagEmpty">Click the <i class="fa-solid fa-syringe"></i> icon on a message to view its injected context.</div>');
    $('#charMemory_drawerMsgLabel').text('');
    $('#charMemory_drawerToolbar').html('');
    $('#charMemory_drawerFooter').text('');

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
            const targets = getMemoryTargets();
            for (const target of targets) {
                const content = await readMemoriesForCharacter(target.avatar, target.fileName);
                const blocks = parseMemories(content);
                if (blocks.some(b => b.chat === chatId || b.chat === 'consolidated' || b.chat === 'unknown')) {
                    hasMemoriesForChat = true;
                    break;
                }
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
    updateHealthIndicator();

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
function captureDiagnostics(messageIndex) {
    const context = getContext();
    lastDiagnostics.extensionPrompts = {};
    lastDiagnostics.timestamp = new Date().toLocaleTimeString();

    if (context.extensionPrompts) {
        for (const [key, value] of Object.entries(context.extensionPrompts)) {
            if (value && value.value) {
                const maxLen = key === '4_vectors_data_bank' ? 16000 : 300;
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

    // Persist per-message injection snapshot
    if (typeof messageIndex === 'number' && messageIndex >= 0) {
        ensureMetadata();

        // Extract memory bullets from the FULL (untruncated) Data Bank vector content
        // so we capture all injected memories, not just those within the 2000-char display limit
        const fullDbContent = context.extensionPrompts?.['4_vectors_data_bank']?.value;
        const memories = [];
        if (fullDbContent) {
            const raw = typeof fullDbContent === 'string' ? fullDbContent : String(fullDbContent);
            const bullets = raw.split('\n')
                .map(line => line.trim())
                .filter(line => line.startsWith('- '))
                .map(line => line.slice(2).trim())
                .filter(Boolean);
            for (const b of bullets) {
                memories.push({ text: b });
            }
        }

        const snapshot = {
            memories,
            worldInfo: lastDiagnostics.worldInfoEntries.map(e => ({
                comment: e.comment,
                keys: e.keys,
                content: e.content,
            })),
            extensionPrompts: Object.values(lastDiagnostics.extensionPrompts).map(p => ({
                label: p.label,
                content: p.label === '4_vectors_data_bank' ? p.content : p.content.substring(0, 500),
                position: p.position,
            })),
            timestamp: lastDiagnostics.timestamp,
        };

        chat_metadata[MODULE_NAME].injectionData[messageIndex] = snapshot;
        saveMetadataDebounced();

        // Update the indicator now that the snapshot exists
        const $mes = $(`#chat .mes[mesid="${messageIndex}"]`);
        if ($mes.length) {
            updateIndicatorForMessage($mes, messageIndex);
        }
    }

    updateDiagnosticsDisplay();
    updateHealthIndicator();

    // Auto-update injection drawer if open
    if ($('#charMemory_injectionDrawer').hasClass('open') && typeof messageIndex === 'number' && messageIndex >= 0) {
        showInjectionDrawer(messageIndex);
    }
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

// ============ Injection Health Score ============

/**
 * Compute the injection health score by running a series of checks
 * against Vector Storage settings and the current diagnostics state.
 * @returns {Promise<{level: 'green'|'yellow'|'red'|'unknown', checks: {id: string, level: string, label: string, detail: string}[]}>}
 */
async function computeHealthScore() {
    const checks = [];
    const targets = getMemoryTargets();
    if (targets.length === 0) return { level: 'unknown', checks: [] };

    const target = targets[0];
    const vecSettings = extension_settings.vectors;

    // Check 1: Vector Storage enabled for files
    const filesEnabled = vecSettings?.enabled_files;
    checks.push({
        id: 'vec_files_enabled',
        level: filesEnabled ? 'green' : 'red',
        label: 'Vector Storage for files',
        detail: filesEnabled
            ? 'Enabled — Data Bank files will be vectorized'
            : 'Disabled — memories will not be vectorized or injected. Enable "Files" in Vector Storage settings.',
    });

    if (!filesEnabled) return { level: 'red', checks };

    // Check 2: Memory file exists
    const attachment = findMemoryAttachmentForCharacter(target.avatar, target.fileName);
    checks.push({
        id: 'memory_file_exists',
        level: attachment ? 'green' : 'red',
        label: 'Memory file in Data Bank',
        detail: attachment
            ? `Found: ${target.fileName}`
            : `Not found: ${target.fileName}. Extract memories first.`,
    });

    if (!attachment) {
        const level = checks.some(c => c.level === 'red') ? 'red'
            : checks.some(c => c.level === 'yellow') ? 'yellow' : 'green';
        return { level, checks };
    }

    // Check 3: File vectorized
    const vecStatus = await checkVectorizationStatus(attachment.url);
    if (vecStatus === null) {
        checks.push({ id: 'file_vectorized', level: 'red', label: 'File vectorization',
            detail: 'Could not check vectorization status. Vector Storage may not be enabled for files.' });
    } else if (vecStatus === false) {
        checks.push({ id: 'file_vectorized', level: 'red', label: 'File vectorization',
            detail: 'File exists but has 0 vector chunks. It has not been vectorized yet.' });
    } else {
        const via = vecStatus.model ? `${vecStatus.source}/${vecStatus.model}` : vecStatus.source;
        checks.push({ id: 'file_vectorized', level: 'green', label: 'File vectorization',
            detail: `Vectorized: ${vecStatus.chunks} chunk${vecStatus.chunks === 1 ? '' : 's'} via ${via}` });
    }

    // Check 4: Chunk overlap
    const overlapPct = vecSettings?.overlap_percent_db ?? 0;
    const chunkSizeDb = vecSettings?.chunk_size_db ?? 2500;
    if (overlapPct === 0) {
        const recommended = Math.round(chunkSizeDb * 0.15);
        checks.push({ id: 'chunk_overlap', level: 'yellow', label: 'Chunk overlap',
            detail: `Overlap is 0%. Memory blocks that span chunk boundaries may be split. Recommended: 10-25% (~${recommended} chars at current chunk size).` });
    } else {
        const overlapChars = Math.round(chunkSizeDb * overlapPct / 100);
        checks.push({ id: 'chunk_overlap', level: 'green', label: 'Chunk overlap',
            detail: `${overlapPct}% (~${overlapChars} chars) — helps prevent memory blocks from being split.` });
    }

    // Check 5: Chunk size vs memory block size
    try {
        const content = await getFileAttachment(attachment.url);
        const blocks = parseMemories(content || '');
        if (blocks.length > 0) {
            const totalChars = blocks.reduce((sum, b) => {
                const blockText = b.bullets.map(bul => `- ${bul}`).join('\n');
                return sum + blockText.length + 80; // ~80 chars for <memory> tag overhead
            }, 0);
            const avgBlockSize = Math.round(totalChars / blocks.length);

            if (chunkSizeDb > 0 && chunkSizeDb < avgBlockSize) {
                checks.push({ id: 'chunk_size', level: 'yellow', label: 'Chunk size',
                    detail: `Chunk size (${chunkSizeDb}) is smaller than average memory block (${avgBlockSize} chars). Blocks will be split across chunks. Consider increasing chunk size.` });
            } else if (chunkSizeDb > 0 && chunkSizeDb > avgBlockSize * 4) {
                checks.push({ id: 'chunk_size', level: 'yellow', label: 'Chunk size',
                    detail: `Chunk size (${chunkSizeDb}) is much larger than average memory block (${avgBlockSize} chars). Retrieval may be less selective as chunks grow.` });
            } else {
                checks.push({ id: 'chunk_size', level: 'green', label: 'Chunk size',
                    detail: `Chunk size (${chunkSizeDb}) is appropriate for average memory block size (${avgBlockSize} chars).` });
            }
        }
    } catch { /* file read failed, skip */ }

    // Checks 6-7: Only run after a generation has been captured
    const dbPrompt = lastDiagnostics.extensionPrompts?.['4_vectors_data_bank'];
    if (dbPrompt && dbPrompt.content) {
        const injectedBullets = dbPrompt.content.split('\n')
            .map(line => line.trim())
            .filter(line => line.startsWith('- '))
            .map(line => line.slice(2).trim())
            .filter(Boolean);

        // Check 6: Memories actually injected
        if (injectedBullets.length === 0) {
            checks.push({ id: 'memories_injected', level: 'yellow', label: 'Memories in injection',
                detail: 'Vector data was injected but no memory bullets found. The content may be from other Data Bank files.' });
        } else {
            checks.push({ id: 'memories_injected', level: 'green', label: 'Memories in injection',
                detail: `${injectedBullets.length} memor${injectedBullets.length === 1 ? 'y' : 'ies'} found in last injection.` });

            // Check 7: Duplicate detection
            const uniqueBullets = new Set(injectedBullets);
            const dupeCount = injectedBullets.length - uniqueBullets.size;
            if (dupeCount > 0) {
                checks.push({ id: 'duplicate_detection', level: 'yellow', label: 'Duplicate memories',
                    detail: `${dupeCount} duplicate${dupeCount === 1 ? '' : 's'} found (${injectedBullets.length} total, ${uniqueBullets.size} unique). This typically means chunk boundaries are splitting memory blocks. Increase chunk overlap or chunk size.` });
            } else {
                checks.push({ id: 'duplicate_detection', level: 'green', label: 'Duplicate memories',
                    detail: `No duplicates — all ${injectedBullets.length} injected memories are unique.` });
            }
        }
    } else if (lastDiagnostics.timestamp) {
        checks.push({ id: 'memories_injected', level: 'red', label: 'Memories in injection',
            detail: 'No memory content was injected in the last generation. Check that Vector Storage is enabled and the file is vectorized.' });
    }

    const level = checks.some(c => c.level === 'red') ? 'red'
        : checks.some(c => c.level === 'yellow') ? 'yellow' : 'green';
    return { level, checks };
}

/**
 * Update the health dot and label in the status bar.
 */
function renderHealthStatusBarItem(result) {
    const classes = 'health-green health-yellow health-red health-unknown';

    // Status bar dot — reflects all checks (settings + injection)
    const $dot = $('#charMemory_healthDot');
    const $label = $('#charMemory_healthLabel');
    $dot.removeClass(classes).addClass(`health-${result.level}`);

    const labels = { green: 'Healthy', yellow: 'Warnings', red: 'Issues', unknown: '\u2014' };
    $label.text(labels[result.level] || '\u2014');

    const statusTooltip = result.level === 'unknown'
        ? 'No character selected'
        : result.checks
            .filter(c => c.level !== 'green')
            .map(c => `[${c.level.toUpperCase()}] ${c.label}`)
            .join('\n') || 'All checks passed';
    $('#charMemory_statHealth').attr('title', statusTooltip);

    // Drawer header dot — reflects injection state only (gray until generation)
    const $drawerDot = $('#charMemory_drawerHealthDot');
    const hasDiagnostics = !!lastDiagnostics.timestamp;
    if (!hasDiagnostics) {
        $drawerDot.removeClass(classes).addClass('health-unknown')
            .attr('title', 'No generation captured yet.\nGenerate a message to check injection health.');
        return;
    }

    // Build injection-specific stats for the tooltip
    const injectionChecks = result.checks.filter(c =>
        ['memories_injected', 'duplicate_detection', 'file_vectorized'].includes(c.id));
    const memCheck = result.checks.find(c => c.id === 'memories_injected');
    const dupeCheck = result.checks.find(c => c.id === 'duplicate_detection');
    const vecCheck = result.checks.find(c => c.id === 'file_vectorized');

    const drawerLevel = injectionChecks.some(c => c.level === 'red') ? 'red'
        : injectionChecks.some(c => c.level === 'yellow') ? 'yellow'
        : injectionChecks.length > 0 ? 'green' : 'unknown';

    const lines = [];
    if (vecCheck) lines.push(vecCheck.detail);
    if (memCheck) lines.push(memCheck.detail);
    if (dupeCheck && dupeCheck.level !== 'green') lines.push(dupeCheck.detail);
    lines.push('', 'Open CharMemory panel \u2192 Diagnostics for full details.');

    $drawerDot.removeClass(classes).addClass(`health-${drawerLevel}`)
        .attr('title', lines.join('\n'));
}

/**
 * Render the detailed health card in the diagnostics panel.
 */
function renderHealthDiagnosticsCard(result) {
    const $card = $('#charMemory_healthCard');
    if (!$card.length) return;

    const colors = { green: '#4a4', yellow: '#e8a33d', red: '#c44', unknown: 'var(--SmartThemeBorderColor, #555)' };
    const icons = { green: 'fa-circle-check', yellow: 'fa-triangle-exclamation', red: 'fa-circle-xmark', unknown: 'fa-circle-question' };
    const titles = { green: 'All checks passed', yellow: 'Warnings detected', red: 'Issues found', unknown: 'No character selected' };

    let html = `<strong style="color:${colors[result.level]};">
        <i class="fa-solid ${icons[result.level]} fa-sm"></i>
        Injection Health: ${titles[result.level]}
    </strong>`;

    for (const check of result.checks) {
        html += `<div class="charMemory_diagCard charMemory_healthCheck">
            <div class="charMemory_diagCardTitle" style="color:${colors[check.level]};">
                <i class="fa-solid ${icons[check.level]} fa-xs"></i> ${escapeHtml(check.label)}
            </div>
            <div class="charMemory_diagCardContent">${escapeHtml(check.detail)}</div>
        </div>`;
    }

    $card.html(html);
}

/**
 * Run health checks and update both status bar and diagnostics display.
 */
async function updateHealthIndicator() {
    try {
        const result = await computeHealthScore();
        renderHealthStatusBarItem(result);
        renderHealthDiagnosticsCard(result);
    } catch (err) {
        console.warn(LOG_PREFIX, 'Health check failed:', err);
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

    // Health score placeholder — populated async by updateHealthIndicator()
    html += '<div id="charMemory_healthCard" class="charMemory_diagSection"></div>';

    // Timestamp
    if (lastDiagnostics.timestamp) {
        html += `<div class="charMemory_diagTimestamp">Last capture: ${lastDiagnostics.timestamp}</div>`;
    }

    // Memory Info
    html += '<div class="charMemory_diagSection"><strong>Memories</strong>';
    const diagTargets = getMemoryTargets();
    const diagTarget = diagTargets[0]; // Show first target (1:1) or primary target (group)
    const memFileName = diagTarget?.fileName || '(none)';
    const memAttachment = diagTarget ? findMemoryAttachmentForCharacter(diagTarget.avatar, diagTarget.fileName) : null;
    html += `<div class="charMemory_diagCard">
        <div class="charMemory_diagCardTitle">Active file name${diagTargets.length > 1 ? ` (${diagTarget.name})` : ''}</div>
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
            const isTruncated = key !== '4_vectors_data_bank' && p.content.length >= 300;
            html += `<div class="charMemory_diagCard">
                <div class="charMemory_diagCardTitle">${escapeHtml(p.label)}</div>
                <div class="charMemory_diagCardContent" style="white-space:pre-wrap;">${escapeHtml(p.content)}${isTruncated ? '...' : ''}</div>
            </div>`;
        }
    } else {
        html += '<div class="charMemory_diagEmpty">No extension prompts active</div>';
    }
    html += '</div>';

    container.html(html);
}

function escapeHtml(text) {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// ============ Memory Manager ============

/**
 * Unified memory manager — works for both 1:1 and group chats.
 * Shows character headers only when multiple targets exist (group mode).
 * All cards/buttons carry data-avatar and data-filename for uniform event handling.
 */
async function showMemoryManager() {
    const targets = getMemoryTargets();
    if (targets.length === 0) {
        callGenericPopup('No character selected.', POPUP_TYPE.TEXT);
        return;
    }
    const isMultiTarget = targets.length > 1;

    // Load all targets' memories in parallel
    const targetData = await Promise.all(targets.map(async (target) => {
        const content = await readMemoriesForCharacter(target.avatar, target.fileName);
        const blocks = parseMemories(content || '');
        return { ...target, blocks };
    }));

    const totalBlocks = targetData.reduce((sum, t) => sum + t.blocks.length, 0);
    if (totalBlocks === 0) {
        callGenericPopup(isMultiTarget ? 'No memories yet for any group member.' : 'No memories yet.', POPUP_TYPE.TEXT);
        return;
    }

    let html = '<div class="charMemory_manager">';
    for (const target of targetData) {
        if (target.blocks.length === 0) continue;

        // Character header (group mode only)
        if (isMultiTarget) {
            const memCount = target.blocks.reduce((sum, b) => sum + b.bullets.length, 0);
            html += `<div class="charMemory_groupSection" data-avatar="${escapeAttr(target.avatar)}" data-filename="${escapeAttr(target.fileName)}">
                <div style="font-weight:bold;font-size:0.95em;margin:8px 0 4px;border-bottom:1px solid var(--SmartThemeBorderColor, rgba(128,128,128,0.2));padding-bottom:4px;">
                    ${escapeHtml(target.name)} <small style="opacity:0.5;">(${memCount} memories)</small>
                </div>`;
        }

        // Display newest blocks first (reverse chronological) while preserving original indices
        for (let bi = target.blocks.length - 1; bi >= 0; bi--) {
            const b = target.blocks[bi];
            const chatLabel = b.chat.length > 16 ? b.chat.slice(0, 16) + '...' : b.chat;
            html += `<div class="charMemory_card" data-block="${bi}" data-avatar="${escapeAttr(target.avatar)}" data-filename="${escapeAttr(target.fileName)}">
                <div class="charMemory_cardHeader">
                    <span class="charMemory_cardTitle">${escapeHtml(chatLabel)}</span>
                    <span class="charMemory_cardTimestamp">${escapeHtml(b.date)}</span>
                    <span class="charMemory_cardActions">
                        <button class="charMemory_deleteBlockBtn menu_button menu_button_icon" data-block="${bi}" data-avatar="${escapeAttr(target.avatar)}" data-filename="${escapeAttr(target.fileName)}" title="Delete all memories from this block"><i class="fa-solid fa-trash"></i></button>
                    </span>
                </div>
                <div class="charMemory_cardBullets">`;
            for (let bui = 0; bui < b.bullets.length; bui++) {
                html += `<div class="charMemory_bulletRow" data-block="${bi}" data-bullet="${bui}">
                    <span class="charMemory_bulletText">- ${escapeHtml(b.bullets[bui])}</span>
                    <span class="charMemory_bulletActions">
                        <button class="charMemory_editBtn menu_button menu_button_icon" data-block="${bi}" data-bullet="${bui}" data-avatar="${escapeAttr(target.avatar)}" data-filename="${escapeAttr(target.fileName)}" title="Edit"><i class="fa-solid fa-pencil"></i></button>
                        <button class="charMemory_deleteBtn menu_button menu_button_icon" data-block="${bi}" data-bullet="${bui}" data-avatar="${escapeAttr(target.avatar)}" data-filename="${escapeAttr(target.fileName)}" title="Delete"><i class="fa-solid fa-trash"></i></button>
                    </span>
                </div>`;
            }
            html += '</div></div>';
        }

        if (isMultiTarget) {
            html += '</div>'; // close .charMemory_groupSection
        }
    }
    html += '</div>';

    const popup = callGenericPopup(html, POPUP_TYPE.TEXT, '', { wide: true, allowVerticalScrolling: true });

    // Wire up event handlers — always read avatar+fileName from data attributes
    $(document).off('click.charMemoryManager').on('click.charMemoryManager', '.charMemory_editBtn', async function (e) {
        e.stopPropagation();
        const blockIdx = Number($(this).data('block'));
        const bulletIdx = Number($(this).data('bullet'));
        const avatar = String($(this).data('avatar'));
        const fileName = String($(this).data('filename'));
        await editMemory(blockIdx, bulletIdx, avatar, fileName);
    });

    $(document).off('click.charMemoryDelete').on('click.charMemoryDelete', '.charMemory_deleteBtn', async function (e) {
        e.stopPropagation();
        const blockIdx = Number($(this).data('block'));
        const bulletIdx = Number($(this).data('bullet'));
        const avatar = String($(this).data('avatar'));
        const fileName = String($(this).data('filename'));
        await deleteMemory(blockIdx, bulletIdx, avatar, fileName);
    });

    $(document).off('click.charMemoryDeleteBlock').on('click.charMemoryDeleteBlock', '.charMemory_deleteBlockBtn', async function (e) {
        e.stopPropagation();
        const blockIdx = Number($(this).data('block'));
        const avatar = String($(this).data('avatar'));
        const fileName = String($(this).data('filename'));
        await deleteBlock(blockIdx, avatar, fileName);
    });

    popup.finally(() => {
        $(document).off('click.charMemoryManager');
        $(document).off('click.charMemoryDelete');
        $(document).off('click.charMemoryDeleteBlock');
    });
}

/**
 * Re-index block/bullet data attributes within a scope after deletion.
 * If group sections exist, re-indexes within each section independently.
 * Otherwise re-indexes all cards in the manager.
 */
function reindexManager() {
    const $sections = $('.charMemory_manager .charMemory_groupSection');
    if ($sections.length > 0) {
        $sections.each(function () {
            $(this).find('.charMemory_card').each(function (ci) {
                $(this).attr('data-block', ci);
                $(this).find('.charMemory_deleteBlockBtn').attr('data-block', ci);
                $(this).find('.charMemory_bulletRow').each(function (ri) {
                    $(this).attr('data-block', ci).attr('data-bullet', ri);
                    $(this).find('.charMemory_editBtn, .charMemory_deleteBtn').attr('data-block', ci).attr('data-bullet', ri);
                });
            });
        });
    } else {
        $('.charMemory_manager .charMemory_card').each(function (ci) {
            $(this).attr('data-block', ci);
            $(this).find('.charMemory_deleteBlockBtn').attr('data-block', ci);
            $(this).find('.charMemory_bulletRow').each(function (ri) {
                $(this).attr('data-block', ci).attr('data-bullet', ri);
                $(this).find('.charMemory_editBtn, .charMemory_deleteBtn').attr('data-block', ci).attr('data-bullet', ri);
            });
        });
    }
}

async function editMemory(blockIndex, bulletIndex, avatar, fileName) {
    const content = await readMemoriesForCharacter(avatar, fileName);
    const blocks = parseMemories(content);

    if (blockIndex < 0 || blockIndex >= blocks.length) return;
    const block = blocks[blockIndex];
    if (bulletIndex < 0 || bulletIndex >= block.bullets.length) return;

    const edited = await callGenericPopup('Edit memory:', POPUP_TYPE.INPUT, block.bullets[bulletIndex], { rows: 3 });
    if (edited === null || edited === false) return;

    const newText = String(edited).trim();
    block.bullets[bulletIndex] = newText;
    await writeMemoriesForCharacter(serializeMemories(blocks), avatar, fileName);
    toastr.success('Memory updated.', 'CharMemory');

    // Update DOM in place — scope to section if present
    const $scope = $(`.charMemory_groupSection[data-avatar="${avatar}"]`);
    const $row = ($scope.length ? $scope : $('.charMemory_manager'))
        .find(`.charMemory_bulletRow[data-block="${blockIndex}"][data-bullet="${bulletIndex}"]`);
    $row.find('.charMemory_bulletText').text('- ' + newText);
}

async function deleteMemory(blockIndex, bulletIndex, avatar, fileName) {
    const content = await readMemoriesForCharacter(avatar, fileName);
    const blocks = parseMemories(content);

    if (blockIndex < 0 || blockIndex >= blocks.length) return;
    const block = blocks[blockIndex];
    if (bulletIndex < 0 || bulletIndex >= block.bullets.length) return;

    const confirm = await callGenericPopup(`Delete this memory?\n\n- ${block.bullets[bulletIndex]}`, POPUP_TYPE.CONFIRM);
    if (!confirm) return;

    block.bullets.splice(bulletIndex, 1);
    if (block.bullets.length === 0) {
        blocks.splice(blockIndex, 1);
    }

    await writeMemoriesForCharacter(serializeMemories(blocks), avatar, fileName);
    toastr.success('Memory deleted.', 'CharMemory');

    // Update DOM in place
    const $scope = $(`.charMemory_groupSection[data-avatar="${avatar}"]`);
    const $row = ($scope.length ? $scope : $('.charMemory_manager'))
        .find(`.charMemory_bulletRow[data-block="${blockIndex}"][data-bullet="${bulletIndex}"]`);
    const $card = $row.closest('.charMemory_card');
    $row.remove();

    if ($card.find('.charMemory_bulletRow').length === 0) {
        $card.remove();
    }
    if ($scope.length && $scope.find('.charMemory_card').length === 0) {
        $scope.remove();
    }
    if ($('.charMemory_manager .charMemory_card').length === 0) {
        $('.charMemory_manager').html('<div style="text-align:center;padding:1em;">No memories yet.</div>');
    }

    reindexManager();
}

async function deleteBlock(blockIndex, avatar, fileName) {
    const content = await readMemoriesForCharacter(avatar, fileName);
    const blocks = parseMemories(content);

    if (blockIndex < 0 || blockIndex >= blocks.length) return;
    const block = blocks[blockIndex];

    const confirm = await callGenericPopup(`Delete all ${block.bullets.length} memories from this block?`, POPUP_TYPE.CONFIRM);
    if (!confirm) return;

    blocks.splice(blockIndex, 1);
    await writeMemoriesForCharacter(serializeMemories(blocks), avatar, fileName);
    toastr.success('Block deleted.', 'CharMemory');

    // Update DOM in place
    const $scope = $(`.charMemory_groupSection[data-avatar="${avatar}"]`);
    ($scope.length ? $scope : $('.charMemory_manager'))
        .find(`.charMemory_card[data-block="${blockIndex}"]`).remove();

    if ($scope.length && $scope.find('.charMemory_card').length === 0) {
        $scope.remove();
    }
    if ($('.charMemory_manager .charMemory_card').length === 0) {
        $('.charMemory_manager').html('<div style="text-align:center;padding:1em;">No memories yet.</div>');
    }

    reindexManager();
}

// ============ Consolidation ============

/**
 * Re-index editingSet after a block is removed via splice.
 * Indices above the removed position shift down by one.
 */
function reindexEditingSet(editingSet, removedIndex) {
    const updated = new Set();
    for (const idx of editingSet) {
        if (idx < removedIndex) updated.add(idx);
        else if (idx > removedIndex) updated.add(idx - 1);
    }
    editingSet.clear();
    for (const idx of updated) editingSet.add(idx);
}

function renderConsolidatedCards(blocks, editingSet) {
    return blocks.map((b, bi) => {
        const isEditing = editingSet.has(bi);
        const themeLabel = `${bi + 1}. ${b.chat}`;

        if (isEditing) {
            const bullets = b.bullets.map((bullet, bui) =>
                `<div class="charMemory_editorBulletRow" data-block="${bi}" data-bullet="${bui}">
                    <span class="charMemory_editorDash">-</span>
                    <input type="text" class="charMemory_editorBulletInput" value="${escapeHtml(bullet)}" data-block="${bi}" data-bullet="${bui}" />
                    <button class="charMemory_editorDeleteBullet menu_button menu_button_icon" data-block="${bi}" data-bullet="${bui}" title="Delete memory"><i class="fa-solid fa-trash fa-xs"></i></button>
                </div>`
            ).join('');
            return `<div class="charMemory_card charMemory_editorCard charMemory_editorCard--editing" data-block="${bi}">
                <div class="charMemory_cardHeader">
                    <input type="text" class="charMemory_editorThemeInput" value="${escapeHtml(b.chat)}" data-block="${bi}" />
                    <span class="charMemory_cardActions">
                        <button class="charMemory_editorToggleEdit menu_button menu_button_icon" data-block="${bi}" title="Done editing"><i class="fa-solid fa-check"></i></button>
                        <button class="charMemory_editorDeleteBlock menu_button menu_button_icon" data-block="${bi}" title="Delete block"><i class="fa-solid fa-trash"></i></button>
                    </span>
                </div>
                <div class="charMemory_editorBullets">${bullets}</div>
                <button class="charMemory_editorAddBullet menu_button" data-block="${bi}"><i class="fa-solid fa-plus fa-xs"></i> Add memory</button>
            </div>`;
        } else {
            const bullets = b.bullets.map(bullet => `<li>${escapeHtml(bullet)}</li>`).join('');
            return `<div class="charMemory_card charMemory_editorCard" data-block="${bi}">
                <div class="charMemory_cardHeader">
                    <strong>${escapeHtml(themeLabel)}</strong>
                    <span class="charMemory_cardActions">
                        <button class="charMemory_editorToggleEdit menu_button menu_button_icon" data-block="${bi}" title="Edit block"><i class="fa-solid fa-pencil"></i></button>
                    </span>
                </div>
                <ul>${bullets}</ul>
            </div>`;
        }
    }).join('');
}

function buildConsolidationDialog(beforeBlocks, beforeCount, consolidatedBlocks, editingSet) {
    const renderReadOnlyCards = (blocks) => {
        return blocks.map(b => {
            const bullets = b.bullets.map(bullet => `<li>${escapeHtml(bullet)}</li>`).join('');
            return `<div class="charMemory_card">
                <div class="charMemory_cardHeader"><strong>${escapeHtml(b.chat)}</strong> <span class="charMemory_cardDate">${escapeHtml(b.date)}</span></div>
                <ul>${bullets}</ul>
            </div>`;
        }).join('');
    };

    const afterCount = countMemories(consolidatedBlocks);
    const hasEditing = editingSet.size > 0;

    return `<div class="charMemory_consolidationDialog">
        <div class="charMemory_consolidationStats" id="charMemory_consolidationStats">
            Original: ${beforeCount} memories in ${beforeBlocks.length} blocks &rarr; Consolidated: <span id="charMemory_afterCount">${afterCount}</span> memories
        </div>
        <div class="charMemory_consolidationToolbar">
            <select id="charMemory_consolidationDialogStrategy" class="text_pole" style="max-width:200px;">
                ${Object.entries(CONSOLIDATION_PRESETS).map(([k, v]) =>
                    `<option value="${k}">${escapeHtml(v.name)}</option>`
                ).join('')}
            </select>
            <details class="charMemory_promptDisclosure charMemory_promptDisclosure--dialog">
                <summary><small>Show prompt</small></summary>
                <textarea id="charMemory_dialogPrompt" class="text_pole textarea_compact" rows="4" placeholder="Edit prompt for this strategy..."></textarea>
                <div class="charMemory_buttonRow">
                    <input type="button" id="charMemory_dialogRestoreDefault" class="menu_button" value="Restore Default" style="display:none;" />
                </div>
            </details>
            <input type="button" id="charMemory_rerunConsolidation" class="menu_button" value="Re-run" title="Send original memories to the LLM again with current strategy" />
            <input type="button" id="charMemory_undoRerun" class="menu_button" value="Undo" title="Revert to previous consolidated version" disabled />
            <span id="charMemory_rerunSpinner" style="display:none;">Working...</span>
        </div>
        <div class="charMemory_consolidationPanes">
            <div class="charMemory_consolidationPane">
                <h4>Original Memories</h4>
                <div class="charMemory_consolidationContent">${renderReadOnlyCards(beforeBlocks)}</div>
            </div>
            <div class="charMemory_consolidationPane">
                <h4>Consolidated Memories</h4>
                <div class="charMemory_consolidationContent" id="charMemory_editorPane">${renderConsolidatedCards(consolidatedBlocks, editingSet)}</div>
                <button class="charMemory_editorAddBlock menu_button ${hasEditing ? '' : 'charMemory_editorAddBlock--hidden'}" id="charMemory_editorAddBlock"><i class="fa-solid fa-plus fa-xs"></i> Add Block</button>
            </div>
        </div>
    </div>`;
}

async function undoConsolidation() {
    if (!consolidationBackup) {
        toastr.warning('No consolidation to undo.', 'CharMemory');
        return;
    }
    const confirm = await callGenericPopup('Undo the last consolidation and restore previous memories?', POPUP_TYPE.CONFIRM);
    if (!confirm) return;

    await writeMemoriesForCharacter(consolidationBackup.content, consolidationBackup.avatar, consolidationBackup.fileName);
    consolidationBackup = null;
    $('#charMemory_undoConsolidate').prop('disabled', true);
    toastr.success('Consolidation undone. Memories restored.', 'CharMemory');
    updateStatusDisplay();
}

const CONSOLIDATION_PRESETS = {
    conservative: {
        name: 'Conservative',
        description: 'Only merge near-exact duplicates. Preserves everything else.',
        prompt: `Merge ONLY near-exact duplicate memories. If two bullets say essentially the same thing, keep the more detailed version. Do NOT combine loosely related facts. Do NOT summarize. Preserve every distinct piece of information.`,
    },
    balanced: {
        name: 'Balanced',
        description: 'Merge duplicates and combine related facts.',
        prompt: `Merge duplicate or near-duplicate memories into one. Combine closely related facts about the same event or topic. Preserve all unique information — do NOT discard distinct memories. Summarize in third person.`,
    },
    aggressive: {
        name: 'Aggressive',
        description: 'Compress heavily. Summarize themes. Minimize bullet count.',
        prompt: `Aggressively consolidate these memories into the fewest possible entries. Group by theme or topic. Summarize rather than listing individual events. It's OK to lose minor details if the key facts are preserved. Aim for a compact overview.`,
    },
};

function buildConsolidationPrompt(memoriesText) {
    const strategy = extension_settings[MODULE_NAME].consolidationStrategy || 'balanced';
    const overrides = extension_settings[MODULE_NAME].consolidationPrompts || {};
    const userPrompt = overrides[strategy]
        || CONSOLIDATION_PRESETS[strategy]?.prompt
        || CONSOLIDATION_PRESETS.balanced.prompt;
    return `You are a memory consolidation assistant. Review the following character memories and consolidate them.

RULES:
${userPrompt}

ADDITIONAL FORMAT RULES:
1. Do NOT use emojis anywhere in the output.
2. Do NOT copy text verbatim from the input — rephrase in third person.
3. Group memories by theme. Each group is wrapped in <memory chat="Theme Name"></memory> tags where "Theme Name" is a short descriptive label (e.g. "Relationship History", "Character Background", "Key Events").
4. Inside each <memory> block, use a markdown bulleted list (lines starting with "- ").

MEMORIES TO CONSOLIDATE:
${memoriesText}

Output ONLY <memory> blocks. No headers, no commentary, no extra text.`;
}

async function runConsolidationLLM(memories) {
    let memoriesText = memories.map((b, i) =>
        `[Block ${i + 1}]\n${b.bullets.map(bullet => `- ${bullet}`).join('\n')}`,
    ).join('\n\n');

    const isWebLlm = extension_settings[MODULE_NAME].source === EXTRACTION_SOURCE.WEBLLM;
    if (isWebLlm) {
        const template = buildConsolidationPrompt('');
        const available = Math.max(WEBLLM_MAX_PROMPT_CHARS - template.length, 1000);
        memoriesText = truncateText(memoriesText, available);
    }

    let prompt = buildConsolidationPrompt(memoriesText);
    prompt = substituteParamsExtended(prompt);

    try {
        inApiCall = true;
        const sourceLabel = getSourceLabel();
        toastr.info(`Consolidating via ${sourceLabel}...`, 'CharMemory', { timeOut: 3000 });

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
            toastr.warning('Consolidation returned empty result.', 'CharMemory');
            return null;
        }

        // Parse into memory format, then serialize back to plain text for the editor
        const now = new Date();
        const timestamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

        const consolidationRegex = /<memory(?:\s+chat="([^"]*)")?>([\s\S]*?)<\/memory>/gi;
        const consolidationMatches = [...cleanResult.matchAll(consolidationRegex)];
        const rawEntries = consolidationMatches.length > 0
            ? consolidationMatches.map(m => ({ theme: m[1] || 'Consolidated', content: m[2].trim() })).filter(e => e.content)
            : [{ theme: 'Consolidated', content: cleanResult.trim() }].filter(e => e.content);

        const consolidated = rawEntries.map(entry => {
            const bullets = entry.content.split('\n')
                .map(l => l.trim())
                .filter(l => l.startsWith('- '))
                .map(l => l.slice(2).trim())
                .filter(Boolean);
            return { chat: entry.theme, date: timestamp, bullets: bullets.length > 0 ? bullets : [entry.content] };
        });

        return serializeMemories(consolidated);
    } catch (err) {
        console.error(LOG_PREFIX, 'Consolidation failed:', err);
        logActivity(`Consolidation failed: ${err.message}`, 'error');
        toastr.error('Memory consolidation failed. Check console for details.', 'CharMemory');
        return null;
    } finally {
        inApiCall = false;
    }
}

async function consolidateMemories() {
    if (inApiCall) {
        toastr.warning('An API call is already in progress.', 'CharMemory');
        return;
    }

    const targets = getMemoryTargets();
    if (targets.length === 0) {
        toastr.warning('No character selected.', 'CharMemory');
        return;
    }

    // For multiple targets (group), show a character picker
    let target;
    if (targets.length === 1) {
        target = targets[0];
    } else {
        const pickerHtml = targets.map((t, i) =>
            `<label class="checkbox_label"><input type="radio" name="charMemory_consolTarget" value="${i}" ${i === 0 ? 'checked' : ''} /> ${escapeHtml(t.name)}</label>`,
        ).join('<br>');
        const picked = await callGenericPopup(`Select a character to consolidate memories for:<br><br>${pickerHtml}`, POPUP_TYPE.CONFIRM);
        if (!picked) return;
        const selectedIdx = Number($('input[name="charMemory_consolTarget"]:checked').val()) || 0;
        target = targets[selectedIdx];
    }

    const content = await readMemoriesForCharacter(target.avatar, target.fileName);
    const memories = parseMemories(content);

    if (memories.length < 2) {
        toastr.info('Not enough memories to consolidate.', 'CharMemory');
        return;
    }

    const beforeCount = countMemories(memories);
    logActivity(`Consolidation started for ${target.name}: ${beforeCount} memories in ${memories.length} blocks`);

    // Show busy state on button
    const $btn = $('#charMemory_consolidate');
    $btn.val('Consolidating…').prop('disabled', true);

    // Run initial consolidation — returns serialized text, parse to blocks
    let initialResult;
    try {
        initialResult = await runConsolidationLLM(memories);
    } finally {
        $btn.val('Consolidate').prop('disabled', false);
    }
    if (!initialResult) return;

    let editorBlocks = parseMemories(initialResult);
    const versionStack = [];
    const editingSet = new Set();

    // Deep copy blocks array
    const cloneBlocks = (blocks) => blocks.map(b => ({ ...b, bullets: [...b.bullets] }));

    // Re-render the editor pane from editorBlocks
    const refreshEditor = () => {
        $('#charMemory_editorPane').html(renderConsolidatedCards(editorBlocks, editingSet));
        $('#charMemory_afterCount').text(countMemories(editorBlocks));
        $('#charMemory_editorAddBlock').toggleClass('charMemory_editorAddBlock--hidden', editingSet.size === 0);
    };

    // Build and show the interactive dialog
    const dialogHtml = buildConsolidationDialog(memories, beforeCount, editorBlocks, editingSet);
    const popup = callGenericPopup(dialogHtml, POPUP_TYPE.CONFIRM, '', { wide: true, allowVerticalScrolling: true });

    // Set up the strategy dropdown and prompt viewer to match current setting
    const currentStrategy = extension_settings[MODULE_NAME].consolidationStrategy || 'balanced';
    $('#charMemory_consolidationDialogStrategy').val(currentStrategy);
    const overrides = extension_settings[MODULE_NAME].consolidationPrompts || {};
    const currentPrompt = overrides[currentStrategy] || CONSOLIDATION_PRESETS[currentStrategy]?.prompt || '';
    $('#charMemory_dialogPrompt').val(currentPrompt);
    $('#charMemory_dialogRestoreDefault').toggle(!!overrides[currentStrategy]);

    // === Event delegation for editor interactions ===

    // Toggle edit mode per block
    $(document).off('click.charMemoryEditorToggle').on('click.charMemoryEditorToggle', '.charMemory_editorToggleEdit', function () {
        const bi = Number($(this).data('block'));
        if (editingSet.has(bi)) {
            editingSet.delete(bi);
        } else {
            editingSet.add(bi);
        }
        refreshEditor();
    });

    // Sync bullet input changes back to editorBlocks
    $(document).off('input.charMemoryEditor').on('input.charMemoryEditor', '.charMemory_editorBulletInput', function () {
        const bi = Number($(this).data('block'));
        const bui = Number($(this).data('bullet'));
        if (editorBlocks[bi]) {
            editorBlocks[bi].bullets[bui] = $(this).val();
        }
    });

    // Sync theme input changes back to editorBlocks
    $(document).off('input.charMemoryEditorTheme').on('input.charMemoryEditorTheme', '.charMemory_editorThemeInput', function () {
        const bi = Number($(this).data('block'));
        if (editorBlocks[bi]) {
            editorBlocks[bi].chat = $(this).val();
        }
    });

    // Delete bullet
    $(document).off('click.charMemoryEditorDelBullet').on('click.charMemoryEditorDelBullet', '.charMemory_editorDeleteBullet', function () {
        const bi = Number($(this).data('block'));
        const bui = Number($(this).data('bullet'));
        if (editorBlocks[bi]) {
            editorBlocks[bi].bullets.splice(bui, 1);
            if (editorBlocks[bi].bullets.length === 0) {
                editorBlocks.splice(bi, 1);
                reindexEditingSet(editingSet, bi);
            }
            refreshEditor();
        }
    });

    // Delete block
    $(document).off('click.charMemoryEditorDelBlock').on('click.charMemoryEditorDelBlock', '.charMemory_editorDeleteBlock', function () {
        const bi = Number($(this).data('block'));
        editorBlocks.splice(bi, 1);
        reindexEditingSet(editingSet, bi);
        refreshEditor();
    });

    // Add bullet to block
    $(document).off('click.charMemoryEditorAddBullet').on('click.charMemoryEditorAddBullet', '.charMemory_editorAddBullet', function () {
        const bi = Number($(this).data('block'));
        if (editorBlocks[bi]) {
            editorBlocks[bi].bullets.push('');
            refreshEditor();
            $(`#charMemory_editorPane .charMemory_editorCard[data-block="${bi}"] .charMemory_editorBulletInput:last`).focus();
        }
    });

    // Add new block
    $(document).off('click.charMemoryEditorAddBlock').on('click.charMemoryEditorAddBlock', '#charMemory_editorAddBlock', function () {
        const now = new Date();
        const timestamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
        const newIdx = editorBlocks.length;
        editorBlocks.push({ chat: 'New Group', date: timestamp, bullets: [''] });
        editingSet.add(newIdx);
        refreshEditor();
        $('#charMemory_editorPane .charMemory_editorCard:last .charMemory_editorBulletInput:last').focus();
    });

    // === Dialog prompt handlers ===
    $('#charMemory_dialogPrompt').off('input').on('input', function () {
        const strategy = $('#charMemory_consolidationDialogStrategy').val();
        if (!extension_settings[MODULE_NAME].consolidationPrompts) {
            extension_settings[MODULE_NAME].consolidationPrompts = {};
        }
        extension_settings[MODULE_NAME].consolidationPrompts[strategy] = $(this).val();
        $('#charMemory_dialogRestoreDefault').show();
        saveSettingsDebounced();
    });

    $('#charMemory_dialogRestoreDefault').off('click').on('click', function () {
        const strategy = $('#charMemory_consolidationDialogStrategy').val();
        if (extension_settings[MODULE_NAME].consolidationPrompts) {
            delete extension_settings[MODULE_NAME].consolidationPrompts[strategy];
        }
        const preset = CONSOLIDATION_PRESETS[strategy];
        $('#charMemory_dialogPrompt').val(preset?.prompt || '');
        $('#charMemory_dialogRestoreDefault').hide();
        saveSettingsDebounced();
    });

    $('#charMemory_consolidationDialogStrategy').off('change').on('change', function () {
        const strategy = $(this).val();
        const dlgOverrides = extension_settings[MODULE_NAME].consolidationPrompts || {};
        const prompt = dlgOverrides[strategy] || CONSOLIDATION_PRESETS[strategy]?.prompt || '';
        const isCustomized = !!dlgOverrides[strategy];
        $('#charMemory_dialogPrompt').val(prompt);
        $('#charMemory_dialogRestoreDefault').toggle(isCustomized);
    });

    // === Re-run button ===
    $('#charMemory_rerunConsolidation').off('click').on('click', async () => {
        if (inApiCall) return;

        const currentBlocks = cloneBlocks(editorBlocks);

        const dialogStrategy = $('#charMemory_consolidationDialogStrategy').val();
        extension_settings[MODULE_NAME].consolidationStrategy = dialogStrategy;
        updateConsolidationStrategyUI();
        saveSettingsDebounced();

        $('#charMemory_rerunSpinner').show();
        $('#charMemory_rerunConsolidation').prop('disabled', true);
        $('#charMemory_editorPane').addClass('charMemory_editorDisabled');

        const newResult = await runConsolidationLLM(memories);

        $('#charMemory_rerunSpinner').hide();
        $('#charMemory_rerunConsolidation').prop('disabled', false);
        $('#charMemory_editorPane').removeClass('charMemory_editorDisabled');

        if (newResult) {
            versionStack.push(currentBlocks);
            $('#charMemory_undoRerun').prop('disabled', false);
            editorBlocks = parseMemories(newResult);
            editingSet.clear();
            refreshEditor();
        }
    });

    // === Undo button ===
    $('#charMemory_undoRerun').off('click').on('click', () => {
        if (versionStack.length === 0) return;
        editorBlocks = versionStack.pop();
        editingSet.clear();
        refreshEditor();
        if (versionStack.length === 0) {
            $('#charMemory_undoRerun').prop('disabled', true);
        }
    });

    // === Wait for Accept/Cancel ===
    const confirmed = await popup;

    // Clean up event delegation
    $(document).off('click.charMemoryEditorToggle');
    $(document).off('input.charMemoryEditor');
    $(document).off('input.charMemoryEditorTheme');
    $(document).off('click.charMemoryEditorDelBullet');
    $(document).off('click.charMemoryEditorDelBlock');
    $(document).off('click.charMemoryEditorAddBullet');
    $(document).off('click.charMemoryEditorAddBlock');

    if (!confirmed) {
        logActivity('Consolidation cancelled by user');
        toastr.info('Consolidation cancelled.', 'CharMemory');
        updateConsolidationStrategyUI();
        return;
    }

    if (inApiCall) {
        toastr.warning('Cannot save while a re-run is in progress.', 'CharMemory');
        return;
    }

    // Filter out empty bullets and empty blocks before saving
    const cleanBlocks = editorBlocks
        .map(b => ({ ...b, bullets: b.bullets.filter(bullet => bullet.trim() !== '') }))
        .filter(b => b.bullets.length > 0);

    if (cleanBlocks.length === 0) {
        toastr.warning('No memories to save. Memories unchanged.', 'CharMemory');
        return;
    }

    consolidationBackup = { content, avatar: target.avatar, fileName: target.fileName };
    await writeMemoriesForCharacter(serializeMemories(cleanBlocks), target.avatar, target.fileName);
    $('#charMemory_undoConsolidate').prop('disabled', false);

    const afterCount = countMemories(cleanBlocks);
    logActivity(`Consolidation complete: ${beforeCount} → ${afterCount} memories`, 'success');
    toastr.success(`Consolidated ${beforeCount} → ${afterCount} memories.`, 'CharMemory');
    updateStatusDisplay();
    updateConsolidationStrategyUI();
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
            const modelCount = currentModelList.length;
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

    // Model search input — filter dropdown on typing
    $('#charMemory_modelSearch').off('input').on('input', function () {
        const filter = $(this).val();
        renderModelDropdown(filter);
        $('#charMemory_modelDropdown').addClass('open');
    });

    // Model search input — open dropdown on focus
    $('#charMemory_modelSearch').off('focus').on('focus', function () {
        renderModelDropdown($(this).val());
        $('#charMemory_modelDropdown').addClass('open');
    });

    // Model dropdown — select a model on click
    $('#charMemory_modelDropdown').off('click').on('click', '.charMemory_modelOption', function () {
        const modelId = $(this).data('model-id');
        const model = currentModelList.find(m => m.id === modelId);
        if (!model) return;

        $('#charMemory_providerModel').val(modelId);
        $('#charMemory_modelSearch').val(model.name);
        $('#charMemory_modelDropdown').removeClass('open');

        const providerKey = extension_settings[MODULE_NAME].selectedProvider;
        const providerSettings = getProviderSettings(providerKey);
        providerSettings.model = modelId;
        saveSettingsDebounced();

        if (providerKey === 'nanogpt' && cachedNanoGptModels) {
            updateProviderModelInfo(cachedNanoGptModels, modelId);
        }
    });

    // Close dropdown when clicking outside
    $(document).off('click.charMemoryModelPicker').on('click.charMemoryModelPicker', function (e) {
        if (!$(e.target).closest('.charMemory_modelPicker').length) {
            $('#charMemory_modelDropdown').removeClass('open');
            // Restore display to current selection if search was abandoned
            const selectedId = $('#charMemory_providerModel').val();
            if (selectedId) {
                const model = currentModelList.find(m => m.id === selectedId);
                if (model) $('#charMemory_modelSearch').val(model.name);
            } else {
                $('#charMemory_modelSearch').val('');
            }
        }
    });

    // Keyboard navigation in model dropdown
    $('#charMemory_modelSearch').off('keydown').on('keydown', function (e) {
        const $dropdown = $('#charMemory_modelDropdown');
        if (!$dropdown.hasClass('open')) {
            if (e.key === 'ArrowDown' || e.key === 'Enter') {
                renderModelDropdown($(this).val());
                $dropdown.addClass('open');
                e.preventDefault();
            }
            return;
        }

        const $options = $dropdown.find('.charMemory_modelOption');
        const $active = $dropdown.find('.charMemory_modelOption.active');
        let idx = $options.index($active);

        if (e.key === 'ArrowDown') {
            e.preventDefault();
            idx = Math.min(idx + 1, $options.length - 1);
            $options.removeClass('active');
            $options.eq(idx).addClass('active');
            $options.eq(idx)[0]?.scrollIntoView({ block: 'nearest' });
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            idx = Math.max(idx - 1, 0);
            $options.removeClass('active');
            $options.eq(idx).addClass('active');
            $options.eq(idx)[0]?.scrollIntoView({ block: 'nearest' });
        } else if (e.key === 'Enter') {
            e.preventDefault();
            if ($active.length) {
                $active.click();
            }
        } else if (e.key === 'Escape') {
            $dropdown.removeClass('open');
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

    $('#charMemory_consolidationStrategy').off('change').on('change', function () {
        extension_settings[MODULE_NAME].consolidationStrategy = String($(this).val());
        updateConsolidationStrategyUI();
        saveSettingsDebounced();
    });

    // Consolidation prompt editing — save override for current strategy
    $('#charMemory_consolidationPrompt').off('input').on('input', function () {
        const strategy = extension_settings[MODULE_NAME].consolidationStrategy || 'balanced';
        if (!extension_settings[MODULE_NAME].consolidationPrompts) {
            extension_settings[MODULE_NAME].consolidationPrompts = {};
        }
        extension_settings[MODULE_NAME].consolidationPrompts[strategy] = $(this).val();
        $('#charMemory_restorePresetDefault').show();
        saveSettingsDebounced();
    });

    // Restore preset default prompt
    $('#charMemory_restorePresetDefault').off('click').on('click', function () {
        const strategy = extension_settings[MODULE_NAME].consolidationStrategy || 'balanced';
        if (extension_settings[MODULE_NAME].consolidationPrompts) {
            delete extension_settings[MODULE_NAME].consolidationPrompts[strategy];
        }
        updateConsolidationStrategyUI();
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

        // Also clear stored memories for ALL targets so re-extraction starts fresh
        const resetTargets = getMemoryTargets();
        for (const target of resetTargets) {
            const existing = findMemoryAttachmentForCharacter(target.avatar, target.fileName);
            if (existing) {
                await deleteFileFromServer(existing.url, true);
                ensureCharacterAttachments(target.avatar);
                extension_settings.character_attachments[target.avatar] =
                    extension_settings.character_attachments[target.avatar].filter(a => a.url !== existing.url);
            }
        }
        saveSettingsDebounced();

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

    $('#charMemory_mergeChunks').off('change').on('change', function () {
        extension_settings[MODULE_NAME].mergeChunks = !!$(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#charMemory_perChat').off('change').on('change', function () {
        extension_settings[MODULE_NAME].perChat = !!$(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#charMemory_manageMemories').off('click').on('click', () => showMemoryManager());

    $('#charMemory_consolidate').off('click').on('click', () => consolidateMemories());
    $('#charMemory_undoConsolidate').off('click').on('click', () => undoConsolidation());

    // Tab switching for top-level panel tabs
    $('.charMemory_tab').off('click').on('click', function () {
        const tab = $(this).data('tab');
        $('.charMemory_tab').removeClass('active');
        $(this).addClass('active');
        $('.charMemory_tabContent').hide();
        const capName = tab.charAt(0).toUpperCase() + tab.slice(1);
        $(`#charMemory_tab${capName}`).show();
        // Auto-load batch list when switching to Tools tab with Batch pill active
        if (tab === 'tools' && $('.charMemory_toolPill.active').data('tool') === 'batch') {
            loadBatchChatList();
        }
    });

    // Pill switching within Tools tab
    $('.charMemory_toolPill').off('click').on('click', function () {
        const tool = $(this).data('tool');
        $('.charMemory_toolPill').removeClass('active');
        $(this).addClass('active');
        $('.charMemory_toolContent').hide();
        $(`#charMemory_tool${tool.charAt(0).toUpperCase() + tool.slice(1)}`).show();
        if (tool === 'batch') loadBatchChatList();
        if (tool === 'convert') populateConvertSourceDropdown();
    });

    // Chunk boundary format controls
    $('#charMemory_chunkBoundary').off('change').on('change', async function () {
        const val = $(this).val();
        extension_settings[MODULE_NAME].chunkBoundary = val;
        saveSettingsDebounced();
        toggleChunkBoundaryUI(val);
        await offerReformat();
    });

    $('#charMemory_customSeparator').off('input').on('input', function () {
        extension_settings[MODULE_NAME].customSeparator = $(this).val();
        saveSettingsDebounced();
    });

    $('#charMemory_chunkMetadata').off('change').on('change', function () {
        extension_settings[MODULE_NAME].chunkMetadata = $(this).prop('checked');
        saveSettingsDebounced();
    });

    // Convert tool
    $('#charMemory_convertPreview').off('click').on('click', () => previewConversion());
    $('#charMemory_restoreConvertPrompt').off('click').on('click', () => {
        $('#charMemory_convertPrompt').val(defaultConversionPrompt);
        extension_settings[MODULE_NAME].conversionPrompt = '';
        saveSettingsDebounced();
    });
    $('#charMemory_convertPrompt').off('input').on('input', function () {
        extension_settings[MODULE_NAME].conversionPrompt = $(this).val();
        saveSettingsDebounced();
    });
    $('#charMemory_refreshDiag').off('click').on('click', function () {
        captureDiagnostics();
        toastr.info('Diagnostics refreshed.', 'CharMemory');
    });

    // Health indicator click — scroll to diagnostics
    $('#charMemory_statHealth').off('click').on('click', function () {
        const $diag = $('.charMemory_bottomDiagnostics');
        if ($diag.length) {
            $diag[0].scrollIntoView({ behavior: 'smooth', block: 'start' });
            $diag.css('outline', '2px solid var(--SmartThemeQuoteColor, #e8a33d)');
            setTimeout(() => $diag.css('outline', ''), 1500);
        }
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

    // Injection data indicator
    $nameBlock.find('.charMemory_injectionIndicator').remove();
    const hasInjectionData = chat_metadata[MODULE_NAME]?.injectionData?.[messageIndex];
    if (hasInjectionData) {
        $nameBlock.append('<span class="charMemory_injectionIndicator" title="Click to view injected context" data-mesid="' + messageIndex + '"><i class="fa-solid fa-syringe fa-xs"></i></span>');
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
        if ($extraBtns.find('.charMemory_extractHereBtn, .charMemory_pinMemoryBtn, .charMemory_viewInjectedBtn').length) return;

        // Pin as memory — all non-system messages
        $extraBtns.prepend(`<div class="mes_button charMemory_pinMemoryBtn" data-mesid="${mesId}" title="Pin as memory"><i class="fa-solid fa-bookmark"></i></div>`);

        // Extract from here — character messages only
        if (!msg.is_user) {
            $extraBtns.prepend(`<div class="mes_button charMemory_extractHereBtn" data-mesid="${mesId}" title="Extract memories up to here"><i class="fa-solid fa-brain"></i></div>`);
            // View injected context
            $extraBtns.prepend(`<div class="mes_button charMemory_viewInjectedBtn" data-mesid="${mesId}" title="View injected context"><i class="fa-solid fa-syringe"></i></div>`);
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
    $extraBtns.find('.charMemory_extractHereBtn, .charMemory_pinMemoryBtn, .charMemory_viewInjectedBtn').remove();

    // Pin as memory — available on all non-system messages (user + character)
    $extraBtns.prepend(`<div class="mes_button charMemory_pinMemoryBtn" data-mesid="${messageIndex}" title="Pin as memory"><i class="fa-solid fa-bookmark"></i></div>`);

    // Extract from here — character messages only
    if (!msg.is_user) {
        $extraBtns.prepend(`<div class="mes_button charMemory_extractHereBtn" data-mesid="${messageIndex}" title="Extract memories up to here"><i class="fa-solid fa-brain"></i></div>`);
        // View injected context
        $extraBtns.prepend(`<div class="mes_button charMemory_viewInjectedBtn" data-mesid="${messageIndex}" title="View injected context"><i class="fa-solid fa-syringe"></i></div>`);
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

    // Find the target matching the message sender (for groups, match by name)
    const targets = getMemoryTargets();
    const senderName = msg.name;
    const target = targets.find(t => t.name === senderName) || targets[0];
    if (!target) return;

    const existingContent = await readMemoriesForCharacter(target.avatar, target.fileName);
    const blocks = parseMemories(existingContent);
    blocks.push({ chat: chatId, date: timestamp, bullets });
    await writeMemoriesForCharacter(serializeMemories(blocks), target.avatar, target.fileName);

    toastr.success(`${bullets.length} memor${bullets.length === 1 ? 'y' : 'ies'} pinned${targets.length > 1 ? ` to ${target.name}` : ''}!`, 'CharMemory');
    updateStatusDisplay();
}

/**
 * Click handler for "View Injected" button and injection indicator.
 */
function onViewInjectedClick() {
    const messageIndex = Number($(this).data('mesid'));
    if (isNaN(messageIndex)) return;
    showInjectionDrawer(messageIndex);
}

/**
 * Toggle the injection viewer drawer open/closed.
 * @param {boolean} [forceState] If provided, force open (true) or closed (false).
 */
function toggleInjectionDrawer(forceState) {
    const $drawer = $('#charMemory_injectionDrawer');
    const $toggle = $('#charMemory_drawerToggle');
    const isOpen = $drawer.hasClass('open');
    const shouldOpen = forceState !== undefined ? forceState : !isOpen;

    $drawer.toggleClass('open', shouldOpen);
    $toggle.toggleClass('open', shouldOpen);

    // Persist state
    extension_settings[MODULE_NAME].injectionDrawerOpen = shouldOpen;
    saveSettingsDebounced();
}

/**
 * Show the injection drawer for a specific message.
 * @param {number} messageIndex The chat message index to display.
 */
function showInjectionDrawer(messageIndex) {
    ensureMetadata();
    const snapshot = chat_metadata[MODULE_NAME]?.injectionData?.[messageIndex];

    const $body = $('#charMemory_drawerBody');
    const $label = $('#charMemory_drawerMsgLabel');
    const $toolbar = $('#charMemory_drawerToolbar');

    $label.text(`\u2014 Message #${messageIndex}`);

    if (!snapshot) {
        $body.html('<div class="charMemory_diagEmpty">No injection data recorded for this message.</div>');
        $toolbar.html('');
        toggleInjectionDrawer(true);
        return;
    }

    let html = '';

    // Per-message health notes
    const memCount = snapshot.memories?.length || 0;
    if (memCount === 0) {
        html += '<div class="charMemory_drawerHealthNote charMemory_drawerHealthNote--red">'
            + '<i class="fa-solid fa-circle-xmark fa-xs"></i> No memories injected for this message. '
            + 'Check the health indicator in the status bar.'
            + '</div>';
    } else {
        const uniqueTexts = new Set(snapshot.memories.map(m => m.text));
        const dupeCount = memCount - uniqueTexts.size;
        if (dupeCount > 0) {
            html += '<div class="charMemory_drawerHealthNote charMemory_drawerHealthNote--yellow">'
                + `<i class="fa-solid fa-triangle-exclamation fa-xs"></i> ${dupeCount} duplicate memor${dupeCount === 1 ? 'y' : 'ies'} detected. `
                + 'This may indicate chunk boundary issues in Vector Storage.'
                + '</div>';
        }
    }

    // CharMemory section
    html += '<div class="charMemory_drawerSection">';
    html += '<div class="charMemory_drawerSectionHeader" data-section="memories">';
    html += '<i class="fa-solid fa-chevron-down charMemory_drawerChevron"></i> ';
    html += `<strong>CharMemory</strong> <span class="charMemory_drawerCount">(${memCount})</span>`;
    html += '</div>';
    html += '<div class="charMemory_drawerSectionBody">';
    if (memCount > 0) {
        for (const mem of snapshot.memories) {
            html += `<div class="charMemory_drawerBullet">- ${escapeHtml(mem.text)}</div>`;
        }
    } else {
        html += '<div class="charMemory_diagEmpty">No memories injected</div>';
    }
    html += '</div></div>';

    // Lorebook Entries section
    const wiCount = snapshot.worldInfo?.length || 0;
    html += '<div class="charMemory_drawerSection">';
    html += '<div class="charMemory_drawerSectionHeader" data-section="worldinfo">';
    html += '<i class="fa-solid fa-chevron-down charMemory_drawerChevron"></i> ';
    html += `<strong>Lorebook Entries</strong> <span class="charMemory_drawerCount">(${wiCount})</span>`;
    html += '</div>';
    html += '<div class="charMemory_drawerSectionBody">';
    if (wiCount > 0) {
        for (const entry of snapshot.worldInfo) {
            html += '<div class="charMemory_drawerCard">';
            html += `<div class="charMemory_drawerCardTitle">${escapeHtml(entry.comment)}</div>`;
            if (entry.keys?.length > 0) {
                html += `<div class="charMemory_drawerCardKeys">Keys: ${escapeHtml(entry.keys.join(', '))}</div>`;
            }
            if (entry.content) {
                html += `<div class="charMemory_drawerCardContent">${escapeHtml(entry.content)}${entry.content.length >= 200 ? '...' : ''}</div>`;
            }
            html += '</div>';
        }
    } else {
        html += '<div class="charMemory_diagEmpty">No lorebook entries activated</div>';
    }
    html += '</div></div>';

    // Extension Prompts section
    const epCount = snapshot.extensionPrompts?.length || 0;
    html += '<div class="charMemory_drawerSection">';
    html += '<div class="charMemory_drawerSectionHeader" data-section="prompts">';
    html += '<i class="fa-solid fa-chevron-down charMemory_drawerChevron"></i> ';
    html += `<strong>Extension Prompts</strong> <span class="charMemory_drawerCount">(${epCount})</span>`;
    html += '</div>';
    html += '<div class="charMemory_drawerSectionBody">';
    if (epCount > 0) {
        for (const prompt of snapshot.extensionPrompts) {
            html += '<div class="charMemory_drawerCard">';
            html += `<div class="charMemory_drawerCardTitle">${escapeHtml(prompt.label)}</div>`;
            const isTruncated = prompt.label !== '4_vectors_data_bank' && prompt.content.length >= 500;
            html += `<div class="charMemory_drawerCardContent" style="white-space:pre-wrap;">${escapeHtml(prompt.content)}${isTruncated ? '...' : ''}</div>`;
            html += '</div>';
        }
    } else {
        html += '<div class="charMemory_diagEmpty">No extension prompts active</div>';
    }
    html += '</div></div>';

    $body.html(html);
    $toolbar.html(`<span>Captured at ${escapeHtml(snapshot.timestamp)}</span><span class="charMemory_drawerDiagLink" title="Open CharMemory panel and scroll to Diagnostics">Diagnostics</span>`);

    // Open the drawer
    toggleInjectionDrawer(true);

    // Highlight the selected message briefly
    $('#chat .mes').removeClass('charMemory_highlightMes');
    $(`#chat .mes[mesid="${messageIndex}"]`).addClass('charMemory_highlightMes');
    setTimeout(() => $(`#chat .mes[mesid="${messageIndex}"]`).removeClass('charMemory_highlightMes'), 1500);
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

    // Injection viewer drawer — appended to body, outside extension panel
    $('body').append(`
        <div id="charMemory_injectionDrawer" class="charMemory_injectionDrawer">
            <div class="charMemory_drawerHeader">
                <span class="charMemory_healthDot" id="charMemory_drawerHealthDot" title="Injection health"></span>
                <span class="charMemory_drawerTitle">Injected Context</span>
                <span class="charMemory_drawerMsgLabel" id="charMemory_drawerMsgLabel"></span>
                <div class="charMemory_drawerClose" id="charMemory_drawerClose" title="Close"><i class="fa-solid fa-xmark"></i></div>
            </div>
            <div class="charMemory_drawerToolbar" id="charMemory_drawerToolbar"></div>
            <div class="charMemory_drawerBody" id="charMemory_drawerBody">
                <div class="charMemory_diagEmpty">Click the <i class="fa-solid fa-syringe"></i> icon on a message to view its injected context.</div>
            </div>
            <div class="charMemory_drawerFooter" id="charMemory_drawerFooter"></div>
        </div>
        <div id="charMemory_drawerBackdrop" class="charMemory_drawerBackdrop"></div>
        <div id="charMemory_drawerToggle" class="charMemory_drawerToggle" title="Toggle injection viewer">
            <i class="fa-solid fa-syringe"></i>
        </div>
    `);

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
    $(document).on('click', '.charMemory_viewInjectedBtn', onViewInjectedClick);
    $(document).on('click', '.charMemory_injectionIndicator', onViewInjectedClick);

    // Diagnostics hooks
    eventSource.on(event_types.WORLD_INFO_ACTIVATED, onWorldInfoActivated);
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, captureDiagnostics);

    // Injection drawer controls
    $('#charMemory_drawerClose').on('click', () => toggleInjectionDrawer(false));
    $('#charMemory_drawerToggle').on('click', () => toggleInjectionDrawer());

    // Drawer "Open Diagnostics" link
    $(document).on('click', '.charMemory_drawerDiagLink', function () {
        const $diag = $('.charMemory_bottomDiagnostics');
        if ($diag.length) {
            $diag[0].scrollIntoView({ behavior: 'smooth', block: 'start' });
            $diag.css('outline', '2px solid var(--SmartThemeQuoteColor, #e8a33d)');
            setTimeout(() => $diag.css('outline', ''), 1500);
        }
    });

    // Swipe right to close drawer (touch devices)
    let touchStartX = 0;
    const drawer = document.getElementById('charMemory_injectionDrawer');
    if (drawer) {
        drawer.addEventListener('touchstart', (e) => {
            touchStartX = e.touches[0].clientX;
        }, { passive: true });
        drawer.addEventListener('touchend', (e) => {
            const deltaX = e.changedTouches[0].clientX - touchStartX;
            if (deltaX > 60) toggleInjectionDrawer(false);
        }, { passive: true });
    }

    // Drawer section collapse/expand
    $(document).on('click', '.charMemory_drawerSectionHeader', function () {
        const $body = $(this).next('.charMemory_drawerSectionBody');
        const $chevron = $(this).find('.charMemory_drawerChevron');
        $body.slideToggle(150);
        $chevron.toggleClass('collapsed');
    });

    // Restore drawer state from settings
    if (extension_settings[MODULE_NAME].injectionDrawerOpen) {
        toggleInjectionDrawer(true);
    }

    console.log(LOG_PREFIX, 'Extension loaded');
});
