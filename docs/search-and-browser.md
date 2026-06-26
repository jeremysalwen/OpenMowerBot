# Search And Browser Plan

## Retrieval Layers

The system should combine three retrieval layers:

1. Metadata filters: date, author, channel, attachment, pinned, bot/non-bot.
2. Lexical search: exact terms, phrases, filenames, channel names.
3. Conversation context: same-channel windows around a hit, or explicit channel time ranges.
4. Semantic search: embeddings over message chunks and thread-sized windows.

The current CLI implements layer 1, direct JSONL text search for layer 2, `context` for layer 3, static browser lexical shards through `build-browser-index`, embedding generation through `build-embeddings`, and vector search over `data/index/embeddings.jsonl`.

## Embedding Strategy

Use stable chunks, not only individual messages:

- Single message records for precise citation.
- Sliding windows of neighboring messages for context.
- Thread-aware chunks where thread metadata exists.

Candidate embedding models:

- A small local embedding model through Transformers.js for browser and Node parity. The default CLI model is `Xenova/all-MiniLM-L6-v2`.
- A hosted embedding provider for one-time offline indexing if quality matters more than full reproducibility.

Store model name, dimensions, chunking parameters, and generation date in `manifest.json`.

## Answer Generation

Answer generation must be an adapter. Retrieval should work without it.

Adapter interface:

```js
await answerEngine.generate({
  question,
  evidence,
  instructions
});
```

Potential adapters:

- Chrome built-in Prompt API when available.
- WebLLM through `@mlc-ai/web-llm` for browsers with WebGPU but no built-in LLM API.
- Transformers.js through `@huggingface/transformers` for browsers such as Firefox where WebGPU may be unavailable; this uses WASM/CPU by default.
- Local CLI adapter to call an agent/model available on the developer machine.
- No-op adapter that returns ranked evidence only.

## Static Browser App

The static page should:

1. Load `data/index/browser/manifest.json`.
2. Let the user chat with the corpus without a separate search/filter form.
3. Run a bounded agent loop that may call retrieval tools repeatedly before answering.
4. Use search tools to find likely messages from sharded lexical/vector indexes.
5. Use context tools to retrieve same-channel surrounding conversation or explicit channel time ranges.
6. Display cited evidence with channel, author, timestamp, and `messageUrl` links back to Discord.
7. Optionally synthesize an answer through the selected local LLM adapter.

The current static page supports a chat interface, Chrome built-in LLM APIs, WebLLM loaded from CDN, Transformers.js loaded from CDN, and evidence-only mode. WebLLM and Transformers.js download model artifacts on first use and then use the browser cache.

Do not require a server process. Any preprocessing must happen before publishing.

## Local Agent Compatibility

Agents launched in this directory should rely on `AGENTS.md` and the CLI. They should not need browser APIs, npm installs, or network access to search the corpus once `data/corpus` exists.
