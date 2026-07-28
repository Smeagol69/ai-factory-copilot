#include "AIFactorySnapshot.h"

#include "AIFactoryCopilotModule.h"
#include "AIFactoryDataProvider.h"
#include "AIFactorySettings.h"
#include "AIFactoryTerrain.h"
#include "Buildables/FGBuildable.h"
#include "Buildables/FGBuildableConveyorBase.h"
#include "Buildables/FGBuildableFactory.h"
#include "Buildables/FGBuildableManufacturer.h"
#include "Buildables/FGBuildablePipeline.h"
#include "Buildables/FGBuildableResourceExtractor.h"
#include "Camera/PlayerCameraManager.h"
#include "Components/PrimitiveComponent.h"
#include "Dom/JsonObject.h"
#include "Engine/HitResult.h"
#include "Engine/World.h"
#include "EngineUtils.h"
#include "FGFactoryConnectionComponent.h"
#include "FGCharacterPlayer.h"
#include "FGGamePhase.h"
#include "FGGamePhaseManager.h"
#include "FGGameState.h"
#include "FGHealthComponent.h"
#include "FGInventoryComponent.h"
#include "FGItemPickup.h"
#include "FGOnboardingStep.h"
#include "FGPipeConnectionComponent.h"
#include "FGPowerCircuit.h"
#include "FGPowerConnectionComponent.h"
#include "FGPowerInfoComponent.h"
#include "FGPlayerController.h"
#include "FGPlayerState.h"
#include "FGRecipe.h"
#include "FGRecipeManager.h"
#include "FGSchematic.h"
#include "FGSchematicManager.h"
#include "FGTutorialIntroManager.h"
#include "FGUseableInterface.h"
#include "FGVehicle.h"
#include "GameFramework/Pawn.h"
#include "HAL/PlatformTime.h"
#include "Kismet/BlueprintAssetHelperLibrary.h"
#include "ModLoading/ModLoadingLibrary.h"
#include "Registry/ModContentRegistry.h"
#include "Resources/FGItemDescriptor.h"
#include "Resources/FGResourceNode.h"
#include "Resources/FGResourceNodeBase.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "UObject/UnrealType.h"

namespace
{
    FString NetModeName(const ENetMode NetMode)
    {
        switch (NetMode)
        {
        case NM_Standalone:
            return TEXT("NM_Standalone");
        case NM_DedicatedServer:
            return TEXT("NM_DedicatedServer");
        case NM_ListenServer:
            return TEXT("NM_ListenServer");
        case NM_Client:
            return TEXT("NM_Client");
        case NM_MAX:
        default:
            return TEXT("NM_MAX");
        }
    }

    TSharedRef<FJsonObject> Evidence(const FString& Value, const TCHAR* Source = TEXT("runtime"))
    {
        const TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
        Result->SetStringField(TEXT("value"), Value);
        Result->SetStringField(TEXT("source"), Source);
        Result->SetStringField(TEXT("certainty"), TEXT("authoritative"));
        return Result;
    }

    TSharedRef<FJsonObject> EvidenceNumber(const double Value, const TCHAR* Source = TEXT("runtime"))
    {
        const TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
        Result->SetNumberField(TEXT("value"), Value);
        Result->SetStringField(TEXT("source"), Source);
        Result->SetStringField(TEXT("certainty"), TEXT("authoritative"));
        return Result;
    }

    TSharedRef<FJsonObject> VectorJson(const FVector& Value)
    {
        const TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
        Result->SetNumberField(TEXT("x"), Value.X);
        Result->SetNumberField(TEXT("y"), Value.Y);
        Result->SetNumberField(TEXT("z"), Value.Z);
        return Result;
    }

    TSharedRef<FJsonObject> RotatorJson(const FRotator& Value)
    {
        const TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
        Result->SetNumberField(TEXT("pitch"), Value.Pitch);
        Result->SetNumberField(TEXT("yaw"), Value.Yaw);
        Result->SetNumberField(TEXT("roll"), Value.Roll);
        return Result;
    }

    FString OwnerModForObject(const UObject* Object)
    {
        if (!IsValid(Object))
        {
            return TEXT("Unknown");
        }

        const FString Owner = UBlueprintAssetHelperLibrary::FindPluginNameByObjectPath(Object->GetPathName(), true);
        return Owner.IsEmpty() ? TEXT("Unknown") : Owner;
    }

    FString ClassPath(const UClass* Class)
    {
        return IsValid(Class) ? Class->GetPathName() : FString();
    }

    FString KindForActor(AActor* Actor)
    {
        if (!IsValid(Actor))
        {
            return TEXT("unknown");
        }
        if (Actor->IsA<AFGBuildable>()) return TEXT("buildable");
        if (Actor->IsA<AFGResourceNodeBase>()) return TEXT("resource_node");
        if (Actor->IsA<AFGCharacterPlayer>()) return TEXT("player");
        if (Actor->IsA<AFGVehicle>()) return TEXT("vehicle");
        if (Actor->IsA<AFGItemPickup>()) return TEXT("item_pickup");
        if (Actor->GetClass()->ImplementsInterface(UAIFactoryDataProvider::StaticClass()))
        {
            return TEXT("adapter_actor");
        }
        return TEXT("world_actor");
    }

    bool IsPotentialModActor(AActor* Actor)
    {
        if (!IsValid(Actor))
        {
            return false;
        }

        const FString Owner = OwnerModForObject(Actor->GetClass());
        return !Owner.IsEmpty() &&
            Owner != TEXT("Unknown") &&
            Owner != TEXT("FactoryGame") &&
            Owner != TEXT("Engine") &&
            Owner != TEXT("CoreUObject") &&
            Owner != TEXT("SML") &&
            Owner != TEXT("AIFactoryCopilot");
    }

    TSharedRef<FJsonObject> ItemAmountJson(const FItemAmount& Amount)
    {
        const TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
        Result->SetStringField(TEXT("item_class"), ClassPath(Amount.ItemClass.Get()));
        Result->SetStringField(TEXT("item_name"),
            Amount.ItemClass ? UFGItemDescriptor::GetItemName(Amount.ItemClass).ToString() : TEXT(""));
        Result->SetNumberField(TEXT("amount"), Amount.Amount);
        return Result;
    }

    TArray<TSharedPtr<FJsonValue>> ItemAmountsJson(const TArray<FItemAmount>& Amounts)
    {
        TArray<TSharedPtr<FJsonValue>> Result;
        for (const FItemAmount& Amount : Amounts)
        {
            Result.Add(MakeShared<FJsonValueObject>(ItemAmountJson(Amount)));
        }
        return Result;
    }

    TArray<TSharedPtr<FJsonValue>> TextArrayJson(const TArray<FText>& Texts)
    {
        TArray<TSharedPtr<FJsonValue>> Result;
        for (const FText& Text : Texts)
        {
            Result.Add(MakeShared<FJsonValueString>(Text.ToString()));
        }
        return Result;
    }

    TSharedRef<FJsonObject> SchematicJson(
        UWorld* World,
        AFGSchematicManager* Manager,
        const TSubclassOf<UFGSchematic>& Schematic)
    {
        const TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
        Result->SetBoolField(TEXT("available"), Schematic != nullptr);
        if (!Schematic)
        {
            return Result;
        }

        Result->SetStringField(TEXT("class_path"), ClassPath(Schematic.Get()));
        Result->SetStringField(TEXT("name"), UFGSchematic::GetSchematicDisplayName(Schematic).ToString());
        Result->SetStringField(TEXT("description"), UFGSchematic::GetSchematicDescription(Schematic).ToString());
        Result->SetStringField(TEXT("owner_mod"), OwnerModForObject(Schematic.Get()));
        Result->SetStringField(
            TEXT("type"),
            StaticEnum<ESchematicType>()->GetNameStringByValue(
                static_cast<int64>(UFGSchematic::GetType(Schematic))));
        Result->SetNumberField(TEXT("tech_tier"), UFGSchematic::GetTechTier(Schematic));
        Result->SetBoolField(TEXT("player_specific"), UFGSchematic::GetIsPlayerSpecific(Schematic));
        Result->SetBoolField(
            TEXT("dependencies_met"),
            IsValid(World) && UFGSchematic::AreSchematicDependenciesMet(Schematic, World));
        if (IsValid(World))
        {
            Result->SetStringField(
                TEXT("state"),
                StaticEnum<ESchematicState>()->GetNameStringByValue(
                    static_cast<int64>(UFGSchematic::GetSchematicState(Schematic, World))));
        }
        Result->SetArrayField(TEXT("cost"), ItemAmountsJson(UFGSchematic::GetCost(Schematic)));
        if (IsValid(Manager))
        {
            Result->SetArrayField(TEXT("paid_cost"), ItemAmountsJson(Manager->GetPaidOffCostFor(Schematic)));
            Result->SetArrayField(TEXT("remaining_cost"), ItemAmountsJson(Manager->GetRemainingCostFor(Schematic)));
        }
        return Result;
    }

