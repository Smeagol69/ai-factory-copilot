# Level tunnel implementation plan

Goal: complete the owner's approved native curved tunnel save/place/readback milestone.

Reuse native GenerateLayout, Blueprint Designer serialization, isolated-world geometry matching, hologram placement and undo. Add schema v6 for foundation full poses; preserve v1-v5. Saved references supply exact class/pose evidence. World-up turns preserve height and existing tilt. Codex chooses the implementation under the already approved tunnel milestone.

- [x] Fail tests for pose retention, invalid quaternions/scales, old-schema rejection and foundation-only scope.
- [x] Extend bridge/native v6, using existing exact native pose readback.
- [x] Expose deterministic reference-derived generation without a hosted model.
- [x] Run focused/full tests, compile exact CL513885 SDK, independently review.
- [x] Check peer branches, deploy with backups while game closed.
- [ ] Generate, save, preview/place and inspect transforms/screenshots. Repair measured failures.

Live checkpoint: initial native archive and raised placement both match 66/66
full poses, but owner rejects the appearance. Preserve the reference and existing
working features. Next pass aligns all 18 profile courses at shared angular
stations (90 pieces for the actual 28.5-degree bend), retains measured transverse
spacing and connects to a live matched reference end. Two focused regression
tests failed before the geometry repair; all 1338 companion tests now pass.

Undo member repair removed all 66 temporary actors in a fresh authoritative
capture; immediate actor destruction is deferred, requiring the native public
GetIsDismantled flag for synchronous accounting and duplicate-refund prevention.
Updated Shipping module compiles; its final live readback test remains pending.
Explicit coordinate teleport with a supplied Z and "at exact height" uses the
existing non-snapping action for interior inspection; all old routes keep snapping.

Ghidra disabled. No scheduled tasks or visible helper consoles. Only the game writes player blueprints/world. Preserve originals. Rigid panels remain faceted; serialization alone does not prove seam/mesh clearance.

Owner: codex-14540, shared task codex-tunnel-full-pose-20261018, baseline419fa8e, remote master3997694. Prior helper continuations failed quota before work; execute inline, preserve partials. Independent review status must remain honest.

Verified superseding checkpoint: native v3 saved/placed all 270 fine-curve poses;
v2 undo removed72 and fresh capture contained0. Owner likes current assembly and
now requests clean emissive seams plus ceiling lights along straight/curved runs.

- [x] Preserve latest bp builder autosave before lighting (SHA256 bea2d2de2fa114d5da6eec5f6483cbab1109c36639de9a8ac9bbb36b85307af0).
- [x] Reproduce actual full-capture refusal and repair explicit-member writer without moving designer ownership.
- [x] Add measured, separately undoable native-v1 lighting compiler and local route; six lights/28 beams on actual reference, no shell replacement.
- [x] Complete1350 companion tests and17 compiled native policy cases; Shipping151inputs builds.
- [ ] Finish independent reviews, deploy with exact-source/peer checks and backups.
- [ ] Save complete assembly; compare archive member classes/full poses with live selection.
- [ ] Generate/place lighting add-on and inspect actual reveals, fixture spacing and native power.
- [ ] Test v7 fitted-panel native scale/readback/render separately, preserving liked version.

Lighting design call: mirror measured lower beam reveals at the highest profile
pivot and use the two flat roof fixtures as rows. Angled side lights are not
copied in this first pass. Native beam default length is nominal evidence, not
mesh fit; visual gaps/overshoot and power must be measured before claiming done.
