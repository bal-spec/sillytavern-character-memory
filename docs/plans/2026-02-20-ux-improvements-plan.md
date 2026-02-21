# UX Improvements Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Three UX improvements: context-aware extraction prompt titles, searchable model picker, and compact group avatars in the stats bar.

**Architecture:** Feature 1 is a static HTML change. Feature 2 replaces the native `<select>` with a custom input+dropdown component built in pure JS/CSS. Feature 3 modifies the `updateStatusDisplay()` function to render avatar thumbnails inline for group chats.

**Tech Stack:** jQuery (ST convention), vanilla JS, CSS. No external dependencies.

**Testing:** This project has no automated tests. Each task includes manual verification steps in the running SillyTavern instance.

---

### Task 1: Context-Aware Extraction Prompt Titles

**Files:**
- Modify: `settings.html:262` (1:1 prompt label)
- Modify: `settings.html:283` (group prompt label)

**Step 1: Update the 1:1 extraction prompt label**

In `settings.html` line 262, change:
```html
<small>Extraction prompt</small>
```
to:
```html
<small>Extraction prompt (1:1 chats)</small>
```

**Step 2: Update the group extraction prompt label**

In `settings.html` line 283, change:
```html
<small>Extraction prompt</small>
```
to:
```html
<small>Extraction prompt (group chats)</small>
```

**Step 3: Verify in SillyTavern**

1. Refresh SillyTavern
2. Open a 1:1 chat → Extensions → Character Memory → Settings tab
3. Scroll to extraction prompt — should say "Extraction prompt (1:1 chats)"
4. Switch to a group chat — should say "Extraction prompt (group chats)"

**Step 4: Commit**

```bash
git add settings.html
git commit -m "ux: context-aware extraction prompt titles for 1:1 and group"
```

---

### Task 2: Searchable Model Picker — HTML Structure

**Files:**
- Modify: `settings.html:148-153` (replace `<select>` with input+dropdown container)

**Step 1: Replace the native select with the searchable picker HTML**

In `settings.html`, replace lines 148-153 (the `<div>` containing the `<select>` and refresh button):

```html
<div style="display:flex;gap:5px;align-items:center;">
    <select id="charMemory_providerModel" class="text_pole" style="flex:1;">
        <option value="">-- Select model --</option>
    </select>
    <input type="button" id="charMemory_providerRefreshModels" class="menu_button" value="&#x21bb;" title="Refresh model list" />
</div>
```

with:

```html
<div style="display:flex;gap:5px;align-items:center;">
    <div class="charMemory_modelPicker" style="flex:1;position:relative;">
        <input type="text" id="charMemory_modelSearch" class="text_pole" placeholder="Search models..." autocomplete="off" />
        <input type="hidden" id="charMemory_providerModel" />
        <div id="charMemory_modelDropdown" class="charMemory_modelDropdown"></div>
    </div>
    <input type="button" id="charMemory_providerRefreshModels" class="menu_button" value="&#x21bb;" title="Refresh model list" />
</div>
```

Key points:
- The visible `<input type="text">` is for searching/display.
- The hidden `<input>` keeps the same `id="charMemory_providerModel"` so existing code that reads `.val()` continues to work — but we'll update those reads in Task 3.
- The dropdown `<div>` is positioned absolutely below the input.

**Step 2: Verify the HTML renders**

Refresh SillyTavern. The model area should show a text input instead of a dropdown. It won't be functional yet (that's Task 3).

---

### Task 3: Searchable Model Picker — CSS Styling

**Files:**
- Modify: `style.css` (add model picker styles)

**Step 1: Add model picker CSS**

Append the following to `style.css`:

```css
/* Searchable model picker */
.charMemory_modelPicker {
    position: relative;
}

.charMemory_modelDropdown {
    display: none;
    position: absolute;
    top: 100%;
    left: 0;
    right: 0;
    max-height: 300px;
    overflow-y: auto;
    background: var(--SmartThemeBorderColor, #333);
    border: 1px solid var(--SmartThemeQuoteColor, #555);
    border-radius: 4px;
    z-index: 1000;
    margin-top: 2px;
}

.charMemory_modelDropdown.open {
    display: block;
}

.charMemory_modelDropdown .charMemory_modelGroup {
    padding: 4px 8px 2px;
    font-size: 0.8em;
    font-weight: bold;
    opacity: 0.6;
    text-transform: uppercase;
    letter-spacing: 0.5px;
}

.charMemory_modelDropdown .charMemory_modelOption {
    padding: 6px 10px;
    cursor: pointer;
    font-size: 0.9em;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.charMemory_modelDropdown .charMemory_modelOption:hover,
.charMemory_modelDropdown .charMemory_modelOption.active {
    background: var(--SmartThemeBlurTintColor, rgba(255, 255, 255, 0.1));
}

.charMemory_modelDropdown .charMemory_modelOption.selected {
    color: var(--SmartThemeQuoteColor, #aaa);
}

.charMemory_modelDropdown .charMemory_modelEmpty {
    padding: 10px;
    text-align: center;
    opacity: 0.5;
    font-size: 0.9em;
}
```

**Step 2: Verify styling renders**

Refresh SillyTavern. No visible change yet (dropdown hidden by default), but inspect the elements to confirm CSS is applied.

---

### Task 4: Searchable Model Picker — JS Logic

**Files:**
- Modify: `index.js:690-763` (`populateProviderModels` — store data structure instead of building `<option>` elements)
- Modify: `index.js:3442-3451` (model change handler — adapt to new hidden input)
- Add new functions after `populateProviderModels`: `renderModelDropdown()`, `filterModelDropdown()`
- Modify: `index.js` `setupListeners()` — add input/click/keyboard handlers for the model picker

**Step 1: Add a module-level variable to hold the model data**

