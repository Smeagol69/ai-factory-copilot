#include "AIFactoryActions.h"

#include "AIFactoryOverlay.h"
#include "AIFactoryTerrain.h"
#include "Buildables/FGBuildable.h"
#include "CollisionQueryParams.h"
#include "Engine/World.h"
#include "EngineUtils.h"
#include "Equipment/FGBuildGun.h"
#include "FGBlueprintProxy.h"
#include "FGBlueprintSettings.h"
#include "FGBlueprintSubsystem.h"
#include "FGBuildableSubsystem.h"
#include "FGCharacterPlayer.h"
#include "FGConstructDisqualifier.h"
#include "FGDismantleInterface.h"
#include "FGInventoryComponent.h"
#include "FGRecipe.h"
#include "FGRecipeManager.h"
#include "Hologram/FGBlueprintHologram.h"
#include "Hologram/FGHologram.h"
#include "Resources/FGBuildingDescriptor.h"
#include "Resources/FGItemDescriptor.h"
#include "Dom/JsonObject.h"
#include "UObject/UObjectIterator.h"

namespace
{
    /** Newest last; UndoLast pops from the end. */
    TArray<FAIFactoryUndoStep> GAIFactoryUndoJournal;
    constexpr int32 MaximumActionUndoSteps = 64;

    TArray<FItemAmount> NormalizeActionCost(const TArray<FItemAmount>& RawCost)
    {
        TArray<FItemAmount> Cost;
        for (const FItemAmount& Entry : RawCost)
        {
            if (!Entry.ItemClass || Entry.Amount <= 0)
            {
                continue;
            }
            FItemAmount* Existing = Cost.FindByPredicate(
                [&Entry](const FItemAmount& Candidate)
                {
                    return Candidate.ItemClass == Entry.ItemClass;
                });
            if (Existing)
            {
                Existing->Amount += Entry.Amount;
            }
            else
            {
                Cost.Add(Entry);
            }
        }
        return Cost;
    }

    TArray<TSharedPtr<FJsonValue>> ActionCostJson(
        const TArray<FItemAmount>& Cost,
        const UFGInventoryComponent* Inventory,
        const bool bNoBuildCost)
    {
        TArray<TSharedPtr<FJsonValue>> Rows;
        for (const FItemAmount& Entry : Cost)
        {
            const int32 Held = IsValid(Inventory)
                ? Inventory->GetNumItems(Entry.ItemClass)
                : 0;
            TSharedPtr<FJsonObject> Row = MakeShared<FJsonObject>();
            Row->SetStringField(
                TEXT("item_class"),
                Entry.ItemClass ? Entry.ItemClass->GetPathName() : TEXT(""));
            Row->SetStringField(
                TEXT("item_name"),
                Entry.ItemClass
                    ? UFGItemDescriptor::GetItemName(Entry.ItemClass).ToString()
                    : TEXT("unknown"));
            Row->SetNumberField(TEXT("required"), Entry.Amount);
            Row->SetNumberField(TEXT("held"), Held);
            Row->SetNumberField(
                TEXT("missing"),
                bNoBuildCost ? 0 : FMath::Max(0, Entry.Amount - Held));
            Rows.Add(MakeShared<FJsonValueObject>(Row));
        }
        return Rows;
    }

    bool CanAffordActionCost(
        const TArray<FItemAmount>& Cost,
        const UFGInventoryComponent* Inventory)
    {
        if (!IsValid(Inventory))
        {
            return false;
        }
        if (Inventory->GetNoBuildCost())
        {
            return true;
        }
        for (const FItemAmount& Entry : Cost)
        {
            if (!Inventory->HasItems(Entry.ItemClass, Entry.Amount))
            {
                return false;
            }
        }
        return true;
    }

    bool ActionCostsEqual(
        const TArray<FItemAmount>& Left,
        const TArray<FItemAmount>& Right)
    {
        if (Left.Num() != Right.Num())
        {
            return false;
        }
        for (const FItemAmount& Entry : Left)
        {
            if (FItemAmount::GetAmountFromItemAmounts(
                    Right,
                    Entry.ItemClass) != Entry.Amount)
            {
                return false;
            }
        }
        return true;
    }

    void ChargeActionCost(
        const TArray<FItemAmount>& Cost,
        UFGInventoryComponent* Inventory)
    {
        if (!IsValid(Inventory) || Inventory->GetNoBuildCost())
        {
            return;
        }
        for (const FItemAmount& Entry : Cost)
        {
            Inventory->Remove(Entry.ItemClass, Entry.Amount);
        }
    }

    struct FAIFactoryRefundDelivery
    {
        int32 ItemUnits = 0;
        int32 AddedToInventory = 0;
        int32 DroppedOnGround = 0;
        TArray<FInventoryStack> Refund;
    };

    FAIFactoryRefundDelivery DismantleWithRefund(
        AActor* DismantleActor,
        AFGCharacterPlayer* Player)
    {
        FAIFactoryRefundDelivery Delivery;
        if (!IsValid(DismantleActor) ||
            !DismantleActor->GetClass()->ImplementsInterface(
                UFGDismantleInterface::StaticClass()))
        {
            return Delivery;
        }
        if (!IsValid(Player))
        {
            IFGDismantleInterface::Execute_Dismantle(DismantleActor);
            return Delivery;
        }

        UFGInventoryComponent* Inventory = Player->GetInventory();
        const bool bNoBuildCost = IsValid(Inventory) && Inventory->GetNoBuildCost();
        IFGDismantleInterface::Execute_GetDismantleRefund(
            DismantleActor,
            Delivery.Refund,
            bNoBuildCost);

        const FVector RefundLocation = DismantleActor->GetActorLocation();
        UWorld* World = DismantleActor->GetWorld();
        IFGDismantleInterface::Execute_Dismantle(DismantleActor);

        TArray<FInventoryStack> Remainder;
        for (const FInventoryStack& Stack : Delivery.Refund)
        {
            if (!Stack.HasItems())
            {
                continue;
            }
            Delivery.ItemUnits += Stack.NumItems;
            const int32 Added = IsValid(Inventory)
                ? Inventory->AddStack(Stack, true)
                : 0;
            Delivery.AddedToInventory += Added;
            if (Added < Stack.NumItems)
            {
                FInventoryStack Left = Stack;
                Left.NumItems -= Added;
                Delivery.DroppedOnGround += Left.NumItems;
                Remainder.Add(MoveTemp(Left));
            }
        }

        if (Remainder.Num() > 0 && IsValid(World))
        {
            FDismantleHelpers::DropRefundOnGroundNoActor(
                World,
                RefundLocation,
                Player,
                Remainder,
                Player);
        }
        return Delivery;
    }

    TSharedPtr<FJsonObject> RefundDeliveryJson(
        const FAIFactoryRefundDelivery& Delivery)
    {
        TSharedPtr<FJsonObject> Object = MakeShared<FJsonObject>();
        Object->SetNumberField(TEXT("item_units"), Delivery.ItemUnits);
        Object->SetNumberField(
            TEXT("added_to_player_inventory"),
            Delivery.AddedToInventory);
        Object->SetNumberField(
            TEXT("dropped_on_ground"),
            Delivery.DroppedOnGround);

        TArray<TSharedPtr<FJsonValue>> Rows;
        for (const FInventoryStack& Stack : Delivery.Refund)
        {
            if (!Stack.HasItems())
            {
                continue;
            }
            const TSubclassOf<UFGItemDescriptor> ItemClass =
                Stack.Item.GetItemClass();
            TSharedPtr<FJsonObject> Row = MakeShared<FJsonObject>();
            Row->SetStringField(
                TEXT("item_class"),
                ItemClass ? ItemClass->GetPathName() : TEXT(""));
            Row->SetStringField(
                TEXT("item_name"),
                ItemClass
                    ? UFGItemDescriptor::GetItemName(ItemClass).ToString()
                    : TEXT("unknown"));
            Row->SetNumberField(TEXT("amount"), Stack.NumItems);
            Rows.Add(MakeShared<FJsonValueObject>(Row));
        }
        Object->SetArrayField(TEXT("items"), Rows);
        return Object;
    }

    void RecordActionUndo(FAIFactoryUndoStep&& Step)
    {
        Step.RecordedAt = FDateTime::UtcNow();
        GAIFactoryUndoJournal.Add(MoveTemp(Step));
        while (GAIFactoryUndoJournal.Num() > MaximumActionUndoSteps)
        {
            GAIFactoryUndoJournal.RemoveAt(0);
        }
    }

