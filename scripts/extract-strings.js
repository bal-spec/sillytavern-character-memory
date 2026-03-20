#!/usr/bin/env node
/**
 * extract-strings.js
 *
 * Extracts all translatable string keys from the CharMemory extension source files
 * and compares them against a locale JSON file.
 *
 * Usage:
 *   node scripts/extract-strings.js                          # summary report
 *   node scripts/extract-strings.js --missing-json           # output missing keys as JSON
 *   node scripts/extract-strings.js --locale locales/zh-tw.json
 *   node scripts/extract-strings.js --missing-json --locale locales/en_US.json
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// --- CLI args ---
const args = process.argv.slice(2);
const missingJsonMode = args.includes('--missing-json');
const localeArgIdx = args.indexOf('--locale');
const localeFile = localeArgIdx !== -1
    ? resolve(ROOT, args[localeArgIdx + 1])
    : resolve(ROOT, 'locales', 'zh-tw.json');

// --- Source files to scan ---
const SOURCE_FILES = [
    resolve(ROOT, 'settings.html'),
    resolve(ROOT, 'index.js'),
    resolve(ROOT, 'editor.js'),
];

// ============================================================
// 1. Extract data-i18n keys
// ============================================================

/**
 * Parse a data-i18n attribute value and return all translation keys it contains.
 *
 * Examples:
 *   "Some text"                    => ["Some text"]
 *   "[value]Button Label"          => ["Button Label"]
 *   "[title]Tooltip"               => ["Tooltip"]
 *   "[placeholder]Enter..."        => ["Enter..."]
 *   "[value]Label;[title]Tooltip"  => ["Label", "Tooltip"]
 *
 * Skip values that contain template expressions (dynamic, not translatable).
 *
 * IMPORTANT: Only split on ';[' (semicolon immediately followed by '[') to handle
 * compound attributes. Plain semicolons inside the key text must NOT be split on.
 */
function parseI18nAttrValue(raw) {
    // Skip purely dynamic values like "${escapeAttr(o.title)}"
    if (raw.includes('${')) return [];

    const keys = [];
    // Only split on the compound separator pattern: ';[attr]'
    // A plain ';' that is part of the key text (e.g. "sidebar; Tablet") is preserved.
    const parts = raw.split(/;(?=\[)/);
    for (const part of parts) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        // Strip optional [attr] prefix
        const withoutPrefix = trimmed.replace(/^\[[^\]]+\]/, '').trim();
        if (withoutPrefix) keys.push(withoutPrefix);
    }
    return keys;
}

/**
 * Extract all data-i18n keys from a source string (HTML or JS).
 * Handles both single-quoted and double-quoted attribute values.
 */
function extractI18nKeys(source) {
    const keys = new Set();

    // Match data-i18n="..." or data-i18n='...'
    // Non-greedy match that handles escaped quotes inside values.
    const re = /data-i18n=(?:"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)')/gs;
    let match;
    while ((match = re.exec(source)) !== null) {
        const raw = (match[1] !== undefined ? match[1] : match[2]).trim();
        for (const key of parseI18nAttrValue(unescapeI18nAttr(raw))) {
            keys.add(key);
        }
    }
    return keys;
}

// ============================================================
// 2. Extract t`...` tagged template literal keys
// ============================================================

/**
 * Fully unescape JavaScript string escape sequences so that extracted keys match the
 * runtime string values that SillyTavern's i18n system sees.
 *
 * Used for t`...` tagged template literal keys.
 *
 * Handles:
 *   \\uXXXX => unicode character (e.g. \\u2026 => …)
 *   \\xXX   => hex character
 *   \\n  => actual newline
 *   \\t  => actual tab
 *   \\r  => actual carriage return
 *   \\\\  => single backslash
 */
function unescapeJsString(s) {
    return s.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
            .replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
            .replace(/\\n/g, '\n')
            .replace(/\\t/g, '\t')
            .replace(/\\r/g, '\r')
            .replace(/\\\\/g, '\\');
}

/**
 * Lightly unescape one level of backslash escaping for data-i18n attribute values
 * found inside JS template literals.
 *
 * Inside a JS template literal the source file contains double-backslash sequences where
 * the runtime string has a single backslash. For example:
 *
 *   Source bytes:  \  \  n  (3 chars: 92 92 110)
 *   Runtime value: \  n     (2 chars: 92 110)  — the literal two-char string "\n"
 *   Locale key:    \  n     (2 chars: 92 110)  — JSON "\\n" = backslash + n
 *
 * We need to convert source bytes to runtime value by collapsing each `\\X` pair to `\X`.
 *
 * NOTE: this is NOT a full JS unescape — we do NOT convert \n to a real newline here.
 * The locale key for data-i18n attributes stores the literal backslash+letter form.
 */
function unescapeI18nAttr(s) {
    // Match two consecutive backslashes followed by any character, and replace with
    // one backslash + that character. This collapses one level of JS string escaping:
    //   \\n (source: 92 92 110) => \n (runtime: 92 110, i.e. literal backslash + n)
    //   \\\\ (source: 92 92 92 92) => \\ (runtime: 92 92, i.e. literal double backslash)
    return s.replace(/\\\\([\s\S])/g, '\\$1');
}

/**
 * Convert a raw template literal string (with ${...} expressions) to a locale key
 * by replacing each interpolation with ${0}, ${1}, ${2}, ... in order.
 *
 * Examples:
 *   "Saved ${count} memories."             => "Saved ${0} memories."
 *   "${n} memory"                          => "${0} memory"
 *   "Stopped after ${a} of ${b} chunks."   => "Stopped after ${0} of ${1} chunks."
 */
function normalizeTemplateKey(raw) {
    let idx = 0;
    // Replace ${...} with ${N}, handling nested braces (one level deep)
    return raw.replace(/\$\{(?:[^{}]|\{[^}]*\})*\}/g, () => `\${${idx++}}`);
}

