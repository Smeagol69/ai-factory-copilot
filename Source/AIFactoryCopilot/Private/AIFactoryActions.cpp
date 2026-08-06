#include "AIFactoryActions.h"
#include "AIFactoryWaypointDisplay.h"

#include "AIFactoryOverlay.h"
#include "AIFactoryTerrain.h"
#include "Buildables/FGBuildable.h"
#include "CollisionQueryParams.h"
#include "Components/PrimitiveComponent.h"
#include "Engine/World.h"
#include "EngineUtils.h"
#include "Equipment/FGBuildGun.h"
#include "FGBlueprintProxy.h"
#include "FGBlueprintSettings.h"
#include "FGBlueprintSubsystem.h"
#include "FGBuildableSubsystem.h"
#include "FGCharacterPlayer.h"
#include "FGMapManager.h"
#include "FGMapMarker.h"
#include "FGConstructDisqualifier.h"
#include "FGDismantleInterface.h"
#include "FGFactoryConnectionComponent.h"
#include "FGInventoryComponent.h"
#include "FGRecipe.h"
#include "FGRecipeManager.h"
#include "Hologram/FGBlueprintHologram.h"
#include "Hologram/FGConveyorBeltHologram.h"
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

    /**
     * Suppresses history trimming while a plan is mid-flight.
     *
     * A transaction remembers where it began as an *index* into the journal,
     * and trimming removes from the front, which shifts every index down. At
     * capacity that silently repoints the transaction: rollback starts too late
     * and leaves its own first placement standing in the world while reporting
     * that it rolled back — the worst kind of wrong, because the report is
     * confident.
     *
     * So the cap is enforced at transaction boundaries rather than on every
     * insert. The journal may sit a few entries over its limit for the duration
     * of one plan, bounded by MaxActionsPerReply, which costs nothing.
     *
     * Found by Codex during a release audit of this file; see
     * docs/ai-collaboration.md.
     */
    int32 GAIFactoryUndoTrimSuspensions = 0;

    void TrimActionUndoJournal()
    {
        if (GAIFactoryUndoTrimSuspensions > 0)
        {
            return;
        }
        while (GAIFactoryUndoJournal.Num() > MaximumActionUndoSteps)
        {
            GAIFactoryUndoJournal.RemoveAt(0);
        }
    }

    /** Holds journal indices stable for the lifetime of one plan. */
    struct FAIFactoryUndoTrimGuard
    {
        FAIFactoryUndoTrimGuard() { ++GAIFactoryUndoTrimSuspensions; }
        ~FAIFactoryUndoTrimGuard()
        {
            --GAIFactoryUndoTrimSuspensions;
            TrimActionUndoJournal();
        }
        FAIFactoryUndoTrimGuard(const FAIFactoryUndoTrimGuard&) = delete;
        FAIFactoryUndoTrimGuard& operator=(const FAIFactoryUndoTrimGuard&) = delete;
    };

    void RecordActionUndo(FAIFactoryUndoStep&& Step)
    {
        Step.RecordedAt = FDateTime::UtcNow();
        GAIFactoryUndoJournal.Add(MoveTemp(Step));
        TrimActionUndoJournal();
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
            // Items handed over are taken back, capped at what is still held
            // so undo can never confiscate a stack the player earned.
            for (const TPair<TSubclassOf<UFGItemDescriptor>, int32>& Granted : Step.GrantedItems)
            {
                if (!Granted.Key || Granted.Value <= 0 || !Step.Player.IsValid())
                {
                    continue;
                }
                if (UFGInventoryComponent* Inventory = Step.Player->GetInventory(); IsValid(Inventory))
                {
                    const int32 ToRemove = FMath::Min(Granted.Value, Inventory->GetNumItems(Granted.Key));
                    if (ToRemove > 0)
                    {
                        Inventory->Remove(Granted.Key, ToRemove);
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
            Batch.GrantedItems.Append(Step.GrantedItems);
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

    /**
     * A hit that names the actor a building is being placed *on*.
     *
     * A downward trace finds a surface, not a target. Placing a miner on
     * BP_ResourceNode213 traced onto StaticMeshActor_8276 -- the terrain mesh
     * beside the node -- so the hologram sat in the right place attached to a
     * rock, never bound to the node, and refused with FGCDInitializing. The
     * position was never the problem, which is why it looked correct.
     *
     * Same shape as MakeActionConnectionHit, and for the same reason: when the
     * caller already knows the actor, saying so beats hoping a trace lands on
     * it.
     */
    FHitResult MakeActorPlacementHit(AActor* Target, const FVector& Location)
    {
        FHitResult Hit;
        Hit.bBlockingHit = true;
        Hit.ImpactPoint = Location;
        Hit.Location = Location;
        Hit.TraceStart = Location + FVector(0.0, 0.0, 500.0);
        Hit.TraceEnd = Location - FVector(0.0, 0.0, 500.0);
        Hit.ImpactNormal = FVector::UpVector;
        Hit.Normal = Hit.ImpactNormal;
        Hit.HitObjectHandle = FActorInstanceHandle(Target);
        if (IsValid(Target))
        {
            Hit.Component = Target->FindComponentByClass<UPrimitiveComponent>();
        }
        return Hit;
    }

    bool PositionAndValidateActionHologram(
        AFGHologram* Hologram,
        UWorld* World,
        AFGCharacterPlayer* Player,
        UFGInventoryComponent* Inventory,
        const FTransform& Requested,
        AActor* PlacementTarget,
        const TSharedPtr<FJsonObject>& Predicted,
        FString& OutFailure)
    {
        if (!IsValid(Hologram))
        {
            OutFailure = TEXT("hologram_spawn_failed");
            return false;
        }

        FHitResult Hit;
        if (IsValid(PlacementTarget))
        {
            // The caller named what this goes on, so hand the hologram that
            // rather than whatever a trace happens to strike first.
            Hit = MakeActorPlacementHit(PlacementTarget, Requested.GetLocation());
            Predicted->SetStringField(
                TEXT("placement_target_actor"),
                PlacementTarget->GetPathName());
        }
        else if (!TraceActionPlacementSurface(
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
        // Ask the hologram to snap before positioning it, the same way the
        // build gun does, and the same way the belt path had to learn to.
        //
        // A miner on a resource node came back
        // `hologram_disqualified:FGCDInitializing` from a live save: the
        // hologram was still waiting to be told what it sits on.
        // `UpdateHologramPlacement` alone does not tell it.
        // AFGResourceExtractorHologram overrides `TrySnapToActor` for exactly
        // this -- binding itself to the node under the hit -- and without the
        // call it never binds, so it never finishes initialising and refuses.
        //
        // Not a refusal when it returns false: most buildings do not snap to
        // anything, and a foundation on open ground is the normal case. The
        // answer is recorded instead, so a building that *should* have snapped
        // and did not is visible in the reply rather than inferred from a
        // downstream failure.
        const bool bSnappedToTarget = Hologram->TrySnapToActor(Hit);
        Predicted->SetBoolField(TEXT("snap_accepted"), bSnappedToTarget);
        Hologram->UpdateHologramPlacement(Hit);

        // Rotate through the hologram's own scroll input, measuring the result
        // after each step rather than predicting it.
        //
        // The obvious implementation — read GetRotationStep(), divide, scroll
        // that many ticks — was wrong twice. The header is explicit that the
        // return is "the overridden rotation step size to use when rotating. 0
        // or negative means no override", so a zero step means *use the default
        // granularity*, not "this building cannot rotate". Treating zero as
        // "cannot rotate" is what made "place a miner on this node facing
        // north" fail outright with hologram_has_no_rotation_step. Assuming a
        // default granularity instead would just be a different guess.
        //
        // So this scrolls one tick at a time and reads the actual yaw back. It
        // discovers the granularity by observation, stops as soon as the
        // requested yaw is reached, and detects a genuinely unrotatable
        // hologram by the yaw not moving at all. Bounded by a full revolution
        // so a hologram with a tiny step cannot spin here forever.
        //
        // Caught by Codex against the official 491125 headers; see
        // docs/ai-collaboration.md.
        const double RequestedYaw = Requested.Rotator().Yaw;
        constexpr double YawToleranceDegrees = 0.5;
        constexpr int32 MaximumRotationScrolls = 360;

        const auto CurrentYawError = [&]()
        {
            return FRotator::NormalizeAxis(RequestedYaw - Hologram->GetActorRotation().Yaw);
        };

        double YawError = CurrentYawError();
        double BestYawError = YawError;
        int32 ScrollsApplied = 0;
        bool bRotationUnavailable = false;

        while (FMath::Abs(YawError) > YawToleranceDegrees && ScrollsApplied < MaximumRotationScrolls)
        {
            const double YawBeforeScroll = Hologram->GetActorRotation().Yaw;
            Hologram->Scroll(1);
            Hologram->UpdateHologramPlacement(Hit);
            ++ScrollsApplied;

            const double YawAfterScroll = Hologram->GetActorRotation().Yaw;
            if (FMath::IsNearlyEqual(YawBeforeScroll, YawAfterScroll, 1.e-3))
            {
                // Scrolling moved nothing, so this hologram really is fixed —
                // a miner snaps to its node, a wall to its frame. The player
                // asked for the building; the yaw was never theirs to choose.
                bRotationUnavailable = true;
                break;
            }

            YawError = CurrentYawError();
            if (FMath::Abs(YawError) < FMath::Abs(BestYawError))
            {
                BestYawError = YawError;
            }
        }

        Predicted->SetObjectField(
            TEXT("hologram_transform"),
            ActionTransformJson(Hologram->GetActorTransform()));
        Predicted->SetNumberField(TEXT("hologram_yaw_error_degrees"), YawError);
        Predicted->SetNumberField(TEXT("hologram_rotation_scrolls"), ScrollsApplied);

        if (bRotationUnavailable)
        {
            Predicted->SetBoolField(TEXT("rotation_ignored"), true);
            Predicted->SetStringField(
                TEXT("rotation_ignored_reason"),
                FString::Printf(
                    TEXT("This building's orientation is fixed by what it snaps to, so scrolling "
                         "does not turn it. Requested yaw %.1f, placed at %.1f."),
                    RequestedYaw,
                    Hologram->GetActorRotation().Yaw));
        }
        else if (FMath::Abs(YawError) > YawToleranceDegrees)
        {
            // It rotates, but not onto the requested angle. Report the closest
            // it can reach instead of refusing: the player asked for a building
            // and the exact facing is a preference the game does not offer.
            Predicted->SetBoolField(TEXT("rotation_approximated"), true);
            Predicted->SetStringField(
                TEXT("rotation_approximated_reason"),
                FString::Printf(
                    TEXT("The nearest angle this building can hold is %.1f, %.1f off the "
                         "requested %.1f."),
                    Hologram->GetActorRotation().Yaw,
                    FMath::Abs(YawError),
                    RequestedYaw));
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
        // Drift is always reported, but only refuses the action when the caller
        // asked for it. Refusing on any drift made writes impossible in a live
        // game — a real build failed with expected=569 actual=600 purely because
        // belts were moving while the model was thinking.
        if (Context.bRequireUnchangedWorld &&
            !Context.ExpectedWorldRevision.IsEmpty() &&
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

    /**
     * `waypoint` / `clear_waypoints`, using the game's own map markers.
     *
     * The drawn overlay is the right tool for "show me every beryl nut in 100 m"
     * — many targets, seen at once, gone when you clear them. It is the wrong
     * tool for "mark the best HUB site", because the game already has a marker
     * system that puts a pin on the map and a bearing with a live distance
     * readout on the compass, exactly like the resource scanner. Reimplementing
     * that would be worse than using it.
     *
     * Markers are saved with the world, so they survive a reload — which is why
     * this reports the marker's GUID and offers a targeted clear rather than
     * only clearing everything.
     */
    FAIFactoryActionResult RunWaypointAction(
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

        AFGMapManager* MapManager = AFGMapManager::Get(Context.World);
        if (!IsValid(MapManager))
        {
            return FAIFactoryActionResult::Refuse(Kind, TEXT("map_manager_unavailable"));
        }

        if (Kind == TEXT("clear_waypoints"))
        {
            FString NameFilter;
            Spec->TryGetStringField(TEXT("name_contains"), NameFilter);

            TArray<FMapMarker> Markers;
            MapManager->GetMapMarkers(Markers);

            TArray<FMapMarker> Matching;
            for (const FMapMarker& Marker : Markers)
            {
                // Only markers this copilot placed are removable: the player's
                // own pins are not ours to delete.
                const bool bIsOurs = Marker.CategoryName == AIFactoryWaypointDisplay::Category;
                const bool bMatchesName =
                    NameFilter.IsEmpty() || Marker.Name.Contains(NameFilter);
                if (bIsOurs && bMatchesName)
                {
                    Matching.Add(Marker);
                }
            }

            // A map marker is saved with the world, so removing one is a real
            // deletion and a dry run must not perform it. This path deleted
            // regardless of bDryRun, which made "show me what this would do"
            // destructive. Found by Codex during a release audit.
            if (Context.bDryRun)
            {
                TSharedPtr<FJsonObject> Predicted = MakeShared<FJsonObject>();
                Predicted->SetNumberField(TEXT("waypoints_would_be_removed"), Matching.Num());
                Predicted->SetNumberField(TEXT("markers_now"), MapManager->GetNumMapMarkers());
                Result.Predicted = Predicted;
                Result.bAccepted = true;
                Result.bDryRun = true;
                Result.Status = TEXT("dry_run");
                return Result;
            }

            for (const FMapMarker& Marker : Matching)
            {
                MapManager->RemoveMapMarker(Marker);
            }

            TSharedPtr<FJsonObject> Observed = MakeShared<FJsonObject>();
            Observed->SetNumberField(TEXT("waypoints_removed"), Matching.Num());
            Observed->SetNumberField(TEXT("markers_left"), MapManager->GetNumMapMarkers());
            Result.Observed = Observed;
            Result.bAccepted = true;
            Result.bCommitted = true;
            Result.Status = Matching.Num() > 0 ? TEXT("committed") : TEXT("nothing_to_clear");
            Result.UndoDescription = TEXT("Removed map markers are not restored by undo.");
            return Result;
        }

        const TSharedPtr<FJsonObject>* LocationJson = nullptr;
        if (!Spec->TryGetObjectField(TEXT("location"), LocationJson) || !LocationJson)
        {
            return FAIFactoryActionResult::Refuse(Kind, TEXT("location_is_required"));
        }
        double LocationX = 0.0;
        double LocationY = 0.0;
        double LocationZ = 0.0;
        if (!(*LocationJson)->TryGetNumberField(TEXT("x"), LocationX) ||
            !(*LocationJson)->TryGetNumberField(TEXT("y"), LocationY) ||
            !(*LocationJson)->TryGetNumberField(TEXT("z"), LocationZ))
        {
            return FAIFactoryActionResult::Refuse(Kind, TEXT("location_must_be_an_xyz_object"));
        }
        const FVector Location(LocationX, LocationY, LocationZ);
        if (Location.ContainsNaN())
        {
            return FAIFactoryActionResult::Refuse(Kind, TEXT("location_is_not_a_number"));
        }

        if (!MapManager->CanAddNewMapMarker())
        {
            return FAIFactoryActionResult::Refuse(Kind, TEXT("map_marker_limit_reached"));
        }

        FMapMarker Marker;
        Marker.Location = Location;
        Marker.Name = TEXT("Copilot waypoint");
        Spec->TryGetStringField(TEXT("name"), Marker.Name);
        Marker.CategoryName = AIFactoryWaypointDisplay::Category;
        Marker.MapMarkerType = ERepresentationType::RT_MapMarker;
        Marker.Color = FLinearColor(0.1f, 0.8f, 1.0f, 1.0f);
        Marker.Scale = 1.0f;
        // The point of using the game's markers is the compass readout, so it is
        // on by default rather than left at the struct's CVD_Off.
        Marker.CompassViewDistance = ECompassViewDistance::CVD_Always;

        if (IsValid(Context.Player))
        {
            Marker.Name = AIFactoryWaypointDisplay::FormatName(
                Marker.Name,
                Context.Player->GetActorLocation(),
                Location);
        }

        int32 IconId = 0;
        if (Spec->TryGetNumberField(TEXT("icon_id"), IconId))
        {
            Marker.IconID = IconId;
        }

        if (Context.bDryRun)
        {
            TSharedPtr<FJsonObject> Predicted = MakeShared<FJsonObject>();
            Predicted->SetStringField(TEXT("name"), Marker.Name);
            Predicted->SetObjectField(TEXT("location"), ActionVectorJson(Location));
            Predicted->SetStringField(TEXT("shown_on"), TEXT("map and compass, with live distance"));
            Result.Predicted = Predicted;
            Result.bAccepted = true;
            Result.bDryRun = true;
            Result.Status = TEXT("dry_run");
            return Result;
        }

        FMapMarker Created;
        if (!MapManager->AddNewMapMarker(Marker, Created))
        {
            return FAIFactoryActionResult::Refuse(Kind, TEXT("game_refused_the_map_marker"));
        }

        TSharedPtr<FJsonObject> Observed = MakeShared<FJsonObject>();
        Observed->SetStringField(TEXT("marker_guid"), Created.MarkerGUID.ToString());
        Observed->SetStringField(TEXT("name"), Created.Name);
        Observed->SetObjectField(TEXT("location"), ActionVectorJson(Created.Location));
        if (IsValid(Context.Player))
        {
            Observed->SetNumberField(
                TEXT("distance_m"),
                FVector::Dist(Context.Player->GetActorLocation(), FVector(Created.Location)) / 100.0);
        }
        Observed->SetNumberField(TEXT("total_markers"), MapManager->GetNumMapMarkers());
        Observed->SetStringField(
            TEXT("visible_on"),
            TEXT("The map and the compass, with the game's own live distance readout."));
        Result.Observed = Observed;
        Result.bAccepted = true;
        Result.bCommitted = true;
        Result.Status = TEXT("committed");
        return Result;
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
    bool bCheckClearance,
    const FString& PlacementTargetActorId)
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

    // Resolving here rather than in the hologram helper keeps the refusal
    // specific: a target that was named and cannot be found is a different
    // fault from one that was never named, and only the first is a mistake.
    AActor* PlacementTarget = nullptr;
    if (!PlacementTargetActorId.IsEmpty())
    {
        PlacementTarget = FindActionActorByPathName(Context.World, PlacementTargetActorId);
        if (!IsValid(PlacementTarget))
        {
            return FAIFactoryActionResult::Refuse(
                Action,
                TEXT("placement_target_actor_not_found:") + PlacementTargetActorId);
        }
    }

    FString HologramFailure;
    const bool bHologramValid = PositionAndValidateActionHologram(
        Hologram,
        Context.World,
        Context.Player,
        Inventory,
        Target,
        PlacementTarget,
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
        // A blueprint is placed on ground, not onto a named actor, so it keeps
        // the downward trace.
        nullptr,
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

FAIFactoryActionResult GiveItem(
    const FAIFactoryActionContext& Context,
    const FString& ItemClassPath,
    const int32 Count)
{
    const FString Action = TEXT("give_item");
    const FString Blocked = CheckActionPreconditions(Context);
    if (!Blocked.IsEmpty())
    {
        return FAIFactoryActionResult::Refuse(Action, Blocked);
    }
    if (Count <= 0)
    {
        return FAIFactoryActionResult::Refuse(Action, TEXT("count_must_be_positive"));
    }

    UClass* ItemClass = FindActionClassByPath(ItemClassPath);
    if (!ItemClass || !ItemClass->IsChildOf(UFGItemDescriptor::StaticClass()))
    {
        // Naming an item that does not exist must fail loudly. Adding nothing
        // and reporting success is the failure mode that wastes the most time.
        return FAIFactoryActionResult::Refuse(
            Action,
            TEXT("item_class_did_not_resolve_to_an_item_descriptor"));
    }
    const TSubclassOf<UFGItemDescriptor> Descriptor{ ItemClass };

    UFGInventoryComponent* Inventory = Context.Player->GetInventory();
    if (!IsValid(Inventory))
    {
        return FAIFactoryActionResult::Refuse(Action, TEXT("player_has_no_inventory"));
    }

    const FString DisplayName = UFGItemDescriptor::GetItemName(Descriptor).ToString();
    const int32 HeldBefore = Inventory->GetNumItems(Descriptor);

    FAIFactoryActionResult Result;
    Result.Action = Action;

    const TSharedRef<FJsonObject> Predicted = MakeShared<FJsonObject>();
    Predicted->SetStringField(TEXT("item_class"), ItemClass->GetPathName());
    Predicted->SetStringField(TEXT("item_name"), DisplayName);
    Predicted->SetNumberField(TEXT("requested"), Count);
    Predicted->SetNumberField(TEXT("held_before"), HeldBefore);
    Result.Predicted = Predicted;

    if (Context.bDryRun)
    {
        Result.bAccepted = true;
        Result.bDryRun = true;
        Result.Status = TEXT("dry_run");
        return Result;
    }

    // Partial adds are allowed: a nearly full inventory is an ordinary
    // situation, and the count that actually landed is read back rather than
    // assumed, so undo can take back exactly that many and no more.
    const FInventoryStack Stack(Count, Descriptor);
    const int32 Added = Inventory->AddStack(Stack, /*allowPartialAdd*/ true);

    const int32 HeldAfter = Inventory->GetNumItems(Descriptor);
    const TSharedRef<FJsonObject> Observed = MakeShared<FJsonObject>();
    Observed->SetStringField(TEXT("item_class"), ItemClass->GetPathName());
    Observed->SetStringField(TEXT("item_name"), DisplayName);
    Observed->SetNumberField(TEXT("requested"), Count);
    Observed->SetNumberField(TEXT("added"), Added);
    Observed->SetNumberField(TEXT("held_before"), HeldBefore);
    Observed->SetNumberField(TEXT("held_after"), HeldAfter);
    Result.Observed = Observed;

    if (Added <= 0)
    {
        Result.bAccepted = true;
        Result.Status = TEXT("no_space_in_inventory");
        Result.Reason = TEXT("inventory_is_full");
        return Result;
    }
    if (Added < Count)
    {
        Result.Warnings.Add(FString::Printf(
            TEXT("Only %d of the %d requested fitted; the inventory filled up."),
            Added,
            Count));
    }

    FAIFactoryUndoStep Step;
    Step.Action = Action;
    Step.Player = Context.Player;
    Step.GrantedItems.Add(TPair<TSubclassOf<UFGItemDescriptor>, int32>(Descriptor, Added));
    Step.Description = FString::Printf(TEXT("Take back %d %s."), Added, *DisplayName);

    Result.bAccepted = true;
    Result.bCommitted = true;
    Result.Status = TEXT("committed");
    Result.bUndoable = true;
    Result.UndoDescription = Step.Description;
    RecordActionUndo(MoveTemp(Step));

    return Result;
}

/**
 * Resolves an exported connection component path back to the live component.
 *
 * The scanner exports `GetPathName()`, so the same string round-trips through
 * `FindObject`. A path that no longer resolves means the machine was dismantled
 * between the snapshot and the write, which is a refusal, not a retry.
 */
UFGFactoryConnectionComponent* FindActionFactoryConnection(const FString& ComponentPath)
{
    if (ComponentPath.IsEmpty())
    {
        return nullptr;
    }
    return FindObject<UFGFactoryConnectionComponent>(nullptr, *ComponentPath);
}

/**
 * A hit result aimed at a connection, shaped the way the build gun would.
 *
 * The conveyor hologram snaps to connections by inspecting the hit actor near
 * the impact point. Factory connections derive from USceneComponent and cannot
 * be stored in FHitResult::Component, but a real build-gun trace also carries
 * the machine primitive it hit. Preserve that part of the contract with an
 * actual UPrimitiveComponent owned by the connection's buildable.
 */
FHitResult MakeActionConnectionHit(UFGFactoryConnectionComponent* Connection)
{
    FHitResult Hit;
    Hit.bBlockingHit = true;
    const FVector Location = Connection->GetConnectorLocation(false);
    Hit.ImpactPoint = Location;
    Hit.Location = Location;
    Hit.TraceStart = Location + Connection->GetConnectorNormal() * 100.0;
    Hit.TraceEnd = Location;
    Hit.ImpactNormal = Connection->GetConnectorNormal();
    Hit.Normal = Hit.ImpactNormal;
    AActor* Owner = Connection->GetOwner();
    Hit.HitObjectHandle = FActorInstanceHandle(Owner);
    if (IsValid(Owner))
    {
        Hit.Component = Owner->FindComponentByClass<UPrimitiveComponent>();
    }
    return Hit;
}

/**
 * The first free conveyor port of the wanted direction on a named actor.
 *
 * Used when a belt addresses machines rather than components, which is the only
 * way to plan a belt for a machine that does not exist yet. "First free" is
 * deliberate and reported: a machine with several free inputs has no preference
 * this layer can know, and picking one is better than refusing a whole module
 * over an ambiguity the player does not care about.
 */
UFGFactoryConnectionComponent* FindFreeActionConnection(
    const FString& ActorId,
    const EFactoryConnectionDirection Wanted)
{
    AActor* Actor = FindObject<AActor>(nullptr, *ActorId);
    if (!IsValid(Actor))
    {
        return nullptr;
    }

    TInlineComponentArray<UFGFactoryConnectionComponent*> Connections;
    Actor->GetComponents(Connections);
    for (UFGFactoryConnectionComponent* Connection : Connections)
    {
        if (!IsValid(Connection) || Connection->IsConnected())
        {
            continue;
        }
        const EFactoryConnectionDirection Direction = Connection->GetDirection();
        if (Direction == Wanted || Direction == EFactoryConnectionDirection::FCD_ANY)
        {
            return Connection;
        }
    }
    return nullptr;
}

FAIFactoryActionResult PlaceBelt(
    const FAIFactoryActionContext& Context,
    const FString& RecipeClassPath,
    const FString& FromConnectionComponent,
    const FString& ToConnectionComponent,
    const FString& FromActorId,
    const FString& ToActorId)
{
    const FString Action = TEXT("place_belt");
    const FString Blocked = CheckActionPreconditions(Context);
    if (!Blocked.IsEmpty())
    {
        return FAIFactoryActionResult::Refuse(Action, Blocked);
    }

    UFGFactoryConnectionComponent* From = FindActionFactoryConnection(FromConnectionComponent);
    UFGFactoryConnectionComponent* To = FindActionFactoryConnection(ToConnectionComponent);

    // Fall back to picking a port off a named actor.
    //
    // A belt planned before its machines exist cannot name their connection
    // components, because those components do not exist yet. Addressing the
    // actor instead lets one transaction place a machine and belt it, with the
    // executor choosing the free port at the moment it runs — which is also the
    // only moment the answer is knowable.
    if (!IsValid(From) && !FromActorId.IsEmpty())
    {
        From = FindFreeActionConnection(FromActorId, EFactoryConnectionDirection::FCD_OUTPUT);
    }
    if (!IsValid(To) && !ToActorId.IsEmpty())
    {
        To = FindFreeActionConnection(ToActorId, EFactoryConnectionDirection::FCD_INPUT);
    }
    if (!IsValid(From))
    {
        return FAIFactoryActionResult::Refuse(Action, TEXT("from_connection_did_not_resolve"));
    }
    if (!IsValid(To))
    {
        return FAIFactoryActionResult::Refuse(Action, TEXT("to_connection_did_not_resolve"));
    }
    if (From == To)
    {
        return FAIFactoryActionResult::Refuse(Action, TEXT("a_belt_needs_two_different_connections"));
    }

    // An occupied port is the most common reason a planned route cannot be
    // built: the plan was made against a snapshot, and the player may have
    // belted it themselves since.
    if (From->IsConnected())
    {
        return FAIFactoryActionResult::Refuse(Action, TEXT("from_connection_is_already_connected"));
    }
    if (To->IsConnected())
    {
        return FAIFactoryActionResult::Refuse(Action, TEXT("to_connection_is_already_connected"));
    }

    const EFactoryConnectionDirection FromDirection = From->GetDirection();
    const EFactoryConnectionDirection ToDirection = To->GetDirection();
    if (FromDirection == EFactoryConnectionDirection::FCD_INPUT)
    {
        return FAIFactoryActionResult::Refuse(Action, TEXT("from_connection_is_an_input"));
    }
    if (ToDirection == EFactoryConnectionDirection::FCD_OUTPUT)
    {
        return FAIFactoryActionResult::Refuse(Action, TEXT("to_connection_is_an_output"));
    }

    UClass* RecipeClass = FindActionClassByPath(RecipeClassPath);
    if (!RecipeClass || !RecipeClass->IsChildOf(UFGRecipe::StaticClass()))
    {
        return FAIFactoryActionResult::Refuse(Action, TEXT("recipe_class_did_not_resolve_to_a_recipe"));
    }

    AFGBuildableSubsystem* Buildables = AFGBuildableSubsystem::Get(Context.World);
    if (!IsValid(Buildables))
    {
        return FAIFactoryActionResult::Refuse(Action, TEXT("buildable_subsystem_unavailable"));
    }

    FAIFactoryActionResult Result;
    Result.Action = Action;
    Result.bDryRun = Context.bDryRun;

    const TSharedRef<FJsonObject> Predicted = MakeShared<FJsonObject>();
    Predicted->SetStringField(TEXT("from_component"), FromConnectionComponent);
    Predicted->SetStringField(TEXT("to_component"), ToConnectionComponent);
    Predicted->SetObjectField(TEXT("from_location"), ActionVectorJson(From->GetConnectorLocation(false)));
    Predicted->SetObjectField(TEXT("to_location"), ActionVectorJson(To->GetConnectorLocation(false)));
    Predicted->SetNumberField(
        TEXT("straight_line_length_cm"),
        FVector::Dist(From->GetConnectorLocation(false), To->GetConnectorLocation(false)));

    AActor* HologramOwner = Context.Player;
    if (AFGBuildGun* BuildGun = Context.Player->GetBuildGun();
        IsValid(BuildGun))
    {
        HologramOwner = BuildGun;
    }

    AFGHologram* Spawned = AFGHologram::SpawnHologramFromRecipe(
        RecipeClass,
        HologramOwner,
        From->GetConnectorLocation(false),
        Context.Player);
    AFGConveyorBeltHologram* Belt = Cast<AFGConveyorBeltHologram>(Spawned);
    if (!IsValid(Belt))
    {
        if (IsValid(Spawned))
        {
            Spawned->Destroy();
        }
        // A recipe that is not a belt would otherwise be free-placed at the
        // start connector, which is a building appearing where a belt was asked
        // for. Naming the mismatch is more useful than building the wrong thing.
        return FAIFactoryActionResult::Refuse(
            Action,
            TEXT("recipe_is_not_a_conveyor_belt"));
    }

    Belt->SetConstructionInstigator(Context.Player);

    // Multi-step placement, exactly as the build gun drives it: update from the
    // source hit, lock it, update from the destination hit, finish. Calling
    // SetHologramLocationAndRotation directly skips AFGHologram's snap path:
    // the official header says it is called only after TrySnapToActor did not
    // snap. UpdateHologramPlacement owns that sequence and must receive the hit.
    // Ask the hologram to snap, and use its own answer rather than inferring one.
    //
    // `UpdateHologramPlacement` alone was not snapping to the source connector
    // in a live save — the belt refused with
    // `belt_hologram_did_not_accept_the_source_connection` on a perfectly
    // ordinary 13 m run. `TrySnapToActor` is the public entry point the build
    // gun uses for exactly this, it returns whether the snap took, and it is
    // overridden by the conveyor hologram specifically to find connections near
    // the hit. Calling it directly turns a silent non-snap into a fact.
    //
    // Both are called: the snap establishes the connection, the placement
    // update positions the spline from it.
    const FHitResult FromHit = MakeActionConnectionHit(From);
    const bool bSnappedSource = Belt->TrySnapToActor(FromHit);
    Belt->UpdateHologramPlacement(FromHit);
    Predicted->SetBoolField(TEXT("source_snap_accepted"), bSnappedSource);

    if (!Belt->IsConnectionSnapped(false))
    {
        Belt->Destroy();
        return FAIFactoryActionResult::Refuse(
            Action,
            bSnappedSource
                // The hologram accepted the hit but did not record a connection,
                // which is a different fault from rejecting the hit outright and
                // wants a different fix.
                ? TEXT("belt_hologram_snapped_but_recorded_no_source_connection")
                : TEXT("belt_hologram_did_not_accept_the_source_connection"));
    }

    const ESplineHologramBuildStep SourceStep = Belt->GetCurrentBuildStep();
    const bool bFinishedAtSource = Belt->DoMultiStepPlacement(false);
    if (bFinishedAtSource || Belt->GetCurrentBuildStep() == SourceStep)
    {
        // DoMultiStepPlacement returns true only when placement is finished.
        // At the source it must instead advance to the destination step.
        Belt->Destroy();
        return FAIFactoryActionResult::Refuse(
            Action,
            bFinishedAtSource
                ? TEXT("belt_hologram_finished_before_destination")
                : TEXT("belt_hologram_did_not_advance_from_source"));
    }

    const FHitResult ToHit = MakeActionConnectionHit(To);
    const bool bSnappedDestination = Belt->TrySnapToActor(ToHit);
    Belt->UpdateHologramPlacement(ToHit);
    Predicted->SetBoolField(TEXT("destination_snap_accepted"), bSnappedDestination);
    if (!Belt->IsConnectionSnapped(true))
    {
        Belt->Destroy();
        return FAIFactoryActionResult::Refuse(
            Action,
            TEXT("belt_hologram_did_not_accept_the_destination_connection"));
    }

    FString HardReason = DescribeHologramDisqualifiers(Belt, Predicted);
    Belt->ValidatePlacementAndCost(
        IsValid(Context.Player) ? Context.Player->GetInventory() : nullptr);
    if (!Belt->CanConstruct())
    {
        Predicted->SetStringField(
            TEXT("hologram_transform"),
            Belt->GetActorTransform().ToString());
        Result.Predicted = Predicted;
        Result.bAccepted = false;
        Result.Status = TEXT("refused");
        Result.Reason = HardReason.IsEmpty()
            ? TEXT("belt_hologram_refused_placement_or_cost")
            : TEXT("belt_hologram_disqualified:") + HardReason;
        return Result;
    }

    if (Context.bDryRun)
    {
        Belt->Destroy();
        Result.Predicted = Predicted;
        Result.bAccepted = true;
        Result.Status = TEXT("dry_run");
        return Result;
    }

    if (!Belt->DoMultiStepPlacement(true))
    {
        Belt->Destroy();
        return FAIFactoryActionResult::Refuse(
            Action,
            TEXT("belt_hologram_wants_more_placement_points"));
    }

    TArray<AActor*> ConstructedChildren;
    AActor* Constructed = Belt->Construct(
        ConstructedChildren,
        Buildables->GetNewNetConstructionID());
    if (IsValid(Belt))
    {
        Belt->Destroy();
    }

    TArray<AFGBuildable*> Built;
    if (AFGBuildable* Root = Cast<AFGBuildable>(Constructed);
        IsValid(Root))
    {
        Built.Add(Root);
    }
    for (AActor* Child : ConstructedChildren)
    {
        if (AFGBuildable* ChildBuildable = Cast<AFGBuildable>(Child);
            IsValid(ChildBuildable))
        {
            Built.AddUnique(ChildBuildable);
        }
    }
    if (Built.Num() == 0)
    {
        return FAIFactoryActionResult::Refuse(Action, TEXT("game_constructed_no_belt"));
    }

    // Read the world back rather than trusting the request: whether the belt
    // actually joined both ports is the only thing that answers "did it work".
    const TSharedRef<FJsonObject> Observed = MakeShared<FJsonObject>();
    Observed->SetBoolField(TEXT("from_connected"), From->IsConnected());
    Observed->SetBoolField(TEXT("to_connected"), To->IsConnected());
    TArray<TSharedPtr<FJsonValue>> BuiltIds;
    for (AFGBuildable* Buildable : Built)
    {
        Result.CreatedActorIds.Add(Buildable->GetPathName());
        BuiltIds.Add(MakeShared<FJsonValueString>(Buildable->GetPathName()));
    }
    Observed->SetArrayField(TEXT("belt_actors"), BuiltIds);

    FAIFactoryUndoStep Step;
    Step.Action = Action;
    Step.Description = FString::Printf(TEXT("Dismantle the %d belt piece(s) just built."), Built.Num());
    for (AFGBuildable* Buildable : Built)
    {
        Step.SpawnedBuildables.Add(Buildable);
    }

    Result.Predicted = Predicted;
    Result.Observed = Observed;
    Result.bAccepted = true;
    Result.bCommitted = true;
    Result.Status = TEXT("committed");
    Result.bUndoable = true;
    Result.UndoDescription = Step.Description;
    if (!From->IsConnected() || !To->IsConnected())
    {
        Result.Warnings.Add(
            TEXT("The belt was built but at least one end did not register as connected. "
                 "Check both machines before relying on the throughput."));
    }
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

    // Items granted by the step are handed back, capped at what is still held
    // so undo can never confiscate a stack the player earned separately.
    int32 ItemsReclaimed = 0;
    for (const TPair<TSubclassOf<UFGItemDescriptor>, int32>& Granted : Step.GrantedItems)
    {
        if (!Granted.Key || Granted.Value <= 0 || !Step.Player.IsValid())
        {
            continue;
        }
        if (UFGInventoryComponent* Inventory = Step.Player->GetInventory(); IsValid(Inventory))
        {
            const int32 ToRemove = FMath::Min(Granted.Value, Inventory->GetNumItems(Granted.Key));
            if (ToRemove > 0)
            {
                Inventory->Remove(Granted.Key, ToRemove);
                ItemsReclaimed += ToRemove;
            }
        }
    }

    bool bPlayerMoved = false;
    if (Step.bHadPlayerTransform && Step.Player.IsValid())
    {
        bPlayerMoved = Step.Player->TeleportTo(
            Step.PreviousPlayerTransform.GetLocation(),
            Step.PreviousPlayerTransform.Rotator());
    }

    TSharedPtr<FJsonObject> Observed = MakeShared<FJsonObject>();
    Observed->SetNumberField(TEXT("buildings_removed"), Removed);
    Observed->SetNumberField(TEXT("items_taken_back"), ItemsReclaimed);
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
            Kind == TEXT("give_item") ||
            Kind == TEXT("place_belt") ||
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

    /**
     * Rewrites `from_step` / `to_step` into the actor a previous step created.
     *
     * Steps are 1-based, matching how they are reported to the player. A
     * reference to a step that built nothing — or has not run — is left
     * unresolved on purpose: the action then refuses for a missing endpoint,
     * which is a clearer failure than silently belting the wrong machine.
     */
    void ResolveActionStepReferences(
        const TSharedPtr<FJsonObject>& Spec,
        const TArray<TSharedPtr<FJsonValue>>& CompletedResults)
    {
        if (!Spec.IsValid())
        {
            return;
        }

        const auto ActorFromStep = [&CompletedResults](const int32 OneBasedStep, FString& OutActorId) -> bool
        {
            const int32 Index = OneBasedStep - 1;
            if (Index < 0 || Index >= CompletedResults.Num())
            {
                return false;
            }
            const TSharedPtr<FJsonObject>* Object = nullptr;
            if (!CompletedResults[Index].IsValid() ||
                !CompletedResults[Index]->TryGetObject(Object) ||
                !Object)
            {
                return false;
            }
            const TArray<TSharedPtr<FJsonValue>>* Created = nullptr;
            if (!(*Object)->TryGetArrayField(TEXT("created_actor_ids"), Created) ||
                !Created ||
                Created->Num() == 0)
            {
                return false;
            }
            // The first created actor is the one the step was asked for; a
            // blueprint's extra members come after it.
            OutActorId = (*Created)[0]->AsString();
            return !OutActorId.IsEmpty();
        };

        static const TCHAR* StepFields[][2] = {
            { TEXT("from_step"), TEXT("from_actor_id") },
            { TEXT("to_step"), TEXT("to_actor_id") },
        };

        for (const auto& Pair : StepFields)
        {
            double StepNumber = 0.0;
            if (!Spec->TryGetNumberField(Pair[0], StepNumber))
            {
                continue;
            }
            FString ActorId;
            if (ActorFromStep(FMath::RoundToInt(StepNumber), ActorId))
            {
                Spec->SetStringField(Pair[1], ActorId);
            }
        }
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
            // What this building goes *on*, when the caller knows. A miner is
            // placed on a named resource node, and a trace cannot be relied on
            // to find it.
            FString PlacementTargetActorId;
            Spec->TryGetStringField(TEXT("target_actor_id"), PlacementTargetActorId);
            return PlaceBuilding(
                Context,
                RecipeClass,
                FTransform(FRotator(0.0, Yaw, 0.0), Location),
                bCheck,
                PlacementTargetActorId);
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
        if (Kind == TEXT("place_belt"))
        {
            FString RecipeClass;
            FString FromComponent;
            FString ToComponent;
            Spec->TryGetStringField(TEXT("recipe_class"), RecipeClass);
            Spec->TryGetStringField(TEXT("from_component"), FromComponent);
            Spec->TryGetStringField(TEXT("to_component"), ToComponent);
            FString FromActorId;
            FString ToActorId;
            Spec->TryGetStringField(TEXT("from_actor_id"), FromActorId);
            Spec->TryGetStringField(TEXT("to_actor_id"), ToActorId);
            if (RecipeClass.IsEmpty())
            {
                return FAIFactoryActionResult::Refuse(Kind, TEXT("recipe_class_is_required"));
            }
            if ((FromComponent.IsEmpty() && FromActorId.IsEmpty()) ||
                (ToComponent.IsEmpty() && ToActorId.IsEmpty()))
            {
                return FAIFactoryActionResult::Refuse(
                    Kind,
                    TEXT("each end needs a component path or an actor id"));
            }
            return PlaceBelt(Context, RecipeClass, FromComponent, ToComponent, FromActorId, ToActorId);
        }
        if (Kind == TEXT("give_item"))
        {
            FString ItemClass;
            if (!Spec->TryGetStringField(TEXT("item_class"), ItemClass) || ItemClass.IsEmpty())
            {
                return FAIFactoryActionResult::Refuse(Kind, TEXT("item_class_is_required"));
            }
            double Count = 1.0;
            Spec->TryGetNumberField(TEXT("count"), Count);
            return GiveItem(Context, ItemClass, FMath::RoundToInt(Count));
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
        if (Kind == TEXT("waypoint") || Kind == TEXT("clear_waypoints"))
        {
            return RunWaypointAction(Context, Kind, Spec);
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
        Item.Spec->TryGetBoolField(TEXT("require_unchanged_world"), Context.bRequireUnchangedWorld);
        Item.Preflight = RunActionSpec(Context, Item.Spec);
        // Record drift on the result even when it did not refuse the action, so
        // a world that moved under the plan stays visible to the player.
        if (!Context.ExpectedWorldRevision.IsEmpty() &&
            !Context.ActualWorldRevision.IsEmpty() &&
            Context.ExpectedWorldRevision != Context.ActualWorldRevision)
        {
            Item.Preflight.WorldRevisionDrift = FString::Printf(
                TEXT("world moved from %s to %s while the plan was prepared; per-action checks still ran"),
                *Context.ExpectedWorldRevision,
                *Context.ActualWorldRevision);
        }

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

    // Everything below indexes the journal from here, so it must not move
    // underneath us. The guard defers the history cap until the plan is done.
    const FAIFactoryUndoTrimGuard UndoTrimGuard;
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
        Item.Spec->TryGetBoolField(TEXT("require_unchanged_world"), Context.bRequireUnchangedWorld);

        // The reply may request a commit, but only the game side can grant one.
        Context.bDryRun = !(bAllowCommit && Item.bRequestedCommit);

        // Resolve references to what earlier steps built.
        //
        // A belt cannot name its endpoints when the plan is written: the
        // machines do not exist yet, so neither do their connection components.
        // That made "build me a module" impossible as one transaction — the
        // placements had to commit, a new snapshot had to be captured, and the
        // belts came in a second request that could not be rolled back with the
        // first. A step reference closes that: `from_step: 1` means "whatever
        // step 1 created", and the executor knows because it just built it.
        ResolveActionStepReferences(Item.Spec, OutResults);

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
    // Surfaced even when it did not refuse the action, so a world that moved
    // under a plan is never silently invisible.
    if (!Result.WorldRevisionDrift.IsEmpty())
    {
        Object->SetStringField(TEXT("world_revision_drift"), Result.WorldRevisionDrift);
    }
    Object->SetNumberField(TEXT("undo_steps_available"), GAIFactoryUndoJournal.Num());
    Object->SetStringField(TEXT("source"), TEXT("executed_by_the_game_and_read_back"));
    return Object;
}

}