    int32 RollBackActionUndoFrom(const int32 FirstStep)
    {
        int32 Reversed = 0;
        for (int32 Index = GAIFactoryUndoJournal.Num() - 1; Index >= FirstStep; --Index)
        {
            const FAIFactoryUndoStep& Step = GAIFactoryUndoJournal[Index];
            if (Step.DismantleActors.Num() > 0)
            {
                for (const TWeakObjectPtr<AActor>& Weak : Step.DismantleActors)
                {
                    if (AActor* Actor = Weak.Get(); IsValid(Actor))
                    {
                        DismantleWithRefund(Actor, Step.Player.Get());
                        ++Reversed;
                    }
                }
            }
            else
            {
                // Compatibility for journal entries made before grouped
                // dismantle targets were introduced.
                for (const TWeakObjectPtr<AFGBuildable>& Weak : Step.SpawnedBuildables)
                {
                    if (AFGBuildable* Buildable = Weak.Get(); IsValid(Buildable))
                    {
                        DismantleWithRefund(Buildable, Step.Player.Get());
                        ++Reversed;
                    }
                }
            }
            if (Step.bHadPlayerTransform && Step.Player.IsValid())
            {
                Step.Player->TeleportTo(
                    Step.PreviousPlayerTransform.GetLocation(),
                    Step.PreviousPlayerTransform.Rotator());
                ++Reversed;
            }
        }
        if (FirstStep >= 0 && FirstStep < GAIFactoryUndoJournal.Num())
        {
            GAIFactoryUndoJournal.RemoveAt(
                FirstStep,
                GAIFactoryUndoJournal.Num() - FirstStep);
        }
        return Reversed;
    }

    void ConsolidateActionUndoFrom(const int32 FirstStep, const int32 ActionCount)
    {
        const int32 Added = GAIFactoryUndoJournal.Num() - FirstStep;
        if (Added <= 1)
        {
            return;
        }

        FAIFactoryUndoStep Batch;
        Batch.Action = TEXT("transaction");
        Batch.Description = FString::Printf(
            TEXT("Reverse the previous %d-action transaction."),
            ActionCount);
        for (int32 Index = FirstStep; Index < GAIFactoryUndoJournal.Num(); ++Index)
        {
            const FAIFactoryUndoStep& Step = GAIFactoryUndoJournal[Index];
            Batch.DismantleActors.Append(Step.DismantleActors);
            Batch.SpawnedBuildables.Append(Step.SpawnedBuildables);
            if (!Batch.Player.IsValid() && Step.Player.IsValid())
            {
                Batch.Player = Step.Player;
            }
            // The first saved player transform is where the whole transaction
            // began. Later teleports must not replace it.
            if (!Batch.bHadPlayerTransform && Step.bHadPlayerTransform)
            {
                Batch.bHadPlayerTransform = true;
                Batch.PreviousPlayerTransform = Step.PreviousPlayerTransform;
            }
        }
        GAIFactoryUndoJournal.RemoveAt(FirstStep, Added);
        RecordActionUndo(MoveTemp(Batch));
    }

    TSharedPtr<FJsonObject> ActionVectorJson(const FVector& Value)
    {
        TSharedPtr<FJsonObject> Object = MakeShared<FJsonObject>();
        Object->SetNumberField(TEXT("x"), Value.X);
        Object->SetNumberField(TEXT("y"), Value.Y);
        Object->SetNumberField(TEXT("z"), Value.Z);
        return Object;
    }

    TSharedPtr<FJsonObject> ActionTransformJson(const FTransform& Value)
    {
        TSharedPtr<FJsonObject> Object = MakeShared<FJsonObject>();
        Object->SetObjectField(TEXT("location"), ActionVectorJson(Value.GetLocation()));
        const FRotator Rotation = Value.Rotator();
        TSharedPtr<FJsonObject> RotationJson = MakeShared<FJsonObject>();
        RotationJson->SetNumberField(TEXT("pitch"), Rotation.Pitch);
        RotationJson->SetNumberField(TEXT("yaw"), Rotation.Yaw);
        RotationJson->SetNumberField(TEXT("roll"), Rotation.Roll);
        Object->SetObjectField(TEXT("rotation"), RotationJson);
        return Object;
    }

    bool TraceActionPlacementSurface(
        UWorld* World,
        AActor* IgnoreActor,
        const FVector& RequestedLocation,
        FHitResult& OutHit)
    {
        if (!IsValid(World))
        {
            return false;
        }
        constexpr double TraceUpCm = 30000.0;
        constexpr double TraceDownCm = 60000.0;
        const FVector Start(
            RequestedLocation.X,
            RequestedLocation.Y,
            RequestedLocation.Z + TraceUpCm);
        const FVector End(
            RequestedLocation.X,
            RequestedLocation.Y,
            RequestedLocation.Z - TraceDownCm);
        FCollisionQueryParams Params(
            SCENE_QUERY_STAT(AIFactoryActionPlacementTrace),
            true,
            IgnoreActor);
        Params.bReturnPhysicalMaterial = false;
        return World->LineTraceSingleByChannel(
            OutHit,
            Start,
            End,
            ECC_Visibility,
            Params);
    }

    FString DescribeHologramDisqualifiers(
        AFGHologram* Hologram,
        const TSharedPtr<FJsonObject>& Predicted)
    {
        TArray<TSubclassOf<UFGConstructDisqualifier>> Disqualifiers;
        Hologram->GetConstructDisqualifiers(Disqualifiers);

        TArray<TSharedPtr<FJsonValue>> Rows;
        FString FirstHardReason;
        for (const TSubclassOf<UFGConstructDisqualifier>& Disqualifier : Disqualifiers)
        {
            if (!Disqualifier)
            {
                continue;
            }
            const bool bSoft =
                UFGConstructDisqualifier::GetIsSoftDisqualifier(Disqualifier);
            const FString ClassName = Disqualifier->GetName();
            TSharedPtr<FJsonObject> Row = MakeShared<FJsonObject>();
            Row->SetStringField(TEXT("class"), ClassName);
            Row->SetStringField(
                TEXT("message"),
                UFGConstructDisqualifier::GetDisqualifyingText(
                    Disqualifier).ToString());
            Row->SetBoolField(TEXT("soft"), bSoft);
            Rows.Add(MakeShared<FJsonValueObject>(Row));
            if (!bSoft && FirstHardReason.IsEmpty())
            {
                FirstHardReason = ClassName;
            }
        }
        Predicted->SetArrayField(TEXT("placement_disqualifiers"), Rows);
        Predicted->SetBoolField(
            TEXT("hologram_can_construct"),
            Hologram->CanConstruct());
        return FirstHardReason;
    }

    bool PositionAndValidateActionHologram(
        AFGHologram* Hologram,
        UWorld* World,
        AFGCharacterPlayer* Player,
        UFGInventoryComponent* Inventory,
        const FTransform& Requested,
        const TSharedPtr<FJsonObject>& Predicted,
        FString& OutFailure)
    {
        if (!IsValid(Hologram))
        {
            OutFailure = TEXT("hologram_spawn_failed");
            return false;
        }

        FHitResult Hit;
        if (!TraceActionPlacementSurface(
                World,
                Player,
                Requested.GetLocation(),
                Hit))
        {
            OutFailure = TEXT("no_build_surface_below_requested_location");
            return false;
        }
        Predicted->SetObjectField(
            TEXT("build_surface_point"),
            ActionVectorJson(Hit.ImpactPoint));
        Predicted->SetObjectField(
            TEXT("build_surface_normal"),
            ActionVectorJson(Hit.ImpactNormal));
        Predicted->SetStringField(
            TEXT("build_surface_actor"),
            IsValid(Hit.GetActor()) ? Hit.GetActor()->GetPathName() : TEXT("unknown"));

        Hologram->SetConstructionInstigator(Player);
        if (!Hologram->IsValidHitResult(Hit))
        {
            OutFailure = TEXT("hologram_rejected_build_surface");
            return false;
        }
        Hologram->UpdateHologramPlacement(Hit);

        // Rotate only through the hologram's public scroll interface. The final
        // actor transform is read back, so a recipe with a different rotation
        // granularity is refused instead of silently placed at another yaw.
        const double RequestedYaw = Requested.Rotator().Yaw;
        double YawError = FRotator::NormalizeAxis(
            RequestedYaw - Hologram->GetActorRotation().Yaw);
        constexpr double YawToleranceDegrees = 0.5;
        if (FMath::Abs(YawError) > YawToleranceDegrees)
        {
            const int32 RotationStep = Hologram->GetRotationStep();
            if (RotationStep <= 0)
            {
                OutFailure = FString::Printf(
                    TEXT("hologram_has_no_rotation_step:requested_yaw=%.3f,actual_yaw=%.3f"),
                    RequestedYaw,
                    Hologram->GetActorRotation().Yaw);
                return false;
            }
            const int32 ScrollTicks =
                FMath::RoundToInt(YawError / static_cast<double>(RotationStep));
            if (ScrollTicks == 0)
            {
                OutFailure = TEXT("requested_yaw_is_not_representable_by_hologram");
                return false;
            }
            Hologram->ScrollRotate(ScrollTicks, RotationStep);
            Hologram->UpdateHologramPlacement(Hit);
            YawError = FRotator::NormalizeAxis(
                RequestedYaw - Hologram->GetActorRotation().Yaw);
        }

        Predicted->SetObjectField(
            TEXT("hologram_transform"),
            ActionTransformJson(Hologram->GetActorTransform()));
        Predicted->SetNumberField(TEXT("hologram_yaw_error_degrees"), YawError);
        if (FMath::Abs(YawError) > YawToleranceDegrees)
        {
            OutFailure = FString::Printf(
                TEXT("requested_yaw_is_not_representable:requested=%.3f,actual=%.3f"),
                RequestedYaw,
                Hologram->GetActorRotation().Yaw);
            return false;
        }

        Hologram->ValidatePlacementAndCost(Inventory);
        FString HardReason = DescribeHologramDisqualifiers(Hologram, Predicted);
        if (!Hologram->CanConstruct())
        {
            OutFailure = HardReason.IsEmpty()
                ? TEXT("hologram_refused_placement_or_cost")
                : TEXT("hologram_disqualified:") + HardReason;
            return false;
        }

        // A single-point machine/building should complete immediately. Belts,
        // pipes, wires, and other multi-point recipes need explicit endpoints
        // and are refused by this action instead of inventing the missing point.
        if (!Hologram->DoMultiStepPlacement(true))
        {
            OutFailure = TEXT("hologram_requires_additional_placement_points");
            return false;
        }
        Hologram->ValidatePlacementAndCost(Inventory);
        HardReason = DescribeHologramDisqualifiers(Hologram, Predicted);
        if (!Hologram->CanConstruct())
        {
            OutFailure = HardReason.IsEmpty()
                ? TEXT("hologram_refused_after_final_build_step")
                : TEXT("hologram_disqualified_after_final_build_step:") + HardReason;
            return false;
        }
        return true;
    }

