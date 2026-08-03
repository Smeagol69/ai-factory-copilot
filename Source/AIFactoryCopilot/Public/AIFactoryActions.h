#pragma once

#include "CoreMinimal.h"

class AFGBuildable;
class AFGCharacterPlayer;
class UWorld;

/**
 * World-mutating actions.
 *
 * Everything the copilot can *change* goes through here, and every action obeys
 * the same contract:
 *
 *   1. Typed and validated before anything is touched. A malformed request is
 *      refused with a reason, never partially applied.
 *   2. Server-authoritative. Refused outright on a client.
 *   3. Optionally revision-gated: if the caller states the world revision it
 *      reasoned about and the world has moved on, the action is refused rather
 *      than applied to a world it did not see.
 *   4. Dry-runnable. The same validation runs, nothing is committed, and the
 *      caller is told exactly what would have happened.
 *   5. Read back after committing. The result reports what the *world* now says,
 *      not what was requested — those differ when the game snaps or rejects.
 *   6. Reversible writes are journalled as one transaction and rolled back if a
 *      later step fails. Irreversible dismantles must run alone.
 *
 * The read-only scanner's rules still hold here: an action that cannot determine
 * something reports it as unknown rather than assuming success.
 */

/** What an action did, in enough detail for the bridge to report it honestly. */
struct FAIFactoryActionResult
{
    bool bAccepted = false;
    bool bCommitted = false;
    bool bDryRun = false;
    FString Action;
    FString Status = TEXT("not_run");
    FString Reason;

    /** Actors created by this action, as stable ids matching the scanner's. */
    TArray<FString> CreatedActorIds;
    /** Actors removed by this action. */
    TArray<FString> RemovedActorIds;

    /** Read back from the world after committing; empty on a dry run. */
    TSharedPtr<class FJsonObject> Observed;
    /** What would happen, filled in on a dry run and on acceptance. */
    TSharedPtr<class FJsonObject> Predicted;

    /** Set when this action can be reversed, and how. */
    bool bUndoable = false;
    FString UndoDescription;

    /** Set when the world moved under the plan, whether or not that refused it. */
    FString WorldRevisionDrift;

    TArray<FString> Warnings;

    static FAIFactoryActionResult Refuse(const FString& InAction, const FString& InReason)
    {
        FAIFactoryActionResult Result;
        Result.Action = InAction;
        Result.Status = TEXT("refused");
        Result.Reason = InReason;
        return Result;
    }
};

/** One reversible action or consolidated transaction recorded in the journal. */
struct FAIFactoryUndoStep
{
    FString Action;
    /**
     * Actors to dismantle to reverse the action. A blueprint records its proxy
     * once so the game handles the group and lightweight members as one refund.
     */
    TArray<TWeakObjectPtr<AActor>> DismantleActors;
    /** Buildables to remove to undo a placement. */
    TArray<TWeakObjectPtr<AFGBuildable>> SpawnedBuildables;
    /**
     * Items handed to the player, to be taken back on undo.
     *
     * The count is what actually landed, not what was asked for — a partial add
     * into a nearly full inventory must not have undo remove more than it gave.
     */
    TArray<TPair<TSubclassOf<class UFGItemDescriptor>, int32>> GrantedItems;
    /** Where the player was before a teleport. */
    bool bHadPlayerTransform = false;
    FTransform PreviousPlayerTransform;
    TWeakObjectPtr<AFGCharacterPlayer> Player;
    FDateTime RecordedAt;
    FString Description;
};

/** Parameters shared by every action. */
struct FAIFactoryActionContext
{
    UWorld* World = nullptr;
    AFGCharacterPlayer* Player = nullptr;
    bool bDryRun = true;
    /** When set, the action is refused if the live world revision differs. */
    FString ExpectedWorldRevision;
    FString ActualWorldRevision;
    /**
     * Whether a moved world revision refuses the action, or is merely reported.
     *
     * It must be reported either way, but refusing on any drift makes writes
     * impossible in a live game: `MarkWorldDirty` fires on every actor spawn
     * and destroy, so items travelling along a belt tick the counter
     * continuously. A global counter cannot tell a distant leaf from a building
     * appearing on the target tile, and the per-action preflight below — recipe,
     * ground, overlap, cost, hologram — is what actually answers that question.
     */
    bool bRequireUnchangedWorld = false;
};

