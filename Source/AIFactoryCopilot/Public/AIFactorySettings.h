#pragma once

#include "CoreMinimal.h"

struct FAIFactorySettings
{
    FString BridgeUrl = TEXT("http://127.0.0.1:8142/v1/ask");
    float DefaultScanRadiusMeters = 250.0f;
    float ViewTraceDistanceMeters = 250.0f;
    float ObserverIntervalSeconds = 1.0f;
    int32 MaxActorsPerSnapshot = 5000;
    int32 MaxReflectedPropertiesPerObject = 256;
    int32 MaxReflectedValueCharacters = 2048;
    bool bIncludeContentCatalog = true;
    bool bIncludeReflectedProperties = true;
    /** Rendered UI can contain chat or credentials from another mod; opt in. */
    bool bIncludeVisibleUiText = false;
    /** Ground, slope, and water probing for build-site suitability. */
    bool bIncludeTerrain = true;
    float TerrainFootprintMeters = 24.0f;
    int32 TerrainResolution = 5;
    int32 MaxTerrainProbes = 150;
    float TerrainProbeRadiusMeters = 500.0f;
    bool bUIWholeWorldSnapshot = true;
    bool bStartupSelfTest = false;
    float StartupSelfTestDelaySeconds = 10.0f;
    FString StartupSelfTestQuestion = TEXT(
        "Using only the authoritative snapshot, what should the player do next and what placement facts are known?");

    /**
     * Master switch for world-mutating actions. When false the mod still runs
     * every requested action's validation and reports what *would* happen, but
     * commits nothing — the game side decides whether a write lands, not the
     * model and not the bridge.
     */
    bool bAllowWriteActions = false;
    /** Upper bound on actions executed from one reply, so a runaway plan stops. */
    int32 MaxActionsPerReply = 64;

    /**
     * Write what the player is looking at to a PNG the assistant can read.
     *
     * Off by default: a capture every few seconds spends the player's frame
     * budget on the assistant's convenience, and that is a choice to make
     * rather than one to discover.
     */
    /**
     * Start the bundled companion bridge when a world loads.
     *
     * On by default: the mod is one install now, and an assistant that
     * reports itself offline until you find a second zip is not one. Turn it
     * off if you run the bridge yourself -- the mod only ever stops a process
     * it started, so both can coexist.
     */
    bool bAutoStartCompanion = true;

    /**
     * Tell the bridge what the world looks like, without being asked.
     *
     * Off by default, and deliberately not a whole-world capture. A full
     * capture of a developed save measures 1.9 seconds on the game thread and
     * 77 MB of JSON; repeating that on a timer would not be a feed, it would
     * be a stall. What goes out instead is the player's surroundings with the
     * reflected-property detail and the static content catalog left off - the
     * parts that answer "where is everything and what is connected to what",
     * which is what a feed is for. The whole-world picture still arrives the
     * way it always did, on a question.
     *
     * Changed world/coverage is sent on the next paced attempt. Otherwise a
     * periodic refresh observes inventories and other unhashed state after
     * max(30 seconds, this interval). 0 disables the feed entirely.
     */
    float LiveFeedIntervalSeconds = 0.0f;
    /** How far around the player the feed looks. */
    float LiveFeedRadiusMeters = 250.0f;

    bool bVisionEnabled = false;
    /** 0 disables the timer; frames can still be requested on demand. */
    float VisionIntervalSeconds = 0.0f;
    /** The HUD is information -- hotbar, health, build mode -- not clutter. */
    bool bVisionIncludeUI = true;
    /** Ring size. One still cannot show motion; a short history can. */
    int32 VisionFrameHistory = 12;

    static FAIFactorySettings Load();
    static FString GetConfigPath();
};
