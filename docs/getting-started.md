# Getting Started

After installing CharMemory, the **Setup Wizard** opens automatically on your first visit. It walks you through the two things you need before memories work: an LLM to extract them, and Vector Storage to retrieve them.

If the wizard didn't open automatically, click the **wand icon** (✦) in the CharMemory panel header at any time.

![CharMemory panel header showing the wand, gear, and wrench icons](../images/panel-header.png)

---

## Step 1: Connect an LLM

CharMemory needs its own LLM connection — separate from your main chat. This keeps the extraction prompt clean and uncontaminated by chat personas, jailbreaks, or system prompts.

![Setup Wizard step 1 — provider dropdown, API key field, Connect button](../images/wizard-step1.png)

**1. Choose a provider** from the dropdown, e.g. **NanoGPT**. If you're not sure, **Pollinations** is free and requires no API key. See [Providers](providers.md) for a full list with model recommendations.

**2. Enter your API key** if the provider requires one. Click the **(get key)** link for a direct link to that provider's key page.

**3. Click Connect.** CharMemory fetches the available models for that provider.

**4. Select a model.** Type to search — especially useful for providers with many models. Not sure which? **GLM 4.7** and **DeepSeek V3.1** are reliable extraction models.

**5. Click Test Connection** to confirm everything works. On success, the wizard enables the Next button.

> **Running an LLM locally?** Select **Local Server** from the provider dropdown. Enter your server URL (e.g., `http://localhost:11434/v1` for Ollama). No API key needed. See [Providers → Local Servers](providers.md#local-servers) for port numbers by backend.

> **If your provider is not listed** Many providers have an OpenAI compatible API endpoint. See if you can configure it that way.

![Wizard step 1 after successful connection — green checkmark, model selected](../images/wizard-step1-connected.png)

---

## Step 2: Configure

![Wizard step 2 — extraction interval and Vector Storage health check](../images/wizard-step2.png)

### Extraction interval

Set how many character messages trigger an automatic extraction. The default is **20 messages** — a good starting point for most chat styles. Lower means more frequent extractions; higher means the LLM gets more context per call and tends to produce better, more selective memories.

### Vector Storage check

The wizard checks your Vector Storage extension configuration and shows one of three states:

**Green — Ready.** Vector Storage is enabled and settings look good. Nothing to do.

**Yellow — Needs tuning.** Vector Storage is active but you should examine some of the settings as they may reduce retrieval quality (e.g., chunk size too small, score threshold not set). The wizard shows specific recommendations but ultimately this is a trial and error process. You can continue and fix these later — see [Retrieval & Prompts](retrieval-and-prompts.md) for guidance.

**Red — Not enabled.** Vector Storage is installed but the "Enable for files" checkbox is off in the Vector Storage extension. Memories will be stored but your character won't recall them during chat.

> To fix the red state: open **Extensions → Vector Storage** → under **File vectorization settings**, check **Enable for files**. Then come back and click Re-check. New to Vector Storage? See SillyTavern's [Data Bank (RAG)](https://docs.sillytavern.app/usage/core-concepts/data-bank/) documentation for a full explanation.

The wizard won't block you — you can click Next even with warnings. But Vector Storage is what makes memories actually show up in conversation, so it's worth setting up before you start chatting.

---

## Step 3: Review & Go

![Wizard step 3 — summary card with provider, model, and status](../images/wizard-step3.png)

The final step shows a summary of your configuration:

- **Provider and model** — what will run extraction
- **Connection** — whether the test passed
- **Extraction** — how often memories will be extracted
- **Vector Storage** — whether retrieval is ready

If anything looks wrong, click **Back** to fix it.

### Existing memories

If the current character already has a Data Bank memory file, the wizard offers to convert it to the current format (topic-tagged blocks for better retrieval). You can do this now or skip it — the same operation is available at any time via the **Reformat** button in the Data Bank Tools section. See [Managing Memories → Reformat](managing-memories.md#reformat) for details.

Click **Get Started** to close the wizard and return to the dashboard.

---

## Your first extraction

After setup, chat normally. The **stats bar** at the top of the CharMemory panel tracks your progress:

![Stats bar showing file name, memory count, progress, and health dot](../images/stats-bar.png)

| Item | What it shows |
|------|---------------|
| **File** | Memory file name for this character (e.g., `Flux-memories.md`) |
| **Memories** | Total memory bullets stored |
| **Progress** | Messages since last extraction vs. the threshold (e.g., `3/20 msgs`) |
| **Status** | `Ready` when extraction can fire, or a countdown timer during cooldown |
| **Health dot** | Green = injection healthy / Yellow = warnings / Red = problems. Click for details. |

When the counter reaches the threshold, extraction fires automatically. You can also trigger it manually at any time:

- **Extract Now** (button in the panel) — processes all unprocessed messages immediately
- **Extract Here** (brain icon on any character message) — processes messages up to that specific point

![Brain icon on a character message](../images/brain-icon-message.png)

Extraction speed will vary based on the number of messages being sent to the LLM and its processing time. A toast notification provides status updates and how many memories were saved. You can watch the steps in the **Activity** section of the dashboard, or click **View full log** for the detailed log.

---

## Viewing your memories

There are a few ways to view your memories — you can open the Data Bank directly and read the raw file, or use the Memory Manager for a more structured view. Click **View / Edit** in the CharMemory panel to open the Memory Manager.

![Memory Manager showing memory cards with topic tags and edit controls](../images/memory-manager.png)

Memories appear as cards grouped by extraction, newest first. Each card shows the chat it came from, the extraction timestamp, and the individual memory bullets. You can:

- **Edit** any bullet to refine its wording
- **Delete** individual bullets (empty cards are removed automatically)
- Browse by scrolling — in group chats, each character has their own section

Memories are stored as a plain markdown file in the character's Data Bank. You can also edit that file directly from the **Data Bank** button in the panel.

---

## Verifying memories are being injected

After your first extraction, generate a few more messages. Then click the **health dot** in the stats bar — if it's green, memories are being retrieved and injected correctly.

For a deeper look, open the **Injection Viewer** (syringe icon in the panel header) to see exactly which memories were injected for the latest message. See [Injection Viewer](injection-viewer.md) for how to read it.

If the health dot is yellow or red, see [Troubleshooting](troubleshooting.md).

> There are many ways for memories to either not be extracted well or not injected well. Much of this is down to extraction prompts, chunking and Vector Storage settings. It is impossible to provide out of the box functionality that will work for everyone, so you may need to spend some time adjusting to suit your particular chats and characters.

---

## Recommended next steps

| I want to… | Go to |
|-----------|-------|
| Understand what's being injected into the prompt | [Injection Viewer](injection-viewer.md) |
| Use CharMemory in a group chat | [Group Chats](group-chats.md) |
| Tune extraction frequency | [Managing Memories](managing-memories.md) |
| Change LLM provider or model | [Providers](providers.md) |
| Fix "memories stored but not recalled" | [Retrieval & Prompts](retrieval-and-prompts.md) |
| Something isn't working | [Troubleshooting](troubleshooting.md) |
