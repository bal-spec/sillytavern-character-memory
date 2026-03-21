# Translating CharMemory

CharMemory uses SillyTavern's native i18n system. Translations are stored as JSON files in the `locales/` directory and loaded automatically when a user selects a matching language in SillyTavern's UI settings.

## Quick start

1. Generate a template with all translatable strings:
   ```bash
   node scripts/extract-strings.js --missing-json > locales/your-lang.json
   ```
   This outputs every key with its English text as the value — open it and translate the values.

   Alternatively, copy an existing translation as a starting point:
   ```bash
   cp locales/fr-fr.json locales/your-lang.json
   ```

2. Edit the JSON file — translate the values, leave the keys unchanged:
   ```json
   {
       "_translator": "Your Name or GitHub username",
       "_language": "Français (French)",
       "_last_updated": "2026-03-20",
       "Extract Now": "Extraire maintenant",
       "No character selected.": "Aucun personnage sélectionné.",
       "Saved ${0} memories.": "${0} souvenirs sauvegardés."
   }
   ```

3. Register it in `manifest.json`:
   ```json
   {
       "i18n": {
           "zh-tw": "locales/zh-tw.json",
           "fr-fr": "locales/fr-fr.json"
       }
   }
   ```

4. In SillyTavern, switch to your language (User Settings > UI Language) and reload.

## How it works

CharMemory uses two i18n mechanisms, both provided by SillyTavern:

| Mechanism | Where | How it works |
|---|---|---|
| `data-i18n` HTML attributes | Sidebar, modals, dialogs | ST's MutationObserver auto-translates elements when they appear in the DOM |
| `` t`string` `` tagged template | Toastr notifications, status bar, health checks, popups | The `t` function looks up the string in locale data at call time |

In both cases, the **English string is the lookup key**. If a key isn't found in the locale file, the English text is shown as a fallback. This means partial translations work fine — untranslated strings just stay in English.

## Locale file format

Locale files are flat JSON dictionaries. The key is always the English string exactly as it appears in the source code.

```json
{
    "key (English)": "translated value"
}
```

### Translator credits

JSON doesn't support comments, but you can add metadata keys prefixed with `_` to credit yourself and track the translation:

```json
{
    "_translator": "Your Name or GitHub username",
    "_language": "Language name in its native script",
    "_last_updated": "2026-03-20",
    "Extract Now": "..."
}
```

These keys are ignored by the i18n system — they'll never match a UI string so they have no effect on the extension. The extraction script also skips `_` prefixed keys when reporting orphaned entries.

### Interpolation placeholders

Some strings contain variables. In the source code these are JavaScript expressions like `${count}`, but in locale keys they're replaced with indexed placeholders:

| Source code | Locale key | Example translation |
|---|---|---|
| `` t`Saved ${count} memories.` `` | `Saved ${0} memories.` | `已儲存 ${0} 條記憶。` |
| `` t`${a} → ${b} memories.` `` | `${0} → ${1} memories.` | `${0} → ${1} 條記憶。` |

You can reorder placeholders in your translation — they're filled by position, not by name:
```json
{
    "Saved ${0} memories to ${1}.": "${1} に ${0} 件のメモリを保存しました。"
}
```

### HTML in strings

Some strings contain HTML tags like `<b>`, `<strong>`, `<br>`, or `<i>`. Preserve the HTML structure but translate the text around it:

```json
{
    "Click <b>Extract Now</b> to start.": "Cliquez sur <b>Extraire</b> pour commencer."
}
```

### Pluralization

English plurals are split into separate keys so each language can handle them independently:

```json
{
    "${0} memory": "${0} souvenir",
    "${0} memories": "${0} souvenirs"
}
```

Languages that don't inflect for number (like Chinese) can use the same translation for both.

## Finding strings to translate

### Using the extraction script

The `scripts/extract-strings.js` tool scans the source code and compares against a locale file:

```bash
# Show a summary of translation coverage (defaults to zh-tw.json)
node scripts/extract-strings.js

# Show coverage for a specific locale
node scripts/extract-strings.js --locale locales/fr-fr.json

# Output ALL keys as a JSON template (for starting a new translation)
node scripts/extract-strings.js --missing-json > locales/your-lang.json

# Output only keys missing from a specific locale (for filling gaps)
node scripts/extract-strings.js --missing-json --locale locales/zh-tw.json > missing-zh.json
```

Without `--locale`, `--missing-json` outputs **all** translatable keys — this is the right starting point for a new translation. With `--locale`, it outputs only the keys that locale is still missing. In both cases, the output is a valid locale file where each value equals its key. Translate the values and save (or merge into an existing locale file).

### Using SillyTavern's built-in tools

ST has a debug function that tracks missing translations at runtime:

1. Open the browser console (F12)
2. Run: `localStorage.setItem('trackDynamicTranslate', 'true')`
3. Reload the page and interact with CharMemory (open modals, trigger extractions, etc.)
4. In the console, run the "Get missing translations" debug function (under the bug icon in ST's top bar)
5. This dumps all untranslated strings encountered during your session

This catches strings that the static extraction script might miss (e.g., strings built from complex runtime logic).

## Language codes

Use the same language codes as SillyTavern's `locales/lang.json`. Common codes:

| Code | Language |
|---|---|
| `zh-tw` | 繁體中文 (Traditional Chinese) |
| `zh-cn` | 简体中文 (Simplified Chinese) |
| `ja-jp` | 日本語 (Japanese) |
| `ko-kr` | 한국어 (Korean) |
| `fr-fr` | Français (French) |
| `de-de` | Deutsch (German) |
| `es-es` | Español (Spanish) |
| `pt-pt` | Português (Portuguese) |
| `ru-ru` | Русский (Russian) |
| `it-it` | Italiano (Italian) |
| `uk-ua` | Українська (Ukrainian) |

## String priority guide

If you're starting a new translation, prioritize strings roughly in this order (highest impact first):

1. **Sidebar dashboard** — button labels, tooltips, status text (~35 strings)
2. **Toastr notifications** — error messages, success confirmations (~84 strings)
3. **Settings Modal** — section headings, field labels, options (~80 strings)
4. **Setup Wizard** — step titles, instructions, buttons (~50 strings)
5. **Troubleshooter** — health check labels, fix hints (~50 strings)
6. **Consolidation/Conversion dialogs** — labels, buttons (~30 strings)
7. **Prompts Modal** — nav labels, buttons (~15 strings)
8. **Long explanatory text** — helper paragraphs, wizard prose (~30 strings)

## Contributing a translation

1. Fork the repository
2. Create your locale file in `locales/`
3. Add the entry to `manifest.json`'s `i18n` field
4. Submit a pull request

Partial translations are welcome — any coverage is better than none. The extraction script's summary output is a good way to show your coverage in the PR description.

## Maintaining translations

When new strings are added to CharMemory, they won't appear in existing locale files and will fall back to English. Run the extraction script periodically to find new untranslated strings:

```bash
node scripts/extract-strings.js --locale locales/your-lang.json
```

The "ORPHANED" count in the output shows keys in your locale file that no longer match any string in the code — these can be safely removed.
