#include "AIFactoryGameInstanceModule.h"

#include "AIFactoryBlueprintPreviewRCO.h"
#include "AIFactoryBlueprintResourceAnchorRCO.h"

UAIFactoryGameInstanceModule::UAIFactoryGameInstanceModule()
{
    bRootModule = true;
    RemoteCallObjects.Add(UAIFactoryBlueprintPreviewRCO::StaticClass());
    RemoteCallObjects.Add(UAIFactoryBlueprintResourceAnchorRCO::StaticClass());
}
