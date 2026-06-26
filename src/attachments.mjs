import fs from "node:fs/promises";
import path from "node:path";
import { readJsonl } from "./jsonl.mjs";

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
]);

export async function downloadSelectedAttachments(options = {}) {
  const corpusDir = path.resolve(options.corpus || "data/corpus");
  const messagesPath = path.join(corpusDir, "messages.jsonl");
  const maxSize = Number(options.maxSize || options.maxSizeBytes || 500_000);
  const extensions = parseExtensions(options.extensions);
  const force = Boolean(options.force);
  const dryRun = Boolean(options.dryRun);
  const stats = {
    considered: 0,
    selected: 0,
    downloaded: 0,
    skippedExisting: 0,
    skippedSize: 0,
    skippedType: 0,
    failed: 0,
    bytes: 0,
    selectedBytes: 0,
  };

  for await (const message of readJsonl(messagesPath)) {
    for (const attachment of message.attachments || []) {
      stats.considered += 1;

      const size = Number(attachment.fileSizeBytes || 0);
      if (size > maxSize) {
        stats.skippedSize += 1;
        continue;
      }

      const ext = path.extname(attachment.fileName || "").toLowerCase();
      if (extensions.size > 0 && !extensions.has(ext)) {
        stats.skippedType += 1;
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

      if (dryRun) {
        continue;
      }

      try {
        await fs.mkdir(path.dirname(target), { recursive: true });
        await downloadFile(attachment.url, target);
        stats.downloaded += 1;
        stats.bytes += size;
      } catch (error) {
        stats.failed += 1;
        console.error(`Failed to download ${attachment.url}: ${error.message}`);
      }
    }
  }

  return stats;
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
