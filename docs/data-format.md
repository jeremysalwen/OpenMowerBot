# Data Format

## Raw

`data/raw/` contains DiscordChatExporter JSON. Each file has guild metadata, channel metadata, export metadata, and a `messages` array.

Raw data is local scratch data. Re-run corpus generation instead of editing raw exports.

## Corpus Messages

`data/corpus/messages-YYYY.jsonl` is newline-delimited JSON, split into one file per calendar year. Each line is one readable message record intended for git, agents, and browser preprocessing.

The corpus is sharded by year because GitHub rejects any file over 100 MB, and a single `messages.jsonl` had reached 98 MB. Year shards keep every file far below that ceiling and confine growth to the current year. Readers concatenate the shards in filename order, which is chronological.

Example:

```json
{
  "id": "123",
  "timestamp": "2024-01-01T12:00:00.000-05:00",
  "content": "example",
  "guildId": "456",
  "guildName": "OpenMower",
  "channelId": "789",
  "channelName": "general",
  "messageUrl": "https://discord.com/channels/456/789/123",
  "authorId": "111",
  "authorName": "user",
  "authorNickname": "User",
  "replyToMessageId": null,
  "replyToChannelId": null,
  "replyToMessageUrl": null,
  "attachmentCount": 0,
  "attachments": [],
  "sourceFile": "OpenMower - general [789].json"
}
```

The schema is append-friendly. Browser and CLI tools should ignore unknown fields.

## Manifest

`data/corpus/manifest.json` contains:

- `schemaVersion`
- `generatedAt`
- `messageCount`
- `attachmentMessageCount`
- `dateRange`
- counted maps for `guilds`, `channels`, and `authors`
- derived file names

## Attachments

Every attachment is represented as metadata in the message record. Selected downloaded files live under `data/attachments/`, and each attachment record includes a `localPath` when a deterministic local path can be generated.

## Embeddings

```text
data/index/embeddings.jsonl
data/index/embeddings-manifest.json
```

Each line:

```json
{"id":"message-id-or-chunk-id","model":"model-name","dims":384,"vector":[0.01,-0.02]}
```

Build with:

```bash
npm install --save-optional @huggingface/transformers
npm run build-embeddings
```

For browser use, vectors can later be sharded and quantized. Keep message/chunk IDs stable so embedding shards can be regenerated without breaking citations.

## Browser Shards

For static hosting, derive smaller shards from the corpus:

```text
data/index/browser/manifest.json
data/index/browser/messages/messages-000.json
data/index/browser/messages/messages-001.json
data/index/browser/search/terms-*.json
data/index/browser/archive/index.html
data/index/browser/archive/channels/<channel-slug>/page-001.html
data/index/browser/archive/channels/<channel-slug>/pages.html
data/index/browser/archive/channels/<channel-slug>/dates.html
data/index/vectors/vectors-*.bin
```

Generate the browser lexical index with:

```bash
npm run build-browser-index
```

The CLI can use the monolithic JSONL first. The browser assistant should use sharded files to avoid loading the full corpus upfront. The generated archive pages are normal static HTML for GitHub Pages and search engines: one hierarchical section/channel/thread index, channel roots that open the latest messages, paginated message pages, per-channel page indexes, and per-channel date indexes.
