# Export Plan

## Access

Use a Discord bot token when possible. DiscordChatExporter can authenticate with user tokens, but its project documentation warns that automating user accounts can violate Discord terms. The bot needs read access to all relevant OpenMower channels, threads, and attachment URLs.

Needed from the server owner/admin:

- Bot added to the OpenMower Discord server.
- Guild/server ID.
- Permission to read target channels and archived threads.
- Permission to read message history.
- Permission to access/download attachment URLs.

## Command Shape

Confirm exact options with:

```bash
/home/jeremy/mowgli/ChatExporterBinaries/DiscordChatExporter.Cli exportguild --help
```

Expected full export:

```bash
npm run export -- --raw data/raw --parallel 8
npm run build-corpus -- --raw data/raw --out data/corpus
npm run stats -- --corpus data/corpus
```

The export command uses `%c.json` filenames to avoid path length failures from long thread names. It defaults to JSON, all threads, `25mb` partitions, and `--parallel 8`.

For incremental updates after the initial corpus exists:

```bash
npm run export -- --incremental --raw data/raw-incremental/latest --parallel 1 --retries 2 --retry-delay-seconds 60
npm run build-corpus -- --raw data/raw-incremental/latest --out data/corpus-incremental --allow-empty
npm run merge-corpus -- --base data/corpus --delta data/corpus-incremental --out data/corpus
```

The GitHub Actions workflow uses the lower incremental parallelism because Discord can return 429 responses while DiscordChatExporter is enumerating a large server and its threads. The retry flags rerun only after rate-limited exporter failures and wait at least the advertised Discord retry window.

## Attachment Policy

Keep reasonably sized attachments locally. For the first public GitHub version:

- Include metadata for every attachment in `data/corpus/messages.jsonl`.
- Download selected files into `data/attachments/`.
- Include source code uploads, configs, logs, small archives, CAD/project files, PDFs, and smaller images when useful.
- Exclude huge videos, large archives, and raw binaries unless there is a clear reason to preserve them.
- Use Git LFS or release assets if selected attachments are too large for normal git. The repository includes `.gitattributes` patterns for selected attachments and binary index shards.

Default selected attachment download:

```bash
npm run download-attachments -- --corpus data/corpus --max-size 1049600
```

Use `--extensions` and `--max-size` to widen or narrow the policy.

Discord CDN URLs stored in the corpus are signed with a short expiry and go
stale (HTTP 404). The downloader refreshes them through the Discord
`attachments/refresh-urls` API before fetching, using `DISCORD_TOKEN` from
`.env` (or `--token`). Pass `--bot` if the token is a bot token, or
`--no-refresh` to skip refreshing and use the stored URLs as-is.

## Privacy Review

Before uploading:

- Remove tokens and `.env` files.
- Review whether the Discord server permits publication of exported history.
- Consider redacting private channels, deleted-sensitive content, or personal data.
- Publish `data/corpus` only if raw messages are acceptable to publish.
- Do not publish `.env`, tokens, or raw `data/raw` scratch exports.
