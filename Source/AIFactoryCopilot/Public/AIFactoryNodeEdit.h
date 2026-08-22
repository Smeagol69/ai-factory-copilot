#pragma once

#include "CoreMinimal.h"
#include "Templates/SubclassOf.h"

class AFGResourceNodeBase;
class UFGResourceDescriptor;
class UWorld;

/**
 * Changing what a resource node yields.
 *
 * The owner asked to turn a Pure Limestone node into Coal, and the assistant
 * said it could not be done. It can -- the game has a first-class mechanism for
 * it and the assistant simply had no route to it:
 *
 *     UPROPERTY( SaveGame, ReplicatedUsing = OnRep_ResourceClassOverride )
 *     TSubclassOf< UFGResourceDescriptor > mResourceClassOverride;
 *
 *     void SetResourceClassOverride( TSubclassOf< UFGResourceDescriptor > resource );
 *
 * Three properties of that declaration decide the whole design. It is
 * **SaveGame**, so the change persists rather than lasting one session. It is
 * **replicated**, so it is multiplayer-correct without any work from us. And it
 * is an **override**, not a mutation -- `mResourceClass` keeps saying Limestone,
 * `GetResourceClassOriginal()` still returns it, and clearing the override
 * restores the node exactly. Nothing about the world is destroyed.
 *
 * That last point is why this is offered at all. Editing `mResourceClass`
 * directly would be a one-way change to someone's save; using the override the
 * game already ships is reversible by construction.
 */
namespace AIFactoryNodeEdit
{
    /**
     * Every resource that actually exists on this map, by display name.
     *
     * Gathered from the nodes in the world rather than from a hardcoded list, so
     * it covers modded resources for free and can never offer something whose
     * class path was guessed. "Coal" resolves only because a Coal node exists
     * somewhere to resolve it from.
     */
    TMap<FString, TSubclassOf<UFGResourceDescriptor>> KnownResources(UWorld* World);

    /**
     * Point a node at a different resource.
     *
     * @param Resource  nullptr clears the override and restores the original.
     * @param OutReason empty on success, otherwise why not.
     *
     * Refuses while a miner sits on the node. Changing what a node yields under
     * a running extractor means the miner keeps its old recipe and belt while
     * the ground beneath it says something else; dismantling the player's miner
     * to make our edit possible is not ours to decide.
     */
    bool SetNodeResource(
        UWorld* World,
        AFGResourceNodeBase* Node,
        TSubclassOf<UFGResourceDescriptor> Resource,
        FString& OutReason);
}
