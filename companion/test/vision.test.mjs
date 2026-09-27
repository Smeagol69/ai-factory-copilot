import assert from "node:assert/strict";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  markLastUserMessageCacheable,
  needsStrongModel,
  providerMessages,
} from "../lib/providers.mjs";
import { isVisionQuestion, loadVisionFrames, visionMetadataText } from "../lib/vision.mjs";

function tinyPng(width = 64, height = 32) {
  const buffer = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(buffer, 0);
  buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

function providerContext(vision) {
  return {
    question: "does this blueprint look balanced?",
    serializedSnapshot: "{}",
    serializedDerivedFacts: "{}",
    serializedAnalysisDigest: "{}",
    omissions: [],
    history: [],
    vision,
  };
}

test("vision is opt-in by visual intent and sends hybrid visual work to the strong tier", () => {
  assert.equal(isVisionQuestion("what is my power usage?", {}), false);
  assert.equal(isVisionQuestion("does this blueprint look good?", {}), true);
  assert.equal(needsStrongModel("does this blueprint look good?", {}), true);
  assert.equal(needsStrongModel("does this blueprint look good?", { LOCAL_AI_VISION: "true" }), false);
});

test("natural Architect briefs request images without magic visual keywords", () => {
  for (const question of [
    "build an entrance around this hypertube",
    "finish my underground factory",
    "make a bunker here",
    "connect this balcony to the room below",
    "AI Architect: improve this",
    "i built a factory then attached a hypertube that goes straight up; i want a render of the entrance and the factory",
  ]) {
    assert.equal(isVisionQuestion(question, {}), true, question);
    assert.equal(needsStrongModel(question, {}), true, question);
    assert.equal(isVisionQuestion(question, { AIFACTORY_VISION: "off" }), false);
  }
  for (const question of ["check base chatgpt", "restore base chatgpt", "how much iron am i making", "what does a smelter do"]) {
    assert.equal(isVisionQuestion(question, {}), false, question);
  }
});

test("Architect retains distinct recent views with exact age and request-view differences", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "architect-views-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const nowMs = Date.now();
  const pose = (z, yaw) => ({ location: { x: 100, y: 200, z }, view_rotation: { pitch: 0, yaw, roll: 0 } });
  const entries = [
    { index: 1, seconds: 5, player: pose(-2000, -179) },
    { index: 2, seconds: 20, player: pose(-2000, 179) }, // same view across angular wrap
    { index: 3, seconds: 40, player: pose(2000, 90) }, // prior surface view
    { index: 4, seconds: 55, player: pose(2000, 0) },
    { index: 5, seconds: 200, player: pose(5000, 0) }, // outside history limit
  ];
  for (const entry of entries) {
    const name = `frame-${String(entry.index).padStart(3, "0")}`;
    await writeFile(path.join(directory, `${name}.json`), JSON.stringify({
      frame_index: entry.index, captured_at_utc: new Date(nowMs - entry.seconds * 1000).toISOString(), player: entry.player,
    }));
    await writeFile(path.join(directory, `${name}.png`), tinyPng());
  }
  const snapshot = { interaction_context: {
    captured_at_utc: new Date(nowMs).toISOString(),
    player: { pawn_location: pose(-2000, 179).location, control_rotation: pose(-2000, 179).view_rotation },
  } };
  const request = { question: "build an entrance for this underground factory", nowMs,
    env: { AIFACTORY_VISION_DIR: directory }, snapshot };
  const vision = await loadVisionFrames(request);
  assert.deepEqual(vision.frames.map(frame => frame.frame_index), [1, 3, 4]);
  assert.equal(vision.frames[0].view_context.role, "recent_viewpoint_near_request");
  assert.equal(vision.frames[0].view_context.max_rotation_delta_degrees, 2);
  assert.equal(vision.frames[0].view_context.save_identity_verified, false);
  assert.equal(vision.frames[1].view_context.role, "recent_visual_reference");
  assert.equal(vision.frames[1].view_context.distance_cm, 4000);
  assert.equal(vision.frames[1].view_context.frame_minus_snapshot_ms, -40000);
  assert.match(visionMetadataText(vision), /not a live video stream/);
  const missing = await loadVisionFrames({ ...request, snapshot: null });
  assert.equal(missing.frames[0].view_context.distance_cm, null);
  assert.equal(missing.frames[0].view_context.role, "recent_visual_reference");
  const capped = await loadVisionFrames({ ...request, env: { ...request.env, AIFACTORY_VISION_MAX_FRAMES: "1" } });
  assert.equal(capped.frames.length, 1);
  const textOnlyQuestion = await loadVisionFrames({ ...request, question: "what do you see?" });
  assert.equal(textOnlyQuestion.frames.length, 1);
  for (const format of ["anthropic", "openai", "chat"]) {
    const messages = providerMessages(providerContext(vision), { visionFormat: format });
    const content = messages.at(-1).content;
    assert.equal(content.filter(block => ["image", "input_image", "image_url"].includes(block.type)).length, 3);
    const text = content.find(block => ["text", "input_text"].includes(block.type)).text;
    assert.match(text, /recent_visual_reference/);
    assert.match(text, /same order as attached images/);
  }
});

