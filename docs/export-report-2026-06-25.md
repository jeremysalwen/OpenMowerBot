# Export Report: 2026-06-25

## Summary

- Server: `x-tech`
- Export format: DiscordChatExporter JSON
- Export command output template: `data/raw/%c.json`
- Export result: 211 channel/thread targets exported
- Raw JSON files indexed: 210
- Indexed messages: 111,651
- Indexed authors: 2,386
- Indexed channels/threads: 210
- Messages with attachments: 6,778
- Indexed date range: 2022-03-29T17:34:24.652-04:00 to 2026-06-25T18:39:34.773-04:00
- Raw export size: 139 MB
- Derived index size: 83 MB

The first export attempt used DiscordChatExporter's default descriptive filenames and failed near the end because one thread title produced a path that exceeded the filesystem path length limit. That partial export was preserved at:

```text
data/raw.failed-pathlong-20260625-174728
```

The successful rerun used channel/thread IDs for filenames to avoid path-length failures.

## Skipped Or Failed Targets

DiscordChatExporter reported these 11 targets as skipped/failed:

- `Open Mower / dev`: parent forum channel cannot be exported directly; its threads were pulled and exported individually.
- `Important / moderators`: forbidden.
- `Voice / yet-another-voice-channel`: no matching messages.
- `Voice / random`: no matching messages.
- `Open Mower / open-mower-hardware / No GPS after regular MB 0.13 build`: no matching messages.
- `Vendor specific / stihl-imow`: no messages.
- `archive / alpha-software-feedback`: forbidden.
- `archive / 🚀-next-gen-mower-ideas`: forbidden.
- `Voice / afk`: no messages.
- `Text Channels / patreon-lounge`: forbidden.
- `moderator-only`: forbidden.

## Verification

The normalized index was built with:

```bash
npm run ingest
npm run stats
npm run search -- --q RTK --limit 3
```

The smoke search returned recent `#open-mower` RTK-related messages, confirming the CLI can query the generated index.