    /**
     * Common gate for every action. Returns an empty string when the action may
     * proceed, otherwise the reason it may not.
     */
    FString CheckActionPreconditions(const FAIFactoryActionContext& Context)
    {
        if (!IsValid(Context.World))
        {
            return TEXT("no_world");
        }
        // Writes must not run on a client: the server owns world state, and a
        // client-side spawn would desync rather than build.
        const ENetMode NetMode = Context.World->GetNetMode();
        if (NetMode == NM_Client)
        {
            return TEXT("not_server_authoritative");
        }
        if (!Context.ExpectedWorldRevision.IsEmpty() &&
            !Context.ActualWorldRevision.IsEmpty() &&
            Context.ExpectedWorldRevision != Context.ActualWorldRevision)
        {
            return FString::Printf(
                TEXT("world_revision_moved:expected=%s,actual=%s"),
                *Context.ExpectedWorldRevision,
                *Context.ActualWorldRevision);
        }
        return FString();
    }

    /** Resolves a class path to a loaded UClass without loading arbitrary assets. */
    UClass* FindActionClassByPath(const FString& ClassPath)
    {
        if (ClassPath.IsEmpty())
        {
            return nullptr;
        }
        // Accept both the full object path and a bare class name, matching the
        // forms the scanner emits and the catalog stores.
        if (UClass* Direct = FindObject<UClass>(nullptr, *ClassPath))
        {
            return Direct;
        }
        if (UClass* Loaded = LoadObject<UClass>(nullptr, *ClassPath))
        {
            return Loaded;
        }
        for (TObjectIterator<UClass> It; It; ++It)
        {
            if (It->GetName() == ClassPath || It->GetPathName() == ClassPath)
            {
                return *It;
            }
        }
        return nullptr;
    }

    AActor* FindActionActorByPathName(UWorld* World, const FString& ActorId)
    {
        for (TActorIterator<AActor> It(World); It; ++It)
        {
            if (It->GetPathName() == ActorId)
            {
                return *It;
            }
        }
        return nullptr;
    }

    FLinearColor ParseOverlayColor(const FString& Name, const FLinearColor& Fallback)
    {
        const FString Lower = Name.ToLower();
        if (Lower == TEXT("green")) return FLinearColor(0.1f, 1.0f, 0.4f, 1.0f);
        if (Lower == TEXT("red")) return FLinearColor(1.0f, 0.15f, 0.15f, 1.0f);
        if (Lower == TEXT("blue")) return FLinearColor(0.2f, 0.5f, 1.0f, 1.0f);
        if (Lower == TEXT("yellow")) return FLinearColor(1.0f, 0.9f, 0.1f, 1.0f);
        if (Lower == TEXT("orange")) return FLinearColor(1.0f, 0.5f, 0.05f, 1.0f);
        if (Lower == TEXT("purple")) return FLinearColor(0.7f, 0.3f, 1.0f, 1.0f);
        if (Lower == TEXT("cyan")) return FLinearColor(0.1f, 0.9f, 1.0f, 1.0f);
        if (Lower == TEXT("white")) return FLinearColor::White;
        // An unrecognised name keeps the default rather than drawing nothing.
        return Fallback;
    }

    /** `highlight` / `clear_highlight`, expressed as an action result. */
    FAIFactoryActionResult RunOverlayAction(
        const FAIFactoryActionContext& Context,
        const FString& Kind,
        const TSharedPtr<FJsonObject>& Spec)
    {
        FAIFactoryActionResult Result;
        Result.Action = Kind;

        if (!IsValid(Context.World))
        {
            return FAIFactoryActionResult::Refuse(Kind, TEXT("no_world"));
        }

        FString OverlayName = TEXT("overlay");
        Spec->TryGetStringField(TEXT("overlay"), OverlayName);

        if (Kind == TEXT("clear_highlight"))
        {
            bool bAll = false;
            Spec->TryGetBoolField(TEXT("all"), bAll);
            const int32 Cleared = bAll
                ? AIFactoryOverlay::ClearAll(Context.World)
                : (AIFactoryOverlay::Clear(Context.World, OverlayName) ? 1 : 0);
            TSharedPtr<FJsonObject> Observed = MakeShared<FJsonObject>();
            Observed->SetNumberField(TEXT("overlays_cleared"), Cleared);
            Result.Observed = Observed;
            Result.bAccepted = true;
            Result.bCommitted = true;
            Result.Status = Cleared > 0 ? TEXT("committed") : TEXT("nothing_to_clear");
            return Result;
        }

        FAIFactoryOverlayQuery Query;
        Spec->TryGetStringField(TEXT("item_name_contains"), Query.ItemNameContains);
        Spec->TryGetStringField(TEXT("class_name_contains"), Query.ClassNameContains);
        Spec->TryGetStringField(TEXT("name_contains"), Query.DisplayNameContains);
        Spec->TryGetStringField(TEXT("kind"), Query.Kind);
        Spec->TryGetNumberField(TEXT("radius_m"), Query.RadiusMeters);
        Spec->TryGetNumberField(TEXT("max_results"), Query.MaxResults);

        const TArray<TSharedPtr<FJsonValue>>* Ids = nullptr;
        if (Spec->TryGetArrayField(TEXT("actor_ids"), Ids) && Ids)
        {
            for (const TSharedPtr<FJsonValue>& Value : *Ids)
            {
                FString Id;
                if (Value.IsValid() && Value->TryGetString(Id) && !Id.IsEmpty())
                {
                    Query.ActorIds.Add(Id);
                }
            }
        }

        FAIFactoryOverlayStyle Style;
        FString ColorName;
        if (Spec->TryGetStringField(TEXT("color"), ColorName))
        {
            Style.Color = ParseOverlayColor(ColorName, Style.Color);
        }
        Spec->TryGetBoolField(TEXT("tracers"), Style.bDrawTracers);
        Spec->TryGetBoolField(TEXT("boxes"), Style.bDrawBoxes);
        Spec->TryGetBoolField(TEXT("pillars"), Style.bDrawPillars);
        Spec->TryGetBoolField(TEXT("through_walls"), Style.bDrawThroughWalls);
        double Thickness = Style.Thickness;
        if (Spec->TryGetNumberField(TEXT("thickness"), Thickness))
        {
            Style.Thickness = static_cast<float>(FMath::Clamp(Thickness, 0.5, 30.0));
        }
        double Lifetime = Style.LifetimeSeconds;
        if (Spec->TryGetNumberField(TEXT("lifetime_seconds"), Lifetime))
        {
            Style.LifetimeSeconds = static_cast<float>(FMath::Clamp(Lifetime, 0.0, 3600.0));
        }

        const FAIFactoryOverlayResult Overlay = AIFactoryOverlay::Draw(
            Context.World, Context.Player, OverlayName, Query, Style);

        Result.bAccepted = true;
        Result.Observed = AIFactoryOverlay::ResultToJson(Overlay);
        if (Overlay.bDrawn)
        {
            Result.bCommitted = true;
            Result.Status = TEXT("committed");
            Result.bUndoable = true;
            Result.UndoDescription = FString::Printf(
                TEXT("Clear the '%s' overlay."), *Overlay.OverlayName);
        }
        else
        {
            Result.Status = Overlay.Status;
            Result.Reason = Overlay.Reason;
        }
        return Result;
    }
}

