import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { readJsonl } from "./jsonl.mjs";
import { findJsonFiles } from "./normalize.mjs";

const MAX_ATTACHMENT_FILE_NAME_LENGTH = 100;

export async function buildCorpusFromDiscordChatExporter(rawDir, outDir, options = {}) {
  await fs.mkdir(outDir, { recursive: true });

  const files = await findJsonFiles(rawDir);
  if (files.length === 0) {
    if (options.allowEmpty) {
      const manifest = createCorpusManifest();
      const messagesPath = path.join(outDir, "messages.jsonl");
      const manifestPath = path.join(outDir, "manifest.json");
      await fs.writeFile(messagesPath, "");
      await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      return {
        manifest,
        sourceFileCount: 0,
        messagesPath,
        manifestPath,
      };
    }

    throw new Error(`No DiscordChatExporter JSON files found under ${rawDir}`);
  }

  const messagesPath = path.join(outDir, "messages.jsonl");
  const manifestPath = path.join(outDir, "manifest.json");
  const manifest = createCorpusManifest();
  const output = await fs.open(messagesPath, "w");

  try {
    for (const file of files) {
      const exported = JSON.parse(await fs.readFile(file, "utf8"));
      const sourceFile = path.relative(rawDir, file);

      updateGuild(manifest, exported.guild);

      for (const message of exported.messages || []) {
        const compact = compactMessage(exported, message, sourceFile);
        updateCorpusManifest(manifest, compact);
        await output.write(`${JSON.stringify(compact)}\n`);
      }
    }
  } finally {
    await output.close();
  }

  manifest.sourceFileCount = files.length;
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  return {
    manifest,
    sourceFileCount: files.length,
    messagesPath,
    manifestPath,
  };
}

export async function mergeCorpusDirs(baseDir, deltaDir, outDir) {
  const messages = new Map();

  await loadCorpusMessages(path.join(baseDir, "messages.jsonl"), messages);
  await loadCorpusMessages(path.join(deltaDir, "messages.jsonl"), messages);

  const sorted = [...messages.values()].sort(compareMessagesAsc);
  const manifest = createCorpusManifest();

  await fs.mkdir(outDir, { recursive: true });
  const messagesPath = path.join(outDir, "messages.jsonl");
  const manifestPath = path.join(outDir, "manifest.json");
  const output = await fs.open(messagesPath, "w");

  try {
    for (const message of sorted) {
      updateCorpusManifest(manifest, message);
      await output.write(`${JSON.stringify(message)}\n`);
    }
  } finally {
    await output.close();
  }

  manifest.sourceFileCount = 0;
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  return {
    manifest,
    messagesPath,
    manifestPath,
  };
}

export function createCorpusManifest() {
  return {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    messageCount: 0,
    attachmentMessageCount: 0,
    attachmentCount: 0,
    attachmentBytes: 0,
    dateRange: {
      after: null,
      before: null,
    },
    guilds: {},
    channels: {},
    authors: {},
    files: {
      messages: "messages.jsonl",
      embeddings: "../index/embeddings.jsonl",
    },
  };
}

export function compactMessage(exported, message, sourceFile = null) {
  const channel = exported.channel || {};
  const author = message.author || {};
  const reference = message.reference || null;
  const attachments = Array.isArray(message.attachments)
    ? message.attachments.map((attachment) => compactAttachment(attachment, channel.id))
    : [];

  return {
    id: String(message.id || ""),
    timestamp: message.timestamp || null,
    timestampEdited: message.timestampEdited || null,
    type: message.type || null,
    content: message.content || "",
    guildId: exported.guild?.id || null,
    guildName: exported.guild?.name || null,
    channelId: channel.id || null,
    channelName: channel.name || null,
    channelType: channel.type || null,
    categoryId: channel.categoryId || null,
    categoryName: channel.category || null,
    authorId: author.id || null,
    authorName: author.name || null,
    authorNickname: author.nickname || null,
    authorIsBot: Boolean(author.isBot),
    replyToMessageId: reference?.messageId || null,
    replyToChannelId: reference?.channelId || null,
    messageUrl: buildDiscordMessageUrl(exported.guild?.id, channel.id, message.id),
    replyToMessageUrl: reference
      ? buildDiscordMessageUrl(reference.guildId || exported.guild?.id, reference.channelId, reference.messageId)
      : null,
    attachmentCount: attachments.length,
    attachments,
    sourceFile,
  };
}

