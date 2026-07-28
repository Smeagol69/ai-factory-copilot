#include "AIFactoryActions.h"

#include "AIFactoryOverlay.h"
#include "AIFactoryTerrain.h"
#include "Buildables/FGBuildable.h"
#include "Engine/World.h"
#include "EngineUtils.h"
#include "FGBlueprintSubsystem.h"
#include "FGBuildableSubsystem.h"
#include "FGCharacterPlayer.h"
#include "FGDismantleInterface.h"
#include "FGRecipe.h"
#include "Resources/FGBuildingDescriptor.h"
#include "Dom/JsonObject.h"
#include "UObject/UObjectIterator.h"

namespace
{
    /** Newest last; UndoLast pops from the end. */
    TArray<FAIFactoryUndoStep> GAIFactoryUndoJournal;
    constexpr int32 MaximumActionUndoSteps = 64;

    void RecordActionUndo(FAIFactoryUndoStep&& Step)
    {
        Step.RecordedAt = FDateTime::UtcNow();
        GAIFactoryUndoJournal.Add(MoveTemp(Step));
        while (GAIFactoryUndoJournal.Num() > MaximumActionUndoSteps)
        {
            GAIFactoryUndoJournal.RemoveAt(0);
        }
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
    Result.Predicted = Predicted;

    if (Context.bDryRun)
    {
        Result.Status = TEXT("dry_run");
        return Result;
    }

    AFGBuildable* Spawned = Buildables->BeginSpawnBuildable(BuildableClass, Target);
    if (!IsValid(Spawned))
    {
        Result.Status = TEXT("failed");
        Result.Reason = TEXT("game_refused_to_spawn_the_buildable");
        return Result;
    }
    // Binding the recipe is what makes the building dismantle for the right
    // refund and show the right name; a buildable spawned without it is subtly
    // wrong rather than obviously broken.
    Spawned->SetBuiltWithRecipe(RecipeClass);
    Spawned->FinishSpawning(Target);

    Result.bCommitted = true;
    Result.Status = TEXT("committed");
    Result.CreatedActorIds.Add(Spawned->GetPathName());

    TSharedPtr<FJsonObject> Observed = MakeShared<FJsonObject>();
    Observed->SetStringField(TEXT("actor_id"), Spawned->GetPathName());
    Observed->SetObjectField(TEXT("transform"), ActionTransformJson(Spawned->GetActorTransform()));
    Observed->SetNumberField(
        TEXT("offset_from_requested_cm"),
        FVector::Dist(Spawned->GetActorLocation(), Target.GetLocation()));
    Result.Observed = Observed;

    Result.bUndoable = true;
    Result.UndoDescription = TEXT("Dismantle the placed building.");

    FAIFactoryUndoStep Step;
    Step.Action = Action;
    Step.SpawnedBuildables.Add(Spawned);
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

    FAIFactoryActionResult Result;
    Result.Action = Action;
    Result.bAccepted = true;
    Result.bDryRun = Context.bDryRun;

    TSharedPtr<FJsonObject> Predicted = MakeShared<FJsonObject>();
    Predicted->SetStringField(TEXT("blueprint_name"), BlueprintName);
    Predicted->SetObjectField(TEXT("origin"), ActionTransformJson(Origin));
    Result.Predicted = Predicted;

    if (Context.bDryRun)
    {
        Result.Status = TEXT("dry_run");
        return Result;
    }

    // The game's own loader places the contents, so layout, internal
    // connections, and per-machine recipes come from Satisfactory's serialiser
    // rather than being reconstructed here.
    TArray<AFGBuildable*> Placed;
    Blueprints->LoadStoredBlueprint(
        Descriptor,
        Origin,
        Placed,
        /* useBlueprintWorld */ false,
        /* designer */ nullptr,
        /* instigator */ Context.Player);

    if (Placed.Num() == 0)
    {
        Result.Status = TEXT("failed");
        Result.Reason = TEXT("blueprint_loader_placed_nothing");
        return Result;
    }

    Result.bCommitted = true;
    Result.Status = TEXT("committed");

    FAIFactoryUndoStep Step;
    Step.Action = Action;
    for (AFGBuildable* Buildable : Placed)
    {
        if (IsValid(Buildable))
        {
            Result.CreatedActorIds.Add(Buildable->GetPathName());
            Step.SpawnedBuildables.Add(Buildable);
        }
    }
    Step.Description = FString::Printf(TEXT("Dismantle the placed blueprint '%s'"), *BlueprintName);

    TSharedPtr<FJsonObject> Observed = MakeShared<FJsonObject>();
    Observed->SetNumberField(TEXT("buildings_placed"), Result.CreatedActorIds.Num());
    Observed->SetObjectField(TEXT("origin"), ActionTransformJson(Origin));
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

    IFGDismantleInterface::Execute_Dismantle(Buildable);
    Result.bCommitted = true;
    Result.Status = TEXT("committed");
    Result.RemovedActorIds.Add(ActorId);

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
        IFGDismantleInterface::Execute_Dismantle(Buildable);
        ++Removed;
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
    Observed->SetNumberField(TEXT("already_gone"), AlreadyGone);
    Observed->SetBoolField(TEXT("player_restored"), bPlayerMoved);
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

FString ExecutePlan(
    UWorld* World,
    AFGCharacterPlayer* Player,
    const TArray<TSharedPtr<FJsonValue>>& Actions,
    bool bAllowCommit,
    const FString& ActualWorldRevision,
    TArray<TSharedPtr<FJsonValue>>& OutResults)
{
    int32 Committed = 0;
    int32 DryRun = 0;
    int32 Refused = 0;
    int32 Skipped = 0;
    FString FirstFailure;

    for (int32 Index = 0; Index < Actions.Num(); ++Index)
    {
        const TSharedPtr<FJsonObject>* Spec = nullptr;
        if (!Actions[Index]->TryGetObject(Spec) || !Spec)
        {
            OutResults.Add(MakeShared<FJsonValueObject>(
                ResultToJson(FAIFactoryActionResult::Refuse(TEXT("unknown"), TEXT("action_is_not_an_object")))));
            ++Refused;
            continue;
        }

        // Once a step has failed the rest of the plan is no longer the plan the
        // model designed, so report the remainder as skipped instead of running it.
        if (!FirstFailure.IsEmpty())
        {
            FString SkippedKind;
            (*Spec)->TryGetStringField(TEXT("action"), SkippedKind);
            FAIFactoryActionResult Stop = FAIFactoryActionResult::Refuse(
                SkippedKind.IsEmpty() ? TEXT("unknown") : SkippedKind,
                TEXT("skipped_because_an_earlier_step_failed"));
            Stop.Status = TEXT("skipped");
            OutResults.Add(MakeShared<FJsonValueObject>(ResultToJson(Stop)));
            ++Skipped;
            continue;
        }

        FString Kind;
        (*Spec)->TryGetStringField(TEXT("action"), Kind);

        FAIFactoryActionContext Context;
        Context.World = World;
        Context.Player = Player;
        Context.ActualWorldRevision = ActualWorldRevision;
        (*Spec)->TryGetStringField(TEXT("expect_world_revision"), Context.ExpectedWorldRevision);

        // The reply may request a commit, but only the game side can grant one.
        bool bRequestedCommit = false;
        (*Spec)->TryGetBoolField(TEXT("commit"), bRequestedCommit);
        Context.bDryRun = !(bAllowCommit && bRequestedCommit);

        FAIFactoryActionResult Result;
        if (Kind == TEXT("teleport_player"))
        {
            const TSharedPtr<FJsonObject>* Target = nullptr;
            if (!(*Spec)->TryGetObjectField(TEXT("target"), Target) || !Target)
            {
                Result = FAIFactoryActionResult::Refuse(Kind, TEXT("missing_target"));
            }
            else
            {
                FVector Location(
                    (*Target)->GetNumberField(TEXT("x")),
                    (*Target)->GetNumberField(TEXT("y")),
                    (*Target)->HasField(TEXT("z")) ? (*Target)->GetNumberField(TEXT("z")) : 0.0);
                bool bSnap = true;
                (*Spec)->TryGetBoolField(TEXT("snap_to_ground"), bSnap);
                double Clearance = 200.0;
                (*Spec)->TryGetNumberField(TEXT("snap_clearance_cm"), Clearance);
                Result = TeleportPlayer(Context, Location, bSnap, Clearance);
            }
        }
        else if (Kind == TEXT("place_building"))
        {
            FString RecipeClass;
            (*Spec)->TryGetStringField(TEXT("recipe_class"), RecipeClass);
            FTransform Target = FTransform::Identity;
            const TSharedPtr<FJsonObject>* Location = nullptr;
            if ((*Spec)->TryGetObjectField(TEXT("location"), Location) && Location)
            {
                Target.SetLocation(FVector(
                    (*Location)->GetNumberField(TEXT("x")),
                    (*Location)->GetNumberField(TEXT("y")),
                    (*Location)->GetNumberField(TEXT("z"))));
            }
            double Yaw = 0.0;
            (*Spec)->TryGetNumberField(TEXT("yaw"), Yaw);
            Target.SetRotation(FRotator(0.0, Yaw, 0.0).Quaternion());
            bool bCheck = true;
            (*Spec)->TryGetBoolField(TEXT("check_clearance"), bCheck);
            Result = PlaceBuilding(Context, RecipeClass, Target, bCheck);
        }
        else if (Kind == TEXT("place_blueprint"))
        {
            FString Name;
            (*Spec)->TryGetStringField(TEXT("blueprint_name"), Name);
            FTransform Origin = FTransform::Identity;
            const TSharedPtr<FJsonObject>* Location = nullptr;
            if ((*Spec)->TryGetObjectField(TEXT("location"), Location) && Location)
            {
                Origin.SetLocation(FVector(
                    (*Location)->GetNumberField(TEXT("x")),
                    (*Location)->GetNumberField(TEXT("y")),
                    (*Location)->GetNumberField(TEXT("z"))));
            }
            double Yaw = 0.0;
            (*Spec)->TryGetNumberField(TEXT("yaw"), Yaw);
            Origin.SetRotation(FRotator(0.0, Yaw, 0.0).Quaternion());
            Result = PlaceBlueprint(Context, Name, Origin);
        }
        else if (Kind == TEXT("dismantle"))
        {
            FString ActorId;
            (*Spec)->TryGetStringField(TEXT("actor_id"), ActorId);
            Result = DismantleActor(Context, ActorId);
        }
        else if (Kind == TEXT("undo_last"))
        {
            Result = UndoLast(Context);
        }
        else if (Kind == TEXT("highlight") || Kind == TEXT("clear_highlight"))
        {
            // Overlays only draw; they change nothing in the world, so they run
            // regardless of whether write actions are enabled and are never
            // held back for confirmation.
            Result = RunOverlayAction(Context, Kind, *Spec);
        }
        else
        {
            Result = FAIFactoryActionResult::Refuse(
                Kind.IsEmpty() ? TEXT("unknown") : Kind,
                TEXT("unsupported_action"));
        }

        OutResults.Add(MakeShared<FJsonValueObject>(ResultToJson(Result)));

        if (Result.bCommitted)
        {
            ++Committed;
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

    if (Actions.Num() == 0)
    {
        return FString();
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
    if (!FirstFailure.IsEmpty())
    {
        Summary += FString::Printf(TEXT(" — stopped at %s"), *FirstFailure);
    }
    if (Committed > 0)
    {
        Summary += TEXT(" (say \"undo\" to reverse)");
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