    TSharedRef<FJsonObject> GamePhaseJson(const UFGGamePhase* Phase)
    {
        const TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
        Result->SetBoolField(TEXT("available"), IsValid(Phase));
        if (!IsValid(Phase))
        {
            return Result;
        }

        Result->SetStringField(TEXT("asset_path"), Phase->GetPathName());
        Result->SetStringField(TEXT("name"), Phase->mDisplayName.ToString());
        Result->SetNumberField(TEXT("last_tech_tier"), Phase->mLastTierOfPhase);
        Result->SetNumberField(TEXT("priority"), Phase->mPriority);
        Result->SetStringField(TEXT("phase_tag"), Phase->mPhaseTag.ToString());
        Result->SetStringField(
            TEXT("legacy_phase"),
            StaticEnum<EGamePhase>()->GetNameStringByValue(static_cast<int64>(Phase->mGamePhase)));
        Result->SetArrayField(TEXT("cost"), ItemAmountsJson(Phase->mCosts));
        return Result;
    }

    TArray<TSharedPtr<FJsonValue>> InventoryJson(const UFGInventoryComponent* Inventory)
    {
        TArray<TSharedPtr<FJsonValue>> Result;
        if (!IsValid(Inventory))
        {
            return Result;
        }

        TArray<FInventoryStack> Stacks;
        Inventory->GetInventoryStacks(Stacks, false);
        for (const FInventoryStack& Stack : Stacks)
        {
            if (!Stack.HasItems())
            {
                continue;
            }

            const TSubclassOf<UFGItemDescriptor> ItemClass = Stack.Item.GetItemClass();
            const TSharedRef<FJsonObject> Item = MakeShared<FJsonObject>();
            Item->SetStringField(TEXT("item_class"), ClassPath(ItemClass.Get()));
            Item->SetStringField(TEXT("item_name"),
                ItemClass ? UFGItemDescriptor::GetItemName(ItemClass).ToString() : TEXT(""));
            Item->SetNumberField(TEXT("amount"), Stack.NumItems);
            Result.Add(MakeShared<FJsonValueObject>(Item));
        }
        return Result;
    }

    TArray<TSharedPtr<FJsonValue>> ReflectedPropertiesJson(
        UObject* Object,
        const FAIFactorySettings& Settings)
    {
        TArray<TSharedPtr<FJsonValue>> Result;
        if (!IsValid(Object) || Settings.MaxReflectedPropertiesPerObject <= 0)
        {
            return Result;
        }

        int32 Added = 0;
        for (TFieldIterator<FProperty> It(Object->GetClass(), EFieldIterationFlags::IncludeSuper); It && Added < Settings.MaxReflectedPropertiesPerObject; ++It)
        {
            const FProperty* Property = *It;
            if (!Property ||
                Property->HasAnyPropertyFlags(CPF_Transient | CPF_Deprecated | CPF_EditorOnly | CPF_SkipSerialization))
            {
                continue;
            }

            FString ExportedValue;
            const void* ValuePointer = Property->ContainerPtrToValuePtr<void>(Object);
            Property->ExportTextItem_Direct(ExportedValue, ValuePointer, nullptr, Object, PPF_None);
            if (ExportedValue.Len() > Settings.MaxReflectedValueCharacters)
            {
                ExportedValue.LeftInline(Settings.MaxReflectedValueCharacters);
                ExportedValue += TEXT("…[truncated]");
            }

            const TSharedRef<FJsonObject> Entry = MakeShared<FJsonObject>();
            Entry->SetStringField(TEXT("name"), Property->GetName());
            Entry->SetStringField(TEXT("cpp_type"), Property->GetCPPType());
            Entry->SetStringField(TEXT("declared_by"), Property->GetOwnerClass() ? Property->GetOwnerClass()->GetPathName() : TEXT(""));
            Entry->SetStringField(TEXT("flags"), FString::Printf(TEXT("0x%016llx"),
                static_cast<unsigned long long>(Property->GetPropertyFlags())));
            Entry->SetStringField(TEXT("value"), ExportedValue);
            Entry->SetStringField(TEXT("source"), TEXT("unreal_reflection"));
            Entry->SetStringField(TEXT("certainty"), TEXT("authoritative"));
            Result.Add(MakeShared<FJsonValueObject>(Entry));
            ++Added;
        }
        return Result;
    }

    void AddAdapterJson(const TSharedRef<FJsonObject>& Result, AActor* Actor)
    {
        if (!IsValid(Actor) || !Actor->GetClass()->ImplementsInterface(UAIFactoryDataProvider::StaticClass()))
        {
            return;
        }

        const TSharedRef<FJsonObject> Adapter = MakeShared<FJsonObject>();
        Adapter->SetNumberField(
            TEXT("schema_version"),
            IAIFactoryDataProvider::Execute_GetAIFactorySchemaVersion(Actor));
        Adapter->SetBoolField(
            TEXT("complete"),
            IAIFactoryDataProvider::Execute_IsAIFactoryDataComplete(Actor));
        Adapter->SetStringField(TEXT("source"), TEXT("explicit_mod_adapter"));
        Adapter->SetStringField(TEXT("certainty"), TEXT("authoritative"));

        TArray<TSharedPtr<FJsonValue>> CapabilityTags;
        for (const FName& Tag : IAIFactoryDataProvider::Execute_GetAIFactoryCapabilityTags(Actor))
        {
            CapabilityTags.Add(MakeShared<FJsonValueString>(Tag.ToString()));
        }
        Adapter->SetArrayField(TEXT("capability_tags"), CapabilityTags);

        const FString AdapterJson = IAIFactoryDataProvider::Execute_GetAIFactoryAuthoritativeDataJson(Actor);
        TSharedPtr<FJsonObject> AdapterObject;
        const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(AdapterJson);
        if (FJsonSerializer::Deserialize(Reader, AdapterObject) && AdapterObject.IsValid())
        {
            Adapter->SetObjectField(TEXT("data"), AdapterObject.ToSharedRef());
        }
        else
        {
            Adapter->SetStringField(TEXT("error"), TEXT("Adapter returned invalid JSON."));
            Adapter->SetBoolField(TEXT("complete"), false);
        }
        Result->SetObjectField(TEXT("adapter"), Adapter);
    }

    /** Measured ground conditions for a candidate footprint. */
    TSharedRef<FJsonObject> SiteTerrainJson(const FAIFactorySiteTerrain& Site)
    {
        const TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
        Result->SetBoolField(TEXT("sampled"), Site.bSampled);
        Result->SetStringField(TEXT("verdict"), Site.Verdict);
        Result->SetNumberField(TEXT("footprint_meters"), Site.FootprintMeters);
        Result->SetNumberField(TEXT("samples_requested"), Site.SamplesRequested);
        Result->SetNumberField(TEXT("samples_with_ground"), Site.SamplesWithGround);
        if (Site.bSampled)
        {
            Result->SetNumberField(TEXT("mean_slope_degrees"), Site.MeanSlopeDegrees);
            Result->SetNumberField(TEXT("max_slope_degrees"), Site.MaxSlopeDegrees);
            Result->SetNumberField(TEXT("elevation_range_cm"), Site.ElevationRangeCm);
            Result->SetNumberField(TEXT("min_ground_z"), Site.MinGroundZ);
            Result->SetNumberField(TEXT("max_ground_z"), Site.MaxGroundZ);
            Result->SetNumberField(TEXT("mean_ground_z"), Site.MeanGroundZ);
            Result->SetNumberField(TEXT("water_samples"), Site.WaterSamples);
            Result->SetNumberField(TEXT("blocked_samples"), Site.BlockedSamples);
        }
        Result->SetStringField(TEXT("source"), TEXT("unreal_line_traces_and_water_volumes"));
        Result->SetStringField(TEXT("certainty"), TEXT("authoritative"));
        Result->SetStringField(
            TEXT("blocked_meaning"),
            TEXT("A world-static volume lifted clear of the ground overlapped the footprint: rock, cliff, or foliage. Existing buildables are not counted here; the solvers compute those from actor bounds."));
        return Result;
    }

