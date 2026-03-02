# Injection Viewer

The Injection Viewer is a sidebar that shows exactly what context was injected into the LLM's prompt for any character message — which memories, which lorebook entries, and what other extensions contributed. It's the fastest way to answer "did my character actually know about X when they wrote that?"

![Injection Viewer open beside a chat showing memory bullets and count](../images/injection-viewer.png)

## Opening the viewer

Click the **syringe icon** in the CharMemory panel header to show or hide the viewer sidebar. The sidebar docks to the right side of the chat area and stays open as you scroll through the conversation.

Once open, click the **pen icon** on any character message to load that message's injection data. The header updates to show which message you're viewing (e.g., "Message #42").

![Brain icon on a character message](../images/brain-icon-message.png)

> Only **character messages** have injection data — user messages don't trigger a generation so there's nothing to capture. Messages generated before CharMemory was installed will show a placeholder.

---

## What the viewer shows

The viewer has three collapsible sections:

### CharMemory

The memory bullets that Vector Storage retrieved and injected for this generation. The header shows a count (e.g., "CharMemory (6)"). Each bullet is listed individually — this is the direct answer to "what did the character remember when writing this message?"

If this section is empty but memories exist in the file, Vector Storage either filtered them out (score threshold too high) or didn't find a close enough semantic match. See [Retrieval & Prompts](retrieval-and-prompts.md) for how to tune retrieval.

![CharMemory section expanded showing memory bullets with topic tags](../images/injection-viewer.png)

### Lorebook Entries

Which World Info / lorebook entries fired for this generation, based on their trigger keywords matching the recent conversation. Each entry shows its name, trigger keys, and a content preview.

If an entry you expected to see isn't listed, its keywords didn't match the recent context window. This section is useful for understanding the full picture — memories and lorebook entries both contribute to what the character "knows," and they can complement or conflict with each other.

### Extension Prompts

The raw content injected by all active extensions, keyed by injection position (e.g., `4_vectors_data_bank` for Vector Storage, `2_floating_prompt` for Author's Note). This is the unprocessed view — useful for seeing the exact `<memory>` block markup and chunk boundaries that the LLM received.

---

## The health dot

The viewer header includes a colored health dot that mirrors the one in the stats bar:

| Color | Meaning |
|-------|---------|
| **Green** | All health checks passed |
| **Yellow** | Warnings — things work but could be improved |
| **Red** | Problems detected — memories may not be injecting correctly |
| **Gray** | No generation captured yet for this message |

Hover over the dot for a quick summary. On touch devices, tap the **Diagnostics** link in the viewer toolbar to see the full health check results inline without leaving the chat.

For details on what each check looks for and how to fix issues, see [Troubleshooting → Health Checks](troubleshooting.md#health-checks).

---

## How data is captured

Injection data is captured automatically at generation time — CharMemory takes a snapshot of all injected context the moment the character produces a response. A few things to know:

- **Data persists across page refreshes** — snapshots are stored in chat metadata, so they survive reloads within the same chat
- **Only messages generated while CharMemory is active have data** — messages from before installation show a placeholder
- **Group chats**: each character message captures data for that specific character's generation turn

---

## Injection Viewer vs. Diagnostics

Both tools inspect injected context, but they serve different purposes:

| | Injection Viewer | Diagnostics |
|---|---|---|
| **Scope** | Any past message — inspect any generation | Latest generation only |
| **Detail** | Parsed sections — memories, lorebooks, prompts | Full system overview — file status, vectorization, health checks |
| **Best for** | "What did the character know when it wrote *this*?" | "Is my setup working correctly?" |
| **Access** | Pen icon on any character message | Wrench icon → Diagnostics |

Use the Injection Viewer to spot-check individual messages and compare what changed between generations. Use Diagnostics to verify your overall setup — file vectorized, settings correct, memories being injected at all.
