/**
 * Sync check: verify that functions duplicated in both lib.js and index.js
 * have identical implementations. These files must stay in sync because
 * index.js can't import from lib.js at runtime (SillyTavern loads it as
 * a browser extension, not an ES module).
 *
 * If this test fails, you changed a function in one file but not the other.
 * Update both files to match.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..', '..');

const libSource = readFileSync(join(root, 'lib.js'), 'utf-8');
const indexSource = readFileSync(join(root, 'index.js'), 'utf-8');

/**
 * Extract a function body from source code by name.
 * Matches `function name(` or `export function name(` and captures
 * everything from the opening `{` to the balanced closing `}`.
 */
function extractFunctionBody(source, funcName) {
    // Find the function declaration
    const pattern = new RegExp(`(?:export\\s+)?function\\s+${funcName}\\s*\\(`);
    const match = source.match(pattern);
    if (!match) throw new Error(`Function "${funcName}" not found in source`);

    // Find the opening brace after the parameter list
    const declStart = source.indexOf(match[0]);
    let braceStart = source.indexOf('{', declStart);
    if (braceStart === -1) throw new Error(`No opening brace found for "${funcName}"`);

    // Walk to the balanced closing brace
    let depth = 0;
    let i = braceStart;
    while (i < source.length) {
        if (source[i] === '{') depth++;
        else if (source[i] === '}') {
            depth--;
            if (depth === 0) break;
        }
        i++;
    }

    // Return the body between braces (exclusive), normalized
    return source.slice(braceStart + 1, i).trim();
}

// Functions that must be identical between lib.js and index.js
const SYNCED_FUNCTIONS = [
    'stripNonDiegetic',
    'formatChatMessages',
    'substitutePromptTemplate',
];

describe('lib.js / index.js sync check', () => {
    for (const funcName of SYNCED_FUNCTIONS) {
        it(`${funcName}() is identical in both files`, () => {
            const libBody = extractFunctionBody(libSource, funcName);
            const indexBody = extractFunctionBody(indexSource, funcName);
            expect(libBody).toBe(indexBody);
        });
    }
});
