#include "AIFactoryBlueprintExport.h"

#include "AIFactoryActions.h"
#include "Buildables/FGBuildable.h"
#include "Buildables/FGBuildableBlueprintDesigner.h"
#include "FGBlueprintSubsystem.h"
#include "FGCharacterPlayer.h"
#include "FGFactoryBlueprintTypes.h"
#include "FGPlayerController.h"
#include "EngineUtils.h"

/**
 * Writing a real `.sbp` from buildings that are standing in the world.
 *
 * The owner's ask is a mega blueprint: mark a whole base with the dismantle
 * tool and get one native blueprint, no size cap, extractors included, placed
 * afterwards with the game's own Build Gun. The Blueprint Designer normally
 * caps that at its own box and cannot hold a miner, because there is no ore
 * inside it to satisfy FGCDNeedsResourceNode.
 *
 * None of that is a rule about blueprints. Verified against the CL 502094
 * headers: AFGBlueprintHologram validates nothing on placement, AFGBuildable
 * has no per-buildable "can be blueprinted" flag, and extractors do not opt
 * out. The restrictions live in what you can *build inside the designer box*,
 * not in what an archive may contain.
 *
 * So this does not fight the designer. It tells one what it already has a
 * public method for being told:
 *
 *   AFGBuildableBlueprintDesigner::OnBuildableConstructedInsideDesigner()
 *     "When a buildable is constructed it informs the designer of its
 *      existence. This way we don't need to gather them to serialize."
 *
 * Then SaveBlueprint runs the game's own serialiser over that list. Three
 * public calls, no reflection, no private access.
 *
 * ---------------------------------------------------------------------------
 * THE HAZARD, AND WHY THE UNWIND IS THE MAIN EVENT
 *
 * `SetInsideBlueprintDesigner` marks a *live factory building* as belonging to
 * a designer. That is a lie told briefly for the serialiser's benefit, and if
 * it outlives this function the player's base is damaged: a designer that
 * believes it owns half a megabase will offer to dismantle it, and
 * `mReplicatedBuiltInsideBlueprintDesigner` is saved with the world.
 *
 * Every marked buildable is therefore unwound by a guard whose destructor runs
 * on every path out of here -- success, refusal, early return, or an exception
 * from inside the engine. Nothing about this function is allowed to be
 * conditional on reaching the end of it.
 */

namespace
{
    /**
     * Marks buildables as inside a designer and guarantees they are unmarked.
     *
     * Destructor-based rather than a tidy-up call at the end, because there are
     * five ways out of the export below and a forgotten one corrupts a save.
     */
    class FScopedDesignerMembership
    {
    public:
        FScopedDesignerMembership(AFGBuildableBlueprintDesigner* InDesigner)
            : Designer(InDesigner)
        {
        }

        /** Returns false if the buildable could not be adopted; nothing is marked in that case. */
        bool Adopt(AFGBuildable* Buildable)
        {
            if (!IsValid(Buildable) || !IsValid(Designer))
            {
                return false;
            }
            // Something already inside a designer is either a genuine designer
            // building or the result of an earlier export that did not unwind.
            // Either way it is not ours to move, and taking it would mean
            // handing it back to the wrong owner.
            if (Buildable->IsBuildableInsideBlueprintDesigner())
            {
                return false;
            }

            // `SetInsideBlueprintDesigner` is NOT called here, and must not be.
            //
            // It crashed the game on the first live attempt:
            //
            //   AFGBuildable::SetInsideBlueprintDesigner() FGBuildable.cpp:1131
            //   AIFactoryBlueprintExport::ExportSelection() line 208
            //
            // A check() inside it fires for a buildable that is already alive.
            // It is a construction-time API, the same as its sibling
            // SetBlueprintBuildEffectID which documents "Must be called before
            // BeginPlay". The comment on OnBuildableConstructedInsideDesigner
            // -- "when a buildable is constructed it informs the designer" --
            // describes when the game calls it, and I read it as an invitation
            // to call it later. It is not one.
            //
            // Dropping it also removes the worse hazard: mBlueprintDesigner is
            // UPROPERTY(SaveGame), so a marking that outlived the export would
            // have followed the player's factory into their save file
            // permanently. Nothing here writes a persisted field on a
            // buildable any more.
            //
            // What remains is the designer's own list, which is what
            // SaveBlueprint iterates. Whether that alone is enough is the open
            // question; if the designer also requires the back-reference, this
            // route is finished and the archive must be written directly with
            // FBlueprintArchiveObjectDataProxy instead.
            Designer->OnBuildableConstructedInsideDesigner(Buildable);
            Adopted.Add(Buildable);
            return true;
        }

        int32 Num() const { return Adopted.Num(); }

        ~FScopedDesignerMembership()
        {
            for (int32 Index = Adopted.Num() - 1; Index >= 0; --Index)
            {
                AFGBuildable* Buildable = Adopted[Index].Get();
                if (!IsValid(Buildable))
                {
                    continue;
                }
                if (IsValid(Designer))
                {
                    Designer->OnBuildableDismantledInsideDesigner(Buildable);
                }
                // No SetInsideBlueprintDesigner(nullptr) counterpart, because
                // nothing set it. See Adopt().
            }
            Adopted.Reset();
        }

    private:
        AFGBuildableBlueprintDesigner* Designer = nullptr;
        TArray<TWeakObjectPtr<AFGBuildable>> Adopted;
    };

    /** Any Blueprint Designer standing in the world. The player must own one. */
    AFGBuildableBlueprintDesigner* FindAnyDesigner(UWorld* World)
    {
        if (!IsValid(World))
        {
            return nullptr;
        }
        for (TActorIterator<AFGBuildableBlueprintDesigner> It(World); It; ++It)
        {
            if (IsValid(*It))
            {
                return *It;
            }
        }
        return nullptr;
    }
}

