import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const ARCHITECT_STORE_SCHEMA = "ai-architect.revision-store/v1";
export const ARCHITECT_REVISION_SCHEMA = "ai-architect.revision/v1";
export const MAX_ARCHITECT_SESSIONS_PER_SCOPE = 32;
export const MAX_ARCHITECT_REVISIONS_PER_SESSION = 64;

const MAX_STORE_BYTES = 16 * 1024 * 1024;
const MAX_DESIGN_REQUEST_BYTES = 256 * 1024;
const SHA256 = /^sha256:[0-9a-f]{64}$/;

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonical(value[key])]),
  );
}

export function stableJson(value) {
  return JSON.stringify(canonical(value));
}

function boundedText(value, maximum, { required = true } = {}) {
  const text = String(value ?? "").trim();
  if (!text) return required ? null : "";
  return text.length <= maximum ? text : null;
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function resultError(reason, details = {}) {
  return { ok: false, reason, ...details };
}

export function resolveArchitectStoreDirectory(env = process.env) {
  const configured = String(env.AIFACTORY_ARCHITECT_STORE ?? "").trim();
  if (["0", "false", "off", "none"].includes(configured.toLowerCase())) return null;
  if (configured) return path.resolve(configured);
  if (!env.LOCALAPPDATA) return null;
  return path.join(
    env.LOCALAPPDATA,
    "FactoryGame",
    "Saved",
    "AIFactoryCopilot",
    "Architect",
  );
}

/** Scope metadata never becomes a path. Only its digest is used as a filename. */
export function deriveArchitectScope(snapshot, chatSessionId) {
  const map = boundedText(snapshot?.world?.map, 256);
  const saveSessionName = boundedText(snapshot?.world?.session_name, 256);
  const chatSession = boundedText(chatSessionId, 256);
  if (!map) return resultError("architect_scope_map_not_captured");
  if (!saveSessionName) return resultError("architect_scope_save_session_not_captured");
  if (!chatSession) return resultError("architect_scope_chat_session_is_required");
  const scope = {
    map,
    save_session_name: saveSessionName,
    chat_session_id: chatSession,
  };
  return {
    ok: true,
    scope,
    scope_id: sha256(stableJson(scope)),
  };
}

export function fingerprintArchitectManifest(manifest) {
  if (manifest?.schema !== "megabase.design/v1" || manifest?.compiled !== true ||
      manifest?.validation?.valid !== true) {
    return resultError("architect_revision_requires_a_valid_compiled_megabase_manifest");
  }
  const family = String(manifest?.design_family?.fingerprint ?? "").trim();
  const unlock = String(
    manifest?.unlock_constraints?.availability_fingerprint ?? "",
  ).trim();
  if (!SHA256.test(family)) {
    return resultError("architect_manifest_design_family_fingerprint_is_invalid");
  }
  if (!SHA256.test(unlock)) {
    return resultError("architect_manifest_unlock_fingerprint_is_invalid");
  }
  // The global revision changes for belt item spawns/despawns and cannot be a
  // semantic design gate. Keep it as provenance on the revision, but remove it
  // (and capture time) from the exact recompile identity. Unlocks, terrain,
  // program, parts, geometry, topology and blockers remain in the digest.
  const semanticManifest = clone(manifest);
  if (semanticManifest.unlock_constraints) {
    delete semanticManifest.unlock_constraints.captured_world_revision;
    delete semanticManifest.unlock_constraints.captured_at_utc;
  }
  return {
    ok: true,
    manifest_fingerprint: sha256(stableJson(semanticManifest)),
    design_family_fingerprint: family,
    unlock_fingerprint: unlock,
  };
}

function normalizeBrief(brief, manifest) {
  const goal = boundedText(brief?.goal, 512);
  const creativeDirection = boundedText(
    brief?.creative_direction,
    1000,
    { required: false },
  );
  const rawConstraints = brief?.constraints ?? [];
  if (!goal) return resultError("architect_brief_goal_must_be_1_to_512_characters");
  if (creativeDirection === null) {
    return resultError("architect_brief_creative_direction_is_too_long");
  }
  if (!Array.isArray(rawConstraints) || rawConstraints.length > 32) {
    return resultError("architect_brief_constraints_must_be_an_array_of_at_most_32_items");
  }
  const constraints = [];
  for (const raw of rawConstraints) {
    const constraint = boundedText(raw, 256);
    if (!constraint) {
      return resultError("architect_brief_constraint_must_be_1_to_256_characters");
    }
    constraints.push(constraint);
  }
  return {
    ok: true,
    brief: {
      goal,
      creative_direction: creativeDirection || null,
      constraints,
      style: manifest.style,
    },
  };
}

function sessionIdentity(scopeId, name) {
  return sha256(`${scopeId}\nsession\n${name.toLocaleLowerCase()}`);
}

function revisionIdentity(sessionId, parentRevisionId, label, brief, manifestFingerprint) {
  return sha256(stableJson({
    session_id: sessionId,
    parent_revision_id: parentRevisionId,
    label,
    brief,
    manifest_fingerprint: manifestFingerprint,
  }));
}

function newState(scopeResult, now) {
  return {
    schema: ARCHITECT_STORE_SCHEMA,
    scope_id: scopeResult.scope_id,
    scope: scopeResult.scope,
    created_at_utc: now(),
    updated_at_utc: now(),
    sessions: {},
  };
}

function summarizeRevision(revision) {
  return {
    revision_id: revision.revision_id,
    sequence: revision.sequence,
    label: revision.label,
    parent_revision_id: revision.parent_revision_id,
    created_at_utc: revision.created_at_utc,
    manifest_fingerprint: revision.manifest_fingerprint,
    design_family_fingerprint: revision.design_family_fingerprint,
    unlock_fingerprint: revision.unlock_fingerprint,
    captured_world_revision: revision.captured_world_revision,
    blocker_count: revision.construction_blockers.length,
    element_count: revision.element_count,
    brief: revision.brief,
  };
}

function summarizeSession(session, includeRevisions = true) {
  return {
    architect_session_id: session.architect_session_id,
    name: session.name,
    created_at_utc: session.created_at_utc,
    updated_at_utc: session.updated_at_utc,
    selected_revision_id: session.selected_revision_id,
    revision_count: session.revisions.length,
    ...(includeRevisions
      ? { revisions: session.revisions.map(summarizeRevision) }
      : {}),
  };
}

function elementMap(manifest) {
  return new Map((manifest?.elements ?? []).map((entry) => [entry.id, entry]));
}

function programMachineCount(manifest) {
  return (manifest?.program?.groups ?? []).reduce(
    (total, group) => total + (finite(group?.machines ?? group?.machine_count) ?? 0),
    0,
  );
}

function connectionKeys(manifest) {
  return new Set((manifest?.connections ?? []).map((entry) => stableJson(entry)));
}

function setDifference(left, right, limit = 128) {
  return [...left].filter((entry) => !right.has(entry)).slice(0, limit);
}

function parseExactJsonRows(rows) {
  return rows.map((row) => JSON.parse(row));
}

export function compareArchitectRevisions(left, right) {
  if (!left?.manifest || !right?.manifest) {
    return resultError("architect_comparison_requires_two_stored_revisions");
  }
  const leftElements = elementMap(left.manifest);
  const rightElements = elementMap(right.manifest);
  const added = [];
  const removed = [];
  const changed = [];
  for (const [id, element] of rightElements) {
    if (!leftElements.has(id)) added.push(id);
    else if (stableJson(leftElements.get(id)) !== stableJson(element)) changed.push(id);
  }
  for (const id of leftElements.keys()) {
    if (!rightElements.has(id)) removed.push(id);
  }
  const leftConnections = connectionKeys(left.manifest);
  const rightConnections = connectionKeys(right.manifest);
  const leftBlockers = new Set(left.construction_blockers);
  const rightBlockers = new Set(right.construction_blockers);
  return {
    ok: true,
    schema: "ai-architect.revision-comparison/v1",
    left_revision_id: left.revision_id,
    right_revision_id: right.revision_id,
    geometry: {
      left_element_count: leftElements.size,
      right_element_count: rightElements.size,
      added_element_ids: added.slice(0, 128),
      removed_element_ids: removed.slice(0, 128),
      changed_element_ids: changed.slice(0, 128),
      truncated: added.length > 128 || removed.length > 128 || changed.length > 128,
      left_footprint: left.manifest.footprint ?? null,
      right_footprint: right.manifest.footprint ?? null,
    },
    production: {
      left_machine_count: programMachineCount(left.manifest),
      right_machine_count: programMachineCount(right.manifest),
      left_program_fingerprint: sha256(stableJson(left.manifest?.program ?? null)),
      right_program_fingerprint: sha256(stableJson(right.manifest?.program ?? null)),
    },
    topology: {
      left_connection_count: leftConnections.size,
      right_connection_count: rightConnections.size,
      added_connections: parseExactJsonRows(setDifference(rightConnections, leftConnections)),
      removed_connections: parseExactJsonRows(setDifference(leftConnections, rightConnections)),
      construction_ready_left: left.manifest.construction_ready === true,
      construction_ready_right: right.manifest.construction_ready === true,
    },
    cost: {
      certainty: "unknown",
      reason: "megabase_design_v1_does_not_yet_carry_a_verified_native_blueprint_cost",
    },
    style: {
      left_style: left.manifest.style,
      right_style: right.manifest.style,
      changed: left.manifest.style !== right.manifest.style,
      left_design_family_fingerprint: left.design_family_fingerprint,
      right_design_family_fingerprint: right.design_family_fingerprint,
    },
    blockers: {
      added: setDifference(rightBlockers, leftBlockers),
      resolved: setDifference(leftBlockers, rightBlockers),
      left_count: leftBlockers.size,
      right_count: rightBlockers.size,
    },
  };
}

function validateStoredState(state, scopeResult) {
  if (!state || state.schema !== ARCHITECT_STORE_SCHEMA ||
      state.scope_id !== scopeResult.scope_id ||
      stableJson(state.scope) !== stableJson(scopeResult.scope) ||
      !state.sessions || typeof state.sessions !== "object" ||
      Array.isArray(state.sessions)) {
    return resultError("architect_store_schema_or_scope_is_invalid");
  }
  const sessions = Object.entries(state.sessions);
  if (sessions.length > MAX_ARCHITECT_SESSIONS_PER_SCOPE) {
    return resultError("architect_store_has_too_many_sessions");
  }
  for (const [sessionId, session] of sessions) {
    const name = boundedText(session?.name, 80);
    if (!name || session?.architect_session_id !== sessionId ||
        sessionIdentity(scopeResult.scope_id, name) !== sessionId ||
        !Array.isArray(session?.revisions) ||
        session.revisions.length > MAX_ARCHITECT_REVISIONS_PER_SESSION) {
      return resultError("architect_store_session_is_invalid", { architect_session_id: sessionId });
    }
    const revisionIds = new Set();
    for (const revision of session.revisions) {
      const evidence = fingerprintArchitectManifest(revision?.manifest);
      const expectedId = evidence.ok
        ? revisionIdentity(
            sessionId,
            revision.parent_revision_id ?? null,
            revision.label,
            revision.brief,
            evidence.manifest_fingerprint,
          )
        : null;
      if (revision?.schema !== ARCHITECT_REVISION_SCHEMA ||
          !SHA256.test(String(revision?.revision_id ?? "")) ||
          revisionIds.has(revision.revision_id) ||
          !Number.isInteger(revision.sequence) || revision.sequence < 1 ||
          !boundedText(revision.label, 80) ||
          !evidence.ok ||
          evidence.manifest_fingerprint !== revision.manifest_fingerprint ||
          evidence.design_family_fingerprint !== revision.design_family_fingerprint ||
          evidence.unlock_fingerprint !== revision.unlock_fingerprint ||
          expectedId !== revision.revision_id ||
          !Array.isArray(revision.construction_blockers)) {
        return resultError("architect_store_revision_is_invalid", {
          architect_session_id: sessionId,
          revision_id: revision?.revision_id ?? null,
        });
      }
      revisionIds.add(revision.revision_id);
    }
    for (const revision of session.revisions) {
      if (revision.parent_revision_id && !revisionIds.has(revision.parent_revision_id)) {
        return resultError("architect_store_revision_parent_is_missing", {
          revision_id: revision.revision_id,
          parent_revision_id: revision.parent_revision_id,
        });
      }
    }
    if (session.selected_revision_id && !revisionIds.has(session.selected_revision_id)) {
      return resultError("architect_store_selected_revision_is_missing", {
        architect_session_id: sessionId,
      });
    }
  }
  return { ok: true };
}

export function createArchitectRevisionStore({ directory = null, now = () => new Date().toISOString() } = {}) {
  const memory = new Map();

  function scoped({ snapshot, chat_session_id: chatSessionId }) {
    const scopeResult = deriveArchitectScope(snapshot, chatSessionId);
    const filePath = scopeResult.ok && directory
      ? path.join(directory, `${scopeResult.scope_id.slice("sha256:".length)}.json`)
      : null;

    function load() {
      if (!scopeResult.ok) return scopeResult;
      if (!directory) {
        const existing = memory.get(scopeResult.scope_id);
        return { ok: true, state: existing ? clone(existing) : newState(scopeResult, now) };
      }
      if (!fs.existsSync(filePath)) return { ok: true, state: newState(scopeResult, now) };
      try {
        const stat = fs.statSync(filePath);
        if (stat.size > MAX_STORE_BYTES) return resultError("architect_store_exceeds_size_limit");
        const state = JSON.parse(fs.readFileSync(filePath, "utf8"));
        const valid = validateStoredState(state, scopeResult);
        return valid.ok ? { ok: true, state } : valid;
      } catch (error) {
        return resultError("architect_store_is_corrupt_or_unreadable", {
          diagnostic: error instanceof Error ? error.message : String(error),
        });
      }
    }

    function write(state) {
      if (!scopeResult.ok) return scopeResult;
      state.updated_at_utc = now();
      const serialized = `${JSON.stringify(state, null, 2)}\n`;
      if (Buffer.byteLength(serialized, "utf8") > MAX_STORE_BYTES) {
        return resultError("architect_store_would_exceed_size_limit");
      }
      if (!directory) {
        memory.set(scopeResult.scope_id, clone(state));
        return { ok: true };
      }
      try {
        fs.mkdirSync(directory, { recursive: true });
        const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
        try {
          fs.writeFileSync(temporary, serialized, { encoding: "utf8", flag: "wx" });
          fs.renameSync(temporary, filePath);
        } finally {
          try { fs.rmSync(temporary, { force: true }); } catch { /* best effort */ }
        }
        return { ok: true };
      } catch (error) {
        return resultError("architect_store_write_failed", {
          diagnostic: error instanceof Error ? error.message : String(error),
        });
      }
    }

    function findSession(state, sessionName) {
      const name = boundedText(sessionName, 80);
      if (!name) return resultError("architect_session_name_must_be_1_to_80_characters");
      const id = sessionIdentity(scopeResult.scope_id, name);
      return { ok: true, name, id, session: state.sessions[id] ?? null };
    }

    function getRevisionInternal(state, sessionName, revisionId) {
      const found = findSession(state, sessionName);
      if (!found.ok) return found;
      if (!found.session) return resultError("architect_session_not_found");
      const id = String(revisionId ?? "").trim();
      if (!SHA256.test(id)) return resultError("architect_revision_id_must_be_exact_sha256");
      const revision = found.session.revisions.find((entry) => entry.revision_id === id);
      if (!revision) return resultError("architect_revision_not_found");
      return { ok: true, ...found, revision };
    }

    return {
      configured: Boolean(directory),
      scope: scopeResult.ok ? clone(scopeResult.scope) : null,
      scope_id: scopeResult.ok ? scopeResult.scope_id : null,
      file_path: filePath,

      saveRevision({
        session_name: sessionName,
        label,
        parent_revision_id: parentRevisionId = null,
        brief,
        manifest,
        design_request: designRequest,
        select = false,
      }) {
        const loaded = load();
        if (!loaded.ok) return loaded;
        const state = loaded.state;
        const found = findSession(state, sessionName);
        if (!found.ok) return found;
        const manifestEvidence = fingerprintArchitectManifest(manifest);
        if (!manifestEvidence.ok) return manifestEvidence;
        const normalizedBrief = normalizeBrief(brief, manifest);
        if (!normalizedBrief.ok) return normalizedBrief;
        const rawLabel = String(label ?? "").trim();
        if (rawLabel.length > 80) {
          return resultError("architect_revision_label_must_be_1_to_80_characters");
        }
        const revisionLabel = rawLabel ||
          `Option ${(found.session?.revisions.length ?? 0) + 1}`;
        let session = found.session;
        if (!session) {
          if (Object.keys(state.sessions).length >= MAX_ARCHITECT_SESSIONS_PER_SCOPE) {
            return resultError("architect_scope_has_too_many_sessions");
          }
          session = {
            architect_session_id: found.id,
            name: found.name,
            created_at_utc: now(),
            updated_at_utc: now(),
            selected_revision_id: null,
            revisions: [],
          };
          state.sessions[found.id] = session;
        }
        if (!Array.isArray(session.revisions) ||
            session.revisions.length >= MAX_ARCHITECT_REVISIONS_PER_SESSION) {
          return resultError("architect_session_has_too_many_revisions");
        }
        let parent = null;
        if (parentRevisionId !== null && parentRevisionId !== undefined && parentRevisionId !== "") {
          const parentId = String(parentRevisionId).trim();
          if (!SHA256.test(parentId)) {
            return resultError("architect_parent_revision_id_must_be_exact_sha256");
          }
          parent = session.revisions.find((entry) => entry.revision_id === parentId) ?? null;
          if (!parent) return resultError("architect_parent_revision_not_found");
          parentRevisionId = parentId;
        } else {
          parentRevisionId = null;
        }
        let serializedRequest;
        try {
          serializedRequest = stableJson(designRequest ?? null);
        } catch {
          return resultError("architect_design_request_is_not_serializable");
        }
        if (Buffer.byteLength(serializedRequest, "utf8") > MAX_DESIGN_REQUEST_BYTES) {
          return resultError("architect_design_request_is_too_large");
        }
        const revisionId = revisionIdentity(
          session.architect_session_id,
          parentRevisionId,
          revisionLabel,
          normalizedBrief.brief,
          manifestEvidence.manifest_fingerprint,
        );
        const existing = session.revisions.find((entry) => entry.revision_id === revisionId);
        if (existing) {
          if (select) session.selected_revision_id = revisionId;
          session.updated_at_utc = now();
          const persisted = write(state);
          return persisted.ok
            ? { ok: true, idempotent: true, selected: select, revision: summarizeRevision(existing) }
            : persisted;
        }
        const revision = {
          schema: ARCHITECT_REVISION_SCHEMA,
          revision_id: revisionId,
          sequence: session.revisions.length + 1,
          label: revisionLabel,
          parent_revision_id: parentRevisionId,
          created_at_utc: now(),
          brief: normalizedBrief.brief,
          manifest_fingerprint: manifestEvidence.manifest_fingerprint,
          design_family_fingerprint: manifestEvidence.design_family_fingerprint,
          unlock_fingerprint: manifestEvidence.unlock_fingerprint,
          captured_world_revision:
            manifest.unlock_constraints?.captured_world_revision ?? null,
          captured_at_utc: manifest.unlock_constraints?.captured_at_utc ?? null,
          construction_blockers: [...(manifest.construction_blockers ?? [])],
          element_count: manifest.elements.length,
          design_request: JSON.parse(serializedRequest),
          manifest: clone(manifest),
        };
        session.revisions.push(revision);
        if (select) session.selected_revision_id = revisionId;
        session.updated_at_utc = now();
        const persisted = write(state);
        return persisted.ok
          ? {
              ok: true,
              idempotent: false,
              selected: select,
              architect_session: summarizeSession(session, false),
              revision: summarizeRevision(revision),
            }
          : persisted;
      },

      list({ session_name: sessionName = null } = {}) {
        const loaded = load();
        if (!loaded.ok) return loaded;
        if (sessionName) {
          const found = findSession(loaded.state, sessionName);
          if (!found.ok) return found;
          if (!found.session) return resultError("architect_session_not_found");
          return {
            ok: true,
            scope: scopeResult.scope,
            architect_sessions: [summarizeSession(found.session)],
          };
        }
        return {
          ok: true,
          scope: scopeResult.scope,
          architect_sessions: Object.values(loaded.state.sessions)
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((session) => summarizeSession(session)),
        };
      },

      getRevision({ session_name: sessionName, revision_id: revisionId }) {
        const loaded = load();
        if (!loaded.ok) return loaded;
        const found = getRevisionInternal(loaded.state, sessionName, revisionId);
        if (!found.ok) return found;
        return {
          ok: true,
          architect_session: summarizeSession(found.session, false),
          revision: clone(found.revision),
        };
      },

      compare({ session_name: sessionName, left_revision_id: leftId, right_revision_id: rightId }) {
        const loaded = load();
        if (!loaded.ok) return loaded;
        const left = getRevisionInternal(loaded.state, sessionName, leftId);
        if (!left.ok) return { ...left, side: "left" };
        const right = getRevisionInternal(loaded.state, sessionName, rightId);
        if (!right.ok) return { ...right, side: "right" };
        return compareArchitectRevisions(left.revision, right.revision);
      },

      selectRevision({
        session_name: sessionName,
        revision_id: revisionId,
        recompiled_manifest: recompiledManifest,
        operation = "select",
      }) {
        const loaded = load();
        if (!loaded.ok) return loaded;
        const found = getRevisionInternal(loaded.state, sessionName, revisionId);
        if (!found.ok) return found;
        const currentEvidence = fingerprintArchitectManifest(recompiledManifest);
        if (!currentEvidence.ok) {
          return { ...currentEvidence, effect: "replan_before_selecting_this_revision" };
        }
        if (currentEvidence.unlock_fingerprint !== found.revision.unlock_fingerprint) {
          return resultError("architect_revision_unlock_fingerprint_is_stale", {
            stored_unlock_fingerprint: found.revision.unlock_fingerprint,
            current_unlock_fingerprint: currentEvidence.unlock_fingerprint,
            effect: "replan_before_selecting_this_revision",
          });
        }
        if (currentEvidence.manifest_fingerprint !== found.revision.manifest_fingerprint) {
          return resultError("architect_revision_recompile_no_longer_matches", {
            stored_manifest_fingerprint: found.revision.manifest_fingerprint,
            current_manifest_fingerprint: currentEvidence.manifest_fingerprint,
            effect: "create_a_child_revision_from_current_game_evidence",
          });
        }
        found.session.selected_revision_id = found.revision.revision_id;
        found.session.updated_at_utc = now();
        const persisted = write(loaded.state);
        if (!persisted.ok) return persisted;
        const currentWorldRevision =
          recompiledManifest.unlock_constraints?.captured_world_revision ?? null;
        return {
          ok: true,
          operation,
          selected_revision_id: found.revision.revision_id,
          architect_session: summarizeSession(found.session, false),
          evidence: {
            manifest_fingerprint: currentEvidence.manifest_fingerprint,
            unlock_fingerprint: currentEvidence.unlock_fingerprint,
            stored_world_revision: found.revision.captured_world_revision,
            current_world_revision: currentWorldRevision,
            world_revision_drift:
              String(found.revision.captured_world_revision) !== String(currentWorldRevision),
            world_revision_policy:
              "reported_not_refused; global revision moves with belt traffic, while exact recompile and unlock fingerprints gate selection",
          },
        };
      },

      deleteDraft({ session_name: sessionName, revision_id: revisionId }) {
        const loaded = load();
        if (!loaded.ok) return loaded;
        const found = getRevisionInternal(loaded.state, sessionName, revisionId);
        if (!found.ok) return found;
        if (found.session.selected_revision_id === found.revision.revision_id) {
          return resultError("architect_selected_revision_cannot_be_deleted");
        }
        const child = found.session.revisions.find(
          (entry) => entry.parent_revision_id === found.revision.revision_id,
        );
        if (child) {
          return resultError("architect_revision_with_children_cannot_be_deleted", {
            child_revision_id: child.revision_id,
          });
        }
        found.session.revisions = found.session.revisions.filter(
          (entry) => entry.revision_id !== found.revision.revision_id,
        );
        found.session.updated_at_utc = now();
        const persisted = write(loaded.state);
        return persisted.ok
          ? {
              ok: true,
              deleted_revision_id: found.revision.revision_id,
              effects: {
                architect_metadata_deleted: true,
                native_blueprint_files_deleted: false,
                placed_actors_deleted: false,
                game_save_mutated: false,
              },
            }
          : persisted;
      },
    };
  }

  return {
    configured: Boolean(directory),
    directory,
    scope: scoped,
  };
}
