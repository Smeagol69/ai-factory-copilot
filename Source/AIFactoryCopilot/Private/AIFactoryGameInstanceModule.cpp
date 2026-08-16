#include "AIFactoryGameInstanceModule.h"

#include "AIFactoryBlueprintPreviewRCO.h"

UAIFactoryGameInstanceModule::UAIFactoryGameInstanceModule()
{
    bRootModule = true;
    RemoteCallObjects.Add(UAIFactoryBlueprintPreviewRCO::StaticClass());
}
