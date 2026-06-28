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
  const retries = parseNonNegativeInteger(options.retries, 0);
  const retryDelaySeconds = parsePositiveInteger(options.retryDelaySeconds || options["retry-delay-seconds"], 60);

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

  await runCommandWithRetries(exporter, args, {
    env: {
      DISCORD_TOKEN: token,
    },
    retries,
    retryDelaySeconds,
  });

  return {
    rawDir,
    after,
  };
}

export async function loadEnvFile(file) {
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

async function runCommandWithRetries(command, args, options = {}) {
  const retries = options.retries || 0;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await runCommand(command, args, options.env || {});
    } catch (error) {
      const remainingRetries = retries - attempt;
      if (!remainingRetries || !isRateLimitError(error)) {
        throw error;
      }

      const retryAfterSeconds = parseRetryAfterSeconds(error.output) || 0;
      const delaySeconds = Math.max(
        options.retryDelaySeconds || 60,
        Math.ceil(retryAfterSeconds) + 15,
      );

      console.warn(`DiscordChatExporter was rate limited. Retrying in ${delaySeconds}s (${remainingRetries} ${remainingRetries === 1 ? "retry" : "retries"} left).`);
      await sleep(delaySeconds * 1000);
    }
  }
}

function runCommand(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        ...env,
      },
    });
    let output = "";

    const appendOutput = (chunk, stream) => {
      stream.write(chunk);
      output += chunk.toString("utf8");
      if (output.length > 50000) {
        output = output.slice(-50000);
      }
    };

    child.on("error", reject);
    child.stdout.on("data", (chunk) => appendOutput(chunk, process.stdout));
    child.stderr.on("data", (chunk) => appendOutput(chunk, process.stderr));
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new CommandError(`${command} exited with code ${code}`, code, output));
      }
    });
  });
}

function parseNonNegativeInteger(value, fallback) {
  if (value === undefined || value === null || value === false) return fallback;

  const normalized = String(value).trim();
  if (!/^\d+$/.test(normalized)) {
    throw new Error(`Expected a non-negative integer, got: ${value}`);
  }

  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Expected a non-negative integer, got: ${value}`);
  }

  return parsed;
}

function parsePositiveInteger(value, fallback) {
  if (value === undefined || value === null || value === false) return fallback;

  const normalized = String(value).trim();
  if (!/^\d+$/.test(normalized)) {
    throw new Error(`Expected a positive integer, got: ${value}`);
  }

  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, got: ${value}`);
  }

  return parsed;
}

function isRateLimitError(error) {
  const output = error?.output || "";
  return /rate limited|too many requests/i.test(output);
}

function parseRetryAfterSeconds(output = "") {
  const match = String(output).match(/retry_after["']?\s*:\s*([0-9.]+)/i);
  if (!match) return null;

  const value = Number.parseFloat(match[1]);
  return Number.isFinite(value) ? value : null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class CommandError extends Error {
  constructor(message, code, output) {
    super(message);
    this.name = "CommandError";
    this.code = code;
    this.output = output;
  }
}