namespace AIFactoryActions
{

FAIFactoryActionResult TeleportPlayer(
    const FAIFactoryActionContext& Context,
    const FVector& Target,
    bool bSnapToGround,
    double SnapClearanceCm)
{
    const FString Action = TEXT("teleport_player");
    const FString Blocked = CheckActionPreconditions(Context);
    if (!Blocked.IsEmpty())
    {
        return FAIFactoryActionResult::Refuse(Action, Blocked);
    }
    if (!IsValid(Context.Player))
    {
        return FAIFactoryActionResult::Refuse(Action, TEXT("no_player"));
    }
    if (Target.ContainsNaN())
    {
        return FAIFactoryActionResult::Refuse(Action, TEXT("target_is_not_a_finite_coordinate"));
    }

    FAIFactoryActionResult Result;
    Result.Action = Action;
    Result.bAccepted = true;
    Result.bDryRun = Context.bDryRun;

    // A teleport to a bare XY with a guessed Z drops the player through the
    // world. Resolve the ground first and report the height actually used.
    FVector Resolved = Target;
    bool bGroundFound = false;
    if (bSnapToGround)
    {
        const FAIFactoryGroundSample Sample = FAIFactoryTerrain::SampleGround(Context.World, Target);
        if (Sample.bHitGround)
        {
            Resolved.Z = Sample.GroundPoint.Z + FMath::Max(0.0, SnapClearanceCm);
            bGroundFound = true;
        }
        else
        {
            Result.Warnings.Add(TEXT(
                "No ground was found under the target, so the requested Z was used unchanged. "
                "The player may fall."));
        }
    }

    TSharedPtr<FJsonObject> Predicted = MakeShared<FJsonObject>();
    Predicted->SetObjectField(TEXT("requested"), ActionVectorJson(Target));
    Predicted->SetObjectField(TEXT("resolved"), ActionVectorJson(Resolved));
    Predicted->SetBoolField(TEXT("snapped_to_ground"), bGroundFound);
    Predicted->SetObjectField(TEXT("from"), ActionVectorJson(Context.Player->GetActorLocation()));
    Predicted->SetNumberField(
        TEXT("distance_m"),
        FVector::Dist(Context.Player->GetActorLocation(), Resolved) / 100.0);
    Result.Predicted = Predicted;

    if (Context.bDryRun)
    {
        Result.Status = TEXT("dry_run");
        return Result;
    }

    const FTransform Previous = Context.Player->GetActorTransform();
    const bool bMoved = Context.Player->TeleportTo(Resolved, Context.Player->GetActorRotation());

    // Report where the player actually ended up: the engine resolves collision
    // and may place them somewhere other than the exact target.
    const FVector Landed = Context.Player->GetActorLocation();
    TSharedPtr<FJsonObject> Observed = MakeShared<FJsonObject>();
    Observed->SetObjectField(TEXT("player_location"), ActionVectorJson(Landed));
    Observed->SetNumberField(TEXT("offset_from_requested_cm"), FVector::Dist(Landed, Resolved));
    Result.Observed = Observed;

    if (!bMoved)
    {
        Result.Status = TEXT("failed");
        Result.Reason = TEXT("engine_refused_teleport_target_is_blocked");
        return Result;
    }

    Result.bCommitted = true;
    Result.Status = TEXT("committed");
    Result.bUndoable = true;
    Result.UndoDescription = TEXT("Teleport back to the previous position.");

    FAIFactoryUndoStep Step;
    Step.Action = Action;
    Step.bHadPlayerTransform = true;
    Step.PreviousPlayerTransform = Previous;
    Step.Player = Context.Player;
    Step.Description = TEXT("Teleport back to the previous position.");
    RecordActionUndo(MoveTemp(Step));

    return Result;
}

FAIFactoryActionResult PlaceBuilding(
    const FAIFactoryActionContext& Context,
    const FString& RecipeClassPath,
    const FTransform& Target,
    bool bCheckClearance)
{
    const FString Action = TEXT("place_building");
    const FString Blocked = CheckActionPreconditions(Context);
    if (!Blocked.IsEmpty())
    {
        return FAIFactoryActionResult::Refuse(Action, Blocked);
    }

    UClass* RecipeClassObject = FindActionClassByPath(RecipeClassPath);
    if (!RecipeClassObject || !RecipeClassObject->IsChildOf(UFGRecipe::StaticClass()))
    {
        return FAIFactoryActionResult::Refuse(
            Action,
            FString::Printf(TEXT("recipe_not_found:%s"), *RecipeClassPath));
    }
    const TSubclassOf<UFGRecipe> RecipeClass = RecipeClassObject;

    // A build recipe produces exactly one building descriptor, and that
    // descriptor names the buildable class. Anything else is not placeable.
    TSubclassOf<AFGBuildable> BuildableClass = nullptr;
    for (const FItemAmount& Product : UFGRecipe::GetProducts(RecipeClass))
    {
        if (Product.ItemClass && Product.ItemClass->IsChildOf(UFGBuildingDescriptor::StaticClass()))
        {
            const TSubclassOf<UFGBuildingDescriptor> Descriptor{ Product.ItemClass.Get() };
            BuildableClass = UFGBuildingDescriptor::GetBuildableClass(Descriptor);
            break;
        }
    }
    if (!BuildableClass)
    {
        return FAIFactoryActionResult::Refuse(
            Action,
            FString::Printf(
                TEXT("recipe_is_not_a_build_recipe:%s"),
                *RecipeClassObject->GetName()));
    }

    if (!IsValid(Context.Player))
    {
        return FAIFactoryActionResult::Refuse(Action, TEXT("no_player"));
    }
    AFGRecipeManager* RecipeManager = AFGRecipeManager::Get(Context.World);
    if (!IsValid(RecipeManager))
    {
        return FAIFactoryActionResult::Refuse(Action, TEXT("no_recipe_manager"));
    }
    if (!RecipeManager->IsRecipeAvailable(RecipeClass))
    {
        return FAIFactoryActionResult::Refuse(
            Action,
            FString::Printf(
                TEXT("recipe_is_not_unlocked:%s"),
                *RecipeClassObject->GetName()));
    }
    if (!RecipeManager->IsBuildingAvailable(BuildableClass))
    {
        return FAIFactoryActionResult::Refuse(
            Action,
            FString::Printf(
                TEXT("building_is_not_unlocked:%s"),
                *BuildableClass->GetName()));
    }

    UFGInventoryComponent* Inventory = Context.Player->GetInventory();
    if (!IsValid(Inventory))
    {
        return FAIFactoryActionResult::Refuse(Action, TEXT("no_player_inventory"));
    }
    AFGBuildableSubsystem* Buildables = AFGBuildableSubsystem::Get(Context.World);
    if (!IsValid(Buildables))
    {
        return FAIFactoryActionResult::Refuse(Action, TEXT("no_buildable_subsystem"));
    }

    FAIFactoryActionResult Result;
    Result.Action = Action;
    Result.bAccepted = true;
    Result.bDryRun = Context.bDryRun;

    TSharedPtr<FJsonObject> Predicted = MakeShared<FJsonObject>();
    Predicted->SetStringField(TEXT("recipe_class"), RecipeClassObject->GetName());
    Predicted->SetStringField(TEXT("buildable_class"), BuildableClass->GetName());
    Predicted->SetStringField(
        TEXT("building_name"),
        UFGRecipe::GetRecipeName(RecipeClass).ToString());
    Predicted->SetObjectField(TEXT("transform"), ActionTransformJson(Target));
    Predicted->SetBoolField(TEXT("recipe_unlocked"), true);
    Predicted->SetBoolField(TEXT("building_unlocked"), true);

    // Measure the ground and the space rather than assuming both are fine. This
    // is advisory: the game's own construction still decides.
    if (bCheckClearance)
    {
        const FAIFactoryGroundSample Sample =
            FAIFactoryTerrain::SampleGround(Context.World, Target.GetLocation());
        Predicted->SetBoolField(TEXT("ground_found"), Sample.bHitGround);
        Predicted->SetNumberField(TEXT("ground_slope_degrees"), Sample.SlopeDegrees);
        Predicted->SetBoolField(TEXT("over_water"), Sample.bWater);
        if (!Sample.bHitGround)
        {
            Result.Warnings.Add(TEXT("No ground under the target; the building may float."));
        }
        if (Sample.bWater)
        {
            Result.Warnings.Add(TEXT("The target is over water."));
        }
        if (Sample.bBlockedAboveGround)
        {
            Result.Warnings.Add(FString::Printf(
                TEXT("Something already occupies the target: %s"),
                *Sample.BlockingActor));
        }
    }
    else
    {
        Predicted->SetStringField(TEXT("clearance_check"), TEXT("skipped_by_request"));
    }

    AActor* HologramOwner = Context.Player;
    if (AFGBuildGun* BuildGun = Context.Player->GetBuildGun();
        IsValid(BuildGun))
    {
        HologramOwner = BuildGun;
    }
    AFGHologram* Hologram = AFGHologram::SpawnHologramFromRecipe(
        RecipeClass,
        HologramOwner,
        Target.GetLocation(),
        Context.Player);
    if (!IsValid(Hologram))
    {
        Result.Predicted = Predicted;
        Result.bAccepted = false;
        Result.Status = TEXT("refused");
        Result.Reason = TEXT("game_could_not_spawn_recipe_hologram");
        return Result;
    }

    FString HologramFailure;
    const bool bHologramValid = PositionAndValidateActionHologram(
        Hologram,
        Context.World,
        Context.Player,
        Inventory,
        Target,
        Predicted,
        HologramFailure);
    const TArray<FItemAmount> Cost =
        NormalizeActionCost(Hologram->GetCost(true));
    const bool bCanAfford = CanAffordActionCost(Cost, Inventory);
    Predicted->SetStringField(
        TEXT("placement_validation"),
        TEXT("satisfactory_hologram"));
    Predicted->SetBoolField(TEXT("no_build_cost"), Inventory->GetNoBuildCost());
    Predicted->SetArrayField(
        TEXT("cost"),
        ActionCostJson(Cost, Inventory, Inventory->GetNoBuildCost()));
    Predicted->SetBoolField(TEXT("can_afford"), bCanAfford);
    Result.Predicted = Predicted;

    if (!bHologramValid || !bCanAfford)
    {
        if (IsValid(Hologram))
        {
            Hologram->Destroy();
        }
        Result.bAccepted = false;
        Result.Status = TEXT("refused");
        Result.Reason = !HologramFailure.IsEmpty()
            ? HologramFailure
            : TEXT("player_cannot_afford_hologram_cost");
        return Result;
    }

    if (Context.bDryRun)
    {
        Hologram->Destroy();
        Result.Status = TEXT("dry_run");
        return Result;
    }

    TArray<AActor*> ConstructedChildren;
    AActor* Constructed = Hologram->Construct(
        ConstructedChildren,
        Buildables->GetNewNetConstructionID());
    if (IsValid(Hologram))
    {
        Hologram->Destroy();
    }

    AFGBuildable* RootBuildable = Cast<AFGBuildable>(Constructed);
    TArray<AFGBuildable*> ConstructedBuildables;
    if (IsValid(RootBuildable))
    {
        ConstructedBuildables.Add(RootBuildable);
    }
    for (AActor* Child : ConstructedChildren)
    {
        if (AFGBuildable* ChildBuildable = Cast<AFGBuildable>(Child);
            IsValid(ChildBuildable))
        {
            ConstructedBuildables.AddUnique(ChildBuildable);
        }
    }

    if (!IsValid(RootBuildable) ||
        !RootBuildable->IsA(BuildableClass) ||
        ConstructedBuildables.Num() == 0)
    {
        for (AFGBuildable* Buildable : ConstructedBuildables)
        {
            if (IsValid(Buildable))
            {
                // No material was charged, so cleanup must not grant a refund.
                IFGDismantleInterface::Execute_Dismantle(Buildable);
            }
        }
        if (IsValid(Constructed) && !IsValid(RootBuildable))
        {
            Constructed->Destroy();
        }
        Result.Status = TEXT("failed");
        Result.Reason = TEXT("hologram_constructed_no_matching_buildable");
        return Result;
    }

    ChargeActionCost(Cost, Inventory);

    Result.bCommitted = true;
    Result.Status = TEXT("committed");
    for (AFGBuildable* Buildable : ConstructedBuildables)
    {
        Result.CreatedActorIds.Add(Buildable->GetPathName());
    }

    TSharedPtr<FJsonObject> Observed = MakeShared<FJsonObject>();
    Observed->SetStringField(TEXT("actor_id"), RootBuildable->GetPathName());
    Observed->SetNumberField(
        TEXT("buildables_constructed"),
        ConstructedBuildables.Num());
    Observed->SetObjectField(
        TEXT("transform"),
        ActionTransformJson(RootBuildable->GetActorTransform()));
    Observed->SetStringField(
        TEXT("built_with_recipe"),
        RootBuildable->GetBuiltWithRecipe()
            ? RootBuildable->GetBuiltWithRecipe()->GetPathName()
            : TEXT(""));
    Observed->SetBoolField(TEXT("validated_by_hologram"), true);
    Observed->SetNumberField(
        TEXT("offset_from_requested_cm"),
        FVector::Dist(RootBuildable->GetActorLocation(), Target.GetLocation()));
    Result.Observed = Observed;

    Result.bUndoable = true;
    Result.UndoDescription = TEXT("Dismantle the placed building.");

    FAIFactoryUndoStep Step;
    Step.Action = Action;
    for (AFGBuildable* Buildable : ConstructedBuildables)
    {
        Step.DismantleActors.Add(Buildable);
        Step.SpawnedBuildables.Add(Buildable);
    }
    Step.Player = Context.Player;
    Step.Description = FString::Printf(
        TEXT("Dismantle %s"),
        *UFGRecipe::GetRecipeName(RecipeClass).ToString());
    RecordActionUndo(MoveTemp(Step));

    return Result;
}

FAIFactoryActionResult PlaceBlueprint(
    const FAIFactoryActionContext& Context,
    const FString& BlueprintName,
    const FTransform& Origin)
{
    const FString Action = TEXT("place_blueprint");
    const FString Blocked = CheckActionPreconditions(Context);
    if (!Blocked.IsEmpty())
    {
        return FAIFactoryActionResult::Refuse(Action, Blocked);
    }

    AFGBlueprintSubsystem* Blueprints = AFGBlueprintSubsystem::Get(Context.World);
    if (!IsValid(Blueprints))
    {
        return FAIFactoryActionResult::Refuse(Action, TEXT("no_blueprint_subsystem"));
    }

    UFGBlueprintDescriptor* Descriptor =
        Blueprints->GetBlueprintDescriptorByNameString(BlueprintName);
    if (!IsValid(Descriptor))
    {
        return FAIFactoryActionResult::Refuse(
            Action,
            FString::Printf(TEXT("blueprint_not_found:%s"), *BlueprintName));
    }

    if (!IsValid(Context.Player))
    {
        return FAIFactoryActionResult::Refuse(Action, TEXT("no_player"));
    }
    if (!Descriptor->GetRecipeRequirementsAreMet())
    {
        return FAIFactoryActionResult::Refuse(
            Action,
            FString::Printf(
                TEXT("blueprint_contains_locked_recipes:%s"),
                *BlueprintName));
    }
    UFGInventoryComponent* Inventory = Context.Player->GetInventory();
    if (!IsValid(Inventory))
    {
        return FAIFactoryActionResult::Refuse(Action, TEXT("no_player_inventory"));
    }
    TArray<FItemAmount> RawCost;
    Descriptor->GetBlueprintCost(RawCost);
    const TArray<FItemAmount> DescriptorCost = NormalizeActionCost(RawCost);

    const UFGBlueprintSettings* BlueprintSettings = UFGBlueprintSettings::Get();
    UClass* BlueprintRecipeObject = IsValid(BlueprintSettings)
        ? BlueprintSettings->mBlueprintRecipeClass.LoadSynchronous()
        : nullptr;
    if (!BlueprintRecipeObject ||
        !BlueprintRecipeObject->IsChildOf(UFGRecipe::StaticClass()))
    {
        return FAIFactoryActionResult::Refuse(
            Action,
            TEXT("blueprint_hologram_recipe_is_unavailable"));
    }
    const TSubclassOf<UFGRecipe> BlueprintRecipe = BlueprintRecipeObject;

    AFGBuildableSubsystem* Buildables = AFGBuildableSubsystem::Get(Context.World);
    if (!IsValid(Buildables))
    {
        return FAIFactoryActionResult::Refuse(Action, TEXT("no_buildable_subsystem"));
    }

    FAIFactoryActionResult Result;
    Result.Action = Action;
    Result.bAccepted = true;
    Result.bDryRun = Context.bDryRun;

    TSharedPtr<FJsonObject> Predicted = MakeShared<FJsonObject>();
    Predicted->SetStringField(TEXT("blueprint_name"), BlueprintName);
    Predicted->SetObjectField(TEXT("origin"), ActionTransformJson(Origin));
    Predicted->SetBoolField(TEXT("recipe_requirements_met"), true);
    Predicted->SetObjectField(
        TEXT("dimensions"),
        ActionVectorJson(FVector(Descriptor->GetDimensionsOnInstance())));
    Predicted->SetArrayField(
        TEXT("descriptor_cost"),
        ActionCostJson(
            DescriptorCost,
            Inventory,
            Inventory->GetNoBuildCost()));

    AActor* HologramOwner = Context.Player;
    if (AFGBuildGun* BuildGun = Context.Player->GetBuildGun();
        IsValid(BuildGun))
    {
        HologramOwner = BuildGun;
    }
    AFGHologram* SpawnedHologram = AFGHologram::SpawnHologramFromRecipe(
        BlueprintRecipe,
        HologramOwner,
        Origin.GetLocation(),
        Context.Player,
        [Descriptor](AFGHologram* NewHologram)
        {
            if (AFGBlueprintHologram* BlueprintHologram =
                    Cast<AFGBlueprintHologram>(NewHologram))
            {
                BlueprintHologram->SetBlueprintDescriptor(Descriptor);
            }
        });
    AFGBlueprintHologram* Hologram =
        Cast<AFGBlueprintHologram>(SpawnedHologram);
    if (!IsValid(Hologram))
    {
        if (IsValid(SpawnedHologram))
        {
            SpawnedHologram->Destroy();
        }
        Result.Predicted = Predicted;
        Result.bAccepted = false;
        Result.Status = TEXT("refused");
        Result.Reason = TEXT("game_could_not_spawn_blueprint_hologram");
        return Result;
    }

    FString HologramFailure;
    const bool bHologramValid = PositionAndValidateActionHologram(
        Hologram,
        Context.World,
        Context.Player,
        Inventory,
        Origin,
        Predicted,
        HologramFailure);
    const TArray<FItemAmount> Cost =
        NormalizeActionCost(Hologram->GetCost(true));
    const bool bCostsMatch =
        ActionCostsEqual(DescriptorCost, Cost);
    const bool bCanAfford = CanAffordActionCost(Cost, Inventory);
    Predicted->SetStringField(
        TEXT("placement_validation"),
        TEXT("satisfactory_blueprint_hologram"));
    Predicted->SetBoolField(TEXT("no_build_cost"), Inventory->GetNoBuildCost());
    Predicted->SetArrayField(
        TEXT("cost"),
        ActionCostJson(Cost, Inventory, Inventory->GetNoBuildCost()));
    Predicted->SetBoolField(
        TEXT("hologram_cost_matches_descriptor"),
        bCostsMatch);
    Predicted->SetBoolField(TEXT("can_afford"), bCanAfford);
    Result.Predicted = Predicted;

    if (!bHologramValid || !bCanAfford || !bCostsMatch)
    {
        Hologram->Destroy();
        Result.bAccepted = false;
        Result.Status = TEXT("refused");
        if (!HologramFailure.IsEmpty())
        {
            Result.Reason = HologramFailure;
        }
        else if (!bCostsMatch)
        {
            Result.Reason = TEXT("blueprint_hologram_cost_mismatch");
        }
        else
        {
            Result.Reason = TEXT("player_cannot_afford_blueprint_cost");
        }
        return Result;
    }

    if (Context.bDryRun)
    {
        Hologram->Destroy();
        Result.Status = TEXT("dry_run");
        return Result;
    }

    TArray<AActor*> ConstructedChildren;
    AActor* Constructed = Hologram->Construct(
        ConstructedChildren,
        Buildables->GetNewNetConstructionID());
    if (IsValid(Hologram))
    {
        Hologram->Destroy();
    }

    AFGBlueprintProxy* Proxy = Cast<AFGBlueprintProxy>(Constructed);
    TArray<AFGBuildable*> Placed;
    if (IsValid(Proxy))
    {
        Proxy->CollectBuildables(Placed);
    }
    if (AFGBuildable* RootBuildable = Cast<AFGBuildable>(Constructed);
        IsValid(RootBuildable))
    {
        Placed.AddUnique(RootBuildable);
    }
    for (AActor* Child : ConstructedChildren)
    {
        if (AFGBuildable* Buildable = Cast<AFGBuildable>(Child);
            IsValid(Buildable))
        {
            Placed.AddUnique(Buildable);
        }
    }

    if (Placed.Num() == 0)
    {
        if (IsValid(Proxy))
        {
            // No material was charged, so cleanup must not grant a refund.
            IFGDismantleInterface::Execute_Dismantle(Proxy);
        }
        else
        {
            if (IsValid(Constructed))
            {
                Constructed->Destroy();
            }
            for (AActor* Child : ConstructedChildren)
            {
                if (IsValid(Child))
                {
                    Child->Destroy();
                }
            }
        }
        Result.Status = TEXT("failed");
        Result.Reason = TEXT("blueprint_hologram_constructed_no_buildables");
        return Result;
    }
    ChargeActionCost(Cost, Inventory);

    Result.bCommitted = true;
    Result.Status = TEXT("committed");

    FAIFactoryUndoStep Step;
    Step.Action = Action;
    Step.Player = Context.Player;
    if (IsValid(Proxy))
    {
        Step.DismantleActors.Add(Proxy);
    }
    for (AFGBuildable* Buildable : Placed)
    {
        if (IsValid(Buildable))
        {
            Result.CreatedActorIds.Add(Buildable->GetPathName());
            Step.SpawnedBuildables.Add(Buildable);
            if (!IsValid(Proxy))
            {
                Step.DismantleActors.Add(Buildable);
            }
        }
    }
    Step.Description = FString::Printf(TEXT("Dismantle the placed blueprint '%s'"), *BlueprintName);

    TSharedPtr<FJsonObject> Observed = MakeShared<FJsonObject>();
    Observed->SetNumberField(TEXT("buildings_placed"), Result.CreatedActorIds.Num());
    Observed->SetObjectField(
        TEXT("origin"),
        ActionTransformJson(
            IsValid(Proxy)
                ? Proxy->GetActorTransform()
                : Placed[0]->GetActorTransform()));
    Observed->SetStringField(
        TEXT("blueprint_proxy_id"),
        IsValid(Proxy) ? Proxy->GetPathName() : TEXT(""));
    Observed->SetBoolField(TEXT("validated_by_blueprint_hologram"), true);
    Result.Observed = Observed;

    Result.bUndoable = true;
    Result.UndoDescription = FString::Printf(
        TEXT("Dismantle all %d placed buildings."),
        Result.CreatedActorIds.Num());
    RecordActionUndo(MoveTemp(Step));

    return Result;
}

FAIFactoryActionResult DismantleActor(const FAIFactoryActionContext& Context, const FString& ActorId)
{
    const FString Action = TEXT("dismantle");
    const FString Blocked = CheckActionPreconditions(Context);
    if (!Blocked.IsEmpty())
    {
        return FAIFactoryActionResult::Refuse(Action, Blocked);
    }

    AActor* Found = FindActionActorByPathName(Context.World, ActorId);
    AFGBuildable* Buildable = Cast<AFGBuildable>(Found);
    if (!IsValid(Buildable))
    {
        return FAIFactoryActionResult::Refuse(
            Action,
            FString::Printf(TEXT("buildable_not_found:%s"), *ActorId));
    }
    if (!IsValid(Context.Player))
    {
        return FAIFactoryActionResult::Refuse(Action, TEXT("no_player"));
    }
    if (!IFGDismantleInterface::Execute_CanDismantle(Buildable))
    {
        return FAIFactoryActionResult::Refuse(
            Action,
            TEXT("the_game_reports_this_building_cannot_be_dismantled"));
    }

    FAIFactoryActionResult Result;
    Result.Action = Action;
    Result.bAccepted = true;
    Result.bDryRun = Context.bDryRun;

    TSharedPtr<FJsonObject> Predicted = MakeShared<FJsonObject>();
    Predicted->SetStringField(TEXT("actor_id"), ActorId);
    Predicted->SetStringField(TEXT("class"), Buildable->GetClass()->GetName());
    Predicted->SetObjectField(TEXT("transform"), ActionTransformJson(Buildable->GetActorTransform()));
    Result.Predicted = Predicted;

    if (Context.bDryRun)
    {
        Result.Status = TEXT("dry_run");
        return Result;
    }

    const FAIFactoryRefundDelivery Refund =
        DismantleWithRefund(Buildable, Context.Player);
    Result.bCommitted = true;
    Result.Status = TEXT("committed");
    Result.RemovedActorIds.Add(ActorId);
    TSharedPtr<FJsonObject> Observed = MakeShared<FJsonObject>();
    Observed->SetObjectField(TEXT("refund"), RefundDeliveryJson(Refund));
    Result.Observed = Observed;

    // Dismantling destroys the actor, so there is nothing left to restore. Say
    // so rather than offering an undo that cannot work.
    Result.bUndoable = false;
    Result.UndoDescription = TEXT(
        "Dismantling cannot be undone by this mod; the building would have to be rebuilt.");

    return Result;
}

FAIFactoryActionResult UndoLast(const FAIFactoryActionContext& Context)
{
    const FString Action = TEXT("undo_last");
    const FString Blocked = CheckActionPreconditions(Context);
    if (!Blocked.IsEmpty())
    {
        return FAIFactoryActionResult::Refuse(Action, Blocked);
    }
    if (GAIFactoryUndoJournal.Num() == 0)
    {
        return FAIFactoryActionResult::Refuse(Action, TEXT("nothing_to_undo"));
    }

    const FAIFactoryUndoStep& Step = GAIFactoryUndoJournal.Last();

    FAIFactoryActionResult Result;
    Result.Action = Action;
    Result.bAccepted = true;
    Result.bDryRun = Context.bDryRun;

    TSharedPtr<FJsonObject> Predicted = MakeShared<FJsonObject>();
    Predicted->SetStringField(TEXT("undoes_action"), Step.Action);
    Predicted->SetStringField(TEXT("description"), Step.Description);
    Predicted->SetNumberField(TEXT("buildings_to_remove"), Step.SpawnedBuildables.Num());
    Result.Predicted = Predicted;

    if (Context.bDryRun)
    {
        Result.Status = TEXT("dry_run");
        return Result;
    }

    int32 Removed = 0;
    int32 AlreadyGone = 0;
    int32 RefundedItemUnits = 0;
    int32 RefundedToInventory = 0;
    int32 RefundDropped = 0;
    TArray<AFGBuildable*> LiveBuildables;
    for (const TWeakObjectPtr<AFGBuildable>& Weak : Step.SpawnedBuildables)
    {
        AFGBuildable* Buildable = Weak.Get();
        if (!IsValid(Buildable))
        {
            // The player may have removed it already; that is not a failure.
            ++AlreadyGone;
            continue;
        }
        Result.RemovedActorIds.Add(Buildable->GetPathName());
        LiveBuildables.Add(Buildable);
    }

    int32 DismantleTargets = 0;
    for (const TWeakObjectPtr<AActor>& Weak : Step.DismantleActors)
    {
        AActor* Actor = Weak.Get();
        if (!IsValid(Actor))
        {
            continue;
        }
        if (!Cast<AFGBuildable>(Actor))
        {
            Result.RemovedActorIds.AddUnique(Actor->GetPathName());
        }
        const FAIFactoryRefundDelivery Refund =
            DismantleWithRefund(Actor, Context.Player);
        RefundedItemUnits += Refund.ItemUnits;
        RefundedToInventory += Refund.AddedToInventory;
        RefundDropped += Refund.DroppedOnGround;
        ++DismantleTargets;
    }
    if (DismantleTargets == 0)
    {
        // Older journal entries and a vanished blueprint proxy fall back to
        // dismantling each still-live buildable.
        for (AFGBuildable* Buildable : LiveBuildables)
        {
            if (!IsValid(Buildable))
            {
                continue;
            }
            const FAIFactoryRefundDelivery Refund =
                DismantleWithRefund(Buildable, Context.Player);
            RefundedItemUnits += Refund.ItemUnits;
            RefundedToInventory += Refund.AddedToInventory;
            RefundDropped += Refund.DroppedOnGround;
            ++DismantleTargets;
        }
    }
    Removed = LiveBuildables.Num();

    bool bPlayerMoved = false;
    if (Step.bHadPlayerTransform && Step.Player.IsValid())
    {
        bPlayerMoved = Step.Player->TeleportTo(
            Step.PreviousPlayerTransform.GetLocation(),
            Step.PreviousPlayerTransform.Rotator());
    }

    TSharedPtr<FJsonObject> Observed = MakeShared<FJsonObject>();
    Observed->SetNumberField(TEXT("buildings_removed"), Removed);
    Observed->SetNumberField(TEXT("dismantle_targets"), DismantleTargets);
    Observed->SetNumberField(TEXT("already_gone"), AlreadyGone);
    Observed->SetBoolField(TEXT("player_restored"), bPlayerMoved);
    Observed->SetNumberField(TEXT("refund_item_units"), RefundedItemUnits);
    Observed->SetNumberField(
        TEXT("refund_added_to_player_inventory"),
        RefundedToInventory);
    Observed->SetNumberField(TEXT("refund_dropped_on_ground"), RefundDropped);
    Result.Observed = Observed;

    GAIFactoryUndoJournal.Pop();
    Result.bCommitted = true;
    Result.Status = TEXT("committed");
    return Result;
}

const TArray<FAIFactoryUndoStep>& GetUndoJournal()
{
    return GAIFactoryUndoJournal;
}

void ClearUndoJournal()
{
    GAIFactoryUndoJournal.Reset();
}

namespace
{
    bool ActionKindChangesWorld(const FString& Kind)
    {
        return
            Kind == TEXT("teleport_player") ||
            Kind == TEXT("place_building") ||
            Kind == TEXT("place_blueprint") ||
            Kind == TEXT("dismantle") ||
            Kind == TEXT("undo_last");
    }

