# Tablet Mode — Floating Dashboard Panel

## Problem

On iPad/tablet in landscape, SillyTavern's sidebar is narrow (~250px). The CharMemory dashboard gets squeezed — tool button names truncate ("Refo..."), activity log clips, stats bar wraps awkwardly, and all touch targets are too small. The sidebar paradigm doesn't work for tablet UX.

**Goal:** Add a user-selectable "Tablet Mode" that presents the dashboard as a non-modal, centered floating panel with touch-friendly sizing. No SillyTavern core changes — entirely within the extension.

---

## Approach: DOM Relocation

When the tablet panel opens, **move the actual DOM nodes** from the sidebar's `.inline-drawer-content` into a fixed-position floating panel appended to `<body>`. When it closes, move them back. This means:
- All event handlers survive (they're bound to specific element IDs, not parent containers)
- No HTML duplication or separate template
- No rewiring of button handlers — `$('#charMemory_extractNow')` etc. resolve to the same nodes

The sidebar drawer toggle is intercepted via a **capturing-phase** event listener that fires before ST's built-in handler. In tablet mode, `e.stopPropagation()` prevents the native sidebar expansion and opens the floating panel instead.

---

## Implementation

### 1. Setting: `tabletMode` (index.js)

Add to `defaultSettings` (~line 443):
```js
tabletMode: 'auto', // 'auto' | 'on' | 'off'
```

Add helper (~line 1504):
```js
function isTabletMode() {
    const mode = extension_settings[MODULE_NAME].tabletMode || 'auto';
    if (mode === 'on') return true;
    if (mode === 'off') return false;
    return 'ontouchstart' in window || navigator.maxTouchPoints > 0;
}
```

Tri-state avoids forcing desktop users to see it. `'auto'` detects touch at runtime (same pattern as troubleshooter line ~8097).

### 2. Panel HTML (index.js, init block ~line 8012)

Append to `<body>` after log drawer (same pattern as injection/log drawers):
```html
<div id="charMemory_tabletPanel" class="charMemory_tabletPanel">
    <div class="charMemory_tabletHeader">
        <b>CharMemory</b>
        <div id="charMemory_tabletHeaderIcons" class="charMemory_tabletHeaderIcons">
            <!-- Header icons relocated here from sidebar when open -->
        </div>
        <div class="charMemory_drawerClose" id="charMemory_tabletClose" title="Close">
            <i class="fa-solid fa-xmark"></i>
        </div>
    </div>
    <div id="charMemory_tabletBody" class="charMemory_tabletBody">
        <!-- .inline-drawer-content children relocated here when open -->
    </div>
</div>
```

### 3. Toggle Logic: `toggleTabletPanel()` (index.js, ~line 7596)

**Open:**
1. Detach `.charMemory_headerGear` spans from sidebar header → append to `#charMemory_tabletHeaderIcons`
2. Detach `.inline-drawer-content` children → append to `#charMemory_tabletBody`
3. Collapse sidebar drawer (hide content, chevron down)
4. Add `.open` class to panel
5. Call `updateStatusDisplay()` + `updateHealthIndicator()` (refresh stats)

**Close:**
1. Detach `#charMemory_tabletBody` children → append back to `.inline-drawer-content`
2. Detach `#charMemory_tabletHeaderIcons .charMemory_headerGear` → insert before chevron in sidebar header
3. Remove `.open` class

### 4. Sidebar Toggle Intercept (index.js, ~line 7234)

Replace the existing jQuery `click.charMemoryPanelOpen` handler with a **native capturing-phase** listener:

```js
drawerToggle.addEventListener('click', function (e) {
    if (isTabletMode()) {
        e.stopPropagation();
        e.preventDefault();
        toggleTabletPanel();
        return;
    }
    // Normal mode: existing behavior (refresh on open)
    setTimeout(() => { ... }, 50);
}, true); // capturing phase — fires before ST's handler
```

This is the key mechanism. ST's inline-drawer toggle handler fires in bubbling phase. Our capturing-phase listener runs first and can suppress it.

### 5. Event Wiring (index.js, init block ~line 8054)

- Close button: `$('#charMemory_tabletClose').on('click', () => toggleTabletPanel(false))`
- Tap outside to dismiss: `$(document).on('click.tabletPanelClose', ...)` — checks `!$(e.target).closest('#charMemory_tabletPanel').length`
- Swipe down to dismiss: `touchstart`/`touchend` on panel element, deltaY > 80px

### 6. Wizard Completion Update (index.js, ~line 5225)

When wizard finishes and opens the sidebar, check tablet mode:
```js
if (isTabletMode()) {
    toggleTabletPanel(true);
} else {
    // existing: trigger sidebar toggle
}
```

### 7. Settings Modal Toggle (index.js, ~line 3609)

Add to the Advanced section of `showSettingsModal()`:
- Dropdown: Auto (detect touch) / Always on / Off
- Handler saves to `extension_settings[MODULE_NAME].tabletMode`
- If switched to `'off'` while panel is open, closes panel and restores sidebar

### 8. CSS (style.css, append after line 1943)

**Panel positioning:**
- `position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%)`
- `width: 500px; max-width: 90vw; max-height: 80vh`
- `z-index: 1002` (above injection drawer 1000, log drawer 1001; below ST modals 9999+)
- Fade+scale animation via `.open` class toggle
- `border-radius: 12px; box-shadow: 0 8px 32px rgba(0,0,0,0.4)`

**Touch-friendly overrides (scoped to `.charMemory_tabletPanel`):**

| Element | Current | Tablet |
|---------|---------|--------|
| `.charMemory_headerGear` | padding: 2px 6px | padding: 10px 12px, min-width/height: 44px |
| `.menu_button` / `input[type="button"]` | ST default (~30px) | min-height: 44px, padding: 8px 16px |
| `.charMemory_autoPill` | padding: 3px 10px | padding: 8px 14px, min-height: 44px |
| `.charMemory_statItem` | padding: 4px 8px | padding: 8px 10px |
| `.charMemory_link` | font-size: 0.85em | min-height: 44px, inline-flex center |
| `.charMemory_healthDot` | 8x8px | 10x10px |
| `.charMemory_buttonRow` gap | 8px | 10px |
| `.charMemory_dashActivity` | max-height: 80px | max-height: 120px |

All overrides are scoped to `.charMemory_tabletPanel` — zero impact on desktop sidebar.

---

## Edge Cases

- **Chat changes while open:** `onChatChanged` calls `updateStatusDisplay()` which targets elements by ID — same nodes, works in either location
- **Modal opens while panel is open:** Panel z-index (1002) << modal z-index (9999+), panel stays behind
- **Extract Now from panel:** Async extraction, activity log updates live on the relocated DOM nodes
- **Browser resize / orientation change:** CSS `transform: translate(-50%, -50%)` stays centered; `max-width: 90vw` handles viewport changes
- **Injection/Log drawers open simultaneously:** Side drawers (right edge) don't overlap centered panel
- **Delegated handlers** (e.g., `$(document).on('click', '#charMemory_viewFullLog', ...)`): Match by ID regardless of DOM location — no issue

---

## Files Modified

| File | Change |
|------|--------|
| `index.js` | `defaultSettings.tabletMode`, `isTabletMode()`, panel HTML append, `toggleTabletPanel()`, sidebar toggle intercept, close/swipe wiring, wizard completion update, settings modal toggle |
| `style.css` | Panel positioning/animation, touch-friendly size overrides (all scoped to `.charMemory_tabletPanel`) |

`settings.html` — no changes (sidebar HTML is the source of relocatable DOM nodes)

---

## Verification

1. **Desktop regression:** With `tabletMode: 'off'` — sidebar toggle works exactly as before
2. **Touch detection:** Use Chrome DevTools device emulation (iPad) — `'auto'` mode should activate tablet panel
3. **DOM relocation round-trip:** Open panel → verify all buttons work → close panel → open sidebar normally → verify everything still works
4. **Stats update while open:** Switch chat with panel open — stats bar should reflect new character
5. **Extract from panel:** Click Extract Now — activity log updates in real time
6. **Modal stacking:** Open panel → click Settings gear → modal appears above panel
7. **Settings toggle:** Switch to "Off" while panel is open — panel closes, sidebar restores
8. **Swipe dismiss:** Swipe down on panel — closes
9. **Tap outside:** Tap chat area — panel dismisses