    TSharedRef<FJsonObject> GenericActorJson(
        AActor* Actor,
        const FString& Kind,
        const FAIFactorySettings& Settings)
    {
        const TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
        Result->SetStringField(TEXT("actor_id"), Actor->GetPathName());
        Result->SetStringField(TEXT("name"), Actor->GetName());
        Result->SetStringField(TEXT("class_path"), Actor->GetClass()->GetPathName());
        Result->SetStringField(TEXT("owner_mod"), OwnerModForObject(Actor->GetClass()));
        Result->SetStringField(TEXT("kind"), Kind);
        Result->SetObjectField(TEXT("location"), VectorJson(Actor->GetActorLocation()));
        Result->SetObjectField(TEXT("rotation"), RotatorJson(Actor->GetActorRotation()));
        Result->SetObjectField(TEXT("scale"), VectorJson(Actor->GetActorScale3D()));
        Result->SetObjectField(TEXT("velocity"), VectorJson(Actor->GetVelocity()));

        FVector BoundsOrigin;
        FVector BoundsExtent;
        Actor->GetActorBounds(false, BoundsOrigin, BoundsExtent, true);
        const TSharedRef<FJsonObject> Bounds = MakeShared<FJsonObject>();
        Bounds->SetObjectField(TEXT("origin"), VectorJson(BoundsOrigin));
        Bounds->SetObjectField(TEXT("extent"), VectorJson(BoundsExtent));
        Result->SetObjectField(TEXT("bounds"), Bounds);

        TInlineComponentArray<UFGInventoryComponent*> Inventories;
        Actor->GetComponents(Inventories);
        TArray<TSharedPtr<FJsonValue>> InventoryEntries;
        for (UFGInventoryComponent* Inventory : Inventories)
        {
            if (!IsValid(Inventory))
            {
                continue;
            }
            const TSharedRef<FJsonObject> InventoryEntry = MakeShared<FJsonObject>();
            InventoryEntry->SetStringField(TEXT("component"), Inventory->GetPathName());
            InventoryEntry->SetNumberField(TEXT("slots"), Inventory->GetSizeLinear());
            InventoryEntry->SetArrayField(TEXT("stacks"), InventoryJson(Inventory));
            InventoryEntries.Add(MakeShared<FJsonValueObject>(InventoryEntry));
        }
        Result->SetArrayField(TEXT("inventories"), InventoryEntries);

        if (AFGCharacterPlayer* Player = Cast<AFGCharacterPlayer>(Actor))
        {
            if (const UFGHealthComponent* Health = Player->GetHealthComponent())
            {
                const double CurrentHealth = Health->GetCurrentHealth();
                const double MaxHealth = Health->GetMaxHealth();
                Result->SetNumberField(TEXT("health_current"), CurrentHealth);
                Result->SetNumberField(TEXT("health_max"), MaxHealth);
                Result->SetNumberField(
                    TEXT("health_percent"),
                    MaxHealth > UE_DOUBLE_SMALL_NUMBER ? (CurrentHealth / MaxHealth) * 100.0 : 0.0);
            }
            if (UFGInventoryComponent* Inventory = Player->GetInventory())
            {
                Result->SetArrayField(TEXT("player_inventory"), InventoryJson(Inventory));
            }
        }
        else if (AFGItemPickup* Pickup = Cast<AFGItemPickup>(Actor))
        {
            const TSubclassOf<UFGItemDescriptor> ItemClass = Pickup->GetPickupItemClass();
            Result->SetStringField(TEXT("item_class"), ClassPath(ItemClass.Get()));
            Result->SetStringField(
                TEXT("item_name"),
                ItemClass ? UFGItemDescriptor::GetItemName(ItemClass).ToString() : TEXT(""));
            Result->SetNumberField(TEXT("amount"), Pickup->GetNumItems());
        }

        if (Settings.bIncludeReflectedProperties)
        {
            Result->SetArrayField(TEXT("reflected_properties"), ReflectedPropertiesJson(Actor, Settings));
        }
        AddAdapterJson(Result, Actor);
        return Result;
    }

    TArray<TSharedPtr<FJsonValue>> ConnectionJson(AFGBuildable* Buildable)
    {
        TArray<TSharedPtr<FJsonValue>> Result;

        TInlineComponentArray<UFGFactoryConnectionComponent*> FactoryConnections;
        Buildable->GetComponents(FactoryConnections);
        for (UFGFactoryConnectionComponent* Connection : FactoryConnections)
        {
            if (!IsValid(Connection))
            {
                continue;
            }
            const TSharedRef<FJsonObject> Entry = MakeShared<FJsonObject>();
            Entry->SetStringField(TEXT("kind"), TEXT("factory"));
            Entry->SetStringField(TEXT("component"), Connection->GetPathName());
            Entry->SetStringField(TEXT("direction"), StaticEnum<EFactoryConnectionDirection>()->GetNameStringByValue(
                static_cast<int64>(Connection->GetDirection())));
            Entry->SetBoolField(TEXT("connected"), Connection->IsConnected());
            Entry->SetStringField(TEXT("connected_component"),
                IsValid(Connection->GetConnection()) ? Connection->GetConnection()->GetPathName() : TEXT(""));
            Entry->SetObjectField(TEXT("location"), VectorJson(Connection->GetConnectorLocation(false)));
            Entry->SetObjectField(TEXT("normal"), VectorJson(Connection->GetConnectorNormal()));
            Entry->SetNumberField(TEXT("inventory_access_index"), Connection->GetInventoryAccessIndex());
            Result.Add(MakeShared<FJsonValueObject>(Entry));
        }

        TInlineComponentArray<UFGPipeConnectionComponent*> PipeConnections;
        Buildable->GetComponents(PipeConnections);
        for (UFGPipeConnectionComponent* Connection : PipeConnections)
        {
            if (!IsValid(Connection))
            {
                continue;
            }
            const TSharedRef<FJsonObject> Entry = MakeShared<FJsonObject>();
            Entry->SetStringField(TEXT("kind"), TEXT("pipe"));
            Entry->SetStringField(TEXT("component"), Connection->GetPathName());
            Entry->SetStringField(TEXT("direction"), StaticEnum<EPipeConnectionType>()->GetNameStringByValue(
                static_cast<int64>(Connection->GetPipeConnectionType())));
            Entry->SetBoolField(TEXT("connected"), Connection->IsConnected());
            Entry->SetStringField(TEXT("connected_component"),
                IsValid(Connection->GetConnection()) ? Connection->GetConnection()->GetPathName() : TEXT(""));
            Entry->SetObjectField(TEXT("location"), VectorJson(Connection->GetConnectorLocation(false)));
            Entry->SetObjectField(TEXT("normal"), VectorJson(Connection->GetConnectorNormal()));
            const TSubclassOf<UFGItemDescriptor> Fluid = Connection->GetFluidDescriptor();
            Entry->SetStringField(TEXT("fluid_class"), ClassPath(Fluid.Get()));
            Result.Add(MakeShared<FJsonValueObject>(Entry));
        }

        TInlineComponentArray<UFGPowerConnectionComponent*> PowerConnections;
        Buildable->GetComponents(PowerConnections);
        for (UFGPowerConnectionComponent* Connection : PowerConnections)
        {
            if (!IsValid(Connection))
            {
                continue;
            }
            const TSharedRef<FJsonObject> Entry = MakeShared<FJsonObject>();
            Entry->SetStringField(TEXT("kind"), TEXT("power"));
            Entry->SetStringField(TEXT("component"), Connection->GetPathName());
            const UFGPowerInfoComponent* PowerInfo = Connection->GetPowerInfo();
            Entry->SetBoolField(TEXT("connected"), IsValid(PowerInfo) && PowerInfo->IsConnected());
            if (IsValid(PowerInfo))
            {
                if (UFGPowerCircuit* Circuit = PowerInfo->GetPowerCircuit())
                {
                    const TSharedRef<FJsonObject> CircuitState = MakeShared<FJsonObject>();
                    CircuitState->SetNumberField(TEXT("circuit_id"), Circuit->GetCircuitID());
                    CircuitState->SetBoolField(TEXT("fuse_triggered"), Circuit->IsFuseTriggered());
                    CircuitState->SetNumberField(TEXT("production_capacity_mw"), Circuit->GetPowerProductionCapacity());
                    CircuitState->SetNumberField(TEXT("maximum_consumption_mw"), Circuit->GetMaximumPowerConsumption());
                    CircuitState->SetNumberField(TEXT("battery_store_mwh"), Circuit->GetBatterySumPowerStore());
                    CircuitState->SetNumberField(TEXT("battery_capacity_mwh"), Circuit->GetBatterySumPowerStoreCapacity());
                    CircuitState->SetNumberField(TEXT("battery_input_mw"), Circuit->GetBatterySumPowerInput());
                    CircuitState->SetNumberField(TEXT("battery_output_mw"), Circuit->GetBatterySumPowerOutput());
                    Entry->SetObjectField(TEXT("circuit"), CircuitState);
                }
            }
            Result.Add(MakeShared<FJsonValueObject>(Entry));
        }
        return Result;
    }