function buildDiscordMessageUrl(guildId, channelId, messageId) {
  if (!guildId || !channelId || !messageId) {
    return null;
  }

  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}

function compactAttachment(attachment, channelId) {
  const id = attachment.id || null;
  const fileName = attachment.fileName || attachment.filename || null;

  return {
    id,
    fileName,
    fileSizeBytes: attachment.fileSizeBytes || attachment.fileSize || null,
    contentType: attachment.contentType || inferContentType(fileName),
    url: attachment.url || null,
    localPath: id && fileName && channelId
      ? path.posix.join("data/attachments", String(channelId), `${id}-${safeFileName(fileName)}`)
      : null,
  };
}

function updateCorpusManifest(manifest, message) {
  manifest.messageCount += 1;

  if (message.timestamp) {
    manifest.dateRange.after = minIso(manifest.dateRange.after, message.timestamp);
    manifest.dateRange.before = maxIso(manifest.dateRange.before, message.timestamp);
  }

  incrementMapCount(manifest.channels, message.channelId, message.channelName);
  incrementMapCount(
    manifest.authors,
    message.authorId,
    message.authorNickname || message.authorName,
  );

  if (message.attachmentCount > 0) {
    manifest.attachmentMessageCount += 1;
  }

  for (const attachment of message.attachments || []) {
    manifest.attachmentCount += 1;
    manifest.attachmentBytes += Number(attachment.fileSizeBytes || 0);
  }
}

function updateGuild(manifest, guild = {}) {
  if (!guild.id && !guild.name) {
    return;
  }

  const key = guild.id || guild.name;
  if (!manifest.guilds[key]) {
    manifest.guilds[key] = {
      id: guild.id || null,
      name: guild.name || null,
      count: 0,
    };
  }
  manifest.guilds[key].count += 1;
}

async function loadCorpusMessages(messagesPath, messages) {
  try {
    for await (const message of readJsonl(messagesPath)) {
      if (message.id) {
        messages.set(message.id, message);
      }
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
}

function compareMessagesAsc(left, right) {
  const byTime = (Date.parse(left.timestamp || 0) || 0) - (Date.parse(right.timestamp || 0) || 0);
  if (byTime !== 0) return byTime;
  return String(left.id || "").localeCompare(String(right.id || ""));
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

function inferContentType(fileName) {
  const ext = path.extname(fileName || "").toLowerCase();
  if ([".jpg", ".jpeg"].includes(ext)) return "image/jpeg";
  if (ext === ".png") return "image/png";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  if (ext === ".txt" || ext === ".log") return "text/plain";
  if (ext === ".json") return "application/json";
  if (ext === ".pdf") return "application/pdf";
  if ([".yaml", ".yml"].includes(ext)) return "application/x-yaml";
  return null;
}

function safeFileName(fileName) {
  const cleaned = String(fileName)
    .replace(/[^\w.+=@-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    || "attachment";

  if (cleaned.length <= MAX_ATTACHMENT_FILE_NAME_LENGTH) {
    return cleaned;
  }

  const ext = path.extname(cleaned).slice(0, 20);
  const stem = cleaned.slice(0, cleaned.length - ext.length) || "attachment";
  const hash = crypto.createHash("sha1").update(cleaned).digest("hex").slice(0, 10);
  const stemLength = Math.max(1, MAX_ATTACHMENT_FILE_NAME_LENGTH - ext.length - hash.length - 1);

  return `${stem.slice(0, stemLength)}-${hash}${ext}`;
}
