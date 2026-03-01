# Prompt Design: Why the Prompts Changed in v1.7.0

This document explains the reasoning behind the v1.7.0 prompt changes. It's aimed at contributors and users who want to understand *why* the extraction format looks the way it does, rather than just *what* it looks like.

## The Problem: Vector Search Can't Tell Memories Apart

CharMemory stores memories as markdown in a Data Bank file. Vector Storage chunks that file, embeds each chunk, and retrieves the most relevant chunks when the AI generates a response. The quality of retrieval depends entirely on whether the embedding model can distinguish one memory chunk from another.

Before v1.7.0, the extraction prompt produced memory blocks like this:

```
<memory>
- She broke into a warehouse and stole a sealed envelope from a hidden safe.
- She delivered the envelope to her contact, who confirmed it contained what they needed.
</memory>
```

This worked fine for *storage*. But it failed at *retrieval*, because:

1. **No unique identifiers** — the block doesn't say who "she" is, or name the warehouse, the contact, or anything that distinguishes this event from other events.
2. **Thematic similarity** — a character with 50+ memory blocks about encounters with different people produces embeddings that all look alike. The embedding model sees "person did something somewhere" in every block and can't rank them.
3. **No block-level anchoring** — the embedding for a chunk containing 2-3 blocks is an average of everything in that chunk. Without distinctive content per block, the average is meaningless.

## What We Found Through Testing

During v1.7.0 development, we iterated through vectorization settings using the Injection Viewer to see exactly which memories were being retrieved for each AI response:

1. **Local Transformers (`all-MiniLM-L6-v2`)** with high chunk overlap → everything scored similarly, almost all memories injected regardless of relevance.
2. **Switched to `text-embedding-3-small` (via NanoGPT)** → better discrimination, but still too many false positives with thematically similar blocks.
3. **Raised score threshold** from 0.0 → 0.2 → 0.3 → got closer, but the core problem remained: blocks about different encounters with different people still scored nearly identically because they shared vocabulary and structure.
4. **Added topic tags** to memory blocks → immediately solved the discrimination problem. Mentioning "the vet" in chat now matched strongly against `[Flux, Alex — first vet visit and vaccinations]` and weakly against `[Flux, Alex — adoption day at the apartment]`, even though both blocks shared vocabulary.

The insight: **the prompt determines the shape of the embedding**. You can't fix retrieval by tuning Vector Storage settings alone — you have to produce text that's *embeddable* in the first place.

## The Three Prompt Changes

### 1. Topic Tags (Instruction 6)

**Before:**
```
6. HARD LIMIT: No more than 8 bullet points TOTAL.
```

**After:**
```
6. Start each block with a topic tag as the first bullet:
   "- [Names involved — short description of encounter]"
   (e.g., "- [Alex, Sarah — first visit to the apartment]").
   This aids later retrieval.
```

The topic tag is the single most important change. It front-loads each block with:
- **Who** was involved (specific names, not "a friend")
- **What** the encounter was about (short, unique descriptor)

This gives the embedding model a discriminating anchor. When the tag text appears in the embedding, it creates a unique signature for that memory block even when the rest of the content shares vocabulary with other blocks.

### 2. Tighter Bullet Limits (Instruction 7)

**Before:**
```
HARD LIMIT: No more than 8 bullet points TOTAL.
```

**After:**
```
HARD LIMIT: No more than 5 bullet points per block (not counting the topic tag).
```

Two changes here:
- **8 → 5 bullets**: Forces the LLM to extract outcomes, not processes. With 8 bullets, the LLM writes play-by-play accounts. With 5, it has to prioritize.
- **"per block" not "TOTAL"**: The old limit was ambiguous — did "8 total" mean across all blocks, or per block? The new wording is explicit.

For vectorization, smaller blocks are better. A 200-400 character block gets a more focused embedding than a 1000-character block. With a chunk size of 1000, you fit 2-3 tight blocks per chunk instead of 1 bloated one.

### 3. Named Participants

**Before:**
```
(No explicit instruction about naming)
```

**After:**
```
- Always name specific people involved — use their name, not "a friend" or "someone"
```

Generic labels like "a client" or "someone" produce generic embeddings. "Sarah" is a unique token that the embedding model can match against. This instruction appears in both the WHAT TO EXTRACT section and the conversion prompt.

## Positive and Negative Examples

The old examples used a generic spy scenario:

```
Bad: 8 bullets narrating a warehouse heist step-by-step
Good: 2 bullets summarizing the outcome
```

The new examples use a specific character scenario (Flux, the cat character from our test fixtures):

```
Bad: 8 bullets narrating adoption day step-by-step
Good: topic tag + 3 bullets capturing the encounter
```

The change serves two purposes:
1. It demonstrates the topic tag format in context
2. It uses a concrete, memorable example that the LLM can pattern-match against (character names, specific objects, emotional beats)

## The Conversion Prompt

The conversion/reformat prompt (`defaultConversionPrompt`) was rewritten to align with the extraction prompt. Key differences from the old conversion prompt:

**Old prompt:**
- "Extract every distinct fact or piece of information as a bullet point"
- "Preserve ALL information — do not summarize, combine, or omit anything"
- Topic grouping by category: "Appearance", "Relationships", "Key Events"

**New prompt:**
- Topic tags required as first bullet
- 5-bullet limit per block with "combine related facts into single bullets rather than deleting information"
- Encounter-specific labels: "First day at the apartment", "Club night with Sam"
- Handles three input types: unstructured text, partially formatted blocks, already-formatted blocks
- Won't touch blocks that are already well-formatted (rule 10)

The old prompt's "preserve ALL" instruction was fundamentally incompatible with tight blocks. The new prompt prioritizes *retrievable* structure over exhaustive preservation. Information is preserved by combining related facts into single bullets, not by allowing unlimited bullets.

## The Group Extraction Prompt

The group prompt (`defaultGroupExtractionPrompt`) mirrors the solo prompt changes with additions specific to multi-character chats:

- Topic tags include the specific character whose memories are being extracted
- Instruction 10: "Reference other participants by name"
- Group dynamics in WHAT TO EXTRACT: "who allied with whom, who disagreed, power shifts"

Group memories are even harder for vector search because multiple characters produce similar encounter descriptions. Topic tags with participant names are essential.

## Impact on Existing Users

- **New users**: Get the new prompts automatically.
- **Existing users with default prompt**: Their extraction prompt is set to `""` (meaning "use default"). They'll get the new format on next extraction.
- **Existing users with customized prompts**: Unaffected. Their custom prompt is stored in settings. They can click "Restore Default" to opt in.
- **Existing memories**: Continue to work. The Convert tool (source: "Current memories") rewrites old-format memories into the topic-tagged format via LLM.

## Lessons

1. **Prompt design is retrieval design.** When your output gets embedded and vector-searched, the shape of the text determines retrieval quality. Prompts that produce good-looking text may produce terrible embeddings.
2. **Test with the Injection Viewer, not the output.** The extraction output looked fine before v1.7.0. The problem only became visible when we looked at *what was being retrieved* for each generation.
3. **Unique tokens matter more than structure.** Markdown formatting, clean grammar, and consistent structure don't help vector search. Unique names, specific descriptions, and distinctive vocabulary do.
4. **Tighter is better for chunking.** A 5-bullet block creates a more focused embedding than an 8-bullet block. The lost detail matters less than the gained precision.