namespace AIFactoryBlueprintExport
{

FAIFactoryActionResult ExportSelection(
    const FAIFactoryActionContext& Context,
    const FString& BlueprintName,
    const TArray<AFGBuildable*>& Buildables)
{
    const FString Action = TEXT("export_native_blueprint");

    if (BlueprintName.TrimStartAndEnd().IsEmpty())
    {
        return FAIFactoryActionResult::Refuse(Action, TEXT("blueprint_name_is_required"));
    }
    if (Buildables.Num() == 0)
    {
        return FAIFactoryActionResult::Refuse(Action, TEXT("nothing_was_selected"));
    }
    if (!IsValid(Context.World))
    {
        return FAIFactoryActionResult::Refuse(Action, TEXT("no_world"));
    }

    AFGBuildableBlueprintDesigner* Designer = FindAnyDesigner(Context.World);
    if (!IsValid(Designer))
    {
        // Deliberately not spawning one. A designer is a real building the
        // player pays for and places, and conjuring one to serve an export
        // would leave an object in their world they did not ask for.
        return FAIFactoryActionResult::Refuse(
            Action,
            TEXT("no_blueprint_designer_in_this_world_build_one_first"));
    }

    const TSharedRef<FJsonObject> Predicted = MakeShared<FJsonObject>();
    Predicted->SetStringField(TEXT("blueprint_name"), BlueprintName);
    Predicted->SetNumberField(TEXT("selected_buildables"), Buildables.Num());
    Predicted->SetStringField(TEXT("designer"), Designer->GetPathName());
    Predicted->SetBoolField(TEXT("designer_had_buildings"), Designer->HasBuildings());

    // A designer already holding something is mid-edit for the player. Adding
    // a megabase to it would silently fold their work into this archive.
    if (Designer->HasBuildings())
    {
        FAIFactoryActionResult Refusal = FAIFactoryActionResult::Refuse(
            Action,
            TEXT("the_blueprint_designer_is_not_empty_clear_it_first"));
        Refusal.Predicted = Predicted;
        return Refusal;
    }

    if (Context.bDryRun)
    {
        Predicted->SetStringField(
            TEXT("would_call"),
            TEXT("OnBuildableConstructedInsideDesigner per buildable, then SaveBlueprint"));
        FAIFactoryActionResult Result;
        Result.Action = Action;
        Result.bAccepted = true;
        Result.bDryRun = true;
        Result.Status = TEXT("dry_run");
        Result.Predicted = Predicted;
        return Result;
    }

    FAIFactoryActionResult Result;
    Result.Action = Action;
    Result.Predicted = Predicted;

    int32 Skipped = 0;
    {
        // Scope matters: the guard unwinds at the closing brace, before any
        // readback, so the world is already correct when we ask what happened.
        FScopedDesignerMembership Membership(Designer);
        for (AFGBuildable* Buildable : Buildables)
        {
            if (!Membership.Adopt(Buildable))
            {
                ++Skipped;
            }
        }

        if (Membership.Num() == 0)
        {
            Result.Status = TEXT("failed");
            Result.Reason = TEXT("no_selected_buildable_could_be_adopted_by_the_designer");
            Predicted->SetNumberField(TEXT("skipped"), Skipped);
            return Result;
        }

        FBlueprintRecord Record;
        Record.BlueprintName = BlueprintName;
        Record.BlueprintDescription = TEXT("Exported from a dismantle selection by AI Factory Copilot.");

        AFGPlayerController* Controller =
            IsValid(Context.Player) ? Cast<AFGPlayerController>(Context.Player->GetController()) : nullptr;

        Designer->SaveBlueprint(Record, Controller);

        Predicted->SetNumberField(TEXT("adopted"), Membership.Num());
        Predicted->SetNumberField(TEXT("skipped"), Skipped);
    }

    // Read back from the game, not from the fact that SaveBlueprint returned.
    // It is void, so it tells us nothing on its own; the only honest evidence
    // that an archive exists is the subsystem finding a descriptor for it.
    const TSharedRef<FJsonObject> Observed = MakeShared<FJsonObject>();
    Observed->SetBoolField(TEXT("designer_left_empty"), !Designer->HasBuildings());

    AFGBlueprintSubsystem* Subsystem = AFGBlueprintSubsystem::GetBlueprintSubsystem(Context.World);
    bool bRegistered = false;
    if (IsValid(Subsystem))
    {
        Subsystem->RefreshBlueprintsAndDescriptors();
        bRegistered = Subsystem->ReadBlueprintFromDisc(BlueprintName);
    }
    Observed->SetBoolField(TEXT("blueprint_readable_from_disc"), bRegistered);
    Observed->SetBoolField(TEXT("subsystem_available"), IsValid(Subsystem));
    Result.Observed = Observed;

    if (!bRegistered)
    {
        Result.Status = TEXT("failed");
        Result.Reason = TEXT("save_ran_but_no_archive_could_be_read_back");
        return Result;
    }

    Result.bAccepted = true;
    Result.bCommitted = true;
    Result.Status = TEXT("committed");
    // Deliberately not undoable. The journal reverses world changes, and this
    // wrote a file; "undo" here would mean deleting a blueprint the player can
    // now see in their library, which is not what they would expect it to mean.
    Result.bUndoable = false;
    Result.UndoDescription =
        TEXT("Exported blueprints are files, not world changes; delete it from the blueprint menu.");
    return Result;
}

}
