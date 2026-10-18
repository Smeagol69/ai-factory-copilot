# Level tunnel implementation plan

Goal: complete the owner's approved native curved tunnel save/place/readback milestone.

Reuse native GenerateLayout, Blueprint Designer serialization, isolated-world geometry matching, hologram placement and undo. Add schema v6 for foundation full poses; preserve v1-v5. Saved references supply exact class/pose evidence. World-up turns preserve height and existing tilt. Codex chooses the implementation under the already approved tunnel milestone.

- [ ] Fail tests for pose retention, invalid quaternions/scales, old-schema rejection and foundation-only scope.
- [ ] Extend bridge/native v6, using existing exact native pose readback.
- [ ] Expose deterministic reference-derived generation without a hosted model.
- [ ] Run focused/full tests, compile exact CL513885 SDK, independently review.
- [ ] Check peer branches, deploy with backups while game closed.
- [ ] Generate, save, preview/place and inspect transforms/screenshots. Repair measured failures.

Ghidra disabled. No scheduled tasks or visible helper consoles. Only the game writes player blueprints/world. Preserve originals. Rigid panels remain faceted; serialization alone does not prove seam/mesh clearance.

Owner: codex-14540, shared task codex-tunnel-full-pose-20261018, baseline419fa8e, remote master3997694. Prior helper continuations failed quota before work; execute inline, preserve partials. Independent review status must remain honest.