    TSharedRef<FJsonObject> BuildableJson(AFGBuildable* Buildable, const FAIFactorySettings& Settings)
    {
        const TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
        Result->SetStringField(TEXT("actor_id"), Buildable->GetPathName());
        Result->SetStringField(TEXT("name"), Buildable->GetName());
        Result->SetStringField(TEXT("class_path"), Buildable->GetClass()->GetPathName());
        Result->SetStringField(TEXT("owner_mod"), OwnerModForObject(Buildable->GetClass()));
        Result->SetStringField(TEXT("kind"), TEXT("buildable"));
        Result->SetObjectField(TEXT("location"), VectorJson(Buildable->GetActorLocation()));
        Result->SetObjectField(TEXT("rotation"), RotatorJson(Buildable->GetActorRotation()));
        Result->SetObjectField(TEXT("scale"), VectorJson(Buildable->GetActorScale3D()));

        FVector BoundsOrigin;
        FVector BoundsExtent;
        Buildable->GetActorBounds(false, BoundsOrigin, BoundsExtent, true);
        const TSharedRef<FJsonObject> Bounds = MakeShared<FJsonObject>();
        Bounds->SetObjectField(TEXT("origin"), VectorJson(BoundsOrigin));
        Bounds->SetObjectField(TEXT("extent"), VectorJson(BoundsExtent));
        Result->SetObjectField(TEXT("bounds"), Bounds);

        const TSubclassOf<UFGRecipe> BuiltWithRecipe = Buildable->GetBuiltWithRecipe();
        Result->SetStringField(TEXT("built_with_recipe"), ClassPath(BuiltWithRecipe.Get()));
        Result->SetBoolField(TEXT("inside_blueprint_designer"), Buildable->IsBuildableInsideBlueprintDesigner());
        Result->SetArrayField(TEXT("connections"), ConnectionJson(Buildable));

        TInlineComponentArray<UFGInventoryComponent*> Inventories;
        Buildable->GetComponents(Inventories);
        TArray<TSharedPtr<FJsonValue>> InventoryEntries;
        for (UFGInventoryComponent* Inventory : Inventories)
        {
            if (!IsValid(Inventory))
            {
                continue;
            }
            const TSharedRef<FJsonObject> InventoryEntry = MakeShared<FJsonObject>();
            InventoryEntry->SetStringField(TEXT("component"), Inventory->GetPathName());
            InventoryEntry->SetNumberField(TEXT("slots"), Inventory->GetSizeLinear());
            InventoryEntry->SetArrayField(TEXT("stacks"), InventoryJson(Inventory));
            InventoryEntries.Add(MakeShared<FJsonValueObject>(InventoryEntry));
        }
        Result->SetArrayField(TEXT("inventories"), InventoryEntries);

        if (const AFGBuildableFactory* Factory = Cast<AFGBuildableFactory>(Buildable))
        {
            const TSharedRef<FJsonObject> FactoryState = MakeShared<FJsonObject>();
            FactoryState->SetBoolField(TEXT("is_producing"), Factory->IsProducing());
            FactoryState->SetStringField(TEXT("production_status"),
                StaticEnum<EProductionStatus>()->GetNameStringByValue(
                    static_cast<int64>(Factory->GetProductionIndicatorStatus())));
            FactoryState->SetNumberField(TEXT("productivity"), Factory->GetProductivity());
            FactoryState->SetNumberField(TEXT("production_progress"), Factory->GetProductionProgress());
            FactoryState->SetNumberField(TEXT("production_cycle_seconds"), Factory->GetProductionCycleTime());
            FactoryState->SetNumberField(TEXT("default_production_cycle_seconds"), Factory->GetDefaultProductionCycleTime());
            FactoryState->SetNumberField(TEXT("current_potential"), Factory->GetCurrentPotential());
            FactoryState->SetNumberField(TEXT("pending_potential"), Factory->GetPendingPotential());
            FactoryState->SetNumberField(TEXT("max_potential"), Factory->GetMaxPotential());
            FactoryState->SetNumberField(TEXT("current_production_boost"), Factory->GetCurrentProductionBoost());
            FactoryState->SetNumberField(TEXT("pending_production_boost"), Factory->GetPendingProductionBoost());
            FactoryState->SetNumberField(TEXT("producing_power_consumption_mw"), Factory->GetProducingPowerConsumption());
            FactoryState->SetNumberField(TEXT("idle_power_consumption_mw"), Factory->GetIdlePowerConsumption());
            Result->SetObjectField(TEXT("factory"), FactoryState);
        }

        if (const AFGBuildableManufacturer* Manufacturer = Cast<AFGBuildableManufacturer>(Buildable))
        {
            const TSubclassOf<UFGRecipe> Recipe = Manufacturer->GetCurrentRecipe();
            const TSharedRef<FJsonObject> ManufacturerState = MakeShared<FJsonObject>();
            ManufacturerState->SetStringField(TEXT("recipe_class"), ClassPath(Recipe.Get()));
            ManufacturerState->SetStringField(TEXT("recipe_name"),
                Recipe ? UFGRecipe::GetRecipeName(Recipe).ToString() : TEXT(""));
            ManufacturerState->SetNumberField(TEXT("manufacturing_speed"), Manufacturer->GetManufacturingSpeed());
            Result->SetObjectField(TEXT("manufacturer"), ManufacturerState);
        }

        // Extractors have no recipe, so their yield has to come from the
        // extractor accessors instead of the recipe registry.
        if (const AFGBuildableResourceExtractor* Extractor = Cast<AFGBuildableResourceExtractor>(Buildable))
        {
            const TSharedRef<FJsonObject> ExtractorState = MakeShared<FJsonObject>();
            ExtractorState->SetNumberField(TEXT("items_per_cycle"), Extractor->GetNumExtractedItemsPerCycle());
            ExtractorState->SetNumberField(
                TEXT("items_per_cycle_converted"),
                Extractor->GetNumExtractedItemsPerCycleConverted());
            ExtractorState->SetNumberField(TEXT("extraction_per_minute"), Extractor->GetExtractionPerMinute());
            // Only solid-resource extractors expose a node here; fluid extractors
            // leave this empty and the resource stays unknown until observed.
            const AFGResourceNode* ResourceNode = Extractor->GetResourceNode();
            ExtractorState->SetStringField(
                TEXT("extractable_resource_actor_id"),
                IsValid(ResourceNode) ? ResourceNode->GetPathName() : TEXT(""));
            Result->SetObjectField(TEXT("extractor"), ExtractorState);
        }

        if (AFGBuildableConveyorBase* Conveyor = Cast<AFGBuildableConveyorBase>(Buildable))
        {
            const TSharedRef<FJsonObject> Transport = MakeShared<FJsonObject>();
            Transport->SetStringField(TEXT("kind"), TEXT("conveyor"));
            Transport->SetNumberField(TEXT("reported_speed"), Conveyor->GetSpeed());
            Transport->SetNumberField(TEXT("item_spacing_cm"), AFGBuildableConveyorBase::ITEM_SPACING);
            Transport->SetNumberField(TEXT("reported_length"), Conveyor->GetLength());
            Transport->SetNumberField(TEXT("available_space"), Conveyor->GetAvailableSpace());
            TArray<FConveyorBeltItem*> BeltItems;
            Conveyor->GetConveyorBeltItems(BeltItems);
            Transport->SetNumberField(TEXT("items_on_segment"), BeltItems.Num());
            Result->SetObjectField(TEXT("transport"), Transport);
        }
        else if (AFGBuildablePipeline* Pipeline = Cast<AFGBuildablePipeline>(Buildable))
        {
            const TSharedRef<FJsonObject> Transport = MakeShared<FJsonObject>();
            Transport->SetStringField(TEXT("kind"), TEXT("pipeline"));
            Transport->SetNumberField(TEXT("reported_flow_limit"), Pipeline->GetFlowLimit());
            Transport->SetNumberField(TEXT("reported_content"), Pipeline->GetIndicatorContent());
            Transport->SetNumberField(TEXT("reported_max_content"), Pipeline->GetMaxContent());
            Transport->SetNumberField(TEXT("reported_flow"), Pipeline->GetIndicatorFlow());
            Transport->SetStringField(TEXT("fluid_class"), ClassPath(Pipeline->GetFluidDescriptor().Get()));
            Result->SetObjectField(TEXT("transport"), Transport);
        }

        if (Settings.bIncludeReflectedProperties)
        {
            Result->SetArrayField(TEXT("reflected_properties"), ReflectedPropertiesJson(Buildable, Settings));
        }

        AddAdapterJson(Result, Buildable);
        return Result;
    }

    /** Bounds how much terrain probing one capture may do. */
    struct FTerrainProbeBudget
    {
        int32 Remaining = 0;
        FVector Center = FVector::ZeroVector;
        double RadiusSquaredCm = -1.0;

        bool ShouldProbe(const FVector& Location) const
        {
            if (Remaining <= 0) return false;
            if (RadiusSquaredCm < 0.0) return true;
            return FVector::DistSquared(Location, Center) <= RadiusSquaredCm;
        }
    };

    TSharedRef<FJsonObject> ResourceNodeJson(
        AFGResourceNodeBase* Node,
        const FAIFactorySettings& Settings,
        UWorld* World,
        FTerrainProbeBudget& TerrainBudget)
    {
        const TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
        Result->SetStringField(TEXT("actor_id"), Node->GetPathName());
        Result->SetStringField(TEXT("name"), Node->GetName());
        Result->SetStringField(TEXT("class_path"), Node->GetClass()->GetPathName());
        Result->SetStringField(TEXT("owner_mod"), OwnerModForObject(Node->GetClass()));
        Result->SetStringField(TEXT("kind"), TEXT("resource_node"));
        Result->SetObjectField(TEXT("location"), VectorJson(Node->GetActorLocation()));
        Result->SetBoolField(TEXT("occupied"), Node->IsOccupied());
        Result->SetStringField(TEXT("resource_class"), ClassPath(Node->GetResourceClass().Get()));
        Result->SetStringField(TEXT("resource_name"), Node->GetResourceName().ToString());
        Result->SetStringField(TEXT("node_type"), StaticEnum<EResourceNodeType>()->GetNameStringByValue(
            static_cast<int64>(Node->GetResourceNodeType())));

        if (AFGResourceNode* ResourceNode = Cast<AFGResourceNode>(Node))
        {
            Result->SetStringField(TEXT("purity"), StaticEnum<EResourcePurity>()->GetNameStringByValue(
                static_cast<int64>(ResourceNode->GetResourcePurity())));
            Result->SetStringField(TEXT("amount_type"), StaticEnum<EResourceAmount>()->GetNameStringByValue(
                static_cast<int64>(ResourceNode->GetResourceAmount())));
            Result->SetBoolField(TEXT("has_resources"), ResourceNode->HasAnyResources());
        }

        // Unoccupied nodes are the candidate anchors for a new factory, so their
        // ground is measured here and find_best_site scores it.
        if (Settings.bIncludeTerrain && TerrainBudget.ShouldProbe(Node->GetActorLocation()))
        {
            --TerrainBudget.Remaining;
            const FAIFactorySiteTerrain Site = FAIFactoryTerrain::ProbeSite(
                World,
                Node->GetActorLocation(),
                Settings.TerrainFootprintMeters,
                Settings.TerrainResolution,
                Node);
            Result->SetObjectField(TEXT("terrain"), SiteTerrainJson(Site));
        }

        if (Settings.bIncludeReflectedProperties)
        {
            Result->SetArrayField(TEXT("reflected_properties"), ReflectedPropertiesJson(Node, Settings));
        }
        return Result;
    }

