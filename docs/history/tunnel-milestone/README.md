# Tunnel milestone evidence (2026-10-18)

The proof files from Codex's curved level tunnel run, copied from
`hub/state/live-architect/tunnel-milestone/` (which keeps everything, including
multi-megabyte actor captures and save backups, on the owner's PC only). Files
under 300 KB are here; home-folder paths are masked as `%USERPROFILE%`.

| File | What it proves |
|---|---|
| `progress.json` | Codex's own summary at 21:54 UTC: 66-piece save exact, 270 placed, `visualJointsVerified: false`, open items |
| `v3-saved-inspection.json`, `v3-connected-pose-proof.json` | Fine-curve v3 saved and placed; every placed pose checked |
| `v2-connected-pose-proof.json`, `v2-joint-ridges.png` | v2 placement and the ridge problem v3 fixed |
| `complete-export-after-repair.json` | The repaired native explicit-member save of the whole work area (528 members, disk header matches) |
| `complete-preserved-assembly-proof.json` | 330/330 original + generated members at exact class and position in that save |
| `raised-placement-pose-proof.json`, `ground-placement-pose-proof.json` | Explicit-height placement through native hologram validation |
| `undo-test-response.json` | Undo removed the placed members (72 → 0) |
| `local-*-review*.json` | The local model's (HauhauCS) bounded reviews of each change, with the files and hashes it saw |
| `lighting-proposal-draft.json`, `lighting-native-instance-response.json` | Lighting add-on request (6 lamps, 28 beams); not yet placed |
| `*-deployment.json` | Each deployment: commit, DLL hash, peer checkouts checked |
| `before-placement.png`, `placed-first-view.png`, `raised-tunnel-overview.png` | In-game views |
| `*.mjs`, `*.ps1` | The one-off verification and review scripts Codex ran |

The plan with its checkboxes is
[../../superpowers/plans/2026-10-18-level-tunnel.md](../../superpowers/plans/2026-10-18-level-tunnel.md).
