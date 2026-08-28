import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const DEFAULT_MAX_AGE_SECONDS = 180;
const DEFAULT_MAX_FRAME_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_PIXELS = 16_000_000;
const DEFAULT_MAX_FRAMES = 1;

function enabled(value, fallback = true) {
  if (value === undefined || value === null || value === "") return fallback;
  return !["0", "false", "off", "no", "disabled"].includes(String(value).toLowerCase());
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed)
    ? Math.max(minimum, Math.min(maximum, parsed))
    : fallback;
}

export function defaultVisionDirectory(env = process.env) {
  const configured = String(env.AIFACTORY_VISION_DIR ?? "").trim();
  if (configured) return path.resolve(configured);
  const localAppData = String(env.LOCALAPPDATA ?? "").trim();
  return localAppData
    ? path.join(localAppData, "FactoryGame", "Saved", "AIFactoryCopilot", "Vision")
    : null;
}

/** Visual judgement is the only automatic image trigger; normal game questions stay text-only. */
export function isVisionQuestion(question, env = process.env) {
  if (!enabled(env.AIFACTORY_VISION, true)) return false;
  if (enabled(env.AIFACTORY_VISION_ALWAYS, false)) return true;
  return /\b(?:look|see|screen|screenshot|view|visual|appearance|aesthetic|style|beautiful|ugly|looks?|blue\s?print|architecture|building design|facade|façade|symmetry|decorate|decoration|color scheme|colour scheme)\b/i.test(
    String(question ?? ""),
  );
}

function pngDimensions(buffer) {
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (buffer.toString("ascii", 12, 16) !== "IHDR") return null;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (!width || !height) return null;
  return { width, height, pixels: width * height };
}

function safeMetadata(raw, sidecarName) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const frameIndex = Number(parsed?.frame_index);
  const capturedAtMs = Date.parse(String(parsed?.captured_at_utc ?? ""));
  if (!Number.isInteger(frameIndex) || frameIndex < 0 || frameIndex > 999_999 ||
      !Number.isFinite(capturedAtMs)) {
    return null;
  }
  return {
    frame_index: frameIndex,
    captured_at_utc: new Date(capturedAtMs).toISOString(),
    captured_at_ms: capturedAtMs,
    reason: String(parsed?.reason ?? "unknown").slice(0, 160),
    includes_ui: parsed?.includes_ui === true,
    player: parsed?.player && typeof parsed.player === "object" ? parsed.player : {},
    sidecar: sidecarName,
  };
}

/**
 * Read recent completed frames without trusting the absolute `image` path in
 * the sidecar. The game writes JSON before the asynchronous PNG completes, so
 * an older ring-slot PNG is rejected unless its mtime matches this request.
 */