namespace AIFactoryActions
{
    /**
     * Moves the player. Snaps to ground by default: a teleport to a coordinate
     * with nothing under it drops the player through the world, so the target Z
     * is resolved by tracing down from above and the resolved height is reported.
     */
    FAIFactoryActionResult TeleportPlayer(
        const FAIFactoryActionContext& Context,
        const FVector& Target,
        bool bSnapToGround,
        double SnapClearanceCm);

    /**
     * Places one building from its build recipe.
     *
     * Validation before committing: the recipe must resolve to a buildable class,
     * the ground under the target is probed, and the footprint is overlap-tested.
     * The game's own construction is what actually runs, so anything it refuses
     * is reported as refused rather than silently skipped.
     */
    FAIFactoryActionResult PlaceBuilding(
        const FAIFactoryActionContext& Context,
        const FString& RecipeClassPath,
        const FTransform& Target,
        bool bCheckClearance);

    /**
     * Places a saved blueprint through AFGBlueprintHologram, so Satisfactory
     * validates snapping, clearance, cost, layout, internal wiring, and recipes.
     * Returns every buildable it constructed and journals the blueprint proxy
     * as one group-aware undo target.
     */
    FAIFactoryActionResult PlaceBlueprint(
        const FAIFactoryActionContext& Context,
        const FString& BlueprintName,
        const FTransform& Origin);

    /**
     * Puts items into the player's inventory.
     *
     * The item class must resolve to a real `UFGItemDescriptor`, so an unknown
     * name is refused rather than silently producing nothing. Partial adds are
     * allowed and reported: a nearly full inventory is a normal outcome, and
     * "12 of the 50 you asked for went in" is more use than a flat refusal.
     *
     * Reversible — undo removes exactly what went in, never more.
     */
    FAIFactoryActionResult GiveItem(
        const FAIFactoryActionContext& Context,
        const FString& ItemClassPath,
        int32 Count);

    /**
     * Runs a conveyor belt between two existing factory connections.
     *
     * `plan_belt_route` on the bridge already chooses the connector pair and
     * measures the span; this is the half that builds it. Both endpoints are
     * addressed by their connection *component* path, because that is what the
     * scanner exports and what identifies a port uniquely — an actor id alone
     * does not say which of a machine's four ports was meant.
     *
     * The belt is built through `AFGConveyorBeltHologram`, driven by the same
     * two-step placement the build gun uses, so Satisfactory itself decides the
     * spline shape, the bend radius, the maximum length, the incline limit,
     * clearance, and cost. Nothing here reimplements any of that, and anything
     * the game refuses is reported as refused.
     */
    FAIFactoryActionResult PlaceBelt(
        const FAIFactoryActionContext& Context,
        const FString& RecipeClassPath,
        const FString& FromConnectionComponent,
        const FString& ToConnectionComponent);

    /** Removes a placed building, addressed by the scanner's actor id. */
    FAIFactoryActionResult DismantleActor(
        const FAIFactoryActionContext& Context,
        const FString& ActorId);

    /** Reverses the most recent journalled transaction. */
    FAIFactoryActionResult UndoLast(const FAIFactoryActionContext& Context);

    /** The journal, newest first, for reporting what can still be undone. */
    const TArray<FAIFactoryUndoStep>& GetUndoJournal();
    void ClearUndoJournal();

    /** Serialises a result for the bridge. */
    TSharedPtr<class FJsonObject> ResultToJson(const FAIFactoryActionResult& Result);

    /**
     * Runs the `actions` array from a bridge reply.
     *
     * Preflights the complete plan before its first mutation, executes in order,
     * and stops at the first runtime failure. Reversible writes already committed
     * by that transaction are rolled back; irreversible dismantles and undo are
     * accepted only as standalone committed writes.
     *
     * `bAllowCommit` is the master switch. When false every action is forced to
     * a dry run no matter what the reply asked for, which is how confirmation is
     * enforced on the game side rather than trusted to the model.
     *
     * Returns a short human-readable summary for the chat panel; the full
     * per-action detail goes to `OutResults`.
     */
    FString ExecutePlan(
        UWorld* World,
        AFGCharacterPlayer* Player,
        const TArray<TSharedPtr<class FJsonValue>>& Actions,
        bool bAllowCommit,
        const FString& ActualWorldRevision,
        TArray<TSharedPtr<class FJsonValue>>& OutResults);
}
