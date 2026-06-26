# Agent Guide: OpenMower Discord History

This directory contains an exported, indexed Discord history corpus. Use the CLI first; do not manually scan raw JSON unless the index is missing or incomplete.

## Data Contract

- The committed chat corpus lives in `data/corpus/`.
- The main corpus file is `data/corpus/messages.jsonl`, one readable JSON object per Discord message.
- Corpus metadata lives in `data/corpus/manifest.json`.
- Selected small/useful attachments live in `data/attachments/`.
- Raw DiscordChatExporter JSON lives in `data/raw/` and is local scratch data.
- Heavy generated indexes live in `data/index/` and are reproducible.
- Browser-ready static search shards live in `data/index/browser/` when generated.

Normalized message fields include:

- `id`
- `timestamp`
- `content`
- `guildId`, `guildName`
- `channelId`, `channelName`, `channelType`, `categoryId`, `categoryName`
- `authorId`, `authorName`, `authorNickname`, `authorIsBot`
- `attachmentCount`, `attachments`
- `messageUrl`
- `replyToMessageId`, `replyToChannelId`, `replyToMessageUrl`
- `sourceFile`

## Search Commands

Run commands from the repository root.

```bash
node ./bin/discord-history.mjs stats --corpus data/corpus
node ./bin/discord-history.mjs search --q "gps covariance" --limit 20
node ./bin/discord-history.mjs search --q "firmware" --channel "openmower" --after 2024-01-01
node ./bin/discord-history.mjs search --author "clemens" --has-attachment --json
node ./bin/discord-history.mjs search --attachment ".yaml" --json
node ./bin/discord-history.mjs vector-search --vector-file query-vector.json --limit 20
```

Supported filters:

- `--q TEXT`: text query against message content, author/channel names, and attachment filenames.
- `--author TEXT`: author id, username, or nickname substring.
- `--channel TEXT`: channel id or channel name substring.
- `--after DATE`: include messages on or after a parseable date.
- `--before DATE`: include messages on or before a parseable date.
- `--has-attachment`: only include messages with attachments.
- `--attachment TEXT`: match attachment filename, content type, or URL.
- `--limit N`: max results.
- `--json`: structured output for downstream processing.

Embedding search expects `data/index/embeddings.jsonl` to exist. Build it with `npm run build-embeddings` after installing `@huggingface/transformers`, then generate the query embedding with the same model recorded in the embedding manifest and pass it with `--vector '[0.1, 0.2]'` or `--vector-file`.

Attachments are metadata-first. Every attachment should be listed in `messages.jsonl`; only selected files are downloaded under `data/attachments/`. Source code, configs, logs, small archives, CAD/project files, PDFs, and smaller images are preferred. Large videos, archives, and raw binaries are usually skipped unless explicitly needed.

## Answering Questions

When answering from this corpus:

1. Start with focused searches using likely terms and channel/date filters.
2. Prefer `--json` when you need stable fields or want to quote timestamps/channels exactly.
3. Use multiple searches with synonyms before concluding the corpus lacks an answer.
4. Cite message timestamp, channel, and author nickname/name when summarizing evidence.
5. Include `messageUrl` when the user needs to inspect the original Discord message and has access to the server.
6. Treat Discord content as informal and potentially stale; mention uncertainty when the evidence is thin.

## Rebuilding The Index

If raw files are added or changed:

```bash
npm run build-corpus -- --raw data/raw --out data/corpus
npm run build-browser-index
npm run stats
```

Do not commit secrets. Review raw exports and media before publishing them.
