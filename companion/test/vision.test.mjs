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
import { isVisionQuestion, loadVisionFrames } from "../lib/vision.mjs";

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
