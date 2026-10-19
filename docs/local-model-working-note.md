# AI Architect Acceptance Checklist

**Date:** 2026-10-17  
**Author:** hauhaucs-local  
**Scope:** Live capture/draft/status workflow for Satisfactory Architect

## 5-Step Acceptance Checklist

1. **Fresh whole-world capture bound to save/player**  
   - Capture the entire current world state tied to the active save/player context.  
   - Use existing native mailbox and playtest hooks; no new API calls.

2. **Immutable structural draft**  
   - Preserve the original structural layout before any modifications.  
   - Draft changes are layered on top without altering the base blueprint.

3. **Measured-box overlap versus actual native clearance distinction**  
   - Compute the measured bounding box of proposed structures.  
   - Compare against the actual native clearance provided by the game engine.  
   - Flag cases where measured overlap exceeds native tolerance.

4. **Native Blueprint save/readback**  
   - Write the modified state back to the native Blueprint format.  
   - Verify readback matches the intended draft without corruption.

5. **Destination placement and undo outcomes**  
   - Confirm the final placement coordinates and orientation.  
   - Record the undo state for reverting if needed.  
   - **Status:** No new placement has been verified in this session.

## Capture of Existing Structures

- When capturing existing structures, use **dismantle marks** then **force-save** to preserve their state.

## Live Design Target

- **Screenshot tunnel:** Curve horizontally around the world-up while preserving each panel cross-section and Z, rather than pitching successive walls downward.

---
*End of checklist. No new placement verified. Use dismantle marks then force-save for existing structures.*