    TSharedRef<FJsonObject> FocusActorJson(
        AActor* Actor,
        const FAIFactorySettings& Settings,
        UWorld* World,
        FTerrainProbeBudget& TerrainBudget)
    {
        if (AFGBuildable* Buildable = Cast<AFGBuildable>(Actor))
        {
            return BuildableJson(Buildable, Settings);
        }
        if (AFGResourceNodeBase* ResourceNode = Cast<AFGResourceNodeBase>(Actor))
        {
            return ResourceNodeJson(ResourceNode, Settings, World, TerrainBudget);
        }
        return GenericActorJson(Actor, KindForActor(Actor), Settings);
    }

    TSharedRef<FJsonObject> HitResultJson(const FHitResult& Hit, const bool bHadHit)
    {
        const TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
        AActor* HitActor = Hit.GetActor();
        UPrimitiveComponent* HitComponent = Hit.GetComponent();

        Result->SetBoolField(TEXT("hit"), bHadHit);
        Result->SetBoolField(TEXT("blocking_hit"), Hit.bBlockingHit);
        Result->SetBoolField(TEXT("started_penetrating"), Hit.bStartPenetrating);
        Result->SetNumberField(TEXT("trace_fraction"), Hit.Time);
        Result->SetNumberField(TEXT("distance_meters"), Hit.Distance / 100.0);
        Result->SetNumberField(TEXT("penetration_depth_cm"), Hit.PenetrationDepth);
        Result->SetObjectField(TEXT("trace_start"), VectorJson(Hit.TraceStart));
        Result->SetObjectField(TEXT("trace_end"), VectorJson(Hit.TraceEnd));
        Result->SetObjectField(TEXT("location"), VectorJson(Hit.Location));
        Result->SetObjectField(TEXT("impact_point"), VectorJson(Hit.ImpactPoint));
        Result->SetObjectField(TEXT("normal"), VectorJson(Hit.Normal));
        Result->SetObjectField(TEXT("impact_normal"), VectorJson(Hit.ImpactNormal));
        Result->SetStringField(TEXT("actor_id"), IsValid(HitActor) ? HitActor->GetPathName() : TEXT(""));
        Result->SetStringField(TEXT("actor_name"), IsValid(HitActor) ? HitActor->GetName() : TEXT(""));
        Result->SetStringField(TEXT("actor_class_path"),
            IsValid(HitActor) ? HitActor->GetClass()->GetPathName() : TEXT(""));
        Result->SetStringField(TEXT("actor_owner_mod"),
            IsValid(HitActor) ? OwnerModForObject(HitActor->GetClass()) : TEXT(""));
        Result->SetStringField(TEXT("actor_kind"), IsValid(HitActor) ? KindForActor(HitActor) : TEXT(""));
        Result->SetStringField(TEXT("component_path"),
            IsValid(HitComponent) ? HitComponent->GetPathName() : TEXT(""));
        Result->SetStringField(TEXT("bone_name"), Hit.BoneName.ToString());
        Result->SetStringField(TEXT("my_bone_name"), Hit.MyBoneName.ToString());
        Result->SetNumberField(TEXT("item_index"), Hit.Item);
        Result->SetNumberField(TEXT("face_index"), Hit.FaceIndex);
        Result->SetStringField(TEXT("source"), TEXT("unreal_hit_result"));
        Result->SetStringField(TEXT("certainty"), TEXT("authoritative"));
        return Result;
    }

    TSharedRef<FJsonObject> InteractionContextJson(
        UWorld* World,
        const FAIFactorySnapshotRequest& Request,
        const FAIFactorySettings& Settings,
        FTerrainProbeBudget& TerrainBudget)
    {
        const TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
        Result->SetStringField(TEXT("captured_at_utc"), FDateTime::UtcNow().ToIso8601());
        Result->SetNumberField(TEXT("world_time_seconds"), IsValid(World) ? World->GetTimeSeconds() : 0.0);
        Result->SetStringField(TEXT("source"), TEXT("player_controller_and_game_interaction_state"));
        Result->SetStringField(TEXT("certainty"), TEXT("authoritative_at_capture_time"));

        const TSharedRef<FJsonObject> Grounding = MakeShared<FJsonObject>();
        Grounding->SetStringField(
            TEXT("this_that_it"),
            TEXT("preferred_target; unavailable means the player must aim at the intended object and ask again"));
        Grounding->SetStringField(
            TEXT("here"),
            TEXT("preferred_target.hit_location when available, otherwise player.pawn_location"));
        Grounding->SetStringField(
            TEXT("current_over_history"),
            TEXT("this capture overrides any target or position mentioned in conversation history"));
        Result->SetObjectField(TEXT("grounding_rules"), Grounding);

        AFGPlayerController* PlayerController = Request.PlayerController;
        Result->SetBoolField(TEXT("player_controller_available"), IsValid(PlayerController));
        if (!IsValid(PlayerController))
        {
            Result->SetStringField(TEXT("unavailable_reason"), TEXT("No player controller was supplied by the command sender."));
            return Result;
        }

        const TSharedRef<FJsonObject> Player = MakeShared<FJsonObject>();
        Player->SetStringField(TEXT("controller_id"), PlayerController->GetPathName());
        Player->SetStringField(TEXT("controller_class_path"), PlayerController->GetClass()->GetPathName());
        Player->SetObjectField(TEXT("control_rotation"), RotatorJson(PlayerController->GetControlRotation()));

        APawn* Pawn = PlayerController->GetPawn();
        Player->SetBoolField(TEXT("pawn_available"), IsValid(Pawn));
        if (IsValid(Pawn))
        {
            Player->SetStringField(TEXT("pawn_id"), Pawn->GetPathName());
            Player->SetStringField(TEXT("pawn_class_path"), Pawn->GetClass()->GetPathName());
            Player->SetObjectField(TEXT("pawn_location"), VectorJson(Pawn->GetActorLocation()));
            Player->SetObjectField(TEXT("pawn_rotation"), RotatorJson(Pawn->GetActorRotation()));
            Player->SetObjectField(TEXT("pawn_velocity"), VectorJson(Pawn->GetVelocity()));
        }
        Result->SetObjectField(TEXT("player"), Player);

        FVector ViewLocation = FVector::ZeroVector;
        FRotator ViewRotation = FRotator::ZeroRotator;
        PlayerController->GetPlayerViewPoint(ViewLocation, ViewRotation);
        const FVector ViewDirection = ViewRotation.Vector();
        const FVector TraceEnd =
            ViewLocation + ViewDirection * static_cast<double>(Settings.ViewTraceDistanceMeters * 100.0f);

        const TSharedRef<FJsonObject> Camera = MakeShared<FJsonObject>();
        Camera->SetObjectField(TEXT("location"), VectorJson(ViewLocation));
        Camera->SetObjectField(TEXT("rotation"), RotatorJson(ViewRotation));
        Camera->SetObjectField(TEXT("forward_vector"), VectorJson(ViewDirection));
        Camera->SetNumberField(TEXT("trace_distance_meters"), Settings.ViewTraceDistanceMeters);
        if (IsValid(PlayerController->PlayerCameraManager))
        {
            Camera->SetNumberField(TEXT("field_of_view_degrees"), PlayerController->PlayerCameraManager->GetFOVAngle());
        }
        Result->SetObjectField(TEXT("camera"), Camera);

        FHitResult CameraHit;
        bool bCameraHit = false;
        if (IsValid(World))
        {
            FCollisionQueryParams QueryParams(SCENE_QUERY_STAT(AIFactoryCopilotCameraTrace), true);
            if (IsValid(Pawn))
            {
                QueryParams.AddIgnoredActor(Pawn);
            }
            bCameraHit = World->LineTraceSingleByChannel(
                CameraHit,
                ViewLocation,
                TraceEnd,
                ECC_Visibility,
                QueryParams);
        }
        if (!bCameraHit)
        {
            CameraHit.TraceStart = ViewLocation;
            CameraHit.TraceEnd = TraceEnd;
            CameraHit.Location = TraceEnd;
            CameraHit.ImpactPoint = TraceEnd;
        }
        Result->SetObjectField(TEXT("camera_visibility_trace"), HitResultJson(CameraHit, bCameraHit));

        AFGCharacterPlayer* Character = Cast<AFGCharacterPlayer>(PlayerController->GetControlledCharacter());
        FHitResult InteractionHit;
        bool bInteractionHit = false;
        const TSharedRef<FJsonObject> GameInteraction = MakeShared<FJsonObject>();
        GameInteraction->SetBoolField(TEXT("controlled_character_available"), IsValid(Character));
        if (IsValid(Character))
        {
            GameInteraction->SetStringField(TEXT("controlled_character_id"), Character->GetPathName());
            if (FUseState* UseState = Character->GetCachedUseState())
            {
                bInteractionHit = UseState->bIsTraceHit;
                InteractionHit = UseState->UseHitResult;
                GameInteraction->SetBoolField(TEXT("is_direct_trace_hit"), UseState->bIsTraceHit);
                GameInteraction->SetObjectField(TEXT("use_location"), VectorJson(UseState->UseLocation));
                GameInteraction->SetStringField(
                    TEXT("use_component_path"),
                    IsValid(UseState->UseComponent) ? UseState->UseComponent->GetPathName() : TEXT(""));
                GameInteraction->SetStringField(TEXT("use_state_class"), ClassPath(UseState->GetState().Get()));
                GameInteraction->SetBoolField(
                    TEXT("is_usable_state"),
                    UFGUseState::CanUseInState(UseState->GetState()));
                GameInteraction->SetObjectField(
                    TEXT("hit_result"),
                    HitResultJson(InteractionHit, bInteractionHit));
            }
        }
        Result->SetObjectField(TEXT("game_cached_interaction"), GameInteraction);

        AActor* PreferredActor = bInteractionHit ? InteractionHit.GetActor() : CameraHit.GetActor();
        const FHitResult& PreferredHit = bInteractionHit ? InteractionHit : CameraHit;
        const bool bPreferredAvailable = bInteractionHit || bCameraHit;
        const TSharedRef<FJsonObject> PreferredTarget = MakeShared<FJsonObject>();
        PreferredTarget->SetBoolField(TEXT("available"), bPreferredAvailable);
        PreferredTarget->SetStringField(
            TEXT("selected_from"),
            bInteractionHit ? TEXT("game_cached_interaction") :
                (bCameraHit ? TEXT("camera_visibility_trace") : TEXT("none")));
        PreferredTarget->SetObjectField(TEXT("hit_location"), VectorJson(PreferredHit.ImpactPoint));
        if (IsValid(PreferredActor))
        {
            PreferredTarget->SetStringField(TEXT("actor_id"), PreferredActor->GetPathName());
            PreferredTarget->SetStringField(TEXT("actor_name"), PreferredActor->GetName());
            PreferredTarget->SetStringField(TEXT("actor_class_path"), PreferredActor->GetClass()->GetPathName());
            PreferredTarget->SetStringField(TEXT("actor_owner_mod"), OwnerModForObject(PreferredActor->GetClass()));
            PreferredTarget->SetStringField(TEXT("actor_kind"), KindForActor(PreferredActor));
            PreferredTarget->SetObjectField(TEXT("actor_snapshot"), FocusActorJson(PreferredActor, Settings, World, TerrainBudget));
        }
        Result->SetObjectField(TEXT("preferred_target"), PreferredTarget);
        return Result;
    }

