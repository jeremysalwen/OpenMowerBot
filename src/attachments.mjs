import crypto from "node:crypto";
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
      const target = resolveAttachmentTarget(attachment.localPath, outRoot);

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

// Recover attachments that are listed in the corpus but absent from the
// attachments mirror.
//
// These are files the archive already held before attachments moved out of Git
// LFS; the only other copies are LFS objects behind an exhausted budget. Their
// Discord CDN URLs have expired, but Discord's refresh-urls endpoint re-signs
// them as long as the original message still exists, so they can be fetched
// straight from Discord and never touch the LFS budget.
//
// Unlike downloadSelectedAttachments this takes no size cap: every entry is a
// file the archive already contained, so recovering it restores the archive
// rather than expanding what it collects. When a manifest supplies the
// expected sha256 (the old LFS oid), the download is verified against it, so a
// recovered file is provably the original bytes.
export async function recoverMissingAttachments(options = {}) {
  const corpusDir = path.resolve(options.corpus || "data/corpus");
  const messagesPath = path.join(corpusDir, "messages.jsonl");
  const outRoot = path.resolve(options.out || "data/attachments");
  const dryRun = Boolean(options.dryRun);
  const auth = createAuthScheme(options.token || process.env.DISCORD_TOKEN, options.bot);

  const wanted = await readMissingManifest(options.manifest);
  const stats = { wanted: wanted.size, matched: 0, recovered: 0, verified: 0, mismatched: 0, failed: 0, bytes: 0 };
  if (wanted.size === 0) return stats;

  // Walk the corpus once to attach a current URL to each wanted entry.
  const pending = [];
  for await (const message of readJsonl(messagesPath)) {
    for (const attachment of message.attachments || []) {
      const relative = toMirrorPath(attachment.localPath);
      const entry = relative && wanted.get(relative);
      if (!entry || !attachment.url) continue;
      wanted.delete(relative);
      pending.push({ ...entry, relative, url: attachment.url });
      stats.matched += 1;
    }
  }

  for (let index = 0; index < pending.length; index += REFRESH_BATCH_SIZE) {
    const batch = pending.slice(index, index + REFRESH_BATCH_SIZE);
    let refreshed = new Map();
    try {
      refreshed = await refreshAttachmentUrls(batch.map((entry) => entry.url), auth);
    } catch (error) {
      console.error(`Failed to refresh URLs: ${error.message}`);
    }

    for (const entry of batch) {
      const url = refreshed.get(entry.url) || entry.url;
      if (dryRun) continue;

      const target = path.join(outRoot, ...entry.relative.split("/"));
      try {
        await fs.mkdir(path.dirname(target), { recursive: true });
        const buffer = await fetchBuffer(url);
        if (entry.oid) {
          const digest = crypto.createHash("sha256").update(buffer).digest("hex");
          if (digest === entry.oid) {
            stats.verified += 1;
          } else {
            // Discord served something other than the archived bytes; keeping
            // it would silently corrupt the archive.
            stats.mismatched += 1;
            console.error(`Checksum mismatch, not written: ${entry.relative}`);
            continue;
          }
        }
        await fs.writeFile(target, buffer);
        stats.recovered += 1;
        stats.bytes += buffer.length;
      } catch (error) {
        stats.failed += 1;
        console.error(`Failed to recover ${entry.relative}: ${error.message}`);
      }
    }
  }

  return stats;
}

// Write the mirror's index of held files, one repo-relative path per line, so a
// Pages build can tell what is linkable without cloning the image data.
export async function writeAttachmentIndex(mirrorDir, options = {}) {
  const indexName = options.indexName || "INDEX.txt";
  const root = path.resolve(mirrorDir);
  const paths = [];

  async function walk(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        const relative = path.relative(root, full).split(path.sep).join("/");
        // Repository metadata is not attachment content.
        if (!relative.includes("/")) continue;
        paths.push(relative);
      }
    }
  }

  await walk(root);
  paths.sort();
  const target = path.join(root, indexName);
  await fs.writeFile(target, `${paths.join("\n")}\n`);

  // Entries that have since been recovered are no longer missing.
  let pruned = 0;
  if (options.missing) {
    const held = new Set(paths);
    const missingPath = path.resolve(options.missing);
    const text = await fs.readFile(missingPath, "utf8");
    const kept = [];
    for (const line of text.split("\n")) {
      const row = line.trim();
      if (!row) continue;
      if (row.startsWith("#")) { kept.push(line); continue; }
      const relative = row.split("\t")[2];
      if (relative && held.has(relative)) { pruned += 1; continue; }
      kept.push(line);
    }
    await fs.writeFile(missingPath, `${kept.join("\n")}\n`);
  }

  return { path: target, count: paths.length, pruned };
}

// Attachment paths in the corpus are rooted at data/attachments/. Rebase them
// when writing somewhere else, such as a checkout of the attachments mirror.
function resolveAttachmentTarget(localPath, outRoot) {
  const relative = outRoot ? toMirrorPath(localPath) : null;
  return relative ? path.join(outRoot, ...relative.split("/")) : path.resolve(localPath);
}

// A missing-attachments manifest is TSV: oid, size, mirror-relative path.
// Comment and blank lines are ignored. Returns a map keyed by that path.
async function readMissingManifest(manifestPath) {
  const wanted = new Map();
  if (!manifestPath) return wanted;

  const text = await fs.readFile(path.resolve(manifestPath), "utf8");
  for (const line of text.split("\n")) {
    const row = line.trim();
    if (!row || row.startsWith("#")) continue;
    const [oid, size, relative] = row.split("\t");
    if (!relative) continue;
    wanted.set(relative, { oid: oid || null, size: Number(size) || 0 });
  }
  return wanted;
}

// Corpus localPath values carry the data/attachments/ prefix; the mirror is
// rooted at the channel id.
function toMirrorPath(localPath) {
  if (!localPath) return null;
  const normalized = String(localPath).split(path.sep).join("/");
  const marker = "data/attachments/";
  const at = normalized.indexOf(marker);
  return at === -1 ? null : normalized.slice(at + marker.length);
}

async function fetchBuffer(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}
