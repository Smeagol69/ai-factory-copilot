#pragma once

#include "CoreMinimal.h"
#include "Resources/FGResourceNode.h"
#include "Templates/SubclassOf.h"

class AFGResourceNodeBase;
class AFGPlayerController;
class UFGResourceDescriptor;
class UWorld;

/**
 * One exact special resource-node template proven by a live actor.
 *
 * Some mods intentionally use RF_INVALID descriptors and custom
 * AFGResourceNode subclasses because their extractor is not an item/fluid
 * miner. Reproducing only the descriptor loses the mod's behavior. This
 * contract keeps the exact loaded actor class beside its exact resource and
 * node type, and is never synthesized from a name.
 */
struct FAIFactoryCreativeNodeTemplate
{
    TSubclassOf<AFGResourceNode> NodeClass;
    TSubclassOf<UFGResourceDescriptor> Resource;
    FString DisplayName;
    EResourceNodeType NodeType = EResourceNodeType::Invalid;
};

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
     * Every registered solid resource descriptor the live game knows, by
     * display name.
     *
     * The Recipe Manager owns Satisfactory's complete runtime item catalogue,
     * including loaded mod content. We filter it to genuine solid
     * UFGResourceDescriptor subclasses, never a hard-coded ore list. Existing
     * map nodes remain a fallback for a startup window before that catalogue is
     * ready.
     */
    TMap<FString, TSubclassOf<UFGResourceDescriptor>> KnownResources(UWorld* World);

    /**
     * Every resource descriptor the creative node spawner can represent,
     * including liquid, gas, and native geyser descriptors. This is separate
     * from KnownResources so generic vanilla-node retargeting remains solid
     * only and cannot accidentally turn a map node into a special source.
     */
    TMap<FString, TSubclassOf<UFGResourceDescriptor>> KnownCreativeResources(UWorld* World);

    /**
     * Exact special node classes discovered from live loaded actors, keyed by
     * lowercase class path and (when unambiguous) lowercase display name.
     * Ordinary solid/liquid/gas nodes and native geysers stay on the managed
     * creative-node path instead of being cloned as map classes.
     */
    TMap<FString, FAIFactoryCreativeNodeTemplate> KnownCreativeNodeTemplates(
        UWorld* World);

    /**
     * Re-proves a selected special template against a live actor in this
     * world. Both the arming server and the construction server call this;
     * neither trusts a class/resource pair carried by the client.
     */
    bool ValidateCreativeNodeTemplate(
        UWorld* World,
        TSubclassOf<AFGResourceNode> NodeClass,
        TSubclassOf<UFGResourceDescriptor> Resource,
        EResourcePurity Purity,
        EResourceNodeType& OutNodeType,
        FString& OutReason);

    /**
     * The resource node the player is aiming at, or null.
     *
     * Reads the character's cached use state first -- the same source that
     * makes "Press E to start mining" appear -- and only then falls back to a
     * visibility trace. A raw trace is not sufficient on its own: resource
     * rocks are instanced meshes, so it hits an AbstractInstanceManager and
     * never the node actor behind it.
     */
    class AFGResourceNodeBase* NodeUnderCrosshair(class APlayerController* Controller);

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
        AFGPlayerController* RequestingPlayer,
        UWorld* World,
        AFGResourceNodeBase* Node,
        TSubclassOf<UFGResourceDescriptor> Resource,
        FString& OutReason);
}