    TArray<TSharedPtr<FJsonValue>> ModsJson(UWorld* World, int32& Count)
    {
        TArray<TSharedPtr<FJsonValue>> Result;
        Count = 0;
        if (!IsValid(World) || !IsValid(World->GetGameInstance()))
        {
            return Result;
        }

        UModLoadingLibrary* Library = World->GetGameInstance()->GetSubsystem<UModLoadingLibrary>();
        if (!IsValid(Library))
        {
            return Result;
        }

        for (const FModInfo& Mod : Library->GetLoadedMods())
        {
            const TSharedRef<FJsonObject> Entry = MakeShared<FJsonObject>();
            Entry->SetStringField(TEXT("reference"), Mod.Name);
            Entry->SetStringField(TEXT("friendly_name"), Mod.FriendlyName);
            Entry->SetStringField(TEXT("version"), Mod.Version.ToString());
            Entry->SetBoolField(TEXT("required_on_remote"), Mod.bRequiredOnRemote);
            Result.Add(MakeShared<FJsonValueObject>(Entry));
            ++Count;
        }
        return Result;
    }

    TSharedRef<FJsonObject> ContentJson(UWorld* World, int32& ItemCount, int32& RecipeCount)
    {
        const TSharedRef<FJsonObject> Content = MakeShared<FJsonObject>();
        TArray<TSharedPtr<FJsonValue>> Items;
        TArray<TSharedPtr<FJsonValue>> Recipes;
        ItemCount = 0;
        RecipeCount = 0;
        int32 AvailableItemCount = 0;
        int32 UnavailableItemCount = 0;
        int32 AvailableRecipeCount = 0;
        int32 UnavailableRecipeCount = 0;
        AFGRecipeManager* RecipeManager =
            IsValid(World) ? AFGRecipeManager::Get(World) : nullptr;
        Content->SetBoolField(TEXT("availability_known"), IsValid(RecipeManager));
        Content->SetStringField(
            TEXT("availability_source"),
            IsValid(RecipeManager)
                ? TEXT("AFGRecipeManager runtime state")
                : TEXT("unavailable: recipe manager was not initialized"));

        UModContentRegistry* Registry = UModContentRegistry::Get(World);
        if (!IsValid(Registry))
        {
            Content->SetArrayField(TEXT("items"), Items);
            Content->SetArrayField(TEXT("recipes"), Recipes);
            Content->SetNumberField(TEXT("available_item_count"), AvailableItemCount);
            Content->SetNumberField(TEXT("unavailable_item_count"), UnavailableItemCount);
            Content->SetNumberField(TEXT("available_recipe_count"), AvailableRecipeCount);
            Content->SetNumberField(TEXT("unavailable_recipe_count"), UnavailableRecipeCount);
            return Content;
        }

        for (const FGameObjectRegistration& Registration : Registry->GetLoadedItemDescriptors())
        {
            UClass* ItemClassObject = Cast<UClass>(Registration.RegisteredObject);
            if (!IsValid(ItemClassObject) || !ItemClassObject->IsChildOf(UFGItemDescriptor::StaticClass()))
            {
                continue;
            }
            const TSubclassOf<UFGItemDescriptor> ItemClass(ItemClassObject);
            const TSharedRef<FJsonObject> Entry = MakeShared<FJsonObject>();
            Entry->SetStringField(TEXT("class_path"), ItemClassObject->GetPathName());
            Entry->SetStringField(TEXT("name"), UFGItemDescriptor::GetItemName(ItemClass).ToString());
            Entry->SetStringField(TEXT("description"), UFGItemDescriptor::GetItemDescription(ItemClass).ToString());
            Entry->SetStringField(TEXT("owner_mod"), Registration.OwnedByModReference.ToString());
            Entry->SetStringField(TEXT("registrar_mod"), Registration.RegistrarModReference.ToString());
            Entry->SetStringField(TEXT("form"), StaticEnum<EResourceForm>()->GetNameStringByValue(
                static_cast<int64>(UFGItemDescriptor::GetForm(ItemClass))));
            Entry->SetNumberField(TEXT("stack_size"), UFGItemDescriptor::GetStackSize(ItemClass));
            Entry->SetNumberField(TEXT("registration_flags"), static_cast<uint8>(Registration.Flags));
            if (IsValid(RecipeManager))
            {
                const bool bAvailable = RecipeManager->IsItemDescriptorAvailable(ItemClass);
                Entry->SetBoolField(TEXT("available"), bAvailable);
                bAvailable ? ++AvailableItemCount : ++UnavailableItemCount;
            }
            Items.Add(MakeShared<FJsonValueObject>(Entry));
            ++ItemCount;
        }

        for (const FGameObjectRegistration& Registration : Registry->GetRegisteredRecipes())
        {
            UClass* RecipeClassObject = Cast<UClass>(Registration.RegisteredObject);
            if (!IsValid(RecipeClassObject) || !RecipeClassObject->IsChildOf(UFGRecipe::StaticClass()))
            {
                continue;
            }
            const TSubclassOf<UFGRecipe> RecipeClass(RecipeClassObject);
            const TSharedRef<FJsonObject> Entry = MakeShared<FJsonObject>();
            Entry->SetStringField(TEXT("class_path"), RecipeClassObject->GetPathName());
            Entry->SetStringField(TEXT("name"), UFGRecipe::GetRecipeName(RecipeClass).ToString());
            Entry->SetStringField(TEXT("owner_mod"), Registration.OwnedByModReference.ToString());
            Entry->SetStringField(TEXT("registrar_mod"), Registration.RegistrarModReference.ToString());
            Entry->SetNumberField(TEXT("duration_seconds"), UFGRecipe::GetManufacturingDuration(RecipeClass));
            Entry->SetNumberField(TEXT("registration_flags"), static_cast<uint8>(Registration.Flags));
            if (IsValid(RecipeManager))
            {
                const bool bAvailable = RecipeManager->IsRecipeAvailable(RecipeClass);
                Entry->SetBoolField(TEXT("available"), bAvailable);
                bAvailable ? ++AvailableRecipeCount : ++UnavailableRecipeCount;
            }

            TArray<TSharedPtr<FJsonValue>> Ingredients;
            for (const FItemAmount& Ingredient : UFGRecipe::GetIngredients(World, RecipeClass))
            {
                Ingredients.Add(MakeShared<FJsonValueObject>(ItemAmountJson(Ingredient)));
            }
            Entry->SetArrayField(TEXT("ingredients"), Ingredients);

            TArray<TSharedPtr<FJsonValue>> Products;
            for (const FItemAmount& Product : UFGRecipe::GetProducts(RecipeClass))
            {
                Products.Add(MakeShared<FJsonValueObject>(ItemAmountJson(Product)));
            }
            Entry->SetArrayField(TEXT("products"), Products);

            TArray<TSharedPtr<FJsonValue>> Producers;
            for (const TSubclassOf<UObject>& Producer : UFGRecipe::GetProducedIn(RecipeClass))
            {
                Producers.Add(MakeShared<FJsonValueString>(ClassPath(Producer.Get())));
            }
            Entry->SetArrayField(TEXT("produced_in"), Producers);
            Recipes.Add(MakeShared<FJsonValueObject>(Entry));
            ++RecipeCount;
        }

        Content->SetArrayField(TEXT("items"), Items);
        Content->SetArrayField(TEXT("recipes"), Recipes);
        Content->SetNumberField(TEXT("available_item_count"), AvailableItemCount);
        Content->SetNumberField(TEXT("unavailable_item_count"), UnavailableItemCount);
        Content->SetNumberField(TEXT("available_recipe_count"), AvailableRecipeCount);
        Content->SetNumberField(TEXT("unavailable_recipe_count"), UnavailableRecipeCount);
        return Content;
    }

