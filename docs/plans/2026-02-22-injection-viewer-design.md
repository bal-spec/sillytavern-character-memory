# Per-Message Injection Viewer — Design

## Problem

Users find the diagnostics panel hard to use and want to know "what was injected to cause this response" directly from the message itself. The current diagnostics panel only shows the latest generation's data and is buried in the extension settings.

## Solution

A per-message injection viewer with three components:

1. **Indicator dot** on AI messages that have injection data
2. **"View Injected" button** in the extra message buttons menu
3. **Toggleable side drawer** showing the selected message's injection snapshot

## Data Capture & Storage

On each AI generation, snapshot injected context into `chat_metadata[MODULE_NAME].injectionData[messageIndex]`:

```js
{
  memories: [{ text: "Alice loves gardening" }, ...],
  worldInfo: [{ comment, keys, content }, ...],
  extensionPrompts: [{ label, content, position }, ...],
  timestamp: "14:30:05"
}
```

Capture happens at `CHARACTER_MESSAGE_RENDERED` time. We already capture this data into `lastDiagnostics` — we additionally persist it keyed by message index.

### Storage considerations

- Each snapshot is ~2-5KB (truncated content previews)
- 500 messages ~2.5MB in `chat_metadata`, acceptable
- Messages generated before this feature ships have no snapshot — indicator dot won't appear, button says "No injection data recorded"
- Swipes/regenerations overwrite the snapshot for that message index

## UI Components

### 1. Indicator Dot

- Small dot/icon on AI messages next to character name (similar to existing extraction brain indicator)
- Only appears if `injectionData[messageIndex]` exists
- Clicking it opens/updates the drawer

### 2. "View Injected" Button

- Added to `.extraMesButtons` alongside Extract Here and Pin
- Only on AI messages (not user messages)
- Clicking opens/updates the drawer to show that message's data

### 3. Side Drawer

- Sits to the right of chat area (~320px wide)
- On narrow viewports: overlays chat with absolute positioning + z-index
- Toggle button visible even when drawer is closed
- Open/closed state persists in extension settings

#### Drawer sections (all collapsible):

- **Header**: "Injected Context — Message #N" + close button
- **CharMemory**: Bullet list of injected memory lines (extracted from `4_vectors_data_bank`)
- **Lorebook Entries**: Activated WI entries with comment, keys, and content preview
- **Extension Prompts**: All extension prompts with label and content
- **Footer**: Capture timestamp

### Interaction Flow

- Click indicator dot or "View Injected" button -> drawer opens/updates for that message
- Drawer stays open; clicking different message's button updates content
- New generation auto-updates drawer to latest message (if open)
- Drawer close button; open/closed state persists

## Relationship to Existing Diagnostics

The diagnostics panel in the settings tab **stays as-is**. It serves a different purpose:

- Diagnostics: extension health (file status, vectorization, memory counts, extraction results)
- Drawer: per-message injection context ("what caused this response")

No duplication — different concerns.

## Event Hooks

Existing hooks we leverage:

| Event | Handler | Purpose |
|-------|---------|---------|
| `WORLD_INFO_ACTIVATED` | `onWorldInfoActivated` | Captures activated WI entries (already exists) |
| `CHARACTER_MESSAGE_RENDERED` | `captureDiagnostics` | Captures extension prompts (already exists) |
| `CHARACTER_MESSAGE_RENDERED` | `onMessageRenderedAddButtons` | Adds per-message buttons (already exists) |

New behavior:

- `captureDiagnostics` additionally saves snapshot to `chat_metadata`
- `onMessageRenderedAddButtons` additionally adds "View Injected" button and indicator dot
- New: drawer toggle, drawer render function, drawer auto-update logic
