# UX Improvements: Prompt Titles, Model Search, Group Avatars

Date: 2026-02-20

## Feature 1: Context-Aware Extraction Prompt Title

### Problem
Both the 1:1 and group extraction prompt sections use the identical label "Extraction prompt". When switching between chat types, there's no visual indication that you're looking at a different prompt.

### Design
Static HTML text change — no JS logic needed since `updateChatTypeVisibility()` already toggles the correct section.

- 1:1 section (`charMemory_section1v1`): label becomes **"Extraction prompt (1:1 chats)"**
- Group section (`charMemory_sectionGroup`): label becomes **"Extraction prompt (group chats)"**

### Files
- `settings.html` — change `<small>` text in both sections

## Feature 2: Searchable Model Picker

### Problem
The model dropdown (`#charMemory_providerModel`) is a native `<select>` with 100+ options for providers like NanoGPT and NVIDIA. Users must scroll through the entire list to find a model.

### Design
Replace the native `<select>` with a custom filtered dropdown component.

**UI behavior:**
- Text input replaces the select. Shows currently selected model name, or placeholder "Search models..." when empty.
- Dropdown panel appears on focus/click showing all available models.
- Typing filters the list in real-time (case-insensitive substring match on model ID/name).
- Optgroup support preserved: NanoGPT models grouped by provider. Groups with no matches hidden during filtering.
- Clicking a model selects it and closes the dropdown.
- Keyboard: Arrow keys navigate, Enter selects, Escape closes.
- Refresh button (↻) works as before, rebuilds the internal model list.

**Implementation approach:**
- Pure JS/CSS, no external dependencies.
- `populateProviderModels()` builds an internal data structure (array of `{id, name, group?}` objects) instead of `<option>` elements.
- New `renderFilteredModels(filter)` function renders the visible dropdown from the data structure.
- A `data-value` attribute on the input (or hidden input) stores the actual model ID.
- Existing change handler reads from the data attribute instead of `$(select).val()`.
- New CSS class `charMemory_modelPicker` for the dropdown container, items, groups, and active/hover states.

**Edge cases:**
- Provider switch clears the input and rebuilds the model list.
- No models available: show "No models — click ↻ to fetch" message.
- Filter matches nothing: show "No matching models" message.
- Selected model not in list (stale selection): show the model ID in the input with a visual indicator.

### Files
- `settings.html` — replace `<select>` with input + dropdown container structure
- `index.js` — modify `populateProviderModels()`, add filter/render logic, update change handler
- `style.css` — dropdown positioning, item styling, optgroup headers, active states

## Feature 3: Compact Group Avatars in Stats Bar

### Problem
In group chats, the stats bar shows "Group (2 characters)" which doesn't tell you which characters are involved or what their memory files are named.

### Design
Add small character avatar thumbnails inline in the stats bar, with a detailed tooltip.

**Display (group chats only):**
```
📝 [av1][av2] Group (2)
```

- Avatar images: ~18px rounded `<img>` elements using ST's thumbnail endpoint: `/thumbnail?type=avatar&file=<avatar_filename>`
- Displayed before the "Group (N)" text
- Tooltip on hover shows per-character filenames:
  ```
  Flux the Cat → Flux_the_Cat-memories.md
  Vulkan → Vulkan-memories.md
  ```

**1:1 chats:** No change — continues showing filename only.

**Implementation:**
- `updateStatusDisplay()` builds avatar `<img>` elements from `targets[].avatar`.
- Uses `.html()` instead of `.text()` for the group case to insert `<img>` elements.
- CSS: `charMemory_groupAvatar` class for sizing (18px), border-radius (50%), vertical alignment, and small right margin between avatars.
- Avatar `onerror` handler: hide the image if thumbnail fails to load (graceful degradation).

### Files
- `index.js` — modify `updateStatusDisplay()` group branch
- `style.css` — avatar image styling