    TSharedRef<FJsonObject> ProgressionJson(
        UWorld* World,
        AFGPlayerController* PlayerController)
    {
        const TSharedRef<FJsonObject> Progression = MakeShared<FJsonObject>();
        TArray<TSharedPtr<FJsonValue>> Purchased;
        if (!IsValid(World))
        {
            Progression->SetArrayField(TEXT("purchased_schematics"), Purchased);
            const TSharedRef<FJsonObject> Unavailable = MakeShared<FJsonObject>();
            Unavailable->SetBoolField(TEXT("available"), false);
            Progression->SetObjectField(TEXT("onboarding"), Unavailable);
            return Progression;
        }

        AFGSchematicManager* SchematicManager = AFGSchematicManager::Get(World);
        if (IsValid(SchematicManager))
        {
            Progression->SetNumberField(
                TEXT("highest_available_tech_tier"),
                SchematicManager->GetHighestAvailableTechTier());
            TArray<TSubclassOf<UFGSchematic>> Schematics;
            SchematicManager->GetAllPurchasedSchematics(Schematics);
            for (const TSubclassOf<UFGSchematic>& Schematic : Schematics)
            {
                const TSharedRef<FJsonObject> Entry = MakeShared<FJsonObject>();
                Entry->SetStringField(TEXT("class_path"), ClassPath(Schematic.Get()));
                Entry->SetStringField(
                    TEXT("name"),
                    Schematic ? UFGSchematic::GetSchematicDisplayName(Schematic).ToString() : TEXT(""));
                Entry->SetStringField(TEXT("owner_mod"), OwnerModForObject(Schematic.Get()));
                if (Schematic)
                {
                    Entry->SetNumberField(TEXT("tech_tier"), UFGSchematic::GetTechTier(Schematic));
                    Entry->SetStringField(
                        TEXT("type"),
                        StaticEnum<ESchematicType>()->GetNameStringByValue(
                            static_cast<int64>(UFGSchematic::GetType(Schematic))));
                }
                Purchased.Add(MakeShared<FJsonValueObject>(Entry));
            }

            Progression->SetObjectField(
                TEXT("active_schematic"),
                SchematicJson(World, SchematicManager, SchematicManager->GetActiveSchematic()));
            Progression->SetObjectField(
                TEXT("last_active_schematic"),
                SchematicJson(World, SchematicManager, SchematicManager->GetLastActiveSchematic()));
        }
        Progression->SetArrayField(TEXT("purchased_schematics"), Purchased);

        const TSharedRef<FJsonObject> Onboarding = MakeShared<FJsonObject>();
        AFGTutorialIntroManager* TutorialManager = AFGTutorialIntroManager::Get(World);
        Onboarding->SetBoolField(TEXT("available"), IsValid(TutorialManager));
        if (IsValid(TutorialManager))
        {
            const EIntroTutorialSteps TutorialStep = TutorialManager->GetCurrentTutorialStep();
            Onboarding->SetBoolField(
                TEXT("intro_sequence_completed"),
                TutorialManager->GetIsIntroSequenceDone());
            Onboarding->SetBoolField(
                TEXT("tutorial_completed"),
                TutorialManager->GetIsTutorialCompleted());
            Onboarding->SetBoolField(
                TEXT("trading_post_built"),
                TutorialManager->HasTradingpostBeenBuilt());
            Onboarding->SetNumberField(
                TEXT("trading_post_level"),
                TutorialManager->GetTradingPostLevel());
            Onboarding->SetStringField(
                TEXT("legacy_step"),
                StaticEnum<EIntroTutorialSteps>()->GetNameStringByValue(
                    static_cast<int64>(TutorialStep)));
            Onboarding->SetStringField(
                TEXT("legacy_step_display_name"),
                StaticEnum<EIntroTutorialSteps>()->GetDisplayNameTextByValue(
                    static_cast<int64>(TutorialStep)).ToString());

            UFGOnboardingStep* CurrentStep = TutorialManager->GetCurrentOnboardingStep();
            const TSharedRef<FJsonObject> Step = MakeShared<FJsonObject>();
            Step->SetBoolField(TEXT("available"), IsValid(CurrentStep));
            if (IsValid(CurrentStep))
            {
                Step->SetStringField(TEXT("asset_path"), CurrentStep->GetPathName());
                Step->SetStringField(TEXT("class_path"), CurrentStep->GetClass()->GetPathName());
                Step->SetStringField(TEXT("owner_mod"), OwnerModForObject(CurrentStep));
                Step->SetStringField(TEXT("title"), CurrentStep->Title.ToString());
                Step->SetArrayField(TEXT("objectives"), TextArrayJson(CurrentStep->Objectives));
                Step->SetArrayField(
                    TEXT("objectives_gamepad"),
                    TextArrayJson(CurrentStep->ObjectivesGamepad));
                Step->SetArrayField(TEXT("hints"), TextArrayJson(CurrentStep->Hints));
                Step->SetArrayField(TEXT("hints_gamepad"), TextArrayJson(CurrentStep->HintsGamepad));
                Step->SetNumberField(TEXT("index"), CurrentStep->mIndex);
                Step->SetNumberField(TEXT("priority"), CurrentStep->mPriority);
                Step->SetBoolField(
                    TEXT("excluded_from_onboarding"),
                    CurrentStep->mExcludeFromOnboarding);
            }
            Onboarding->SetObjectField(TEXT("current_step"), Step);
        }
        Progression->SetObjectField(TEXT("onboarding"), Onboarding);

        const TSharedRef<FJsonObject> GamePhase = MakeShared<FJsonObject>();
        AFGGamePhaseManager* GamePhaseManager = AFGGamePhaseManager::Get(World);
        GamePhase->SetBoolField(TEXT("available"), IsValid(GamePhaseManager));
        if (IsValid(GamePhaseManager))
        {
            GamePhase->SetObjectField(
                TEXT("current"),
                GamePhaseJson(GamePhaseManager->GetCurrentGamePhase()));
            GamePhase->SetObjectField(
                TEXT("target"),
                GamePhaseJson(GamePhaseManager->GetTargetGamePhase()));
            GamePhase->SetBoolField(
                TEXT("ready_for_next_phase"),
                GamePhaseManager->ReadyToGoToNextGamePhase());
            GamePhase->SetBoolField(
                TEXT("last_phase_reached"),
                GamePhaseManager->IsLastGamePhaseReached());

            TArray<FRemainingPhaseCost> RemainingCosts;
            GamePhaseManager->GetRemainingPhaseCosts(RemainingCosts);
            TArray<TSharedPtr<FJsonValue>> RemainingJson;
            for (const FRemainingPhaseCost& Remaining : RemainingCosts)
            {
                const TSharedRef<FJsonObject> Entry = MakeShared<FJsonObject>();
                Entry->SetStringField(TEXT("item_class"), ClassPath(Remaining.ItemClass.Get()));
                Entry->SetStringField(
                    TEXT("item_name"),
                    Remaining.ItemClass
                        ? UFGItemDescriptor::GetItemName(Remaining.ItemClass).ToString()
                        : TEXT(""));
                Entry->SetNumberField(TEXT("total"), Remaining.TotalCost);
                Entry->SetNumberField(TEXT("remaining"), Remaining.RemainingCost);
                Entry->SetNumberField(
                    TEXT("paid"),
                    FMath::Max(0, Remaining.TotalCost - Remaining.RemainingCost));
                RemainingJson.Add(MakeShared<FJsonValueObject>(Entry));
            }
            GamePhase->SetArrayField(TEXT("remaining_costs"), RemainingJson);
        }
        Progression->SetObjectField(TEXT("game_phase"), GamePhase);

        const TSharedRef<FJsonObject> Todo = MakeShared<FJsonObject>();
        AFGPlayerState* PlayerState = IsValid(PlayerController)
            ? PlayerController->GetPlayerState<AFGPlayerState>()
            : nullptr;
        Todo->SetBoolField(TEXT("available"), IsValid(PlayerState));
        if (IsValid(PlayerState))
        {
            Todo->SetStringField(TEXT("public"), PlayerState->GetPublicTodoList());
            Todo->SetStringField(TEXT("private"), PlayerState->GetPrivateTodoList());
        }
        Progression->SetObjectField(TEXT("todo_lists"), Todo);
        return Progression;
    }
}

