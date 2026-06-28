import fs from "node:fs/promises";
import path from "node:path";
import { readJsonl } from "./jsonl.mjs";
import { loadEnvFile } from "./exporter.mjs";

const DEFAULT_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".txt",
  ".log",
  ".yaml",
  ".yml",
  ".json",
  ".md",
  ".csv",
  ".zip",
  ".tar",
  ".gz",
  ".tgz",
  ".c",
  ".cc",
  ".cpp",
  ".cxx",
  ".h",
  ".hh",
  ".hpp",
  ".hxx",
  ".ino",
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".py",
  ".sh",
  ".bash",
  ".zsh",
  ".rs",
  ".go",
  ".java",
  ".kt",
  ".lua",
  ".cmake",
  ".dockerfile",
  ".toml",
  ".ini",
  ".cfg",
  ".conf",
  ".service",
  ".launch",
  ".urdf",
  ".xacro",
  ".xml",
  ".html",
  ".pdf",
  ".stl",
  ".kicad_pcb",
  ".kicad_sch",
  ".bag",
  ".mcap",
  ".db3",
]);

// Rosbag recordings are valuable but routinely exceed the generic size cap, so
// they are downloaded regardless of --max-size (when their extension is allowed).
const NO_SIZE_LIMIT_EXTENSIONS = new Set([".bag", ".mcap", ".db3"]);

// Discord signs CDN URLs with a short-lived expiry, so URLs stored in the
// corpus go stale (HTTP 404). The attachments/refresh-urls endpoint mints fresh
// URLs for them. It accepts up to 50 URLs per request.
const REFRESH_ENDPOINT = "https://discord.com/api/v10/attachments/refresh-urls";
const REFRESH_BATCH_SIZE = 50;

export async function downloadSelectedAttachments(options = {}) {
  await loadEnvFile(options.env || ".env");

  const corpusDir = path.resolve(options.corpus || "data/corpus");
  const messagesPath = path.join(corpusDir, "messages.jsonl");
  const maxSize = Number(options.maxSize || options.maxSizeBytes || 1025 * 1024);
  const extensions = parseExtensions(options.extensions);
  const force = Boolean(options.force);
  const dryRun = Boolean(options.dryRun);
  const token = options.token || process.env.DISCORD_TOKEN || null;
  // refresh-urls needs a "Bot <token>" prefix for bot tokens; user tokens are
  // sent raw. Auto-detected on the first request, overridable via --bot.
  const refresh = options.refresh !== false && options.noRefresh !== true;
  const auth = createAuthScheme(token, options.bot);
  const stats = {
    considered: 0,
    selected: 0,
    downloaded: 0,
    refreshed: 0,
    skippedExisting: 0,
    skippedSize: 0,
    skippedType: 0,
    failed: 0,
    bytes: 0,
    selectedBytes: 0,
  };

  // Phase 1: decide what to fetch before touching the network so URLs can be
  // refreshed in batches right before download (refreshed URLs also expire).
  const pending = [];
  for await (const message of readJsonl(messagesPath)) {
    for (const attachment of message.attachments || []) {
      stats.considered += 1;

      const ext = path.extname(attachment.fileName || "").toLowerCase();
      if (extensions.size > 0 && !extensions.has(ext)) {
        stats.skippedType += 1;
        continue;
      }

      const size = Number(attachment.fileSizeBytes || 0);
      if (size > maxSize && !NO_SIZE_LIMIT_EXTENSIONS.has(ext)) {
        stats.skippedSize += 1;
        continue;
      }

      if (!attachment.url || !attachment.localPath) {
        stats.skippedType += 1;
        continue;
      }

      stats.selected += 1;
      stats.selectedBytes += size;
      const target = path.resolve(attachment.localPath);

      if (!force && await exists(target)) {
        stats.skippedExisting += 1;
        continue;
      }

      pending.push({ url: attachment.url, target, size });
    }
  }

  if (dryRun || pending.length === 0) {
    return stats;
  }

  if (refresh && !token) {
    console.warn("No DISCORD_TOKEN found; downloading with stored URLs, which may be expired. Set DISCORD_TOKEN in .env to refresh them.");
  }

  // Phase 2: refresh + download in batches.
  for (let i = 0; i < pending.length; i += REFRESH_BATCH_SIZE) {
    const batch = pending.slice(i, i + REFRESH_BATCH_SIZE);
    let urlMap = new Map();
    if (refresh && token) {
      try {
        urlMap = await refreshAttachmentUrls(batch.map((item) => item.url), auth);
        stats.refreshed += urlMap.size;
      } catch (error) {
        console.error(`Failed to refresh attachment URLs: ${error.message}`);
      }
    }

    for (const item of batch) {
      const downloadUrl = urlMap.get(item.url) || item.url;
      try {
        await fs.mkdir(path.dirname(item.target), { recursive: true });
        await downloadFile(downloadUrl, item.target);
        stats.downloaded += 1;
        stats.bytes += item.size;
      } catch (error) {
        stats.failed += 1;
        console.error(`Failed to download ${item.url}: ${error.message}`);
      }
    }
  }

  return stats;
}

// Build a token authorization header, auto-detecting user vs. bot token. Discord
// rejects user tokens with a "Bot " prefix and vice versa, so on the first 401
// we flip the scheme and remember it for subsequent batches.
function createAuthScheme(token, forceBot) {
  let bot = Boolean(forceBot);
  return {
    get header() {
      return token ? (bot ? `Bot ${token}` : token) : null;
    },
    flip() {
      bot = !bot;
    },
  };
}

async function refreshAttachmentUrls(urls, auth, attempt = 0) {
  if (!auth.header) return new Map();

  const response = await fetch(REFRESH_ENDPOINT, {
    method: "POST",
    headers: {
      "Authorization": auth.header,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ attachment_urls: urls }),
  });

  if (response.status === 401 && attempt === 0) {
    // Wrong token scheme; flip user<->bot and retry once.
    auth.flip();
    return refreshAttachmentUrls(urls, auth, attempt + 1);
  }

  if (response.status === 429) {
    const retryAfter = Number(response.headers.get("retry-after")) || 1;
    await sleep((retryAfter + 0.5) * 1000);
    return refreshAttachmentUrls(urls, auth, attempt);
  }

  if (!response.ok) {
    throw new Error(`refresh-urls HTTP ${response.status}`);
  }

  const data = await response.json();
  const map = new Map();
  for (const entry of data.refreshed_urls || []) {
    if (entry?.original && entry?.refreshed) {
      map.set(entry.original, entry.refreshed);
    }
  }
  return map;
}

function parseExtensions(value) {
  if (!value) {
    return DEFAULT_EXTENSIONS;
  }

  if (String(value).toLowerCase() === "all") {
    return new Set();
  }

  return new Set(
    String(value)
      .split(",")
      .map((ext) => ext.trim().toLowerCase())
      .filter(Boolean)
      .map((ext) => ext.startsWith(".") ? ext : `.${ext}`),
  );
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function downloadFile(url, target) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(target, buffer);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