/**
 * Extract all t`...` tagged template literal keys from a source string.
 *
 * The regex matches:
 *   - t` preceded by a non-word boundary (not a letter/digit/underscore before it)
 *   - Template content that may include ${...} interpolations and newlines
 *   - Stops at the closing backtick (does not handle nested backticks)
 *
 * Multiline keys are preserved (newlines kept as-is).
 */
function extractTTagKeys(source) {
    const keys = new Set();

    // Match t`...` — the tag must be preceded by a non-identifier character.
    // Content: anything except a bare backtick — allows ${...} and escaped chars.
    const re = /(?<![a-zA-Z0-9_])t`((?:[^`\\$]|\\.|(?:\$(?!\{))|(?:\$\{(?:[^{}]|\{[^}]*\})*\}))*)`/gs;
    let match;
    while ((match = re.exec(source)) !== null) {
        const raw = match[1];
        const key = unescapeJsString(normalizeTemplateKey(raw));
        if (key.trim()) keys.add(key);
    }
    return keys;
}

// ============================================================
// 3. Main: scan files, load locale, compare
// ============================================================

function scanFiles(files) {
    const allKeys = new Set();
    for (const filePath of files) {
        let source;
        try {
            source = readFileSync(filePath, 'utf8');
        } catch (e) {
            process.stderr.write(`Warning: could not read ${filePath}: ${e.message}\n`);
            continue;
        }
        for (const key of extractI18nKeys(source)) allKeys.add(key);
        for (const key of extractTTagKeys(source)) allKeys.add(key);
    }
    return allKeys;
}

function loadLocale(filePath) {
    try {
        const raw = readFileSync(filePath, 'utf8');
        return JSON.parse(raw);
    } catch (e) {
        process.stderr.write(`Error: could not load locale file ${filePath}: ${e.message}\n`);
        process.exit(1);
    }
}

const codeKeys = scanFiles(SOURCE_FILES);
const locale = loadLocale(localeFile);
const localeKeys = new Set(Object.keys(locale));

const missing = [...codeKeys].filter(k => !localeKeys.has(k)).sort();
const orphaned = [...localeKeys].filter(k => !codeKeys.has(k) && !k.startsWith('_')).sort();
const translated = [...codeKeys].filter(k => localeKeys.has(k)).sort();

if (missingJsonMode) {
    // Output missing keys as { "key": "key" } so translators can see what to translate.
    const obj = {};
    for (const key of missing) obj[key] = key;
    process.stdout.write(JSON.stringify(obj, null, 4) + '\n');
} else {
    // Human-readable summary report
    console.log('='.repeat(60));
    console.log('CharMemory -- Translatable String Audit');
    console.log(`Locale file: ${localeFile}`);
    console.log('='.repeat(60));
    console.log(`\nTotal keys found in code:    ${codeKeys.size}`);
    console.log(`Translated (in locale file): ${translated.length}`);
    console.log(`MISSING from locale file:    ${missing.length}`);
    console.log(`ORPHANED in locale file:     ${orphaned.length}`);

    if (missing.length > 0) {
        console.log('\n--- MISSING KEYS (need translation) ---');
        for (const key of missing) {
            console.log(`  ${JSON.stringify(key)}`);
        }
    }

    if (orphaned.length > 0) {
        console.log('\n--- ORPHANED KEYS (in locale, not in code) ---');
        for (const key of orphaned) {
            console.log(`  ${JSON.stringify(key)}`);
        }
    }

    console.log('\n' + '='.repeat(60));
}
