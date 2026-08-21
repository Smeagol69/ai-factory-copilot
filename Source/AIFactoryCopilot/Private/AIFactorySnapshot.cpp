#include "AIFactorySnapshot.h"
#include "FGLightweightBuildableSubsystem.h"

#include "AIFactoryCopilotModule.h"
#include "AIFactoryDataProvider.h"
#include "AIFactorySettings.h"
#include "AIFactoryTerrain.h"
#include "Blueprint/UserWidget.h"
#include "Blueprint/WidgetBlueprintLibrary.h"
#include "Blueprint/WidgetTree.h"
#include "Buildables/FGBuildable.h"
#include "Buildables/FGBuildableConveyorBase.h"
#include "Buildables/FGBuildableFactory.h"
#include "Buildables/FGBuildableManufacturer.h"
#include "Buildables/FGBuildablePipeline.h"
#include "Buildables/FGBuildableGenerator.h"
#include "Buildables/FGBuildableGeneratorFuel.h"
#include "Buildables/FGBuildableResourceExtractor.h"
#include "Camera/PlayerCameraManager.h"
#include "Components/PanelWidget.h"
#include "Components/PrimitiveComponent.h"
#include "Components/RichTextBlock.h"
#include "Components/TextBlock.h"
#include "Components/Widget.h"
#include "Dom/JsonObject.h"
#include "Engine/HitResult.h"
#include "Engine/World.h"
#include "EngineUtils.h"
#include "FGFactoryConnectionComponent.h"
#include "FGCharacterPlayer.h"
#include "Equipment/FGBuildGun.h"
#include "Equipment/FGBuildGunDismantle.h"
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
#include "Resources/FGBuildingDescriptor.h"
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

    /**
     * What a building does, read off its class rather than a placed example.
     *
     * The build menu shows "75 MW" for a Coal-Powered Generator the player has
     * never built. The snapshot did not: it sent the recipe's cost and name and
     * nothing about the building itself, so asked to plan a coal plant the
     * copilot could not work out how many generators one node feeds and had to
     * ask. The owner's objection was exact -- it knows the node purity and the
     * tech tier, so it should already know.
     *
     * These come from the class default object, so nothing has to exist to be
     * measured. That is the case that matters: a player switching to coal power
     * has no coal generator yet, which is precisely when they ask.
     *
     * Nothing here is coal-specific, and no rate is written down. Power is MJ/s
     * and a fuel item is worth MJ, so the burn rate is the game's own
     * relationship -- which keeps it right for the modded generators this save
     * has, where a table copied from a wiki would be wrong.
     *
     * Returns nothing for a building with no stats worth reporting, so absent
     * stays absent rather than becoming a zero the solvers would treat as fact.
     */
    TSharedPtr<FJsonObject> BuildingStatsJson(const TSubclassOf<UFGItemDescriptor>& ProductClass)
    {
        if (!ProductClass)
        {
            return nullptr;
        }
        // Most recipe products are items, not buildings. Iron Plate has no
        // buildable class, and asking for one must be a decline rather than a
        // bad cast, so the descendancy is checked before the conversion.
        if (!ProductClass->IsChildOf(UFGBuildingDescriptor::StaticClass()))
        {
            return nullptr;
        }
        const TSubclassOf<UFGBuildingDescriptor> BuildingDescriptor(*ProductClass);
        if (!BuildingDescriptor)
        {
            return nullptr;
        }
        const TSubclassOf<AFGBuildable> BuildableClass =
            UFGBuildingDescriptor::GetBuildableClass(BuildingDescriptor);
        if (!BuildableClass)
        {
            return nullptr;
        }

        const TSharedPtr<FJsonObject> Stats = MakeShared<FJsonObject>();
        bool bAnything = false;

        if (const AFGBuildableGenerator* Generator =
                Cast<AFGBuildableGenerator>(BuildableClass->GetDefaultObject()))
        {
            const float PowerMw = Generator->GetDefaultPowerProductionCapacity();
            if (FMath::IsFinite(PowerMw) && PowerMw > 0.0f)
            {
                Stats->SetNumberField(TEXT("power_production_mw"), PowerMw);
                bAnything = true;
            }

            if (const AFGBuildableGeneratorFuel* FuelGenerator =
                    Cast<AFGBuildableGeneratorFuel>(Generator))
            {
                // Water, for a coal generator. Reported as the flag and the
                // resource so the reply can name it instead of warning vaguely.
                const bool bSupplemental = FuelGenerator->GetRequiresSupplementalResource();
                Stats->SetBoolField(TEXT("requires_supplemental_resource"), bSupplemental);
                if (bSupplemental)
                {
                    Stats->SetStringField(TEXT("supplemental_resource_class"),
                        ClassPath(FuelGenerator->GetSupplementalResourceClass().Get()));
                }
                bAnything = true;

                TArray<TSharedPtr<FJsonValue>> Fuels;
                for (const TSoftClassPtr<UFGItemDescriptor>& SoftFuel :
                     FuelGenerator->GetDefaultFuelClasses())
                {
                    const TSubclassOf<UFGItemDescriptor> FuelClass(SoftFuel.LoadSynchronous());
                    if (!FuelClass)
                    {
                        continue;
                    }
                    const TSharedRef<FJsonObject> Fuel = MakeShared<FJsonObject>();
                    Fuel->SetStringField(TEXT("item_class"), ClassPath(FuelClass.Get()));
                    Fuel->SetStringField(TEXT("item_name"),
                        UFGItemDescriptor::GetItemName(FuelClass).ToString());

                    // MJ per item. The burn rate is power / this * 60, and the
                    // division is left to the solvers so an unusable energy
                    // value stays visibly unusable instead of dividing by zero.
                    const float EnergyMj = UFGItemDescriptor::GetEnergyValue(FuelClass);
                    if (FMath::IsFinite(EnergyMj) && EnergyMj > 0.0f)
                    {
                        Fuel->SetNumberField(TEXT("energy_mj_per_item"), EnergyMj);
                        if (FMath::IsFinite(PowerMw) && PowerMw > 0.0f)
                        {
                            Fuel->SetNumberField(TEXT("items_per_minute_at_full_load"),
                                PowerMw / EnergyMj * 60.0f);
                        }
                    }
                    Fuels.Add(MakeShared<FJsonValueObject>(Fuel));
                }
                if (Fuels.Num() > 0)
                {
                    Stats->SetArrayField(TEXT("fuels"), Fuels);
                }
            }
        }

        if (const AFGBuildableResourceExtractor* Extractor =
                Cast<AFGBuildableResourceExtractor>(BuildableClass->GetDefaultObject()))
        {
            // A water pump, oil pump, fracking extractor, and solid miner all
            // derive from AFGBuildableResourceExtractor. Their raw cycle
            // amounts are not interchangeable (fluids use inventory units),
            // so the companion must be able to select the correct family
            // before comparing rates. This public engine discriminator also
            // keeps modded miner tiers working without relying on their names.
            Stats->SetStringField(TEXT("extractor_type_name"),
                Extractor->GetExtractorTypeName().ToString());
            bAnything = true;

            const int32 PerCycle = Extractor->GetNumExtractedItemsPerCycle();
            const float CycleSeconds = Extractor->GetDefaultExtractCycleTime();
            if (PerCycle > 0 && FMath::IsFinite(CycleSeconds) && CycleSeconds > 0.0f)
            {
                Stats->SetNumberField(TEXT("extracted_items_per_cycle"), PerCycle);
                Stats->SetNumberField(TEXT("extract_cycle_seconds"), CycleSeconds);
                // At 100% and before node purity, which the solvers apply from
                // the purity already captured on the node itself.
                Stats->SetNumberField(TEXT("items_per_minute_at_normal_purity"),
                    static_cast<float>(PerCycle) / CycleSeconds * 60.0f);
                bAnything = true;
            }
        }

        // Spelled out rather than a ternary: TSharedRef and nullptr have no
        // common type, so `bAnything ? Stats : nullptr` does not compile.
        if (!bAnything)
        {
            return nullptr;
        }
        return Stats;
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

    FString SlateVisibilityName(const ESlateVisibility Visibility)
    {
        switch (Visibility)
        {
        case ESlateVisibility::Visible:
            return TEXT("visible");
        case ESlateVisibility::Collapsed:
            return TEXT("collapsed");
        case ESlateVisibility::Hidden:
            return TEXT("hidden");
        case ESlateVisibility::HitTestInvisible:
            return TEXT("hit_test_invisible");
        case ESlateVisibility::SelfHitTestInvisible:
            return TEXT("self_hit_test_invisible");
        default:
            return TEXT("unknown");
        }
    }

    bool TryGetRenderedWidgetText(
        const UWidget* Widget,
        FString& OutText,
        FString& OutSource)
    {
        if (const UTextBlock* TextBlock = Cast<UTextBlock>(Widget))
        {
            OutText = TextBlock->GetText().ToString();
            OutSource = TEXT("UTextBlock::GetText");
            return true;
        }
        if (const URichTextBlock* RichTextBlock = Cast<URichTextBlock>(Widget))
        {
            OutText = RichTextBlock->GetText().ToString();
            OutSource = TEXT("URichTextBlock::GetText");
            return true;
        }
        return false;
    }

    bool IsWidgetBranchRendered(const UWidget* Widget)
    {
        for (const UWidget* Current = Widget;
             IsValid(Current);
             Current = Current->GetParent())
        {
            if (!Current->IsRendered())
            {
                return false;
            }
        }
        return true;
    }

    TSharedRef<FJsonObject> VisibleUiJson(UWorld* World, const bool bEnabled)
    {
        constexpr int32 MaxEntries = 512;
        constexpr int32 MaxCharacters = 32768;
        constexpr int32 MaxCharactersPerEntry = 4096;

        const TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
        TArray<TSharedPtr<FJsonValue>> RenderedText;
        const bool bAvailable =
            bEnabled &&
            IsValid(World) &&
            World->GetNetMode() != NM_DedicatedServer;
        Result->SetBoolField(TEXT("enabled"), bEnabled);
        Result->SetBoolField(TEXT("available"), bAvailable);
        Result->SetStringField(
            TEXT("source"),
            TEXT("active local viewport's rendered Unreal UMG widget trees; no screenshot or OCR"));
        Result->SetStringField(TEXT("certainty"), TEXT("authoritative_at_capture_time"));
        Result->SetNumberField(TEXT("entry_limit"), MaxEntries);
        Result->SetNumberField(TEXT("character_limit"), MaxCharacters);
        if (!bAvailable)
        {
            Result->SetStringField(
                TEXT("unavailable_reason"),
                !bEnabled
                    ? TEXT("disabled_by_config_to_avoid_exporting_rendered_text")
                    : TEXT("no_local_viewport"));
            Result->SetArrayField(TEXT("rendered_text"), RenderedText);
            Result->SetNumberField(TEXT("top_level_user_widget_count"), 0);
            Result->SetNumberField(TEXT("user_widget_count"), 0);
            Result->SetNumberField(TEXT("rendered_text_count"), 0);
            Result->SetNumberField(TEXT("captured_text_count"), 0);
            Result->SetBoolField(TEXT("truncated"), false);
            return Result;
        }

        TArray<UUserWidget*> TopLevelUserWidgets;
        UWidgetBlueprintLibrary::GetAllWidgetsOfClass(
            World,
            TopLevelUserWidgets,
            UUserWidget::StaticClass(),
            true);

        struct FPendingUserWidget
        {
            const UUserWidget* Widget = nullptr;
            bool bAncestorsRendered = false;
        };
        TArray<FPendingUserWidget> PendingUserWidgets;
        for (const UUserWidget* TopLevel : TopLevelUserWidgets)
        {
            PendingUserWidgets.Add({ TopLevel, true });
        }

        TSet<const UUserWidget*> SeenUserWidgets;
        TSet<const UWidget*> SeenWidgets;
        int32 UserWidgetCount = 0;
        int32 RenderedTextCount = 0;
        int32 CapturedCharacters = 0;
        bool bTruncated = false;
        while (!PendingUserWidgets.IsEmpty())
        {
            const FPendingUserWidget Pending = PendingUserWidgets.Pop();
            const UUserWidget* UserWidget = Pending.Widget;
            if (!IsValid(UserWidget) ||
                SeenUserWidgets.Contains(UserWidget) ||
                UserWidget->GetWorld() != World ||
                !IsValid(UserWidget->WidgetTree))
            {
                continue;
            }
            SeenUserWidgets.Add(UserWidget);
            ++UserWidgetCount;
            const bool bUserWidgetRendered =
                Pending.bAncestorsRendered &&
                UserWidget->IsRendered();

            TArray<UWidget*> Widgets;
            UserWidget->WidgetTree->GetAllWidgets(Widgets);
            for (const UWidget* Widget : Widgets)
            {
                if (!IsValid(Widget))
                {
                    continue;
                }
                if (const UUserWidget* NestedUserWidget = Cast<UUserWidget>(Widget))
                {
                    PendingUserWidgets.Add({
                        NestedUserWidget,
                        bUserWidgetRendered && IsWidgetBranchRendered(NestedUserWidget)
                    });
                }
                if (SeenWidgets.Contains(Widget) ||
                    !bUserWidgetRendered ||
                    !IsWidgetBranchRendered(Widget))
                {
                    continue;
                }
                SeenWidgets.Add(Widget);

                FString Text;
                FString TextSource;
                if (!TryGetRenderedWidgetText(Widget, Text, TextSource) ||
                    Text.TrimStartAndEnd().IsEmpty())
                {
                    continue;
                }
                ++RenderedTextCount;

                const bool bEntryTruncated = Text.Len() > MaxCharactersPerEntry;
                const FString CapturedText = bEntryTruncated
                    ? Text.Left(MaxCharactersPerEntry)
                    : Text;
                if (RenderedText.Num() >= MaxEntries ||
                    CapturedCharacters + CapturedText.Len() > MaxCharacters)
                {
                    bTruncated = true;
                    continue;
                }

                const TSharedRef<FJsonObject> Entry = MakeShared<FJsonObject>();
                Entry->SetStringField(TEXT("text"), CapturedText);
                Entry->SetStringField(TEXT("text_source"), TextSource);
                Entry->SetBoolField(TEXT("text_truncated"), bEntryTruncated);
                Entry->SetStringField(TEXT("widget_name"), Widget->GetName());
                Entry->SetStringField(TEXT("widget_class"), ClassPath(Widget->GetClass()));
                Entry->SetStringField(TEXT("visibility"), SlateVisibilityName(Widget->GetVisibility()));
                Entry->SetStringField(TEXT("user_widget_name"), UserWidget->GetName());
                Entry->SetStringField(
                    TEXT("user_widget_class"),
                    ClassPath(UserWidget->GetClass()));
                Entry->SetStringField(
                    TEXT("owner_mod"),
                    OwnerModForObject(UserWidget->GetClass()));
                if (const UPanelWidget* Parent = Widget->GetParent())
                {
                    Entry->SetStringField(TEXT("parent_name"), Parent->GetName());
                    Entry->SetStringField(TEXT("parent_class"), ClassPath(Parent->GetClass()));
                }
                RenderedText.Add(MakeShared<FJsonValueObject>(Entry));
                CapturedCharacters += CapturedText.Len();
                bTruncated = bTruncated || bEntryTruncated;
            }
        }

        Result->SetArrayField(TEXT("rendered_text"), RenderedText);
        Result->SetNumberField(
            TEXT("top_level_user_widget_count"),
            TopLevelUserWidgets.Num());
        Result->SetNumberField(TEXT("user_widget_count"), UserWidgetCount);
        Result->SetNumberField(TEXT("rendered_text_count"), RenderedTextCount);
        Result->SetNumberField(TEXT("captured_text_count"), RenderedText.Num());
        Result->SetNumberField(TEXT("captured_characters"), CapturedCharacters);
        Result->SetBoolField(TEXT("truncated"), bTruncated);
        Result->SetStringField(
            TEXT("interpretation"),
            TEXT("This is the exact text the local UMG tree rendered. Progression manager fields "
                 "are separate authoritative state; report both if they conflict."));
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
            const FString PropertyName = Property->GetName().ToLower();
            if (PropertyName.Contains(TEXT("password")) ||
                PropertyName.Contains(TEXT("passphrase")) ||
                PropertyName.Contains(TEXT("secret")) ||
                PropertyName.Contains(TEXT("credential")) ||
                PropertyName.Contains(TEXT("authorization")) ||
                PropertyName.Contains(TEXT("bearer")) ||
                PropertyName.EndsWith(TEXT("token")) ||
                PropertyName.Contains(TEXT("authtoken")) ||
                PropertyName.Contains(TEXT("auth_token")) ||
                PropertyName.Contains(TEXT("accesstoken")) ||
                PropertyName.Contains(TEXT("access_token")) ||
                PropertyName.Contains(TEXT("refreshtoken")) ||
                PropertyName.Contains(TEXT("refresh_token")) ||
                PropertyName.Contains(TEXT("apikey")) ||
                PropertyName.Contains(TEXT("api_key")) ||
                PropertyName.Contains(TEXT("privatekey")) ||
                PropertyName.Contains(TEXT("private_key")) ||
                PropertyName.Contains(TEXT("clientsecret")) ||
                PropertyName.Contains(TEXT("client_secret")))
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

    /**
     * One lightweight buildable, in the same shape as BuildableJson.
     *
     * Foundations, walls, pillars, catwalks and roofs are not actors. They are
     * instance data, so TActorIterator cannot reach them and the snapshot has
     * been reporting a base's wiring as though it were the whole base --
     * measured at 11 of 51 classes visible in one building.
     *
     * Compact on purpose: a wall has no inventory, no throughput and no
     * connections, and a large base holds tens of thousands of these. Class,
     * transform, bounds and recipe is what a layout reader actually needs.
     *
     * The id is synthesised as lightweight:<Class>:<Index> because these have
     * no path name -- that pair is how the subsystem itself addresses them.
     * It is stable only within one snapshot: removing an instance shifts every
     * index above it, which is why nothing should persist one of these ids.
     */
    TSharedRef<FJsonObject> LightweightBuildableJson(
        const TSubclassOf<AFGBuildable>& BuildableClass,
        const FRuntimeBuildableInstanceData& Instance,
        int32 Index)
    {
        const TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
        const FString ClassName = IsValid(BuildableClass) ? BuildableClass->GetName() : TEXT("Unknown");
        Result->SetStringField(TEXT("actor_id"),
            FString::Printf(TEXT("lightweight:%s:%d"), *ClassName, Index));
        Result->SetStringField(TEXT("name"), FString::Printf(TEXT("%s_%d"), *ClassName, Index));
        Result->SetStringField(TEXT("class_path"),
            IsValid(BuildableClass) ? BuildableClass->GetPathName() : FString());
        Result->SetStringField(TEXT("owner_mod"), OwnerModForObject(BuildableClass));
        Result->SetStringField(TEXT("kind"), TEXT("lightweight_buildable"));
        Result->SetObjectField(TEXT("location"), VectorJson(Instance.Transform.GetLocation()));
        Result->SetObjectField(TEXT("rotation"), RotatorJson(Instance.Transform.Rotator()));
        Result->SetObjectField(TEXT("scale"), VectorJson(Instance.Transform.GetScale3D()));

        // BoundingBox is local space -- the field says so -- so it is moved onto
        // the instance before being reported, to match BuildableJson's world bounds.
        if (Instance.BoundingBox.IsValid != 0)
        {
            const FBox WorldBounds = Instance.BoundingBox.TransformBy(Instance.Transform);
            const TSharedRef<FJsonObject> Bounds = MakeShared<FJsonObject>();
            Bounds->SetObjectField(TEXT("origin"), VectorJson(WorldBounds.GetCenter()));
            Bounds->SetObjectField(TEXT("extent"), VectorJson(WorldBounds.GetExtent()));
            Result->SetObjectField(TEXT("bounds"), Bounds);
        }

        Result->SetStringField(TEXT("built_with_recipe"), ClassPath(Instance.BuiltWithRecipe.Get()));
        Result->SetBoolField(TEXT("inside_blueprint_designer"), false);
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

        // A modded or partially loaded manufacturer can exist before its
        // replicated current recipe does. FactoryGame implements both cycle
        // accessors by dereferencing that recipe, so asking it for a cycle at
        // this point crashes the save instead of reporting an unknown rate.
        // Capture the recipe once before the generic factory block and only
        // call those recipe-dependent accessors when it is a valid class.
        const AFGBuildableManufacturer* Manufacturer = Cast<AFGBuildableManufacturer>(Buildable);
        const TSubclassOf<UFGRecipe> Recipe =
            Manufacturer ? Manufacturer->GetCurrentRecipe() : nullptr;
        const bool bProductionCycleKnown = !Manufacturer || IsValid(Recipe.Get());

        if (const AFGBuildableFactory* Factory = Cast<AFGBuildableFactory>(Buildable))
        {
            const TSharedRef<FJsonObject> FactoryState = MakeShared<FJsonObject>();
            FactoryState->SetBoolField(TEXT("is_producing"), Factory->IsProducing());
            FactoryState->SetStringField(TEXT("production_status"),
                StaticEnum<EProductionStatus>()->GetNameStringByValue(
                    static_cast<int64>(Factory->GetProductionIndicatorStatus())));
            FactoryState->SetNumberField(TEXT("productivity"), Factory->GetProductivity());
            FactoryState->SetNumberField(TEXT("production_progress"), Factory->GetProductionProgress());
            FactoryState->SetBoolField(TEXT("production_cycle_known"), bProductionCycleKnown);
            if (bProductionCycleKnown)
            {
                FactoryState->SetNumberField(TEXT("production_cycle_seconds"), Factory->GetProductionCycleTime());
                FactoryState->SetNumberField(TEXT("default_production_cycle_seconds"), Factory->GetDefaultProductionCycleTime());
            }
            else
            {
                FactoryState->SetStringField(
                    TEXT("production_cycle_unavailable_reason"),
                    TEXT("manufacturer_has_no_valid_current_recipe"));
            }
            FactoryState->SetNumberField(TEXT("current_potential"), Factory->GetCurrentPotential());
            FactoryState->SetNumberField(TEXT("pending_potential"), Factory->GetPendingPotential());
            FactoryState->SetNumberField(TEXT("max_potential"), Factory->GetMaxPotential());
            FactoryState->SetNumberField(TEXT("current_production_boost"), Factory->GetCurrentProductionBoost());
            FactoryState->SetNumberField(TEXT("pending_production_boost"), Factory->GetPendingProductionBoost());
            FactoryState->SetNumberField(TEXT("producing_power_consumption_mw"), Factory->GetProducingPowerConsumption());
            FactoryState->SetNumberField(TEXT("idle_power_consumption_mw"), Factory->GetIdlePowerConsumption());
            Result->SetObjectField(TEXT("factory"), FactoryState);
        }

        if (Manufacturer)
        {
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
            // GetResourceNode() is deprecated old-save state and is legitimately
            // null on current and modded extractors even while they are mining.
            // The public interface is the authoritative relation used by the
            // game now; keep its actor and descriptor together so a player
            // aiming at an existing extractor can still mean "this node".
            const TScriptInterface<IFGExtractableResourceInterface> Extractable =
                Extractor->GetExtractableResource();
            const AActor* ExtractableActor = Cast<AActor>(Extractable.GetObject());
            const IFGExtractableResourceInterface* ExtractableInterface = Extractable.GetInterface();
            const TSubclassOf<UFGResourceDescriptor> ResourceClass = ExtractableInterface
                ? ExtractableInterface->GetResourceClass()
                : nullptr;
            ExtractorState->SetStringField(
                TEXT("extractable_resource_actor_id"),
                IsValid(ExtractableActor) ? ExtractableActor->GetPathName() : TEXT(""));
            ExtractorState->SetStringField(TEXT("resource_class"), ClassPath(ResourceClass.Get()));
            ExtractorState->SetStringField(
                TEXT("resource_name"),
                ResourceClass ? UFGItemDescriptor::GetItemName(ResourceClass).ToString() : TEXT(""));
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

        // What the player has marked with the dismantle tool.
        //
        // The owner wanted to pick things out by hand and save exactly those,
        // rather than everything inside a radius. The dismantle state is
        // already a multi-selection UI with a highlight, and it exposes what is
        // in it: GetPendingDismantleActors is the set built up with the tool,
        // and GetSelectedActor is the one currently under the crosshair.
        //
        // Reading it changes nothing. Nothing here dismantles; the selection is
        // borrowed as a way of pointing at several things at once, which the
        // game already does well and a chat line does badly.
        const TSharedRef<FJsonObject> Selection = MakeShared<FJsonObject>();
        TArray<TSharedPtr<FJsonValue>> SelectedIds;
        bool bDismantleStateFound = false;
        if (AFGCharacterPlayer* PlayerCharacter = Cast<AFGCharacterPlayer>(Pawn); IsValid(PlayerCharacter))
        {
            if (AFGBuildGun* BuildGun = PlayerCharacter->GetBuildGun(); IsValid(BuildGun))
            {
                if (UFGBuildGunStateDismantle* Dismantle = Cast<UFGBuildGunStateDismantle>(
                        BuildGun->GetBuildGunStateFor(EBuildGunState::BGS_DISMANTLE)))
                {
                    bDismantleStateFound = true;
                    for (AActor* Pending : Dismantle->GetPendingDismantleActors())
                    {
                        if (IsValid(Pending))
                        {
                            SelectedIds.Add(MakeShared<FJsonValueString>(Pending->GetPathName()));
                        }
                    }
                    // The aimed-at actor is highlighted but not yet added to the
                    // pending list, and a player who has aimed at one thing and
                    // marked none plainly means that one.
                    if (AActor* Aimed = Dismantle->GetSelectedActor(); IsValid(Aimed))
                    {
                        Selection->SetStringField(TEXT("aimed_actor_id"), Aimed->GetPathName());
                    }
                }
            }
        }
        Selection->SetBoolField(TEXT("available"), bDismantleStateFound);
        Selection->SetArrayField(TEXT("actor_ids"), SelectedIds);
        Selection->SetNumberField(TEXT("count"), SelectedIds.Num());
        Selection->SetStringField(
            TEXT("note"),
            TEXT("Actors marked with the dismantle tool. Read only: this capture never dismantles them."));
        Result->SetObjectField(TEXT("dismantle_selection"), Selection);
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

            // What the building does, not just what it costs. Only build
            // recipes have one, and only some of those -- a wall has no stats,
            // so the field is simply absent rather than empty.
            const TArray<FItemAmount> ProductAmounts = UFGRecipe::GetProducts(RecipeClass);
            if (ProductAmounts.Num() > 0)
            {
                if (const TSharedPtr<FJsonObject> Stats =
                        BuildingStatsJson(ProductAmounts[0].ItemClass))
                {
                    Entry->SetObjectField(TEXT("building_stats"), Stats);
                }
            }

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
    FAIFactorySettings CaptureSettings = Settings;
    CaptureSettings.bIncludeReflectedProperties =
        Settings.bIncludeReflectedProperties && Request.bIncludeReflectedProperties;
    FAIFactorySnapshotResult Result;
    const TSharedRef<FJsonObject> Root = MakeShared<FJsonObject>();
    Root->SetStringField(TEXT("schema"), TEXT("aifactory.snapshot"));
    Root->SetNumberField(TEXT("schema_version"), 1);
    Root->SetStringField(TEXT("generated_at_utc"), CaptureStartedAtUtc);
    Root->SetStringField(TEXT("capture_started_at_utc"), CaptureStartedAtUtc);
    Root->SetStringField(TEXT("data_policy"), TEXT("authoritative_or_explicitly_unknown"));
    Root->SetNumberField(TEXT("world_revision"), static_cast<double>(WorldRevision));
    const TSharedRef<FJsonObject> ReflectionPolicy = MakeShared<FJsonObject>();
    ReflectionPolicy->SetBoolField(
        TEXT("enabled"),
        CaptureSettings.bIncludeReflectedProperties);
    ReflectionPolicy->SetBoolField(TEXT("sensitive_property_names_omitted"), true);
    ReflectionPolicy->SetStringField(
        TEXT("omission_reason"),
        TEXT("Properties named like credentials, secrets, passwords, private keys, authorization values, or tokens are never exported."));
    Root->SetObjectField(TEXT("reflection_policy"), ReflectionPolicy);

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
    Root->SetObjectField(
        TEXT("interaction_context"),
        InteractionContextJson(World, Request, CaptureSettings, TerrainBudget));

    Root->SetArrayField(TEXT("mods"), ModsJson(World, Result.ModCount));
    if (Request.bIncludeContentCatalog)
    {
        Root->SetObjectField(TEXT("content"), ContentJson(World, Result.ItemCount, Result.RecipeCount));
    }
    Root->SetObjectField(TEXT("progression"), ProgressionJson(World, Request.PlayerController));
    Root->SetObjectField(
        TEXT("visible_ui"),
        VisibleUiJson(World, Settings.bIncludeVisibleUiText));

    TArray<TSharedPtr<FJsonValue>> Actors;
    int32 LightweightSeen = 0;
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
            Actors.Add(MakeShared<FJsonValueObject>(BuildableJson(Buildable, CaptureSettings)));
            ++Result.ActorCount;
            ++Result.BuildableCount;
        }

        // The other four fifths. Structural pieces are instance data, not
        // actors, so the loop above cannot see them -- measured at 11 of 51
        // classes visible in one of the owner's buildings.
        if (!Result.bActorLimitReached)
        {
            if (AFGLightweightBuildableSubsystem* Lightweight =
                    AFGLightweightBuildableSubsystem::Get(World))
            {
                for (const auto& Pair : Lightweight->GetAllLightweightBuildableInstances())
                {
                    const TArray<FRuntimeBuildableInstanceData>& Instances = Pair.Value;
                    for (int32 Index = 0; Index < Instances.Num(); ++Index)
                    {
                        const FRuntimeBuildableInstanceData& Instance = Instances[Index];
                        if (Request.bUseRadius &&
                            FVector::DistSquared(Instance.Transform.GetLocation(), Request.Center) > RadiusSquaredCm)
                        {
                            continue;
                        }
                        if (Actors.Num() >= Settings.MaxActorsPerSnapshot)
                        {
                            Result.bActorLimitReached = true;
                            break;
                        }
                        Actors.Add(MakeShared<FJsonValueObject>(
                            LightweightBuildableJson(Pair.Key, Instance, Index)));
                        ++Result.ActorCount;
                        ++LightweightSeen;
                    }
                    if (Result.bActorLimitReached)
                    {
                        break;
                    }
                }
            }
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
                Actors.Add(MakeShared<FJsonValueObject>(
                    ResourceNodeJson(Node, CaptureSettings, World, TerrainBudget)));
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

                Actors.Add(MakeShared<FJsonValueObject>(
                    GenericActorJson(Actor, Kind, CaptureSettings)));
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
    // Named separately so a reader can tell an empty base from a blind snapshot.
    Completeness->SetNumberField(TEXT("lightweight_buildable_count"), LightweightSeen);
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
        Hash = HashCombineFast(Hash, GetTypeHash(Buildable->GetActorTransform()));
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