test("the vision reader accepts only a recent completed bounded PNG from its own ring", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "aifactory-vision-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const captured = new Date(Date.now() - 1_000).toISOString();
  await writeFile(path.join(directory, "latest.json"), JSON.stringify({
    captured_at_utc: captured,
    frame_index: 7,
    reason: "requested",
    includes_ui: true,
    image: "C:\\outside\\must-not-be-read.png",
    player: { location: { x: 1, y: 2, z: 3 } },
  }));
  await writeFile(path.join(directory, "frame-007.png"), tinyPng(1_920, 1_080));

  const vision = await loadVisionFrames({
    question: "look at this factory",
    env: { AIFACTORY_VISION_DIR: directory },
  });
  assert.equal(vision.status, "ready");
  assert.equal(vision.frames.length, 1);
  assert.equal(vision.frames[0].width, 1_920);
  assert.equal(vision.frames[0].height, 1_080);
  assert.equal(vision.frames[0].includes_ui, true);
  assert.equal(vision.frames[0].data_base64, tinyPng(1_920, 1_080).toString("base64"));
  assert.equal(JSON.stringify(vision).includes("outside"), false);
});

test("an old PNG occupying a newly requested ring slot is never reused", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "aifactory-vision-stale-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const capturedAt = Date.now() - 500;
  await writeFile(path.join(directory, "latest.json"), JSON.stringify({
    captured_at_utc: new Date(capturedAt).toISOString(),
    frame_index: 2,
  }));
  const pngPath = path.join(directory, "frame-002.png");
  await writeFile(pngPath, tinyPng());
  const old = new Date(capturedAt - 30_000);
  await utimes(pngPath, old, old);

  const vision = await loadVisionFrames({
    question: "what do you see?",
    env: { AIFACTORY_VISION_DIR: directory },
    nowMs: capturedAt + 500,
  });
  assert.equal(vision.status, "no_recent_complete_frame");
  assert.deepEqual(vision.frames, []);
});

test("provider messages use each API's native image block without weakening text grounding", () => {
  const frame = {
    media_type: "image/png",
    data_base64: tinyPng().toString("base64"),
    frame_index: 1,
    captured_at_utc: new Date().toISOString(),
    age_ms: 10,
    width: 64,
    height: 32,
    includes_ui: false,
    reason: "requested",
    player: {},
  };
  const context = providerContext({ requested: true, status: "ready", frames: [frame] });
  const anthropic = providerMessages(context, { visionFormat: "anthropic" });
  assert.equal(anthropic[0].content[0].type, "image");
  assert.equal(anthropic[0].content[0].source.data, frame.data_base64);
  assert.match(anthropic[0].content.at(-1).text, /visual evidence only/i);
  markLastUserMessageCacheable(anthropic);
  assert.deepEqual(anthropic[0].content.at(-1).cache_control, { type: "ephemeral" });

  const openai = providerMessages(context, { visionFormat: "openai" });
  assert.equal(openai[0].content[0].type, "input_text");
  assert.equal(openai[0].content[1].type, "input_image");
  assert.match(openai[0].content[1].image_url, /^data:image\/png;base64,/);

  const textOnly = providerMessages(context);
  assert.equal(typeof textOnly[0].content, "string");
  assert.match(textOnly[0].content, /provider_did_not_attach_vision/);
  assert.doesNotMatch(textOnly[0].content, new RegExp(frame.data_base64));
});
