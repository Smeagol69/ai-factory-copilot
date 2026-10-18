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
