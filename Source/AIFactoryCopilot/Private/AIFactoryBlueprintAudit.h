#pragma once

#include "CoreMinimal.h"
#include "Dom/JsonObject.h"

class AActor;

/**
 * Evidence-only inspection of one *placed* native Blueprint instance.
 *
 * This belongs to the module's private surface: it carries JSON types and is
 * consumed only by the snapshot and action readback implementations. It never
 * repairs, claims, places, exports, imports, or changes any resource binding.
 */
namespace AIFactoryBlueprintAudit
{
    /**
     * Captures the native Blueprint proxy owning an aimed proxy or actor-backed
     * Blueprint member. When the game's cached use hit resolves to a resource
     * node (as miners commonly do), CameraFallbackTarget is considered only for
     * this evidence read; it never changes the normal preferred target used by
     * placement or any other action.
     */
    TSharedRef<FJsonObject> Capture(
        AActor* PrimaryTarget,
        AActor* CameraFallbackTarget = nullptr);
}
