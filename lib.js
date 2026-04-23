/**
 * CharMemory — Pure utility functions.
 *
 * This module contains all side-effect-free functions extracted from index.js
 * so they can be independently tested. Nothing here touches the DOM,
 * SillyTavern globals, or network.
 */

// ─── XML attribute escaping ────────────────────────────────────────────

export function escapeAttr(text) {
    return String(text).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

export function unescapeAttr(text) {
    return String(text).replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

// ─── HTML escaping ─────────────────────────────────────────────────────

export function escapeHtml(text) {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// ─── Memory parsing ────────────────────────────────────────────────────

/**
 * Parse <memory> blocks from raw markdown content.
 * @param {string} content Raw file content.
 * @returns {{chat: string, date: string, bullets: string[]}[]}
 */
export function parseMemories(content) {
    if (!content || !content.trim()) return [];

    const blocks = [];
    const regex = /<memory\b([^>]*)>([\s\S]*?)<\/memory>/gi;
    let match;

    while ((match = regex.exec(content)) !== null) {
        const attrs = match[1];
        const body = match[2];

        const chatMatch = attrs.match(/chat="([^"]*)"/);
        const dateMatch = attrs.match(/date="([^"]*)"/);
        const chat = chatMatch ? unescapeAttr(chatMatch[1]) : 'unknown';
        const date = dateMatch ? unescapeAttr(dateMatch[1]) : '';

        const bullets = body.split('\n')
            .map(line => line.trim())
            .filter(line => line.startsWith('- ') || /^\[.*?\]\s*-\s/.test(line))
            .map(line => {
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
 * Split a bullet array containing multiple topic tags into separate arrays.
 * Topic tags match the "[Names — description]" pattern (em dash, en dash, or hyphen
 * surrounded by spaces). If 0 or 1 topic tags, returns the original array unchanged.
 * @param {string[]} bullets Array of bullet strings (without "- " prefix)
 * @returns {string[][]} Array of bullet arrays, one per topic-tagged section
 */
export function splitMultiTagBullets(bullets) {
    if (bullets.length === 0) return [bullets];

    const isTopicTag = b => /^\[.+ [—–\-] .+\]$/.test(b);
    const tagIndices = [];
    for (let i = 0; i < bullets.length; i++) {
        if (isTopicTag(bullets[i])) tagIndices.push(i);
    }

    if (tagIndices.length <= 1) return [bullets];

    const groups = [];
    for (let i = 0; i < tagIndices.length; i++) {
        const start = i === 0 ? 0 : tagIndices[i];
        const end = i + 1 < tagIndices.length ? tagIndices[i + 1] : bullets.length;
        groups.push(bullets.slice(start, end));
    }

    return groups;
}

/**
 * Count total individual memories (bullets) across all blocks.
 * @param {{bullets: string[]}[]} blocks Parsed memory blocks.
 * @returns {number}
 */
export function countMemories(blocks) {
    return blocks.reduce((sum, b) => sum + b.bullets.length, 0);
}

// ─── Memory serialization ──────────────────────────────────────────────

const DEFAULT_FORMAT = { boundary: 'block', separator: '\n\n', metadata: false };

/**
 * Serialize an array of memory blocks back to <memory> tag format.
 * @param {{chat: string, date: string, bullets: string[]}[]} blocks
 * @param {{boundary: string, separator: string, metadata: boolean}} [format]
 * @returns {string}
 */
export function serializeMemories(blocks, format) {
    const fmt = format || DEFAULT_FORMAT;

    if (fmt.boundary === 'bullet') {
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

    // Default block-level
    return blocks.map(b => {
        const bulletsText = b.bullets.map(bullet => `- ${bullet}`).join('\n');
        return `<memory chat="${escapeAttr(b.chat)}" date="${escapeAttr(b.date)}">\n${bulletsText}\n</memory>`;
    }).join('\n\n');
}

// ─── Memory block merging ──────────────────────────────────────────────

/**
 * Merge memory blocks that share the same chat ID.
 * @param {{chat: string, date: string, bullets: string[]}[]} blocks
 * @returns {{chat: string, date: string, bullets: string[]}[]}
 */
export function mergeMemoryBlocks(blocks) {
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

// ─── Format detection & migration ──────────────────────────────────────

/**
 * Migrate old memory formats to <memory> tag format if needed.
 * @param {string} content Existing file content.
 * @returns {string} Content in <memory> tag format.
 */
export function migrateMemoriesIfNeeded(content) {
    if (!content || !content.trim()) return content;

    if (/<memory\b[^>]*>/i.test(content)) return content;

    const timestamp = getTimestamp();

    if (/^## Memory \d+/m.test(content)) {
        const parts = content.split(/^## Memory \d+\s*$/m);
        const blocks = [];

        for (let i = 1; i < parts.length; i++) {
            const part = parts[i].trim();
            if (!part) continue;

            let date = timestamp;
            let text = part;

            const tsMatch = part.match(/^_Extracted:\s*(.+?)_\s*\n/);
            if (tsMatch) {
                date = tsMatch[1].trim();
                text = part.slice(tsMatch[0].length).trim();
            }

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
export function detectFileFormat(content) {
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
export function convertHeuristic(content, format) {
    const today = getTimestamp();
    const warnings = [];

    if (format === 'memory_tags') {
        warnings.push('Already in CharMemory format \u2014 no conversion needed.');
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
    warnings.push('Freeform text detected \u2014 results may be rough. Consider using LLM restructuring for better quality.');
    return {
        blocks: [{ chat: 'imported', date: today, bullets: sentences }],
        warnings,
    };
}

// ─── Text utilities ────────────────────────────────────────────────────

/**
 * Truncate text to a maximum character count, breaking at newline boundaries.
 * @param {string} text
 * @param {number} maxChars
 * @returns {string}
 */
export function truncateText(text, maxChars) {
    if (!text || text.length <= maxChars) return text;
    const truncated = text.slice(0, maxChars);
    const lastNewline = truncated.lastIndexOf('\n');
    return (lastNewline > maxChars * 0.5 ? truncated.slice(0, lastNewline) : truncated) + '\n[...truncated]';
}

/**
 * Adjust a Set of indices after an element is removed from an array.
 * @param {Set<number>} editingSet Set of active indices (mutated in place).
 * @param {number} removedIndex The index that was removed.
 */
export function reindexEditingSet(editingSet, removedIndex) {
    const updated = new Set();
    for (const idx of editingSet) {
        if (idx < removedIndex) updated.add(idx);
        else if (idx > removedIndex) updated.add(idx - 1);
    }
    editingSet.clear();
    for (const idx of updated) editingSet.add(idx);
}

// --- Non-diegetic content stripping ---

/**
 * Strip non-diegetic content from a message: code blocks, details sections,
 * markdown tables, HTML tags, and excessive newlines.
 * @param {string} text Raw message text.
 * @returns {string} Cleaned text.
 */
export function stripNonDiegetic(text) {
    return text
        .replace(/```[\s\S]*?```/g, '')
        .replace(/<details[\s\S]*?<\/details>/gi, '')
        .replace(/\|[^\n]*\|(?:\n\|[^\n]*\|)*/g, '')
        .replace(/<[^>]*>/g, '')
        .replace(/\n{3,}/g, '\n\n');
}

// --- Chat message formatting ---

/**
 * Format chat messages for extraction prompt. Filters out empty/system-only
 * messages, strips non-diegetic content, returns "Name: text" format.
 * @param {Array<{name: string, mes: string, is_user?: boolean, is_system?: boolean}>} chatArray
 * @param {number} startIndex Start index (inclusive) in chatArray.
 * @param {number} endIndex End index (exclusive) in chatArray.
 * @returns {{ text: string, startIndex: number, endIndex: number, messageCount: number }}
 */
export function formatChatMessages(chatArray, startIndex, endIndex) {
    if (!chatArray || chatArray.length === 0) return { text: '', startIndex: -1, endIndex: -1, messageCount: 0 };

    const safeStart = Math.max(0, startIndex);
    const safeEnd = Math.min(chatArray.length, endIndex);
    if (safeStart >= safeEnd) return { text: '', startIndex: -1, endIndex: -1, messageCount: 0 };

    const slice = chatArray.slice(safeStart, safeEnd);
    const lines = [];

    for (const msg of slice) {
        if (!msg.mes) continue;
        if (msg.is_system && !msg.is_user && !msg.name) continue;
        const text = stripNonDiegetic(msg.mes).trim();
        if (!text) continue;
        lines.push(`${msg.name}: ${text}`);
    }

    return {
        text: lines.join('\n\n'),
        startIndex: safeStart,
        endIndex: safeEnd - 1,
        messageCount: lines.length,
    };
}

// --- Prompt template substitution ---

/**
 * Substitute CharMemory template variables in a prompt string.
 * @param {string} template Prompt template with {{variable}} placeholders.
 * @param {Object} vars Variable values to substitute.
 * @param {string} [vars.charName]
 * @param {string} [vars.charCard]
 * @param {string} [vars.existingMemories]
 * @param {string} [vars.recentMessages]
 * @param {string} [vars.participants]
 * @returns {string} Prompt with variables replaced.
 */
export function substitutePromptTemplate(template, vars) {
    let result = template;
    if (vars.charName != null) result = result.replace(/\{\{charName\}\}/g, vars.charName);
    if (vars.charCard != null) result = result.replace(/\{\{charCard\}\}/g, vars.charCard);
    result = result.replace(/\{\{existingMemories\}\}/g, vars.existingMemories || '(none yet)');
    if (vars.recentMessages != null) result = result.replace(/\{\{recentMessages\}\}/g, vars.recentMessages);
    if (vars.participants != null) result = result.replace(/\{\{participants\}\}/g, vars.participants);
    return result;
}

// ─── Timestamp utility ──────────────────────────────────────────────────

/**
 * Generate a YYYY-MM-DD HH:MM timestamp string.
 * @param {Date} [date] - Date to format. Defaults to now.
 * @returns {string}
 */
export function getTimestamp(date) {
    const now = date || new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

// ─── Memory block cloning ───────────────────────────────────────────────

/**
 * Deep-clone an array of memory blocks (shallow object clone + bullet array copy).
 * @param {Array<{chat: string, date: string, bullets: string[]}>} blocks
 * @returns {Array<{chat: string, date: string, bullets: string[]}>}
 */
export function cloneMemoryBlocks(blocks) {
    return blocks.map(b => ({ ...b, bullets: [...b.bullets] }));
}

// ─── Find & replace across memory blocks ────────────────────────────────

/**
 * Escape a string for use in a RegExp.
 * @param {string} str
 * @returns {string}
 */
function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Count how many times `find` appears across all bullets and chat labels in blocks.
 * @param {Array<{chat: string, date: string, bullets: string[]}>} blocks
 * @param {string} find Search string (plain text, not regex).
 * @param {boolean} [caseSensitive=false]
 * @returns {number}
 */
export function countMatchesInBlocks(blocks, find, caseSensitive = false) {
    if (!find) return 0;
    const flags = caseSensitive ? 'g' : 'gi';
    const re = new RegExp(escapeRegex(find), flags);
    let count = 0;
    for (const block of blocks) {
        count += (block.chat.match(re) || []).length;
        for (const bullet of block.bullets) {
            count += (bullet.match(re) || []).length;
        }
    }
    return count;
}

/**
 * Replace all occurrences of `find` with `replace` across all bullets and chat labels.
 * Mutates the blocks array in place.
 * @param {Array<{chat: string, date: string, bullets: string[]}>} blocks
 * @param {string} find Search string (plain text, not regex).
 * @param {string} replace Replacement string (plain text).
 * @param {boolean} [caseSensitive=false]
 * @returns {number} Total number of replacements made.
 */
export function replaceInBlocks(blocks, find, replace, caseSensitive = false) {
    if (!find) return 0;
    const flags = caseSensitive ? 'g' : 'gi';
    const re = new RegExp(escapeRegex(find), flags);
    // Use replacer function to avoid $& / $' / $` interpolation in replacement string
    const replacer = () => replace;
    let count = 0;
    for (const block of blocks) {
        const chatMatches = (block.chat.match(re) || []).length;
        if (chatMatches) {
            block.chat = block.chat.replace(re, replacer);
            count += chatMatches;
        }
        for (let i = 0; i < block.bullets.length; i++) {
            const bulletMatches = (block.bullets[i].match(re) || []).length;
            if (bulletMatches) {
                block.bullets[i] = block.bullets[i].replace(re, replacer);
                count += bulletMatches;
            }
        }
    }
    return count;
}

/**
 * Decide whether automatic extraction should fire right now.
 * Pure function — caller supplies all state, including `now` for deterministic tests.
 *
 * Order of checks (first matching wins):
 *   1. below-interval       — haven't accumulated enough new messages yet
 *   2. generation-active    — a primary-LLM generation is in flight; defer to idle
 *   3. cooldown             — not enough time has elapsed since the last extraction
 *   4. fire                 — all gates pass
 *
 * @param {object} state
 * @param {number} state.messagesSinceExtraction - Messages seen since last extraction.
 * @param {number} state.interval - Configured extraction interval (messages).
 * @param {number} [state.extractionLag=0] - Additional messages to wait past the interval.
 * @param {boolean} state.isGenerating - True if a primary-LLM generation is currently running.
 * @param {number} state.now - Current timestamp (ms).
 * @param {number} state.lastExtractionTime - Timestamp of the last successful extraction (ms).
 * @param {number} state.cooldownMs - Minimum ms between extractions (0 disables).
 * @returns {{fire: true} | {fire: false, reason: string, remainingMs?: number}}
 */
export function shouldExtractNow({
    messagesSinceExtraction,
    interval,
    extractionLag = 0,
    isGenerating,
    now,
    lastExtractionTime,
    cooldownMs,
}) {
    if (messagesSinceExtraction < interval + extractionLag) {
        return { fire: false, reason: 'below-interval' };
    }
    if (isGenerating) {
        return { fire: false, reason: 'generation-active' };
    }
    if (cooldownMs > 0) {
        const elapsed = now - lastExtractionTime;
        if (elapsed < cooldownMs) {
            return { fire: false, reason: 'cooldown', remainingMs: cooldownMs - elapsed };
        }
    }
    return { fire: true };
}

// ─── Chunked consolidation helpers ─────────────────────────────────────

/**
 * Estimate the prompt and output size a consolidation call will produce.
 * @param {Array<{chat:string,date:string,bullets:string[]}>} memories
 * @param {{promptTemplateLength?:number, outputRatio?:number}} [opts]
 * @returns {{memoriesChars:number, promptChars:number, outputCharsEstimate:number}}
 */
export function estimateConsolidationSize(memories, opts = {}) {
    const { promptTemplateLength = 0, outputRatio = 0.5 } = opts;
    const memoriesChars = memories.reduce((sum, b) => sum + blockCharCount(b), 0);
    return {
        memoriesChars,
        promptChars: promptTemplateLength + memoriesChars,
        outputCharsEstimate: Math.round(memoriesChars * outputRatio),
    };
}

/**
 * Greedily pack memory blocks into chunks, each at or under a char budget
 * (boundary-inclusive: a block whose addition brings the chunk to exactly
 * budgetChars is still placed in that chunk).
 * Preserves block order. A single block larger than the budget is placed
 * in its own chunk (no mid-block splitting).
 * @param {Array<{chat:string,date:string,bullets:string[]}>} memories
 * @param {number} budgetChars
 * @returns {Array<Array<{chat:string,date:string,bullets:string[]}>>}
 */
export function packBlocksIntoChunks(memories, budgetChars) {
    const chunks = [];
    let current = [];
    let currentChars = 0;

    for (const b of memories) {
        const bChars = blockCharCount(b);
        if (current.length === 0) {
            current.push(b);
            currentChars = bChars;
            continue;
        }
        if (currentChars + bChars > budgetChars) {
            chunks.push(current);
            current = [b];
            currentChars = bChars;
        } else {
            current.push(b);
            currentChars += bChars;
        }
    }
    if (current.length > 0) chunks.push(current);
    return chunks;
}

function blockCharCount(b) {
    // Intentional underestimate of <memory chat="…" date="…"></memory> wrapper
    // size — real tags run ~70-80 chars once attributes are populated. For the
    // 24k-char chunk budget this ~40-char-per-block delta is a rounding error
    // (~0.2%). Callers needing exactness should use serializeMemories().length.
    const WRAPPER_OVERHEAD = 30;
    const BULLET_OVERHEAD = 3;   // "- " + newline
    return WRAPPER_OVERHEAD + b.bullets.reduce((s, x) => s + x.length + BULLET_OVERHEAD, 0);
}

/**
 * Classify memory blocks into "eligible" (candidates for re-consolidation) and
 * "protected" (preserved verbatim). A block is protected when its chat label
 * fails the URL-safe ID pattern — which is the convention for extraction chat
 * IDs — OR when the block is structurally malformed or uses the "unknown"
 * placeholder. Order is preserved within each bucket.
 * @param {Array<{chat:string,date:string,bullets:string[]}>} memories
 * @returns {{ eligible: Array, protected: Array }}
 */
export function classifyBlocksForConsolidation(memories) {
    const ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
    const eligible = [];
    const protectedBlocks = [];
    for (const b of memories) {
        const hasBullets = Array.isArray(b?.bullets);
        const chatLabel = typeof b?.chat === 'string' ? b.chat : '';
        const isIdLike = chatLabel !== '' && chatLabel !== 'unknown' && ID_PATTERN.test(chatLabel);
        if (hasBullets && isIdLike) {
            eligible.push(b);
        } else {
            protectedBlocks.push(b);
        }
    }
    return { eligible, protected: protectedBlocks };
}