FAIFactorySnapshotResult FAIFactorySnapshot::Build(
    UWorld* World,
    const FAIFactorySnapshotRequest& Request,
    const FAIFactorySettings& Settings,
    const uint64 WorldRevision)
{
    const double CaptureStartSeconds = FPlatformTime::Seconds();
    const FString CaptureStartedAtUtc = FDateTime::UtcNow().ToIso8601();
    FAIFactorySnapshotResult Result;
    const TSharedRef<FJsonObject> Root = MakeShared<FJsonObject>();
    Root->SetStringField(TEXT("schema"), TEXT("aifactory.snapshot"));
    Root->SetNumberField(TEXT("schema_version"), 1);
    Root->SetStringField(TEXT("generated_at_utc"), CaptureStartedAtUtc);
    Root->SetStringField(TEXT("capture_started_at_utc"), CaptureStartedAtUtc);
    Root->SetStringField(TEXT("data_policy"), TEXT("authoritative_or_explicitly_unknown"));
    Root->SetNumberField(TEXT("world_revision"), static_cast<double>(WorldRevision));

    const TSharedRef<FJsonObject> Units = MakeShared<FJsonObject>();
    Units->SetStringField(TEXT("positions_and_extents"), TEXT("unreal_centimeters"));
    Units->SetStringField(TEXT("velocities"), TEXT("unreal_centimeters_per_second"));
    Units->SetStringField(TEXT("rotations"), TEXT("degrees"));
    Units->SetStringField(TEXT("explicit_distance_meters_fields"), TEXT("meters"));
    Root->SetObjectField(TEXT("units"), Units);

    const TSharedRef<FJsonObject> WorldInfo = MakeShared<FJsonObject>();
    WorldInfo->SetStringField(TEXT("map"), IsValid(World) ? World->GetMapName() : TEXT(""));
    WorldInfo->SetStringField(TEXT("net_mode"), IsValid(World)
        ? NetModeName(World->GetNetMode())
        : TEXT(""));
    if (IsValid(World))
    {
        if (const AFGGameState* GameState = World->GetGameState<AFGGameState>())
        {
            WorldInfo->SetStringField(TEXT("session_name"), GameState->GetSessionName());
        }
    }
    WorldInfo->SetObjectField(TEXT("scan_center"), VectorJson(Request.Center));
    WorldInfo->SetNumberField(TEXT("scan_radius_meters"), Request.bUseRadius ? Request.RadiusMeters : -1.0);
    Root->SetObjectField(TEXT("world"), WorldInfo);

    FTerrainProbeBudget TerrainBudget;
    if (Settings.bIncludeTerrain)
    {
        TerrainBudget.Remaining = Settings.MaxTerrainProbes;
        TerrainBudget.Center = Request.Center;
        TerrainBudget.RadiusSquaredCm = Settings.TerrainProbeRadiusMeters < 0.0f
            ? -1.0
            : FMath::Square(static_cast<double>(Settings.TerrainProbeRadiusMeters) * 100.0);

        // The ground the player is standing on, always measured.
        const FAIFactorySiteTerrain Here = FAIFactoryTerrain::ProbeSite(
            World,
            Request.Center,
            Settings.TerrainFootprintMeters,
            Settings.TerrainResolution);
        const TSharedRef<FJsonObject> TerrainRoot = MakeShared<FJsonObject>();
        TerrainRoot->SetObjectField(TEXT("at_scan_center"), SiteTerrainJson(Here));
        TerrainRoot->SetNumberField(TEXT("probe_budget"), Settings.MaxTerrainProbes);
        TerrainRoot->SetNumberField(TEXT("probe_footprint_meters"), Settings.TerrainFootprintMeters);
        TerrainRoot->SetNumberField(TEXT("probe_resolution"), Settings.TerrainResolution);
        TerrainRoot->SetNumberField(TEXT("probe_radius_meters"), Settings.TerrainProbeRadiusMeters);
        TerrainRoot->SetStringField(TEXT("coverage"),
            TEXT("Unoccupied resource nodes inside the probe radius carry their own measured terrain; "
                 "nodes beyond it are unmeasured, not flat."));
        Root->SetObjectField(TEXT("terrain"), TerrainRoot);
    }
    Root->SetObjectField(TEXT("interaction_context"), InteractionContextJson(World, Request, Settings, TerrainBudget));

    Root->SetArrayField(TEXT("mods"), ModsJson(World, Result.ModCount));
    if (Request.bIncludeContentCatalog)
    {
        Root->SetObjectField(TEXT("content"), ContentJson(World, Result.ItemCount, Result.RecipeCount));
    }
    Root->SetObjectField(TEXT("progression"), ProgressionJson(World, Request.PlayerController));

    TArray<TSharedPtr<FJsonValue>> Actors;
    if (IsValid(World))
    {
        const double RadiusSquaredCm = FMath::Square(static_cast<double>(Request.RadiusMeters) * 100.0);

        for (TActorIterator<AFGBuildable> It(World); It; ++It)
        {
            AFGBuildable* Buildable = *It;
            if (!IsValid(Buildable))
            {
                continue;
            }
            if (Request.bUseRadius && FVector::DistSquared(Buildable->GetActorLocation(), Request.Center) > RadiusSquaredCm)
            {
                continue;
            }
            if (Actors.Num() >= Settings.MaxActorsPerSnapshot)
            {
                Result.bActorLimitReached = true;
                break;
            }
            Actors.Add(MakeShared<FJsonValueObject>(BuildableJson(Buildable, Settings)));
            ++Result.ActorCount;
            ++Result.BuildableCount;
        }

        if (!Result.bActorLimitReached)
        {
            for (TActorIterator<AFGResourceNodeBase> It(World); It; ++It)
            {
                AFGResourceNodeBase* Node = *It;
                if (!IsValid(Node))
                {
                    continue;
                }
                if (Request.bUseRadius && FVector::DistSquared(Node->GetActorLocation(), Request.Center) > RadiusSquaredCm)
                {
                    continue;
                }
                if (Actors.Num() >= Settings.MaxActorsPerSnapshot)
                {
                    Result.bActorLimitReached = true;
                    break;
                }
                Actors.Add(MakeShared<FJsonValueObject>(ResourceNodeJson(Node, Settings, World, TerrainBudget)));
                ++Result.ActorCount;
                ++Result.ResourceNodeCount;
            }
        }

        if (!Result.bActorLimitReached)
        {
            for (TActorIterator<AActor> It(World); It; ++It)
            {
                AActor* Actor = *It;
                if (!IsValid(Actor) ||
                    Actor->IsA<AFGBuildable>() ||
                    Actor->IsA<AFGResourceNodeBase>())
                {
                    continue;
                }

                FString Kind = KindForActor(Actor);
                if (Kind == TEXT("world_actor"))
                {
                    if (!IsPotentialModActor(Actor))
                    {
                        continue;
                    }
                    Kind = TEXT("mod_actor");
                }

                if (Request.bUseRadius && FVector::DistSquared(Actor->GetActorLocation(), Request.Center) > RadiusSquaredCm)
                {
                    continue;
                }
                if (Actors.Num() >= Settings.MaxActorsPerSnapshot)
                {
                    Result.bActorLimitReached = true;
                    break;
                }

                Actors.Add(MakeShared<FJsonValueObject>(GenericActorJson(Actor, Kind, Settings)));
                ++Result.ActorCount;
                if (Kind == TEXT("player")) ++Result.PlayerCount;
                else if (Kind == TEXT("vehicle")) ++Result.VehicleCount;
                else if (Kind == TEXT("item_pickup")) ++Result.PickupCount;
                else if (Kind == TEXT("adapter_actor")) ++Result.AdapterActorCount;
            }
        }
    }
    Root->SetArrayField(TEXT("actors"), Actors);

    const TSharedRef<FJsonObject> Completeness = MakeShared<FJsonObject>();
    Completeness->SetBoolField(TEXT("actor_limit_reached"), Result.bActorLimitReached);
    Completeness->SetNumberField(TEXT("actor_limit"), Settings.MaxActorsPerSnapshot);
    Completeness->SetStringField(TEXT("unknown_policy"),
        TEXT("Unknown custom behavior is never inferred; an explicit adapter is required."));
    Root->SetObjectField(TEXT("completeness"), Completeness);
    Root->SetStringField(TEXT("capture_completed_at_utc"), FDateTime::UtcNow().ToIso8601());
    Root->SetNumberField(
        TEXT("capture_duration_ms"),
        (FPlatformTime::Seconds() - CaptureStartSeconds) * 1000.0);

    const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Result.Json);
    FJsonSerializer::Serialize(Root, Writer);
    return Result;
}

uint32 FAIFactorySnapshot::ComputeWorldFingerprint(UWorld* World)
{
    if (!IsValid(World))
    {
        return 0;
    }

    uint32 Hash = 0;
    for (TActorIterator<AFGBuildable> It(World); It; ++It)
    {
        AFGBuildable* Buildable = *It;
        if (!IsValid(Buildable))
        {
            continue;
        }

        Hash = HashCombineFast(Hash, GetTypeHash(Buildable->GetPathName()));
        Hash = HashCombineFast(Hash, GetTypeHash(Buildable->GetActorTransform().ToHumanReadableString()));
        Hash = HashCombineFast(Hash, GetTypeHash(ClassPath(Buildable->GetBuiltWithRecipe().Get())));

        if (const AFGBuildableFactory* Factory = Cast<AFGBuildableFactory>(Buildable))
        {
            Hash = HashCombineFast(Hash, GetTypeHash(Factory->IsProducing()));
            Hash = HashCombineFast(Hash, GetTypeHash(Factory->GetCurrentPotential()));
        }
        if (const AFGBuildableManufacturer* Manufacturer = Cast<AFGBuildableManufacturer>(Buildable))
        {
            Hash = HashCombineFast(Hash, GetTypeHash(ClassPath(Manufacturer->GetCurrentRecipe().Get())));
        }

    }
    return Hash;
}
