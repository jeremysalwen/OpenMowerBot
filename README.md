# OpenMower Discord Archive

The full message history of the **OpenMower** Discord server, normalized into plain committed files. No server, no database: clone the repo and the whole archive is on disk as JSON you can search, read, or grep.

**Ask it questions in your browser: https://jeremysalwen.github.io/OpenMowerBot/**

## The archive

The corpus is `data/corpus/messages.jsonl` — one JSON object per message, with `timestamp`, `channelName`, `authorName`, `content`, `messageUrl`, attachments, and reply links. Selected attachments are under `data/attachments/`. That file is the archive; everything else is tooling on top of it.

Search it with the bundled CLI (Node 18+, no dependencies):

```bash
node ./bin/discord-history.mjs search --q "rtk gps" --channel mower --after 2023-01-01 --limit 10
node ./bin/discord-history.mjs context --message-id 123456789012345678 --json
node ./bin/discord-history.mjs stats --corpus data/corpus
```

`search` supports `--q`, `--author`, `--channel`, `--after`, `--before`, `--has-attachment`, `--attachment`, `--limit`, and `--json`. `context` shows the same-channel conversation around a message or a time range. Or just `grep data/corpus/messages.jsonl`.

## Asking questions

### Web (no install)

Open **https://jeremysalwen.github.io/OpenMowerBot/**, type a question, and it searches the archive in your browser and answers with cited sources. Pick an answer model in the top-right:

- **Hosted API (OpenAI-compatible)** — your own base URL, model, and key (OpenAI, OpenRouter, Groq, Anthropic's compatibility endpoint, a local server). Most reliable; the key stays in your browser.
- **WebLLM / Transformers.js** — local models that run entirely in the browser. No key, but smaller and less reliable.
- **Evidence only** — skip the LLM and list the top matching messages.

Run it locally by serving the repo root:

```bash
npm run build-browser-index      # first time: builds data/index/browser
python3 -m http.server 8080      # then open http://localhost:8080/web/
```

### Agent CLI

Run an agent CLI such as [Claude Code](https://claude.com/claude-code) or [Codex](https://github.com/openai/codex) in the cloned repo and ask in plain language ("How do people fix RTK GPS drift?"). `AGENTS.md` teaches it to use the search CLI, so it runs focused searches, expands surrounding conversation, and cites messages.

```bash
git clone https://github.com/jeremysalwen/OpenMowerBot.git
cd OpenMowerBot
claude          # or: codex
```

---

The rest of this README covers how the archive is built and maintained.

## Repository layout

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
  data/index/            Derived heavier search/vector indexes, reproducible.
  web/                   Static browser search and local-answer page.
```

## Building the corpus

DiscordChatExporter JSON is the temporary raw input; it is normalized into the compact corpus. A full server export should use a bot token if possible, because DiscordChatExporter warns that automating user accounts can violate Discord terms.

```bash
npm run export -- --raw data/raw --parallel 8
npm run build-corpus -- --raw data/raw --out data/corpus
npm run stats -- --corpus data/corpus
```

Run the local exporter help before the first real export, because option names can differ by build:

```bash
/home/jeremy/mowgli/ChatExporterBinaries/DiscordChatExporter.Cli exportguild --help
```

## CLI reference

The core CLI requires Node 18+ and has no npm dependencies.

- `build-corpus`: reads DiscordChatExporter JSON from `data/raw` and writes `data/corpus/messages.jsonl` plus `data/corpus/manifest.json`.
- `merge-corpus`: merges an incremental corpus into the checked-in corpus by message ID.
- `download-attachments`: downloads selected small/useful attachments, including source-code uploads.
- `build-browser-index`: writes static JSON message shards and lexical term buckets under `data/index/browser`.
- `build-embeddings`: writes `data/index/embeddings.jsonl` with a local Transformers.js model when `@huggingface/transformers` is installed.
- `search`: text, date range, author, channel, and attachment filters.
- `context`: same-channel conversation around a message, or a channel time range.
- `vector-search`: searches a precomputed `data/index/embeddings.jsonl` with a query vector.
- `stats`: summarizes indexed corpus coverage.

Embedding generation needs the optional dependency:

```bash
npm install --save-optional @huggingface/transformers
npm run build-embeddings -- --model Xenova/all-MiniLM-L6-v2
node ./bin/discord-history.mjs vector-search --vector-file query-vector.json --limit 10
```

## Keeping it updated

`.github/workflows/update-corpus.yml` refreshes the committed corpus on a schedule. Configure repository secrets:

- `DISCORD_TOKEN`: bot token with read access to the target channels and threads.
- `OPENMOWER_GUILD_ID`: Discord guild/server ID.

The workflow exports only messages after `data/corpus/manifest.json`'s latest timestamp, builds a delta corpus, merges by message ID, downloads selected attachments, and commits `data/corpus` plus `data/attachments`. Run the full local export once before enabling scheduled updates so the repository has an initial watermark.

The scheduled export intentionally uses lower DiscordChatExporter parallelism and rate-limit retries. Large guild exports can hit Discord 429 responses while channels and threads are enumerated, so unattended updates favor reliability over speed.

## Publishing

Recommended repository policy:

- Commit source code, docs, `AGENTS.md`, `data/corpus`, and reviewed selected attachments.
- Keep `.env` and Discord tokens out of git.
- Do not commit the full raw export.
- Use Git LFS or release assets if selected attachments are too large for normal git. `.gitattributes` marks selected attachments and binary index files for LFS.
- For static hosting, publish `web/` and the generated browser index from `data/index/browser`. The corpus is only needed to build the index; the browser app reads the index, not `data/corpus` directly.

### GitHub Pages

`.github/workflows/deploy-pages.yml` publishes the browser app to GitHub Pages. On each run it rebuilds `data/index/browser` from the committed corpus, assembles a static site under `web/` with the index as a sibling, and deploys it. The browser index is reproducible and is never committed.

- One-time setup: in the repository settings, set **Pages → Build and deployment → Source** to **GitHub Actions**.
- Live URL: `https://jeremysalwen.github.io/OpenMowerBot/` (the bare URL redirects into the app under `/web/`).
- Triggers: pushes that touch `web/`, `data/corpus`, `src/`, or `bin/`; completion of the scheduled **Update Discord corpus** run; and manual `workflow_dispatch`.
- Attachments are not published to Pages. The deploy sets `attachmentsLocal:false` in `web/config.js`, so attachment links fall back to the original Discord CDN URLs. Served locally, the committed `web/config.js` keeps attachment links pointed at local `data/attachments` files.

## Browser app architecture

The browser app loads `data/index/browser/manifest.json`, fetches only the message/index shards it needs, and presents a chat interface. It is a tool-calling agent: the selected model decides which tool to call (`search_messages`, `get_context`, `read_channel`) and answers once it has enough evidence. Cited sources show in a side panel rather than inline.

Answer engines sit behind one `chat(messages)` interface, so swapping the model never changes how the corpus is queried:

- Hosted OpenAI-compatible API (user-supplied base URL, model, key).
- Chrome built-in Prompt API.
- WebLLM via `@mlc-ai/web-llm` for WebGPU browsers without a built-in LLM API.
- Transformers.js via `@huggingface/transformers` for browsers without WebGPU, including Firefox.
- A no-LLM mode that returns ranked evidence only.

## Sources

- DiscordChatExporter documents JSON export, attachments, embeds, partitioning, and date filters.
- Chrome's built-in AI docs currently expose multiple browser AI APIs and recommend polyfills for browser support.
- WebLLM runs LLM inference in the browser using WebGPU with no server dependency.
