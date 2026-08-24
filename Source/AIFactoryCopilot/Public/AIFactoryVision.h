#pragma once

#include "CoreMinimal.h"

/**
 * Eyes.
 *
 * Everything else in this mod reads the world as data -- actors, transforms,
 * recipes. This writes what the player is actually looking at to a PNG, so the
 * assistant can look at the game the way the player does. It is the difference
 * between knowing there are 204 foundations and seeing the building.
 *
 * A frame is paired with a small JSON sidecar carrying the capture time, why it
 * was taken, and where the player was standing. A screenshot on its own is a
 * picture of somewhere; a screenshot plus a transform is a picture of somewhere
 * *known*, which is what makes it usable alongside a snapshot.
 *
 * Frames go into a bounded ring rather than one overwritten file, because a
 * single still cannot show motion. A short history is what turns "look at this"
 * into "watch this".
 *
 * Capture is asynchronous: the engine writes the file a frame or two after the
 * request. Nothing here blocks, and nothing should wait on the file existing.
 */
namespace AIFactoryVision
{
    /** `Saved/AIFactoryCopilot/Vision`, created on demand. */
    FString VisionDirectory();

    /**
     * Ask the engine for one frame.
     *
     * @param Reason  Recorded in the sidecar so a reader can tell a routine
     *                timer frame from one taken because something happened.
     * @param bWithUI Include the HUD. Usually wanted -- the hotbar, health and
     *                build-mode text are information about what the player is
     *                doing, not clutter.
     *
     * Safe to call when vision is disabled; it does nothing.
     */
    void RequestFrame(UWorld* World, const FString& Reason, bool bWithUI);

    /** True when settings enable capture. Callers need not check; RequestFrame does. */
    bool IsEnabled();
}
