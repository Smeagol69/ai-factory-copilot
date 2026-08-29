#include "AIFactoryNodeEdit.h"

#include "AIFactoryBlueprintResourceAnchor.h"
#include "AIFactoryCopilotModule.h"
#include "AIFactoryCreativeResourceNode.h"
#include "AIFactoryWorldEditAccess.h"
#include "Engine/World.h"
#include "EngineUtils.h"
#include "FGCharacterPlayer.h"
#include "FGPlayerController.h"
#include "FGRecipeManager.h"
#include "GameFramework/PlayerController.h"
#include "Resources/FGItemDescriptor.h"
#include "Resources/FGResourceDescriptor.h"
#include "Resources/FGResourceNode.h"
#include "Resources/FGResourceNodeBase.h"

namespace AIFactoryNodeEdit
{
AFGResourceNodeBase* NodeUnderCrosshair(APlayerController* Controller)
{
    if (!IsValid(Controller))
    {
        return nullptr;
    }

    // The game's own answer to "what am I pointing at". This is what puts
    // "Press E to start mining Limestone (Normal)" on screen, so if the prompt
    // is visible this resolves.
    if (AFGCharacterPlayer* Character =
            Cast<AFGCharacterPlayer>(Controller->GetPawn()))
    {
        if (FUseState* UseState = Character->GetCachedUseState();
            UseState && UseState->bIsTraceHit)
        {
            if (AFGResourceNodeBase* Node =
                    Cast<AFGResourceNodeBase>(UseState->UseHitResult.GetActor()))
            {
                return Node;
            }
        }
    }

    // Fallback only. On its own this fails for resource nodes: the rocks are
    // instanced meshes, so the hit actor is an AbstractInstanceManager rather
    // than the node. Kept because it still resolves a node whose use state has
    // not been cached yet.
    FVector ViewLocation;
    FRotator ViewRotation;
    Controller->GetPlayerViewPoint(ViewLocation, ViewRotation);
    FHitResult Hit;
    FCollisionQueryParams QueryParams(
        SCENE_QUERY_STAT(AIFactoryNodeEditAimTrace), true, Controller->GetPawn());
    if (UWorld* World = Controller->GetWorld())
    {
        World->LineTraceSingleByChannel(
            Hit,
            ViewLocation,
            ViewLocation + ViewRotation.Vector() * 25000.0,
            ECC_Visibility,
            QueryParams);
        return Cast<AFGResourceNodeBase>(Hit.GetActor());
    }
    return nullptr;
}

TMap<FString, TSubclassOf<UFGResourceDescriptor>> KnownResources(UWorld* World)
{
    TMap<FString, TSubclassOf<UFGResourceDescriptor>> Result;
    if (!IsValid(World))
    {
        return Result;
    }

    // Build candidates first. Two mods are allowed to localise different
    // descriptors to the same display name; choosing whichever one happened
    // to be iterated last would be a world-editor write based on a guess.
    TMap<FString, TArray<TSubclassOf<UFGResourceDescriptor>>> Candidates;
    const auto AddSolidResource = [&Candidates](const TSubclassOf<UFGResourceDescriptor> Resource)
    {
        if (!IsValid(Resource) ||
            UFGItemDescriptor::GetForm(Resource) != EResourceForm::RF_SOLID)
        {
            return;
        }

        // This list is the editor's promise of what it can construct. A
        // descriptor without a deposit mesh would later be refused by the
        // hologram in order to avoid an invisible mineable node, so do not
        // advertise it as a selectable creative resource in the first place.
        FString ValidationReason;
        if (!AAIFactoryCreativeResourceNode::ValidateCreativeConfiguration(
                Resource, RP_Normal, ValidationReason))
        {
            return;
        }

        const FString Name = UFGItemDescriptor::GetItemName(Resource).ToString();
        if (!Name.IsEmpty())
        {
            TArray<TSubclassOf<UFGResourceDescriptor>>& ByName =
                Candidates.FindOrAdd(Name.ToLower());
            if (!ByName.Contains(Resource))
            {
                ByName.Add(Resource);
            }
        }
    };

    // The all-item catalogue is the only authoritative way to offer a valid
    // resource that happens not to have a node in the currently streamed part
    // of the map. This includes modded solid resource descriptors without
    // guessing their class paths.
    if (AFGRecipeManager* const Recipes = AFGRecipeManager::Get(World))
    {
        for (const TSubclassOf<UFGItemDescriptor> Descriptor : Recipes->GetAllItemDescriptors())
        {
            UClass* const DescriptorClass = Descriptor.Get();
            if (IsValid(DescriptorClass) &&
                DescriptorClass->IsChildOf(UFGResourceDescriptor::StaticClass()))
            {
                AddSolidResource(TSubclassOf<UFGResourceDescriptor>(DescriptorClass));
            }
        }
    }

    // During an early world-load window the Recipe Manager catalogue may not
    // yet have replicated. Nodes are still authoritative live evidence, so
    // retain them as a bounded fallback rather than presenting an empty list.
    for (TActorIterator<AFGResourceNodeBase> It(World); It; ++It)
    {
        AFGResourceNodeBase* Node = *It;
        if (!IsValid(Node))
        {
            continue;
        }
        // The original, not the current one: a node this tool already changed
        // should still contribute its real resource to the list, or the set of
        // things you can pick shrinks as you use it.
        const TSubclassOf<UFGResourceDescriptor> Resource = Node->GetResourceClassOriginal();
        AddSolidResource(Resource);
    }

    for (const TPair<FString, TArray<TSubclassOf<UFGResourceDescriptor>>>& Entry : Candidates)
    {
        if (Entry.Value.Num() == 1)
        {
            Result.Add(Entry.Key, Entry.Value[0]);
            continue;
        }

        // Do not keep the ambiguous display-name alias. List one deterministic
        // qualified key per descriptor instead, so the player can deliberately
        // choose a modded resource without needing to know a class path.
        for (const TSubclassOf<UFGResourceDescriptor> Resource : Entry.Value)
        {
            Result.Add(FString::Printf(
                TEXT("%s [%s]"),
                *UFGItemDescriptor::GetItemName(Resource).ToString(),
                *Resource->GetName()).ToLower(),
                Resource);
        }
    }
    return Result;
}

TMap<FString, TSubclassOf<UFGResourceDescriptor>> KnownCreativeResources(UWorld* World)
{
    TMap<FString, TSubclassOf<UFGResourceDescriptor>> Result;
    if (!IsValid(World))
    {
        return Result;
    }

    // The creative spawner has a wider contract than generic node retargeting:
    // it may construct ordinary solid/liquid/gas nodes and native geysers.
    // Keep this catalogue separate so `/ai node <resource>` can never broaden
    // a vanilla node edit into a special extractor mode.
    TMap<FString, TArray<TSubclassOf<UFGResourceDescriptor>>> Candidates;
    const auto AddCreativeResource = [&Candidates](
        const TSubclassOf<UFGResourceDescriptor> Resource)
    {
        if (!IsValid(Resource))
        {
            return;
        }

        FString ValidationReason;
        if (!AAIFactoryCreativeResourceNode::ValidateCreativeConfiguration(
                Resource,
                RP_Normal,
                AAIFactoryCreativeResourceNode::NodeTypeForResource(Resource),
                ValidationReason))
        {
            return;
        }

        const FString Name = UFGItemDescriptor::GetItemName(Resource).ToString().TrimStartAndEnd();
        if (Name.IsEmpty())
        {
            return;
        }

        TArray<TSubclassOf<UFGResourceDescriptor>>& ByName =
            Candidates.FindOrAdd(Name.ToLower());
        if (!ByName.Contains(Resource))
        {
            ByName.Add(Resource);
        }
    };

    if (AFGRecipeManager* const Recipes = AFGRecipeManager::Get(World))
    {
        for (const TSubclassOf<UFGItemDescriptor> Descriptor : Recipes->GetAllItemDescriptors())
        {
            UClass* const DescriptorClass = Descriptor.Get();
            if (IsValid(DescriptorClass) &&
                DescriptorClass->IsChildOf(UFGResourceDescriptor::StaticClass()))
            {
                AddCreativeResource(TSubclassOf<UFGResourceDescriptor>(DescriptorClass));
            }
        }
    }

    // Keep the early-load fallback useful for saves whose recipe catalogue has
    // not replicated yet. A live node is still authoritative evidence of a
    // descriptor the game can represent.
    for (TActorIterator<AFGResourceNodeBase> It(World); It; ++It)
    {
        AFGResourceNodeBase* const Node = *It;
        if (IsValid(Node))
        {
            AddCreativeResource(Node->GetResourceClassOriginal());
        }
    }

    for (const TPair<FString, TArray<TSubclassOf<UFGResourceDescriptor>>>& Entry : Candidates)
    {
        if (Entry.Value.Num() == 1)
        {
            Result.Add(Entry.Key, Entry.Value[0]);
            continue;
        }

        // Two mods may localise different descriptors to the same display name.
        // Preserve deliberate selection with the same qualified alias used by
        // the solid-only editor rather than choosing one by iteration order.
        for (const TSubclassOf<UFGResourceDescriptor> Resource : Entry.Value)
        {
            Result.Add(
                FString::Printf(
                    TEXT("%s [%s]"),
                    *UFGItemDescriptor::GetItemName(Resource).ToString(),
                    *Resource->GetName()).ToLower(),
                Resource);
        }
    }
    return Result;
}

bool SetNodeResource(
    AFGPlayerController* const RequestingPlayer,
    UWorld* World,
    AFGResourceNodeBase* Node,
    TSubclassOf<UFGResourceDescriptor> Resource,
    FString& OutReason)
{
    OutReason.Reset();

    if (!AIFactoryWorldEditAccess::CanEdit(RequestingPlayer, OutReason))
    {
        return false;
    }

    if (!IsValid(World) || !IsValid(Node))
    {
        OutReason = TEXT("no node to change");
        return false;
    }

    // The caller's authoritative world is the only valid destination. Keeping
    // the explicit equality check prevents a future direct caller from using
    // another player's permission to mutate an unrelated travel/world context.
    if (World != RequestingPlayer->GetWorld())
    {
        OutReason = TEXT("the requested node belongs to a different world");
        return false;
    }

    // Blueprint Resource Anchor runtime nodes are real AFGResourceNodes, but
    // deliberately transient. Their owning buildable persists resource/purity
    // and re-creates this child after Blueprint/save load. A generic base-node
    // override would therefore appear to work now and silently be lost later.
    // Keep Anchor configuration on its dedicated native Build Gun path.
    if (Node->IsA<AAIFactoryBlueprintAnchorNode>())
    {
        OutReason = TEXT(
            "that is a transient Blueprint Resource Anchor node. Its resource and purity "
            "belong to the saved Anchor buildable, so this generic node editor refuses "
            "to change it. Reconfigure the Anchor through its dedicated Build Gun workflow");
        return false;
    }

    if (Node->IsOccupied())
    {
        OutReason = TEXT(
            "a miner is on this node. Changing what it yields would leave the miner "
            "running the old recipe onto the old belt while the ground says otherwise. "
            "Dismantle the miner first");
        return false;
    }

    if (AAIFactoryCreativeResourceNode* const CreativeNode =
            Cast<AAIFactoryCreativeResourceNode>(Node))
    {
        // A created node has no immutable map-original resource to restore.
        // Delegating rather than using the base override is what keeps its
        // own SaveGame configuration in sync across a future load.
        if (!IsValid(Resource))
        {
            OutReason = TEXT(
                "creative nodes have no vanilla original resource to restore. "
                "Choose the resource you want instead");
            return false;
        }
        return CreativeNode->ConfigureCreativeNode(
            Resource,
            CreativeNode->GetCreativePurity(),
            OutReason);
    }

    // The base hierarchy contains deposits, geysers, fracking satellites and
    // fracking cores. Some are AFGResourceNode subclasses, so a cast alone is
    // unsafe. The vanilla override path is deliberately limited to ordinary
    // static map nodes; every special/extraction mode stays owned by the game.
    AFGResourceNode* const OrdinaryNode = Cast<AFGResourceNode>(Node);
    if (!IsValid(OrdinaryNode) || Node->GetResourceNodeType() != EResourceNodeType::Node)
    {
        OutReason = TEXT(
            "that is not an ordinary solid resource node. The editor does not retarget "
            "deposits, geysers, fracking nodes, or other special resource actors");
        return false;
    }

    const TSubclassOf<UFGResourceDescriptor> Original = Node->GetResourceClassOriginal();

    if (!IsValid(Resource))
    {
        // Clearing is the documented way back: the original was never touched.
        Node->SetResourceClassOverride(nullptr);
        UE_LOG(LogAIFactoryCopilot, Display,
            TEXT("Node %s restored to %s"),
            *Node->GetName(),
            IsValid(Original) ? *Original->GetName() : TEXT("its original resource"));
        return true;
    }

    if (Resource == Node->GetResourceClass())
    {
        OutReason = TEXT("that node already yields this");
        return false;
    }

    Node->SetResourceClassOverride(Resource);

    // Read back rather than trusting the setter. mResourceClassOverride is
    // replicated and the setter's body is behind a stub in the Starter Project,
    // so whether it took is a question worth asking rather than assuming.
    if (Node->GetResourceClass() != Resource)
    {
        OutReason = TEXT("the game did not accept the change");
        return false;
    }

    UE_LOG(LogAIFactoryCopilot, Display,
        TEXT("Node %s overridden from %s to %s"),
        *Node->GetName(),
        IsValid(Original) ? *Original->GetName() : TEXT("unknown"),
        *Resource->GetName());
    return true;
}
}