export async function loadVisionFrames({
  question,
  env = process.env,
  nowMs = Date.now(),
} = {}) {
  const requested = isVisionQuestion(question, env);
  const directory = defaultVisionDirectory(env);
  if (!requested) return { requested: false, status: "not_requested", frames: [] };
  if (!directory) return { requested: true, status: "vision_directory_unavailable", frames: [] };

  const maxFrames = boundedInteger(
    env.AIFACTORY_VISION_MAX_FRAMES,
    DEFAULT_MAX_FRAMES,
    1,
    3,
  );
  const maxAgeMs = boundedInteger(
    env.AIFACTORY_VISION_MAX_AGE_SECONDS,
    DEFAULT_MAX_AGE_SECONDS,
    5,
    3_600,
  ) * 1_000;
  const maxFrameBytes = boundedInteger(
    env.AIFACTORY_VISION_MAX_FRAME_BYTES,
    DEFAULT_MAX_FRAME_BYTES,
    64 * 1024,
    20 * 1024 * 1024,
  );
  const maxTotalBytes = boundedInteger(
    env.AIFACTORY_VISION_MAX_TOTAL_BYTES,
    DEFAULT_MAX_TOTAL_BYTES,
    maxFrameBytes,
    32 * 1024 * 1024,
  );
  const maxPixels = boundedInteger(
    env.AIFACTORY_VISION_MAX_PIXELS,
    DEFAULT_MAX_PIXELS,
    64 * 64,
    50_000_000,
  );

  let names;
  try {
    names = await readdir(directory);
  } catch {
    return { requested: true, status: "vision_directory_unreadable", frames: [] };
  }
  const sidecars = names
    .filter((name) => name === "latest.json" || /^frame-\d{3,6}\.json$/i.test(name))
    .slice(0, 512);
  const candidates = [];
  for (const name of sidecars) {
    try {
      const metadata = safeMetadata(await readFile(path.join(directory, name), "utf8"), name);
      if (metadata) candidates.push(metadata);
    } catch {
      // A partially replaced sidecar is ignored; another ring entry may be valid.
    }
  }
  candidates.sort((left, right) => right.captured_at_ms - left.captured_at_ms);

  const frames = [];
  const seen = new Set();
  let totalBytes = 0;
  for (const metadata of candidates) {
    if (frames.length >= maxFrames) break;
    const identity = `${metadata.frame_index}:${metadata.captured_at_utc}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    const ageMs = nowMs - metadata.captured_at_ms;
    if (ageMs < -30_000 || ageMs > maxAgeMs) continue;

    const fileName = `frame-${String(metadata.frame_index).padStart(3, "0")}.png`;
    const filePath = path.join(directory, fileName);
    try {
      const info = await stat(filePath);
      // A stale PNG can occupy the same ring slot while the new screenshot is
      // still pending. Two seconds allows filesystem timestamp granularity.
      if (!info.isFile() || info.mtimeMs + 2_000 < metadata.captured_at_ms ||
          info.size <= 0 || info.size > maxFrameBytes ||
          totalBytes + info.size > maxTotalBytes) {
        continue;
      }
      const buffer = await readFile(filePath);
      if (buffer.length !== info.size) continue;
      const dimensions = pngDimensions(buffer);
      if (!dimensions || dimensions.pixels > maxPixels) continue;
      totalBytes += buffer.length;
      frames.push({
        media_type: "image/png",
        data_base64: buffer.toString("base64"),
        bytes: buffer.length,
        width: dimensions.width,
        height: dimensions.height,
        frame_index: metadata.frame_index,
        captured_at_utc: metadata.captured_at_utc,
        age_ms: Math.max(0, ageMs),
        reason: metadata.reason,
        includes_ui: metadata.includes_ui,
        player: metadata.player,
      });
    } catch {
      // Screenshot capture is asynchronous. Missing/incomplete files are an
      // honest "not ready", never an excuse to reuse an old frame.
    }
  }

  return {
    requested: true,
    status: frames.length > 0 ? "ready" : "no_recent_complete_frame",
    frames,
    limits: { max_frames: maxFrames, max_age_ms: maxAgeMs, max_total_bytes: maxTotalBytes },
  };
}

export function visionMetadataText(vision) {
  if (!vision?.requested) return "";
  if (!Array.isArray(vision.frames) || vision.frames.length === 0) {
    return `\n\nCURRENT VISION STATUS: ${vision.status}. No screenshot may be inferred.`;
  }
  const entries = vision.frames.map((frame) => ({
    frame_index: frame.frame_index,
    captured_at_utc: frame.captured_at_utc,
    age_ms: frame.age_ms,
    dimensions: { width: frame.width, height: frame.height },
    includes_ui: frame.includes_ui,
    reason: frame.reason,
    player: frame.player,
  }));
  return (
    `\n\nCURRENT VISION FRAME METADATA JSON:\n${JSON.stringify(entries)}\n` +
    "The attached pixels are visual evidence only. Snapshot/solver data remains authoritative for identities, recipes, rates, coordinates, collision, unlocks, and every write."
  );
}
