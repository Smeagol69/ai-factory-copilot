#include "AIFactoryGameInstanceModule.h"

#include "AIFactoryBlueprintPreviewRCO.h"
#include "AIFactoryBlueprintResourceAnchorRCO.h"
#include "AIFactoryCreativeNodeRCO.h"

UAIFactoryGameInstanceModule::UAIFactoryGameInstanceModule()
{
    bRootModule = true;
    RemoteCallObjects.Add(UAIFactoryBlueprintPreviewRCO::StaticClass());
    RemoteCallObjects.Add(UAIFactoryBlueprintResourceAnchorRCO::StaticClass());
    RemoteCallObjects.Add(UAIFactoryCreativeNodeRCO::StaticClass());
}
