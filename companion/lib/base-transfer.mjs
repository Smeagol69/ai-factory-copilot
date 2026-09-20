import { createHash } from "node:crypto";

export const BASE_TRANSFER_SCHEMA = "aifactory.absolute-base/v1";
const AXES = { translation: ["x", "y", "z"], rotation: ["x", "y", "z", "w"], scale3d: ["x", "y", "z"] };
const hash = value => createHash("sha256").update(value).digest("hex");

/** Store the IEEE-754 bytes as well as readable numbers. JSON alone loses -0.
 * These are absolute world centimetres, never a movable Blueprint pivot.
 */
export function exactBaseTransform(transform) {
  const values = {}, bits = {};
  for (const [group, axes] of Object.entries(AXES)) {
    values[group] = {}; bits[group] = {};
    for (const axis of axes) {
      const value = transform?.[group]?.[axis];
      if (!Number.isFinite(value)) throw new Error(`Invalid transform: ${group}.${axis}`);
      const bytes = Buffer.alloc(8); bytes.writeDoubleLE(value);
      values[group][axis] = value; bits[group][axis] = bytes.toString("hex");
    }
  }
  const q = values.rotation;
  if (Math.abs(q.x*q.x + q.y*q.y + q.z*q.z + q.w*q.w - 1) > 0.00001) {
    throw new Error("Saved rotation is not a unit quaternion");
  }
  return { transform: values, transform_float64_le_hex: bits };
}

export function readExactBaseTransform(piece) {
  const transform = {};
  for (const [group, axes] of Object.entries(AXES)) {
    transform[group] = {};
    for (const axis of axes) {
      const hex = piece.transform_float64_le_hex?.[group]?.[axis];
      if (typeof hex !== "string" || !/^[0-9a-f]{16}$/.test(hex)) throw new Error("Missing transform bytes");
      const value = Buffer.from(hex, "hex").readDoubleLE();
      if (!Number.isFinite(value) || value !== piece.transform?.[group]?.[axis]) {
        throw new Error(`Transform bytes disagree: ${group}.${axis}`);
      }
      transform[group][axis] = value;
    }
  }
  return exactBaseTransform(transform).transform;
}

export function basePieceKey(piece) {
  const transform = readExactBaseTransform(piece);
  return JSON.stringify([piece.class_path, exactBaseTransform(transform).transform_float64_le_hex]);
}

export function validateBaseTransfer(manifest) {
  if (manifest?.schema !== BASE_TRANSFER_SCHEMA || manifest.coordinate_space !== "absolute_world_cm" ||
      manifest.placement_policy !== "preserve_each_saved_transform") throw new Error("Unsupported base transfer contract");
  if (!/^[0-9a-f]{64}$/.test(manifest.source?.save_sha256 ?? "") || !manifest.source?.map_name ||
      !Number.isSafeInteger(manifest.source?.build_version)) throw new Error("Missing source provenance");
  if (!Array.isArray(manifest.pieces) || !manifest.pieces.length) throw new Error("Empty base transfer");
  const ids = new Set();
  for (const piece of manifest.pieces) {
    if (!piece.id || ids.has(piece.id) || typeof piece.class_path !== "string" || !piece.class_path.startsWith("/") ||
        !["actor", "lightweight"].includes(piece.kind)) throw new Error("Invalid/duplicate base piece");
    ids.add(piece.id); readExactBaseTransform(piece);
  }
  if (manifest.piece_count !== ids.size) throw new Error("Base piece count mismatch");
  const digest = hash(JSON.stringify(manifest.pieces.map(piece => [piece.id, piece.kind, basePieceKey(piece)])));
  if (manifest.transform_sha256 !== digest) throw new Error("Base transform digest mismatch");
  return manifest;
}

export function createBaseTransfer(source, pieces) {
  const manifest = {
    schema: BASE_TRANSFER_SCHEMA, coordinate_space: "absolute_world_cm",
    placement_policy: "preserve_each_saved_transform", source: structuredClone(source),
    piece_count: pieces.length, pieces: pieces.map(piece => ({
      ...structuredClone(piece), ...exactBaseTransform(piece.transform),
    })),
    // A source manifest proves saved coordinates; it is not a native spawn result.
    native_restore_verified: false,
  };
  manifest.transform_sha256 = hash(JSON.stringify(manifest.pieces.map(piece => [piece.id, piece.kind, basePieceKey(piece)])));
  return validateBaseTransfer(manifest);
}

/** Match occurrences, not a set: two identical coincident pieces are two pieces.
 * The caller must supply the complete newly created set, including lightweight
 * instances. A pre-existing destination foundation cannot prove a new spawn.
 */
export function verifyBaseSpawn(manifest, readback) {
  validateBaseTransfer(manifest);
  if (readback?.scope !== "created_by_this_restore" || readback.complete !== true ||
      readback.map_name !== manifest.source.map_name || !Array.isArray(readback.pieces)) {
    throw new Error("Complete game-side restore readback is required");
  }
  const buckets = new Map();
  const identities = new Set();
  for (const piece of readback.pieces) {
    if (!piece.runtime_id || identities.has(piece.runtime_id)) throw new Error("Duplicate/missing runtime identity");
    identities.add(piece.runtime_id);
    const key = basePieceKey({ ...piece, ...exactBaseTransform(piece.transform) });
    const bucket = buckets.get(key) ?? []; bucket.push(piece.runtime_id); buckets.set(key, bucket);
  }
  const matches = [], missing = [];
  for (const piece of manifest.pieces) {
    const runtimeId = buckets.get(basePieceKey(piece))?.pop();
    if (runtimeId) matches.push({ source_id: piece.id, runtime_id: runtimeId });
    else missing.push(piece.id);
  }
  const unexpected = [...buckets.values()].flat();
  return { exact: !missing.length && !unexpected.length, expected: manifest.piece_count,
    matched: matches.length, missing, unexpected, matches,
    scope: "geometry_only_state_and_connections_require_separate_readback" };
}
