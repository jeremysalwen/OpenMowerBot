# DiscordHistory

DiscordHistory is a local-first archive and search project for the OpenMower Discord server. It is designed for two use cases:

1. Let command-line agents answer questions from the exported chat history.
2. Publish the same corpus as static files that a browser page can search and summarize locally.

The project uses DiscordChatExporter JSON as temporary raw input, normalizes it to a compact readable corpus, and provides a dependency-free Node CLI for text and metadata search. Optional browser and embedding indexes can be generated from the corpus.

## Current Status

- `export`: runs DiscordChatExporter locally or in CI. Incremental mode exports only messages after the committed corpus watermark.
- `build-corpus`: reads DiscordChatExporter JSON files from `data/raw` and writes `data/corpus/messages.jsonl` plus `data/corpus/manifest.json`.
- `merge-corpus`: merges an incremental corpus into the checked-in corpus by message ID.
- `download-attachments`: downloads selected small/useful attachments, including source code uploads.
- `build-browser-index`: writes static JSON message shards and lexical term buckets under `data/index/browser`.
- `build-embeddings`: writes `data/index/embeddings.jsonl` with a local Transformers.js feature-extraction model when `@huggingface/transformers` is installed.
- `search`: supports text matching, date range, author, channel, and attachment filters.
- `context`: shows same-channel conversation around a message, or a channel time range.
- `vector-search`: searches a precomputed `data/index/embeddings.jsonl` with a query vector.
- `stats`: summarizes indexed corpus coverage.
- The browser app loads `data/index/browser` and can answer from cited conversation context using built-in browser LLM support, WebLLM, Transformers.js, or evidence-only mode.

## Layout

```text
DiscordHistory/
  AGENTS.md              Agent-facing instructions.
  bin/                   CLI entry points.
  src/                   Shared normalization/search code.
  docs/                  Human-facing project notes.
  data/raw/              Local raw DiscordChatExporter JSON exports, ignored.
  data/corpus/           Committed readable message corpus.
  data/attachments/      Committed selected attachment files.
  data/media/            Local raw exporter media, ignored.
  data/index/            Derived heavier search/vector indexes.
  web/                   Static browser search and local-answer page.
```

## Export

DiscordChatExporter supports CLI export, JSON output, attachments/media, threads, partitioning, and date filtering. A full server export should use a bot token if possible because DiscordChatExporter warns that automating user accounts can violate Discord terms.

Example full local export:

```bash
npm run export -- --raw data/raw --parallel 8
npm run build-corpus -- --raw data/raw --out data/corpus
npm run stats -- --corpus data/corpus
```

Run the local exporter help before the first real export because option names can differ by build:

```bash
/home/jeremy/mowgli/ChatExporterBinaries/DiscordChatExporter.Cli exportguild --help
```

## CLI

From this directory:

```bash
npm run build-corpus -- --raw data/raw --out data/corpus
npm run stats -- --corpus data/corpus
node ./bin/discord-history.mjs search --q "rtk gps" --channel mower --after 2023-01-01 --limit 10
node ./bin/discord-history.mjs context --message-id 123456789012345678 --json
node ./bin/discord-history.mjs context --channel open-mower --after 2024-01-01 --before 2024-01-02
node ./bin/discord-history.mjs search --author "clemens" --has-attachment --json
node ./bin/discord-history.mjs build-browser-index
node ./bin/discord-history.mjs vector-search --vector-file query-vector.json --limit 10
```

The core CLI requires Node 18+ and has no npm dependencies. Embedding generation additionally needs:

```bash
npm install --save-optional @huggingface/transformers
npm run build-embeddings -- --model Xenova/all-MiniLM-L6-v2
```

## Incremental Updates

The workflow in `.github/workflows/update-corpus.yml` can refresh the committed corpus on a schedule. Configure repository secrets:

- `DISCORD_TOKEN`: bot token with read access to the target channels and threads.
- `OPENMOWER_GUILD_ID`: Discord guild/server ID.

The workflow downloads DiscordChatExporter, exports only messages after `data/corpus/manifest.json`'s latest timestamp, builds a delta corpus, merges by message ID, downloads selected attachments, and commits `data/corpus` plus `data/attachments`.

Run the full local export once before enabling scheduled updates so the repository has an initial `data/corpus` watermark.

## GitHub Publishing

Recommended repository policy:

- Commit source code, docs, `AGENTS.md`, `data/corpus`, and reviewed selected attachments.
- Keep `.env` and Discord tokens out of git.
- Do not commit the full raw export.
- Use Git LFS or release assets if selected attachments are too large for normal git. `.gitattributes` marks selected attachments and binary index files for LFS.
- For static hosting, publish `web/`, `data/corpus`, selected `data/attachments`, and generated browser index shards from `data/index/browser`.

## Browser Direction

The browser app loads `data/index/browser/manifest.json`, fetches only the needed message/index shards, and presents a chat interface. Internally it runs a bounded agent loop over browser tools such as `searchDiscord`, `getConversationContext`, and `getChannelRange` before passing cited evidence to a pluggable local answer engine.

Answer engine adapters should be isolated behind one interface:

- Chrome built-in Prompt API when available.
- WebLLM through `@mlc-ai/web-llm` for browsers with WebGPU but no built-in LLM API.
- Transformers.js through `@huggingface/transformers` for browsers without WebGPU, including Firefox configurations where `navigator.gpu` is unavailable.
- A disabled/no-LLM mode that still returns ranked evidence.

The WebLLM and Transformers.js paths import libraries from CDN and download selected model artifacts into the browser cache on first use. They do not require a server-side model endpoint.

Retrieval must not depend on the LLM adapter. Search should be used to find likely threads; answer generation should use expanded conversation context and channel ranges, not isolated matching messages. The browser agent should be free to make multiple tool calls before answering. That keeps local agents, static hosting, and future Chrome APIs compatible with the same corpus.

## Sources Checked

- DiscordChatExporter documents JSON export, attachments, embeds, partitioning, and date filters.
- Chrome's built-in AI docs currently expose multiple browser AI APIs and recommend polyfills for browser support.
- WebLLM runs LLM inference in the browser using WebGPU with no server dependency.