    bool TryReadActionVector(
        const TSharedPtr<FJsonObject>& Spec,
        const TCHAR* Field,
        const bool bRequireZ,
        FVector& Out)
    {
        const TSharedPtr<FJsonObject>* Object = nullptr;
        if (!Spec.IsValid() || !Spec->TryGetObjectField(Field, Object) || !Object)
        {
            return false;
        }
        double X = 0.0;
        double Y = 0.0;
        double Z = 0.0;
        if (!(*Object)->TryGetNumberField(TEXT("x"), X) ||
            !(*Object)->TryGetNumberField(TEXT("y"), Y) ||
            (bRequireZ && !(*Object)->TryGetNumberField(TEXT("z"), Z)))
        {
            return false;
        }
        if (!bRequireZ)
        {
            (*Object)->TryGetNumberField(TEXT("z"), Z);
        }
        Out = FVector(X, Y, Z);
        return !Out.ContainsNaN();
    }

    FAIFactoryActionResult RunActionSpec(
        const FAIFactoryActionContext& Context,
        const TSharedPtr<FJsonObject>& Spec)
    {
        FString Kind;
        if (!Spec.IsValid() || !Spec->TryGetStringField(TEXT("action"), Kind) || Kind.IsEmpty())
        {
            return FAIFactoryActionResult::Refuse(TEXT("unknown"), TEXT("missing_action_kind"));
        }

        if (Kind == TEXT("teleport_player"))
        {
            FVector Location;
            if (!TryReadActionVector(Spec, TEXT("target"), false, Location))
            {
                return FAIFactoryActionResult::Refuse(Kind, TEXT("target_must_be_an_xyz_object"));
            }
            bool bSnap = true;
            Spec->TryGetBoolField(TEXT("snap_to_ground"), bSnap);
            double Clearance = 200.0;
            Spec->TryGetNumberField(TEXT("snap_clearance_cm"), Clearance);
            return TeleportPlayer(Context, Location, bSnap, Clearance);
        }
        if (Kind == TEXT("place_building"))
        {
            FString RecipeClass;
            FVector Location;
            if (!Spec->TryGetStringField(TEXT("recipe_class"), RecipeClass) || RecipeClass.IsEmpty())
            {
                return FAIFactoryActionResult::Refuse(Kind, TEXT("recipe_class_is_required"));
            }
            if (!TryReadActionVector(Spec, TEXT("location"), true, Location))
            {
                return FAIFactoryActionResult::Refuse(
                    Kind,
                    TEXT("location_must_be_an_xyz_object_with_an_explicit_z"));
            }
            double Yaw = 0.0;
            Spec->TryGetNumberField(TEXT("yaw"), Yaw);
            bool bCheck = true;
            Spec->TryGetBoolField(TEXT("check_clearance"), bCheck);
            return PlaceBuilding(
                Context,
                RecipeClass,
                FTransform(FRotator(0.0, Yaw, 0.0), Location),
                bCheck);
        }
        if (Kind == TEXT("place_blueprint"))
        {
            FString Name;
            FVector Location;
            if (!Spec->TryGetStringField(TEXT("blueprint_name"), Name) || Name.IsEmpty())
            {
                return FAIFactoryActionResult::Refuse(Kind, TEXT("blueprint_name_is_required"));
            }
            if (!TryReadActionVector(Spec, TEXT("location"), true, Location))
            {
                return FAIFactoryActionResult::Refuse(
                    Kind,
                    TEXT("location_must_be_an_xyz_object_with_an_explicit_z"));
            }
            double Yaw = 0.0;
            Spec->TryGetNumberField(TEXT("yaw"), Yaw);
            return PlaceBlueprint(
                Context,
                Name,
                FTransform(FRotator(0.0, Yaw, 0.0), Location));
        }
        if (Kind == TEXT("dismantle"))
        {
            FString ActorId;
            if (!Spec->TryGetStringField(TEXT("actor_id"), ActorId) || ActorId.IsEmpty())
            {
                return FAIFactoryActionResult::Refuse(Kind, TEXT("actor_id_is_required"));
            }
            return DismantleActor(Context, ActorId);
        }
        if (Kind == TEXT("undo_last"))
        {
            return UndoLast(Context);
        }
        if (Kind == TEXT("highlight") || Kind == TEXT("clear_highlight"))
        {
            return RunOverlayAction(Context, Kind, Spec);
        }
        return FAIFactoryActionResult::Refuse(Kind, TEXT("unsupported_action"));
    }
}

FString ExecutePlan(
    UWorld* World,
    AFGCharacterPlayer* Player,
    const TArray<TSharedPtr<FJsonValue>>& Actions,
    bool bAllowCommit,
    const FString& ActualWorldRevision,
    TArray<TSharedPtr<FJsonValue>>& OutResults)
{
    if (Actions.Num() == 0)
    {
        return FString();
    }

    struct FPreparedAction
    {
        TSharedPtr<FJsonObject> Spec;
        FString Kind;
        bool bRequestedCommit = false;
        bool bWillCommitWrite = false;
        FAIFactoryActionResult Preflight;
    };

    TArray<FPreparedAction> Prepared;
    Prepared.Reserve(Actions.Num());
    int32 WillCommitWrites = 0;
    int32 IrreversibleWrites = 0;
    int32 UndoWrites = 0;
    FString PlanRefusal;

    for (const TSharedPtr<FJsonValue>& Value : Actions)
    {
        FPreparedAction& Item = Prepared.AddDefaulted_GetRef();
        const TSharedPtr<FJsonObject>* Spec = nullptr;
        if (!Value.IsValid() || !Value->TryGetObject(Spec) || !Spec)
        {
            Item.Preflight =
                FAIFactoryActionResult::Refuse(TEXT("unknown"), TEXT("action_is_not_an_object"));
            if (PlanRefusal.IsEmpty())
            {
                PlanRefusal = TEXT("one_or_more_actions_failed_preflight");
            }
            continue;
        }
        Item.Spec = *Spec;
        Item.Spec->TryGetStringField(TEXT("action"), Item.Kind);
        Item.Spec->TryGetBoolField(TEXT("commit"), Item.bRequestedCommit);
        Item.bWillCommitWrite =
            bAllowCommit &&
            Item.bRequestedCommit &&
            ActionKindChangesWorld(Item.Kind);
        if (Item.bWillCommitWrite)
        {
            ++WillCommitWrites;
            if (Item.Kind == TEXT("dismantle"))
            {
                ++IrreversibleWrites;
            }
            if (Item.Kind == TEXT("undo_last"))
            {
                ++UndoWrites;
            }
            FString ExpectedRevision;
            Item.Spec->TryGetStringField(TEXT("expect_world_revision"), ExpectedRevision);
            if (ExpectedRevision.IsEmpty() && PlanRefusal.IsEmpty())
            {
                PlanRefusal = TEXT("committed_write_missing_expect_world_revision");
            }
        }
    }

    if (IrreversibleWrites > 0 && WillCommitWrites > 1)
    {
        PlanRefusal = TEXT("irreversible_dismantle_must_be_a_standalone_commit");
    }
    if (UndoWrites > 0 && WillCommitWrites > 1)
    {
        PlanRefusal = TEXT("undo_must_be_a_standalone_commit");
    }

    // Preflight every write before the first mutation. A malformed final step
    // therefore cannot leave the beginning of a layout standing.
    for (FPreparedAction& Item : Prepared)
    {
        if (!Item.Spec.IsValid())
        {
            continue;
        }
        if (Item.Kind == TEXT("highlight") || Item.Kind == TEXT("clear_highlight"))
        {
            Item.Preflight.Action = Item.Kind;
            Item.Preflight.bAccepted = true;
            Item.Preflight.bDryRun = true;
            Item.Preflight.Status = TEXT("preflight_not_required_for_overlay");
            continue;
        }

        FAIFactoryActionContext Context;
        Context.World = World;
        Context.Player = Player;
        Context.ActualWorldRevision = ActualWorldRevision;
        Context.bDryRun = true;
        Item.Spec->TryGetStringField(TEXT("expect_world_revision"), Context.ExpectedWorldRevision);
        Item.Preflight = RunActionSpec(Context, Item.Spec);
        if (!Item.Preflight.bAccepted && PlanRefusal.IsEmpty())
        {
            PlanRefusal = TEXT("one_or_more_actions_failed_preflight");
        }
    }

    if (!PlanRefusal.IsEmpty())
    {
        bool bReportedCause = false;
        for (const FPreparedAction& Item : Prepared)
        {
            FAIFactoryActionResult Result = Item.Preflight;
            if (!bReportedCause && !Result.bAccepted)
            {
                bReportedCause = true;
            }
            else
            {
                Result = FAIFactoryActionResult::Refuse(
                    Item.Kind.IsEmpty() ? TEXT("unknown") : Item.Kind,
                    bReportedCause
                        ? TEXT("skipped_because_plan_preflight_failed")
                        : PlanRefusal);
                Result.Status = TEXT("skipped");
            }
            OutResults.Add(MakeShared<FJsonValueObject>(ResultToJson(Result)));
        }
        return FString::Printf(
            TEXT("[actions] 0 committed, plan refused before mutation: %s"),
            *PlanRefusal);
    }

    const int32 UndoJournalStart = GAIFactoryUndoJournal.Num();
    int32 Committed = 0;
    int32 CommittedWrites = 0;
    int32 DryRun = 0;
    int32 Refused = 0;
    int32 Skipped = 0;
    int32 RolledBack = 0;
    FString FirstFailure;

    for (int32 Index = 0; Index < Prepared.Num(); ++Index)
    {
        const FPreparedAction& Item = Prepared[Index];

        // Once a step has failed the rest of the plan is no longer the plan the
        // model designed, so report the remainder as skipped instead of running it.
        if (!FirstFailure.IsEmpty())
        {
            FAIFactoryActionResult Stop = FAIFactoryActionResult::Refuse(
                Item.Kind.IsEmpty() ? TEXT("unknown") : Item.Kind,
                TEXT("skipped_because_an_earlier_step_failed"));
            Stop.Status = TEXT("skipped");
            OutResults.Add(MakeShared<FJsonValueObject>(ResultToJson(Stop)));
            ++Skipped;
            continue;
        }

        FAIFactoryActionContext Context;
        Context.World = World;
        Context.Player = Player;
        Context.ActualWorldRevision = ActualWorldRevision;
        Item.Spec->TryGetStringField(TEXT("expect_world_revision"), Context.ExpectedWorldRevision);

        // The reply may request a commit, but only the game side can grant one.
        Context.bDryRun = !(bAllowCommit && Item.bRequestedCommit);
        FAIFactoryActionResult Result = Context.bDryRun && ActionKindChangesWorld(Item.Kind)
            ? Item.Preflight
            : RunActionSpec(Context, Item.Spec);
        TSharedPtr<FJsonObject> ResultObject = ResultToJson(Result);
        OutResults.Add(MakeShared<FJsonValueObject>(ResultObject));

        if (Result.bCommitted)
        {
            ++Committed;
            if (ActionKindChangesWorld(Item.Kind))
            {
                ++CommittedWrites;
            }
        }
        else if (Result.Status == TEXT("dry_run"))
        {
            ++DryRun;
        }
        else
        {
            ++Refused;
            FirstFailure = FString::Printf(
                TEXT("step %d (%s): %s"),
                Index + 1,
                *Result.Action,
                *Result.Reason);
        }
    }

    if (!FirstFailure.IsEmpty() && CommittedWrites > 0)
    {
        RolledBack = RollBackActionUndoFrom(UndoJournalStart);
        for (const TSharedPtr<FJsonValue>& Value : OutResults)
        {
            const TSharedPtr<FJsonObject>* Object = nullptr;
            if (Value.IsValid() && Value->TryGetObject(Object) && Object)
            {
                bool bWasCommitted = false;
                FString ResultKind;
                (*Object)->TryGetBoolField(TEXT("committed"), bWasCommitted);
                (*Object)->TryGetStringField(TEXT("action"), ResultKind);
                if (bWasCommitted && ActionKindChangesWorld(ResultKind))
                {
                    (*Object)->SetBoolField(TEXT("committed"), false);
                    (*Object)->SetBoolField(TEXT("rolled_back"), true);
                    (*Object)->SetStringField(TEXT("status"), TEXT("rolled_back"));
                }
            }
        }
        Committed -= CommittedWrites;
        CommittedWrites = 0;
    }
    else if (FirstFailure.IsEmpty() && CommittedWrites > 0)
    {
        ConsolidateActionUndoFrom(UndoJournalStart, CommittedWrites);
    }

    FString Summary = FString::Printf(
        TEXT("[actions] %d committed, %d previewed, %d refused"),
        Committed,
        DryRun,
        Refused);
    if (Skipped > 0)
    {
        Summary += FString::Printf(TEXT(", %d skipped"), Skipped);
    }
    if (RolledBack > 0)
    {
        Summary += FString::Printf(TEXT(", %d effects rolled back"), RolledBack);
    }
    if (!FirstFailure.IsEmpty())
    {
        Summary += FString::Printf(TEXT(" — stopped at %s"), *FirstFailure);
    }
    if (CommittedWrites > 0 && GAIFactoryUndoJournal.Num() > UndoJournalStart)
    {
        Summary += TEXT(" (say \"undo\" to reverse this transaction)");
    }
    return Summary;
}

TSharedPtr<FJsonObject> ResultToJson(const FAIFactoryActionResult& Result)
{
    TSharedPtr<FJsonObject> Object = MakeShared<FJsonObject>();
    Object->SetStringField(TEXT("action"), Result.Action);
    Object->SetStringField(TEXT("status"), Result.Status);
    Object->SetBoolField(TEXT("accepted"), Result.bAccepted);
    Object->SetBoolField(TEXT("committed"), Result.bCommitted);
    Object->SetBoolField(TEXT("dry_run"), Result.bDryRun);
    if (!Result.Reason.IsEmpty())
    {
        Object->SetStringField(TEXT("reason"), Result.Reason);
    }
    if (Result.Predicted.IsValid())
    {
        Object->SetObjectField(TEXT("predicted"), Result.Predicted);
    }
    if (Result.Observed.IsValid())
    {
        Object->SetObjectField(TEXT("observed"), Result.Observed);
    }

    TArray<TSharedPtr<FJsonValue>> Created;
    for (const FString& Id : Result.CreatedActorIds)
    {
        Created.Add(MakeShared<FJsonValueString>(Id));
    }
    Object->SetArrayField(TEXT("created_actor_ids"), Created);

    TArray<TSharedPtr<FJsonValue>> RemovedIds;
    for (const FString& Id : Result.RemovedActorIds)
    {
        RemovedIds.Add(MakeShared<FJsonValueString>(Id));
    }
    Object->SetArrayField(TEXT("removed_actor_ids"), RemovedIds);

    TArray<TSharedPtr<FJsonValue>> Warnings;
    for (const FString& Warning : Result.Warnings)
    {
        Warnings.Add(MakeShared<FJsonValueString>(Warning));
    }
    Object->SetArrayField(TEXT("warnings"), Warnings);

    Object->SetBoolField(TEXT("undoable"), Result.bUndoable);
    if (!Result.UndoDescription.IsEmpty())
    {
        Object->SetStringField(TEXT("undo"), Result.UndoDescription);
    }
    Object->SetNumberField(TEXT("undo_steps_available"), GAIFactoryUndoJournal.Num());
    Object->SetStringField(TEXT("source"), TEXT("executed_by_the_game_and_read_back"));
    return Object;
}

}
