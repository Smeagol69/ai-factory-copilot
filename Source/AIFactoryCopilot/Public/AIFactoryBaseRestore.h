#pragma once
#include "CoreMinimal.h"
#include "AIFactoryActions.h"

namespace AIFactoryBaseRestore
{
    /** Standalone server transaction. The caller owns write/revision gates and
     * journals OutUndo only after verified success. No Build Gun snapping. */
    FAIFactoryActionResult Restore(const FAIFactoryActionContext& Context,
        const FString& PackageName, FAIFactoryUndoStep& OutUndo);
}