Near the top of index.js, after the existing `let cachedNanoGptModels = null;` line, add:

```javascript
/** @type {Array<{id: string, name: string, group?: string, meta?: string}>} */
let currentModelList = [];
```

**Step 2: Refactor `populateProviderModels()` to build a data array**

Replace the body of `populateProviderModels()` (lines 690-763) with a version that:
1. Builds `currentModelList` (array of `{id, name, group?, meta?}` objects) from the API response
2. Calls `renderModelDropdown('')` to render the full list
3. Sets the search input display text and hidden input value for the current selection

The NanoGPT branch builds grouped entries (`group` = provider name, `meta` = cost + subscription tag).
The standard branch builds flat entries (no `group`).

Full replacement for the function body (keep signature and jsdoc):

```javascript
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
```

**Step 3: Add `renderModelDropdown()` function**

Add this function right after `populateProviderModels()`:

```javascript
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
        $dropdown.append('<div class="charMemory_modelEmpty">No models — click ↻ to fetch</div>');
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
```

**Step 4: Add event handlers in `setupListeners()`**

In the `setupListeners()` function, replace the existing model change handler at lines 3442-3451:

```javascript
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
```

with the searchable picker handlers:

```javascript
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
```

**Step 5: Update any other code that reads `$('#charMemory_providerModel').val()` directly**

Search the codebase for `$('#charMemory_providerModel').val(` — this now reads from the hidden input, which should work. But verify that `populateProviderModels` doesn't try to call `.empty()` or `.append()` on it (we already replaced this in Step 2).

Also check the NanoGPT filter handler that calls `populateProviderModels` — it should still work since the function signature is unchanged.

**Step 6: Verify in SillyTavern**

1. Refresh SillyTavern
2. Open Character Memory → Settings
3. With a provider connected (e.g., NVIDIA), click the model search input
4. Full model list appears in dropdown
5. Type "deep" — list filters to DeepSeek models
6. Click a model — it selects, dropdown closes, model name shows in input
7. Arrow keys navigate, Enter selects, Escape closes
8. Click outside — dropdown closes, input reverts to selected model name
9. Switch providers — model list updates
10. Click ↻ — model list refreshes

**Step 7: Commit**

```bash
git add index.js settings.html style.css
git commit -m "feat: searchable model picker with filter-as-you-type"
```

---

### Task 5: Compact Group Avatars in Stats Bar

**Files:**
- Modify: `index.js:892-900` (group branch of `updateStatusDisplay()`)
- Modify: `style.css` (avatar thumbnail styling)

**Step 1: Add avatar CSS to `style.css`**

Append after the existing `.charMemory_statItem span` block:

```css
.charMemory_groupAvatar {
    width: 18px;
    height: 18px;
    border-radius: 50%;
    object-fit: cover;
    flex-shrink: 0;
}
```

**Step 2: Modify `updateStatusDisplay()` group branch**

In `index.js`, replace lines 892-900:

```javascript
// Stats bar: file name
if (targets.length > 1) {
    const label = `Group (${targets.length} characters)`;
    $('#charMemory_statFile').text(label).attr('title', targets.map(t => t.name).join(', '));
} else if (targets.length === 1) {
    $('#charMemory_statFile').text(targets[0].fileName).attr('title', targets[0].fileName);
} else {
    $('#charMemory_statFile').text('No character').attr('title', 'No character selected');
}
```

with:

```javascript
// Stats bar: file name (with avatars for group chats)
if (targets.length > 1) {
    const avatarHtml = targets.map(t =>
        `<img class="charMemory_groupAvatar" src="/thumbnail?type=avatar&file=${encodeURIComponent(t.avatar)}" alt="${escapeHtml(t.name)}" onerror="this.style.display='none'" />`
    ).join('');
    const tooltipLines = targets.map(t => `${t.name} → ${t.fileName}`).join('\n');
    $('#charMemory_statFile').html(`${avatarHtml} Group (${targets.length})`).attr('title', tooltipLines);
} else if (targets.length === 1) {
    $('#charMemory_statFile').text(targets[0].fileName).attr('title', targets[0].fileName);
} else {
    $('#charMemory_statFile').text('No character').attr('title', 'No character selected');
}
```

Key points:
- Uses ST's `/thumbnail?type=avatar&file=` endpoint for thumbnails.
- `onerror="this.style.display='none'"` handles missing avatars gracefully.
- Tooltip shows `Name → filename` per character, one per line.
- Uses `.html()` instead of `.text()` for the group case to render `<img>` elements.
- 1:1 case unchanged — still uses `.text()`.

**Step 3: Verify in SillyTavern**

1. Refresh SillyTavern
2. Open a group chat with 2+ characters
3. Stats bar should show small round avatars before "Group (2)"
4. Hover over the stat item — tooltip shows:
   ```
   Flux the Cat → Flux_the_Cat-memories.md
   Vulkan → Vulkan-memories.md
   ```
5. Switch to a 1:1 chat — stats bar shows filename only (no avatar)
6. Switch to a chat with no character — shows "No character"

**Step 4: Commit**

```bash
git add index.js style.css
git commit -m "feat: show character avatars in stats bar for group chats"
```

---

### Task 6: Final Verification and Changelog

**Step 1: Full manual test pass**

Test all three features together:
1. 1:1 chat: prompt title says "(1:1 chats)", stats bar shows filename, model picker is searchable
2. Group chat: prompt title says "(group chats)", stats bar shows avatars + "Group (N)", model picker works
3. Switch between chats — everything updates correctly
4. Switch providers — model list rebuilds, search works
5. NanoGPT provider — model list shows optgroups, filter works across groups

**Step 2: Update CHANGELOG.md**

Add entries for the three features under the current version.

**Step 3: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: changelog for UX improvements"
```
