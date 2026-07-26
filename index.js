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
    getMaxContextSize,
    itemizedPrompts,
    itemizedParams,
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
import { t } from '../../../i18n.js';
import {
    escapeAttr,
    escapeHtml,
    parseMemories,
    splitMultiTagBullets,
    countMemories,
    mergeMemoryBlocks,
    migrateMemoriesIfNeeded,
    convertHeuristic,
    formatChatMessages,
    substitutePromptTemplate,
    truncateText,
    getTimestamp,
    countMatchesInBlocks,
    replaceInBlocks,
    cloneMemoryBlocks,
    shouldExtractNow,
    estimateConsolidationSize,
    packBlocksIntoChunks,
    classifyBlocksForConsolidation,
    shouldSkipStaleMetadataReset,
} from './lib.js';
import { createMemoryEditor } from './editor.js';
import { runChunkedConsolidation } from './consolidation.js';

const MODULE_NAME = 'charMemory';
const MODULE_VERSION = '2.3.0';
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
let reformatBackup = null;
let consolidationCancelRequested = false;
// Dedicated reentrancy flags for consolidateMemories/reformatMemories, separate from
// inApiCall. inApiCall is only actually held during the real LLM call inside these flows
// (set deep inside runConsolidationLLM/convertWithLLM), not during the character-picker /
// protected-blocks confirmation popups that precede it — extending inApiCall itself across
// those popups would block unrelated actions (like auto-extraction) for however long the
// user takes to answer a dialog. These flags instead just stop the SAME flow (button click
// or slash command) from being entered twice concurrently while its own popups are open.
let consolidationInFlight = false;
let reformatInFlight = false;
// convertPreviewResult removed — conversion state now lives in the dialog closure
let lastExtractionTime = 0; // session-only, resets on page load
let isGenerating = false;
let pendingExtraction = false;

// ============ Activity Log ============

const MAX_LOG_ENTRIES = 500;
let activityLog = [];

function logActivity(message, type = 'info') {
    const now = new Date();
    const timestamp = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
    const entry = { timestamp, message, type };
    activityLog.unshift(entry);
    if (activityLog.length > MAX_LOG_ENTRIES) activityLog.pop();
    updateActivityLogDisplay();
    updateLogDrawer(entry);
}

function renderLogEntryHtml(entry) {
    const typeClass = `charMemory_log_${entry.type}`;
    const isVerbose = entry.message.includes('\n');
    const msgHtml = isVerbose
        ? `<details><summary>${escapeHtml(entry.message.split('\n')[0])}</summary><pre class="charMemory_logVerbose">${escapeHtml(entry.message)}</pre></details>`
        : escapeHtml(entry.message);
    return `<div class="charMemory_logEntry ${typeClass}"><span class="charMemory_logTime">${entry.timestamp}</span> ${msgHtml}</div>`;
}

function updateActivityLogDisplay() {
    // Update dashboard activity (last 3 entries, first line only)
    const $dashActivity = $('#charMemory_dashActivity');
    if (!$dashActivity.length) return;

    if (activityLog.length === 0) {
        $dashActivity.html(`<div class="charMemory_diagEmpty charMemory_miniLogEmpty">${t`No activity yet.`}</div>`);
        return;
    }

    const miniEntries = activityLog.slice(0, 3);
    const miniHtml = miniEntries.map(entry => {
        const typeClass = `charMemory_log_${entry.type}`;
        const msgText = entry.message.split('\n')[0];
        return `<div class="charMemory_logEntry ${typeClass}"><span class="charMemory_logTime">${entry.timestamp}</span> ${escapeHtml(msgText)}</div>`;
    }).join('');
    $dashActivity.html(miniHtml);
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
2. Write in past tense, third person. Always refer to {{charName}} by name, not "she/he/they". Do NOT quote dialogue verbatim.
3. Do NOT use emojis.
4. Wrap output in <memory></memory> tags with a markdown bulleted list (lines starting with "- ").
5. Use ONE <memory> block per encounter or event. Everything in the same scene = one block. If events happen in the same evening or outing, that is ONE block — do not split by location or sub-event.
6. Start each block with a topic tag as the first bullet: "- [{{charName}}, OtherNames — short description]". ALWAYS include {{charName}} first, then other key participants. This aids later retrieval.
7. HARD LIMIT: No more than 5 bullet points per block (not counting the topic tag). If you have more, you are being too granular — keep only the most significant outcomes.
8. If nothing genuinely new or significant, respond with exactly: NO_NEW_MEMORIES
9. Write about WHAT HAPPENED, not about the conversation itself. Never write "she told him about X" or "she described her X" or "she admitted Y" — instead write the actual fact: "X happened" or "she did Y."

WHAT TO EXTRACT — ask for each item: "Would {{char}} bring this up unprompted weeks or months later?"
- Backstory reveals, personal history, goals, fears (only if NOT already in the character card)
- Relationship changes (new connections, betrayals, shifts in feeling)
- Significant events and their outcomes (not the step-by-step process)
- Skills, possessions, or status changes
- Emotional turning points
- Dates and times when mentioned or clearly implied in the conversation
- Always name specific people involved — use their name, not "a friend" or "someone"

DO NOT EXTRACT:
- Anything already described in the CHARACTER CARD above — traits, profession, appearance, personality, habits, preferences, or abilities that are baseline knowledge. This includes rephrasing card traits as discoveries (e.g. if the card says "competitive", do not write "she felt proud when she won again")
- Routine behaviors that simply confirm what the card already says (e.g. if the card says "smoker", don't extract "she smoked a cigarette"; if the card says "meticulous", don't extract "she organized her bag again")
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
- Alex set the carrier down on the hardwood floor and opened the metal door.
- Flux emerged from the carrier and walked toward the Gundam Roomba by the window.
- Alex poured premium salmon pâté into a ceramic bowl and placed it near the kitchen island.
- Flux ate the salmon and began purring for the first time.
- Alex had a video conference with Mr. Henderson about the Q1 marketing budget.
- Flux rode the Roomba around the apartment, inspecting a floor lamp and a bookshelf.
- Alex assembled a cat tree in the corner and Flux climbed to the top perch.
- Alex ordered sushi for lunch and ate it on the balcony.
</bad_example>
This is a play-by-play scene summary. It narrates every step instead of capturing what matters.

POSITIVE EXAMPLE — the same scene extracted well:
<good_example>
- [Alex, Flux — adoption day and settling into the apartment]
- Alex adopted Flux and brought him to his penthouse apartment, where Flux immediately bonded with his custom Gundam-styled Roomba.
- Flux's first meal of premium salmon pâté triggered his first purr in the new home.
- Alex assembled a cat tree that Flux claimed as a second perch, alternating between it and the Roomba.
</good_example>
A topic tag plus three bullets capture the full encounter: who was involved, what happened, and the key bonding moments. No step-by-step process, no scene-setting.

NOTE: When significant events occur, name the specific outcome clearly — do not sanitize into vague language. "She confronted him and left" is a memory. "Something happened between them" is not. But this does NOT mean narrate each step leading up to it — summarize the outcome, not the process.

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
2. Write in past tense, third person. Always refer to {{charName}} by name, not "she/he/they". Do NOT quote dialogue verbatim.
3. Do NOT use emojis.
4. Wrap output in <memory></memory> tags with a markdown bulleted list (lines starting with "- ").
5. Use ONE <memory> block per encounter or event. Everything in the same scene = one block. If events happen in the same evening or outing, that is ONE block — do not split by location or sub-event.
6. Start each block with a topic tag as the first bullet: "- [{{charName}}, OtherNames — short description]". ALWAYS include {{charName}} first, then other key participants. This aids later retrieval.
7. HARD LIMIT: No more than 5 bullet points per block (not counting the topic tag). If you have more, you are being too granular — keep only the most significant outcomes.
8. If nothing genuinely new or significant about {{charName}}, respond with exactly: NO_NEW_MEMORIES
9. Write about WHAT HAPPENED, not about the conversation itself. Never write "she told him about X" — instead write the actual fact: "X happened" or "she did Y."
10. IMPORTANT: Reference other participants by name. Include who was involved in events, who said what to whom, who was present. Names matter for group memory.
11. When possible, note approximate timeframes or sequencing of events mentioned in conversation.

WHAT TO EXTRACT — ask for each item: "Would {{charName}} remember this weeks or months later?"
- Backstory reveals, personal history, goals, fears (only if NOT already in the character card)
- Relationship changes with specific participants (new connections, conflicts, alliances, shifts in feeling)
- Significant events and their outcomes involving {{charName}} (not step-by-step)
- Skills, possessions, or status changes
- Emotional turning points
- Group dynamics: who allied with whom, who disagreed, power shifts
- Always name specific people involved — use their name, not "a participant" or "someone"

DO NOT EXTRACT:
- Anything already described in the CHARACTER CARD above — traits, profession, appearance, personality, habits, preferences, or abilities that are baseline knowledge. This includes rephrasing card traits as discoveries (e.g. if the card says "competitive", do not write "she felt proud when she won again")
- Routine behaviors that simply confirm what the card already says (e.g. if the card says "smoker", don't extract "she smoked a cigarette"; if the card says "workaholic", don't extract "she stayed late at the office again")
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
- [Alex, Flux, Sarah — game night at the apartment]
- Sarah arrived at Alex's apartment carrying a board game and a bottle of wine.
- Flux jumped onto Sarah's lap and purred when she scratched behind his ears.
- Alex opened the wine and poured three glasses while Sarah set up the game.
- Sarah won the first round and did a victory dance that startled Flux off the couch.
- Flux knocked over Sarah's wine glass while chasing his toy mouse across the table.
- Alex cleaned up the spill while Sarah held Flux and called him a "little menace."
- They ordered pizza and played two more rounds before Sarah left around midnight.
- Sarah said she'd come back next week for a rematch.
</bad_example>
This is a play-by-play scene summary. It narrates every step instead of capturing what matters. It also splits naturally connected events into too many bullets.

POSITIVE EXAMPLE — the same scene extracted well:
<good_example>
- [Flux, Alex, Sarah — first game night and Sarah bonding with Flux]
- Sarah visited Alex's apartment for game night, where Flux immediately bonded with her — sitting in her lap and purring, though he later knocked over her wine chasing a toy.
- Sarah won the game and plans to return weekly for rematches, calling Flux a "little menace" as a term of endearment.
</good_example>
A topic tag plus two bullets capture the full encounter: who was involved, the key relationship development (Sarah bonding with Flux), and the lasting outcome (weekly visits planned). No step-by-step process, no scene-setting.

NOTE: When significant events occur, name the specific outcome clearly — do not sanitize into vague language. "She confronted him and left" is a memory. "Something happened between them" is not. But this does NOT mean narrate each step leading up to it — summarize the outcome, not the process.

Each memory block should answer: "What from this encounter would {{charName}} remember — things involving them or affecting them that they'd tell someone about months later, or that would surface unbidden in their own mind?"

Output ONLY <memory> blocks (or NO_NEW_MEMORIES). No headers, no commentary, no extra text.`;

const defaultConversionPrompt = `You are reformatting character memories into a standardized format for {{charName}}. The input may be unstructured text, partially formatted memory blocks, or already-formatted blocks that need updating.

Character name: {{charName}}

RULES:
1. Every memory block must be wrapped in <memory chat="Topic Name" date="YYYY-MM-DD HH:MM"></memory> tags.
2. The chat attribute should be a short, specific encounter label (e.g., "First day at the apartment", "Game night with Sarah"). Use existing chat attributes if they already contain a descriptive name.
3. The first bullet in each block must be a topic tag: "- [{{charName}}, OtherNames — short description]". ALWAYS include {{charName}} first, then other key participants.
4. No more than 5 bullets per block (not counting the topic tag). Combine related facts into single bullets rather than deleting information.
5. Always use specific names — never "a friend", "a client", "someone", or "a stranger".
6. Write in past tense, third person.
7. Do NOT add, infer, or invent any facts not present in the original.
8. Do NOT merge events from different times or encounters into one block — keep them separate.
9. If the input is unstructured text, group related facts by encounter or topic into separate blocks.
10. If the input already has well-formatted blocks with topic tags and 5 or fewer bullets, output them unchanged.
11. Preserve dates from existing blocks. For unstructured text without dates, use "{{today}}" as the date.

INPUT:
{{sourceText}}

Output ONLY <memory> blocks. No headers, no commentary, no extra text.`;

const EXTRACTION_SOURCE = {
    MAIN_LLM: 'main_llm',
    WEBLLM: 'webllm',
    PROVIDER: 'provider',
    PROFILE: 'profile',
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
    local: {
        name: 'Local Server (Ollama / KoboldCpp / llama.cpp / LM Studio)',
        baseUrl: 'http://localhost:5001/v1',
        authStyle: 'none',
        modelsEndpoint: 'standard',
        requiresApiKey: false,
        extraHeaders: {},
        defaultModel: '',
        allowCustomUrl: true,
        helpUrl: '',
        useProxy: true,
    },
    nvidia: {
        name: 'NVIDIA',
        baseUrl: 'https://integrate.api.nvidia.com/v1',
        authStyle: 'bearer',
        modelsEndpoint: 'standard',
        requiresApiKey: true,
        extraHeaders: {},
        defaultModel: 'meta/llama-3.3-70b-instruct',
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
    extractionLag: 0,
    maxMessagesPerExtraction: 20,
    responseLength: 1000,
    mergeChunks: false,
    extractionPrompt: defaultExtractionPrompt,
    consolidationStrategy: 'balanced',
    consolidationPrompts: {},
    consolidationChunkChars: 24000,
    consolidationOutputRatio: 0.5,
    source: EXTRACTION_SOURCE.PROVIDER,
    fileName: DEFAULT_FILE_NAME,
    perChat: false,
    selectedProvider: 'openrouter',
    selectedProfileId: '',
    profileSystemPrompt: '',
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
    injectionDrawerWidth: 0, // 0 = use CSS default; set by drag-to-resize
    logDrawerWidth: 0,       // 0 = use CSS default; set by drag-to-resize
    pushChatContent: true,   // when true, drawer pushes ST's chat panel left instead of overlaying
    displayMode: 'auto',
    protectRecentMessages: false,
    protectRecentMessagesCount: 4,
    hideExtractedMessages: false,
};

const PROMPT_CONFIG = {
    extraction: {
        title: 'Extraction Prompt (1:1)',
        navLabel: 'Extract (1:1)',
        settingsKey: 'extractionPrompt',
        defaultValue: defaultExtractionPrompt,
        version: '2.0.1',
    },
    groupExtraction: {
        title: 'Extraction Prompt (Group)',
        navLabel: 'Extract (Group)',
        settingsKey: 'groupExtractionPrompt',
        defaultValue: defaultGroupExtractionPrompt,
        version: '2.0.1',
    },
    consolidation: {
        title: 'Consolidation Prompt',
        navLabel: 'Consolidation',
        settingsKey: 'consolidationPrompt',
        defaultValue: null, // depends on strategy — resolved at runtime
        version: '2.0.1',
    },
    conversion: {
        title: 'Conversion Prompt',
        navLabel: 'Convert',
        settingsKey: 'conversionPrompt',
        defaultValue: defaultConversionPrompt,
        version: '2.0.1',
    },
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
        t`Reformat existing memories to match the new format?\n\nThis will rewrite ${totalBullets} memories in ${totalBlocks} blocks.`,
        POPUP_TYPE.CONFIRM,
    );

    if (result) {
        for (const target of targets) {
            await reformatExistingMemories(target.avatar, target.fileName);
        }
        toastr.success(t`Reformatted ${totalBullets} memories.`, 'CharMemory');
        updateStatusDisplay();
    }
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
 * Convert file content to <memory> tag format using LLM.
 * @param {string} content Raw file content.
 * @param {string} charName Character name for prompt.
 * @returns {Promise<{blocks: {chat: string, date: string, bullets: string[]}[], warnings: string[]}>}
 */
async function convertWithLLM(content, charName) {
    const warnings = [];
    const prompt = (extension_settings[MODULE_NAME].conversionPrompt || defaultConversionPrompt)
        .replace(/\{\{charName\}\}/g, charName)
        .replace(/\{\{sourceText\}\}/g, content)
        .replace(/\{\{today\}\}/g, new Date().toISOString().slice(0, 10));

    let response;
    try {
        response = await callLLM(prompt, Math.max(extension_settings[MODULE_NAME].responseLength * 2 || 4000, 4000), 'You are a text restructuring assistant. Preserve all information faithfully.');
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
            return {
                blocks: [{ chat: 'imported', date: getTimestamp(), bullets: lines.map(l => l.slice(2).trim()) }],
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
                <span data-i18n="Use LLM">Use LLM</span>
            </label>
            <input type="button" id="charMemory_rerunConversion" class="menu_button" value="Re-run" data-i18n="[value]Re-run;[title]Re-parse the source file with current settings" title="Re-parse the source file with current settings" />
            <input type="button" id="charMemory_undoConvRerun" class="menu_button" value="Undo" data-i18n="[value]Undo;[title]Revert to previous version" title="Revert to previous version" disabled />
            <span id="charMemory_convRerunSpinner" style="display:none;" data-i18n="Working...">Working...</span>
        </div>
        ${buildFindReplaceBar('charMemory_convFR')}
        <div class="charMemory_consolidationPanes">
            <div class="charMemory_consolidationPane">
                <h4 data-i18n="Original File">Original File</h4>
                <div class="charMemory_consolidationContent"><pre class="charMemory_convertSourcePre">${escapeHtml(sourceContent)}</pre></div>
            </div>
            <div class="charMemory_consolidationPane">
                <h4 data-i18n="Converted Memories">Converted Memories</h4>
                <div class="charMemory_consolidationContent" id="charMemory_convEditorPane">${renderConsolidatedCards(convertedBlocks, editingSet)}</div>
                <button class="charMemory_editorAddBlock menu_button ${hasEditing ? '' : 'charMemory_editorAddBlock--hidden'}" id="charMemory_convAddBlock"><i class="fa-solid fa-plus fa-xs"></i> <span data-i18n="Add Block">Add Block</span></button>
            </div>
        </div>
        <div class="charMemory_convOutputSection">
            <div class="charMemory_convertWarning">
                <i class="fa-solid fa-triangle-exclamation fa-sm"></i>
                <span data-i18n="The original file will not be deleted. Hide or remove it from the Data Bank to avoid duplicate memories.">The original file will <b>not</b> be deleted. Hide or remove it from the Data Bank to avoid duplicate memories.</span>
            </div>
            <div class="charMemory_convDestRow">
                <small><b data-i18n="Output to:">Output to:</b></small>
                <label class="radio_label">
                    <input type="radio" name="charMemory_convDest" value="auto" checked />
                    <span>CharMemory file (${escapeHtml(memoryFileName)})</span>
                </label>
                <label class="radio_label">
                    <input type="radio" name="charMemory_convDest" value="custom" />
                    <span data-i18n="Custom:">Custom:</span>
                    <input type="text" id="charMemory_convCustomName" class="text_pole" placeholder="my-memories.md" style="flex:1;max-width:200px;" disabled />
                </label>
            </div>
        </div>
    </div>`;
}

/**
 * Unified Convert tool dispatcher — routes to file conversion or memory reformat based on source picker.
 */
async function previewConvert() {
    const source = $('input[name="charMemory_formatSource"]:checked').val();
    if (source === 'databank') {
        await previewConversion();
    } else {
        await reformatMemories();
    }
}

/**
 * Parse the selected source file and show an interactive conversion preview dialog.
 * The dialog uses the same editable-card pattern as the consolidation feature.
 */
async function previewConversion(sourceFileUrl) {
    if (inApiCall) {
        toastr.warning(t`An API call is already in progress.`, 'CharMemory');
        return;
    }

    const fileUrl = sourceFileUrl || $('#charMemory_convertSource').val();
    if (!fileUrl) {
        toastr.warning(t`Select a source file first.`, 'CharMemory');
        return;
    }

    // Claim the lock before the first await (getFileAttachment) rather than only
    // around the conversion call below — otherwise a second previewConversion (or
    // any other inApiCall-guarded action) could start while this one is still
    // reading the source file, since inApiCall was still false at that point.
    // Released on every exit path below; re-acquired (redundantly but harmlessly)
    // around the conversion call further down, which still releases it at the same
    // point as before once the LLM/heuristic step finishes — the interactive preview
    // dialog after that is intentionally NOT covered by this lock.
    inApiCall = true;
    let sourceContent;
    try {
        sourceContent = await getFileAttachment(fileUrl);
    } catch (err) {
        console.error(LOG_PREFIX, 'Failed to read source file:', err);
        toastr.error(t`Could not read the selected file.`, 'CharMemory');
        inApiCall = false;
        return;
    }
    if (!sourceContent) {
        toastr.error(t`Could not read the selected file.`, 'CharMemory');
        inApiCall = false;
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
            toastr.info(t`Sending to LLM for restructuring...`, 'CharMemory', { timeOut: 3000 });
            result = await convertWithLLM(sourceContent, charName);
        } else {
            result = convertHeuristic(sourceContent, format);
        }
    } catch (err) {
        console.error(LOG_PREFIX, 'Conversion failed:', err);
        toastr.error(t`Conversion failed: ${err.message || 'Unknown error'}`, 'CharMemory');
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
        toastr.warning(t`No memories could be extracted from the file.`, 'CharMemory');
        return;
    }

    // === Editor state (lives in closure, survives popup DOM lifecycle) ===
    const editor = createMemoryEditor({ blocks: result.blocks });
    const rerunBackups = []; // separate stack for re-run undo (editor.replaceAll clears internal undo)
    let destType = 'auto';
    let destCustomName = '';
    let dialogClosed = false; // cancellation flag for in-flight re-run callbacks
    let convFindPattern = null;

    const refreshEditor = (highlightPattern) => {
        if (highlightPattern !== undefined) convFindPattern = highlightPattern;
        const blocks = editor.getBlocks();
        const editing = editor.getEditingSet();
        $('#charMemory_convEditorPane').html(renderConsolidatedCards(blocks, editing, convFindPattern));
        $('#charMemory_convAfterCount').text(countMemories(blocks));
        $('#charMemory_convBlockCount').text(blocks.length);
        $('#charMemory_convAddBlock').toggleClass('charMemory_editorAddBlock--hidden', editing.size === 0);
    };

    // Build and show dialog
    const formatLabel = formatLabels[format] || format;
    const method = useLLM && format !== 'memory_tags' ? 'LLM' : 'Heuristic';
    const initBlocks = editor.getBlocks();
    const initEditing = editor.getEditingSet();
    const dialogHtml = buildConversionDialog(sourceContent, formatLabel, method, initBlocks, initEditing, useLLM && format !== 'memory_tags');
    const popup = callGenericPopup(dialogHtml, POPUP_TYPE.CONFIRM, '', { wide: true, allowVerticalScrolling: true, okButton: t`Save`, cancelButton: t`Cancel` });

    // === Find/Replace bar ===
    const cleanupConvFR = wireFindReplaceEvents(editor, refreshEditor, 'charMemory_convFR', '.charMemoryConvFR');

    // === Editor event delegation (same card classes as consolidation, different namespaces) ===

    $(document).off('click.charMemoryConvToggle').on('click.charMemoryConvToggle', '.charMemory_editorToggleEdit', function () {
        editor.toggleEdit(Number($(this).data('block')));
        refreshEditor();
    });

    $(document).off('input.charMemoryConvBullet').on('input.charMemoryConvBullet', '.charMemory_editorBulletInput', function () {
        editor.updateBullet(Number($(this).data('block')), Number($(this).data('bullet')), $(this).val());
    });

    $(document).off('input.charMemoryConvTheme').on('input.charMemoryConvTheme', '.charMemory_editorThemeInput', function () {
        editor.updateTheme(Number($(this).data('block')), $(this).val());
    });

    $(document).off('click.charMemoryConvDelBullet').on('click.charMemoryConvDelBullet', '.charMemory_editorDeleteBullet', function () {
        editor.deleteBullet(Number($(this).data('block')), Number($(this).data('bullet')));
        refreshEditor();
    });

    $(document).off('click.charMemoryConvDelBlock').on('click.charMemoryConvDelBlock', '.charMemory_editorDeleteBlock', function () {
        editor.deleteBlock(Number($(this).data('block')));
        refreshEditor();
    });

    $(document).off('click.charMemoryConvAddBullet').on('click.charMemoryConvAddBullet', '.charMemory_editorAddBullet', function () {
        const bi = Number($(this).data('block'));
        editor.addBullet(bi);
        refreshEditor();
        $(`#charMemory_convEditorPane .charMemory_editorCard[data-block="${bi}"] .charMemory_editorBulletInput:last`).focus();
    });

    $(document).off('click.charMemoryConvAddBlock').on('click.charMemoryConvAddBlock', '#charMemory_convAddBlock', function () {
        editor.addBlock();
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
        const backupBlocks = editor.getBlocks();
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
            toastr.error(t`Re-run failed: ${err.message || 'Unknown error'}`, 'CharMemory');
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
            rerunBackups.push(backupBlocks);
            $('#charMemory_undoConvRerun').prop('disabled', false);
            editor.replaceAll(newResult.blocks);
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
        if (rerunBackups.length === 0) return;
        editor.replaceAll(rerunBackups.pop());
        refreshEditor();
        if (rerunBackups.length === 0) $('#charMemory_undoConvRerun').prop('disabled', true);
    });

    // === Wait for dialog Accept/Cancel ===

    const confirmed = await popup;
    dialogClosed = true;

    // Clean up all event delegation
    cleanupConvFR();
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

    const cleanBlocks = editor.getBlocks()
        .map(b => ({ ...b, bullets: b.bullets.filter(bullet => bullet.trim() !== '') }))
        .filter(b => b.bullets.length > 0);

    if (cleanBlocks.length === 0) {
        toastr.warning(t`No memories to save.`, 'CharMemory');
        return;
    }

    const context = getContext();
    const avatar = characters[context.characterId]?.avatar;
    if (!avatar) {
        toastr.error(t`No character selected.`, 'CharMemory');
        return;
    }

    // destType and destCustomName are captured from closure (updated by event handlers)
    let destFileName;
    if (destType === 'custom') {
        destFileName = destCustomName.trim();
        if (!destFileName) {
            toastr.warning(t`Enter a filename for custom output.`, 'CharMemory');
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
    toastr.success(t`Converted ${count} memories to ${destFileName}. Remember to hide or remove the original file from Data Bank to avoid duplicates.`, 'CharMemory', { timeOut: 8000 });
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
let healthRecheckTimer = null; // delayed re-check after vectorization (race condition guard)
let healthPollInterval = null; // periodic background health poll

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
    if (preset.allowCustomUrl) {
        const isLocal = preset.authStyle === 'none' && !preset.requiresApiKey;
        const placeholder = isLocal ? 'http://127.0.0.1:1234/v1' : 'https://your-server.com/v1';
        $('#charMemory_providerBaseUrl')
            .attr('placeholder', placeholder)
            .val(providerSettings.customBaseUrl || preset.baseUrl || '');
        $('#charMemory_providerBaseUrlHint').text(
            isLocal
                ? 'http://IP:port/v1 — the /v1 suffix is required'
                : 'OpenAI-compatible base URL ending in /v1',
        ).show();
    } else {
        $('#charMemory_providerBaseUrl').val('');
        $('#charMemory_providerBaseUrlHint').hide();
    }

    // Connect button row: show when provider supports model fetching
    const hasModelsEndpoint = preset.modelsEndpoint === 'standard' || preset.modelsEndpoint === 'custom';
    $('#charMemory_providerConnectRow').toggle(hasModelsEndpoint);

    // Model: dropdown vs text input
    const useDropdown = hasModelsEndpoint;
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
        // Clear stale model display from previous provider, show saved model for this provider
        const savedModel = providerSettings.model || '';
        $('#charMemory_providerModel').val(savedModel);
        $('#charMemory_modelSearch').val(savedModel ? savedModel : '').attr('placeholder', 'Click Connect to fetch models');
        currentModelList = [];
        renderModelDropdown('');
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
            `<div class="charMemory_modelOption${selectedClass}" data-model-id="${escapeAttr(model.id)}">${escapeHtml(model.name)}</div>`
        );
        hasResults = true;
    }

    if (!hasResults) {
        $dropdown.append('<div class="charMemory_modelEmpty" data-i18n="No matching models">No matching models</div>');
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

    // Migrate Ollama → combined local server preset
    if (extension_settings[MODULE_NAME].selectedProvider === 'ollama') {
        extension_settings[MODULE_NAME].selectedProvider = 'local';
        const ollamaSettings = extension_settings[MODULE_NAME].providers?.ollama;
        if (ollamaSettings) {
            const localSettings = getProviderSettings('local');
            if (ollamaSettings.model) localSettings.model = ollamaSettings.model;
            if (ollamaSettings.systemPrompt) localSettings.systemPrompt = ollamaSettings.systemPrompt;
            // Preserve the Ollama URL since the new default port differs
            localSettings.customBaseUrl = ollamaSettings.customBaseUrl || 'http://localhost:11434/v1';
        }
        saveSettingsDebounced();
    }

    // Check prompt versions for update notifications
    checkPromptVersions();
    const pendingPromptUpdates = Object.keys(PROMPT_CONFIG).filter(k => hasPromptUpdate(k));
    if (pendingPromptUpdates.length > 0) {
        setTimeout(() => toastr.info(
            t`Some CharMemory prompts have been updated. Open <b>Settings → Prompts</b> to review.`,
            'CharMemory',
            { timeOut: 10000, escapeHtml: false },
        ), 2000);
    }

    // Bind dashboard UI elements to settings
    $('#charMemory_autoExtractPill').toggleClass('active', !!extension_settings[MODULE_NAME].enabled);

    updateStatusDisplay();
    updateHealthIndicator();

    // Periodic health re-check — catches manual vectorization, VS setting changes,
    // and any other state changes not covered by event listeners.
    startHealthPoll();
}

function startHealthPoll() {
    clearInterval(healthPollInterval);
    healthPollInterval = setInterval(() => updateHealthIndicator(), 60_000);
}

// Pause the poll when the page is hidden (background tab / screen locked),
// resume and immediately re-check when it becomes visible again.
// Registered once at module load — safe to call multiple times via loadSettings.
if (!window._charMemoryVisibilityBound) {
    window._charMemoryVisibilityBound = true;
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            clearInterval(healthPollInterval);
        } else {
            startHealthPoll();
            updateHealthIndicator();
        }
    });
}

/**
 * Resolve the effective display mode from the user setting.
 * 'auto' detects: touch + narrow viewport → phone, touch → tablet, else desktop.
 * @returns {'desktop'|'tablet'|'phone'}
 */
function getEffectiveDisplayMode() {
    const setting = extension_settings[MODULE_NAME].displayMode
        || extension_settings[MODULE_NAME].tabletMode // legacy migration
        || 'auto';
    if (setting === 'desktop' || setting === 'off') return 'desktop';
    if (setting === 'tablet' || setting === 'on') return 'tablet';
    if (setting === 'phone') return 'phone';
    // 'auto' — detect at runtime
    const hasTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    if (!hasTouch) return 'desktop';
    return window.innerWidth <= 600 ? 'phone' : 'tablet';
}

/**
 * Whether the floating tablet panel should be used (tablet or phone mode).
 * @returns {boolean}
 */
function isTabletMode() {
    const mode = getEffectiveDisplayMode();
    return mode === 'tablet' || mode === 'phone';
}

/**
 * Apply/remove the body class for phone-mode CSS overrides.
 * Called on init, setting change, and viewport resize.
 */
function applyDisplayModeClass() {
    document.body.classList.toggle('charMemory-phone-mode', getEffectiveDisplayMode() === 'phone');
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
        $('#charMemory_statFile').text(t`No character`).attr('title', t`No character selected`);
    }

    // Stats bar: memory count (total bullets across all targets, async)
    if (targets.length === 0) {
        $('#charMemory_statCount').text(t`0 memories`);
    } else {
        let totalCount = 0;
        let loaded = 0;
        for (const target of targets) {
            readMemoriesForCharacter(target.avatar, target.fileName).then(content => {
                const blocks = parseMemories(content || '');
                totalCount += countMemories(blocks);
                loaded++;
                if (loaded === targets.length) {
                    $('#charMemory_statCount').text(totalCount === 1 ? t`${totalCount} memory` : t`${totalCount} memories`);
                }
            }).catch(() => { loaded++; });
        }
    }

    // Stats bar: extraction progress
    const msgsSince = chat_metadata[MODULE_NAME]?.messagesSinceExtraction || 0;
    const interval = extension_settings[MODULE_NAME]?.interval || 10;
    $('#charMemory_statProgress').text(t`${msgsSince}/${interval} msgs`);

    // Stats bar: cooldown timer
    updateCooldownDisplay();
    startCooldownTimer();

    // Stats bar: hidden extracted messages count
    const chat = getContext().chat;
    if (chat && chat.length > 0) {
        let hiddenCount = 0;
        for (const msg of chat) {
            if (msg.extra?.charMemory_extracted && msg.is_system) hiddenCount++;
        }
        if (hiddenCount > 0) {
            $('#charMemory_statHidden').text(t`${hiddenCount} hidden`);
            $('#charMemory_statHiddenWrap').show();
        } else {
            $('#charMemory_statHiddenWrap').hide();
        }
    } else {
        $('#charMemory_statHiddenWrap').hide();
    }

    // Show resolved filename for 1:1 chats
    if (!isGroupChat()) {
        const charName = getCharacterName();
        $('#charMemory_resolvedFileName').text(charName ? getMemoryFileName() : t`—`);
    }
}

/**
 * Update the dashboard diagnostics summary with current health status.
 */
function updateDashboardDiagSummary() {
    const $summary = $('#charMemory_dashDiagSummary');
    if (!$summary.length) return;

    computeHealthScore().then(result => {
        if (result.level === 'unknown') {
            $summary.html(`<div class="charMemory_diagEmpty">${t`No character selected.`}</div>`);
            return;
        }

        const icons = { green: 'fa-check-circle', yellow: 'fa-exclamation-triangle', red: 'fa-times-circle' };
        const colors = { green: '#4a4', yellow: '#e8a33d', red: '#c44' };
        const icon = icons[result.level] || 'fa-question-circle';
        const color = colors[result.level] || '';
        const label = result.level === 'green' ? t`Healthy` : result.level === 'yellow' ? t`Warnings` : t`Issues detected`;

        let html = `<div style="display:flex;align-items:center;gap:6px;font-size:0.9em;">`;
        html += `<i class="fa-solid ${icon}" style="color:${color};"></i>`;
        html += `<span>${label}</span>`;
        html += `</div>`;

        if (result.checks) {
            const issues = result.checks.filter(c => c.status !== 'pass');
            if (issues.length > 0) {
                html += `<div style="font-size:0.8em;opacity:0.7;margin-top:2px;">`;
                html += issues.slice(0, 2).map(c => `${c.label}: ${c.detail || c.status}`).join('<br>');
                if (issues.length > 2) html += `<br>...and ${issues.length - 2} more`;
                html += `</div>`;
            }
        }

        $summary.html(html);
    }).catch(() => {
        $summary.html(`<div class="charMemory_diagEmpty">${t`Health check failed.`}</div>`);
    });
}

function updateCooldownDisplay() {
    const cooldownMs = (extension_settings[MODULE_NAME]?.minCooldownMinutes || 0) * 60000;
    if (cooldownMs <= 0 || lastExtractionTime === 0) {
        $('#charMemory_statCooldown').text(t`Ready`);
        return;
    }
    const elapsed = Date.now() - lastExtractionTime;
    if (elapsed >= cooldownMs) {
        $('#charMemory_statCooldown').text(t`Ready`);
    } else {
        const remaining = Math.ceil((cooldownMs - elapsed) / 60000);
        $('#charMemory_statCooldown').text(t`${remaining}m cooldown`);
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
 * Resolve group members and report both the successfully-resolved ones and
 * any avatars that couldn't be found in the global `characters` array (the
 * most common cause is a load-order race: CHAT_CHANGED fires before ST has
 * finished populating characters for large groups).
 *
 * Outside a group chat, returns all-empty defaults.
 *
 * @returns {{
 *   resolved: Array<{name:string, avatar:string, charIndex:number}>,
 *   unresolvedAvatars: string[],
 *   totalActive: number
 * }}
 */
function getGroupMembersDetailed() {
    const context = getContext();
    if (!context.groupId) return { resolved: [], unresolvedAvatars: [], totalActive: 0 };
    const group = context.groups?.find(g => g.id === context.groupId);
    if (!group) {
        console.warn(LOG_PREFIX, `Group not found: groupId="${context.groupId}", available groups:`, context.groups?.map(g => g.id));
        return { resolved: [], unresolvedAvatars: [], totalActive: 0 };
    }
    const activeMembers = group.members
        .filter(avatar => !group.disabled_members?.includes(avatar));
    if (activeMembers.length === 0) {
        console.warn(LOG_PREFIX, `Group "${group.name}" has no active members. members=${group.members?.length}, disabled=${group.disabled_members?.length}, mode=${group.generation_mode}`);
    }
    const resolved = [];
    const unresolvedAvatars = [];
    for (const avatar of activeMembers) {
        const charIndex = characters.findIndex(c => c.avatar === avatar);
        const char = characters[charIndex];
        if (char) {
            resolved.push({ name: char.name, avatar, charIndex });
        } else {
            unresolvedAvatars.push(avatar);
        }
    }
    if (unresolvedAvatars.length > 0) {
        console.warn(LOG_PREFIX, `${unresolvedAvatars.length} of ${activeMembers.length} group members could not be resolved: ${unresolvedAvatars.join(', ')} (characters.length=${characters.length})`);
    }
    return { resolved, unresolvedAvatars, totalActive: activeMembers.length };
}

/**
 * Back-compat entry point used by 9+ callers. Returns only the resolved members.
 * New code that needs visibility into unresolved avatars should call
 * getGroupMembersDetailed() directly.
 */
function getGroupMembers() {
    return getGroupMembersDetailed().resolved;
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

    const result = formatChatMessages(chat, startIndex, sliceEnd);

    logActivity(`Collected ${result.messageCount} messages (indices ${startIndex}-${sliceEnd - 1})`);
    return { text: result.text, startIndex, endIndex: sliceEnd - 1 };
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

    // Route through ST server proxy to avoid CORS issues with nano-gpt.com
    const proxyHeaders = getRequestHeaders();

    const [modelsResponse, subResponse] = await Promise.all([
        fetch('/api/backends/chat-completions/status', {
            method: 'POST',
            headers: proxyHeaders,
            body: JSON.stringify({
                chat_completion_source: 'custom',
                custom_url: 'https://nano-gpt.com/api',
            }),
        }),
        fetch('/api/backends/chat-completions/status', {
            method: 'POST',
            headers: proxyHeaders,
            body: JSON.stringify({
                chat_completion_source: 'custom',
                custom_url: 'https://nano-gpt.com/api/subscription/v1',
            }),
        }).catch(() => null),
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
        return providerSettings.customBaseUrl.replace(/\/+$/, '').replace(/\/chat\/completions\/?$/i, '');
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
        const proxyBody = {
            chat_completion_source: 'custom',
            custom_url: baseUrl,
            model,
            messages,
            max_tokens: maxTokens,
            temperature: 0.3,
            stream: false,
        };
        if (apiKey) {
            proxyBody.custom_include_headers = `Authorization: Bearer ${apiKey}`;
        }
        const response = await fetch('/api/backends/chat-completions/generate', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(proxyBody),
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
    if (source === EXTRACTION_SOURCE.PROFILE) {
        try {
            const CMRS = getContext().ConnectionManagerRequestService;
            const profile = CMRS?.getProfile(extension_settings[MODULE_NAME].selectedProfileId);
            return `Profile: ${profile?.name || 'unknown'}`;
        } catch { return 'Connection Profile'; }
    }
    if (source === EXTRACTION_SOURCE.PROVIDER) {
        const key = extension_settings[MODULE_NAME].selectedProvider;
        return PROVIDER_PRESETS[key]?.name || key;
    }
    return 'main LLM';
}

/**
 * Check whether the Connection Manager extension is available.
 * @returns {boolean}
 */
function isConnectionManagerAvailable() {
    const context = getContext();
    return !context.extensionSettings?.disabledExtensions?.includes('connection-manager');
}

/**
 * Send a request via SillyTavern's Connection Manager (saved connection profiles).
 * @param {string} userPrompt The user prompt to send.
 * @param {number} maxTokens Max tokens for the response.
 * @param {string} defaultSystemPrompt Fallback system prompt.
 * @returns {Promise<string>} The LLM response text.
 */
async function generateProfileResponse(userPrompt, maxTokens, defaultSystemPrompt) {
    const s = extension_settings[MODULE_NAME];
    const profileId = s.selectedProfileId;

    if (!profileId) {
        throw new Error('No connection profile selected. Configure it in Character Memory settings.');
    }
    if (!isConnectionManagerAvailable()) {
        throw new Error('Connection Manager extension is disabled. Enable it in Extensions, or switch to Dedicated API.');
    }

    const context = getContext();
    const CMRS = context.ConnectionManagerRequestService;
    if (!CMRS) {
        throw new Error('ConnectionManagerRequestService not found. Your SillyTavern version may be too old.');
    }

    const systemPrompt = s.profileSystemPrompt || defaultSystemPrompt;
    const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
    ];

    logActivity(`Calling LLM via connection profile...`, 'info');
    const t0 = performance.now();
    const result = await CMRS.sendRequest(profileId, messages, maxTokens, {
        stream: false,
        extractData: true,
        includePreset: true,
    });
    const elapsed = ((performance.now() - t0) / 1000).toFixed(1);

    const text = result?.content || '';
    logActivity(`Profile response: ${text.length} chars, ${elapsed}s`, 'success');
    return text;
}

/**
 * Unified LLM dispatch: routes to Provider API, Connection Profile, WebLLM, or Main LLM.
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
    if (source === EXTRACTION_SOURCE.PROFILE) {
        return generateProfileResponse(userPrompt, maxTokens, defaultSystemPrompt);
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
        const proxyBody = {
            chat_completion_source: 'custom',
            custom_url: baseUrl,
        };
        if (providerSettings.apiKey) {
            proxyBody.custom_include_headers = `Authorization: Bearer ${providerSettings.apiKey}`;
        }
        const response = await fetch('/api/backends/chat-completions/status', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(proxyBody),
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
    // Target the Settings Modal elements (sidebar provider panel was removed in v2.0)
    const $status = $('#cm_modal_testStatus');
    const $btn = $('#cm_modal_testModel');

    if (!preset) {
        $status.text(t`Unknown provider selected.`).css('color', '#e74c3c').show();
        return;
    }

    const providerSettings = getProviderSettings(providerKey);
    if (preset.requiresApiKey && !providerSettings.apiKey) {
        $status.text(t`Enter an API key first.`).css('color', '#e74c3c').show();
        return;
    }

    $btn.prop('disabled', true).val(t`Testing...`);
    $status.text(t`Testing model...`).css('color', '').show();

    try {
        const baseUrl = resolveBaseUrl(preset, providerSettings);
        const testModel = providerSettings.model || preset.defaultModel;
        if (!testModel) {
            $status.text(t`Select a model first, then test.`).css('color', '#e67e22').show();
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
            $status.text(t`\u2714 ${modelShort} responded correctly (${elapsed}s)`).css('color', '#2ecc71').show();
        } else {
            $status.html(t`\u26A0 ${escapeHtml(modelShort)} responded but didn't follow the test instruction (${elapsed}s). Reply: "<b>${escapeHtml(reply.slice(0, 80))}</b>". It may still work for extraction.`).css('color', '#e67e22').show();
        }
    } catch (err) {
        logActivity(`${preset.name} model test failed: ${err.message}`, 'error');
        $status.text(t`\u2718 ${err.message || 'Test failed'}`).css('color', '#e74c3c').show();
    } finally {
        $btn.prop('disabled', false).val(t`Test Model`);
    }
}

/**
 * Test connection via a saved Connection Profile.
 */
async function testProfileConnection() {
    const $status = $('#cm_modal_profileTestStatus');
    const $btn = $('#cm_modal_profileTest');
    const profileId = extension_settings[MODULE_NAME].selectedProfileId;

    if (!profileId) {
        $status.text(t`Select a connection profile first.`).css('color', '#e74c3c').show();
        return;
    }
    if (!isConnectionManagerAvailable()) {
        $status.text(t`Connection Manager extension is disabled.`).css('color', '#e74c3c').show();
        return;
    }

    $btn.prop('disabled', true).val(t`Testing...`);
    $status.text(t`Testing connection...`).css('color', '').show();

    try {
        const context = getContext();
        const CMRS = context.ConnectionManagerRequestService;
        const profile = CMRS.getProfile(profileId);
        const profileName = profile?.name || profileId;

        const t0 = performance.now();
        const result = await CMRS.sendRequest(
            profileId,
            [{ role: 'user', content: 'Respond with exactly: CHARMEMORY_TEST_OK' }],
            20,
            { stream: false, extractData: true },
        );
        const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
        const reply = (result?.content || '').trim();
        const passed = reply.includes('CHARMEMORY_TEST_OK');

        logActivity(`Profile test (${profileName}): reply="${reply}", ${elapsed}s`, passed ? 'success' : 'warn');
        if (passed) {
            $status.text(t`\u2714 ${profileName} responded correctly (${elapsed}s)`).css('color', '#2ecc71').show();
        } else {
            $status.html(t`\u26A0 ${escapeHtml(profileName)} responded but didn't follow the test instruction (${elapsed}s). Reply: "<b>${escapeHtml(reply.slice(0, 80))}</b>". It may still work for extraction.`).css('color', '#e67e22').show();
        }
    } catch (err) {
        logActivity(`Profile test failed: ${err.message}`, 'error');
        $status.text(t`\u2718 ${err.message || 'Test failed'}`).css('color', '#e74c3c').show();
    } finally {
        $btn.prop('disabled', false).val(t`Test Connection`);
    }
}

// Approximate character limit for WebLLM prompt content (leaves room for response)
const WEBLLM_MAX_PROMPT_CHARS = 6000;

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

    // Build participants string for group chats
    let participants = undefined;
    if (isGroup) {
        const context = getContext();
        const userName = context.name1 || 'User';
        const otherNames = allTargets
            .filter(t => t.name !== charName)
            .map(t => t.name);
        otherNames.unshift(`${userName} (user)`);
        participants = otherNames.join(', ');
    }

    prompt = substitutePromptTemplate(prompt, {
        charName,
        charCard,
        existingMemories: memories,
        recentMessages: messages,
        participants,
    });

    // Let ST handle {{char}}, {{user}}, etc.
    prompt = substituteParamsExtended(prompt);

    return prompt;
}

/**
 * Tag extracted messages and optionally hide them from the main LLM context.
 * Only applies to the active 1:1 chat. Group chats and batch extraction are skipped.
 * @param {Array} chatArray - The chat array to modify
 * @param {number} startIdx - First message index in the extracted chunk (inclusive)
 * @param {number} endIdx - Last message index in the extracted chunk (inclusive)
 * @param {boolean} isActiveChat - Whether this is the active chat (false for batch extraction)
 */
function hideExtractedChunk(chatArray, startIdx, endIdx, isActiveChat) {
    if (!isActiveChat || isGroupChat()) return;

    const shouldHide = extension_settings[MODULE_NAME].hideExtractedMessages;
    let taggedCount = 0;

    for (let i = startIdx; i <= endIdx; i++) {
        const msg = chatArray[i];
        if (!msg) continue;

        // Don't re-tag messages that were already extracted and manually unhidden
        if (msg.extra?.charMemory_extracted) continue;

        if (!msg.extra) msg.extra = {};
        msg.extra.charMemory_extracted = true;
        taggedCount++;

        if (shouldHide) {
            msg.is_system = true;
            // Update DOM if the message element exists
            $(`.mes[mesid="${i}"]`).attr('is_system', 'true');
        }
    }

    if (taggedCount > 0) {
        if (shouldHide) {
            logActivity(`Tagged and hid ${taggedCount} extracted message(s) (indices ${startIdx}-${endIdx})`);
        } else {
            logActivity(`Tagged ${taggedCount} extracted message(s) (indices ${startIdx}-${endIdx})`);
        }
    }
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
/**
 * Public entry point — claims the `inApiCall` reentrancy lock before any `await`
 * (including the manual-extraction confirm popup inside extractMemoriesInner) so a
 * fast double-trigger can't slip both calls past the guard and run concurrently.
 * try/finally guarantees the lock releases on every exit path from the inner
 * function, including its early returns.
 */
async function extractMemories(opts = {}) {
    const noopResult = { totalMemories: 0, chunksProcessed: 0, lastExtractedIndex: opts.lastExtractedIdx ?? -1 };

    if (inApiCall) {
        console.log(LOG_PREFIX, 'Already in API call, skipping');
        return noopResult;
    }

    inApiCall = true;
    try {
        return await extractMemoriesInner(opts);
    } finally {
        inApiCall = false;
    }
}

async function extractMemoriesInner({
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
        if (isGroupChat()) {
            const _ctx = getContext();
            const _group = _ctx.groups?.find(g => g.id === _ctx.groupId);
            const _total = _group?.members?.length ?? 0;
            const _active = (_group?.members || []).filter(a => !_group?.disabled_members?.includes(a)).length;
            if (_total > 0 && _active === 0) {
                logActivity('Extraction: all group members are disabled in SillyTavern — re-enable at least one in the group settings', 'warning');
            } else {
                logActivity('Extraction: no targets found', 'warning');
            }
        } else {
            logActivity('Extraction: no targets found', 'warning');
        }
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
    let effectiveEnd = endIndex !== null ? endIndex + 1 : chat.length;

    // Protect recent messages: for auto-extraction, skip the most recent N messages
    // so swipes/regenerations aren't constrained by just-extracted memories
    if (!force && endIndex === null && extension_settings[MODULE_NAME].protectRecentMessages) {
        const buffer = extension_settings[MODULE_NAME].protectRecentMessagesCount || 4;
        effectiveEnd = Math.max(currentLastExtracted + 1, effectiveEnd - buffer);
    }

    const totalUnprocessed = effectiveEnd - (currentLastExtracted + 1);

    if (totalUnprocessed <= 0) {
        console.log(LOG_PREFIX, 'No new messages to extract');
        logActivity('No new messages to extract — nothing unprocessed', 'warning');
        if (force) {
            toastr.info(t`No unprocessed messages. Use "Reset Extraction State" to re-read from the beginning.`, 'CharMemory', { timeOut: 5000 });
        } else {
            toastr.info(t`No new messages to extract.`, 'CharMemory');
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
            ? t`This will process ${totalUnprocessed} messages for ${targets.length} characters (${totalSteps} LLM calls). This may take a while. Continue?`
            : t`This will process ${totalUnprocessed} messages in ${totalChunks} chunks. This may take a while. Continue?`;
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

    // Batch extraction (isActiveChat === false) operates on an explicitly-passed
    // chatArray/chatId and writes to extension_settings.batchState, never the live
    // chat_metadata global, so it isn't affected by the user switching chats — always
    // valid. For interactive extraction, re-check before EVERY chat_metadata write, not
    // just once after the LLM call: readMemoriesForCharacter/writeMemoriesForCharacter
    // below are also real awaits the user can switch chats during, and until now nothing
    // re-validated context between those and the chunk/final bookkeeping writes further
    // down — meaning a chat switch mid-write could commit this extraction's
    // lastExtractedIndex, hidden-message state, and messagesSinceExtraction into whatever
    // chat is NOW active instead of the one this extraction was actually for.
    const contextStillValid = () => {
        if (!isActiveChat) return true;
        const newContext = getContext();
        if (newContext.chatId !== savedChatId) return false;
        if (!isMultiTarget && newContext.characterId !== savedCharId) return false;
        return true;
    };

    const sourceLabel = getSourceLabel();

    let totalMemories = 0;
    let chunksProcessed = 0;
    let stepsCompleted = 0;

    // Per-target accumulator: holds raw extracted text from prior chunks so chunk N+1
    // sees chunk N's output in the EXISTING MEMORIES section, preventing cross-chunk duplicates.
    const chunkExtractedByTarget = {};

    try {
        lastExtractionTime = Date.now();

        for (let chunk = 0; chunk < totalChunks; chunk++) {
            // Check abort signal
            if (abortSignal?.aborted) {
                logActivity(`Extraction aborted after ${chunksProcessed} chunk(s)`, 'warning');
                toastr.warning(t`Extraction stopped after ${chunksProcessed} of ${totalChunks} chunks.`, 'CharMemory');
                break;
            }

            // Collect messages for this chunk (shared across all targets)
            const { text: recentMessages, endIndex: chunkEndIndex } = collectRecentMessages({
                endIndex: effectiveEnd - 1,
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
                    toastr.info(t`${prefix}Extracting for ${stepInfo} via ${sourceLabel}...`, 'CharMemory', { timeOut: 3000 });
                } else {
                    const chunkInfo = totalChunks > 1 ? t` (chunk ${chunk + 1}/${totalChunks})` : '';
                    toastr.info(t`${prefix}Extracting via ${sourceLabel}${chunkInfo}...`, 'CharMemory', { timeOut: 3000 });
                }

                if (onProgress) {
                    onProgress({ chunk: chunk + 1, totalChunks, chunksProcessed, totalMemories, character: target.name, step: stepsCompleted, totalSteps });
                }

                // Read this target's existing memories + any accumulated from prior chunks
                let existingMemories = await readMemoriesForCharacter(target.avatar, target.fileName);
                const accumulated = chunkExtractedByTarget[target.avatar] || '';
                if (accumulated) {
                    existingMemories += '\n' + accumulated;
                }

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
                        logActivity(`${logLabel} LLM error: ${llmErr.message} — aborting chunk to preserve extraction pointer`, 'error');
                        toastr.error(t`Extraction failed for ${target.name}: ${llmErr.message}`, 'CharMemory');
                        chunkAborted = true;
                        break;
                    }
                    if (llmErr.message?.includes('WebLLM is not available')) {
                        toastr.error(t`WebLLM is not available in this browser.`, 'CharMemory');
                        return { totalMemories, chunksProcessed, lastExtractedIndex: currentLastExtracted };
                    }
                    throw llmErr;
                }

                const llmElapsed = ((Date.now() - llmStartTime) / 1000).toFixed(1);
                logActivity(`${logLabel} Response in ${llmElapsed}s (${(result || '').length} chars)`);
                if (verbose && result) {
                    logActivity(`${logLabel} Raw response:\n${result}`);
                }

                // Verify context hasn't changed mid-extraction (no-op for batch, see
                // contextStillValid above). In group chats we only check chatId —
                // characterId legitimately flips between members as they reply and is not
                // a signal of a context switch.
                if (!contextStillValid()) {
                    logActivity('Context changed during extraction — discarding result', 'warning');
                    return { totalMemories, chunksProcessed, lastExtractedIndex: currentLastExtracted };
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
                const timestamp = getTimestamp();

                const memoryRegex = /<memory[^>]*>([\s\S]*?)<\/memory>/gi;
                const matches = [...cleanResult.matchAll(memoryRegex)];
                let rawEntries = matches.length > 0
                    ? matches.map(m => m[1].trim()).filter(Boolean)
                    : [];

                // Handle LLMs that produce self-closing <memory></memory> with bullets after the tag
                if (rawEntries.length === 0 && matches.length > 0) {
                    const altRegex = /<memory[^>]*>\s*<\/memory>([\s\S]*?)(?=<memory|$)/gi;
                    const altEntries = [...cleanResult.matchAll(altRegex)];
                    rawEntries = altEntries.map(m => m[1].trim()).filter(Boolean);
                }

                // Final fallback: treat entire response as one block
                if (rawEntries.length === 0) {
                    rawEntries = [cleanResult.trim()].filter(Boolean);
                }

                let newBulletCount = 0;
                for (const entry of rawEntries) {
                    const bullets = entry.split('\n')
                        .map(l => l.trim())
                        .filter(l => l.startsWith('- '))
                        .map(l => l.slice(2).trim())
                        .filter(Boolean);

                    // Split blocks with multiple topic tags into separate blocks
                    const bulletGroups = splitMultiTagBullets(bullets);
                    if (bulletGroups.length > 1) {
                        console.log(LOG_PREFIX, `Split multi-tag block into ${bulletGroups.length} separate blocks`);
                    }
                    for (const group of bulletGroups) {
                        const finalBullets = group.length > 0 ? group : [entry];
                        existing.push({ chat: effectiveChatId, date: timestamp, bullets: finalBullets });
                        newBulletCount += finalBullets.length;
                    }
                }

                await writeMemoriesForCharacter(serializeMemories(existing), target.avatar, target.fileName);
                totalMemories += newBulletCount;
                logActivity(`${logLabel} Saved ${newBulletCount} new memor${newBulletCount === 1 ? 'y' : 'ies'}`, 'success');

                // Accumulate raw extracted text for subsequent chunks' dedup
                if (!chunkExtractedByTarget[target.avatar]) chunkExtractedByTarget[target.avatar] = '';
                chunkExtractedByTarget[target.avatar] += '\n' + cleanResult;
            }

            // Don't advance index if abort interrupted the target loop
            if (chunkAborted) {
                logActivity(`Chunk ${chunk + 1} aborted mid-extraction — not advancing index`, 'warning');
                break;
            }

            // Advance lastExtractedIndex after each complete chunk
            const chunkStartIdx = Math.max(0, currentLastExtracted + 1);
            currentLastExtracted = chunkEndIndex !== -1 ? chunkEndIndex : effectiveEnd - 1;

            if (isActiveChat) {
                if (!contextStillValid()) {
                    // The active chat/character changed while readMemoriesForCharacter/
                    // writeMemoriesForCharacter above were in flight. The per-target memory
                    // files are already safely saved (character-keyed, unaffected by which
                    // chat is active), but writing lastExtractedIndex/hiding messages here
                    // would corrupt whichever chat is NOW active instead of the one this
                    // extraction was actually for. Stop rather than keep processing chunks
                    // for a chat the user has already left.
                    logActivity('Chat/character changed mid-extraction — stopping without updating extraction-pointer bookkeeping for the original (now inactive) chat', 'warning');
                    break;
                }
                ensureMetadata();
                chat_metadata[MODULE_NAME].lastExtractedIndex = currentLastExtracted;
                saveMetadataDebounced();
                logActivity(`Advanced lastExtractedIndex to ${currentLastExtracted}`);
                hideExtractedChunk(chatArray || getContext().chat, chunkStartIdx, currentLastExtracted, isActiveChat);
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

        // Final status updates — skip if the chat/character changed since this extraction
        // started (see contextStillValid above); same reasoning as the per-chunk guard.
        if (isActiveChat && contextStillValid()) {
            ensureMetadata();
            chat_metadata[MODULE_NAME].messagesSinceExtraction = 0;
            saveMetadataDebounced();
            // Save chat to persist extraction tags and hidden state
            if (extension_settings[MODULE_NAME].hideExtractedMessages || totalMemories > 0) {
                getContext().saveChat();
            }
        }

        updateStatusDisplay();
        updateAllIndicators();

        if (totalMemories > 0) {
            const suffix = isMultiTarget ? t` across ${targets.length} characters` : '';
            const memoryWord = totalMemories === 1 ? t`${totalMemories} memory` : t`${totalMemories} memories`;
            toastr.success(t`${memoryWord} saved${suffix} from ${chunksProcessed} chunk(s).`, 'CharMemory');

            // Post-first-extraction verification nudge
            if (!extension_settings[MODULE_NAME].verificationSeen) {
                showVerificationStep();
            }
        } else if (chunksProcessed > 0) {
            toastr.info(t`No new memories found.`, 'CharMemory');
        }

        return { totalMemories, chunksProcessed, lastExtractedIndex: currentLastExtracted };
    } catch (err) {
        console.error(LOG_PREFIX, 'Extraction failed:', err);
        logActivity(`Extraction failed: ${err.message}`, 'error');
        toastr.error(t`Memory extraction failed. Check console for details.`, 'CharMemory');
        return { totalMemories, chunksProcessed, lastExtractedIndex: currentLastExtracted };
    }
}

/**
 * Event handler for CHARACTER_MESSAGE_RENDERED.
 * @param {number} _messageIndex - Index of the rendered message (unused directly).
 * @param {string} [type] - Generation type ('swipe', 'continue', etc.). Swipes re-render an
 *   existing message slot without adding a new message, so they must not count toward the
 *   extraction interval.
 */
function onCharacterMessageRendered(_messageIndex, type) {
    if (!extension_settings[MODULE_NAME].enabled) return;

    // Swipes replace an existing message slot — no new content added to chat history.
    if (type === 'swipe') return;

    const context = getContext();
    if (context.characterId === undefined && !context.groupId) return;

    ensureMetadata();
    chat_metadata[MODULE_NAME].messagesSinceExtraction = (chat_metadata[MODULE_NAME].messagesSinceExtraction || 0) + 1;
    saveMetadataDebounced();
    updateStatusDisplay();

    const count = chat_metadata[MODULE_NAME].messagesSinceExtraction;
    const settings = extension_settings[MODULE_NAME];
    const decision = shouldExtractNow({
        messagesSinceExtraction: count,
        interval: settings.interval,
        extractionLag: settings.extractionLag || 0,
        isGenerating,
        now: Date.now(),
        lastExtractionTime,
        cooldownMs: (settings.minCooldownMinutes || 0) * 60000,
    });

    if (decision.fire) {
        extractMemories({ force: false });
        return;
    }

    if (decision.reason === 'generation-active') {
        if (!pendingExtraction) {
            pendingExtraction = true;
            logActivity('Extraction deferred: primary LLM is generating — will run when it ends');
        }
        return;
    }

    if (decision.reason === 'cooldown') {
        const remainingMin = Math.ceil(decision.remainingMs / 60000);
        logActivity(`Extraction skipped: cooldown active (${remainingMin}m remaining)`, 'warning');
        return;
    }
    // reason === 'below-interval' — silent, this is the common case on every message
}

/**
 * Event handler for CHAT_CHANGED — reset status display.
 */
async function onChatChanged() {
    const context = getContext();
    const chatId = context.chatId || '(none)';
    const charName = getCharacterName() || '(none)';
    const msgCount = context.chat ? context.chat.length : 0;
    // Used below to re-validate before writes that follow a real await (readMemoriesForCharacter
    // is a network round trip) — the user can switch chats again while this invocation is
    // still running, and a stale-metadata-reset write after that point would target the
    // wrong chat's metadata object.
    const savedChatId = context.chatId;
    const savedGroupId = context.groupId;
    const stillSameChat = () => getContext().chatId === savedChatId && getContext().groupId === savedGroupId;

    logActivity(`Chat changed: "${charName}" chat=${chatId} (${msgCount} messages)`);

    // Clear injection drawer on chat switch
    $('#charMemory_drawerBody').html(`<div class="charMemory_diagEmpty">${t`Click the <i class="fa-solid fa-syringe"></i> icon on a message to view its injected context.`}</div>`);
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

    // Detect stale metadata: lastExtractedIndex is set but the memory file is empty.
    // This happens when old code advanced the index even on NO_NEW_MEMORIES, or when
    // the user clears memories after extraction. Auto-reset so extraction can run.
    //
    // We check for ANY blocks (not chat-specific), because consolidation replaces the
    // original chatId labels with thematic labels (e.g. "First Meeting"). Requiring a
    // chatId match would falsely reset the index every session after consolidation.
    if (lastIdx >= 0) {
        try {
            // In group chats, if member resolution is incomplete we can't trust a
            // "no memories anywhere" conclusion — the members we CAN see might
            // legitimately lack memories while the ones we CAN'T see have them.
            // Guard prevents the destructive reset that causes re-extraction from
            // message 0 (issue #17 / #18).
            const detail = isGroupChat()
                ? getGroupMembersDetailed()
                : { resolved: null, unresolvedAvatars: [], totalActive: 0 };
            const skipReset = shouldSkipStaleMetadataReset({
                isGroup: isGroupChat(),
                unresolvedCount: detail.unresolvedAvatars.length,
                totalActive: detail.totalActive,
            });
            if (skipReset) {
                logActivity(`Skipped stale-metadata reset: ${detail.unresolvedAvatars.length} of ${detail.totalActive} group members could not be loaded (likely a load-order race). Pointer preserved at ${lastIdx}.`, 'warning');
            } else {
                let hasAnyMemories = false;
                const targets = getMemoryTargets();
                for (const target of targets) {
                    const content = await readMemoriesForCharacter(target.avatar, target.fileName);
                    const blocks = parseMemories(content);
                    if (blocks.length > 0) {
                        hasAnyMemories = true;
                        break;
                    }
                }
                if (hasAnyMemories) {
                    // no reset needed
                } else if (stillSameChat()) {
                    meta.lastExtractedIndex = -1;
                    saveMetadataDebounced();
                    logActivity(`Auto-reset lastExtractedIndex: was ${lastIdx} but memory file is empty — stale metadata`, 'warning');
                } else {
                    logActivity('Skipped stale-metadata reset — chat changed while checking memory files', 'warning');
                }
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

    // Retry member resolution after 2 seconds to recover from the load-order
    // race on large groups (issue #17 / #18). If the initial resolution was
    // incomplete, re-read and log the outcome; updateHealthIndicator() will
    // clear the yellow warning if the retry succeeded.
    if (isGroupChat()) {
        const initial = getGroupMembersDetailed();
        if (initial.unresolvedAvatars.length > 0) {
            const initialGroupId = getContext().groupId;
            setTimeout(() => {
                // Bail if the user switched to a different chat (1:1 or a different group) —
                // logging retry outcome against the wrong group would misattribute.
                if (!isGroupChat() || getContext().groupId !== initialGroupId) return;
                const retry = getGroupMembersDetailed();
                if (retry.unresolvedAvatars.length < initial.unresolvedAvatars.length) {
                    const recovered = initial.unresolvedAvatars.length - retry.unresolvedAvatars.length;
                    const stillStuck = retry.unresolvedAvatars.length;
                    const suffix = stillStuck > 0 ? ` (${stillStuck} still unresolved — check health indicator)` : '';
                    logActivity(`Retry resolved ${recovered} previously-unresolved group members.${suffix}`);
                } else {
                    logActivity(`Retry did not resolve any additional group members (${retry.unresolvedAvatars.length} still unresolved).`, 'warning');
                }
                updateHealthIndicator();
            }, 2000);
        }
    }

    // Inject buttons on already-rendered messages (with a small delay to
    // ensure the DOM has finished rendering the chat)
    setTimeout(addButtonsToExistingMessages, 500);
}

// ============ Diagnostics ============

/**
 * Return the usable context window size (max context minus reserved response tokens).
 * Delegates to ST's getMaxContextSize() which handles all API backends correctly.
 */
function getMainContextMaxTokens() {
    try {
        const size = getMaxContextSize();
        if (typeof size === 'number' && size > 0) return size;
    } catch { /* ignore */ }
    return null;
}

/** Estimate token count from character count (~4 chars per token for Latin text). */
function estimateTokens(chars) {
    return Math.round(chars / 4);
}

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

        // Capture char counts for token estimation before truncation
        const dbCharCount = fullDbContent
            ? (typeof fullDbContent === 'string' ? fullDbContent.length : String(fullDbContent).length)
            : 0;
        // Use itemizedPrompts for accurate char counts (actual injected strings, not truncated entry content)
        const itemIdx = itemizedPrompts.findIndex(x => Number(x.mesId) === messageIndex);
        let wiTotalChars = 0;
        let dbCharsAccurate = dbCharCount;
        if (itemIdx !== -1) {
            const ip = itemizedPrompts[itemIdx];
            if (typeof ip.worldInfoString === 'string') wiTotalChars = ip.worldInfoString.length;
            if (typeof ip.dataBankVectorsString === 'string') dbCharsAccurate = ip.dataBankVectorsString.length;
        } else {
            // Fall back to summing entry content (may be inaccurate for multi-entry lorebooks)
            wiTotalChars = lastDiagnostics.worldInfoEntries.reduce((sum, e) => sum + (e.content?.length || 0), 0);
        }
        const epCharCounts = {};
        for (const [key, value] of Object.entries(context.extensionPrompts || {})) {
            if (value?.value) {
                epCharCounts[key] = typeof value.value === 'string'
                    ? value.value.length
                    : String(value.value).length;
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
                depth: p.depth,
            })),
            tokenData: {
                charMemoryChars: dbCharsAccurate,
                wiChars: wiTotalChars,
                epCharCounts,
                contextMaxTokens: getMainContextMaxTokens(),
            },
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

    updateHealthIndicator();

    // Vector Storage may finish vectorizing the file shortly after the message renders.
    // Schedule a follow-up health re-check to catch that (debounced to avoid hammering).
    clearTimeout(healthRecheckTimer);
    healthRecheckTimer = setTimeout(() => updateHealthIndicator(), 4000);

    // Auto-update injection drawer if open
    if ($('#charMemory_injectionDrawer').hasClass('open') && typeof messageIndex === 'number' && messageIndex >= 0) {
        showInjectionDrawer(messageIndex);
    }
}

/**
 * Discover the KoboldCPP embedding model name by querying the server.
 * KoboldCPP doesn't store its model name in Vector Storage settings — it's
 * discovered dynamically from the API response during embedding creation.
 * This mirrors what the VS extension itself does for its list operations.
 * @returns {Promise<string|null>} The model name, or null if unavailable.
 */
async function discoverKoboldCppModel() {
    try {
        const vecSettings = extension_settings.vectors;
        let serverUrl;
        if (vecSettings?.use_alt_endpoint) {
            serverUrl = vecSettings.alt_endpoint_url;
        } else {
            const tgSettings = getContext().textCompletionSettings;
            serverUrl = tgSettings?.server_urls?.koboldcpp;
        }
        if (!serverUrl) return null;

        const response = await fetch('/api/backends/kobold/embed', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ items: [], server: serverUrl }),
        });
        if (!response.ok) return null;

        const data = await response.json();
        return data.model || null;
    } catch {
        return null;
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
        let model = vecSettings[modelKey] || '';

        // KoboldCPP doesn't store its model in VS settings — discover it from the API
        if (!model && source === 'koboldcpp') {
            model = await discoverKoboldCppModel() || '';
        }

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

    // Check 0 (conditional): Connection Profile source validation
    const source = extension_settings[MODULE_NAME].source;
    if (source === EXTRACTION_SOURCE.PROFILE) {
        const cmOk = isConnectionManagerAvailable();
        const profileId = extension_settings[MODULE_NAME].selectedProfileId;
        let profileOk = false;
        if (cmOk && profileId) {
            try {
                const CMRS = getContext().ConnectionManagerRequestService;
                CMRS?.getProfile(profileId);
                profileOk = true;
            } catch { /* profile not found */ }
        }
        if (!cmOk) {
            checks.push({ id: 'profile_source', level: 'red', label: t`Connection Profile`,
                detail: t`Connection Manager extension is disabled. Enable it in Extensions, or switch to Dedicated API.` });
        } else if (!profileId) {
            checks.push({ id: 'profile_source', level: 'red', label: t`Connection Profile`,
                detail: t`No profile selected. Open Settings → Connection to choose one.` });
        } else if (!profileOk) {
            checks.push({ id: 'profile_source', level: 'red', label: t`Connection Profile`,
                detail: t`Selected profile no longer exists. Open Settings → Connection to choose a new one.` });
        } else {
            checks.push({ id: 'profile_source', level: 'green', label: t`Connection Profile`,
                detail: t`Profile configured and available.` });
        }
    }

    // Check 0b (conditional): Group chat member resolution completeness.
    // Surfaces the load-order race / genuinely-missing-card cases so they're
    // not silent (issue #17). The guard in onChatChanged prevents the destructive
    // pointer reset; this check tells the user why some group members might be
    // missing from extraction/consolidation.
    if (isGroupChat()) {
        const detail = getGroupMembersDetailed();
        if (detail.unresolvedAvatars.length > 0) {
            const listed = detail.unresolvedAvatars.slice(0, 5).join(', ');
            const more = detail.unresolvedAvatars.length > 5
                ? t` (+ ${detail.unresolvedAvatars.length - 5} more)`
                : '';
            checks.push({
                id: 'group_unresolved',
                level: 'yellow',
                label: t`Group members: ${detail.unresolvedAvatars.length} of ${detail.totalActive} could not be loaded`,
                detail: t`These avatars couldn't be found in SillyTavern's character list: ${listed}${more}. This often resolves itself within seconds (the extension auto-retries 2s after chat change); check again shortly. If it persists, the character cards may have been renamed or deleted — extraction and consolidation will skip these members.`,
            });
        }
    }

    // Check 1: Vector Storage enabled for files
    // Also verify VS extension is actually loaded — extension_settings.vectors persists
    // even when the VS extension is disabled, so we need both checks.
    const vsExtLoaded = !!document.querySelector('#vectors_enabled_files');
    const filesEnabled = vsExtLoaded && !!vecSettings?.enabled_files;
    checks.push({
        id: 'vec_files_enabled',
        level: filesEnabled ? 'green' : 'red',
        label: t`Vector Storage for files`,
        detail: filesEnabled
            ? t`Enabled — Data Bank files will be vectorized`
            : t`Disabled — memories will not be vectorized or injected. Enable "Files" in Vector Storage settings.`,
    });

    if (!filesEnabled) return { level: 'red', checks };

    // Check 2: Memory file exists
    const attachment = findMemoryAttachmentForCharacter(target.avatar, target.fileName);
    checks.push({
        id: 'memory_file_exists',
        level: attachment ? 'green' : 'yellow',
        label: t`Memory file in Data Bank`,
        detail: attachment
            ? t`Found: ${target.fileName}`
            : t`Not found: ${target.fileName}. Extract memories first to create it.`,
    });

    if (!attachment) {
        const level = checks.some(c => c.level === 'red') ? 'red'
            : checks.some(c => c.level === 'yellow') ? 'yellow' : 'green';
        return { level, checks };
    }

    // Check 3: File vectorized
    const vecStatus = await checkVectorizationStatus(attachment.url);
    if (vecStatus === null) {
        checks.push({ id: 'file_vectorized', level: 'red', label: t`File vectorization`,
            detail: t`Could not check vectorization status. Vector Storage may not be enabled for files.` });
    } else if (vecStatus === false) {
        checks.push({ id: 'file_vectorized', level: 'yellow', label: t`File vectorization`,
            detail: t`File not yet indexed by Vector Storage. This usually resolves automatically when the next message is sent.` });
    } else {
        const via = vecStatus.model ? `${vecStatus.source}/${vecStatus.model}` : vecStatus.source;
        const chunkLabel = vecStatus.chunks === 1 ? t`${vecStatus.chunks} chunk` : t`${vecStatus.chunks} chunks`;
        checks.push({ id: 'file_vectorized', level: 'green', label: t`File vectorization`,
            detail: t`Vectorized: ${chunkLabel} via ${via}` });
    }

    // Check 4: Chunk overlap
    const overlapPct = vecSettings?.overlap_percent_db ?? 0;
    const chunkSizeDb = vecSettings?.chunk_size_db ?? 2500;
    if (overlapPct === 0) {
        const recommended = Math.round(chunkSizeDb * 0.15);
        checks.push({ id: 'chunk_overlap', level: 'yellow', label: t`Chunk overlap`,
            detail: t`Overlap is 0%. Memory blocks that span chunk boundaries may be split. Recommended: 10-25% (~${recommended} chars at current chunk size).` });
    } else {
        const overlapChars = Math.round(chunkSizeDb * overlapPct / 100);
        checks.push({ id: 'chunk_overlap', level: 'green', label: t`Chunk overlap`,
            detail: t`${overlapPct}% (~${overlapChars} chars) — helps prevent memory blocks from being split.` });
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
                checks.push({ id: 'chunk_size', level: 'yellow', label: t`Chunk size`,
                    detail: t`Chunk size (${chunkSizeDb} chars) is smaller than the average memory block (${avgBlockSize} chars). This may split blocks mid-content. Recommended: 800-1000 chars for CharMemory.` });
            } else if (chunkSizeDb > 0 && chunkSizeDb > avgBlockSize * 4) {
                checks.push({ id: 'chunk_size', level: 'yellow', label: t`Chunk size`,
                    detail: t`Chunk size (${chunkSizeDb} chars) is much larger than the average memory block (${avgBlockSize} chars). Multiple blocks may be packed into single chunks, reducing retrieval precision. Recommended: 800-1000 chars for CharMemory.` });
            } else {
                checks.push({ id: 'chunk_size', level: 'green', label: t`Chunk size`,
                    detail: t`Chunk size (${chunkSizeDb}) is appropriate for average memory block size (${avgBlockSize} chars).` });
            }
        }
    } catch { /* file read failed, skip */ }

    // Check 6: Retrieve chunks — warn if too high for CharMemory
    const retrieveChunks = vecSettings?.chunk_count_db;
    if (retrieveChunks !== undefined) {
        if (retrieveChunks > 5) {
            checks.push({
                id: 'retrieve_chunks',
                level: 'yellow',
                label: t`Retrieve chunks is high`,
                detail: t`Retrieve chunks is set to ${retrieveChunks}. For CharMemory, 2-3 is recommended. Higher values inject more memories per message, which can flood the prompt with irrelevant content.`,
            });
        } else {
            checks.push({
                id: 'retrieve_chunks',
                level: 'green',
                label: t`Retrieve chunks: ${retrieveChunks}`,
                detail: t`Retrieve chunks is in the recommended range for CharMemory.`,
            });
        }
    }

    // Check 7: Score threshold — warn if not set or too low
    const scoreThreshold = vecSettings?.score_threshold;
    if (scoreThreshold !== undefined && scoreThreshold < 0.1) {
        checks.push({
            id: 'score_threshold',
            level: 'yellow',
            label: t`No score threshold set`,
            detail: t`Without a score threshold, low-relevance memories may be injected. Recommended: 0.2-0.3 for most embedding models.`,
        });
    } else if (scoreThreshold !== undefined) {
        checks.push({
            id: 'score_threshold',
            level: 'green',
            label: t`Score threshold: ${scoreThreshold}`,
            detail: t`Score threshold is set — low-relevance results will be filtered out.`,
        });
    }

    // Checks 8-9: Only run after a generation has been captured
    const dbPrompt = lastDiagnostics.extensionPrompts?.['4_vectors_data_bank'];
    if (dbPrompt && dbPrompt.content) {
        const injectedBullets = dbPrompt.content.split('\n')
            .map(line => line.trim())
            .filter(line => line.startsWith('- '))
            .map(line => line.slice(2).trim())
            .filter(Boolean);

        // Check 8: Memories actually injected
        if (injectedBullets.length === 0) {
            checks.push({ id: 'memories_injected', level: 'yellow', label: t`Memories in injection`,
                detail: t`Vector data was injected but no memory bullets found. The content may be from other Data Bank files.` });
        } else {
            const injMemLabel = injectedBullets.length === 1 ? t`${injectedBullets.length} memory` : t`${injectedBullets.length} memories`;
            checks.push({ id: 'memories_injected', level: 'green', label: t`Memories in injection`,
                detail: t`${injMemLabel} found in last injection.` });

            // Check 9: Duplicate detection
            const uniqueBullets = new Set(injectedBullets);
            const dupeCount = injectedBullets.length - uniqueBullets.size;
            if (dupeCount > 0) {
                const dupeLabel = dupeCount === 1 ? t`${dupeCount} duplicate` : t`${dupeCount} duplicates`;
                checks.push({ id: 'duplicate_detection', level: 'yellow', label: t`Duplicate memories`,
                    detail: t`${dupeLabel} found (${injectedBullets.length} total, ${uniqueBullets.size} unique). This typically means chunk boundaries are splitting memory blocks. Increase chunk overlap or chunk size.` });
            } else {
                checks.push({ id: 'duplicate_detection', level: 'green', label: t`Duplicate memories`,
                    detail: t`No duplicates — all ${injectedBullets.length} injected memories are unique.` });
            }
        }
    } else if (lastDiagnostics.timestamp) {
        // No data bank content in the last generation. Earlier checks already flag VS-disabled
        // and file-not-vectorized separately, so the most common cause here is that no memories
        // were relevant enough to pass the score threshold — which is working as intended.
        checks.push({ id: 'memories_injected', level: 'yellow', label: t`Memories in injection`,
            detail: t`No memories were injected in the last generation. This is normal if the conversation topic doesn't match any stored memories. If this persists, check that Vector Storage is enabled and the file is vectorized.` });
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

    const labels = { green: t`Healthy`, yellow: t`Warnings`, red: t`Issues`, unknown: '\u2014' };
    $label.text(labels[result.level] || '\u2014');

    const statusTooltip = result.level === 'unknown'
        ? t`No character selected`
        : result.checks
            .filter(c => c.level !== 'green')
            .map(c => `[${c.level.toUpperCase()}] ${c.label}`)
            .join('\n') || t`All checks passed`;
    $('#charMemory_statHealth').attr('title', statusTooltip);

    // Drawer header dot — reflects injection state only (gray until generation)
    const $drawerDot = $('#charMemory_drawerHealthDot');
    const hasDiagnostics = !!lastDiagnostics.timestamp;
    if (!hasDiagnostics) {
        $drawerDot.removeClass(classes).addClass('health-unknown')
            .attr('title', t`No generation captured yet.\nGenerate a message to check injection health.`);
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
    const titles = { green: t`All checks passed`, yellow: t`Warnings detected`, red: t`Issues found`, unknown: t`No character selected` };

    let html = `<strong style="color:${colors[result.level]};">
        <i class="fa-solid ${icons[result.level]} fa-sm"></i>
        ${t`Injection Health:`} ${titles[result.level]}
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
        updateDashboardDiagSummary();
        updateNudgeBanner(result);
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

// ============ Settings Modal ============

/**
 * Build and show the Settings modal with left-nav layout.
 * All form controls are built dynamically to avoid ID conflicts with the sidebar.
 * Uses callGenericPopup for center-screen display.
 */
async function showSettingsModal() {
    const s = extension_settings[MODULE_NAME];
    const providerKey = s.selectedProvider || 'openrouter';
    const providerSettings = getProviderSettings(providerKey);
    const preset = PROVIDER_PRESETS[providerKey] || {};

    // Build provider options — sorted alphabetically, custom last
    const providerOptions = Object.entries(PROVIDER_PRESETS)
        .sort(([ka, a], [kb, b]) => {
            if (ka === 'custom') return 1;
            if (kb === 'custom') return -1;
            return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
        })
        .map(([key, p]) => `<option value="${escapeHtml(key)}" ${key === providerKey ? 'selected' : ''}>${escapeHtml(p.name)}</option>`)
        .join('');

    // Build source options
    const cmAvailable = isConnectionManagerAvailable();
    const sourceOptions = [
        { value: 'provider', label: 'Dedicated API (recommended)' },
        { value: 'profile', label: 'Connection Profile', disabled: !cmAvailable, title: cmAvailable ? '' : 'Enable the Connection Manager extension to use saved profiles' },
        { value: 'webllm', label: 'WebLLM (browser-local)' },
        { value: 'main_llm', label: 'Main LLM' },
    ].map(o => `<option value="${o.value}" ${o.value === s.source ? 'selected' : ''} ${o.disabled ? 'disabled' : ''} ${o.title ? `title="${escapeAttr(o.title)}" data-i18n="[title]${escapeAttr(o.title)}"` : ''} data-i18n="${o.label}">${o.label}</option>`).join('');

    // Build chunk boundary options
    const chunkOptions = [
        { value: 'block', label: 'Block-level (default)' },
        { value: 'bullet', label: 'Bullet-level' },
        { value: 'custom', label: 'Custom' },
    ].map(o => `<option value="${o.value}" ${o.value === (s.chunkBoundary || 'block') ? 'selected' : ''} data-i18n="${o.label}">${o.label}</option>`).join('');

    // Connection section HTML
    const connectionHtml = `
        <h4 class="charMemory_modalSectionTitle" data-i18n="LLM Connection">LLM Connection</h4>
        <div class="charMemory_modalFieldGroup">
            <label for="cm_modal_source"><small data-i18n="LLM Used for Extraction">LLM Used for Extraction</small></label>
            <select id="cm_modal_source" class="text_pole">${sourceOptions}</select>
            <small class="charMemory_helperText"><b data-i18n="Dedicated API is recommended.">Dedicated API is recommended.</b> <span data-i18n="Main LLM pollutes the extraction prompt with chat context.">Main LLM pollutes the extraction prompt with chat context.</span></small>
        </div>
        <div id="cm_modal_providerSettings" style="${s.source === 'provider' ? '' : 'display:none;'}">
            <div class="charMemory_modalFieldGroup">
                <label><small data-i18n="Provider">Provider</small></label>
                <select id="cm_modal_providerSelect" class="text_pole">${providerOptions}</select>
            </div>
            <div class="charMemory_modalFieldGroup" id="cm_modal_apiKeyRow" style="${preset.requiresApiKey ? '' : 'display:none;'}">
                <label><small><span data-i18n="API Key">API Key</span> <a id="cm_modal_helpLink" href="${escapeAttr(preset.helpUrl || '#')}" target="_blank" style="font-size:0.85em;${preset.helpUrl ? '' : 'display:none;'}" data-i18n="(get key)">(get key)</a></small></label>
                <div style="display:flex;gap:5px;align-items:center;">
                    <input type="password" id="cm_modal_apiKey" class="text_pole" placeholder="Enter API key" data-i18n="[placeholder]Enter API key" style="flex:1;" value="${escapeAttr(providerSettings.apiKey || '')}" />
                    <button type="button" id="cm_modal_apiKeyReveal" class="menu_button" title="Show/hide API key" data-i18n="[title]Show/hide API key" style="padding:3px 8px;">
                        <i class="fa-solid fa-eye fa-sm"></i>
                    </button>
                </div>
            </div>
            <div class="charMemory_modalFieldGroup" id="cm_modal_baseUrlRow" style="${preset.allowCustomUrl ? '' : 'display:none;'}">
                <label><small data-i18n="Base URL">Base URL</small></label>
                <input type="text" id="cm_modal_baseUrl" class="text_pole" placeholder="${preset.authStyle === 'none' ? 'http://127.0.0.1:1234/v1' : 'https://your-server.com/v1'}" value="${escapeAttr(providerSettings.customBaseUrl || preset.baseUrl || '')}" />
                <small id="cm_modal_baseUrlHint" class="charMemory_helperText">${preset.allowCustomUrl ? (preset.authStyle === 'none' ? 'http://IP:port/v1 — the /v1 suffix is required' : 'OpenAI-compatible base URL ending in /v1') : ''}</small>
            </div>
            <div class="charMemory_modalFieldGroup" id="cm_modal_connectRow" style="${preset.modelsEndpoint === 'standard' || preset.modelsEndpoint === 'custom' ? '' : 'display:none;'}">
                <input type="button" id="cm_modal_connect" class="menu_button" value="Connect" title="Fetch available models from the server" data-i18n="[value]Connect;[title]Fetch available models from the server" />
            </div>
            <small id="cm_modal_connectStatus" class="charMemory_helperText" style="display:none;"></small>
            <div class="charMemory_modalFieldGroup" id="cm_modal_modelDropdownRow" style="${preset.modelsEndpoint === 'standard' || preset.modelsEndpoint === 'custom' ? '' : 'display:none;'}">
                <label><small data-i18n="Model">Model</small></label>
                <div id="cm_modal_nanogptFilters" style="${providerKey === 'nanogpt' ? '' : 'display:none;'}">
                    <div class="charMemory_filterRow" style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:4px;">
                        <label class="checkbox_label"><input type="checkbox" id="cm_modal_nanogptFilterSub" ${providerSettings.nanogptFilterSubscription ? 'checked' : ''} /> <small data-i18n="Subscription">Subscription</small></label>
                        <label class="checkbox_label"><input type="checkbox" id="cm_modal_nanogptFilterOS" ${providerSettings.nanogptFilterOpenSource ? 'checked' : ''} /> <small data-i18n="Open Source">Open Source</small></label>
                        <label class="checkbox_label"><input type="checkbox" id="cm_modal_nanogptFilterRP" ${providerSettings.nanogptFilterRoleplay ? 'checked' : ''} /> <small data-i18n="Roleplay">Roleplay</small></label>
                        <label class="checkbox_label"><input type="checkbox" id="cm_modal_nanogptFilterReasoning" ${providerSettings.nanogptFilterReasoning ? 'checked' : ''} /> <small data-i18n="Reasoning">Reasoning</small></label>
                    </div>
                </div>
                <div class="charMemory_wizModelPicker">
                    <div style="display:flex;gap:5px;align-items:center;">
                        <input type="text" id="cm_modal_modelSearch" class="charMemory_wizModelSearch" style="flex:1;" placeholder="${providerSettings.model ? 'Search models...' : 'Click Connect to fetch models'}" autocomplete="off" value="${escapeAttr(providerSettings.model || '')}" />
                        <input type="hidden" id="cm_modal_providerModel" value="${escapeAttr(providerSettings.model || '')}" />
                        <input type="button" id="cm_modal_refreshModels" class="menu_button" value="&#x21bb;" title="Refresh model list" data-i18n="[title]Refresh model list" />
                    </div>
                    <div id="cm_modal_modelList" class="charMemory_wizModelList" style="${currentModelList.length > 0 ? '' : 'display:none;'}"></div>
                </div>
                <small id="cm_modal_modelInfo" class="charMemory_helperText"></small>
            </div>
            <div class="charMemory_modalFieldGroup" id="cm_modal_testRow">
                <div style="display:flex;gap:5px;align-items:center;">
                    <input type="button" id="cm_modal_testModel" class="menu_button" value="Test Model" title="Send a test prompt and verify it responds correctly" data-i18n="[value]Test Model;[title]Send a test prompt and verify it responds correctly" />
                </div>
                <small id="cm_modal_testStatus" class="charMemory_helperText" style="display:none;"></small>
            </div>
            <div class="charMemory_modalFieldGroup" id="cm_modal_modelInputRow" style="${preset.modelsEndpoint === 'standard' || preset.modelsEndpoint === 'custom' ? 'display:none;' : ''}">
                <label><small data-i18n="Model ID">Model ID</small></label>
                <input type="text" id="cm_modal_modelInput" class="text_pole" placeholder="Enter model identifier" data-i18n="[placeholder]Enter model identifier" value="${escapeAttr(providerSettings.model || '')}" />
                <small class="charMemory_helperText" data-i18n="Enter the model ID manually (e.g. claude-sonnet-4-5-20250929).">Enter the model ID manually (e.g. claude-sonnet-4-5-20250929).</small>
            </div>
            <div class="charMemory_modalFieldGroup">
                <label><small data-i18n="System prompt (optional)">System prompt (optional)</small></label>
                <textarea id="cm_modal_systemPrompt" class="text_pole" rows="3" placeholder="Override the default system prompt. Leave blank for default." data-i18n="[placeholder]Override the default system prompt. Leave blank for default.">${escapeHtml(providerSettings.systemPrompt || '')}</textarea>
                <small class="charMemory_helperText" data-i18n="Prepended to extraction/consolidation calls. Use for jailbreaks or custom instructions.">Prepended to extraction/consolidation calls. Use for jailbreaks or custom instructions.</small>
            </div>
        </div>
        <div id="cm_modal_profileSettings" style="${s.source === 'profile' ? '' : 'display:none;'}">
            <div class="charMemory_modalFieldGroup">
                <label><small data-i18n="Connection Profile">Connection Profile</small></label>
                <select id="cm_modal_profileSelect" class="text_pole">
                    <option value="" data-i18n="— Select a profile —">— Select a profile —</option>
                </select>
                <small class="charMemory_helperText" data-i18n="Uses credentials and settings from your saved SillyTavern connection profile.">Uses credentials and settings from your saved SillyTavern connection profile.</small>
            </div>
            <div class="charMemory_modalFieldGroup" id="cm_modal_profileTestRow">
                <div style="display:flex;gap:5px;align-items:center;">
                    <input type="button" id="cm_modal_profileTest" class="menu_button" value="Test Connection" title="Send a test prompt via the selected profile" data-i18n="[value]Test Connection;[title]Send a test prompt via the selected profile" />
                </div>
                <small id="cm_modal_profileTestStatus" class="charMemory_helperText" style="display:none;"></small>
            </div>
            <div class="charMemory_modalFieldGroup">
                <label><small data-i18n="System prompt (optional)">System prompt (optional)</small></label>
                <textarea id="cm_modal_profileSystemPrompt" class="text_pole" rows="3" placeholder="Override the default system prompt. Leave blank for default." data-i18n="[placeholder]Override the default system prompt. Leave blank for default.">${escapeHtml(s.profileSystemPrompt || '')}</textarea>
                <small class="charMemory_helperText" data-i18n="Prepended to extraction/consolidation calls. Use for jailbreaks or custom instructions.">Prepended to extraction/consolidation calls. Use for jailbreaks or custom instructions.</small>
            </div>
        </div>
        <hr class="charMemory_separator" />
        <a id="cm_modal_runWizard" class="charMemory_link" data-i18n="Run Setup Wizard">Run Setup Wizard</a>
    `;

    // Extraction section HTML
    const extractionHtml = `
        <h4 class="charMemory_modalSectionTitle" data-i18n="Auto-Extraction">Auto-Extraction</h4>
        <div class="charMemory_sliderRow">
            <label title="How many new messages trigger an automatic extraction." data-i18n="[title]How many new messages trigger an automatic extraction.">
                <small data-i18n="Extract after every N messages">Extract after every N messages</small>
            </label>
            <input class="neo-range-slider" type="range" id="cm_modal_interval" min="3" max="100" step="1" value="${s.interval}" />
            <div class="wide100p">
                <input class="neo-range-input" type="number" min="3" max="100" step="1"
                       data-for="cm_modal_interval" id="cm_modal_intervalCounter" value="${s.interval}" />
            </div>
        </div>
        <div class="charMemory_sliderRow">
            <label title="Extra messages to wait past the interval before extracting. Useful on single-GPU setups so extraction runs while you read, not while you wait for the next reply." data-i18n="[title]Extra messages to wait past the interval before extracting.">
                <small data-i18n="Extraction lag (messages)">Extraction lag (messages)</small>
            </label>
            <input class="neo-range-slider" type="range" id="cm_modal_extractionLag" min="0" max="20" step="1" value="${s.extractionLag || 0}" />
            <div class="wide100p">
                <input class="neo-range-input" type="number" min="0" max="20" step="1"
                       data-for="cm_modal_extractionLag" id="cm_modal_extractionLagCounter" value="${s.extractionLag || 0}" />
            </div>
        </div>
        <div class="charMemory_sliderRow">
            <label title="Minimum time between auto-extractions." data-i18n="[title]Minimum time between auto-extractions.">
                <small data-i18n="Minimum wait between extractions (min)">Minimum wait between extractions (min)</small>
            </label>
            <input class="neo-range-slider" type="range" id="cm_modal_minCooldown" min="0" max="30" step="1" value="${s.minCooldownMinutes}" />
            <div class="wide100p">
                <input class="neo-range-input" type="number" min="0" max="30" step="1"
                       data-for="cm_modal_minCooldown" id="cm_modal_minCooldownCounter" value="${s.minCooldownMinutes}" />
            </div>
        </div>
        <small class="charMemory_helperText" data-i18n="These settings only affect automatic extraction. Manual and batch extraction ignore them.">These settings only affect automatic extraction. Manual and batch extraction ignore them.</small>
        <div class="charMemory_statusRow" style="margin-top: 12px;">
            <label class="checkbox_label" for="cm_modal_protectRecent" title="Excludes the most recent messages from auto-extraction so swipes and regenerations aren't constrained by just-extracted memories.">
                <input type="checkbox" id="cm_modal_protectRecent" ${s.protectRecentMessages ? 'checked' : ''} />
                <span data-i18n="Protect recent messages">Protect recent messages</span>
            </label>
            <small class="charMemory_helperText" data-i18n="Excludes the most recent messages from auto-extraction, so swipes and regenerations aren't constrained by just-extracted memories. Skipped messages are picked up on the next cycle.">Excludes the most recent messages from auto-extraction, so swipes and regenerations aren't constrained by just-extracted memories. Skipped messages are picked up on the next cycle.</small>
        </div>
        <div class="charMemory_sliderRow" id="cm_modal_protectRecentCountRow" style="display: ${s.protectRecentMessages ? 'flex' : 'none'};">
            <label title="How many recent messages to skip during auto-extraction." data-i18n="[title]How many recent messages to skip during auto-extraction.">
                <small data-i18n="Messages to protect">Messages to protect</small>
            </label>
            <input class="neo-range-slider" type="range" id="cm_modal_protectRecentCount" min="1" max="20" step="1" value="${s.protectRecentMessagesCount}" />
            <div class="wide100p">
                <input class="neo-range-input" type="number" min="1" max="20" step="1"
                       data-for="cm_modal_protectRecentCount" id="cm_modal_protectRecentCountCounter" value="${s.protectRecentMessagesCount}" />
            </div>
        </div>

        <hr class="charMemory_separator" />
        <h4 class="charMemory_modalSectionTitle" data-i18n="Extraction Settings">Extraction Settings</h4>
        <div class="charMemory_sliderRow">
            <label title="How many messages to include in each LLM call." data-i18n="[title]How many messages to include in each LLM call.">
                <small data-i18n="Messages per LLM call">Messages per LLM call</small>
            </label>
            <input class="neo-range-slider" type="range" id="cm_modal_maxMessages" min="10" max="200" step="1" value="${s.maxMessagesPerExtraction}" />
            <div class="wide100p">
                <input class="neo-range-input" type="number" min="10" max="200" step="1"
                       data-for="cm_modal_maxMessages" id="cm_modal_maxMessagesCounter" value="${s.maxMessagesPerExtraction}" />
            </div>
        </div>
        <div class="charMemory_sliderRow">
            <label title="Maximum tokens the LLM can use for its response." data-i18n="[title]Maximum tokens the LLM can use for its response.">
                <small data-i18n="Max response length">Max response length</small>
            </label>
            <input class="neo-range-slider" type="range" id="cm_modal_responseLength" min="100" max="4000" step="50" value="${s.responseLength}" />
            <div class="wide100p">
                <input class="neo-range-input" type="number" min="100" max="4000" step="50"
                       data-for="cm_modal_responseLength" id="cm_modal_responseLengthCounter" value="${s.responseLength}" />
            </div>
        </div>
        <div class="charMemory_statusRow">
            <label class="checkbox_label" for="cm_modal_mergeChunks" title="When enabled, extraction results from the same chat are merged into a single block.">
                <input type="checkbox" id="cm_modal_mergeChunks" ${s.mergeChunks ? 'checked' : ''} />
                <span data-i18n="Merge extraction chunks">Merge extraction chunks</span>
            </label>
            <small class="charMemory_helperText" data-i18n="When enabled, multiple LLM calls from one extraction session are merged into a single memory block. Keep off for long chats — separate blocks give Vector Storage better retrieval granularity.">When enabled, multiple LLM calls from one extraction session are merged into a single memory block. Keep off for long chats — separate blocks give Vector Storage better retrieval granularity.</small>
        </div>

    `;

    // Storage section HTML
    const storageHtml = `
        <h4 class="charMemory_modalSectionTitle" data-i18n="Storage">Storage</h4>
        <div class="charMemory_statusRow">
            <label class="checkbox_label" for="cm_modal_perChat" title="Store memories in separate files per chat." data-i18n="[title]Store memories in separate files per chat.">
                <input type="checkbox" id="cm_modal_perChat" ${s.perChat ? 'checked' : ''} />
                <span data-i18n="Separate memory files per chat">Separate memory files per chat</span>
            </label>
            <small class="charMemory_helperText" data-i18n="Each conversation stores memories in its own file. The character still sees all memories during generation.">Each conversation stores memories in its own file. The character still sees all memories during generation.</small>
        </div>
        <div id="cm_modal_section1v1" style="${isGroupChat() ? 'display:none;' : ''}">
            <div class="charMemory_statusRow">
                <label for="cm_modal_fileName">
                    <small data-i18n="File name override">File name override</small>
                </label>
                <input type="text" id="cm_modal_fileName" class="text_pole" placeholder="(auto-generated from character name)" value="${escapeAttr(s.fileName || '')}" />
                <small class="charMemory_helperText">Current file: <span id="cm_modal_resolvedFileName">${escapeHtml(getCharacterName() ? getMemoryFileName() : '—')}</span></small>
            </div>
        </div>
        <div id="cm_modal_sectionGroup" style="${isGroupChat() ? '' : 'display:none;'}">
            <div id="cm_modal_groupMembersSection">
                <label><small data-i18n="Member memory files">Member memory files</small></label>
                <div id="cm_modal_groupMembersList" class="charMemory_groupMembersList">
                    <small class="charMemory_helperText" data-i18n="Open a group chat to see members.">Open a group chat to see members.</small>
                </div>
                <small class="charMemory_helperText" data-i18n="Each character's memories are stored in their own Data Bank. Leave blank for auto-naming.">Each character's memories are stored in their own Data Bank. Leave blank for auto-naming.</small>
            </div>
        </div>
    `;

    // Prompts overview section HTML
    const promptsHtml = `
        <h4 class="charMemory_modalSectionTitle" data-i18n="Prompts">Prompts</h4>
        <small class="charMemory_helperText" style="margin-bottom:12px;display:block;" data-i18n="CharMemory uses four separate prompts. Click View / Edit to customize any of them.">CharMemory uses four separate prompts. Click View / Edit to customize any of them.</small>
        <div class="charMemory_modalPromptEntry">
            <div class="charMemory_modalPromptRow">
                <span class="charMemory_modalPromptLabel" data-i18n="Extraction — 1:1 chats">Extraction — 1:1 chats</span>
                <input type="button" class="menu_button charMemory_modalPromptBtn" id="cm_modal_promptsViewExtraction" value="View / Edit" data-i18n="[value]View / Edit" />
            </div>
            <small class="charMemory_helperText" data-i18n="Used every time CharMemory reads messages from a 1:1 chat. Sent to the LLM along with recent messages, existing memories, and the character card. Controls what gets extracted and the memory bullet format.">Used every time CharMemory reads messages from a 1:1 chat. Sent to the LLM along with recent messages, existing memories, and the character card. Controls what gets extracted and the memory bullet format.</small>
        </div>
        <div class="charMemory_modalPromptEntry">
            <div class="charMemory_modalPromptRow">
                <span class="charMemory_modalPromptLabel" data-i18n="Extraction — group chats">Extraction — group chats</span>
                <input type="button" class="menu_button charMemory_modalPromptBtn" id="cm_modal_promptsViewGroup" value="View / Edit" data-i18n="[value]View / Edit" />
            </div>
            <small class="charMemory_helperText" data-i18n="Same as above, but used in group chats where multiple characters are present. Includes context about all active characters.">Same as above, but used in group chats where multiple characters are present. Includes context about all active characters.</small>
        </div>
        <div class="charMemory_modalPromptEntry">
            <div class="charMemory_modalPromptRow">
                <span class="charMemory_modalPromptLabel" data-i18n="Consolidation">Consolidation</span>
                <input type="button" class="menu_button charMemory_modalPromptBtn" id="cm_modal_promptsViewConsolidation" value="View / Edit" data-i18n="[value]View / Edit" />
            </div>
            <small class="charMemory_helperText" data-i18n="Used by the Consolidate tool (Data Bank Tools). Instructs the LLM to merge duplicate or near-duplicate memories into fewer entries. Has two presets (Balanced / Aggressive) in the Consolidate tool.">Used by the Consolidate tool (Data Bank Tools). Instructs the LLM to merge duplicate or near-duplicate memories into fewer entries. Has two presets (Balanced / Aggressive) in the Consolidate tool.</small>
        </div>
        <div class="charMemory_modalPromptEntry">
            <div class="charMemory_modalPromptRow">
                <span class="charMemory_modalPromptLabel" data-i18n="Conversion">Conversion</span>
                <input type="button" class="menu_button charMemory_modalPromptBtn" id="cm_modal_promptsViewConversion" value="View / Edit" data-i18n="[value]View / Edit" />
            </div>
            <small class="charMemory_helperText" data-i18n="Used by the Reformat tool (Data Bank Tools). Converts memories in non-standard formats (e.g., plain prose) into CharMemory's structured bullet-point format with topic tags.">Used by the Reformat tool (Data Bank Tools). Converts memories in non-standard formats (e.g., plain prose) into CharMemory's structured bullet-point format with topic tags.</small>
        </div>
    `;

    // Advanced section HTML
    const displayModeVal = s.displayMode || s.tabletMode || 'auto';
    // Normalize legacy values for the dropdown
    const normalizedMode = { on: 'tablet', off: 'desktop' }[displayModeVal] || displayModeVal;
    const displayModeOptions = [
        { val: 'auto', label: 'Auto (detect)' },
        { val: 'desktop', label: 'Desktop (sidebar)' },
        { val: 'tablet', label: 'Tablet (floating panel)' },
        { val: 'phone', label: 'Phone (panel + wide drawers)' },
    ].map(o => `<option value="${o.val}" ${normalizedMode === o.val ? 'selected' : ''} data-i18n="${o.label}">${o.label}</option>`).join('');

    const advancedHtml = `
        <h4 class="charMemory_modalSectionTitle" data-i18n="Display">Display</h4>
        <div class="charMemory_statusRow">
            <label for="cm_modal_displayMode">
                <small data-i18n="Display Mode">Display Mode</small>
            </label>
            <select id="cm_modal_displayMode" class="text_pole">${displayModeOptions}</select>
            <small class="charMemory_helperText" data-i18n="Controls dashboard layout. &quot;Auto&quot; detects your device. Desktop uses the sidebar; Tablet uses a floating panel; Phone adds wider drawers on top.">Controls dashboard layout. "Auto" detects your device. Desktop uses the sidebar; Tablet uses a floating panel; Phone adds wider drawers on top.</small>
        </div>
        <div class="charMemory_statusRow" style="margin-top:8px;">
            <label class="checkbox_label" for="cm_modal_pushChatContent">
                <input type="checkbox" id="cm_modal_pushChatContent" ${s.pushChatContent !== false ? 'checked' : ''} />
                <span data-i18n="Split chat when drawer is open">Split chat when drawer is open</span>
            </label>
            <small class="charMemory_helperText" data-i18n="When on, the Injected Context and Activity Log drawers push the chat panel left instead of overlaying it. Drag the drawer's left edge to resize.">When on, the Injected Context and Activity Log drawers push the chat panel left instead of overlaying it. Drag the drawer's left edge to resize.</small>
        </div>
        <hr class="charMemory_separator" />
        <h4 class="charMemory_modalSectionTitle" data-i18n="Memory File Format">Memory File Format</h4>
        <div class="charMemory_statusRow">
            <label for="cm_modal_chunkBoundary">
                <small data-i18n="Chunk boundary">Chunk boundary</small>
            </label>
            <select id="cm_modal_chunkBoundary" class="text_pole">${chunkOptions}</select>
            <small class="charMemory_helperText" data-i18n="Controls how memories are separated in the file. Vector Storage splits on the separator to create retrievable chunks.">Controls how memories are separated in the file. Vector Storage splits on the separator to create retrievable chunks.</small>
        </div>
        <div class="charMemory_statusRow" id="cm_modal_customSeparatorRow" style="${(s.chunkBoundary || 'block') === 'custom' ? '' : 'display:none;'}">
            <label for="cm_modal_customSeparator">
                <small data-i18n="Custom separator">Custom separator</small>
            </label>
            <input type="text" id="cm_modal_customSeparator" class="text_pole" placeholder="\\n\\n" value="${escapeAttr(s.customSeparator || '\\n\\n')}" />
            <small class="charMemory_helperText" data-i18n="Characters inserted between chunks. Use \\n for newlines.">Characters inserted between chunks. Use \\n for newlines.</small>
        </div>
        <div id="cm_modal_chunkMetadataRow" style="${(s.chunkBoundary || 'block') === 'bullet' || (s.chunkBoundary || 'block') === 'custom' ? '' : 'display:none;'}">
            <label class="checkbox_label" for="cm_modal_chunkMetadata">
                <input type="checkbox" id="cm_modal_chunkMetadata" ${s.chunkMetadata ? 'checked' : ''} />
                <span data-i18n="Include metadata in chunks">Include metadata in chunks</span>
            </label>
            <small class="charMemory_helperText" data-i18n="Prefix each bullet with [date | chat_id] so standalone chunks retain their provenance.">Prefix each bullet with [date | chat_id] so standalone chunks retain their provenance.</small>
        </div>
        <div class="charMemory_statusRow" style="margin-top:8px;">
            <label class="checkbox_label" for="cm_modal_hideExtracted">
                <input type="checkbox" id="cm_modal_hideExtracted" ${s.hideExtractedMessages ? 'checked' : ''} />
                <span data-i18n="Hide extracted messages from context">Hide extracted messages from context</span>
            </label>
            <small class="charMemory_helperText" data-i18n="After extraction, hides processed messages from the main LLM so they don't consume context tokens. Memories are still retrieved via Vector Storage. Use &quot;Unhide&quot; in the Troubleshooter to reverse.">After extraction, hides processed messages from the main LLM so they don't consume context tokens. Memories are still retrieved via Vector Storage. Use "Unhide" in the Troubleshooter to reverse.</small>
        </div>

        <hr class="charMemory_separator" />
        <h4 class="charMemory_modalSectionTitle" data-i18n="Consolidation">Consolidation</h4>
        <div class="charMemory_statusRow">
            <label for="cm_modal_consolidationChunkChars">
                <small data-i18n="Chunk size (chars)">Chunk size (chars)</small>
            </label>
            <input type="number" id="cm_modal_consolidationChunkChars" class="text_pole" min="4000" step="1000" value="${s.consolidationChunkChars || 24000}" />
            <small class="charMemory_helperText" data-i18n="Large memory sets are split into chunks of this size to avoid consolidation truncation. Lower means more LLM calls but accommodates smaller output limits. Default 24000. Minimum 4000.">Large memory sets are split into chunks of this size to avoid consolidation truncation. Lower means more LLM calls but accommodates smaller output limits. Default 24000. Minimum 4000.</small>
        </div>

        <hr class="charMemory_separator" />
        <h4 class="charMemory_modalSectionTitle" data-i18n="Reset">Reset</h4>
        <div class="charMemory_statusRow">
            <input type="button" id="cm_modal_resetThisChat" class="menu_button" value="Reset This Chat" data-i18n="[value]Reset This Chat"
                title="Resets the extraction pointer for the active chat — next 'Extract Now' re-reads from the first message. In group chats all characters share one pointer, so all are reset together." />
            <small class="charMemory_helperText">
                Resets the extraction pointer for the active chat. Next "Extract Now" will re-read all messages in this chat from the first.
                ${isGroupChat() ? '<br><i class="fa-solid fa-people-group fa-xs"></i> <em>Group chat:</em> all members share one extraction pointer, so this resets all of them at once.' : ''}
            </small>
            <input type="button" id="cm_modal_resetBatchProgress" class="menu_button" value="Reset Batch Progress" data-i18n="[value]Reset Batch Progress"
                title="Clears batch extraction records for all of this character's chats. Use before re-running Batch Extract to start fresh. Does not affect regular (non-batch) extraction for non-active chats." />
            <small class="charMemory_helperText">
                The Batch tool remembers the last message it processed in each chat file so future runs only extract new messages. Reset this to make Batch treat all of ${escapeHtml(getCharacterName() || 'this character')}'s chats as unprocessed — for example, after changing the extraction prompt. Does not affect Extract Now or auto-extraction.
            </small>
            <input type="button" id="cm_modal_resetExtraction" class="menu_button charMemory_dangerBtn" value="Clear All Memories" data-i18n="[value]Clear All Memories" title="Delete this character's memory file and reset extraction tracking — cannot be undone" />
            <small class="charMemory_helperText" data-i18n="Deletes this character's memory file (contains memories from all their chats) and resets extraction tracking. Cannot be undone.">Deletes this character's memory file (contains memories from all their chats) and resets extraction tracking. Cannot be undone.</small>
        </div>
    `;

    // Assemble modal HTML
    const html = `<div class="charMemory_modal">
        <div class="charMemory_modalNav">
            <button class="charMemory_modalNavItem active" data-section="connection" data-i18n="Connection">Connection</button>
            <button class="charMemory_modalNavItem" data-section="extraction" data-i18n="Extraction">Extraction</button>
            <button class="charMemory_modalNavItem" data-section="storage" data-i18n="Storage">Storage</button>
            <button class="charMemory_modalNavItem" data-section="prompts" data-i18n="Prompts">Prompts</button>
            <button class="charMemory_modalNavItem" data-section="advanced" data-i18n="Advanced">Advanced</button>
        </div>
        <div class="charMemory_modalContent">
            <div class="charMemory_modalSection active" data-section="connection">${connectionHtml}</div>
            <div class="charMemory_modalSection" data-section="extraction">${extractionHtml}</div>
            <div class="charMemory_modalSection" data-section="storage">${storageHtml}</div>
            <div class="charMemory_modalSection" data-section="prompts">${promptsHtml}</div>
            <div class="charMemory_modalSection" data-section="advanced">${advancedHtml}</div>
        </div>
    </div>`;

    // Open popup
    const popup = callGenericPopup(html, POPUP_TYPE.TEXT, '', { wide: true, allowVerticalScrolling: true });

    // Wire nav switching (scoped to this modal's container)
    const $settingsModal = $('.charMemory_modal').last();
    $settingsModal.on('click', '.charMemory_modalNavItem', function () {
        const section = $(this).data('section');
        $settingsModal.find('.charMemory_modalNavItem').removeClass('active');
        $(this).addClass('active');
        $settingsModal.find('.charMemory_modalSection').removeClass('active');
        $settingsModal.find(`.charMemory_modalSection[data-section="${section}"]`).addClass('active');
    });

    // === Connection handlers ===
    $('#cm_modal_source').off('change').on('change', function () {
        const val = String($(this).val());
        extension_settings[MODULE_NAME].source = val;
        saveSettingsDebounced();
        $('#cm_modal_providerSettings').toggle(val === 'provider');
        $('#cm_modal_profileSettings').toggle(val === 'profile');
        // Sync sidebar
        $('#charMemory_source').val(val);
        toggleProviderSettings(val);
    });

    $('#cm_modal_providerSelect').off('change').on('change', function () {
        const key = String($(this).val());
        extension_settings[MODULE_NAME].selectedProvider = key;
        saveSettingsDebounced();
        // Sync sidebar
        $('#charMemory_providerSelect').val(key);
        // Update modal provider UI
        updateModalProviderUI();
    });

    // === Connection Profile handlers ===
    if (cmAvailable) {
        try {
            const context = getContext();
            const CMRS = context.ConnectionManagerRequestService;
            if (CMRS) {
                CMRS.handleDropdown(
                    '#cm_modal_profileSelect',
                    s.selectedProfileId || '',
                    (profile) => {
                        // onChange — fires on selection, update, or delete
                        extension_settings[MODULE_NAME].selectedProfileId = profile?.id || '';
                        saveSettingsDebounced();
                    },
                    (profile) => {
                        // onCreate — new profile added to dropdown automatically
                        logActivity(`New connection profile available: ${profile?.name}`, 'info');
                    },
                    (oldProfile, newProfile) => {
                        // onUpdate — dropdown refreshes automatically
                        if (oldProfile?.id === s.selectedProfileId) {
                            logActivity(`Active connection profile "${newProfile?.name}" was updated`, 'info');
                        }
                    },
                    (profile) => {
                        // onDelete — clear selection if the active profile was deleted
                        if (profile?.id === s.selectedProfileId) {
                            extension_settings[MODULE_NAME].selectedProfileId = '';
                            saveSettingsDebounced();
                            logActivity('Active connection profile was deleted — please select a new one', 'warn');
                        }
                    },
                );
            }
        } catch (err) {
            console.warn(`${LOG_PREFIX} Failed to initialize profile dropdown:`, err);
        }
    }

    $('#cm_modal_profileSystemPrompt').off('input').on('input', function () {
        extension_settings[MODULE_NAME].profileSystemPrompt = String($(this).val());
        saveSettingsDebounced();
    });

    $('#cm_modal_profileTest').off('click').on('click', async function () {
        await testProfileConnection();
    });

    $('#cm_modal_apiKey').off('input').on('input', function () {
        const pk = extension_settings[MODULE_NAME].selectedProvider;
        const ps = getProviderSettings(pk);
        ps.apiKey = String($(this).val());
        saveSettingsDebounced();
        // Sync sidebar
        $('#charMemory_providerApiKey').val(ps.apiKey);
    });

    $('#cm_modal_apiKeyReveal').off('click').on('click', function () {
        const $input = $('#cm_modal_apiKey');
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

    $('#cm_modal_baseUrl').off('input').on('input', function () {
        const ps = getProviderSettings(extension_settings[MODULE_NAME].selectedProvider);
        ps.customBaseUrl = String($(this).val());
        saveSettingsDebounced();
        // Sync sidebar
        $('#charMemory_providerBaseUrl').val(ps.customBaseUrl);
    });

    $('#cm_modal_connect').off('click').on('click', async function () {
        const pk = extension_settings[MODULE_NAME].selectedProvider;
        const p = PROVIDER_PRESETS[pk];
        const ps = getProviderSettings(pk);
        const $btn = $(this);
        const $status = $('#cm_modal_connectStatus');

        if (p?.requiresApiKey && !ps.apiKey) {
            $status.text(t`Enter an API key first.`).css('color', '#e74c3c').show();
            return;
        }

        $btn.prop('disabled', true).val(t`Connecting...`);
        $status.text(t`Fetching models...`).css('color', '').show();

        try {
            await populateProviderModels(pk, true);
            const modelCount = currentModelList.length;
            if (modelCount > 0) {
                $status.text(modelCount === 1 ? t`Connected — ${modelCount} model available.` : t`Connected — ${modelCount} models available.`).css('color', '#27ae60').show();
            } else {
                $status.text(t`Connected, but no models returned.`).css('color', '#e67e22').show();
            }
            // Update modal model list
            const savedModel = ps.model || '';
            const match = currentModelList.find(m => m.id === savedModel);
            $('#cm_modal_providerModel').val(savedModel);
            $('#cm_modal_modelSearch').val(match ? match.name : savedModel).attr('placeholder', 'Search models...');
            const rawModels = pk === 'nanogpt' ? (cachedNanoGptModels || []) : [];
            $('#cm_modal_modelList').show();
            renderModalModelList('', rawModels);
        } catch (err) {
            $status.text(t`Connection failed: ${err.message}`).css('color', '#e74c3c').show();
        } finally {
            $btn.prop('disabled', false).val(t`Connect`);
        }
    });

    // Model search — filter always-visible list
    $('#cm_modal_modelSearch').off('input').on('input', function () {
        const rawModels = extension_settings[MODULE_NAME].selectedProvider === 'nanogpt' ? (cachedNanoGptModels || []) : [];
        renderModalModelList($(this).val(), rawModels);
    });

    // Model list click — select model
    $('#cm_modal_modelList').off('click').on('click', '.charMemory_modelOption', function () {
        const modelId = $(this).data('model-id');
        const model = currentModelList.find(m => m.id === modelId);
        if (!model) return;

        $('#cm_modal_providerModel').val(modelId);
        $('#cm_modal_modelSearch').val(model.name);
        $('#cm_modal_modelList .charMemory_modelOption').removeClass('selected');
        $(this).addClass('selected');

        const pk = extension_settings[MODULE_NAME].selectedProvider;
        const ps = getProviderSettings(pk);
        ps.model = modelId;
        saveSettingsDebounced();

        // Sync sidebar
        $('#charMemory_providerModel').val(modelId);
        $('#charMemory_modelSearch').val(model.name);

        if (pk === 'nanogpt' && cachedNanoGptModels) {
            updateProviderModelInfo(cachedNanoGptModels, modelId);
        }
    });

    // NanoGPT filter checkboxes — re-render list
    $('#cm_modal_nanogptFilterSub, #cm_modal_nanogptFilterOS, #cm_modal_nanogptFilterRP, #cm_modal_nanogptFilterReasoning').off('change').on('change', function () {
        const pk = extension_settings[MODULE_NAME].selectedProvider;
        const ps = getProviderSettings(pk);
        ps.nanogptFilterSubscription = $('#cm_modal_nanogptFilterSub').is(':checked');
        ps.nanogptFilterOpenSource = $('#cm_modal_nanogptFilterOS').is(':checked');
        ps.nanogptFilterRoleplay = $('#cm_modal_nanogptFilterRP').is(':checked');
        ps.nanogptFilterReasoning = $('#cm_modal_nanogptFilterReasoning').is(':checked');
        saveSettingsDebounced();
        renderModalModelList($('#cm_modal_modelSearch').val(), cachedNanoGptModels || []);
    });

    $('#cm_modal_refreshModels').off('click').on('click', function () {
        const pk = extension_settings[MODULE_NAME].selectedProvider;
        populateProviderModels(pk, true).then(async () => {
            const ps = getProviderSettings(pk);
            const match = currentModelList.find(m => m.id === ps.model);
            $('#cm_modal_providerModel').val(ps.model || '');
            $('#cm_modal_modelSearch').val(match ? match.name : ps.model || '').attr('placeholder', 'Search models...');
            const rawModels = pk === 'nanogpt' ? (cachedNanoGptModels || []) : [];
            $('#cm_modal_modelList').show();
            renderModalModelList('', rawModels);
        });
    });

    $('#cm_modal_modelInput').off('input').on('input', function () {
        const ps = getProviderSettings(extension_settings[MODULE_NAME].selectedProvider);
        ps.model = String($(this).val());
        saveSettingsDebounced();
    });

    $('#cm_modal_systemPrompt').off('input').on('input', function () {
        const ps = getProviderSettings(extension_settings[MODULE_NAME].selectedProvider);
        ps.systemPrompt = String($(this).val());
        saveSettingsDebounced();
    });

    $('#cm_modal_testModel').off('click').on('click', async function () {
        await testProviderConnection();
    });

    // Run Setup Wizard link — close settings and open wizard
    $('#cm_modal_runWizard').off('click').on('click', function () {
        // Close the settings modal
        const $dialog = $settingsModal.closest('.popup');
        if ($dialog.length) {
            $dialog.find('.popup-button-ok, .popup-button-close').first().trigger('click');
        }
        // Open wizard after a brief delay to let the popup close
        setTimeout(() => showSetupWizard(1), 200);
    });

    // === Extraction handlers ===
    const sliderHandler = (sliderId, counterId, settingKey, syncSliderId, syncCounterId) => {
        $(`#${sliderId}`).off('input').on('input', function () {
            const val = Number($(this).val());
            extension_settings[MODULE_NAME][settingKey] = val;
            $(`#${counterId}`).val(val);
            saveSettingsDebounced();
            if (syncSliderId) $(`#${syncSliderId}`).val(val);
            if (syncCounterId) $(`#${syncCounterId}`).val(val);
            if (settingKey === 'interval') updateStatusDisplay();
        });
        $(`#${counterId}`).off('input').on('input', function () {
            const val = Number($(this).val());
            extension_settings[MODULE_NAME][settingKey] = val;
            $(`#${sliderId}`).val(val);
            saveSettingsDebounced();
            if (syncSliderId) $(`#${syncSliderId}`).val(val);
            if (syncCounterId) $(`#${syncCounterId}`).val(val);
            if (settingKey === 'interval') updateStatusDisplay();
        });
    };

    sliderHandler('cm_modal_interval', 'cm_modal_intervalCounter', 'interval', 'charMemory_interval', 'charMemory_intervalCounter');
    sliderHandler('cm_modal_extractionLag', 'cm_modal_extractionLagCounter', 'extractionLag', null, null);
    sliderHandler('cm_modal_minCooldown', 'cm_modal_minCooldownCounter', 'minCooldownMinutes', 'charMemory_minCooldown', 'charMemory_minCooldownCounter');
    sliderHandler('cm_modal_maxMessages', 'cm_modal_maxMessagesCounter', 'maxMessagesPerExtraction', 'charMemory_maxMessages', 'charMemory_maxMessagesCounter');
    sliderHandler('cm_modal_responseLength', 'cm_modal_responseLengthCounter', 'responseLength', 'charMemory_responseLength', 'charMemory_responseLengthCounter');

    $('#cm_modal_mergeChunks').off('change').on('change', function () {
        extension_settings[MODULE_NAME].mergeChunks = !!$(this).prop('checked');
        saveSettingsDebounced();
        // Sync sidebar
        $('#charMemory_mergeChunks').prop('checked', extension_settings[MODULE_NAME].mergeChunks);
    });

    $('#cm_modal_protectRecent').off('change').on('change', function () {
        extension_settings[MODULE_NAME].protectRecentMessages = !!$(this).prop('checked');
        saveSettingsDebounced();
        $('#cm_modal_protectRecentCountRow').toggle(extension_settings[MODULE_NAME].protectRecentMessages);
    });

    sliderHandler('cm_modal_protectRecentCount', 'cm_modal_protectRecentCountCounter', 'protectRecentMessagesCount');

    // Prompt view/edit buttons — open the Prompts modal
    $('#cm_modal_promptsViewExtraction').off('click').on('click', () => showPromptsModal('extraction'));
    $('#cm_modal_promptsViewGroup').off('click').on('click', () => showPromptsModal('groupExtraction'));
    $('#cm_modal_promptsViewConsolidation').off('click').on('click', () => showPromptsModal('consolidation'));
    $('#cm_modal_promptsViewConversion').off('click').on('click', () => showPromptsModal('conversion'));

    // === Storage handlers ===
    $('#cm_modal_perChat').off('change').on('change', function () {
        extension_settings[MODULE_NAME].perChat = !!$(this).prop('checked');
        saveSettingsDebounced();
        // Sync sidebar
        $('#charMemory_perChat').prop('checked', extension_settings[MODULE_NAME].perChat);
    });

    $('#cm_modal_fileName').off('input').on('input', function () {
        const val = String($(this).val()).trim();
        extension_settings[MODULE_NAME].fileName = val;
        saveSettingsDebounced();
        // Sync sidebar
        $('#charMemory_fileName').val(val);
    });

    // === Advanced handlers ===
    $('#cm_modal_displayMode').off('change').on('change', function () {
        const val = $(this).val();
        extension_settings[MODULE_NAME].displayMode = val;
        delete extension_settings[MODULE_NAME].tabletMode; // clean up legacy key
        saveSettingsDebounced();
        applyDisplayModeClass();
        syncChatPushFromDrawers();
        // If switched to desktop while tablet panel is open, close it and restore sidebar
        if (!isTabletMode() && isTabletPanelOpen()) {
            toggleTabletPanel(false);
        }
    });

    $('#cm_modal_pushChatContent').off('change').on('change', function () {
        extension_settings[MODULE_NAME].pushChatContent = !!$(this).prop('checked');
        saveSettingsDebounced();
        syncChatPushFromDrawers();
    });

    $('#cm_modal_chunkBoundary').off('change').on('change', async function () {
        const val = $(this).val();
        extension_settings[MODULE_NAME].chunkBoundary = val;
        saveSettingsDebounced();
        $('#cm_modal_customSeparatorRow').toggle(val === 'custom');
        $('#cm_modal_chunkMetadataRow').toggle(val === 'bullet' || val === 'custom');
        // Sync sidebar
        $('#charMemory_chunkBoundary').val(val);
        toggleChunkBoundaryUI(val);
        await offerReformat();
    });

    $('#cm_modal_customSeparator').off('input').on('input', function () {
        extension_settings[MODULE_NAME].customSeparator = $(this).val();
        saveSettingsDebounced();
        // Sync sidebar
        $('#charMemory_customSeparator').val(extension_settings[MODULE_NAME].customSeparator);
    });

    $('#cm_modal_chunkMetadata').off('change').on('change', function () {
        extension_settings[MODULE_NAME].chunkMetadata = $(this).prop('checked');
        saveSettingsDebounced();
        // Sync sidebar
        $('#charMemory_chunkMetadata').prop('checked', extension_settings[MODULE_NAME].chunkMetadata);
    });

    $('#cm_modal_hideExtracted').off('change').on('change', function () {
        extension_settings[MODULE_NAME].hideExtractedMessages = $(this).is(':checked');
        saveSettingsDebounced();
    });

    $('#cm_modal_consolidationChunkChars').off('input').on('input', function () {
        const raw = Number($(this).val());
        const clamped = Number.isFinite(raw) ? Math.max(4000, Math.floor(raw)) : 24000;
        extension_settings[MODULE_NAME].consolidationChunkChars = clamped;
        saveSettingsDebounced();
    });

    // Reset / Clear handlers
    $('#cm_modal_resetThisChat').off('click').on('click', async function () {
        const charName = getCharacterName() || t`this character`;
        const isGroup = isGroupChat();
        const scopeNote = isGroup
            ? `<br><small>${t`This is a group chat — all members share one extraction pointer and will all be reset together.`}</small>`
            : '';
        const confirmed = await callGenericPopup(
            t`The extraction pointer for the active chat will be reset for <strong>${escapeHtml(charName)}</strong>. Next "Extract Now" will re-read all messages in this chat from the first.${scopeNote}`,
            POPUP_TYPE.CONFIRM, t`Reset This Chat`,
        );
        if (!confirmed) return;
        resetCurrentChatTracking();
    });

    $('#cm_modal_resetBatchProgress').off('click').on('click', async function () {
        const charName = getCharacterName() || t`this character`;
        const confirmed = await callGenericPopup(
            t`The Batch tool's record of which messages it has already processed will be cleared for all of <strong>${escapeHtml(charName)}</strong>'s chats. The next Batch run will re-read every message from the start, which may create duplicate memories unless you clear existing memories first. Extract Now and auto-extraction are not affected.`,
            POPUP_TYPE.CONFIRM, t`Reset Batch Progress`,
        );
        if (!confirmed) return;
        resetBatchProgress();
    });

    $('#cm_modal_resetExtraction').off('click').on('click', async function () {
        const charName = getCharacterName() || t`this character`;
        const sLocal = extension_settings[MODULE_NAME];
        const scopeNote = sLocal.perChat
            ? t`This will delete memories for the current chat only.`
            : t`This includes memories from all of ${escapeHtml(charName)}'s chats.`;
        const confirmed = await callGenericPopup(
            t`<strong>${escapeHtml(charName)}'s</strong> memory file will be deleted and extraction tracking will be reset. This cannot be undone.<br><br>${scopeNote}`,
            POPUP_TYPE.CONFIRM, t`Clear All Memories`,
        );
        if (!confirmed) return;
        await clearAllMemories();
    });

    // Populate group members list if in a group chat
    if (isGroupChat()) {
        const targets = getMemoryTargets();
        if (targets.length > 0) {
            const memberHtml = targets.map(t => {
                const override = extension_settings[MODULE_NAME].characterFileNames?.[t.avatar] || '';
                return `<div class="charMemory_groupMemberRow">
                    <img class="charMemory_groupAvatar" src="/thumbnail?type=avatar&file=${encodeURIComponent(t.avatar)}" alt="${escapeHtml(t.name)}" onerror="this.style.display='none'" />
                    <span class="charMemory_groupMemberName">${escapeHtml(t.name)}</span>
                    <input type="text" class="text_pole charMemory_groupMemberFile cm_modal_groupMemberFile" data-avatar="${escapeAttr(t.avatar)}" placeholder="${escapeAttr(t.fileName)}" value="${escapeAttr(override)}" style="flex:1;" />
                </div>`;
            }).join('');
            $('#cm_modal_groupMembersList').html(memberHtml);

            $(document).off('input.cmModalGroupMember').on('input.cmModalGroupMember', '.cm_modal_groupMemberFile', function () {
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
        }
    }

    // Clean up delegated handlers when popup closes
    popup.then(() => {
        $(document).off('click.cmModalModelPicker');
        $(document).off('input.cmModalGroupMember');
    });
}

// ============ Prompts Modal ============

/**
 * Get the current prompt text for a given prompt key.
 * Handles the consolidation prompt's per-strategy special case.
 * @param {string} promptKey Key from PROMPT_CONFIG
 * @returns {string}
 */
function getPromptText(promptKey) {
    const s = extension_settings[MODULE_NAME];
    if (promptKey === 'consolidation') {
        const strategy = s.consolidationStrategy || 'balanced';
        const overrides = s.consolidationPrompts || {};
        return overrides[strategy] || CONSOLIDATION_PRESETS[strategy]?.prompt || '';
    }
    const config = PROMPT_CONFIG[promptKey];
    return s[config.settingsKey] || config.defaultValue || '';
}

/**
 * Get the default prompt text for a given prompt key.
 * @param {string} promptKey Key from PROMPT_CONFIG
 * @returns {string}
 */
function getDefaultPromptText(promptKey) {
    if (promptKey === 'consolidation') {
        const strategy = extension_settings[MODULE_NAME].consolidationStrategy || 'balanced';
        return CONSOLIDATION_PRESETS[strategy]?.prompt || '';
    }
    return PROMPT_CONFIG[promptKey].defaultValue || '';
}

/**
 * Save a prompt's text to extension_settings.
 * Handles consolidation's per-strategy storage.
 * @param {string} promptKey Key from PROMPT_CONFIG
 * @param {string} text The prompt text to save
 */
function savePromptText(promptKey, text) {
    const s = extension_settings[MODULE_NAME];
    if (promptKey === 'consolidation') {
        const strategy = s.consolidationStrategy || 'balanced';
        if (!s.consolidationPrompts) s.consolidationPrompts = {};
        s.consolidationPrompts[strategy] = text;
    } else {
        s[PROMPT_CONFIG[promptKey].settingsKey] = text;
    }
    saveSettingsDebounced();
}

/**
 * Check whether the current prompt is customized (differs from default).
 * @param {string} promptKey Key from PROMPT_CONFIG
 * @returns {boolean}
 */
function isPromptCustomized(promptKey) {
    return getPromptText(promptKey) !== getDefaultPromptText(promptKey);
}

/**
 * Check whether a prompt has an update available.
 * An update is available when the user has a custom prompt AND the stored
 * version for that prompt is older than the current PROMPT_CONFIG version.
 * @param {string} promptKey Key from PROMPT_CONFIG
 * @returns {boolean}
 */
function hasPromptUpdate(promptKey) {
    const s = extension_settings[MODULE_NAME];
    const stored = (s.promptVersions || {})[promptKey];
    const current = PROMPT_CONFIG[promptKey]?.version;
    if (!stored || !current) return false;
    return isPromptCustomized(promptKey) && stored !== current;
}

/**
 * Check all prompt versions on load. For each prompt:
 * - If no stored version yet, initialize to current (no notification).
 * - If the user has the default prompt and a version mismatch, silently update
 *   the stored version (they already have the latest text).
 * - If the user has a custom prompt and a version mismatch, leave the mismatch
 *   in place so hasPromptUpdate() returns true and the banner is shown.
 */
function checkPromptVersions() {
    const s = extension_settings[MODULE_NAME];
    if (!s.promptVersions) s.promptVersions = {};
    let changed = false;

    for (const [key, config] of Object.entries(PROMPT_CONFIG)) {
        const stored = s.promptVersions[key];
        const current = config.version;

        if (!stored) {
            if (isPromptCustomized(key)) {
                // Upgrading from pre-2.0 (no promptVersions stored) with a custom prompt
                // — use a sentinel so hasPromptUpdate() fires and the banner is shown
                s.promptVersions[key] = 'pre-2.0';
            } else {
                // First time with default prompt — silently initialize to current
                s.promptVersions[key] = current;
            }
            changed = true;
        } else if (stored !== current && !isPromptCustomized(key)) {
            // User has the default prompt text — silently update stored version
            s.promptVersions[key] = current;
            changed = true;
        }
        // If stored !== current AND prompt is customized → leave mismatch for banner
    }

    if (changed) saveSettingsDebounced();
}

/**
 * Acknowledge a prompt version update — sets the stored version to current.
 * @param {string} promptKey Key from PROMPT_CONFIG
 */
function acknowledgePromptVersion(promptKey) {
    const s = extension_settings[MODULE_NAME];
    if (!s.promptVersions) s.promptVersions = {};
    s.promptVersions[promptKey] = PROMPT_CONFIG[promptKey].version;
    saveSettingsDebounced();
}

/**
 * Build and show the Prompts modal with left-nav layout.
 * @param {string} activePrompt Which prompt to show initially: 'extraction', 'groupExtraction', 'consolidation', 'conversion'
 */
async function showPromptsModal(activePrompt = 'extraction') {
    const s = extension_settings[MODULE_NAME];

    // Helper: build badge text for a prompt
    function getBadgeText(key) {
        const config = PROMPT_CONFIG[key];
        const customized = isPromptCustomized(key);
        return customized ? `v${config.version} \u2022 Customized` : `v${config.version} \u2022 Default`;
    }

    // Helper: build update banner HTML (only shown when an update is available)
    function buildUpdateBanner(key) {
        if (!hasPromptUpdate(key)) return '';
        const storedVersion = (s.promptVersions || {})[key] || '?';
        const currentVersion = PROMPT_CONFIG[key].version;
        return `<div class="charMemory_promptUpdateBanner" data-prompt="${escapeAttr(key)}">
            <span>The default prompt was updated (v${escapeHtml(storedVersion)} &rarr; v${escapeHtml(currentVersion)}). Your custom version is unchanged.</span>
            <div class="charMemory_promptUpdateActions">
                <input type="button" class="menu_button charMemory_promptKeepMine" value="Keep mine" data-i18n="[value]Keep mine" />
                <input type="button" class="menu_button charMemory_promptUseNew" value="Use new default" data-i18n="[value]Use new default" />
                <input type="button" class="menu_button charMemory_promptCompare" value="Compare &amp; Edit" data-i18n="[value]Compare & Edit" />
            </div>
        </div>`;
    }

    // Build nav items (with update dot indicator)
    const navItems = Object.entries(PROMPT_CONFIG).map(([key, config]) => {
        const updateDot = hasPromptUpdate(key) ? '<span class="charMemory_navUpdateDot"></span>' : '';
        return `<button class="charMemory_modalNavItem${key === activePrompt ? ' active' : ''}" data-prompt="${escapeAttr(key)}">${escapeHtml(config.navLabel)}${updateDot}</button>`;
    }).join('');

    // Build content sections — one per prompt
    const sections = Object.entries(PROMPT_CONFIG).map(([key, config]) => {
        const current = getPromptText(key);
        const badgeText = getBadgeText(key);
        const strategyNote = key === 'consolidation'
            ? `<small class="charMemory_helperText" style="margin-bottom:8px;display:block;">Strategy: <b>${escapeHtml(CONSOLIDATION_PRESETS[s.consolidationStrategy || 'balanced']?.name || 'balanced')}</b></small>`
            : '';

        return `<div class="charMemory_modalSection${key === activePrompt ? ' active' : ''}" data-prompt="${escapeAttr(key)}">
            <div class="charMemory_promptHeader">
                <h3>${escapeHtml(config.title)}</h3>
                <span class="charMemory_promptBadge">${badgeText}</span>
            </div>
            ${strategyNote}
            ${buildUpdateBanner(key)}
            <div class="charMemory_promptEditorWrap">
                <textarea class="text_pole charMemory_promptEditor" data-prompt="${escapeAttr(key)}">${escapeHtml(current)}</textarea>
            </div>
            <div class="charMemory_promptCompareWrap" style="display:none;">
                <div class="charMemory_comparePane">
                    <label data-i18n="Your prompt (editable)">Your prompt (editable)</label>
                    <textarea class="text_pole charMemory_compareUser" data-prompt="${escapeAttr(key)}">${escapeHtml(current)}</textarea>
                </div>
                <div class="charMemory_comparePane">
                    <label data-i18n="New default (read-only)">New default (read-only)</label>
                    <textarea class="text_pole charMemory_compareDefault" readonly>${escapeHtml(getDefaultPromptText(key))}</textarea>
                </div>
            </div>
            <div class="charMemory_buttonRow" style="margin-top:8px;">
                <input type="button" class="menu_button charMemory_promptRestore" value="Restore Default" data-i18n="[value]Restore Default" />
                <input type="button" class="menu_button charMemory_promptSave" value="Save" data-i18n="[value]Save" />
                <input type="button" class="menu_button charMemory_promptDoneCompare" value="Done comparing" data-i18n="[value]Done comparing" style="display:none;" />
            </div>
        </div>`;
    }).join('');

    const html = `<div class="charMemory_modal charMemory_promptsModal">
        <div class="charMemory_modalNav">${navItems}</div>
        <div class="charMemory_modalContent">${sections}</div>
    </div>`;

    const popup = callGenericPopup(html, POPUP_TYPE.TEXT, '', { wide: true, allowVerticalScrolling: true });

    // Scope all handlers to this modal instance
    const $modal = $('.charMemory_promptsModal').last();

    // Helper: refresh badge and banner for a given section
    function refreshSectionUI($section, key) {
        $section.find('.charMemory_promptBadge').text(getBadgeText(key));
        // Hide/show update banner
        if (!hasPromptUpdate(key)) {
            $section.find('.charMemory_promptUpdateBanner').slideUp(200);
            // Also remove nav dot
            $modal.find(`.charMemory_modalNavItem[data-prompt="${key}"] .charMemory_navUpdateDot`).remove();
        }
    }

    // Nav switching — save current textarea before switching
    $modal.on('click', '.charMemory_modalNavItem', function () {
        // Save current section's textarea before switching
        const $currentSection = $modal.find('.charMemory_modalSection.active');
        const $currentEditor = $currentSection.find('.charMemory_promptEditor:visible, .charMemory_compareUser:visible').first();
        if ($currentEditor.length) {
            const currentKey = $currentEditor.data('prompt');
            savePromptText(currentKey, $currentEditor.val());
            syncSidebarPrompt(currentKey);
        }

        // Switch nav
        const targetKey = $(this).data('prompt');
        $modal.find('.charMemory_modalNavItem').removeClass('active');
        $(this).addClass('active');

        // Switch section
        $modal.find('.charMemory_modalSection').removeClass('active');
        const $targetSection = $modal.find(`.charMemory_modalSection[data-prompt="${targetKey}"]`);
        $targetSection.addClass('active');

        // Reload the prompt text (in case it was changed externally)
        const freshText = getPromptText(targetKey);
        $targetSection.find('.charMemory_promptEditor').val(freshText);
        $targetSection.find('.charMemory_compareUser').val(freshText);

        // Update badge
        refreshSectionUI($targetSection, targetKey);
    });

    // Save button
    $modal.on('click', '.charMemory_promptSave', function () {
        const $section = $(this).closest('.charMemory_modalSection');
        const key = $section.data('prompt');
        // Save from whichever editor is visible (normal or compare)
        const $editor = $section.find('.charMemory_promptEditor:visible, .charMemory_compareUser:visible').first();
        if ($editor.length) {
            savePromptText(key, $editor.val());
            // Sync the other editor too
            $section.find('.charMemory_promptEditor').val($editor.val());
            $section.find('.charMemory_compareUser').val($editor.val());
        }
        syncSidebarPrompt(key);
        refreshSectionUI($section, key);
        toastr.success(t`Prompt saved.`);
    });

    // Restore Default button
    $modal.on('click', '.charMemory_promptRestore', async function () {
        const $section = $(this).closest('.charMemory_modalSection');
        const key = $section.data('prompt');

        const confirmed = await callGenericPopup(
            t`Restore this prompt to its default text? Your customizations will be lost.`,
            POPUP_TYPE.CONFIRM,
            t`Restore Default Prompt`,
        );
        if (!confirmed) return;

        const defaultText = getDefaultPromptText(key);
        $section.find('.charMemory_promptEditor').val(defaultText);
        $section.find('.charMemory_compareUser').val(defaultText);
        savePromptText(key, defaultText);
        acknowledgePromptVersion(key);
        syncSidebarPrompt(key);
        refreshSectionUI($section, key);
        toastr.success(t`Prompt restored to default.`);
    });

    // "Keep mine" — dismiss notification, acknowledge the new version
    $modal.on('click', '.charMemory_promptKeepMine', function () {
        const $section = $(this).closest('.charMemory_modalSection');
        const key = $section.data('prompt');
        acknowledgePromptVersion(key);
        refreshSectionUI($section, key);
        $section.find('.charMemory_promptCompareWrap').hide();
        $section.find('.charMemory_promptEditorWrap').show();
        $section.find('.charMemory_promptDoneCompare').hide();
        toastr.info(t`Notification dismissed. Your custom prompt is unchanged.`);
    });

    // "Use new default" — replace prompt with new default, acknowledge version
    $modal.on('click', '.charMemory_promptUseNew', function () {
        const $section = $(this).closest('.charMemory_modalSection');
        const key = $section.data('prompt');
        const defaultText = getDefaultPromptText(key);
        $section.find('.charMemory_promptEditor').val(defaultText);
        $section.find('.charMemory_compareUser').val(defaultText);
        savePromptText(key, defaultText);
        acknowledgePromptVersion(key);
        syncSidebarPrompt(key);
        refreshSectionUI($section, key);
        $section.find('.charMemory_promptCompareWrap').hide();
        $section.find('.charMemory_promptEditorWrap').show();
        $section.find('.charMemory_promptDoneCompare').hide();
        toastr.success(t`Prompt updated to new default.`);
    });

    // "Compare & Edit" — show side-by-side panes
    $modal.on('click', '.charMemory_promptCompare', function () {
        const $section = $(this).closest('.charMemory_modalSection');
        const key = $section.data('prompt');
        // Copy current editor text to compare pane
        $section.find('.charMemory_compareUser').val($section.find('.charMemory_promptEditor').val());
        $section.find('.charMemory_compareDefault').val(getDefaultPromptText(key));
        // Toggle visibility
        $section.find('.charMemory_promptEditorWrap').hide();
        $section.find('.charMemory_promptCompareWrap').show();
        $section.find('.charMemory_promptDoneCompare').show();
    });

    // "Done comparing" — return to single editor
    $modal.on('click', '.charMemory_promptDoneCompare', function () {
        const $section = $(this).closest('.charMemory_modalSection');
        // Copy the user pane text back to the main editor
        $section.find('.charMemory_promptEditor').val($section.find('.charMemory_compareUser').val());
        // Toggle visibility
        $section.find('.charMemory_promptCompareWrap').hide();
        $section.find('.charMemory_promptEditorWrap').show();
        $(this).hide();
    });

    await popup;
}

/**
 * Sync a prompt change back to the sidebar controls (if they exist).
 * @param {string} promptKey Key from PROMPT_CONFIG
 */
function syncSidebarPrompt(promptKey) {
    switch (promptKey) {
        case 'extraction':
            $('#charMemory_extractionPrompt').val(extension_settings[MODULE_NAME].extractionPrompt);
            break;
        case 'groupExtraction':
            $('#charMemory_groupExtractionPrompt').val(extension_settings[MODULE_NAME].groupExtractionPrompt);
            break;
        case 'consolidation':
            updateConsolidationStrategyUI();
            break;
        case 'conversion':
            $('#charMemory_convertPrompt').val(extension_settings[MODULE_NAME].conversionPrompt || defaultConversionPrompt);
            break;
    }
}

/**
 * Render the always-visible model list in the Settings modal.
 * @param {string} filter Search filter string
 * @param {object[]} [rawModels=[]] Raw NanoGPT model objects for badge rendering
 */
function renderModalModelList(filter, rawModels = []) {
    const $list = $('#cm_modal_modelList');
    $list.empty();

    const lowerFilter = (filter || '').toLowerCase();
    const selectedId = $('#cm_modal_providerModel').val();
    const providerKey = extension_settings[MODULE_NAME].selectedProvider;
    const isNanoGpt = providerKey === 'nanogpt';
    const ps = getProviderSettings(providerKey);

    // Build raw model lookup for badge data
    const rawById = {};
    if (isNanoGpt && rawModels.length > 0) {
        for (const m of rawModels) rawById[m.id] = m;
    }

    // Apply NanoGPT filters if active
    let models = currentModelList;
    if (isNanoGpt && rawModels.length > 0) {
        const filteredRaw = getFilteredNanoGptModels(rawModels, ps);
        const filteredIds = new Set(filteredRaw.map(m => m.id));
        models = currentModelList.filter(m => filteredIds.has(m.id));
    }

    if (models.length === 0) {
        $list.append('<div class="charMemory_modelEmpty" data-i18n="No models — click Connect to fetch">No models \u2014 click Connect to fetch</div>');
        return;
    }

    let hasResults = false;
    let lastGroup = null;

    for (const model of models) {
        if (lowerFilter && !model.id.toLowerCase().includes(lowerFilter) && !model.name.toLowerCase().includes(lowerFilter)) {
            continue;
        }
        if (model.group && model.group !== lastGroup) {
            $list.append(`<div class="charMemory_modelGroup">${escapeHtml(model.group)}</div>`);
            lastGroup = model.group;
        }

        let badgesHtml = '';
        if (isNanoGpt) {
            const raw = rawById[model.id];
            if (raw) {
                if (raw.subscription) badgesHtml += '<span class="charMemory_modelBadge charMemory_modelBadge--sub">sub</span>';
                if (raw.isOpenSource) badgesHtml += '<span class="charMemory_modelBadge charMemory_modelBadge--open">open</span>';
                if (raw.category === 'Roleplay/storytelling models') badgesHtml += '<span class="charMemory_modelBadge charMemory_modelBadge--rp">rp</span>';
                if (raw.capabilities && raw.capabilities.includes('reasoning')) badgesHtml += '<span class="charMemory_modelBadge charMemory_modelBadge--reason">reason</span>';
            }
        }

        const selectedClass = model.id === selectedId ? ' selected' : '';
        $list.append(
            `<div class="charMemory_modelOption${selectedClass}" data-model-id="${escapeAttr(model.id)}"><span class="charMemory_modelOptionName">${escapeHtml(model.name)}</span>${badgesHtml}</div>`
        );
        hasResults = true;
    }

    if (!hasResults) {
        $list.append('<div class="charMemory_modelEmpty" data-i18n="No matching models">No matching models</div>');
    }
}

/**
 * Update the modal provider UI after switching providers.
 * Re-renders provider-specific fields (API key, base URL, model picker, etc.).
 */
function updateModalProviderUI() {
    const providerKey = extension_settings[MODULE_NAME].selectedProvider;
    const preset = PROVIDER_PRESETS[providerKey];
    if (!preset) return;

    const providerSettings = getProviderSettings(providerKey);

    // API Key row
    $('#cm_modal_apiKeyRow').toggle(!!preset.requiresApiKey);
    $('#cm_modal_apiKey').val(providerSettings.apiKey || '');

    // Help link
    if (preset.helpUrl) {
        $('#cm_modal_helpLink').attr('href', preset.helpUrl).show();
    } else {
        $('#cm_modal_helpLink').hide();
    }

    // Base URL row
    $('#cm_modal_baseUrlRow').toggle(!!preset.allowCustomUrl);
    if (preset.allowCustomUrl) {
        const isLocal = preset.authStyle === 'none' && !preset.requiresApiKey;
        $('#cm_modal_baseUrl')
            .attr('placeholder', isLocal ? 'http://127.0.0.1:1234/v1' : 'https://your-server.com/v1')
            .val(providerSettings.customBaseUrl || preset.baseUrl || '');
        $('#cm_modal_baseUrlHint').text(
            isLocal ? 'http://IP:port/v1 — the /v1 suffix is required' : 'OpenAI-compatible base URL ending in /v1'
        ).show();
    } else {
        $('#cm_modal_baseUrl').val('');
        $('#cm_modal_baseUrlHint').hide();
    }

    // Connect button row
    const hasModelsEndpoint = preset.modelsEndpoint === 'standard' || preset.modelsEndpoint === 'custom';
    $('#cm_modal_connectRow').toggle(hasModelsEndpoint);

    // Model: dropdown vs text input
    $('#cm_modal_modelDropdownRow').toggle(hasModelsEndpoint);
    $('#cm_modal_modelInputRow').toggle(!hasModelsEndpoint);

    // NanoGPT filters
    const isNano = providerKey === 'nanogpt';
    $('#cm_modal_nanogptFilters').toggle(isNano);
    if (isNano) {
        $('#cm_modal_nanogptFilterSub').prop('checked', !!providerSettings.nanogptFilterSubscription);
        $('#cm_modal_nanogptFilterOS').prop('checked', !!providerSettings.nanogptFilterOpenSource);
        $('#cm_modal_nanogptFilterRP').prop('checked', !!providerSettings.nanogptFilterRoleplay);
        $('#cm_modal_nanogptFilterReasoning').prop('checked', !!providerSettings.nanogptFilterReasoning);
    }

    if (hasModelsEndpoint) {
        const savedModel = providerSettings.model || '';
        $('#cm_modal_providerModel').val(savedModel);
        $('#cm_modal_modelSearch').val(savedModel || '').attr('placeholder', 'Click Connect to fetch models');
        currentModelList = [];
        $('#cm_modal_modelList').hide().empty();
    } else {
        $('#cm_modal_modelInput').val(providerSettings.model || '');
    }

    // System prompt
    $('#cm_modal_systemPrompt').val(providerSettings.systemPrompt || '');

    // Clear status messages
    $('#cm_modal_connectStatus').hide().text('');
    $('#cm_modal_testStatus').hide().text('');

    // Also update sidebar UI
    updateProviderUI();
}

// ============ Setup Wizard ============

/**
 * Build and display the 3-step Setup Wizard modal.
 * Steps: 1) LLM Connection  2) Vector Storage  3) Ready
 * @param {number} [startStep=1] Step to start on (1, 2, or 3)
 */
async function showSetupWizard(startStep = 1) {
    const s = extension_settings[MODULE_NAME];
    const providerKey = s.selectedProvider || '';
    const providerSettings = providerKey ? getProviderSettings(providerKey) : {};
    const preset = providerKey ? (PROVIDER_PRESETS[providerKey] || {}) : {};

    // Build provider options — sorted alphabetically, custom last, Pollinations highlighted
    const providerOptions = Object.entries(PROVIDER_PRESETS)
        .sort(([ka, a], [kb, b]) => {
            if (ka === 'custom') return 1;
            if (kb === 'custom') return -1;
            return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
        })
        .map(([key, p]) => {
            const label = key === 'pollinations' ? `${p.name} \u2014 free, no API key` : p.name;
            return `<option value="${escapeHtml(key)}" ${key === providerKey ? 'selected' : ''}>${escapeHtml(label)}</option>`;
        }).join('');

    // Step indicator
    const stepIndicatorHtml = `
        <div class="charMemory_wizardStepIndicator">
            <span class="charMemory_wizardDot" data-step="1"></span>
            <span style="opacity:0.3;">\u2014</span>
            <span class="charMemory_wizardDot" data-step="2"></span>
            <span style="opacity:0.3;">\u2014</span>
            <span class="charMemory_wizardDot" data-step="3"></span>
        </div>`;

    // Step 1: LLM Connection
    const noChatWarnStyle = getCharacterName() ? 'display:none;' : '';
    const cmAvailable = isConnectionManagerAvailable();
    const currentSource = s.source || EXTRACTION_SOURCE.PROVIDER;
    const showProfile = currentSource === EXTRACTION_SOURCE.PROFILE;
    const step1Html = `
        <div class="charMemory_wizardStep" data-step="1">
            <div id="cm_wiz_noChatWarn" class="charMemory_wizardCallout charMemory_wizardCallout--warn" style="${noChatWarnStyle}">
                <i class="fa-solid fa-triangle-exclamation fa-sm"></i>
                <span data-i18n="Not in a chat. CharMemory needs an active character to extract memories. You can configure it now — just open a chat before clicking Extract Now."><strong>Not in a chat.</strong> CharMemory needs an active character to extract memories. You can configure it now \u2014 just open a chat before clicking Extract Now.</span>
            </div>
            <div class="charMemory_wizardExplanation" data-i18n="CharMemory automatically extracts structured memories from your roleplay chats and stores them so your characters can recall past events. It needs access to an LLM to read your messages and create memory summaries.">
                <strong>CharMemory</strong> automatically extracts structured memories from your roleplay chats and stores them so your characters can recall past events.
                It needs access to an LLM to read your messages and create memory summaries.
            </div>
            <div class="charMemory_modalFieldGroup">
                <label><small data-i18n="Connection type">Connection type</small></label>
                <div class="charMemory_wizSourceToggle">
                    <button type="button" class="menu_button charMemory_wizSourceBtn${!showProfile ? ' active' : ''}" data-source="provider" data-i18n="Dedicated API">Dedicated API</button>
                    <button type="button" class="menu_button charMemory_wizSourceBtn${showProfile ? ' active' : ''}" data-source="profile" ${!cmAvailable ? 'disabled title="Enable the Connection Manager extension to use saved profiles"' : ''} data-i18n="Connection Profile">Connection Profile</button>
                </div>
            </div>
            <div id="cm_wiz_providerSection" style="${showProfile ? 'display:none;' : ''}">
            <div class="charMemory_modalFieldGroup">
                <label><small data-i18n="Provider">Provider</small></label>
                <select id="cm_wiz_provider" class="text_pole">${providerOptions}</select>
                <small id="cm_wiz_providerHint" class="charMemory_helperText"></small>
            </div>
            <div class="charMemory_modalFieldGroup" id="cm_wiz_baseUrlRow" style="${preset.allowCustomUrl ? '' : 'display:none;'}">
                <label><small data-i18n="Base URL">Base URL</small></label>
                <input type="text" id="cm_wiz_baseUrl" class="text_pole" placeholder="${preset.authStyle === 'none' ? 'http://127.0.0.1:1234/v1' : 'https://your-server.com/v1'}" value="${escapeAttr(providerSettings.customBaseUrl || preset.baseUrl || '')}" />
            </div>
            <div class="charMemory_wizConnectRow">
                <div class="charMemory_wizApiKeyGroup" id="cm_wiz_apiKeyRow" style="${preset.requiresApiKey ? '' : 'display:none;'}">
                    <label><small><span data-i18n="API Key">API Key</span> <a id="cm_wiz_helpLink" href="${escapeAttr(preset.helpUrl || '#')}" target="_blank" style="font-size:0.85em;${preset.helpUrl ? '' : 'display:none;'}" data-i18n="(get key)">(get key)</a></small></label>
                    <div style="display:flex;gap:5px;align-items:center;">
                        <input type="password" id="cm_wiz_apiKey" class="text_pole" placeholder="Enter API key" data-i18n="[placeholder]Enter API key" value="${escapeAttr(providerSettings.apiKey || '')}" style="flex:1;" />
                        <button type="button" id="cm_wiz_apiKeyReveal" class="menu_button" title="Show/hide API key" data-i18n="[title]Show/hide API key" style="padding:3px 8px;flex-shrink:0;"><i class="fa-solid fa-eye fa-sm"></i></button>
                    </div>
                </div>
                <input type="button" id="cm_wiz_connect" class="menu_button${preset.requiresApiKey ? '' : ' charMemory_fullWidth'}" value="Connect &amp; Test" data-i18n="[value]Connect & Test" />
            </div>
            <small id="cm_wiz_connectStatus" class="charMemory_helperText" style="display:none;margin-bottom:6px;"></small>
            <div class="charMemory_modalFieldGroup" id="cm_wiz_modelRow" style="display:none;">
                <label><small data-i18n="Model">Model</small></label>
                <div id="cm_wiz_nanogptFilters" style="display:none;">
                    <div class="charMemory_filterRow">
                        <label class="checkbox_label"><input type="checkbox" id="cm_wiz_nanogptFilterSub" /> <small data-i18n="Subscription">Subscription</small></label>
                        <label class="checkbox_label"><input type="checkbox" id="cm_wiz_nanogptFilterOS" /> <small data-i18n="Open Source">Open Source</small></label>
                        <label class="checkbox_label"><input type="checkbox" id="cm_wiz_nanogptFilterRP" /> <small data-i18n="Roleplay">Roleplay</small></label>
                        <label class="checkbox_label"><input type="checkbox" id="cm_wiz_nanogptFilterReasoning" /> <small data-i18n="Reasoning">Reasoning</small></label>
                    </div>
                </div>
                <div class="charMemory_wizModelPicker">
                    <input type="text" id="cm_wiz_modelSearch" class="charMemory_wizModelSearch" placeholder="Search models..." data-i18n="[placeholder]Search models..." autocomplete="off" value="" />
                    <input type="hidden" id="cm_wiz_modelValue" value="" />
                    <div id="cm_wiz_modelList" class="charMemory_wizModelList"></div>
                </div>
                <small id="cm_wiz_modelStatus" class="charMemory_helperText" style="display:none;"></small>
            </div>
            </div>
            <div id="cm_wiz_profileSection" style="${showProfile ? '' : 'display:none;'}">
                <div class="charMemory_modalFieldGroup">
                    <label><small data-i18n="Connection Profile">Connection Profile</small></label>
                    <select id="cm_wiz_profileSelect" class="text_pole">
                        <option value="" data-i18n="Select a Connection Profile">Select a Connection Profile</option>
                    </select>
                    <small class="charMemory_helperText" data-i18n="Uses credentials and settings from your saved SillyTavern connection profile.">Uses credentials and settings from your saved SillyTavern connection profile.</small>
                </div>
                <div class="charMemory_modalFieldGroup">
                    <input type="button" id="cm_wiz_profileTest" class="menu_button charMemory_fullWidth" value="Test Connection" data-i18n="[value]Test Connection" />
                    <small id="cm_wiz_profileTestStatus" class="charMemory_helperText" style="display:none;margin-bottom:6px;"></small>
                </div>
            </div>
            <div class="charMemory_wizardNav">
                <input type="button" id="cm_wiz_next1" class="menu_button" value="Next \u2192" data-i18n="[value]Next →" disabled />
            </div>
        </div>`;

    // Step 2: Configure
    const step2Html = `
        <div class="charMemory_wizardStep" data-step="2">
            <div class="charMemory_wizardSection">
                <div class="charMemory_wizardSectionTitle" data-i18n="Memory Storage">Memory Storage</div>
                <div class="charMemory_wizardExplanation" style="margin-top:0;" data-i18n="Each character gets their own memory file in their Data Bank. Memories from all of that character's chats are stored together. You can change storage options in Settings later.">
                    Each character gets their own memory file in their Data Bank
                    (e.g., <code>Flux_the_Cat-memories.md</code>). Memories from all of that character's chats are
                    stored together. You can change storage options in Settings later.
                </div>
            </div>
            <div class="charMemory_wizardSection">
                <div class="charMemory_wizardSectionTitle" data-i18n="Extraction Frequency">Extraction Frequency</div>
                <div class="charMemory_wizardIntervalRow">
                    <span data-i18n="Extract memories every">Extract memories every</span>
                    <input type="number" id="cm_wiz_interval" class="charMemory_wizIntervalInput" min="3" max="200" step="1" value="${s.interval || 20}" />
                    <span data-i18n="messages.">messages.</span>
                </div>
                <small class="charMemory_helperText" data-i18n="Lower = more frequent, more API calls. Higher = less frequent, bigger batches. 20 is a good starting point.">Lower = more frequent, more API calls. Higher = less frequent, bigger batches. 20 is a good starting point.</small>
            </div>
            <div class="charMemory_wizardSection">
                <div class="charMemory_wizardSectionTitle" data-i18n="Retrieval (Vector Storage)">Retrieval (Vector Storage)</div>
                <div class="charMemory_wizardExplanation" style="margin-top:0;" data-i18n="Vector Storage finds the right memories at the right time and injects them into the prompt when your character speaks. Without it, memories are stored but never used.">
                    Vector Storage finds the right memories at the right time and injects them into the prompt
                    when your character speaks. Without it, memories are stored but never used.
                </div>
                <div id="cm_wiz_vsStatus"></div>
            </div>
            <div id="cm_wiz_vsAdvisory" style="display:none;">
                <small class="charMemory_helperText" style="color:#e8a33d;">
                    <i class="fa-solid fa-triangle-exclamation fa-xs"></i>
                    You can continue without fixing these \u2014 memories will be stored but not retrieved until Vector Storage is configured.
                </small>
            </div>
            <div class="charMemory_wizardNav">
                <input type="button" id="cm_wiz_back2" class="menu_button" value="\u2190 Back" data-i18n="[value]← Back" />
                <input type="button" id="cm_wiz_next2" class="menu_button" value="Next \u2192" data-i18n="[value]Next →" />
            </div>
        </div>`;

    // Step 3: Review & Go
    const step3Html = `
        <div class="charMemory_wizardStep" data-step="3">
            <div id="cm_wiz_summary" class="charMemory_wizardSummary"></div>
            <div id="cm_wiz_nextSteps"></div>
            <div class="charMemory_wizardCallout">
                <i class="fa-solid fa-circle-info fa-sm"></i>
                <span>Once you have memories, open the <strong>Injection Sidebar</strong> (<i class="fa-solid fa-syringe fa-sm"></i>) to see which ones are being injected into the prompt in real time.</span>
            </div>
            <div id="cm_wiz_existingMemories" style="display:none;">
                <div class="charMemory_wizardExistingMemSection">
                    <i class="fa-solid fa-database fa-sm" style="color:#e8a33d;"></i>
                    <div>
                        <strong data-i18n="Existing memories found">Existing memories found</strong>
                        <div id="cm_wiz_existingMemDetail" class="charMemory_wizardCheckText"></div>
                        <div style="margin-top:6px;display:flex;gap:8px;">
                            <input type="button" id="cm_wiz_convertNow" class="menu_button" value="Convert Now" data-i18n="[value]Convert Now;[title]Reformat memories for better retrieval" title="Reformat memories for better retrieval" />
                            <input type="button" id="cm_wiz_convertSkip" class="menu_button" value="Skip \u2014 I'll do this later" data-i18n="[value]Skip — I'll do this later" />
                        </div>
                    </div>
                </div>
            </div>
            <div class="charMemory_wizardNav">
                <input type="button" id="cm_wiz_back3" class="menu_button" value="\u2190 Back" data-i18n="[value]← Back" />
                <input type="button" id="cm_wiz_done" class="menu_button" value="Get Started" data-i18n="[value]Get Started" />
            </div>
            <div class="charMemory_wizardScopeNote">
                <i class="fa-solid fa-circle-info fa-xs"></i>
                <span data-i18n="Tools like Clear Memories and Reset Extraction State only affect the current character.">Tools like Clear Memories and Reset Extraction State only affect the current character.</span>
            </div>
        </div>`;

    const html = `<div class="charMemory_wizard">
        ${stepIndicatorHtml}
        ${step1Html}
        ${step2Html}
        ${step3Html}
    </div>`;

    const popup = callGenericPopup(html, POPUP_TYPE.DISPLAY, '', { wide: true, allowVerticalScrolling: true });
    const $wizard = $('.charMemory_wizard').last();

    // --- Step navigation helpers ---
    let wizConnectionOk = false;
    let wizHealthResult = null;
    let wizRawModels = [];  // raw NanoGPT model objects for badge rendering

    function showStep(step) {
        $wizard.find('.charMemory_wizardStep').removeClass('active');
        $wizard.find(`.charMemory_wizardStep[data-step="${step}"]`).addClass('active');

        // Update step dots
        $wizard.find('.charMemory_wizardDot').each(function () {
            const dotStep = Number($(this).data('step'));
            $(this).removeClass('active completed');
            if (dotStep === step) $(this).addClass('active');
            else if (dotStep < step) $(this).addClass('completed');
        });

        // Run step-specific init
        if (step === 1) updateWizProviderUI();
        if (step === 2) initStep2();
        if (step === 3) initStep3();
    }

    // --- Step 1: LLM Connection ---
    function updateWizProviderUI() {
        const pk = extension_settings[MODULE_NAME].selectedProvider;
        const p = PROVIDER_PRESETS[pk] || {};
        const ps = getProviderSettings(pk);

        $wizard.find('#cm_wiz_apiKeyRow').toggle(!!p.requiresApiKey);
        $wizard.find('#cm_wiz_apiKey').val(ps.apiKey || '');

        if (p.helpUrl) {
            $wizard.find('#cm_wiz_helpLink').attr('href', p.helpUrl).show();
        } else {
            $wizard.find('#cm_wiz_helpLink').hide();
        }

        $wizard.find('#cm_wiz_baseUrlRow').toggle(!!p.allowCustomUrl);
        if (p.allowCustomUrl) {
            $wizard.find('#cm_wiz_baseUrl')
                .attr('placeholder', p.authStyle === 'none' ? 'http://127.0.0.1:1234/v1' : 'https://your-server.com/v1')
                .val(ps.customBaseUrl || p.baseUrl || '');
        }

        // NanoGPT-specific filters
        const isNanoGpt = pk === 'nanogpt';
        $wizard.find('#cm_wiz_nanogptFilters').toggle(isNanoGpt);
        if (isNanoGpt) {
            $wizard.find('#cm_wiz_nanogptFilterSub').prop('checked', !!ps.nanogptFilterSubscription);
            $wizard.find('#cm_wiz_nanogptFilterOS').prop('checked', !!ps.nanogptFilterOpenSource);
            $wizard.find('#cm_wiz_nanogptFilterRP').prop('checked', !!ps.nanogptFilterRoleplay);
            $wizard.find('#cm_wiz_nanogptFilterReasoning').prop('checked', !!ps.nanogptFilterReasoning);
        }

        // Connect button is full-width when no API key field is shown
        $wizard.find('#cm_wiz_connect').toggleClass('charMemory_fullWidth', !p.requiresApiKey);

        // Provider-specific hint below the dropdown
        const providerHints = {
            pollinations: '<strong>Pollinations</strong> is free and requires no API key \u2014 great for trying out CharMemory. For higher quality, try OpenRouter, Groq, or DeepSeek with an API key.',
            ollama: 'Ollama runs locally. Make sure Ollama is running and set <code>OLLAMA_ORIGINS=*</code> to allow browser access.',
        };
        $wizard.find('#cm_wiz_providerHint').html(providerHints[pk] || '');

        // Reset connection state
        wizConnectionOk = false;
        $wizard.find('#cm_wiz_next1').prop('disabled', true);
        $wizard.find('#cm_wiz_connectStatus').hide().text('');
        $wizard.find('#cm_wiz_modelRow').hide();
    }

    // --- Source toggle (Dedicated API vs Connection Profile) ---
    $wizard.on('click', '.charMemory_wizSourceBtn', function () {
        const source = $(this).data('source');
        $wizard.find('.charMemory_wizSourceBtn').removeClass('active');
        $(this).addClass('active');

        const isProfile = source === 'profile';
        $wizard.find('#cm_wiz_providerSection').toggle(!isProfile);
        $wizard.find('#cm_wiz_profileSection').toggle(isProfile);

        extension_settings[MODULE_NAME].source = isProfile ? EXTRACTION_SOURCE.PROFILE : EXTRACTION_SOURCE.PROVIDER;
        saveSettingsDebounced();

        // Reset connection state for the new source
        wizConnectionOk = false;
        $wizard.find('#cm_wiz_next1').prop('disabled', true);
        $wizard.find('#cm_wiz_connectStatus, #cm_wiz_profileTestStatus').hide().text('');
    });

    // --- Connection Profile dropdown & test ---
    if (cmAvailable) {
        try {
            const context = getContext();
            const CMRS = context.ConnectionManagerRequestService;
            if (CMRS) {
                CMRS.handleDropdown(
                    '#cm_wiz_profileSelect',
                    s.selectedProfileId || '',
                    (profile) => {
                        extension_settings[MODULE_NAME].selectedProfileId = profile?.id || '';
                        saveSettingsDebounced();
                    },
                );
            }
        } catch (err) {
            console.warn(`${LOG_PREFIX} Failed to initialize wizard profile dropdown:`, err);
        }
    }

    $wizard.on('click', '#cm_wiz_profileTest', async function () {
        const profileId = extension_settings[MODULE_NAME].selectedProfileId;
        const $status = $wizard.find('#cm_wiz_profileTestStatus');
        const $btn = $(this);

        if (!profileId) {
            $status.text(t`Select a connection profile first.`).css('color', '#e74c3c').show();
            return;
        }

        $btn.prop('disabled', true).val(t`Testing...`);
        $status.text(t`Testing connection...`).css('color', '').show();

        try {
            const context = getContext();
            const CMRS = context.ConnectionManagerRequestService;
            const profile = CMRS.getProfile(profileId);
            const profileName = profile?.name || profileId;

            const t0 = performance.now();
            const result = await CMRS.sendRequest(
                profileId,
                [{ role: 'user', content: 'Respond with exactly: CHARMEMORY_TEST_OK' }],
                20,
                { stream: false, extractData: true },
            );
            const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
            const reply = (result?.content || '').trim();

            if (reply.includes('CHARMEMORY_TEST_OK')) {
                $status.text(t`\u2714 ${profileName} responded correctly (${elapsed}s)`).css('color', '#2ecc71').show();
            } else {
                $status.html(t`\u2714 ${escapeHtml(profileName)} connected (${elapsed}s). It may still work for extraction.`).css('color', '#27ae60').show();
            }
            wizConnectionOk = true;
            $wizard.find('#cm_wiz_next1').prop('disabled', false);
        } catch (err) {
            $status.text(t`\u2718 ${err.message || 'Test failed'}`).css('color', '#e74c3c').show();
            wizConnectionOk = false;
            $wizard.find('#cm_wiz_next1').prop('disabled', true);
        } finally {
            $btn.prop('disabled', false).val(t`Test Connection`);
        }
    });

    $wizard.on('change', '#cm_wiz_provider', function () {
        const key = String($(this).val());
        extension_settings[MODULE_NAME].selectedProvider = key;
        extension_settings[MODULE_NAME].source = EXTRACTION_SOURCE.PROVIDER;
        saveSettingsDebounced();
        updateWizProviderUI();
    });

    $wizard.on('input', '#cm_wiz_apiKey', function () {
        const pk = extension_settings[MODULE_NAME].selectedProvider;
        const ps = getProviderSettings(pk);
        ps.apiKey = String($(this).val());
        saveSettingsDebounced();
    });

    $wizard.on('click', '#cm_wiz_apiKeyReveal', function () {
        const $input = $wizard.find('#cm_wiz_apiKey');
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

    $wizard.on('input', '#cm_wiz_baseUrl', function () {
        const pk = extension_settings[MODULE_NAME].selectedProvider;
        const ps = getProviderSettings(pk);
        ps.customBaseUrl = String($(this).val());
        saveSettingsDebounced();
    });

    // Run just the LLM response test with the currently selected model.
    // Called by the Connect & Test button (after model fetch) and by the model
    // list click handler when a previous test failed.
    async function doConnectionTest() {
        const pk = extension_settings[MODULE_NAME].selectedProvider;
        const p = PROVIDER_PRESETS[pk];
        const ps = getProviderSettings(pk);
        const $status = $wizard.find('#cm_wiz_connectStatus');
        const $connectBtn = $wizard.find('#cm_wiz_connect');

        const testModel = ps.model || p.defaultModel;
        if (!testModel) {
            const hasModels = p.modelsEndpoint === 'standard' || p.modelsEndpoint === 'custom';
            $status.text(t`Select a model first.`).css('color', '#e67e22').show();
            if (hasModels) $wizard.find('#cm_wiz_modelRow').show();
            return;
        }

        $connectBtn.prop('disabled', true);
        $status.text(t`Testing model response...`).css('color', '').show();
        try {
            const baseUrl = resolveBaseUrl(p, ps);
            const testMessages = [{ role: 'user', content: 'Respond with exactly: CHARMMEMORY_TEST_OK' }];
            const t0 = performance.now();
            let response;
            if (p.isAnthropic) {
                response = await generateAnthropicResponse(baseUrl, ps.apiKey, testModel, testMessages, 20, p);
            } else {
                response = await generateOpenAICompatibleResponse(baseUrl, ps.apiKey, testModel, testMessages, 20, p);
            }
            const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
            const reply = (response || '').trim();
            const passed = reply.includes('CHARMMEMORY_TEST_OK');

            const modelShort = testModel.length > 30 ? testModel.slice(0, 30) + '\u2026' : testModel;
            const displayLabel = (p.modelsEndpoint === 'none') ? p.name : modelShort;
            if (passed) {
                $status.text(t`\u2714 ${displayLabel} responded correctly (${elapsed}s)`).css('color', '#2ecc71').show();
            } else {
                $status.html(t`\u2714 ${escapeHtml(displayLabel)} connected (${elapsed}s). It may still work for extraction.`).css('color', '#27ae60').show();
            }

            wizConnectionOk = true;
            $wizard.find('#cm_wiz_next1').prop('disabled', false);
        } catch (err) {
            let errMsg = err.message || t`Connection failed`;
            // NVIDIA-specific: model list includes models that need terms accepted on build.nvidia.com
            if (pk === 'nvidia' && errMsg.includes('Not Found')) {
                errMsg += t` — Select a different model, or accept its terms on build.nvidia.com first.`;
            }
            $status.text(t`\u2718 ${errMsg}`).css('color', '#e74c3c').show();
            wizConnectionOk = false;
            $wizard.find('#cm_wiz_next1').prop('disabled', true);
        } finally {
            $connectBtn.prop('disabled', false);
        }
    }

    $wizard.on('click', '#cm_wiz_connect', async function () {
        const pk = extension_settings[MODULE_NAME].selectedProvider;
        const p = PROVIDER_PRESETS[pk];
        const ps = getProviderSettings(pk);
        const $btn = $(this);
        const $status = $wizard.find('#cm_wiz_connectStatus');

        if (p?.requiresApiKey && !ps.apiKey) {
            $status.text(t`Enter an API key first.`).css('color', '#e74c3c').show();
            return;
        }

        $btn.prop('disabled', true).val(t`Connecting...`);
        $status.text(t`Connecting to provider...`).css('color', '').show();

        try {
            // Fetch models if the provider supports it
            const hasModels = p.modelsEndpoint === 'standard' || p.modelsEndpoint === 'custom';
            if (hasModels) {
                await populateProviderModels(pk, true);
                const modelCount = currentModelList.length;

                // Auto-select a model: prefer saved, then default, then first available
                let selectedModel = ps.model || p.defaultModel || '';
                if (selectedModel && !currentModelList.find(m => m.id === selectedModel)) {
                    selectedModel = currentModelList.length > 0 ? currentModelList[0].id : '';
                }
                if (!selectedModel && currentModelList.length > 0) {
                    selectedModel = currentModelList[0].id;
                }

                // Cache raw NanoGPT model objects for badge rendering
                if (pk === 'nanogpt') {
                    wizRawModels = await fetchNanoGptModels();
                } else {
                    wizRawModels = [];
                }

                if (selectedModel) {
                    ps.model = selectedModel;
                    saveSettingsDebounced();
                    $wizard.find('#cm_wiz_modelValue').val(selectedModel);
                    $wizard.find('#cm_wiz_modelRow').show();
                    renderWizModelList('');
                }

                $status.text(modelCount === 1 ? t`Connected — ${modelCount} model available.` : t`Connected — ${modelCount} models available.`).css('color', '#27ae60').show();
            } else {
                // No models endpoint (e.g. Pollinations) — use defaultModel
                const model = ps.model || p.defaultModel || '';
                if (model) {
                    ps.model = model;
                    saveSettingsDebounced();
                }
                $status.text(t`Provider configured.`).css('color', '#27ae60').show();
            }
        } catch (err) {
            $status.text(t`\u2718 ${err.message || 'Connection failed'}`).css('color', '#e74c3c').show();
            wizConnectionOk = false;
            $wizard.find('#cm_wiz_next1').prop('disabled', true);
            $btn.prop('disabled', false).val(t`Connect & Test`);
            return;
        }

        // Restore button, then run the test (model fetch succeeded)
        $btn.prop('disabled', false).val(t`Connect & Test`);
        await doConnectionTest();
    });

    // Wizard model list (always-visible)
    function renderWizModelList(filter) {
        const $list = $wizard.find('#cm_wiz_modelList');
        $list.empty();

        const lowerFilter = (filter || '').toLowerCase();
        const selectedId = $wizard.find('#cm_wiz_modelValue').val();
        const pk = extension_settings[MODULE_NAME].selectedProvider;
        const ps = getProviderSettings(pk);
        const isNanoGpt = pk === 'nanogpt';

        // Build raw model lookup for badge data
        const rawById = {};
        if (isNanoGpt && wizRawModels.length > 0) {
            for (const m of wizRawModels) rawById[m.id] = m;
        }

        // Apply NanoGPT filters if active
        let models = currentModelList;
        if (isNanoGpt && wizRawModels.length > 0) {
            const filteredRaw = getFilteredNanoGptModels(wizRawModels, ps);
            const filteredIds = new Set(filteredRaw.map(m => m.id));
            models = currentModelList.filter(m => filteredIds.has(m.id));
        }

        if (models.length === 0) {
            $list.append('<div class="charMemory_modelEmpty" data-i18n="No models loaded">No models loaded</div>');
            return;
        }

        let hasResults = false;
        let lastGroup = null;
        for (const model of models) {
            if (lowerFilter && !model.id.toLowerCase().includes(lowerFilter) && !model.name.toLowerCase().includes(lowerFilter)) continue;
            if (model.group && model.group !== lastGroup) {
                $list.append(`<div class="charMemory_modelGroup">${escapeHtml(model.group)}</div>`);
                lastGroup = model.group;
            }

            // Build inline badges for NanoGPT
            let badgesHtml = '';
            if (isNanoGpt) {
                const raw = rawById[model.id];
                if (raw) {
                    if (raw.subscription) badgesHtml += '<span class="charMemory_modelBadge charMemory_modelBadge--sub">sub</span>';
                    if (raw.isOpenSource) badgesHtml += '<span class="charMemory_modelBadge charMemory_modelBadge--open">open</span>';
                    if (raw.category === 'Roleplay/storytelling models') badgesHtml += '<span class="charMemory_modelBadge charMemory_modelBadge--rp">rp</span>';
                    if (raw.capabilities && raw.capabilities.includes('reasoning')) badgesHtml += '<span class="charMemory_modelBadge charMemory_modelBadge--reason">reason</span>';
                }
            }

            const selectedClass = model.id === selectedId ? ' selected' : '';
            $list.append(`<div class="charMemory_modelOption${selectedClass}" data-model-id="${escapeAttr(model.id)}"><span class="charMemory_modelOptionName">${escapeHtml(model.name)}</span>${badgesHtml}</div>`);
            hasResults = true;
        }

        if (!hasResults) {
            $list.append('<div class="charMemory_modelEmpty" data-i18n="No matching models">No matching models</div>');
        }
    }

    $wizard.on('input', '#cm_wiz_modelSearch', function () {
        renderWizModelList($(this).val());
    });

    $wizard.on('click', '#cm_wiz_modelList .charMemory_modelOption', function () {
        const modelId = $(this).data('model-id');
        const model = currentModelList.find(m => m.id === modelId);
        if (!model) return;

        $wizard.find('#cm_wiz_modelValue').val(modelId);
        $wizard.find('#cm_wiz_modelSearch').val(model.name);
        $wizard.find('#cm_wiz_modelList .charMemory_modelOption').removeClass('selected');
        $(this).addClass('selected');

        const pk = extension_settings[MODULE_NAME].selectedProvider;
        const ps = getProviderSettings(pk);
        ps.model = modelId;
        saveSettingsDebounced();

        // If the previous test failed (e.g. wrong model auto-selected), re-test
        // with the one the user just explicitly chose.
        if (!wizConnectionOk) {
            doConnectionTest();
        }
    });

    $wizard.on('change', '#cm_wiz_nanogptFilterSub, #cm_wiz_nanogptFilterOS, #cm_wiz_nanogptFilterRP, #cm_wiz_nanogptFilterReasoning', function () {
        const pk = extension_settings[MODULE_NAME].selectedProvider;
        const ps = getProviderSettings(pk);
        ps.nanogptFilterSubscription = $wizard.find('#cm_wiz_nanogptFilterSub').is(':checked');
        ps.nanogptFilterOpenSource = $wizard.find('#cm_wiz_nanogptFilterOS').is(':checked');
        ps.nanogptFilterRoleplay = $wizard.find('#cm_wiz_nanogptFilterRP').is(':checked');
        ps.nanogptFilterReasoning = $wizard.find('#cm_wiz_nanogptFilterReasoning').is(':checked');
        saveSettingsDebounced();
        renderWizModelList($wizard.find('#cm_wiz_modelSearch').val());
    });

    // --- Step 2: Configure ---
    function initStep2() {
        // Sync interval input from settings
        $wizard.find('#cm_wiz_interval').val(extension_settings[MODULE_NAME].interval || 20);

        // Three-tier VS detection: read settings directly (no file checks — new user may have no memory file)
        // Check DOM for VS extension UI — extension_settings.vectors persists when VS is disabled,
        // so we need to confirm the extension is actually loaded before trusting its settings.
        const vecSettings = extension_settings.vectors;
        const $vsStatus = $wizard.find('#cm_wiz_vsStatus');
        const $vsAdvisory = $wizard.find('#cm_wiz_vsAdvisory');

        const vsExtLoaded = !!document.querySelector('#vectors_enabled_files');
        const filesEnabled = vsExtLoaded && !!vecSettings?.enabled_files;

        if (!filesEnabled) {
            // Tier 1: VS not enabled at all
            $vsStatus.html(`<div class="charMemory_wizardCheck">
                <i class="fa-solid fa-circle-xmark fa-sm" style="color:#c44;"></i>
                <div class="charMemory_wizardCheckDetail">
                    <div class="charMemory_wizardCheckLabel" data-i18n="Vector Storage is not enabled">Vector Storage is not enabled</div>
                    <div class="charMemory_wizardCheckText" data-i18n="CharMemory will store memories but your character won't recall them. Enable it in Extensions → Vector Storage when you're ready.">CharMemory will store memories but your character won't recall them.
                        Enable it in <strong>Extensions \u2192 Vector Storage</strong> when you're ready.</div>
                </div>
            </div>`);
            $vsAdvisory.find('small').html(`<i class="fa-solid fa-triangle-exclamation fa-xs"></i>
                You can continue \u2014 memories will be stored. Without Vector Storage enabled, your character won't be able to recall them.`);
            $vsAdvisory.show();
        } else {
            // Check settings quality
            const chunkSize = vecSettings?.chunk_size_db ?? 2500;
            const overlapPct = vecSettings?.overlap_percent_db ?? 0;
            const retrieveChunks = vecSettings?.chunk_count_db ?? 0;

            const issues = [];
            if (chunkSize < 500 || chunkSize > 1500) {
                issues.push(`Chunk size is ${chunkSize} chars — recommended 800–1000 for CharMemory.`);
            }
            if (overlapPct === 0) {
                issues.push('Overlap is 0% — memory blocks that span chunk boundaries may be split. Recommended: 10–25%.');
            }
            if (retrieveChunks > 5) {
                issues.push(`Retrieve chunks is ${retrieveChunks} — recommended 2–3 for CharMemory.`);
            }
            if (retrieveChunks === 0) {
                issues.push('Retrieve chunks is 0 — no memories will be injected.');
            }

            if (issues.length > 0) {
                // Tier 2: VS enabled but settings need tuning
                const issueItems = issues.map(i => `<li>${escapeHtml(i)}</li>`).join('');
                $vsStatus.html(`<div class="charMemory_wizardCheck">
                    <i class="fa-solid fa-triangle-exclamation fa-sm" style="color:#e8a33d;"></i>
                    <div class="charMemory_wizardCheckDetail">
                        <div class="charMemory_wizardCheckLabel" data-i18n="Vector Storage is active, but settings may need tuning">Vector Storage is active, but settings may need tuning</div>
                        <ul class="charMemory_wizardIssueList">${issueItems}</ul>
                        <div class="charMemory_wizardCheckFix"><i class="fa-solid fa-lightbulb fa-xs"></i> Adjust these in <strong>Extensions \u2192 Vector Storage</strong>.</div>
                    </div>
                </div>`);
                $vsAdvisory.find('small').html(`<i class="fa-solid fa-triangle-exclamation fa-xs"></i>
                    You can continue \u2014 memories will be stored and retrieved. Tuning these settings may improve recall accuracy.`);
                $vsAdvisory.show();
            } else {
                // Tier 3: VS fully configured
                $vsStatus.html(`<div class="charMemory_wizardCheck">
                    <i class="fa-solid fa-circle-check fa-sm" style="color:#4a4;"></i>
                    <div class="charMemory_wizardCheckDetail">
                        <div class="charMemory_wizardCheckLabel" data-i18n="Vector Storage is configured">Vector Storage is configured</div>
                        <div class="charMemory_wizardCheckText" data-i18n="CharMemory memories will be automatically retrieved and injected into the prompt.">CharMemory memories will be automatically retrieved and injected into the prompt.</div>
                    </div>
                </div>`);
                $vsAdvisory.hide();
            }
        }
    }

    $wizard.on('input change', '#cm_wiz_interval', function () {
        const val = Math.max(3, Math.min(200, parseInt($(this).val(), 10) || 20));
        extension_settings[MODULE_NAME].interval = val;
        saveSettingsDebounced();
    });

    // --- Step 3: Review & Go ---
    function initStep3() {
        const source = extension_settings[MODULE_NAME].source;
        const isProfile = source === EXTRACTION_SOURCE.PROFILE;
        const pk = extension_settings[MODULE_NAME].selectedProvider;
        const p = PROVIDER_PRESETS[pk] || {};
        const ps = getProviderSettings(pk);
        const interval = extension_settings[MODULE_NAME].interval || 20;

        // Build connection summary rows based on source type
        let connectionRows;
        if (isProfile) {
            let profileName = '(none selected)';
            try {
                const context = getContext();
                const CMRS = context.ConnectionManagerRequestService;
                const profile = CMRS?.getProfile(extension_settings[MODULE_NAME].selectedProfileId);
                if (profile?.name) profileName = profile.name;
            } catch { /* ignore */ }
            connectionRows = `
                <div class="charMemory_wizardSummaryRow">
                    <span class="label" data-i18n="Source">Source</span>
                    <span data-i18n="Connection Profile">Connection Profile</span>
                </div>
                <div class="charMemory_wizardSummaryRow">
                    <span class="label" data-i18n="Profile">Profile</span>
                    <span>${escapeHtml(profileName)}</span>
                </div>`;
        } else {
            const modelName = ps.model || p.defaultModel || '(default)';
            const modelShort = modelName.length > 40 ? modelName.slice(0, 40) + '\u2026' : modelName;
            connectionRows = `
                <div class="charMemory_wizardSummaryRow">
                    <span class="label" data-i18n="Provider">Provider</span>
                    <span>${escapeHtml(p.name || pk)}</span>
                </div>
                <div class="charMemory_wizardSummaryRow">
                    <span class="label" data-i18n="Model">Model</span>
                    <span>${escapeHtml(modelShort)}</span>
                </div>`;
        }

        // VS summary from extension_settings.vectors
        // Check DOM for VS extension UI to avoid false-positive when VS is disabled.
        const vecSettings = extension_settings.vectors;
        const vsExtLoaded = !!document.querySelector('#vectors_enabled_files');
        const filesEnabled = vsExtLoaded && !!vecSettings?.enabled_files;
        let vsSummaryHtml;
        if (!filesEnabled) {
            vsSummaryHtml = `<span style="color:#c44;">\u26A0 Not enabled</span>`;
        } else {
            const chunkSize = vecSettings?.chunk_size_db ?? 2500;
            const overlapPct = vecSettings?.overlap_percent_db ?? 0;
            const retrieveChunks = vecSettings?.chunk_count_db ?? 0;
            const hasIssues = chunkSize < 500 || chunkSize > 1500 || overlapPct === 0 || retrieveChunks > 5 || retrieveChunks === 0;
            vsSummaryHtml = hasIssues
                ? `<span style="color:#e8a33d;">\u26A0 Active \u2014 settings may need tuning</span>`
                : `<span style="color:#4a4;">\u2714 Configured</span>`;
        }

        $wizard.find('#cm_wiz_summary').html(`
            ${connectionRows}
            <div class="charMemory_wizardSummaryRow">
                <span class="label" data-i18n="Connection">Connection</span>
                <span>${wizConnectionOk ? '<span style="color:#4a4;">\u2714 Connected</span>' : '<span style="color:#e8a33d;">\u26A0 Not tested</span>'}</span>
            </div>
            <div class="charMemory_wizardSummaryRow">
                <span class="label" data-i18n="Extraction">Extraction</span>
                <span>Every ${escapeHtml(String(interval))} messages</span>
            </div>
            <div class="charMemory_wizardSummaryRow">
                <span class="label" data-i18n="Vector Storage">Vector Storage</span>
                <span>${vsSummaryHtml}</span>
            </div>
        `);

        // Check for existing memories for the current character
        const targets = getMemoryTargets();
        const $existingSection = $wizard.find('#cm_wiz_existingMemories');
        if (targets.length > 0) {
            const target = targets[0];
            const attachment = findMemoryAttachmentForCharacter(target.avatar, target.fileName);
            if (attachment) {
                $wizard.find('#cm_wiz_existingMemDetail').text(
                    `We found an existing memory file for ${target.name}: ${target.fileName}. The Convert tool can reformat it for better retrieval.`
                );
                $existingSection.show();
            } else {
                $existingSection.hide();
            }
        } else {
            $existingSection.hide();
        }

        // Contextual next-steps guidance
        const wizCharName = getCharacterName();
        const $nextSteps = $wizard.find('#cm_wiz_nextSteps');
        if (wizCharName) {
            $nextSteps.html(`
                <div class="charMemory_wizardCallout">
                    <i class="fa-solid fa-check-circle fa-sm"></i>
                    <span>You're in a chat with <strong>${escapeHtml(wizCharName)}</strong>. After closing, click <strong>Extract Now</strong> in the CharMemory panel to create your first memories.</span>
                </div>
            `);
        } else {
            $nextSteps.html(`
                <div class="charMemory_wizardCallout charMemory_wizardCallout--warn">
                    <i class="fa-solid fa-triangle-exclamation fa-sm"></i>
                    <span><strong>Open a chat first.</strong> CharMemory needs an active character to extract from. Start a chat with a character, then click <strong>Extract Now</strong> in the panel.</span>
                </div>
            `);
        }
    }

    // --- Navigation handlers ---
    $wizard.on('click', '#cm_wiz_next1', function () {
        if (wizConnectionOk) showStep(2);
    });

    $wizard.on('click', '#cm_wiz_back2', function () { showStep(1); });
    $wizard.on('click', '#cm_wiz_next2', function () { showStep(3); });
    $wizard.on('click', '#cm_wiz_back3', function () { showStep(2); });

    $wizard.on('click', '#cm_wiz_convertNow', function () {
        $wizard.find('#cm_wiz_existingMemories').hide();
        reformatMemories();
    });

    $wizard.on('click', '#cm_wiz_convertSkip', function () {
        $wizard.find('#cm_wiz_existingMemories').hide();
    });

    $wizard.on('click', '#cm_wiz_done', function () {
        extension_settings[MODULE_NAME].wizardCompleted = true;
        saveSettingsDebounced();
        // Close the popup by clicking the dialog's close/OK button
        const $dialog = $wizard.closest('.popup');
        if ($dialog.length) {
            $dialog.find('.popup-button-ok, .popup-button-close').first().trigger('click');
        }
        // Open the CharMemory panel and orient the user
        setTimeout(() => {
            if (isTabletMode()) {
                toggleTabletPanel(true);
            } else {
                const $content = $('.charMemory_settings .inline-drawer-content');
                if ($content.length && !$content.is(':visible')) {
                    $('.charMemory_settings .inline-drawer-toggle').trigger('click');
                }
            }
            const doneCharName = getCharacterName();
            if (!doneCharName) {
                toastr.info(t`Open a chat with a character, then click <b>Extract Now</b> to start building memories.`, 'CharMemory', { timeOut: 7000, escapeHtml: false });
            } else {
                toastr.success(t`Click <b>Extract Now</b> in the panel to extract your first memories for ${escapeHtml(doneCharName)}.`, 'CharMemory', { timeOut: 7000, escapeHtml: false });
            }
        }, 400);
    });

    // Cleanup when popup closes
    popup.then(() => {
        $(document).off('click.cmWizModelPicker');
    });

    // Show starting step
    showStep(startStep);
}

/**
 * Show a post-first-extraction verification modal.
 * Explains how to check that retrieval is working correctly.
 */
function showVerificationStep() {
    const html = `<div class="charMemory_verification">
        <h4 data-i18n="Memories Extracted Successfully!">Memories Extracted Successfully!</h4>
        <p data-i18n="Your first batch of memories has been saved. Here's how to verify everything is working:">Your first batch of memories has been saved. Here's how to verify everything is working:</p>
        <ol>
            <li><strong>Generate a message</strong> from your character so Vector Storage injects relevant memories.</li>
            <li>Look for the <i class="fa-solid fa-syringe" style="opacity:0.7;"></i> <strong>syringe icon</strong> next to the character's name. Click it to see what memories were injected.</li>
            <li>Check the <strong>health indicator</strong> (colored dot) on the dashboard. Green means everything is working. Yellow or red means there may be Vector Storage configuration issues.</li>
            <li>Use the <strong>Troubleshooter</strong> (<i class="fa-solid fa-screwdriver-wrench" style="opacity:0.7;"></i>) for detailed diagnostics if anything looks off.</li>
        </ol>
        <p style="opacity:0.7; font-size:0.9em;">This message will only appear once. You can always access the Troubleshooter from the dashboard header.</p>
    </div>`;

    callGenericPopup(html, POPUP_TYPE.TEXT, '', { wide: false, allowVerticalScrolling: true });
    extension_settings[MODULE_NAME].verificationSeen = true;
    saveSettingsDebounced();
}

/**
 * Update the nudge banner visibility based on health status.
 * Called after health checks complete and when the wizard has been completed previously.
 * @param {object} [healthResult] Pre-computed health result to avoid re-running checks
 */
function updateNudgeBanner(healthResult) {
    const $banner = $('#charMemory_nudgeBanner');
    if (!$banner.length) return;

    const s = extension_settings[MODULE_NAME];
    if (!s.wizardCompleted) {
        $banner.hide();
        return;
    }

    if (!healthResult) {
        $banner.hide();
        return;
    }

    if (healthResult.level === 'red' || healthResult.level === 'yellow') {
        const issueCount = healthResult.checks.filter(c => c.level !== 'green').length;
        const label = healthResult.level === 'red' ? 'Issues detected' : 'Warnings detected';
        $banner.find('span').first().text(`${label} (${issueCount})`);
        // Determine which step to open
        const hasConnectionIssue = !s.selectedProvider || !getProviderSettings(s.selectedProvider || '').model;
        $banner.data('wizStep', hasConnectionIssue ? 1 : 2);
        $banner.show();
    } else {
        $banner.hide();
    }
}

// ============ Troubleshooter Modal ============

/**
 * Build and display the Troubleshooter modal.
 * Sections: Health Checks, Data Bank Browser, Diagnostic Report, Reset/Clear.
 * @param {string} [initialSection='health'] Section to show first: 'health', 'databank', 'report', or 'reset'
 */
async function showTroubleshooter(initialSection = 'health') {
    const charName = getCharacterName();
    const targets = getMemoryTargets();
    const target = targets[0];

    // Run health checks
    const healthResult = await computeHealthScore();

    // Build health checks HTML
    const colors = { green: '#4a4', yellow: '#e8a33d', red: '#c44', unknown: 'var(--SmartThemeBorderColor, #555)' };
    const icons = { green: 'fa-circle-check', yellow: 'fa-triangle-exclamation', red: 'fa-circle-xmark', unknown: 'fa-circle-question' };
    const titles = { green: t`All checks passed`, yellow: t`Warnings detected`, red: t`Issues found`, unknown: t`No character selected` };

    let healthHtml = `<div class="charMemory_tsOverallStatus" style="color:${colors[healthResult.level]};">
        <i class="fa-solid ${icons[healthResult.level]}"></i>
        ${titles[healthResult.level]}
    </div>`;

    // Fix hints for checks that have actionable solutions
    const fixHints = {
        vec_files_enabled: t`Enable "Files" in the Vector Storage extension settings.`,
        memory_file_exists: t`Use "Extract Now" on the dashboard to create this character's memory file.`,
        file_vectorized: t`Send a message in the chat to trigger automatic vectorization, or open Extensions → Vector Storage → Files tab to vectorize the file manually.`,
        chunk_overlap: t`Set overlap to 10-25% in Vector Storage settings.`,
        chunk_size: t`Set chunk size to 800-1000 chars in Vector Storage settings.`,
    };

    for (const check of healthResult.checks) {
        const fixHint = (check.level !== 'green' && fixHints[check.id])
            ? `<div class="charMemory_tsCheckFix"><i class="fa-solid fa-lightbulb fa-xs"></i> ${escapeHtml(fixHints[check.id])}</div>`
            : '';
        healthHtml += `<div class="charMemory_tsCheck">
            <div class="charMemory_tsCheckHeader">
                <i class="fa-solid ${icons[check.level]} fa-xs" style="color:${colors[check.level]};"></i>
                <span>${escapeHtml(check.label)}</span>
            </div>
            <div class="charMemory_tsCheckDetail">${escapeHtml(check.detail)}</div>
            ${fixHint}
        </div>`;
    }

    // Build Data Bank browser HTML
    // Supports group chats — renders a labeled section per member.
    const buildMemberFileList = (t) => {
        ensureCharacterAttachments(t.avatar);
        const disabledUrls = new Set(extension_settings.disabled_attachments || []);
        const attachments = (extension_settings.character_attachments[t.avatar] || [])
            .filter(att => !disabledUrls.has(att.url));
        if (attachments.length === 0) {
            return '<div class="charMemory_diagEmpty" style="margin:4px 0 8px;" data-i18n="No Data Bank files yet — run Extract Now to create memories.">No Data Bank files yet — run <b>Extract Now</b> to create memories.</div>';
        }
        let html = '<div class="charMemory_tsFileList">';
        for (const att of attachments) {
            const badge = att.name === t.fileName ? '<span class="charMemory_tsBadge">CharMemory</span>' : '';
            const sizeText = att.size ? `<span class="charMemory_tsFileSize">${(att.size / 1024).toFixed(1)} KB</span>` : '';
            html += `<div class="charMemory_tsFileRow" data-url="${escapeAttr(att.url)}" data-name="${escapeAttr(att.name || '')}" data-avatar="${escapeAttr(t.avatar)}">
                    <div class="charMemory_tsFileName">
                        <i class="fa-solid fa-file-lines fa-sm"></i>
                        <span>${escapeHtml(att.name || att.url)}</span>
                        ${sizeText}
                        ${badge}
                    </div>
                    <div class="charMemory_tsFileActions">
                        <button class="menu_button charMemory_tsViewBtn" title="View file contents" data-i18n="[title]View file contents"><i class="fa-solid fa-eye fa-sm"></i></button>
                        <button class="menu_button charMemory_tsExportBtn" title="Download file" data-i18n="[title]Download file"><i class="fa-solid fa-download fa-sm"></i></button>
                        <button class="menu_button charMemory_tsDeleteBtn" title="Delete file" data-i18n="[title]Delete file"><i class="fa-solid fa-trash fa-sm"></i></button>
                        <button class="menu_button charMemory_tsConvertBtn" title="Convert file format" data-i18n="[title]Convert file format"><i class="fa-solid fa-arrows-rotate fa-sm"></i></button>
                    </div>
                </div>`;
        }
        html += '</div>';
        return html;
    };

    let dataBankHtml = '';
    let dataBankSubtitle = '<span data-i18n="No character selected">No character selected</span>';
    if (!targets.length) {
        dataBankHtml = '<div class="charMemory_diagEmpty" data-i18n="No character selected.">No character selected.</div>';
    } else if (targets.length > 1) {
        // Group chat: labeled section per member
        dataBankSubtitle = `Group Data Bank \u2014 ${targets.length} characters`;
        for (const t of targets) {
            const avatarImg = `<img class="charMemory_groupAvatar" src="/thumbnail?type=avatar&file=${encodeURIComponent(t.avatar)}" alt="" onerror="this.style.display='none'" />`;
            dataBankHtml += `<div class="charMemory_tsMemberSection">
                <div class="charMemory_tsMemberLabel">${avatarImg}${escapeHtml(t.name)}</div>
                ${buildMemberFileList(t)}
            </div>`;
        }
    } else {
        const displayName = charName || target.name;
        const avatarImg = `<img class="charMemory_groupAvatar" src="/thumbnail?type=avatar&file=${encodeURIComponent(target.avatar)}" alt="" onerror="this.style.display='none'" style="vertical-align:middle;" />`;
        dataBankSubtitle = `${avatarImg} ${escapeHtml(displayName)}'s Data Bank files`;
        dataBankHtml = buildMemberFileList(target);
    }

    // Build full modal
    const navActive = (s) => s === initialSection ? ' active' : '';
    const html = `<div class="charMemory_modal charMemory_troubleshooter">
        <div class="charMemory_modalNav">
            <button class="charMemory_modalNavItem${navActive('health')}" data-section="health" data-i18n="Health Checks">Health Checks</button>
            <button class="charMemory_modalNavItem${navActive('databank')}" data-section="databank" data-i18n="Data Bank">Data Bank</button>
            <button class="charMemory_modalNavItem${navActive('report')}" data-section="report" data-i18n="Diagnostic Report">Diagnostic Report</button>
            <button class="charMemory_modalNavItem${navActive('reset')}" data-section="reset" data-i18n="Reset / Clear">Reset / Clear</button>
        </div>
        <div class="charMemory_modalContent">
            <div class="charMemory_modalSection${navActive('health')}" data-section="health">
                <h4 class="charMemory_modalSectionTitle" data-i18n="Health Checks">Health Checks</h4>
                <div id="cm_ts_healthChecks">${healthHtml}</div>
                <div style="margin-top:10px;">
                    <button class="menu_button" id="cm_ts_rerunHealth"><i class="fa-solid fa-arrows-rotate fa-sm"></i> <span data-i18n="Re-run checks">Re-run checks</span></button>
                </div>
            </div>
            <div class="charMemory_modalSection${navActive('databank')}" data-section="databank">
                <h4 class="charMemory_modalSectionTitle" data-i18n="Data Bank Browser">Data Bank Browser</h4>
                <small class="charMemory_helperText">${dataBankSubtitle}</small>
                <div id="cm_ts_dataBankList">${dataBankHtml}</div>
                <div class="charMemory_tsImportRow">
                    <input type="file" id="cm_ts_fileImport" style="display:none;" accept=".md,.txt,.json" />
                    <button class="menu_button" id="cm_ts_importBtn"><i class="fa-solid fa-upload fa-sm"></i> <span data-i18n="Import file">Import file</span></button>
                </div>
            </div>
            <div class="charMemory_modalSection${navActive('report')}" data-section="report">
                <h4 class="charMemory_modalSectionTitle" data-i18n="Diagnostic Report">Diagnostic Report</h4>
                <small class="charMemory_helperText" data-i18n="Full snapshot of settings, health checks, and memory state for debugging.">Full snapshot of settings, health checks, and memory state for debugging.</small>
                <pre id="cm_ts_reportContent" class="charMemory_reportPre">Generating\u2026</pre>
                <div class="charMemory_reportActions">
                    <button class="menu_button" id="cm_ts_copyReport"><i class="fa-solid fa-clipboard fa-sm"></i> <span data-i18n="Copy">Copy</span></button>
                    <input type="text" id="cm_ts_reportFilename" class="text_pole charMemory_reportFilename" value="charMemory-diagnostic.txt" placeholder="filename.txt" />
                    <button class="menu_button" id="cm_ts_saveReport"><i class="fa-solid fa-download fa-sm"></i> <span data-i18n="Save">Save</span></button>
                </div>
                <small id="cm_ts_reportStatus" class="charMemory_helperText" style="display:none;margin-top:4px;"></small>
            </div>
            <div class="charMemory_modalSection${navActive('reset')}" data-section="reset">
                <h4 class="charMemory_modalSectionTitle" data-i18n="Reset / Clear">Reset / Clear</h4>
                <div class="charMemory_tsResetSection">
                    <button class="menu_button" id="cm_ts_openWizard" data-i18n="Re-run Setup Wizard">Re-run Setup Wizard</button>
                    <small class="charMemory_helperText" data-i18n="Walk through the setup steps again to reconfigure your LLM connection, storage, or retrieval settings.">Walk through the setup steps again to reconfigure your LLM connection, storage, or retrieval settings.</small>
                </div>
                <div class="charMemory_tsResetSection">
                    <button class="menu_button" id="cm_ts_resetThisChat" data-i18n="Reset This Chat">Reset This Chat</button>
                    <small class="charMemory_helperText">
                        Resets the extraction pointer for the active chat. Next "Extract Now" will re-read all messages in this chat from the first.
                        ${isGroupChat() ? '<br><i class="fa-solid fa-people-group fa-xs"></i> <em>Group chat:</em> all members share one extraction pointer, so this resets all of them at once.' : ''}
                    </small>
                </div>
                <div class="charMemory_tsResetSection">
                    <button class="menu_button" id="cm_ts_markFullyExtracted" data-i18n="Mark as Fully Extracted">Mark as Fully Extracted</button>
                    <small class="charMemory_helperText" data-i18n="Tells CharMemory this chat's messages are already captured in the memory file. Useful after importing an existing memory file into a forked chat — prevents full re-extraction.">Tells CharMemory this chat's messages are already captured in the memory file. Useful after importing an existing memory file into a forked chat — prevents full re-extraction.</small>
                </div>
                <div class="charMemory_tsResetSection">
                    <button class="menu_button" id="cm_ts_resetBatchProgress" data-i18n="Reset Batch Progress">Reset Batch Progress</button>
                    <small class="charMemory_helperText">
                        The Batch tool remembers the last message it processed in each chat file so future runs only extract new messages. Reset this to make Batch treat all of ${escapeHtml(charName || 'this character')}'s chats as unprocessed — for example, after changing the extraction prompt. Does not affect Extract Now or auto-extraction.
                    </small>
                </div>
                <div class="charMemory_tsResetSection">
                    <button class="menu_button" id="cm_ts_unhideExtracted" data-i18n="Unhide Extracted Messages">Unhide Extracted Messages</button>
                    <small class="charMemory_helperText" data-i18n="Restores all messages that CharMemory hid after extraction. Makes them visible to the main LLM again and removes extraction tags.">Restores all messages that CharMemory hid after extraction. Makes them visible to the main LLM again and removes extraction tags.</small>
                </div>
                <div class="charMemory_tsResetSection">
                    <button class="menu_button charMemory_dangerBtn" id="cm_ts_clearMemories" data-i18n="Clear All Memories">Clear All Memories</button>
                    <small class="charMemory_helperText" data-i18n="Deletes this character's memory file (contains memories from all their chats) and resets extraction tracking. Cannot be undone.">Deletes this character's memory file (contains memories from all their chats) and resets extraction tracking. Cannot be undone.</small>
                </div>
            </div>
        </div>
    </div>`;

    let autoRefreshInterval;
    const popup = callGenericPopup(html, POPUP_TYPE.TEXT, '', { wide: true, allowVerticalScrolling: true });
    popup.then(() => { clearInterval(autoRefreshInterval); updateHealthIndicator(); });

    // Wire nav switching
    const $modal = $('.charMemory_troubleshooter').last();
    $modal.on('click', '.charMemory_modalNavItem', function () {
        const section = $(this).data('section');
        $modal.find('.charMemory_modalNavItem').removeClass('active');
        $(this).addClass('active');
        $modal.find('.charMemory_modalSection').removeClass('active');
        $modal.find(`.charMemory_modalSection[data-section="${section}"]`).addClass('active');
        if (section === 'databank') rebuildDataBankList();
    });

    // Re-run health checks
    $('#cm_ts_rerunHealth').off('click').on('click', async function () {
        $(this).prop('disabled', true).find('i').addClass('fa-spin');
        try {
            const result = await computeHealthScore();
            let newHtml = `<div class="charMemory_tsOverallStatus" style="color:${colors[result.level]};">
                <i class="fa-solid ${icons[result.level]}"></i>
                ${titles[result.level]}
            </div>`;
            for (const check of result.checks) {
                const fixHint = (check.level !== 'green' && fixHints[check.id])
                    ? `<div class="charMemory_tsCheckFix"><i class="fa-solid fa-lightbulb fa-xs"></i> ${escapeHtml(fixHints[check.id])}</div>`
                    : '';
                newHtml += `<div class="charMemory_tsCheck">
                    <div class="charMemory_tsCheckHeader">
                        <i class="fa-solid ${icons[check.level]} fa-xs" style="color:${colors[check.level]};"></i>
                        <span>${escapeHtml(check.label)}</span>
                    </div>
                    <div class="charMemory_tsCheckDetail">${escapeHtml(check.detail)}</div>
                    ${fixHint}
                </div>`;
            }
            $('#cm_ts_healthChecks').html(newHtml);
            // Also sync the sidebar health indicator and nudge banner in real time
            renderHealthStatusBarItem(result);
            updateNudgeBanner(result);
        } finally {
            $(this).prop('disabled', false).find('i').removeClass('fa-spin');
        }
    });

    // Data Bank: View / Edit file (editor-based)
    $modal.on('click', '.charMemory_tsViewBtn', async function () {
        const $row = $(this).closest('.charMemory_tsFileRow');
        const url = $row.data('url');
        const name = $row.data('name') || '';
        const avatar = $row.data('avatar') || '';
        try {
            const content = await getFileAttachment(url);
            if (!content) {
                toastr.warning(t`File is empty or could not be read.`, 'CharMemory');
                return;
            }

            const blocks = parseMemories(content);

            if (blocks.length === 0) {
                // Non-memory file or empty — show as plain text (read-only)
                const displayContent = content.length > 10000
                    ? content.substring(0, 10000) + '\n\n... (truncated, ' + content.length + ' chars total)'
                    : content;
                const viewHtml = `<div style="max-height:60vh;overflow:auto;text-align:left;">
                    <pre style="white-space:pre-wrap;word-break:break-word;font-size:0.85em;">${escapeHtml(displayContent)}</pre>
                </div>`;
                callGenericPopup(viewHtml, POPUP_TYPE.TEXT, escapeHtml(name || t`File contents`), { wide: true, allowVerticalScrolling: true });
                return;
            }

            // Memory file — open in editor
            const tsEditor = createMemoryEditor({ blocks });
            const emptyEditingSet = tsEditor.getEditingSet();
            let tsFindPattern = null;

            const refreshTsEditor = (highlightPattern) => {
                if (highlightPattern !== undefined) tsFindPattern = highlightPattern;
                const currentBlocks = tsEditor.getBlocks();
                const editing = tsEditor.getEditingSet();
                $('#cm_ts_fileEditorPane').html(renderConsolidatedCards(currentBlocks, editing, tsFindPattern));
                $('#cm_ts_fileEditorCount').text(`${countMemories(currentBlocks)} memories in ${currentBlocks.length} blocks`);
                $('#cm_ts_fileEditorAddBlock').toggleClass('charMemory_editorAddBlock--hidden', editing.size === 0);
                $('#cm_ts_fileUndoBtn').prop('disabled', !tsEditor.canUndo());
            };

            const editorHtml = `<div class="charMemory_tsFileEditor">
                <div class="charMemory_tsFileEditorHeader">
                    <span class="charMemory_dimText">${escapeHtml(name)}</span>
                    <span id="cm_ts_fileEditorCount" class="charMemory_dimText">${countMemories(blocks)} memories in ${blocks.length} blocks</span>
                </div>
                ${buildFindReplaceBar('cm_ts_fileFR')}
                <div class="charMemory_consolidationContent" id="cm_ts_fileEditorPane">${renderConsolidatedCards(blocks, emptyEditingSet)}</div>
                <div class="charMemory_tsFileEditorFooter">
                    <button class="charMemory_editorAddBlock menu_button charMemory_editorAddBlock--hidden" id="cm_ts_fileEditorAddBlock"><i class="fa-solid fa-plus fa-xs"></i> <span data-i18n="Add Block">Add Block</span></button>
                    <button class="menu_button" id="cm_ts_fileUndoBtn" disabled><i class="fa-solid fa-rotate-left fa-xs"></i> <span data-i18n="Undo">Undo</span></button>
                </div>
            </div>`;

            const savePopup = callGenericPopup(editorHtml, POPUP_TYPE.CONFIRM, '', { wide: true, allowVerticalScrolling: true, okButton: t`Save`, cancelButton: t`Cancel` });

            // Find/Replace bar
            const cleanupTsFR = wireFindReplaceEvents(tsEditor, refreshTsEditor, 'cm_ts_fileFR', '.charMemoryTsFR');

            // Editor event delegation (ts-namespaced to avoid conflicts)
            $(document).off('click.charMemoryTsEditorToggle').on('click.charMemoryTsEditorToggle', '#cm_ts_fileEditorPane .charMemory_editorToggleEdit', function () {
                tsEditor.toggleEdit(Number($(this).data('block')));
                refreshTsEditor();
            });

            $(document).off('input.charMemoryTsEditorBullet').on('input.charMemoryTsEditorBullet', '#cm_ts_fileEditorPane .charMemory_editorBulletInput', function () {
                tsEditor.updateBullet(Number($(this).data('block')), Number($(this).data('bullet')), $(this).val());
            });

            $(document).off('input.charMemoryTsEditorTheme').on('input.charMemoryTsEditorTheme', '#cm_ts_fileEditorPane .charMemory_editorThemeInput', function () {
                tsEditor.updateTheme(Number($(this).data('block')), $(this).val());
            });

            $(document).off('click.charMemoryTsEditorDelBullet').on('click.charMemoryTsEditorDelBullet', '#cm_ts_fileEditorPane .charMemory_editorDeleteBullet', function () {
                tsEditor.deleteBullet(Number($(this).data('block')), Number($(this).data('bullet')));
                refreshTsEditor();
            });

            $(document).off('click.charMemoryTsEditorDelBlock').on('click.charMemoryTsEditorDelBlock', '#cm_ts_fileEditorPane .charMemory_editorDeleteBlock', function () {
                tsEditor.deleteBlock(Number($(this).data('block')));
                refreshTsEditor();
            });

            $(document).off('click.charMemoryTsEditorAddBullet').on('click.charMemoryTsEditorAddBullet', '#cm_ts_fileEditorPane .charMemory_editorAddBullet', function () {
                const bi = Number($(this).data('block'));
                tsEditor.addBullet(bi);
                refreshTsEditor();
                $(`#cm_ts_fileEditorPane .charMemory_editorCard[data-block="${bi}"] .charMemory_editorBulletInput:last`).focus();
            });

            $(document).off('click.charMemoryTsEditorAddBlock').on('click.charMemoryTsEditorAddBlock', '#cm_ts_fileEditorAddBlock', function () {
                tsEditor.addBlock();
                refreshTsEditor();
                $('#cm_ts_fileEditorPane .charMemory_editorCard:last .charMemory_editorBulletInput:last').focus();
            });

            $(document).off('click.charMemoryTsEditorUndo').on('click.charMemoryTsEditorUndo', '#cm_ts_fileUndoBtn', function () {
                if (tsEditor.undo()) refreshTsEditor();
            });

            // Wait for Save/Cancel
            const confirmed = await savePopup;

            // Clean up event handlers
            cleanupTsFR();
            $(document).off('click.charMemoryTsEditorToggle click.charMemoryTsEditorDelBullet click.charMemoryTsEditorDelBlock click.charMemoryTsEditorAddBullet click.charMemoryTsEditorAddBlock click.charMemoryTsEditorUndo');
            $(document).off('input.charMemoryTsEditorBullet input.charMemoryTsEditorTheme');

            if (confirmed && avatar) {
                const cleanBlocks = tsEditor.getBlocks()
                    .map(b => ({ ...b, bullets: b.bullets.filter(bullet => bullet.trim() !== '') }))
                    .filter(b => b.bullets.length > 0);

                if (cleanBlocks.length === 0) {
                    toastr.warning(t`No memories to save.`, 'CharMemory');
                } else {
                    await writeMemoriesForCharacter(serializeMemories(cleanBlocks), avatar, name);
                    toastr.success(t`Saved ${countMemories(cleanBlocks)} memories to ${name}.`, 'CharMemory');
                    updateStatusDisplay();
                }
            }
        } catch (err) {
            console.error(LOG_PREFIX, 'Failed to read file:', err);
            toastr.error(t`Could not read file.`, 'CharMemory');
        }
    });

    // Data Bank: Export file
    $modal.on('click', '.charMemory_tsExportBtn', async function () {
        const $row = $(this).closest('.charMemory_tsFileRow');
        const url = $row.data('url');
        const name = $row.data('name') || 'download.txt';
        try {
            const content = await getFileAttachment(url);
            if (!content) {
                toastr.warning(t`File is empty or could not be read.`, 'CharMemory');
                return;
            }
            const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = name;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(a.href);
            toastr.success(t`Downloaded: ${name}`, 'CharMemory');
        } catch (err) {
            console.error(LOG_PREFIX, 'Failed to export file:', err);
            toastr.error(t`Could not export file.`, 'CharMemory');
        }
    });

    // Data Bank: Delete file
    $modal.on('click', '.charMemory_tsDeleteBtn', async function () {
        const $row = $(this).closest('.charMemory_tsFileRow');
        const url = $row.data('url');
        const name = $row.data('name') || url;
        const confirmed = await callGenericPopup(
            t`Delete "${escapeHtml(name)}" from the Data Bank?\n\nThis cannot be undone.`,
            POPUP_TYPE.CONFIRM,
        );
        if (!confirmed) return;
        try {
            const avatar = $row.data('avatar') || target?.avatar;
            if (!avatar) return;
            await deleteFileFromServer(url, true);
            ensureCharacterAttachments(avatar);
            extension_settings.character_attachments[avatar] =
                (extension_settings.character_attachments[avatar] || []).filter(a => a.url !== url);
            saveSettingsDebounced();
            $row.fadeOut(200, () => $row.remove());
            toastr.success(t`Deleted: ${name}`, 'CharMemory');
            updateStatusDisplay();
        } catch (err) {
            console.error(LOG_PREFIX, 'Failed to delete file:', err);
            toastr.error(t`Could not delete file.`, 'CharMemory');
        }
    });

    // Data Bank: Convert file — open conversion preview directly
    $modal.on('click', '.charMemory_tsConvertBtn', function () {
        const $row = $(this).closest('.charMemory_tsFileRow');
        const url = $row.data('url');
        previewConversion(url);
    });

    // Data Bank: Import file
    $('#cm_ts_importBtn').off('click').on('click', function () {
        $('#cm_ts_fileImport').click();
    });
    $('#cm_ts_fileImport').off('change').on('change', async function () {
        const file = this.files?.[0];
        if (!file) return;
        const avatar = target?.avatar;
        if (!avatar) {
            toastr.warning(t`No character selected.`, 'CharMemory');
            return;
        }
        try {
            const text = await file.text();
            const base64 = convertTextToBase64(text);
            const slug = getStringHash(file.name);
            const uniqueName = `${Date.now()}_${slug}.txt`;
            const fileUrl = await uploadFileAttachment(uniqueName, base64);
            if (!fileUrl) throw new Error('Upload returned no URL');
            ensureCharacterAttachments(avatar);
            extension_settings.character_attachments[avatar].push({
                url: fileUrl,
                size: text.length,
                name: file.name,
                created: Date.now(),
            });
            saveSettingsDebounced();
            toastr.success(t`Imported: ${file.name}`, 'CharMemory');
            // Append new file row to the Data Bank list
            const sizeText = `<span class="charMemory_tsFileSize">${(text.length / 1024).toFixed(1)} KB</span>`;
            const newRow = `<div class="charMemory_tsFileRow" data-url="${escapeAttr(fileUrl)}" data-name="${escapeAttr(file.name)}">
                <div class="charMemory_tsFileName">
                    <i class="fa-solid fa-file-lines fa-sm"></i>
                    <span>${escapeHtml(file.name)}</span>
                    ${sizeText}
                </div>
                <div class="charMemory_tsFileActions">
                    <button class="menu_button charMemory_tsViewBtn" title="View file contents"><i class="fa-solid fa-eye fa-sm"></i></button>
                    <button class="menu_button charMemory_tsExportBtn" title="Download file"><i class="fa-solid fa-download fa-sm"></i></button>
                    <button class="menu_button charMemory_tsDeleteBtn" title="Delete file"><i class="fa-solid fa-trash fa-sm"></i></button>
                    <button class="menu_button charMemory_tsConvertBtn" title="Convert file format"><i class="fa-solid fa-arrows-rotate fa-sm"></i></button>
                </div>
            </div>`;
            let $list = $('#cm_ts_dataBankList .charMemory_tsFileList');
            if (!$list.length) {
                // First file — replace empty-state and create the list
                $('#cm_ts_dataBankList .charMemory_diagEmpty').remove();
                $('#cm_ts_dataBankList').prepend('<div class="charMemory_tsFileList"></div>');
                $list = $('#cm_ts_dataBankList .charMemory_tsFileList');
            }
            $list.append(newRow);
        } catch (err) {
            console.error(LOG_PREFIX, 'Failed to import file:', err);
            toastr.error(t`Could not import file.`, 'CharMemory');
        }
        // Reset input so the same file can be re-imported
        $(this).val('');
    });

    // Diagnostic Report: populate pre box on open
    buildDiagnosticReport().then(report => {
        $('#cm_ts_reportContent').text(report);
    }).catch(err => {
        $('#cm_ts_reportContent').text('Failed to generate report: ' + err.message);
    });

    // Diagnostic Report: copy to clipboard
    $('#cm_ts_copyReport').off('click').on('click', async function () {
        try {
            await navigator.clipboard.writeText($('#cm_ts_reportContent').text());
            const $status = $('#cm_ts_reportStatus');
            $status.text(t`Copied!`).show();
            setTimeout(() => $status.fadeOut(300), 2000);
        } catch (err) {
            console.error(LOG_PREFIX, 'Failed to copy report:', err);
            toastr.error(t`Could not copy report to clipboard.`, 'CharMemory');
        }
    });

    // Diagnostic Report: save to file
    $('#cm_ts_saveReport').off('click').on('click', function () {
        const report = $('#cm_ts_reportContent').text();
        const filename = ($('#cm_ts_reportFilename').val() || '').trim() || 'charMemory-diagnostic.txt';
        const blob = new Blob([report], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
    });

    // Re-run Setup Wizard
    $('#cm_ts_openWizard').off('click').on('click', function () {
        $modal.closest('.popup').find('.popup-button-ok, .popup-button-close').first().trigger('click');
        setTimeout(() => showSetupWizard(1), 200);
    });

    // Reset / Clear actions (with confirmation dialogs)
    $('#cm_ts_resetThisChat').off('click').on('click', async function () {
        const charName = getCharacterName() || t`this character`;
        const isGroup = isGroupChat();
        const scopeNote = isGroup
            ? `<br><small>${t`This is a group chat — all members share one extraction pointer and will all be reset together.`}</small>`
            : '';
        const confirmed = await callGenericPopup(
            t`The extraction pointer for the active chat will be reset for <strong>${escapeHtml(charName)}</strong>. Next "Extract Now" will re-read all messages in this chat from the first.${scopeNote}`,
            POPUP_TYPE.CONFIRM, t`Reset This Chat`,
        );
        if (!confirmed) return;
        resetCurrentChatTracking();
    });

    $('#cm_ts_markFullyExtracted').off('click').on('click', async function () {
        const charName = getCharacterName() || t`this character`;
        const context = getContext();
        const chatLen = context.chat ? context.chat.length : 0;
        if (chatLen === 0) {
            toastr.info(t`No messages in this chat to mark as extracted.`, 'CharMemory');
            return;
        }
        const confirmed = await callGenericPopup(
            t`This will mark all ${chatLen} messages in the active chat for <strong>${escapeHtml(charName)}</strong> as already extracted. Auto-extraction will only process new messages added after this point. Use this if you imported an existing memory file and don't want to re-extract.`,
            POPUP_TYPE.CONFIRM, t`Mark as Fully Extracted`,
        );
        if (!confirmed) return;
        markChatAsFullyExtracted();
    });

    $('#cm_ts_resetBatchProgress').off('click').on('click', async function () {
        const charName = getCharacterName() || t`this character`;
        const confirmed = await callGenericPopup(
            t`The Batch tool's record of which messages it has already processed will be cleared for all of <strong>${escapeHtml(charName)}</strong>'s chats. The next Batch run will re-read every message from the start, which may create duplicate memories unless you clear existing memories first. Extract Now and auto-extraction are not affected.`,
            POPUP_TYPE.CONFIRM, t`Reset Batch Progress`,
        );
        if (!confirmed) return;
        resetBatchProgress();
    });
    $('#cm_ts_unhideExtracted').off('click').on('click', async function () {
        const context = getContext();
        const chat = context.chat;
        if (!chat || chat.length === 0) {
            toastr.info(t`No chat loaded.`, 'CharMemory');
            return;
        }

        let count = 0;
        for (let i = 0; i < chat.length; i++) {
            if (chat[i].extra?.charMemory_extracted) {
                chat[i].is_system = false;
                delete chat[i].extra.charMemory_extracted;
                $(`.mes[mesid="${i}"]`).attr('is_system', 'false');
                count++;
            }
        }

        if (count === 0) {
            toastr.info(t`No hidden extracted messages found.`, 'CharMemory');
            return;
        }

        await context.saveChat();
        updateStatusDisplay();
        toastr.success(t`Unhid ${count} message(s).`, 'CharMemory');
        logActivity(`Unhid ${count} extracted message(s)`, 'success');
    });
    $('#cm_ts_clearMemories').off('click').on('click', async function () {
        const charName = getCharacterName() || t`this character`;
        const s = extension_settings[MODULE_NAME];
        const scopeNote = s.perChat
            ? t`This will delete memories for the current chat only.`
            : t`This includes memories from all of ${escapeHtml(charName)}'s chats.`;
        const confirmed = await callGenericPopup(
            t`<strong>${escapeHtml(charName)}'s</strong> memory file will be deleted and extraction tracking will be reset. This cannot be undone.<br><br>${scopeNote}`,
            POPUP_TYPE.CONFIRM, t`Clear All Memories`,
        );
        if (!confirmed) return;
        await clearAllMemories();
    });

    // Auto-refresh the Data Bank file list every 2s while the databank section is active.
    // Targets are recomputed each tick so the list updates if the character context changes
    // after the modal was opened (e.g. chat loaded after the troubleshooter was opened).
    const rebuildDataBankList = () => {
        if (!$modal.find('.charMemory_modalSection[data-section="databank"]').hasClass('active')) return;
        const currentTargets = getMemoryTargets();
        let newHtml = '';
        if (!currentTargets.length) {
            newHtml = '<div class="charMemory_diagEmpty">No character selected.</div>';
        } else if (currentTargets.length > 1) {
            for (const t of currentTargets) {
                const avatarImg = `<img class="charMemory_groupAvatar" src="/thumbnail?type=avatar&file=${encodeURIComponent(t.avatar)}" alt="" onerror="this.style.display='none'" />`;
                newHtml += `<div class="charMemory_tsMemberSection">
                    <div class="charMemory_tsMemberLabel">${avatarImg}${escapeHtml(t.name)}</div>
                    ${buildMemberFileList(t)}
                </div>`;
            }
        } else {
            newHtml = buildMemberFileList(currentTargets[0]);
        }
        const $list = $('#cm_ts_dataBankList');
        if ($list.html() !== newHtml) $list.html(newHtml);
    };
    rebuildDataBankList(); // Populate immediately so initial render reflects current state
    autoRefreshInterval = setInterval(rebuildDataBankList, 2000);

    return popup;
}

/**
 * Build a text diagnostic report for clipboard sharing.
 * Gathers settings, health checks, activity log, memory count,
 * VS configuration, last injection data, and version info.
 * @returns {Promise<string>}
 */
async function buildDiagnosticReport() {
    const s = extension_settings[MODULE_NAME];
    const targets = getMemoryTargets();
    const target = targets[0];
    const charName = getCharacterName() || '(none)';
    const vecSettings = extension_settings.vectors || {};

    // Health checks
    const healthResult = await computeHealthScore();
    const healthLines = healthResult.checks.map(c =>
        `  [${c.level.toUpperCase()}] ${c.label}: ${c.detail}`
    ).join('\n');

    // Memory count
    let memoryInfo = t`No memory file`;
    if (target) {
        const attachment = findMemoryAttachmentForCharacter(target.avatar, target.fileName);
        if (attachment) {
            try {
                const content = await getFileAttachment(attachment.url);
                const blocks = parseMemories(content || '');
                const count = countMemories(blocks);
                memoryInfo = t`${count} memories in ${blocks.length} blocks (file: ${target.fileName})`;
            } catch {
                memoryInfo = t`File exists but could not be read (${target.fileName})`;
            }
        } else {
            memoryInfo = t`No file found (expected: ${target.fileName})`;
        }
    }

    // Last injection
    const dbPrompt = lastDiagnostics.extensionPrompts?.['4_vectors_data_bank'];
    let injectionInfo = t`No injection data captured`;
    if (dbPrompt?.content) {
        const bullets = dbPrompt.content.split('\n')
            .map(l => l.trim()).filter(l => l.startsWith('- ')).length;
        injectionInfo = t`${bullets} memories injected (${dbPrompt.content.length} chars total)`;
    }

    // Activity log (last 10)
    const logLines = activityLog.slice(0, 10).map(e =>
        `  [${e.timestamp}] ${e.type}: ${e.message.split('\n')[0]}`
    ).join('\n');

    const yes = t`Yes`;
    const no = t`No`;

    const report = `=== ${t`CharMemory Diagnostic Report`} ===
${t`Generated`}: ${new Date().toISOString()}
${t`Version`}: ${MODULE_VERSION}

--- ${t`Character`} ---
${t`Name`}: ${charName}
${t`Group chat`}: ${isGroupChat() ? yes + ' (' + targets.length + ' ' + t`members found` + ')' : no}
${(() => {
    if (!isGroupChat()) return '';
    const context = getContext();
    const group = context.groups?.find(g => g.id === context.groupId);
    if (!group) {
        return `\n--- Group Debug ---\nGroup ID: ${context.groupId}\nGroups loaded: ${context.groups?.length ?? 0}\nAvailable IDs: ${context.groups?.map(g => g.id).join(', ') || '(none)'}\n`;
    }
    const activeAvatars = (group.members || []).filter(a => !group.disabled_members?.includes(a));
    const resolved = activeAvatars.filter(a => characters.findIndex(c => c.avatar === a) >= 0);
    const unresolved = activeAvatars.filter(a => characters.findIndex(c => c.avatar === a) < 0);
    let out = `\n--- Group Debug ---\nGroup name: ${group.name}\nGeneration mode: ${group.generation_mode ?? 0}\nTotal members: ${group.members?.length ?? 0}, disabled: ${group.disabled_members?.length ?? 0}, active: ${activeAvatars.length}\nResolved: ${resolved.length}, unresolved: ${unresolved.length}\nCharacters loaded: ${characters.length}`;
    if (unresolved.length > 0) out += `\nUnresolved avatars: ${unresolved.join(', ')}`;
    return out + '\n';
})()}
--- ${t`Settings`} ---
${t`Source`}: ${s.source || 'provider'}
${t`Provider`}: ${s.selectedProvider || '(none)'}
${t`Interval`}: ${s.interval}
${t`Chunk size`}: ${s.maxMessagesPerExtraction}
${t`Response length`}: ${s.responseLength}
${t`Per-chat`}: ${s.perChat ? yes : no}

--- ${t`Memories`} ---
${memoryInfo}

--- ${t`Health Checks`} (${healthResult.level}) ---
${healthLines || '  ' + t`No checks run`}

--- ${t`Vector Storage`} ---
${t`Enabled (files)`}: ${vecSettings.enabled_files ? yes : no}
${t`Chunk size`}: ${vecSettings.chunk_size_db ?? t`default`}
${t`Overlap`}: ${vecSettings.overlap_percent_db ?? 0}%
${t`Retrieve chunks`}: ${vecSettings.chunk_count_db ?? t`default`}
${t`Score threshold`}: ${vecSettings.score_threshold ?? t`not set`}

--- ${t`Last Injection`} ---
${injectionInfo}
${t`Timestamp`}: ${lastDiagnostics.timestamp || t`none`}

--- ${t`Recent Activity`} (${t`last 10`}) ---
${logLines || '  ' + t`No activity logged`}
`;
    return report;
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
        callGenericPopup(t`No character selected.`, POPUP_TYPE.TEXT);
        return;
    }

    // For group chats, show a character picker first
    let target;
    if (targets.length === 1) {
        target = targets[0];
    } else {
        // Load counts for the picker labels
        const targetData = await Promise.all(targets.map(async (t) => {
            const content = await readMemoriesForCharacter(t.avatar, t.fileName);
            const blocks = parseMemories(content || '');
            const count = blocks.reduce((sum, b) => sum + b.bullets.length, 0);
            return { ...t, count };
        }));
        const pickerHtml = targetData.map((tgt, i) =>
            `<label class="checkbox_label"><input type="radio" name="charMemory_mmTarget" value="${i}" ${i === 0 ? 'checked' : ''} /> ${escapeHtml(tgt.name)} <small style="opacity:0.5;">(${tgt.count} memories)</small></label>`,
        ).join('<br>');
        let selectedIdx = 0;
        $(document).on('change.mmPicker', 'input[name="charMemory_mmTarget"]', function () {
            selectedIdx = Number($(this).val()) || 0;
        });
        const picked = await callGenericPopup(t`Select a character to view/edit memories for:<br><br>${pickerHtml}`, POPUP_TYPE.CONFIRM);
        $(document).off('change.mmPicker');
        if (!picked) return;
        target = targets[selectedIdx];
    }

    const content = await readMemoriesForCharacter(target.avatar, target.fileName);
    const blocks = parseMemories(content || '');

    if (blocks.length === 0) {
        callGenericPopup(t`No memories yet.`, POPUP_TYPE.TEXT);
        return;
    }

    const memCount = countMemories(blocks);
    const editor = createMemoryEditor({ blocks });
    let mmFindPattern = null;

    const refreshEditor = (highlightPattern) => {
        if (highlightPattern !== undefined) mmFindPattern = highlightPattern;
        const currentBlocks = editor.getBlocks();
        const editing = editor.getEditingSet();
        $('#charMemory_mmEditorPane').html(renderConsolidatedCards(currentBlocks, editing, mmFindPattern));
        $('#charMemory_mmCount').text(`${countMemories(currentBlocks)} memories in ${currentBlocks.length} blocks`);
        $('#charMemory_mmAddBlock').toggleClass('charMemory_editorAddBlock--hidden', editing.size === 0);
        $('#charMemory_mmUndoBtn').prop('disabled', !editor.canUndo());
    };

    const editorHtml = `<div class="charMemory_manager">
        <div class="charMemory_tsFileEditorHeader">
            <span class="charMemory_dimText">${escapeHtml(target.name)}</span>
            <span id="charMemory_mmCount" class="charMemory_dimText">${memCount} memories in ${blocks.length} blocks</span>
        </div>
        ${buildFindReplaceBar('charMemory_mmFR')}
        <div class="charMemory_consolidationContent" id="charMemory_mmEditorPane">${renderConsolidatedCards(blocks, editor.getEditingSet())}</div>
        <div class="charMemory_tsFileEditorFooter">
            <button class="charMemory_editorAddBlock menu_button charMemory_editorAddBlock--hidden" id="charMemory_mmAddBlock"><i class="fa-solid fa-plus fa-xs"></i> <span data-i18n="Add Block">Add Block</span></button>
            <button class="menu_button" id="charMemory_mmUndoBtn" disabled><i class="fa-solid fa-rotate-left fa-xs"></i> <span data-i18n="Undo">Undo</span></button>
        </div>
    </div>`;

    const popup = callGenericPopup(editorHtml, POPUP_TYPE.CONFIRM, '', { wide: true, allowVerticalScrolling: true, okButton: t`Save`, cancelButton: t`Cancel` });

    // Find/Replace bar
    const cleanupMmFR = wireFindReplaceEvents(editor, refreshEditor, 'charMemory_mmFR', '.charMemoryMmFR');

    // Editor event delegation
    $(document).off('click.charMemoryMmToggle').on('click.charMemoryMmToggle', '#charMemory_mmEditorPane .charMemory_editorToggleEdit', function () {
        editor.toggleEdit(Number($(this).data('block')));
        refreshEditor();
    });

    $(document).off('input.charMemoryMmBullet').on('input.charMemoryMmBullet', '#charMemory_mmEditorPane .charMemory_editorBulletInput', function () {
        editor.updateBullet(Number($(this).data('block')), Number($(this).data('bullet')), $(this).val());
    });

    $(document).off('input.charMemoryMmTheme').on('input.charMemoryMmTheme', '#charMemory_mmEditorPane .charMemory_editorThemeInput', function () {
        editor.updateTheme(Number($(this).data('block')), $(this).val());
    });

    $(document).off('click.charMemoryMmDelBullet').on('click.charMemoryMmDelBullet', '#charMemory_mmEditorPane .charMemory_editorDeleteBullet', function () {
        editor.deleteBullet(Number($(this).data('block')), Number($(this).data('bullet')));
        refreshEditor();
    });

    $(document).off('click.charMemoryMmDelBlock').on('click.charMemoryMmDelBlock', '#charMemory_mmEditorPane .charMemory_editorDeleteBlock', function () {
        editor.deleteBlock(Number($(this).data('block')));
        refreshEditor();
    });

    $(document).off('click.charMemoryMmAddBullet').on('click.charMemoryMmAddBullet', '#charMemory_mmEditorPane .charMemory_editorAddBullet', function () {
        const bi = Number($(this).data('block'));
        editor.addBullet(bi);
        refreshEditor();
        $(`#charMemory_mmEditorPane .charMemory_editorCard[data-block="${bi}"] .charMemory_editorBulletInput:last`).focus();
    });

    $(document).off('click.charMemoryMmAddBlock').on('click.charMemoryMmAddBlock', '#charMemory_mmAddBlock', function () {
        editor.addBlock();
        refreshEditor();
        $('#charMemory_mmEditorPane .charMemory_editorCard:last .charMemory_editorBulletInput:last').focus();
    });

    $(document).off('click.charMemoryMmUndo').on('click.charMemoryMmUndo', '#charMemory_mmUndoBtn', function () {
        if (editor.undo()) refreshEditor();
    });

    // Wait for Save/Cancel
    const confirmed = await popup;

    // Clean up
    cleanupMmFR();
    $(document).off('click.charMemoryMmToggle click.charMemoryMmDelBullet click.charMemoryMmDelBlock click.charMemoryMmAddBullet click.charMemoryMmAddBlock click.charMemoryMmUndo');
    $(document).off('input.charMemoryMmBullet input.charMemoryMmTheme');

    if (!confirmed) return;

    // Filter out empty bullets and empty blocks before saving
    const cleanBlocks = editor.getBlocks()
        .map(b => ({ ...b, bullets: b.bullets.filter(bullet => bullet.trim() !== '') }))
        .filter(b => b.bullets.length > 0);

    if (cleanBlocks.length === 0) {
        toastr.warning(t`No memories to save.`, 'CharMemory');
        return;
    }

    await writeMemoriesForCharacter(serializeMemories(cleanBlocks), target.avatar, target.fileName);
    const savedCount = countMemories(cleanBlocks);
    toastr.success(t`Saved ${savedCount} memories.`, 'CharMemory');
    updateStatusDisplay();
}

// ============ Find & Replace ============

/**
 * Build HTML for a compact find/replace bar. Reusable across all editor surfaces.
 * @param {string} idPrefix - Unique prefix for element IDs to avoid conflicts.
 * @returns {string} HTML string
 */
function buildFindReplaceBar(idPrefix) {
    return `<div class="charMemory_findReplaceBar">
        <input type="text" id="${idPrefix}_findInput" class="text_pole" placeholder="Find..." data-i18n="[placeholder]Find..." />
        <input type="text" id="${idPrefix}_replaceInput" class="text_pole" placeholder="Replace with..." data-i18n="[placeholder]Replace with..." />
        <button id="${idPrefix}_caseSensitive" class="menu_button menu_button_icon charMemory_frCaseBtn" title="Case sensitive" data-i18n="[title]Case sensitive">Aa</button>
        <button id="${idPrefix}_replaceAllBtn" class="menu_button" disabled data-i18n="Replace All">Replace All</button>
        <span id="${idPrefix}_matchCount" class="charMemory_frMatchCount"></span>
    </div>`;
}

/**
 * Wire find/replace bar events to a createMemoryEditor instance.
 * @param {object} editor - Editor API from createMemoryEditor()
 * @param {function} refreshFn - Called after replace to re-render cards. Receives (highlightPattern).
 * @param {string} idPrefix - Same prefix used in buildFindReplaceBar()
 * @param {string} namespace - jQuery event namespace for cleanup (e.g. '.charMemoryConsolFR')
 * @returns {function} Cleanup function that removes all event handlers.
 */
function wireFindReplaceEvents(editor, refreshFn, idPrefix, namespace) {
    let caseSensitive = false;

    function getPattern() {
        const find = $(`#${idPrefix}_findInput`).val();
        if (!find) return null;
        const escaped = find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const flags = caseSensitive ? 'g' : 'gi';
        return new RegExp(escaped, flags);
    }

    function updateCount() {
        const find = $(`#${idPrefix}_findInput`).val();
        const count = editor.countMatches(find, caseSensitive);
        const $count = $(`#${idPrefix}_matchCount`);
        $count.text(count > 0 ? `${count} match${count === 1 ? '' : 'es'}` : (find ? 'No matches' : ''));
        $(`#${idPrefix}_replaceAllBtn`).prop('disabled', count === 0);
    }

    $(document).on(`input${namespace}`, `#${idPrefix}_findInput`, function () {
        updateCount();
        refreshFn(getPattern());
    });

    $(document).on(`click${namespace}`, `#${idPrefix}_caseSensitive`, function () {
        caseSensitive = !caseSensitive;
        $(this).toggleClass('charMemory_frCaseBtn--active', caseSensitive);
        updateCount();
        refreshFn(getPattern());
    });

    $(document).on(`click${namespace}`, `#${idPrefix}_replaceAllBtn`, function () {
        const find = $(`#${idPrefix}_findInput`).val();
        const replace = $(`#${idPrefix}_replaceInput`).val();
        if (!find) return;
        const result = editor.findAndReplaceAll(find, replace, caseSensitive);
        refreshFn(null);
        updateCount();
        toastr.success(result.replacements === 1 ? t`Replaced ${result.replacements} occurrence.` : t`Replaced ${result.replacements} occurrences.`, 'CharMemory');
    });

    return function cleanup() {
        $(document).off(`input${namespace}`);
        $(document).off(`click${namespace}`);
    };
}

// ============ Consolidation ============

/**
 * Apply <mark> highlighting to raw text, escaping HTML safely per-segment.
 * Matches against raw text first, then escapes each segment individually.
 * This prevents mark tags from splitting HTML entities like &amp;.
 * @param {string} rawText Unescaped raw text
 * @param {RegExp|null} pattern Highlight pattern (global flag required)
 * @returns {string} HTML-safe string with mark wrapping around matches
 */
function highlightText(rawText, pattern) {
    if (!pattern) return escapeHtml(rawText);
    pattern.lastIndex = 0;
    let result = '';
    let lastIndex = 0;
    let m;
    while ((m = pattern.exec(rawText)) !== null) {
        result += escapeHtml(rawText.slice(lastIndex, m.index));
        result += '<mark>' + escapeHtml(m[0]) + '</mark>';
        lastIndex = m.index + m[0].length;
    }
    result += escapeHtml(rawText.slice(lastIndex));
    return result;
}

function renderConsolidatedCards(blocks, editingSet, highlightPattern = null, protectedIndices = new Set()) {
    return blocks.map((b, bi) => {
        const isEditing = editingSet.has(bi);
        const isProtected = protectedIndices.has(bi);
        const themeLabel = `${bi + 1}. ${b.chat}`;

        if (isEditing) {
            const bullets = b.bullets.map((bullet, bui) =>
                `<div class="charMemory_editorBulletRow" data-block="${bi}" data-bullet="${bui}">
                    <span class="charMemory_editorDash">-</span>
                    <input type="text" class="charMemory_editorBulletInput" value="${escapeHtml(bullet)}" data-block="${bi}" data-bullet="${bui}" />
                    <button class="charMemory_editorDeleteBullet menu_button menu_button_icon" data-block="${bi}" data-bullet="${bui}" title="Delete memory" data-i18n="[title]Delete memory"><i class="fa-solid fa-trash fa-xs"></i></button>
                </div>`
            ).join('');
            return `<div class="charMemory_card charMemory_editorCard charMemory_editorCard--editing" data-block="${bi}">
                <div class="charMemory_cardHeader">
                    <input type="text" class="charMemory_editorThemeInput" value="${escapeHtml(b.chat)}" data-block="${bi}" />
                    <span class="charMemory_cardActions">
                        <button class="charMemory_editorToggleEdit menu_button menu_button_icon" data-block="${bi}" title="Done editing" data-i18n="[title]Done editing"><i class="fa-solid fa-check"></i></button>
                        <button class="charMemory_editorDeleteBlock menu_button menu_button_icon" data-block="${bi}" title="Delete block" data-i18n="[title]Delete block"><i class="fa-solid fa-trash"></i></button>
                    </span>
                </div>
                <div class="charMemory_editorBullets">${bullets}</div>
                <button class="charMemory_editorAddBullet menu_button" data-block="${bi}"><i class="fa-solid fa-plus fa-xs"></i> <span data-i18n="Add memory">Add memory</span></button>
            </div>`;
        } else {
            const bullets = b.bullets.map(bullet => `<li>${highlightText(bullet, highlightPattern)}</li>`).join('');
            const headerHtml = highlightText(themeLabel, highlightPattern);
            const cardClass = `charMemory_card charMemory_editorCard${isProtected ? ' charMemory_protectedBlock' : ''}`;
            const badge = isProtected
                ? `<span class="charMemory_protectedBadge" data-i18n="Protected — unchanged">Protected — unchanged</span>`
                : '';
            return `<div class="${cardClass}" data-block="${bi}">
                <div class="charMemory_cardHeader">
                    <strong>${headerHtml}</strong>${badge}
                    <span class="charMemory_cardActions">
                        <button class="charMemory_editorToggleEdit menu_button menu_button_icon" data-block="${bi}" title="Edit block" data-i18n="[title]Edit block"><i class="fa-solid fa-pencil"></i></button>
                    </span>
                </div>
                <ul>${bullets}</ul>
            </div>`;
        }
    }).join('');
}

function buildConsolidationDialog(beforeBlocks, beforeCount, consolidatedBlocks, editingSet, protectedPreviewIndices = new Set()) {
    const protectedCount = protectedPreviewIndices.size;

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
            ${protectedCount > 0 ? t`Consolidating: ${beforeCount} memories in ${beforeBlocks.length} blocks (+ ${protectedCount} protected)` : t`Original: ${beforeCount} memories in ${beforeBlocks.length} blocks`} &rarr; Consolidated: <span id="charMemory_afterCount">${afterCount}</span> memories
        </div>
        <div class="charMemory_consolidationToolbar">
            <select id="charMemory_consolidationDialogStrategy" class="text_pole" style="max-width:200px;">
                ${Object.entries(CONSOLIDATION_PRESETS).map(([k, v]) =>
                    `<option value="${k}">${escapeHtml(v.name)}</option>`
                ).join('')}
            </select>
            <details class="charMemory_promptDisclosure charMemory_promptDisclosure--dialog">
                <summary><small data-i18n="Show prompt">Show prompt</small></summary>
                <textarea id="charMemory_dialogPrompt" class="text_pole textarea_compact" rows="4" placeholder="Edit prompt for this strategy..."></textarea>
                <div class="charMemory_buttonRow">
                    <input type="button" id="charMemory_dialogRestoreDefault" class="menu_button" value="Restore Default" data-i18n="[value]Restore Default" style="display:none;" />
                </div>
            </details>
            <input type="button" id="charMemory_rerunConsolidation" class="menu_button" value="Re-run" data-i18n="[value]Re-run;[title]Re-send eligible memories to the LLM with current strategy" title="Re-send eligible memories to the LLM with current strategy" />
            <input type="button" id="charMemory_undoRerun" class="menu_button" value="Undo" data-i18n="[value]Undo;[title]Revert to previous consolidated version" title="Revert to previous consolidated version" disabled />
            <span id="charMemory_rerunSpinner" style="display:none;" data-i18n="Working...">Working...</span>
        </div>
        ${buildFindReplaceBar('charMemory_consolFR')}
        <div class="charMemory_consolidationPanes">
            <div class="charMemory_consolidationPane">
                <h4 data-i18n="${protectedCount > 0 ? 'Memories to Consolidate' : 'Original Memories'}">${protectedCount > 0 ? t`Memories to Consolidate` : t`Original Memories`}</h4>
                <div class="charMemory_consolidationContent">${renderReadOnlyCards(beforeBlocks)}</div>
            </div>
            <div class="charMemory_consolidationPane">
                <h4 data-i18n="Consolidated Memories">Consolidated Memories</h4>
                <div class="charMemory_consolidationContent" id="charMemory_editorPane">${renderConsolidatedCards(consolidatedBlocks, editingSet, null, protectedPreviewIndices)}</div>
                <button class="charMemory_editorAddBlock menu_button ${hasEditing ? '' : 'charMemory_editorAddBlock--hidden'}" id="charMemory_editorAddBlock"><i class="fa-solid fa-plus fa-xs"></i> <span data-i18n="Add Block">Add Block</span></button>
            </div>
        </div>
    </div>`;
}

async function undoConsolidation() {
    if (!consolidationBackup) {
        toastr.warning(t`No consolidation to undo.`, 'CharMemory');
        return;
    }
    const confirm = await callGenericPopup(t`Undo the last consolidation and restore previous memories?`, POPUP_TYPE.CONFIRM);
    if (!confirm) return;

    await writeMemoriesForCharacter(consolidationBackup.content, consolidationBackup.avatar, consolidationBackup.fileName);
    consolidationBackup = null;
    toastr.success(t`Consolidation undone. Memories restored.`, 'CharMemory');
    updateStatusDisplay();
}

const CONSOLIDATION_PRESETS = {
    conservative: {
        name: 'Conservative',
        description: 'Only merge near-exact duplicates. Preserves everything else.',
        prompt: `Merge ONLY near-exact duplicate memories. If two bullets say essentially the same thing, keep the more detailed version. Do NOT combine loosely related facts. Do NOT summarize. Preserve every distinct piece of information.
Each block must start with a topic tag as the first bullet: "- [{{charName}}, OtherNames — short description]". ALWAYS include {{charName}} first. Preserve existing topic tags.`,
    },
    balanced: {
        name: 'Balanced',
        description: 'Merge duplicates and combine related facts.',
        prompt: `Merge duplicate or near-duplicate memories into one. Combine closely related facts about the same event or topic. Preserve all unique information — do NOT discard distinct memories. Summarize in third person.
Each block must start with a topic tag as the first bullet: "- [{{charName}}, OtherNames — short description]". ALWAYS include {{charName}} first, then other key participants. When merging blocks, update the topic tag to reflect the combined content. No more than 5 bullets per block (not counting the topic tag).`,
    },
    aggressive: {
        name: 'Aggressive',
        description: 'Compress heavily. Summarize themes. Minimize bullet count.',
        prompt: `Aggressively consolidate these memories into the fewest possible entries. Group by theme or topic. Summarize rather than listing individual events. It's OK to lose minor details if the key facts are preserved. Aim for a compact overview.
Each block must start with a topic tag as the first bullet: "- [{{charName}}, OtherNames/themes — short description]". ALWAYS include {{charName}} first. No more than 5 bullets per block (not counting the topic tag). Always name specific people — never use "a client" or "someone."`,
    },
};

function buildConsolidationPrompt(memoriesText, charName) {
    const strategy = extension_settings[MODULE_NAME].consolidationStrategy || 'balanced';
    const overrides = extension_settings[MODULE_NAME].consolidationPrompts || {};
    const userPrompt = overrides[strategy]
        || CONSOLIDATION_PRESETS[strategy]?.prompt
        || CONSOLIDATION_PRESETS.balanced.prompt;
    let prompt = `You are a memory consolidation assistant. Review the following character memories and consolidate them.

RULES:
${userPrompt}

ADDITIONAL FORMAT RULES:
1. Do NOT use emojis anywhere in the output.
2. Do NOT copy text verbatim from the input — rephrase in third person.
3. Group memories by theme or encounter. Each group is wrapped in <memory chat="Theme Name"></memory> tags where "Theme Name" is a short, specific label. Prefer encounter-specific labels (e.g., "Adoption day at the apartment", "First vet visit") over broad categories (e.g., "Key Events", "Relationships"). Specific labels improve later retrieval.
4. Inside each <memory> block, use a markdown bulleted list (lines starting with "- ").
5. The first bullet in each block must be a topic tag: "- [{{charName}}, OtherNames — short description]". ALWAYS include {{charName}} first. This is mandatory.
6. Always use specific names for people involved, never generic labels like "a client" or "someone."

MEMORIES TO CONSOLIDATE:
${memoriesText}

Output ONLY <memory> blocks. No headers, no commentary, no extra text.`;
    prompt = prompt.replace(/\{\{charName\}\}/g, charName || '');
    return prompt;
}

async function runConsolidationLLM(memories, charName) {
    let memoriesText = memories.map((b, i) =>
        `[Block ${i + 1}]\n${b.bullets.map(bullet => `- ${bullet}`).join('\n')}`,
    ).join('\n\n');

    const isWebLlm = extension_settings[MODULE_NAME].source === EXTRACTION_SOURCE.WEBLLM;
    if (isWebLlm) {
        const template = buildConsolidationPrompt('', charName);
        const available = Math.max(WEBLLM_MAX_PROMPT_CHARS - template.length, 1000);
        memoriesText = truncateText(memoriesText, available);
    }

    let prompt = buildConsolidationPrompt(memoriesText, charName);
    prompt = substituteParamsExtended(prompt);

    try {
        inApiCall = true;
        const sourceLabel = getSourceLabel();
        toastr.info(t`Consolidating via ${sourceLabel}...`, 'CharMemory', { timeOut: 3000 });

        const verbose = extension_settings[MODULE_NAME].verboseLogging;
        if (verbose) {
            logActivity(`Consolidation prompt sent to ${sourceLabel} (${prompt.length} chars):\n${prompt}`);
        }

        logActivity(`Sending consolidation to ${sourceLabel}... waiting for response`);
        const llmStartTime = Date.now();
        const result = await callLLM(
            prompt,
            Math.max(extension_settings[MODULE_NAME].responseLength * 4, 4000),
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
            toastr.warning(t`Consolidation returned empty result.`, 'CharMemory');
            return null;
        }

        // Detect truncated response — a complete response ends with </memory>
        if (cleanResult.includes('<memory') && !/<\/memory>\s*$/.test(cleanResult)) {
            logActivity('Consolidation response appears truncated — last block(s) may be missing. Try increasing Response Length in Settings → Extraction.', 'warning');
            toastr.warning(t`Consolidation response may be truncated. Try increasing Response Length in Settings → Extraction.`, 'CharMemory', { timeOut: 8000 });
        }

        // Parse into memory format, then serialize back to plain text for the editor
        const timestamp = getTimestamp();

        const consolidationRegex = /<memory(?:\s+chat="([^"]*)")?>([\s\S]*?)<\/memory>/gi;
        const consolidationMatches = [...cleanResult.matchAll(consolidationRegex)];
        let rawEntries = consolidationMatches.length > 0
            ? consolidationMatches.map(m => ({ theme: m[1] || 'Consolidated', content: m[2].trim() })).filter(e => e.content)
            : [];

        // Handle LLMs that produce self-closing <memory></memory> with bullets after the tag
        if (rawEntries.length === 0 && consolidationMatches.length > 0) {
            const altRegex = /<memory(?:\s+chat="([^"]*)")?\s*>\s*<\/memory>([\s\S]*?)(?=<memory|$)/gi;
            const altMatches = [...cleanResult.matchAll(altRegex)];
            rawEntries = altMatches.map(m => ({ theme: m[1] || 'Consolidated', content: m[2].trim() })).filter(e => e.content);
        }

        // Final fallback: treat entire response as one block
        if (rawEntries.length === 0) {
            rawEntries = [{ theme: 'Consolidated', content: cleanResult.trim() }].filter(e => e.content);
        }

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
        toastr.error(t`Memory consolidation failed. Check console for details.`, 'CharMemory');
        return null;
    } finally {
        inApiCall = false;
    }
}

/**
 * Show a modal letting the user pick which memory blocks to consolidate.
 * Returns a Set<number> of block indices to use as the eligible set, or
 * null if the user cancelled.
 * @param {Array<{chat:string,date:string,bullets:string[]}>} allBlocks
 * @param {Set<number>} initialEligible Indices to pre-check.
 * @param {string} charName
 * @returns {Promise<Set<number>|null>}
 */
async function showBlockSelectionModal(allBlocks, initialEligible, charName) {
    const rows = allBlocks.map((b, i) => {
        const firstBullet = (b.bullets && b.bullets[0]) ? b.bullets[0] : '';
        const truncated = firstBullet.length > 120 ? firstBullet.slice(0, 117) + '…' : firstBullet;
        const checked = initialEligible.has(i) ? 'checked' : '';
        const badgeClass = initialEligible.has(i) ? 'charMemory_eligibleBadge' : 'charMemory_protectedBadge';
        const badgeText = initialEligible.has(i) ? t`Will consolidate` : t`Protected`;
        return `<div class="charMemory_blockPickerRow" data-index="${i}">
            <label class="checkbox_label">
                <input type="checkbox" class="charMemory_blockPickerCheck" data-index="${i}" ${checked} />
                <span class="charMemory_blockPickerLabel"><strong>${escapeHtml(b.chat)}</strong> <span class="${badgeClass}">${badgeText}</span></span>
            </label>
            <div class="charMemory_blockPickerPreview">${escapeHtml(truncated)}</div>
        </div>`;
    }).join('');

    const html = `<div class="charMemory_blockPicker">
        <p>${t`Select which blocks of ${escapeHtml(charName)}'s memories to consolidate. Unchecked blocks are preserved verbatim.`}</p>
        <div class="charMemory_blockPickerActions">
            <button type="button" class="menu_button" id="charMemory_blockPickerAll" data-i18n="Select all">Select all</button>
            <button type="button" class="menu_button" id="charMemory_blockPickerNone" data-i18n="Select none">Select none</button>
            <span class="charMemory_blockPickerCount" id="charMemory_blockPickerCount"></span>
        </div>
        <div class="charMemory_blockPickerList">${rows}</div>
    </div>`;

    // Wire master checkboxes + live count once the popup is in the DOM
    const updateCount = () => {
        const checked = $('.charMemory_blockPickerCheck:checked').length;
        $('#charMemory_blockPickerCount').text(t`${checked} of ${allBlocks.length} selected`);
        // Disable "Run consolidation" when fewer than 2 blocks are selected —
        // the downstream pipeline requires a minimum of 2.
        $('.dialogue_popup_ok').prop('disabled', checked < 2);
    };
    $(document).on('change.blockPicker', '.charMemory_blockPickerCheck', updateCount);
    $(document).on('click.blockPicker', '#charMemory_blockPickerAll', () => {
        $('.charMemory_blockPickerCheck').prop('checked', true);
        updateCount();
    });
    $(document).on('click.blockPicker', '#charMemory_blockPickerNone', () => {
        $('.charMemory_blockPickerCheck').prop('checked', false);
        updateCount();
    });

    // Schedule the initial count update after the popup renders
    setTimeout(updateCount, 0);

    const ok = await callGenericPopup(html, POPUP_TYPE.CONFIRM, '', {
        wide: true,
        allowVerticalScrolling: true,
        okButton: t`Run consolidation`,
        cancelButton: t`Cancel`,
    });

    // Read selection before teardown
    let result = null;
    if (ok) {
        result = new Set();
        $('.charMemory_blockPickerCheck:checked').each(function () {
            result.add(Number($(this).data('index')));
        });
    }

    // Teardown
    $(document).off('change.blockPicker');
    $(document).off('click.blockPicker');

    return result;
}

/**
 * Public entry point — claims consolidationInFlight immediately (before the
 * character-picker/protected-blocks popups below, unlike the old single function which
 * left a window where a second click or the /consolidate-memories slash command could
 * start a fully concurrent run). try/finally releases it on every exit path.
 */
async function consolidateMemories() {
    if (inApiCall) {
        toastr.warning(t`An API call is already in progress.`, 'CharMemory');
        return;
    }
    if (consolidationInFlight) {
        toastr.warning(t`Consolidation is already in progress.`, 'CharMemory');
        return;
    }
    consolidationInFlight = true;
    try {
        return await consolidateMemoriesInner();
    } finally {
        consolidationInFlight = false;
    }
}

async function consolidateMemoriesInner() {
    const targets = getMemoryTargets();
    if (targets.length === 0) {
        toastr.warning(t`No character selected.`, 'CharMemory');
        return;
    }

    // For multiple targets (group), show a character picker
    let target;
    if (targets.length === 1) {
        target = targets[0];
    } else {
        const pickerHtml = targets.map((tgt, i) =>
            `<label class="checkbox_label"><input type="radio" name="charMemory_consolTarget" value="${i}" ${i === 0 ? 'checked' : ''} /> ${escapeHtml(tgt.name)}</label>`,
        ).join('<br>');
        let selectedIdx = 0;
        $(document).on('change.consolPicker', 'input[name="charMemory_consolTarget"]', function () {
            selectedIdx = Number($(this).val()) || 0;
        });
        const picked = await callGenericPopup(t`Select a character to consolidate memories for:<br><br>${pickerHtml}`, POPUP_TYPE.CONFIRM);
        $(document).off('change.consolPicker');
        if (!picked) return;
        target = targets[selectedIdx];
    }

    const content = await readMemoriesForCharacter(target.avatar, target.fileName);
    const memories = parseMemories(content);

    if (memories.length < 2) {
        toastr.info(t`Not enough memories to consolidate.`, 'CharMemory');
        return;
    }

    // Classify blocks: protected blocks stay verbatim; eligible blocks go to the LLM.
    // Classification is heuristic — the user can override via the "Change selection…" modal.
    const { eligible: initialEligible, protected: initialProtected } = classifyBlocksForConsolidation(memories);

    // Build eligibleIndices (Set<number>) tracking positions in the original `memories` list.
    // We rely on the classifier returning the same block references (not clones) so we can
    // convert its output back to positions via a reference-keyed Set lookup (O(1) per block,
    // vs O(N) with Array.includes, and future-resilient if the Set check is preserved).
    const initialEligibleSet = new Set(initialEligible);
    let eligibleIndices = new Set();
    memories.forEach((b, i) => {
        if (initialEligibleSet.has(b)) eligibleIndices.add(i);
    });

    // If any blocks are protected, show a confirm popup with an override option.
    if (initialProtected.length > 0) {
        const protectedCount = initialProtected.length;
        const eligibleCount = initialEligible.length;
        const summary = t`Protecting ${protectedCount} blocks from prior consolidations. Consolidating ${eligibleCount} new blocks.<br><br>Click <strong>Change selection…</strong> to adjust which blocks are protected, or <strong>Proceed</strong> to continue.`;
        const proceed = await callGenericPopup(summary, POPUP_TYPE.CONFIRM, '', {
            okButton: t`Proceed`,
            cancelButton: t`Change selection…`,
        });
        // All non-Proceed dismissals (cancel button, Escape, backdrop click) open the
        // picker modal — SillyTavern's POPUP_TYPE.CONFIRM doesn't distinguish between
        // them. Abort-without-consolidating only happens from within the picker modal
        // itself (via its Cancel button, which returns null).
        if (!proceed) {
            const picked = await showBlockSelectionModal(memories, eligibleIndices, target.name);
            if (picked === null) {
                logActivity('Consolidation cancelled — no changes made.');
                return;
            }
            eligibleIndices = picked;
        }
    }

    // Derive eligible and protected from the (possibly-overridden) eligibleIndices.
    const eligible = memories.filter((_, i) => eligibleIndices.has(i));
    const protectedBlocks = memories.filter((_, i) => !eligibleIndices.has(i));

    if (eligible.length < 2) {
        if (eligible.length === 0) {
            toastr.info(t`All memories appear to be already consolidated — nothing new to do.`, 'CharMemory');
        } else {
            toastr.info(t`Only 1 new block since last consolidation — not enough to consolidate (minimum 2).`, 'CharMemory');
        }
        return;
    }

    const beforeCount = countMemories(eligible);
    logActivity(`Consolidation started for ${target.name}: ${beforeCount} eligible memories in ${eligible.length} blocks (${protectedBlocks.length} protected)`);

    // Show busy state on button
    const $btn = $('#charMemory_consolidateBtn');
    $btn.val(t`Consolidating…`).prop('disabled', true);

    // Route large memory sets through the chunked map-reduce orchestrator.
    const chunkBudget = extension_settings[MODULE_NAME].consolidationChunkChars;
    const outputRatio = extension_settings[MODULE_NAME].consolidationOutputRatio;
    const sizing = estimateConsolidationSize(eligible, { outputRatio });
    // sizing.outputCharsEstimate is reserved for future per-chunk pressure checks.
    const useChunked = sizing.memoriesChars > chunkBudget;

    let initialResult;
    consolidationCancelRequested = false;
    try {
        if (useChunked) {
            // Re-enable so the user can click Cancel (Task 5 wires the click handler).
            $btn.val(t`Cancel`).prop('disabled', false);
            initialResult = await runChunkedConsolidation(eligible, {
                // runConsolidationLLM catches LLM errors and returns null, so the
                // orchestrator's retry-on-throw path will not fire for transient
                // failures. Failed chunks are skipped. Follow-up to propagate
                // retriable errors is tracked separately.
                runLLM: (chunk) => runConsolidationLLM(chunk, target.name),
                logProgress: (msg) => logActivity(msg),
                isCancelled: () => consolidationCancelRequested,
                packChunks: (mems) => packBlocksIntoChunks(mems, chunkBudget),
                parseOutput: (text) => parseMemories(text),
            });
        } else {
            initialResult = await runConsolidationLLM(eligible, target.name);
        }
    } finally {
        $btn.val(t`Consolidate`).prop('disabled', false);
    }
    if (!initialResult) return;

    // Assemble finalBlocks = protected + newly consolidated. Protected blocks retain
    // their original order; newly consolidated output is appended. Indices 0..N-1
    // (where N = protectedBlocks.length) are the protected ones for visual marking.
    const newlyConsolidatedBlocks = parseMemories(initialResult);
    const assembledBlocks = [...protectedBlocks, ...newlyConsolidatedBlocks];
    const protectedPreviewIndices = new Set(protectedBlocks.map((_, i) => i));

    const editor = createMemoryEditor({ blocks: assembledBlocks });
    const rerunBackups = []; // separate stack for re-run undo
    let consolFindPattern = null;

    // Protected blocks are identified by structural fingerprint (chat + bullets)
    // rather than reference, because createMemoryEditor clones blocks internally
    // (editor.js calls cloneMemoryBlocks on init and on every getBlocks() call).
    // Reference-equality checks would always fail against cloned objects, causing
    // badges to vanish on the first refresh. If a user edits a protected block's
    // chat label or bullets, the fingerprint changes and the badge disappears —
    // which is semantically correct: the block is no longer "unchanged."
    const fingerprint = (b) => `${b.chat}\x00${(b.bullets || []).join('\x00')}`;
    const protectedFingerprints = new Set(protectedBlocks.map(fingerprint));

    const refreshEditor = (highlightPattern) => {
        if (highlightPattern !== undefined) consolFindPattern = highlightPattern;
        const blocks = editor.getBlocks();
        const editing = editor.getEditingSet();
        const currentProtectedIndices = new Set();
        blocks.forEach((b, i) => {
            if (protectedFingerprints.has(fingerprint(b))) currentProtectedIndices.add(i);
        });
        $('#charMemory_editorPane').html(renderConsolidatedCards(blocks, editing, consolFindPattern, currentProtectedIndices));
        $('#charMemory_afterCount').text(countMemories(blocks));
        $('#charMemory_editorAddBlock').toggleClass('charMemory_editorAddBlock--hidden', editing.size === 0);
    };

    // Build and show the interactive dialog
    const initBlocks = editor.getBlocks();
    const initEditing = editor.getEditingSet();
    const dialogHtml = buildConsolidationDialog(eligible, beforeCount, initBlocks, initEditing, protectedPreviewIndices);
    const popup = callGenericPopup(dialogHtml, POPUP_TYPE.CONFIRM, '', { wide: true, allowVerticalScrolling: true, okButton: t`Save`, cancelButton: t`Cancel` });

    // Set up the strategy dropdown and prompt viewer to match current setting
    const currentStrategy = extension_settings[MODULE_NAME].consolidationStrategy || 'balanced';
    $('#charMemory_consolidationDialogStrategy').val(currentStrategy);
    const overrides = extension_settings[MODULE_NAME].consolidationPrompts || {};
    const currentPrompt = overrides[currentStrategy] || CONSOLIDATION_PRESETS[currentStrategy]?.prompt || '';
    $('#charMemory_dialogPrompt').val(currentPrompt);
    $('#charMemory_dialogRestoreDefault').toggle(!!overrides[currentStrategy]);

    // === Find/Replace bar ===
    const cleanupConsolFR = wireFindReplaceEvents(editor, refreshEditor, 'charMemory_consolFR', '.charMemoryConsolFR');

    // === Event delegation for editor interactions ===

    // Toggle edit mode per block
    $(document).off('click.charMemoryEditorToggle').on('click.charMemoryEditorToggle', '.charMemory_editorToggleEdit', function () {
        editor.toggleEdit(Number($(this).data('block')));
        refreshEditor();
    });

    // Sync bullet input changes back to editor state
    $(document).off('input.charMemoryEditor').on('input.charMemoryEditor', '.charMemory_editorBulletInput', function () {
        editor.updateBullet(Number($(this).data('block')), Number($(this).data('bullet')), $(this).val());
    });

    // Sync theme input changes back to editor state
    $(document).off('input.charMemoryEditorTheme').on('input.charMemoryEditorTheme', '.charMemory_editorThemeInput', function () {
        editor.updateTheme(Number($(this).data('block')), $(this).val());
    });

    // Delete bullet
    $(document).off('click.charMemoryEditorDelBullet').on('click.charMemoryEditorDelBullet', '.charMemory_editorDeleteBullet', function () {
        editor.deleteBullet(Number($(this).data('block')), Number($(this).data('bullet')));
        refreshEditor();
    });

    // Delete block
    $(document).off('click.charMemoryEditorDelBlock').on('click.charMemoryEditorDelBlock', '.charMemory_editorDeleteBlock', function () {
        editor.deleteBlock(Number($(this).data('block')));
        refreshEditor();
    });

    // Add bullet to block
    $(document).off('click.charMemoryEditorAddBullet').on('click.charMemoryEditorAddBullet', '.charMemory_editorAddBullet', function () {
        const bi = Number($(this).data('block'));
        editor.addBullet(bi);
        refreshEditor();
        $(`#charMemory_editorPane .charMemory_editorCard[data-block="${bi}"] .charMemory_editorBulletInput:last`).focus();
    });

    // Add new block
    $(document).off('click.charMemoryEditorAddBlock').on('click.charMemoryEditorAddBlock', '#charMemory_editorAddBlock', function () {
        editor.addBlock();
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

        const backupBlocks = editor.getBlocks();

        const dialogStrategy = $('#charMemory_consolidationDialogStrategy').val();
        extension_settings[MODULE_NAME].consolidationStrategy = dialogStrategy;
        updateConsolidationStrategyUI();
        saveSettingsDebounced();

        $('#charMemory_rerunSpinner').show();
        $('#charMemory_rerunConsolidation').prop('disabled', true);
        $('#charMemory_editorPane').addClass('charMemory_editorDisabled');

        // Re-run on the eligible subset only — protected blocks must not be
        // re-sent to the LLM (they'd get re-consolidated and risk drift).
        const newResult = await runConsolidationLLM(eligible, target.name);

        $('#charMemory_rerunSpinner').hide();
        $('#charMemory_rerunConsolidation').prop('disabled', false);
        $('#charMemory_editorPane').removeClass('charMemory_editorDisabled');

        if (newResult) {
            rerunBackups.push(backupBlocks);
            $('#charMemory_undoRerun').prop('disabled', false);
            // Reassemble: protected blocks (unchanged) + newly re-consolidated output.
            const newConsolidated = parseMemories(newResult);
            editor.replaceAll([...protectedBlocks, ...newConsolidated]);
            refreshEditor();
        }
    });

    // === Undo button ===
    $('#charMemory_undoRerun').off('click').on('click', () => {
        if (rerunBackups.length === 0) return;
        editor.replaceAll(rerunBackups.pop());
        refreshEditor();
        if (rerunBackups.length === 0) {
            $('#charMemory_undoRerun').prop('disabled', true);
        }
    });

    // === Wait for Accept/Cancel ===
    const confirmed = await popup;

    // Clean up event delegation
    cleanupConsolFR();
    $(document).off('click.charMemoryEditorToggle');
    $(document).off('input.charMemoryEditor');
    $(document).off('input.charMemoryEditorTheme');
    $(document).off('click.charMemoryEditorDelBullet');
    $(document).off('click.charMemoryEditorDelBlock');
    $(document).off('click.charMemoryEditorAddBullet');
    $(document).off('click.charMemoryEditorAddBlock');

    if (!confirmed) {
        logActivity('Consolidation cancelled by user');
        toastr.info(t`Consolidation cancelled.`, 'CharMemory');
        updateConsolidationStrategyUI();
        return;
    }

    if (inApiCall) {
        toastr.warning(t`Cannot save while a re-run is in progress.`, 'CharMemory');
        return;
    }

    // Filter out empty bullets and empty blocks before saving
    const cleanBlocks = editor.getBlocks()
        .map(b => ({ ...b, bullets: b.bullets.filter(bullet => bullet.trim() !== '') }))
        .filter(b => b.bullets.length > 0);

    if (cleanBlocks.length === 0) {
        toastr.warning(t`No memories to save. Memories unchanged.`, 'CharMemory');
        return;
    }

    consolidationBackup = { content, avatar: target.avatar, fileName: target.fileName };
    await writeMemoriesForCharacter(serializeMemories(cleanBlocks), target.avatar, target.fileName);

    const afterCount = countMemories(cleanBlocks);
    logActivity(`Consolidation complete: ${beforeCount} → ${afterCount} memories`, 'success');
    toastr.success(t`Consolidated ${beforeCount} → ${afterCount} memories.`, 'CharMemory');
    updateStatusDisplay();
    updateConsolidationStrategyUI();
}

// ============ Reformat Tool ============

/**
 * Build the HTML for the reformat preview dialog.
 * Left pane: read-only original blocks. Right pane: editable reformatted blocks.
 * Reuses the same CSS classes as the consolidation/conversion editor.
 */
function buildReformatDialog(originalBlocks, originalCount, reformattedBlocks, editingSet) {
    const renderReadOnlyCards = (blocks) => {
        return blocks.map(b => {
            const bullets = b.bullets.map(bullet => `<li>${escapeHtml(bullet)}</li>`).join('');
            return `<div class="charMemory_card">
                <div class="charMemory_cardHeader"><strong>${escapeHtml(b.chat)}</strong> <span class="charMemory_cardDate">${escapeHtml(b.date)}</span></div>
                <ul>${bullets}</ul>
            </div>`;
        }).join('');
    };

    const afterCount = countMemories(reformattedBlocks);
    const hasEditing = editingSet.size > 0;

    return `<div class="charMemory_consolidationDialog">
        <div class="charMemory_consolidationStats" id="charMemory_reformatStats">
            Original: ${originalCount} memories in ${originalBlocks.length} blocks &rarr; Reformatted: <span id="charMemory_reformatAfterCount">${afterCount}</span> memories in <span id="charMemory_reformatBlockCount">${reformattedBlocks.length}</span> blocks
        </div>
        <div class="charMemory_consolidationToolbar">
            <input type="button" id="charMemory_rerunReformat" class="menu_button" value="Re-run" data-i18n="[value]Re-run;[title]Send original memories to the LLM again" title="Send original memories to the LLM again" />
            <input type="button" id="charMemory_undoReformatRerun" class="menu_button" value="Undo" data-i18n="[value]Undo;[title]Revert to previous reformatted version" title="Revert to previous reformatted version" disabled />
            <span id="charMemory_reformatRerunSpinner" style="display:none;" data-i18n="Working...">Working...</span>
        </div>
        ${buildFindReplaceBar('charMemory_refFR')}
        <div class="charMemory_consolidationPanes">
            <div class="charMemory_consolidationPane">
                <h4 data-i18n="Original Memories">Original Memories</h4>
                <div class="charMemory_consolidationContent">${renderReadOnlyCards(originalBlocks)}</div>
            </div>
            <div class="charMemory_consolidationPane">
                <h4 data-i18n="Reformatted Memories">Reformatted Memories</h4>
                <div class="charMemory_consolidationContent" id="charMemory_reformatEditorPane">${renderConsolidatedCards(reformattedBlocks, editingSet)}</div>
                <button class="charMemory_editorAddBlock menu_button ${hasEditing ? '' : 'charMemory_editorAddBlock--hidden'}" id="charMemory_reformatAddBlock"><i class="fa-solid fa-plus fa-xs"></i> <span data-i18n="Add Block">Add Block</span></button>
            </div>
        </div>
    </div>`;
}

/**
 * Show the reformat preview dialog with side-by-side comparison and editing.
 * Returns the edited blocks on confirm, or null on cancel.
 */
async function showReformatPreview(originalBlocks, reformattedBlocks, charName, target) {
    const originalCount = countMemories(originalBlocks);

    // Editor state lives in closure
    const editor = createMemoryEditor({ blocks: reformattedBlocks });
    const rerunBackups = []; // separate stack for re-run undo
    let dialogClosed = false;
    let refFindPattern = null;

    const refreshEditor = (highlightPattern) => {
        if (highlightPattern !== undefined) refFindPattern = highlightPattern;
        const blocks = editor.getBlocks();
        const editing = editor.getEditingSet();
        $('#charMemory_reformatEditorPane').html(renderConsolidatedCards(blocks, editing, refFindPattern));
        $('#charMemory_reformatAfterCount').text(countMemories(blocks));
        $('#charMemory_reformatBlockCount').text(blocks.length);
        $('#charMemory_reformatAddBlock').toggleClass('charMemory_editorAddBlock--hidden', editing.size === 0);
    };

    // Build and show dialog
    const initBlocks = editor.getBlocks();
    const initEditing = editor.getEditingSet();
    const dialogHtml = buildReformatDialog(originalBlocks, originalCount, initBlocks, initEditing);
    const popup = callGenericPopup(dialogHtml, POPUP_TYPE.CONFIRM, '', { wide: true, allowVerticalScrolling: true, okButton: t`Save`, cancelButton: t`Cancel` });

    // === Find/Replace bar ===
    const cleanupRefFR = wireFindReplaceEvents(editor, refreshEditor, 'charMemory_refFR', '.charMemoryRefFR');

    // === Editor event delegation (unique namespace to avoid conflicts) ===

    $(document).off('click.charMemoryRefToggle').on('click.charMemoryRefToggle', '.charMemory_editorToggleEdit', function () {
        editor.toggleEdit(Number($(this).data('block')));
        refreshEditor();
    });

    $(document).off('input.charMemoryRefBullet').on('input.charMemoryRefBullet', '.charMemory_editorBulletInput', function () {
        editor.updateBullet(Number($(this).data('block')), Number($(this).data('bullet')), $(this).val());
    });

    $(document).off('input.charMemoryRefTheme').on('input.charMemoryRefTheme', '.charMemory_editorThemeInput', function () {
        editor.updateTheme(Number($(this).data('block')), $(this).val());
    });

    $(document).off('click.charMemoryRefDelBullet').on('click.charMemoryRefDelBullet', '.charMemory_editorDeleteBullet', function () {
        editor.deleteBullet(Number($(this).data('block')), Number($(this).data('bullet')));
        refreshEditor();
    });

    $(document).off('click.charMemoryRefDelBlock').on('click.charMemoryRefDelBlock', '.charMemory_editorDeleteBlock', function () {
        editor.deleteBlock(Number($(this).data('block')));
        refreshEditor();
    });

    $(document).off('click.charMemoryRefAddBullet').on('click.charMemoryRefAddBullet', '.charMemory_editorAddBullet', function () {
        const bi = Number($(this).data('block'));
        editor.addBullet(bi);
        refreshEditor();
        $(`#charMemory_reformatEditorPane .charMemory_editorCard[data-block="${bi}"] .charMemory_editorBulletInput:last`).focus();
    });

    $(document).off('click.charMemoryRefAddBlock').on('click.charMemoryRefAddBlock', '#charMemory_reformatAddBlock', function () {
        editor.addBlock();
        refreshEditor();
        $('#charMemory_reformatEditorPane .charMemory_editorCard:last .charMemory_editorBulletInput:last').focus();
    });

    // === Re-run button ===
    $('#charMemory_rerunReformat').off('click').on('click', async () => {
        if (inApiCall) return;
        const backupBlocks = editor.getBlocks();

        $('#charMemory_reformatRerunSpinner').show();
        $('#charMemory_rerunReformat').prop('disabled', true);
        $('#charMemory_reformatEditorPane').addClass('charMemory_editorDisabled');

        let newResult;
        try {
            inApiCall = true;
            const content = serializeMemories(originalBlocks);
            newResult = await convertWithLLM(content, charName);
        } catch (err) {
            console.error(LOG_PREFIX, 'Re-run reformat failed:', err);
            toastr.error(t`Re-run failed: ${err.message || 'Unknown error'}`, 'CharMemory');
            newResult = null;
        } finally {
            inApiCall = false;
        }

        if (dialogClosed) return;

        $('#charMemory_reformatRerunSpinner').hide();
        $('#charMemory_rerunReformat').prop('disabled', false);
        $('#charMemory_reformatEditorPane').removeClass('charMemory_editorDisabled');

        if (newResult && newResult.blocks.length > 0) {
            rerunBackups.push(backupBlocks);
            $('#charMemory_undoReformatRerun').prop('disabled', false);
            editor.replaceAll(newResult.blocks);
            refreshEditor();
            for (const w of newResult.warnings) {
                toastr.warning(w, 'CharMemory');
            }
        }
    });

    // === Undo button ===
    $('#charMemory_undoReformatRerun').off('click').on('click', () => {
        if (rerunBackups.length === 0) return;
        editor.replaceAll(rerunBackups.pop());
        refreshEditor();
        if (rerunBackups.length === 0) $('#charMemory_undoReformatRerun').prop('disabled', true);
    });

    // === Wait for Accept/Cancel ===
    const confirmed = await popup;
    dialogClosed = true;

    // Clean up event delegation
    cleanupRefFR();
    $(document).off('click.charMemoryRefToggle');
    $(document).off('input.charMemoryRefBullet');
    $(document).off('input.charMemoryRefTheme');
    $(document).off('click.charMemoryRefDelBullet');
    $(document).off('click.charMemoryRefDelBlock');
    $(document).off('click.charMemoryRefAddBullet');
    $(document).off('click.charMemoryRefAddBlock');

    if (!confirmed) return null;

    // Guard: if a re-run is still in flight, don't save stale state
    if (inApiCall) {
        toastr.warning(t`Cannot save while a re-run is in progress.`, 'CharMemory');
        return null;
    }

    // Filter out empty bullets and empty blocks before returning
    const cleanBlocks = editor.getBlocks()
        .map(b => ({ ...b, bullets: b.bullets.filter(bullet => bullet.trim() !== '') }))
        .filter(b => b.bullets.length > 0);

    return cleanBlocks.length > 0 ? cleanBlocks : null;
}

/**
 * Main reformat flow: read memories, send through LLM conversion prompt,
 * show interactive preview, save on confirmation with backup for undo.
 */
/**
 * Public entry point — claims reformatInFlight immediately, before the character-picker
 * popup below, so a second click or entry point can't start a fully concurrent run while
 * this one is still waiting on the user to answer that popup. try/finally releases it on
 * every exit path.
 */
async function reformatMemories() {
    if (inApiCall) {
        toastr.warning(t`An API call is already in progress.`, 'CharMemory');
        return;
    }
    if (reformatInFlight) {
        toastr.warning(t`Reformat is already in progress.`, 'CharMemory');
        return;
    }
    reformatInFlight = true;
    try {
        return await reformatMemoriesInner();
    } finally {
        reformatInFlight = false;
    }
}

async function reformatMemoriesInner() {
    const targets = getMemoryTargets();
    if (targets.length === 0) {
        toastr.warning(t`No character selected.`, 'CharMemory');
        return;
    }

    // For multiple targets (group), show a character picker
    let target;
    if (targets.length === 1) {
        target = targets[0];
    } else {
        const pickerHtml = targets.map((tgt, i) =>
            `<label class="checkbox_label"><input type="radio" name="charMemory_reformatTarget" value="${i}" ${i === 0 ? 'checked' : ''} /> ${escapeHtml(tgt.name)}</label>`,
        ).join('<br>');
        let selectedIdx = 0;
        $(document).on('change.reformatPicker', 'input[name="charMemory_reformatTarget"]', function () {
            selectedIdx = Number($(this).val()) || 0;
        });
        const picked = await callGenericPopup(t`Select a character to reformat memories for:<br><br>${pickerHtml}`, POPUP_TYPE.CONFIRM);
        $(document).off('change.reformatPicker');
        if (!picked) return;
        target = targets[selectedIdx];
    }

    const content = await readMemoriesForCharacter(target.avatar, target.fileName);
    const originalBlocks = parseMemories(content);

    if (originalBlocks.length === 0) {
        toastr.info(t`No memories found to reformat.`, 'CharMemory');
        return;
    }

    // Check if all blocks already have topic tags (first bullet matches [Topic])
    const allHaveTopicTags = originalBlocks.every(b =>
        b.bullets.length > 0 && /^\[.+\]$/.test(b.bullets[0]),
    );
    if (allHaveTopicTags) {
        const proceed = await callGenericPopup(
            t`All memory blocks already have topic tags. Reformatting may still improve structure, but the memories may already be well-formatted.<br><br>Continue anyway?`,
            POPUP_TYPE.CONFIRM,
        );
        if (!proceed) return;
    }

    const beforeCount = countMemories(originalBlocks);
    logActivity(`Reformat started for ${target.name}: ${beforeCount} memories in ${originalBlocks.length} blocks`);

    // Show busy state
    const $btn = $('#charMemory_formatBtn');
    $btn.val(t`Reformatting\u2026`).prop('disabled', true);

    let result;
    try {
        inApiCall = true;
        const charName = target.name || 'Character';
        const sourceLabel = getSourceLabel();
        toastr.info(t`Sending to ${sourceLabel} for reformatting...`, 'CharMemory', { timeOut: 3000 });
        result = await convertWithLLM(content, charName);
    } catch (err) {
        console.error(LOG_PREFIX, 'Reformat failed:', err);
        toastr.error(t`Reformat failed: ${err.message || 'Unknown error'}`, 'CharMemory');
        return;
    } finally {
        inApiCall = false;
        $btn.val(t`Reformat`).prop('disabled', false);
    }

    for (const w of result.warnings) {
        toastr.warning(w, 'CharMemory');
    }

    if (result.blocks.length === 0) {
        toastr.warning(t`LLM returned no usable memories. Reformat aborted.`, 'CharMemory');
        return;
    }

    // Show interactive preview dialog
    const editedBlocks = await showReformatPreview(originalBlocks, result.blocks, target.name, target);

    if (!editedBlocks) {
        logActivity('Reformat cancelled by user');
        toastr.info(t`Reformat cancelled.`, 'CharMemory');
        return;
    }

    // Back up original content for undo
    reformatBackup = { content, avatar: target.avatar, fileName: target.fileName };

    // Save reformatted memories
    try {
        await writeMemoriesForCharacter(serializeMemories(editedBlocks), target.avatar, target.fileName);
    } catch (err) {
        console.error(LOG_PREFIX, 'Reformat save failed:', err);
        toastr.error(t`Failed to save reformatted memories.`, 'CharMemory');
        reformatBackup = null;
        return;
    }

    const afterCount = countMemories(editedBlocks);
    logActivity(`Reformat complete: ${beforeCount} → ${afterCount} memories in ${editedBlocks.length} blocks`, 'success');
    toastr.success(t`Reformatted ${beforeCount} → ${afterCount} memories.`, 'CharMemory');
    updateStatusDisplay();
}

/**
 * Undo the last reformat and restore original memories.
 */
async function undoReformat() {
    if (!reformatBackup) {
        toastr.warning(t`No reformat to undo.`, 'CharMemory');
        return;
    }
    const confirm = await callGenericPopup(
        t`Undo the last reformat and restore original memories?`,
        POPUP_TYPE.CONFIRM,
    );
    if (!confirm) return;

    await writeMemoriesForCharacter(reformatBackup.content, reformatBackup.avatar, reformatBackup.fileName);
    reformatBackup = null;
    toastr.info(t`Reformat undone — original memories restored.`, 'CharMemory');
    logActivity('Reformat undone');
    updateStatusDisplay();
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
            toastr.info(t`Diagnostics captured. Check console and Diagnostics panel.`, 'CharMemory');
            return '';
        },
        helpString: 'Capture and display CharMemory diagnostics data.',
    }));
}

// ============ UI Setup ============

/**
 * Wire event handlers for provider selection and configuration controls.
 * Covers: LLM source dropdown, provider picker, API key, connect/test,
 * model search/picker with keyboard navigation, provider settings fields,
 * and NanoGPT filter checkboxes.
 */
// setupConnectionControls() removed in v2.0 — all sidebar provider panel elements
// (#charMemory_source, #charMemory_providerSelect, etc.) were removed from settings.html.
// Connection and provider settings are now managed exclusively in the Settings Modal.

/**
 * Wire event handlers for extraction, memory manager, and dashboard tool launchers.
 * Covers: extract now, manage memories, consolidate/batch/format launcher buttons,
 * consolidation strategy/prompt, convert preview/undo, format source radio,
 * convert prompt, batch extract controls, and files popover.
 */
function setupToolControls() {
    $('#charMemory_extractNow').off('click').on('click', function () {
        extractMemories({ force: true });
    });

    $('#charMemory_autoExtractPill').off('click').on('click', function () {
        extension_settings[MODULE_NAME].enabled = !extension_settings[MODULE_NAME].enabled;
        $(this).toggleClass('active', !!extension_settings[MODULE_NAME].enabled);
        saveSettingsDebounced();
    });

    $('#charMemory_manageMemories').off('click').on('click', () => showMemoryManager());

    // Dashboard tool launcher buttons
    $('#charMemory_consolidateBtn').off('click').on('click', () => {
        const $btn = $('#charMemory_consolidateBtn');
        // If chunked consolidation is running, the button label is "Cancel" — treat the
        // click as a cancellation request. Otherwise start a new consolidation.
        if ($btn.val() === t`Cancel`) {
            consolidationCancelRequested = true;
            $btn.val(t`Cancelling…`).prop('disabled', true);
            logActivity(t`Consolidation cancel requested — waiting for current chunk to finish`);
            return;
        }
        consolidateMemories();
    });
    $('#charMemory_batchBtn').off('click').on('click', () => showBatchPopup());
    $('#charMemory_formatBtn').off('click').on('click', () => reformatMemories());
    $('#charMemory_filesPopover').off('click').on('click', () => showTroubleshooter('databank'));

    // Diagnostics link → open troubleshooter
    $('#charMemory_viewDiagDetails').off('click').on('click', () => showTroubleshooter('health'));

    // Delegated handler for batch chat checkboxes (created dynamically in showBatchPopup)
    $(document).off('change', '.charMemory_batchChatCheck').on('change', '.charMemory_batchChatCheck', updateBatchButtons);
}

// setupStorageControls() removed in v2.0 — all sidebar storage panel elements
// (#charMemory_fileName, #charMemory_perChat, etc.) were removed from settings.html.
// Storage settings are now managed exclusively in the Settings Modal.

/**
 * Wire event handlers for health indicator click.
 */
function setupLogControls() {
    // Health indicator click — open troubleshooter
    $('#charMemory_statHealth').off('click').on('click', function () {
        showTroubleshooter('health');
    });

    // Intercept inline-drawer toggle for tablet mode.
    // In tablet mode: prevent ST's native sidebar expansion, open floating panel instead.
    // In normal mode: refresh status/health when the drawer opens (existing behavior).
    // Uses capturing phase to fire before ST's own inline-drawer handler.
    const drawerToggle = document.querySelector('.charMemory_settings .inline-drawer-toggle');
    if (drawerToggle && !drawerToggle._charMemoryTabletBound) {
        drawerToggle._charMemoryTabletBound = true;
        drawerToggle.addEventListener('click', function (e) {
            if (isTabletMode()) {
                e.stopPropagation();
                e.preventDefault();
                toggleTabletPanel();
                return;
            }
            // Normal mode: let ST handle the toggle, then refresh if opened
            setTimeout(() => {
                if ($('.charMemory_settings .inline-drawer-content').is(':visible')) {
                    updateStatusDisplay();
                    updateHealthIndicator();
                }
            }, 50);
        }, true); // capturing phase
    }
}

/**
 * Reset extraction tracking for the currently open chat only.
 * Resets lastExtractedIndex and messagesSinceExtraction in chat_metadata.
 * NOTE: In group chats, all characters share one extraction pointer — this resets all of them simultaneously.
 */
function resetCurrentChatTracking() {
    ensureMetadata();
    chat_metadata[MODULE_NAME].lastExtractedIndex = -1;
    chat_metadata[MODULE_NAME].messagesSinceExtraction = 0;
    saveMetadataDebounced();
    updateStatusDisplay();
    const msg = isGroupChat()
        ? t`Extraction state reset for this group chat. All members will re-process from the beginning.`
        : t`Extraction state reset. Next "Extract Now" will re-read all messages.`;
    toastr.success(msg, 'CharMemory');
}

/**
 * Mark the active chat as fully extracted — sets `lastExtractedIndex` to the
 * last message index, so auto-extraction and "Extract Now" treat the chat as
 * caught up. Useful after importing a Data Bank file into a forked chat where
 * the memories already exist but the pointer has been reset.
 */
function markChatAsFullyExtracted() {
    ensureMetadata();
    const context = getContext();
    const chat = context.chat;
    if (!chat || chat.length === 0) {
        toastr.info(t`No messages in this chat to mark as extracted.`, 'CharMemory');
        return;
    }
    const lastIdx = chat.length - 1;
    chat_metadata[MODULE_NAME].lastExtractedIndex = lastIdx;
    chat_metadata[MODULE_NAME].messagesSinceExtraction = 0;
    saveMetadataDebounced();
    updateStatusDisplay();
    const msg = isGroupChat()
        ? t`This group chat marked as fully extracted (pointer set to message ${lastIdx}). All members share one pointer.`
        : t`Chat marked as fully extracted (pointer set to message ${lastIdx}). Auto-extraction will resume from the next new message.`;
    toastr.success(msg, 'CharMemory');
    logActivity(`Marked chat as fully extracted: lastExtractedIndex=${lastIdx}`);
}

/**
 * Clear batch extraction progress records for all of this character's chats.
 * Does NOT affect the current chat's regular extraction pointer (chat_metadata).
 * For non-active chats, only batch records can be cleared from here — their regular
 * extraction pointers live in each chat's metadata and can only be reset when that chat is open.
 */
function resetBatchProgress() {
    const charName = getCharacterName();
    if (!charName || !extension_settings[MODULE_NAME].batchState) {
        toastr.info(t`No batch progress to clear.`, 'CharMemory');
        return;
    }
    const prefix = `${charName}:`;
    let count = 0;
    for (const key of Object.keys(extension_settings[MODULE_NAME].batchState)) {
        if (key.startsWith(prefix)) {
            delete extension_settings[MODULE_NAME].batchState[key];
            count++;
        }
    }
    saveSettingsDebounced();
    if (count > 0) {
        toastr.success(count === 1 ? t`Batch progress cleared for ${count} chat.` : t`Batch progress cleared for ${count} chats.`, 'CharMemory');
    } else {
        toastr.info(t`No batch progress to clear.`, 'CharMemory');
    }
}

/**
 * Clear all memories and reset extraction state for the current character.
 * Called from Settings Modal, Troubleshooter, and dashboard.
 */
async function clearAllMemories() {
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
    $('#charMemory_statCount').text(t`0 memories`);
    $('#charMemory_statProgress').text(t`0/${extension_settings[MODULE_NAME].interval} msgs`);
    updateStatusDisplay();
    toastr.success(t`Memories cleared and extraction state reset for all chats. Next extraction will start from the beginning.`, 'CharMemory');
}

function setupListeners() {
    setupToolControls();
    setupLogControls();

    // Gear icon → Settings modal
    $('#charMemory_openSettingsModal').off('click').on('click', function (e) {
        e.stopPropagation(); // Prevent toggling the inline-drawer
        showSettingsModal();
    });

    // Wrench icon → Troubleshooter modal
    $('#charMemory_openTroubleshooter').off('click').on('click', function (e) {
        e.stopPropagation();
        showTroubleshooter();
    });

    // Syringe icon → Toggle Injection Sidebar
    $('#charMemory_toggleInjectionBtn').off('click').on('click', function (e) {
        e.stopPropagation();
        toggleInjectionDrawer();
    });
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
        toastr.warning(t`Message has no text content.`, 'CharMemory');
        return;
    }

    const edited = await callGenericPopup(t`Edit text to save as a memory:`, POPUP_TYPE.INPUT, plainText, { rows: 6 });
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

    const timestamp = getTimestamp();
    const chatId = context.chatId || 'unknown';

    const targets = getMemoryTargets();
    if (targets.length === 0) return;

    // In group chats, show a character picker pre-selected to the message sender
    let target;
    if (targets.length === 1) {
        target = targets[0];
    } else {
        const senderName = msg.name;
        const senderIdx = targets.findIndex(tgt => tgt.name === senderName);
        const defaultIdx = senderIdx >= 0 ? senderIdx : 0;
        const pickerHtml = targets.map((tgt, i) =>
            `<label class="checkbox_label"><input type="radio" name="charMemory_pinTarget" value="${i}" ${i === defaultIdx ? 'checked' : ''} /> ${escapeHtml(tgt.name)}</label>`,
        ).join('<br>');
        let selectedIdx = defaultIdx;
        $(document).on('change.pinPicker', 'input[name="charMemory_pinTarget"]', function () {
            selectedIdx = Number($(this).val()) || 0;
        });
        const picked = await callGenericPopup(t`Pin memory to which character?<br><br>${pickerHtml}`, POPUP_TYPE.CONFIRM);
        $(document).off('change.pinPicker');
        if (!picked) return;
        target = targets[selectedIdx];
    }
    if (!target) return;

    const existingContent = await readMemoriesForCharacter(target.avatar, target.fileName);
    const blocks = parseMemories(existingContent);
    blocks.push({ chat: chatId, date: timestamp, bullets });
    await writeMemoriesForCharacter(serializeMemories(blocks), target.avatar, target.fileName);

    const pinnedLabel = bullets.length === 1 ? t`${bullets.length} memory` : t`${bullets.length} memories`;
    const pinnedSuffix = targets.length > 1 ? t` to ${target.name}` : '';
    toastr.success(t`${pinnedLabel} pinned${pinnedSuffix}!`, 'CharMemory');
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
 * Compute a top offset that keeps a drawer below ST's top bar and track viewport
 * changes (pinch-zoom on mobile) so the offset stays correct.
 * @param {JQuery<HTMLElement>} $drawer - The drawer element.
 */
function positionDrawerBelowTopBar($drawer) {
    const apply = () => {
        const topBar = document.getElementById('top-settings-holder');
        const topOffset = topBar ? topBar.getBoundingClientRect().bottom : 0;
        $drawer.css({ top: topOffset + 'px', height: `calc(100vh - ${topOffset}px)` });
    };
    apply();

    // Re-apply on visualViewport resize (pinch-zoom, on-screen keyboard showing).
    // Guard against duplicate listeners — we only want one active per drawer.
    const key = `_charMemoryDrawerVvHandler_${$drawer.attr('id') || 'anon'}`;
    if (window.visualViewport && !window[key]) {
        window[key] = apply;
        window.visualViewport.addEventListener('resize', apply);
    }
}

/**
 * Sync the `--cm-drawer-width` CSS custom property and the `charMemory_drawerPushing`
 * body class so ST's chat panel (#sheld / #top-bar) re-centers into the leftover space
 * when a drawer is open. No-op (and class removed) when:
 *   - the user disabled `pushChatContent`
 *   - we're in phone-mode (drawer is forced full-screen)
 *   - no drawer is open
 *
 * Read the actual rendered width of whichever drawer is open so the chat tracks the
 * drawer exactly during a drag-to-resize, regardless of whether the saved width or
 * the CSS default is in effect.
 */
function syncChatPushFromDrawers() {
    const body = document.body;
    const inj = document.getElementById('charMemory_injectionDrawer');
    const log = document.getElementById('charMemory_logDrawer');
    const openDrawer = (inj && inj.classList.contains('open')) ? inj
        : (log && log.classList.contains('open')) ? log
            : null;

    const enabled = !!extension_settings[MODULE_NAME].pushChatContent;
    const phoneMode = body.classList.contains('charMemory-phone-mode');

    if (!openDrawer || !enabled || phoneMode) {
        body.classList.remove('charMemory_drawerPushing');
        body.style.removeProperty('--cm-drawer-width');
        return;
    }

    const w = openDrawer.getBoundingClientRect().width;
    body.style.setProperty('--cm-drawer-width', `${Math.round(w)}px`);
    body.classList.add('charMemory_drawerPushing');
}

/**
 * Apply a saved drawer width (in px) as an inline style, clamped to a sane range.
 * No-op if width is falsy (so the CSS default wins) or if the body is in phone-mode
 * (drawer is forced full-screen by CSS — overriding it would defeat that).
 * @param {JQuery<HTMLElement>} $drawer
 * @param {number} width
 */
function applyDrawerWidth($drawer, width) {
    if (!width || document.body.classList.contains('charMemory-phone-mode')) {
        $drawer.css('width', '');
        return;
    }
    const min = 320;
    const max = Math.max(min, Math.floor(window.innerWidth * 0.95));
    const clamped = Math.min(max, Math.max(min, Math.floor(width)));
    $drawer.css('width', clamped + 'px');
}

/**
 * Wire up drag-to-resize on a drawer's left-edge handle. The drawer is right-anchored
 * (`position: fixed; right: 0`), so the new width is `viewportWidth - clientX`.
 * Persists the chosen width to extension_settings under the given key.
 * @param {string} drawerId  e.g. 'charMemory_injectionDrawer'
 * @param {string} settingsKey  e.g. 'injectionDrawerWidth'
 */
function setupDrawerResize(drawerId, settingsKey) {
    const drawer = document.getElementById(drawerId);
    if (!drawer) return;
    const handle = drawer.querySelector('.charMemory_drawerResizeHandle');
    if (!handle) return;

    handle.addEventListener('pointerdown', (e) => {
        // Phone-mode forces 100vw — disable resize there.
        if (document.body.classList.contains('charMemory-phone-mode')) return;
        e.preventDefault();
        handle.setPointerCapture(e.pointerId);
        drawer.classList.add('charMemory_drawerResizing');
        document.body.classList.add('charMemory_drawerResizingActive');

        const onMove = (ev) => {
            const newWidth = window.innerWidth - ev.clientX;
            applyDrawerWidth($(drawer), newWidth);
            syncChatPushFromDrawers();
        };
        const onUp = (ev) => {
            handle.releasePointerCapture(ev.pointerId);
            handle.removeEventListener('pointermove', onMove);
            handle.removeEventListener('pointerup', onUp);
            handle.removeEventListener('pointercancel', onUp);
            drawer.classList.remove('charMemory_drawerResizing');
            document.body.classList.remove('charMemory_drawerResizingActive');
            // Save the resolved px width (may differ from raw drag due to clamping)
            const resolved = parseInt(drawer.style.width, 10) || 0;
            if (resolved > 0) {
                extension_settings[MODULE_NAME][settingsKey] = resolved;
                saveSettingsDebounced();
            }
        };
        handle.addEventListener('pointermove', onMove);
        handle.addEventListener('pointerup', onUp);
        handle.addEventListener('pointercancel', onUp);
    });

    // Double-click handle to reset to CSS default.
    handle.addEventListener('dblclick', () => {
        extension_settings[MODULE_NAME][settingsKey] = 0;
        $(drawer).css('width', '');
        saveSettingsDebounced();
    });
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

    // Close log drawer if opening injection drawer (same screen position)
    if (shouldOpen) $('#charMemory_logDrawer').removeClass('open');

    // Position drawer below ST's top bar so header isn't clipped by browser chrome
    if (shouldOpen) {
        positionDrawerBelowTopBar($drawer);
        applyDrawerWidth($drawer, extension_settings[MODULE_NAME].injectionDrawerWidth);
    }

    $drawer.toggleClass('open', shouldOpen);
    $toggle.toggleClass('open', shouldOpen);
    syncChatPushFromDrawers();

    // Persist state
    extension_settings[MODULE_NAME].injectionDrawerOpen = shouldOpen;
    saveSettingsDebounced();
}

/**
 * Toggle the log drawer open/closed.
 * @param {boolean} [forceState] If provided, force open (true) or closed (false).
 */
function toggleLogDrawer(forceState) {
    const $drawer = $('#charMemory_logDrawer');
    const isOpen = $drawer.hasClass('open');
    const shouldOpen = forceState !== undefined ? forceState : !isOpen;

    // Close injection drawer if opening log drawer (same screen position)
    // Log drawer state is not persisted — it's session-only, unlike the injection drawer
    if (shouldOpen) {
        $('#charMemory_injectionDrawer').removeClass('open');
        $('#charMemory_drawerToggle').removeClass('open');
    }

    // Position drawer below ST's top bar so header isn't clipped by browser chrome
    if (shouldOpen) {
        positionDrawerBelowTopBar($drawer);
        applyDrawerWidth($drawer, extension_settings[MODULE_NAME].logDrawerWidth);

        // Populate log entries and sync verbose toggle
        $('#charMemory_logDrawerVerbose').prop('checked', !!extension_settings[MODULE_NAME].verboseLogging);
        renderLogDrawerEntries();
    }

    $drawer.toggleClass('open', shouldOpen);
    syncChatPushFromDrawers();
}

/**
 * Whether the tablet panel is currently open.
 * @returns {boolean}
 */
function isTabletPanelOpen() {
    return $('#charMemory_tabletPanel').hasClass('open');
}

/**
 * Toggle the tablet floating panel open/closed.
 * When opening: relocates sidebar header icons and content into the panel.
 * When closing: moves everything back to the sidebar.
 * Event handlers survive because they are bound to the element IDs, not parent containers.
 * @param {boolean} [forceState] If provided, force open (true) or closed (false).
 */
function toggleTabletPanel(forceState) {
    const $panel = $('#charMemory_tabletPanel');
    const isOpen = $panel.hasClass('open');
    const shouldOpen = forceState !== undefined ? forceState : !isOpen;

    if (shouldOpen === isOpen) return;

    if (shouldOpen) {
        // Move header icons from sidebar to panel header
        const $icons = $('.charMemory_settings .inline-drawer-header .charMemory_headerGear');
        $icons.detach().appendTo('#charMemory_tabletHeaderIcons');

        // Move all inline-drawer-content children to the panel body
        const $content = $('.charMemory_settings .inline-drawer-content');
        $content.children().detach().appendTo('#charMemory_tabletBody');

        // Ensure the sidebar drawer is collapsed
        if ($content.is(':visible')) {
            $content.hide();
            $('.charMemory_settings .inline-drawer-icon').removeClass('up').addClass('down');
        }

        $panel.addClass('open');

        // Refresh stats in the relocated elements
        updateStatusDisplay();
        updateHealthIndicator();
    } else {
        // Move children back to sidebar
        const $sidebarContent = $('.charMemory_settings .inline-drawer-content');
        $('#charMemory_tabletBody').children().detach().appendTo($sidebarContent);

        // Move header icons back — insert before the chevron icon
        const $chevron = $('.charMemory_settings .inline-drawer-header .inline-drawer-icon');
        $('#charMemory_tabletHeaderIcons .charMemory_headerGear').detach().insertBefore($chevron);

        $panel.removeClass('open');
    }
}

/**
 * Render all log entries into the log drawer body.
 */
function renderLogDrawerEntries() {
    const $body = $('#charMemory_logDrawerBody');
    if (!$body.length) return;

    if (activityLog.length === 0) {
        $body.html(`<div class="charMemory_diagEmpty">${t`No activity yet.`}</div>`);
        return;
    }

    $body.html(activityLog.map(renderLogEntryHtml).join(''));
}

/**
 * Update the log drawer with a new entry if it is currently open.
 * Called from logActivity() for live updates.
 * @param {{timestamp: string, message: string, type: string}} entry The new log entry.
 */
function updateLogDrawer(entry) {
    const $drawer = $('#charMemory_logDrawer');
    if (!$drawer.hasClass('open')) return;

    const $body = $('#charMemory_logDrawerBody');
    if (!$body.length) return;

    // Remove empty-state placeholder if present
    $body.find('.charMemory_diagEmpty').remove();

    // Prepend since activityLog stores newest first
    $body.prepend(renderLogEntryHtml(entry));
}

/**
 * Show a popup with actionable tips for reducing injection token usage.
 */
/**
 * Render the full prompt token breakdown from ST's itemized prompt data.
 * @param {object} params Result of itemizedParams()
 * @returns {string} HTML string
 */
function renderPromptBreakdown(params) {
    const isOAI = params.this_main_api === 'openai';
    let categories = [];
    let total, maxCtx;

    if (isOAI) {
        total  = params.finalPromptTokens || 0;
        maxCtx = params.thisPrompt_max_context || null;
        // oaiPromptTokens includes char card + WI + scenario anchors; subtract WI to isolate char card
        const charCardTk = Math.max(0, (params.oaiPromptTokens || 0) - (params.worldInfoStringTokens || 0));
        categories = [
            { label: 'System',       tokens: params.oaiSystemTokens            || 0, color: '#7878aa' },
            { label: 'Char card',    tokens: charCardTk,                             color: '#5b8dd9' },
            { label: 'Lorebook',     tokens: params.worldInfoStringTokens       || 0, color: '#e8a33d' },
            { label: 'Data Bank',    tokens: params.dataBankVectorsStringTokens || 0, color: '#7c6bc9' },
            { label: 'Examples',     tokens: params.examplesStringTokens        || 0, color: '#6aaa64' },
            { label: 'Chat history', tokens: params.ActualChatHistoryTokens     || 0, color: '#4a8fa8' },
        ];
    } else {
        total  = params.totalTokensInPrompt || 0;
        maxCtx = params.thisPrompt_max_context || null;
        categories = [
            { label: 'Char card',    tokens: params.storyStringTokens      || 0, color: '#5b8dd9' },
            { label: 'Lorebook',     tokens: params.worldInfoStringTokens   || 0, color: '#e8a33d' },
            { label: 'Anchors',      tokens: params.allAnchorsTokens        || 0, color: '#7878aa' },
            { label: 'Examples',     tokens: params.examplesStringTokens    || 0, color: '#6aaa64' },
            { label: 'Chat history', tokens: params.ActualChatHistoryTokens || 0, color: '#4a8fa8' },
        ];
    }

    const active = categories.filter(c => c.tokens > 0);
    let html = '';

    // Bar: segments sized relative to context window so unused context shows as grey
    const barBase = (maxCtx && maxCtx > total) ? maxCtx : (total || 1);
    if (total > 0) {
        html += '<div class="charMemory_fullPromptBar">';
        for (const cat of active) {
            const pct = ((cat.tokens / barBase) * 100).toFixed(2);
            const pctOfTotal = ((cat.tokens / total) * 100).toFixed(1);
            html += `<div class="charMemory_tokenBarSeg" style="width:${pct}%;background:${escapeHtml(cat.color)};" title="${escapeHtml(cat.label)}: ${cat.tokens.toLocaleString()} tk (${pctOfTotal}% of prompt)"></div>`;
        }
        html += '</div>';
    }

    // Summary line: total / context and %
    const usedPct = (maxCtx && total) ? Math.round((total / maxCtx) * 100) : null;
    const maxStr = maxCtx ? ` / ${maxCtx.toLocaleString()} tk` : '';
    const pctStr = usedPct !== null ? ` — ${usedPct}% of context used` : '';
    html += `<div class="charMemory_fullPromptSummary">${total.toLocaleString()}${maxStr} tk${escapeHtml(pctStr)}</div>`;

    // Breakdown table: % of context window if available, else % of total
    html += '<div class="charMemory_tokenBreakdown" style="margin-top:4px;">';
    for (const cat of active) {
        const pct = maxCtx
            ? ((cat.tokens / maxCtx) * 100).toFixed(1) + '% of ctx'
            : ((cat.tokens / (total || 1)) * 100).toFixed(1) + '% of total';
        html += '<div class="charMemory_tokenRow">';
        html += `<span class="charMemory_tokenDot" style="background:${escapeHtml(cat.color)};"></span>`;
        html += `<span>${escapeHtml(cat.label)}</span>`;
        html += `<span>${cat.tokens.toLocaleString()} tk (${pct})</span>`;
        html += '</div>';
    }
    html += `<div class="charMemory_tokenRow charMemory_tokenRow--total"><span></span><span>Total</span><span>${total.toLocaleString()} tk</span></div>`;
    html += '</div>';

    // Footer: model + tokenizer + tips link
    const meta = [params.modelUsed, params.selectedTokenizer ? `tokenizer: ${params.selectedTokenizer}` : ''].filter(Boolean).join(' · ');
    const metaStr = meta ? `${escapeHtml(meta)} &middot; ` : '';
    html += `<div class="charMemory_tokenNote" style="margin-top:6px;">${metaStr}<span class="charMemory_tokenTipsLink">Tips to reduce <i class="fa-solid fa-circle-question fa-xs"></i></span></div>`;

    return html;
}

/**
 * Render an estimated token breakdown from snapshot data (for old messages without itemized prompt data).
 * @param {object} snapshot Injection snapshot from chat_metadata
 * @returns {string} HTML string
 */
function renderEstimatedBreakdown(snapshot) {
    const td = snapshot.tokenData;
    const memTk = estimateTokens(td?.charMemoryChars || 0);
    const wiTk  = estimateTokens(td?.wiChars || 0);
    const otherEpChars = Object.entries(td?.epCharCounts || {})
        .filter(([k]) => k !== '4_vectors_data_bank')
        .reduce((sum, [, v]) => sum + v, 0);
    const otherEpTk = estimateTokens(otherEpChars);
    const total = memTk + wiTk + otherEpTk;
    const maxCtx = td?.contextMaxTokens || null;

    const cats = [
        { label: 'Data Bank', tokens: memTk, color: '#7c6bc9' },
        { label: 'Lorebook',  tokens: wiTk,  color: '#e8a33d' },
        { label: 'Other extensions', tokens: otherEpTk, color: '#4a8fa8' },
    ].filter(c => c.tokens > 0);

    let html = '';
    const barBase = (maxCtx && maxCtx > total) ? maxCtx : (total || 1);
    if (total > 0) {
        html += '<div class="charMemory_fullPromptBar">';
        for (const cat of cats) {
            const pct = ((cat.tokens / barBase) * 100).toFixed(2);
            const pctOfTotal = ((cat.tokens / total) * 100).toFixed(1);
            html += `<div class="charMemory_tokenBarSeg" style="width:${pct}%;background:${escapeHtml(cat.color)};" title="${escapeHtml(cat.label)}: ~${cat.tokens.toLocaleString()} tk (${pctOfTotal}% of injections)"></div>`;
        }
        html += '</div>';
    }

    const usedPct = (maxCtx && total) ? Math.round((total / maxCtx) * 100) : null;
    const ctxStr = maxCtx ? ` / ${maxCtx.toLocaleString()} tk` : '';
    const pctStr = usedPct !== null ? ` — ~${usedPct}% of context (injections only)` : '';
    html += `<div class="charMemory_fullPromptSummary">~${total.toLocaleString()}${ctxStr} tk${escapeHtml(pctStr)}</div>`;

    html += '<div class="charMemory_tokenBreakdown" style="margin-top:4px;">';
    for (const cat of cats) {
        const pct = maxCtx
            ? '~' + ((cat.tokens / maxCtx) * 100).toFixed(1) + '% of ctx'
            : '~' + ((cat.tokens / (total || 1)) * 100).toFixed(1) + '%';
        html += '<div class="charMemory_tokenRow">';
        html += `<span class="charMemory_tokenDot" style="background:${escapeHtml(cat.color)};"></span>`;
        html += `<span>${escapeHtml(cat.label)}</span>`;
        html += `<span>~${cat.tokens.toLocaleString()} tk (${pct})</span>`;
        html += '</div>';
    }
    const totalStr = maxCtx
        ? `~${total.toLocaleString()} / ${maxCtx.toLocaleString()}`
        : `~${total.toLocaleString()}`;
    html += `<div class="charMemory_tokenRow charMemory_tokenRow--total"><span></span><span>Total tracked</span><span>${totalStr} tk</span></div>`;
    html += '</div>';

    html += '<div class="charMemory_tokenNote" style="margin-top:6px;">Estimated injection tokens (~4 chars/token). '
        + 'Char card, system prompt, and chat history not included — Prompt Itemization was unavailable for this message. '
        + '<span class="charMemory_tokenTipsLink">Tips <i class="fa-solid fa-circle-question fa-xs"></i></span></div>';
    return html;
}

function showTokenTipsPopup() {
    const section = (title, color, items) => {
        const bullets = items.map(([label, detail]) =>
            `<li style="margin-bottom:6px;"><strong>${label}</strong> — ${detail}</li>`
        ).join('');
        return `
            <div style="margin-bottom:14px;">
                <div style="font-weight:bold;margin-bottom:6px;display:flex;align-items:center;gap:6px;">
                    <span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${color};flex-shrink:0;"></span>
                    ${title}
                </div>
                <ul style="margin:0;padding-left:18px;line-height:1.5;">${bullets}</ul>
            </div>`;
    };

    const html = `<div style="max-width:420px;font-size:0.9em;text-align:left;">
        <h4 style="margin:0 0 14px;">Optimizing Token Usage</h4>
        <p style="opacity:0.65;margin:0 0 14px;font-size:0.9em;">
            Each category in the Prompt Breakdown competes for the same context window.
            Reducing any one of them leaves more room for chat history and the model's reply.
        </p>
        ${section('Char Card / System Prompt', '#5b8dd9', [
            ['Shorten the description', 'The character description, personality, and scenario fields are injected every generation — keep them focused on what\'s relevant to the RP rather than exhaustive world-building.'],
            ['Move lore to the Lorebook', 'Details that are only relevant in certain situations (locations, side characters, history) belong in the Lorebook, where they only activate when triggered.'],
            ['Trim the system prompt', 'Long system / author\'s notes prompts add up quickly. Cut any instructions the model already follows by default.'],
        ])}
        ${section('Data Bank', '#7c6bc9', [
            ['Consolidate', 'Use the <strong>Consolidate</strong> button on the dashboard to compress memories into fewer, denser bullets.'],
            ['Retrieve chunks', 'Lower <strong>Vector Storage → Data Bank files → Retrieve chunks</strong> to inject fewer chunks per generation. Also raise <strong>Score threshold</strong> to filter out low-relevance results.'],
            ['Per-chat isolation', 'Enable <strong>Settings → Storage → Per-chat isolation</strong> so only memories from the current chat are retrieved, not the entire character file.'],
            ['Edit the memory file', 'Open the memory file via <strong>Troubleshooter → Data Bank</strong> and manually trim verbose or redundant bullets.'],
        ])}
        ${section('Lorebook', '#e8a33d', [
            ['Shorten entry content', 'The full text of each triggered entry is injected verbatim — keep entries concise.'],
            ['More specific keywords', 'Broad trigger keywords activate entries unnecessarily; tighten them to reduce spurious activations.'],
            ['Token budget', 'Use ST\'s built-in <strong>Lorebook → Token budget</strong> setting to cap total WI injection size.'],
            ['Disable idle entries', 'Disable lorebook entries that aren\'t relevant to the current story arc.'],
        ])}
        ${section('Other Extensions', '#4a8fa8', [
            ['Identify heavy injectors', 'The <strong>Extension Prompts</strong> section shows each extension\'s name and estimated token cost.'],
            ['Disable unused extensions', 'Many extensions inject a system prompt even when idle — disable ones you\'re not actively using.'],
            ['Per-extension settings', 'Most extensions have their own injection size controls (e.g. Summary max tokens, memory depth).'],
        ])}
        ${section('Overall', 'rgba(128,128,128,0.4)', [
            ['Expand context window', 'Increase the model\'s <strong>Max context</strong> setting if the model supports a larger window.'],
            ['Reduce response tokens', 'Lowering <strong>Max response tokens</strong> reserves less space for output, freeing more for injections and history.'],
            ['Use a larger model', 'Switch to a model with a bigger context window (32k, 128k) to accommodate injections without crowding out chat history.'],
        ])}
    </div>`;

    callGenericPopup(html, POPUP_TYPE.TEXT, '', { wide: false, allowVerticalScrolling: true });
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
        $body.html('<div class="charMemory_diagEmpty" data-i18n="No injection data recorded for this message.">No injection data recorded for this message.</div>');
        $toolbar.html('');
        toggleInjectionDrawer(true);
        return;
    }

    let html = '';

    // ── Prompt Breakdown section (auto-loaded) ───────────────────────────
    const td = snapshot.tokenData;
    const memTokens   = estimateTokens(td?.charMemoryChars || 0);
    const wiTokens    = estimateTokens(td?.wiChars || 0);
    const otherEpChars = Object.entries(td?.epCharCounts || {})
        .filter(([k]) => k !== '4_vectors_data_bank')
        .reduce((sum, [, v]) => sum + v, 0);
    const otherEpTokens = estimateTokens(otherEpChars);

    html += '<div class="charMemory_drawerSection">';
    html += '<div class="charMemory_drawerSectionHeader" data-section="promptbreakdown">';
    html += '<i class="fa-solid fa-chevron-down charMemory_drawerChevron"></i> ';
    html += '<strong data-i18n="Context">Context</strong>';
    html += '</div>';
    html += '<div class="charMemory_drawerSectionBody charMemory_promptBreakdownBody">';
    html += '<div class="charMemory_diagEmpty"><i class="fa-solid fa-spinner fa-spin fa-sm"></i> <span data-i18n="Loading…">Loading…</span></div>';
    html += '</div></div>';

    // ── Per-message health notes ──────────────────────────────────────────
    const memCount = snapshot.memories?.length || 0;
    if (memCount === 0) {
        html += '<div class="charMemory_drawerHealthNote charMemory_drawerHealthNote--yellow">'
            + '<i class="fa-solid fa-circle-info fa-xs"></i> No memories matched this message. '
            + 'This is normal when the conversation topic doesn\'t relate to stored memories.'
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

    // ── CharMemory section ────────────────────────────────────────────────
    html += '<div class="charMemory_drawerSection">';
    html += '<div class="charMemory_drawerSectionHeader" data-section="memories">';
    html += '<i class="fa-solid fa-chevron-down charMemory_drawerChevron"></i> ';
    html += `<strong data-i18n="Data Bank">Data Bank</strong> <span class="charMemory_drawerCount">(${memCount})</span>`;
    if (memTokens > 0) html += `<span class="charMemory_drawerTokenHint">~${memTokens.toLocaleString()} tk</span>`;
    html += '</div>';
    html += '<div class="charMemory_drawerSectionBody">';
    if (memCount > 0) {
        for (const mem of snapshot.memories) {
            html += `<div class="charMemory_drawerBullet">- ${escapeHtml(mem.text)}</div>`;
        }
    } else {
        html += '<div class="charMemory_diagEmpty" data-i18n="No memories injected">No memories injected</div>';
    }
    html += '</div></div>';

    // ── Lorebook Entries section ──────────────────────────────────────────
    const wiCount = snapshot.worldInfo?.length || 0;
    html += '<div class="charMemory_drawerSection">';
    html += '<div class="charMemory_drawerSectionHeader" data-section="worldinfo">';
    html += '<i class="fa-solid fa-chevron-down charMemory_drawerChevron"></i> ';
    html += `<strong data-i18n="Lorebook Entries">Lorebook Entries</strong> <span class="charMemory_drawerCount">(${wiCount})</span>`;
    if (wiTokens > 0) html += `<span class="charMemory_drawerTokenHint">~${wiTokens.toLocaleString()} tk</span>`;
    html += '</div>';
    html += '<div class="charMemory_drawerSectionBody">';
    if (wiCount > 0) {
        for (const entry of snapshot.worldInfo) {
            const entryTk = estimateTokens(entry.content?.length || 0);
            html += '<div class="charMemory_drawerCard">';
            html += `<div class="charMemory_drawerCardTitle">${escapeHtml(entry.comment)}</div>`;
            if (entry.keys?.length > 0) {
                html += `<div class="charMemory_drawerCardKeys">Keys: ${escapeHtml(entry.keys.join(', '))}</div>`;
            }
            html += `<div class="charMemory_drawerCardMeta">~${entryTk.toLocaleString()} tk</div>`;
            if (entry.content) {
                html += `<div class="charMemory_drawerCardContent">${escapeHtml(entry.content)}${entry.content.length >= 200 ? '...' : ''}</div>`;
            }
            html += '</div>';
        }
    } else {
        html += '<div class="charMemory_diagEmpty" data-i18n="No lorebook entries activated">No lorebook entries activated</div>';
    }
    html += '</div></div>';

    // ── Extension Prompts section ─────────────────────────────────────────
    const epCount = snapshot.extensionPrompts?.length || 0;
    const epPositionLabel = (position, depth) => {
        const names = { 0: 'before prompt', 1: 'after system', 2: 'before messages', 3: 'in-chat', 4: 'before reply' };
        const label = names[position] ?? `pos ${position}`;
        return typeof depth === 'number' ? `${label} @ depth ${depth}` : label;
    };
    html += '<div class="charMemory_drawerSection">';
    html += '<div class="charMemory_drawerSectionHeader" data-section="prompts">';
    html += '<i class="fa-solid fa-chevron-down charMemory_drawerChevron"></i> ';
    html += `<strong data-i18n="Extension Prompts">Extension Prompts</strong> <span class="charMemory_drawerCount">(${epCount})</span>`;
    if (otherEpTokens > 0) html += `<span class="charMemory_drawerTokenHint">~${otherEpTokens.toLocaleString()} tk</span>`;
    html += '</div>';
    html += '<div class="charMemory_drawerSectionBody">';
    if (epCount > 0) {
        for (const prompt of snapshot.extensionPrompts) {
            const rawChars = td?.epCharCounts?.[prompt.label] ?? prompt.content.length;
            const promptTk = estimateTokens(rawChars);
            const posLabel = prompt.position !== undefined
                ? epPositionLabel(prompt.position, prompt.depth) : '';
            const isTruncated = prompt.label !== '4_vectors_data_bank' && prompt.content.length >= 500;
            html += '<div class="charMemory_drawerCard">';
            html += `<div class="charMemory_drawerCardTitle">${escapeHtml(prompt.label)}</div>`;
            html += `<div class="charMemory_drawerCardMeta">~${promptTk.toLocaleString()} tk${posLabel ? ' · ' + escapeHtml(posLabel) : ''}</div>`;
            html += `<div class="charMemory_drawerCardContent" style="white-space:pre-wrap;">${escapeHtml(prompt.content)}${isTruncated ? '...' : ''}</div>`;
            html += '</div>';
        }
    } else {
        html += '<div class="charMemory_diagEmpty" data-i18n="No extension prompts active">No extension prompts active</div>';
    }
    html += '</div></div>';


    $body.html(html);

    // Auto-load prompt breakdown
    (async () => {
        const $pbBody = $body.find('.charMemory_promptBreakdownBody');
        try {
            const idx = itemizedPrompts.findIndex(x => Number(x.mesId) === messageIndex);
            if (idx !== -1) {
                const params = await itemizedParams(itemizedPrompts, idx, messageIndex);
                $pbBody.html(renderPromptBreakdown(params));
            } else {
                $pbBody.html(renderEstimatedBreakdown(snapshot));
            }
        } catch (err) {
            console.error(LOG_PREFIX, 'Failed to load prompt breakdown:', err);
            $pbBody.html('<div class="charMemory_diagEmpty">Error computing token counts.</div>');
        }
    })();

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

/**
 * Show a standalone batch extraction popup with chat list and controls.
 * Re-uses the same element IDs as the old sidebar so loadBatchChatList()
 * and runBatchExtraction() work without modification.
 */
async function showBatchPopup() {
    const charName = getCharacterName();
    if (!charName) {
        toastr.warning(t`No character selected.`, 'CharMemory');
        return;
    }

    const batchHtml = `
        <div style="text-align:left;min-width:350px;">
            <div class="charMemory_buttonRow">
                <input type="button" id="charMemory_batchRefresh" class="menu_button" value="Refresh" data-i18n="[value]Refresh;[title]Load chat list for this character" title="Load chat list for this character" />
                <input type="button" id="charMemory_batchExtract" class="menu_button" value="Extract Selected" data-i18n="[value]Extract Selected;[title]Run extraction on all selected chats" title="Run extraction on all selected chats" disabled />
                <input type="button" id="charMemory_batchStop" class="menu_button" value="Stop" data-i18n="[value]Stop;[title]Cancel batch extraction" title="Cancel batch extraction" style="display:none;" />
            </div>
            <div id="charMemory_batchProgress" class="charMemory_batchProgress" style="display:none;">
                <div class="charMemory_batchProgressText"></div>
                <div class="charMemory_batchProgressBar"><div class="charMemory_batchProgressFill"></div></div>
            </div>
            <div class="charMemory_sectionHeader">
                <small><b title="Chat files attached to this character. Select which ones to extract memories from." data-i18n="[title]Chat files attached to this character. Select which ones to extract memories from.">Character Chats</b></small>
                <label class="checkbox_label">
                    <input type="checkbox" id="charMemory_batchSelectAll" />
                    <small data-i18n="Select all">Select all</small>
                </label>
            </div>
            <div id="charMemory_batchChatList" class="charMemory_batchChatList" style="max-height:400px;">
                <div class="charMemory_diagEmpty">Loading...</div>
            </div>
        </div>
    `;

    // Show the popup (non-blocking)
    const popup = callGenericPopup(batchHtml, POPUP_TYPE.TEXT, t`Batch Extraction`, { wide: true, okButton: t`Close` });

    // Wire batch controls after DOM is inserted
    setTimeout(() => {
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
        $(document).off('change.batchPopup', '.charMemory_batchChatCheck')
            .on('change.batchPopup', '.charMemory_batchChatCheck', updateBatchButtons);

        // Auto-load
        loadBatchChatList();
    }, 100);

    await popup;
}

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
        t`Extract memories from ${selected.length} chat(s)? This may make multiple API calls per chat.`,
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
            <div class="charMemory_drawerResizeHandle" data-drawer="injection" title="Drag to resize"></div>
            <div class="charMemory_drawerHeader">
                <i class="fa-solid fa-circle" id="charMemory_drawerHealthDot" title="Injection health" style="font-size:10px;"></i>
                <span class="charMemory_drawerTitle" data-i18n="Injected Context">Injected Context</span>
                <span class="charMemory_drawerMsgLabel" id="charMemory_drawerMsgLabel"></span>
                <div class="charMemory_drawerClose" id="charMemory_drawerClose" title="Close" data-i18n="[title]Close"><i class="fa-solid fa-xmark"></i></div>
            </div>
            <div class="charMemory_drawerToolbar" id="charMemory_drawerToolbar"></div>
            <div class="charMemory_drawerBody" id="charMemory_drawerBody">
                <div class="charMemory_diagEmpty" data-i18n="Click the syringe icon on a message to view its injected context.">Click the <i class="fa-solid fa-syringe"></i> icon on a message to view its injected context.</div>
            </div>
            <div class="charMemory_drawerFooter" id="charMemory_drawerFooter"></div>
        </div>
        <div id="charMemory_drawerBackdrop" class="charMemory_drawerBackdrop"></div>
        <div id="charMemory_drawerToggle" class="charMemory_drawerToggle" title="Toggle injection viewer" data-i18n="[title]Toggle injection viewer">
            <i class="fa-solid fa-syringe"></i>
        </div>
    `);

    // Log drawer — appended to body, outside extension panel
    $('body').append(`
        <div id="charMemory_logDrawer" class="charMemory_logDrawer">
            <div class="charMemory_drawerResizeHandle" data-drawer="log" title="Drag to resize"></div>
            <div class="charMemory_drawerHeader">
                <span class="charMemory_drawerTitle" data-i18n="Activity Log">Activity Log</span>
                <div style="display:flex; gap:6px; align-items:center; margin-left:auto;">
                    <label class="checkbox_label" style="font-size:0.85em;">
                        <input type="checkbox" id="charMemory_logDrawerVerbose" />
                        <span data-i18n="Verbose">Verbose</span>
                    </label>
                    <button id="charMemory_logDrawerClear" class="menu_button" style="font-size:0.8em; padding:2px 8px;" data-i18n="Clear">Clear</button>
                    <button id="charMemory_logDrawerSave" class="menu_button" style="font-size:0.8em; padding:2px 8px;" data-i18n="Save">Save</button>
                    <div class="charMemory_drawerClose" id="charMemory_logDrawerClose" title="Close" data-i18n="[title]Close"><i class="fa-solid fa-xmark"></i></div>
                </div>
            </div>
            <div class="charMemory_drawerBody" id="charMemory_logDrawerBody">
                <div class="charMemory_diagEmpty" data-i18n="No activity yet.">No activity yet.</div>
            </div>
        </div>
    `);

    // Tablet mode floating panel — appended to body, hidden by default
    $('body').append(`
        <div id="charMemory_tabletPanel" class="charMemory_tabletPanel">
            <div class="charMemory_tabletHeader">
                <b>CharMemory</b>
                <div id="charMemory_tabletHeaderIcons" class="charMemory_tabletHeaderIcons"></div>
                <div class="charMemory_drawerClose" id="charMemory_tabletClose" title="Close" data-i18n="[title]Close">
                    <i class="fa-solid fa-xmark"></i>
                </div>
            </div>
            <div id="charMemory_tabletBody" class="charMemory_tabletBody"></div>
        </div>
    `);

    loadSettings();
    setupListeners();
    registerSlashCommands();

    // Setup Wizard: auto-trigger on first launch
    if (!extension_settings[MODULE_NAME].wizardCompleted) {
        showSetupWizard(1);
    }

    // Dashboard wizard button
    $('#charMemory_openWizard').on('click', function () {
        showSetupWizard(1);
    });

    // Nudge banner: View button opens troubleshooter health checks
    $('#charMemory_nudgeFix').on('click', function () {
        showTroubleshooter('health');
    });

    // Event hooks
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onCharacterMessageRendered);
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    eventSource.on(event_types.GENERATION_STARTED, () => {
        isGenerating = true;
    });
    eventSource.on(event_types.GENERATION_ENDED, () => {
        isGenerating = false;
        if (pendingExtraction) {
            pendingExtraction = false;
            logActivity('Running deferred extraction now that generation ended');
            extractMemories({ force: false });
        }
    });
    eventSource.on(event_types.GENERATION_STOPPED, () => {
        isGenerating = false;
        // Don't auto-run deferred extraction after user abort — they may want to edit and retry.
        pendingExtraction = false;
    });

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

    // Log drawer controls
    $('#charMemory_logDrawerClose').on('click', () => toggleLogDrawer(false));
    $('#charMemory_logDrawerClear').on('click', function () {
        activityLog = [];
        updateActivityLogDisplay();
        renderLogDrawerEntries();
    });
    $('#charMemory_logDrawerSave').on('click', function () {
        if (activityLog.length === 0) {
            toastr.info(t`Activity log is empty.`, 'CharMemory');
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
    $('#charMemory_logDrawerVerbose').on('change', function () {
        extension_settings[MODULE_NAME].verboseLogging = !!$(this).prop('checked');
        saveSettingsDebounced();
    });
    // "View full log" link (wired from sidebar dashboard, Task 5)
    $(document).on('click', '#charMemory_viewFullLog', () => toggleLogDrawer(true));

    // Swipe left to close log drawer (touch devices)
    const logDrawerEl = document.getElementById('charMemory_logDrawer');
    if (logDrawerEl) {
        let logTouchStartX = 0;
        logDrawerEl.addEventListener('touchstart', (e) => {
            logTouchStartX = e.touches[0].clientX;
        }, { passive: true });
        logDrawerEl.addEventListener('touchend', (e) => {
            const deltaX = e.changedTouches[0].clientX - logTouchStartX;
            if (deltaX > 60) toggleLogDrawer(false);
        }, { passive: true });
    }

    // Tablet panel controls
    $('#charMemory_tabletClose').on('click', () => toggleTabletPanel(false));

    // Tap outside panel to dismiss (non-modal: doesn't block underlying tap)
    $(document).off('click.tabletPanelClose').on('click.tabletPanelClose', function (e) {
        if (!isTabletPanelOpen()) return;
        // Don't close if an ST popup/modal is currently visible (their backdrop is outside the panel)
        if ($('.popup:visible').length) return;
        if (!$(e.target).closest('#charMemory_tabletPanel').length) {
            toggleTabletPanel(false);
        }
    });

    // Swipe down to dismiss tablet panel (touch devices)
    const tabletPanelEl = document.getElementById('charMemory_tabletPanel');
    if (tabletPanelEl) {
        let tabletTouchStartY = 0;
        tabletPanelEl.addEventListener('touchstart', (e) => {
            tabletTouchStartY = e.touches[0].clientY;
        }, { passive: true });
        tabletPanelEl.addEventListener('touchend', (e) => {
            const deltaY = e.changedTouches[0].clientY - tabletTouchStartY;
            if (deltaY > 80) toggleTabletPanel(false);
        }, { passive: true });
    }

    // Drawer "Open Diagnostics" link — opens extension panel and scrolls to diagnostics
    // Drawer "Diagnostics" link — touch devices get an inline popup, desktop navigates to the panel
    $(document).on('click', '.charMemory_drawerDiagLink', async function () {
        const isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;

        if (isTouchDevice) {
            // Show health summary inline in the drawer body
            const result = await computeHealthScore();
            let html = '<div class="charMemory_drawerHealthPopup">';
            html += '<div class="charMemory_drawerSectionHeader" style="cursor:default;">';
            html += '<strong>Injection Health</strong></div>';
            if (result.level === 'unknown') {
                html += '<div class="charMemory_diagEmpty">No character selected or no data available.</div>';
            } else if (result.checks.length === 0) {
                html += '<div class="charMemory_diagEmpty">No checks to run.</div>';
            } else {
                for (const check of result.checks) {
                    const icon = check.level === 'green' ? 'fa-circle-check'
                        : check.level === 'yellow' ? 'fa-triangle-exclamation' : 'fa-circle-xmark';
                    const color = check.level === 'green' ? '#4a4'
                        : check.level === 'yellow' ? '#e8a33d' : '#c44';
                    html += `<div style="padding:4px 8px;display:flex;gap:6px;align-items:start;">`;
                    html += `<i class="fa-solid ${icon}" style="color:${color};margin-top:2px;flex-shrink:0;"></i>`;
                    html += `<div><strong>${escapeHtml(check.label)}</strong><br>`;
                    html += `<span style="opacity:0.7;font-size:0.9em;">${escapeHtml(check.detail)}</span></div>`;
                    html += `</div>`;
                }
            }
            html += '<div style="padding:6px 8px;font-size:0.8em;opacity:0.5;">';
            html += 'Full diagnostics: Extensions \u2192 Character Memory \u2192 Diagnostics</div>';
            html += '</div>';

            // Insert at top of drawer body
            const $popup = $('#charMemory_drawerBody .charMemory_drawerHealthPopup');
            if ($popup.length) {
                $popup.remove(); // Toggle off if already showing
            } else {
                $('#charMemory_drawerBody').prepend(html);
            }
            return;
        }

        // Desktop: open troubleshooter health checks
        showTroubleshooter('health');
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

    // Token tips link in the budget breakdown
    $(document).on('click', '.charMemory_tokenTipsLink', function (e) {
        e.stopPropagation(); // don't trigger section collapse
        showTokenTipsPopup();
    });



    // Restore drawer state from settings (skip on narrow viewports — drawer would cover the whole screen)
    const isNarrow = window.matchMedia('(max-width: 768px)').matches;
    if (extension_settings[MODULE_NAME].injectionDrawerOpen && !isNarrow) {
        toggleInjectionDrawer(true);
    }

    // Drag-to-resize on both drawers (left-edge handle, persisted to settings)
    setupDrawerResize('charMemory_injectionDrawer', 'injectionDrawerWidth');
    setupDrawerResize('charMemory_logDrawer', 'logDrawerWidth');

    // Apply display mode body class (for phone-mode CSS overrides)
    applyDisplayModeClass();
    window.addEventListener('resize', () => {
        applyDisplayModeClass();
        // Re-clamp saved widths against the new viewport for any open drawer.
        const $inj = $('#charMemory_injectionDrawer');
        if ($inj.hasClass('open')) {
            applyDrawerWidth($inj, extension_settings[MODULE_NAME].injectionDrawerWidth);
        }
        const $log = $('#charMemory_logDrawer');
        if ($log.hasClass('open')) {
            applyDrawerWidth($log, extension_settings[MODULE_NAME].logDrawerWidth);
        }
        syncChatPushFromDrawers();
    });

    console.log(LOG_PREFIX, 'Extension loaded');
});
