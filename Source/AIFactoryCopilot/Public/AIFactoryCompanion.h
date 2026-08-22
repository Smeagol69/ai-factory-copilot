#pragma once

#include "CoreMinimal.h"

/**
 * Starting the bundled bridge, so the mod is one install rather than two.
 *
 * The companion used to be a second download with its own zip and its own
 * install step. The failure that produced was quiet and confusing: the mod
 * loaded fine, the panel said the assistant was offline, and the reason was a
 * file the player never knew to fetch. It now ships inside the mod (see
 * RuntimeDependencies in AIFactoryCopilot.Build.cs) and starts itself.
 *
 * Two rules govern everything here.
 *
 * **Only ever stop what we started.** A player may already be running the bridge
 * from a terminal -- during development that is the normal case. Killing it on
 * world teardown because we happened to want one would be the mod destroying
 * someone else's work. The handle is only valid if this module created it.
 *
 * **Never be the reason the game stalls.** The child is launched detached and
 * hidden and nothing waits on it. If Node is absent, that is reported once, in
 * the panel, in words a player can act on -- not a hang and not a silent
 * failure.
 */
namespace AIFactoryCompanion
{
    /** Absolute path of the bundled `server.mjs`, or empty if it is not there. */
    FString BundledServerPath();

    /**
     * Launch the bridge if settings allow it and we have not already.
     *
     * Safe to call repeatedly. Does nothing when auto-start is off, when the
     * bundled script is missing, or when a process we launched is still alive.
     *
     * Does NOT check whether some other bridge is already listening -- that
     * would mean a blocking probe on the game thread. The bridge itself exits
     * cleanly on EADDRINUSE, which handles the duplicate far more cheaply.
     */
    void EnsureRunning();

    /** Terminate the bridge only if this module launched it. */
    void StopIfWeStartedIt();

    /** Empty when nothing is wrong; otherwise a sentence for the panel. */
    FString LastError();
}
