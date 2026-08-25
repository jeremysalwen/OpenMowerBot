import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { readCorpusMessages } from "./corpus-shards.mjs";
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
  const maxSize = Number(options.maxSize || options.maxSizeBytes || 1025 * 1024);
  // Downloads normally land in the local data/attachments cache; the nightly
  // job points --out at a checkout of the attachments mirror instead.
  const outRoot = options.out ? path.resolve(options.out) : null;
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
  for await (const message of readCorpusMessages(corpusDir)) {
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
  await loadEnvFile(options.env || ".env");

  const corpusDir = path.resolve(options.corpus || "data/corpus");
  const outRoot = path.resolve(options.out || "data/attachments");
  const dryRun = Boolean(options.dryRun);
  const auth = createAuthScheme(options.token || process.env.DISCORD_TOKEN, options.bot);

  const wanted = await readMissingManifest(options.manifest);
  const stats = { wanted: wanted.size, matched: 0, recovered: 0, verified: 0, drifted: 0, rejected: 0, failed: 0, bytes: 0 };
  const drifted = [];
  if (wanted.size === 0) return stats;

  // Walk the corpus once to attach a current URL to each wanted entry.
  const pending = [];
  for await (const message of readCorpusMessages(corpusDir)) {
    for (const attachment of message.attachments || []) {
      const relative = toMirrorPath(attachment.localPath);
      const entry = relative && wanted.get(relative);
      if (!entry || !attachment.url) continue;
      wanted.delete(relative);
      pending.push({ ...entry, relative, url: attachment.url });
      stats.matched += 1;
    }
  }

  // A dry run only reports what would be fetched; refreshing URLs would be a
  // pointless round trip to Discord for every batch.
  if (dryRun) return stats;

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
      const target = path.join(outRoot, ...entry.relative.split("/"));
      try {
        await fs.mkdir(path.dirname(target), { recursive: true });
        const buffer = await fetchBuffer(url);
        const digest = crypto.createHash("sha256").update(buffer).digest("hex");

        if (entry.oid && digest === entry.oid) {
          stats.verified += 1;
        } else if (entry.oid) {
          // Discord re-encodes attachments, so the bytes it serves today often
          // differ from what was archived even though the image is intact:
          // 12% of the files already in the mirror show the same drift. The
          // archived original is unreachable, so a sound re-encode is the only
          // surviving copy and is worth keeping. Verify it is genuinely the
          // kind of file it claims to be rather than an error page or a
          // truncated response, and record the drift so it stays auditable.
          const problem = describeUnusable(buffer, entry.relative);
          if (problem) {
            stats.rejected += 1;
            console.error(`Rejected ${entry.relative}: ${problem}`);
            continue;
          }

          stats.drifted += 1;
          drifted.push({
            relative: entry.relative,
            expectedOid: entry.oid,
            actualOid: digest,
            expectedSize: entry.size,
            actualSize: buffer.length,
          });
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

  await writeDriftManifest(outRoot, drifted);

  return stats;
}

// Files whose bytes no longer match what was archived, recorded so the drift is
// auditable rather than silent. Merged with any existing rows by path.
async function writeDriftManifest(outRoot, rows) {
  if (rows.length === 0) return;

  const manifestPath = path.join(outRoot, "DRIFTED.tsv");
  const merged = new Map();
  try {
    const existing = await fs.readFile(manifestPath, "utf8");
    for (const line of existing.split("\n")) {
      const row = line.trim();
      if (!row || row.startsWith("#")) continue;
      merged.set(row.split("\t")[0], row);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  for (const row of rows) {
    merged.set(row.relative, [
      row.relative, row.expectedOid, row.actualOid, row.expectedSize, row.actualSize,
    ].join("\t"));
  }

  const header = [
    "# Attachments recovered from Discord whose bytes differ from the copy that",
    "# was originally archived. Discord re-encodes attachments, so these are the",
    "# same image in a different encoding, not corrupt files. The archived",
    "# original is unreachable, so the recovered copy is the surviving one.",
    "#path\texpectedOid\tactualOid\texpectedSize\tactualSize",
  ].join("\n");
  await fs.writeFile(manifestPath, `${header}\n${[...merged.values()].sort().join("\n")}\n`);
}

// Guards against Discord returning something that is not the attachment at all.
// Only checks that the payload is the kind of file it claims to be; it cannot
// and should not check byte identity, which re-encoding legitimately breaks.
const MEDIA_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf", ".zip"]);
const FILE_SIGNATURES = {
  ".png": [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  ".jpg": [[0xff, 0xd8, 0xff]],
  ".jpeg": [[0xff, 0xd8, 0xff]],
  ".gif": [[0x47, 0x49, 0x46, 0x38, 0x37, 0x61], [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]],
  ".pdf": [[0x25, 0x50, 0x44, 0x46]],
  ".zip": [[0x50, 0x4b, 0x03, 0x04], [0x50, 0x4b, 0x05, 0x06]],
};

export function describeUnusable(buffer, relative) {
  if (buffer.length === 0) return "empty response";

  const ext = path.extname(relative).toLowerCase();
  // Discord serves an HTML page for expired or blocked links.
  const head = buffer.subarray(0, 64).toString("latin1").trimStart().toLowerCase();
  if (ext !== ".html" && ext !== ".htm" && (head.startsWith("<!doctype html") || head.startsWith("<html"))) {
    return "HTML page instead of file data";
  }

  // Text and config attachments have no signature worth checking.
  if (!MEDIA_EXTENSIONS.has(ext)) return null;

  // Extensions do not reliably match content: the archive already contains a
  // PNG named .jpg. Accept any recognizable media payload rather than
  // demanding the one implied by the extension, so this gate catches error
  // pages and truncated responses without discarding a real, mislabelled file.
  return looksLikeKnownMedia(buffer) ? null : "not a recognizable media file";
}

function looksLikeKnownMedia(buffer) {
  for (const signature of Object.values(FILE_SIGNATURES).flat()) {
    if (buffer.subarray(0, signature.length).equals(Buffer.from(signature))) return true;
  }
  return buffer.length > 12
    && buffer.subarray(0, 4).toString("latin1") === "RIFF"
    && buffer.subarray(8, 12).toString("latin1") === "WEBP";
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
