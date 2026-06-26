import fs from "node:fs/promises";
import path from "node:path";

const JSON_EXT = ".json";

export async function findJsonFiles(root) {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await findJsonFiles(fullPath));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(JSON_EXT)) {
      files.push(fullPath);
    }
  }

  return files.sort();
}

export async function* normalizeDiscordChatExporterFiles(files, options = {}) {
  for (const file of files) {
    const raw = JSON.parse(await fs.readFile(file, "utf8"));
    yield* normalizeDiscordChatExporterExport(raw, {
      sourceFile: options.relativeTo ? path.relative(options.relativeTo, file) : file,
    });
  }
}

export function* normalizeDiscordChatExporterExport(exported, context = {}) {
  const guild = exported.guild || {};
  const channel = exported.channel || {};
  const messages = Array.isArray(exported.messages) ? exported.messages : [];

  for (const message of messages) {
    const author = message.author || {};
    const attachments = Array.isArray(message.attachments)
      ? message.attachments.map(normalizeAttachment)
      : [];

    yield {
      id: String(message.id || ""),
      type: message.type || null,
      timestamp: message.timestamp || null,
      timestampEdited: message.timestampEdited || null,
      isPinned: Boolean(message.isPinned),
      content: message.content || "",
      guildId: guild.id || null,
      guildName: guild.name || null,
      channelId: channel.id || null,
      channelName: channel.name || null,
      channelType: channel.type || null,
      categoryId: channel.categoryId || null,
      categoryName: channel.category || null,
      authorId: author.id || null,
      authorName: author.name || null,
      authorNickname: author.nickname || null,
      authorIsBot: Boolean(author.isBot),
      attachmentCount: attachments.length,
      attachments,
      embedCount: Array.isArray(message.embeds) ? message.embeds.length : 0,
      stickerCount: Array.isArray(message.stickers) ? message.stickers.length : 0,
      reactionCount: Array.isArray(message.reactions) ? message.reactions.length : 0,
      mentionIds: Array.isArray(message.mentions)
        ? message.mentions.map((mention) => mention.id).filter(Boolean)
        : [],
      sourceFile: context.sourceFile || null,
    };
  }
}

function normalizeAttachment(attachment) {
  return {
    id: attachment.id || null,
    url: attachment.url || null,
    fileName: attachment.fileName || attachment.filename || null,
    fileSizeBytes: attachment.fileSizeBytes || attachment.fileSize || null,
    contentType: attachment.contentType || null,
  };
}

export function updateManifest(manifest, message) {
  manifest.messageCount += 1;

  if (message.timestamp) {
    manifest.dateRange.after = minIso(manifest.dateRange.after, message.timestamp);
    manifest.dateRange.before = maxIso(manifest.dateRange.before, message.timestamp);
  }

  incrementMapCount(manifest.guilds, message.guildId, message.guildName);
  incrementMapCount(manifest.channels, message.channelId, message.channelName);
  incrementMapCount(
    manifest.authors,
    message.authorId,
    message.authorNickname || message.authorName,
  );

  if (message.attachmentCount > 0) {
    manifest.attachmentMessageCount += 1;
  }
}

export function createManifest() {
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    messageCount: 0,
    attachmentMessageCount: 0,
    dateRange: {
      after: null,
      before: null,
    },
    guilds: {},
    channels: {},
    authors: {},
    files: {
      messages: "messages.jsonl",
      embeddings: "embeddings.jsonl",
    },
  };
}

function incrementMapCount(map, id, name) {
  const key = id || "unknown";
  if (!map[key]) {
    map[key] = { id, name: name || null, count: 0 };
  }
  map[key].count += 1;
  if (!map[key].name && name) {
    map[key].name = name;
  }
}

function minIso(current, next) {
  if (!current) return next;
  return new Date(next) < new Date(current) ? next : current;
}

function maxIso(current, next) {
  if (!current) return next;
  return new Date(next) > new Date(current) ? next : current;
}
