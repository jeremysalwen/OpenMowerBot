import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

export async function runDiscordChatExporter(options = {}) {
  await loadEnvFile(options.env || ".env");

  const exporter = path.resolve(options.exporter || process.env.DISCORD_CHAT_EXPORTER || "../ChatExporterBinaries/DiscordChatExporter.Cli");
  const token = options.token || process.env.DISCORD_TOKEN;
  const guild = options.guild || process.env.OPENMOWER_GUILD_ID;

  if (!token) {
    throw new Error("Missing Discord token. Set DISCORD_TOKEN in .env or pass --token.");
  }

  if (!guild) {
    throw new Error("Missing guild id. Set OPENMOWER_GUILD_ID in .env or pass --guild.");
  }

  const incremental = Boolean(options.incremental);
  const rawDir = path.resolve(options.raw || defaultRawDir(incremental));
  const after = options.after || (incremental ? await readManifestWatermark(options.manifest || "data/corpus/manifest.json") : null);
  const outputTemplate = path.join(rawDir, options.outputTemplate || "%c.json");

  await fs.mkdir(rawDir, { recursive: true });

  const args = [
    "exportguild",
    "--token", token,
    "--guild", guild,
    "--format", options.format || "Json",
    "--output", outputTemplate,
    "--include-threads", options.includeThreads || "All",
    "--partition", options.partition || "25mb",
    "--parallel", String(options.parallel || 8),
  ];

  if (after) {
    args.push("--after", after);
  }

  if (options.media) {
    args.push("--media", "true");
    args.push("--reuse-media", "true");
    args.push("--media-dir", path.resolve(options.mediaDir || "data/media"));
  }

  await runCommand(exporter, args, {
    DISCORD_TOKEN: token,
  });

  return {
    rawDir,
    after,
  };
}

async function loadEnvFile(file) {
  let content;
  try {
    content = await fs.readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;

    const [, key, rawValue] = match;
    if (process.env[key]) continue;

    process.env[key] = rawValue
      .replace(/^['"]|['"]$/g, "")
      .replace(/\\n/g, "\n");
  }
}

async function readManifestWatermark(manifestPath) {
  const manifest = JSON.parse(await fs.readFile(path.resolve(manifestPath), "utf8"));
  return manifest.dateRange?.before || null;
}

function defaultRawDir(incremental) {
  if (!incremental) {
    return "data/raw";
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join("data/raw-incremental", stamp);
}

function runCommand(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      env: {
        ...process.env,
        ...env,
      },
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} exited with code ${code}`));
      }
    });
  });
}
