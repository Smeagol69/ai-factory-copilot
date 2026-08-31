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
#include "FGResourceNodeGeyser.h"
#include "GameFramework/PlayerController.h"
#include "HAL/PlatformTime.h"
#include "Resources/FGItemDescriptor.h"
#include "Resources/FGResourceDescriptor.h"
#include "Resources/FGResourceNode.h"
#include "Resources/FGResourceNodeBase.h"
#include "UObject/ObjectKey.h"

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

namespace
{
bool IsManagedCopilotNode(const AFGResourceNode* const Node)
{
    return IsValid(Node) &&
        (Node->IsA<AAIFactoryCreativeResourceNode>() ||
         Node->IsA<AAIFactoryCreativeOrdinaryResourceNode>() ||
         Node->IsA<AAIFactoryBlueprintAnchorNode>());
}

bool IsSpecialTemplateEvidence(
    const AFGResourceNode* const Node,
    TSubclassOf<UFGResourceDescriptor>& OutResource)
{
    OutResource = nullptr;
    if (!IsValid(Node) || IsManagedCopilotNode(Node) || !Node->HasAnyResources())
    {
        return false;
    }

    UClass* const NodeClass = Node->GetClass();
    if (!IsValid(NodeClass) ||
        NodeClass->HasAnyClassFlags(
            CLASS_Abstract | CLASS_Deprecated | CLASS_NewerVersionExists))
    {
        return false;
    }

    // Vanilla geothermal nodes already use the dedicated Copilot geyser
    // actor. Their descriptor has RF_INVALID form, so form alone would
    // otherwise mislabel "Geyser" as an exact mod template. A real special
    // template must preserve a different class contract.
    if (Node->IsA<AFGResourceNodeGeyser>())
    {
        return false;
    }

    // Special nodes may deliberately seed the inherited original-resource
    // slot with a vanilla compatibility descriptor. Refined Power's Water
    // Turbine nodes are the live example: the authoritative current resource
    // is Water Turbine Node while the inherited original can still read as
    // Geyser. Clone what the node actually exposes, then fall back only when
    // the current resource is absent.
    OutResource = Node->GetResourceClass();
    if (!IsValid(OutResource))
    {
        OutResource = Node->GetResourceClassOriginal();
    }
    if (!IsValid(OutResource))
    {
        return false;
    }

    // Template cloning is reserved for mod-specific contracts such as Refined
    // Power's RF_INVALID Water Turbine node. Ordinary vanilla nodes are
    // deliberately excluded, and that exclusion was re-instated after being
    // briefly lifted.
    //
    // Lifting it looked justified: a geyser -- which reaches this path only
    // because a geyser descriptor's form is RF_INVALID, so this exclusion never
    // covered it -- clones from BP_ResourceNodeGeyser_C and behaves correctly.
    // But cloning BP_ResourceNode_C produces a hollow actor. A live snapshot
    // diff against a working map node showed the clone with mBoxComponent=None,
    // mMeshActor=None and mResourcesLeft=0: the box, the mesh actor and the
    // resource count are all level-authored per-instance data that a runtime
    // spawn cannot populate. The result is an invisible node with no collision
    // that no extractor can find -- strictly worse than the native class.
    //
    // The native path is correct for ordinary nodes; its real defect was
    // mResourcesLeft never being set, which is fixed at the InitResource call
    // sites rather than by cloning a Blueprint we cannot fully construct.
    const EResourceForm Form = UFGItemDescriptor::GetForm(OutResource);
    const EResourceNodeType NodeType = Node->GetResourceNodeType();
    if (Form != EResourceForm::RF_INVALID &&
        (NodeType == EResourceNodeType::Node ||
         NodeType == EResourceNodeType::Geyser))
    {
        return false;
    }

    // An occupied live node is itself proof that its custom extractor can use
    // the class. For an open node require the native gate to be true now.
    return Node->IsOccupied() || Node->CanPlaceResourceExtractor();
}
}

TMap<FString, FAIFactoryCreativeNodeTemplate> KnownCreativeNodeTemplates(
    UWorld* World)
{
    TMap<FString, FAIFactoryCreativeNodeTemplate> Result;
    if (!IsValid(World))
    {
        return Result;
    }

    TMap<FString, FAIFactoryCreativeNodeTemplate> ByClassPath;
    TMap<FString, TArray<FString>> ClassPathsByDisplayName;
    for (TActorIterator<AFGResourceNode> It(World); It; ++It)
    {
        AFGResourceNode* const Node = *It;
        TSubclassOf<UFGResourceDescriptor> Resource;
        if (!IsSpecialTemplateEvidence(Node, Resource))
        {
            continue;
        }

        UClass* const NodeClassObject = Node->GetClass();
        // Keyed by class AND resource, not class alone. The vanilla ordinary
        // node Blueprint backs every ore in the map, so a class-only key would
        // collapse dozens of live nodes into a single arbitrary row -- one
        // "Iron Ore" template and no way to ask the same Blueprint for coal.
        // Each pair is separately proven by a live node, which is exactly the
        // evidence ValidateCreativeNodeTemplate goes looking for.
        const FString ClassPath = FString::Printf(
            TEXT("%s|%s"), *NodeClassObject->GetPathName(), *Resource->GetPathName());
        if (ByClassPath.Contains(ClassPath))
        {
            continue;
        }

        FAIFactoryCreativeNodeTemplate Template;
        Template.NodeClass = TSubclassOf<AFGResourceNode>(NodeClassObject);
        Template.Resource = Resource;
        Template.DisplayName =
            UFGItemDescriptor::GetItemName(Resource).ToString().TrimStartAndEnd();
        if (Template.DisplayName.IsEmpty())
        {
            Template.DisplayName = NodeClassObject->GetName();
        }
        Template.NodeType = Node->GetResourceNodeType();

        ByClassPath.Add(ClassPath, Template);
        ClassPathsByDisplayName.FindOrAdd(Template.DisplayName.ToLower()).Add(ClassPath);
    }

    for (const TPair<FString, FAIFactoryCreativeNodeTemplate>& Entry : ByClassPath)
    {
        // The combined "class|resource" key is what the panel sends, so one
        // Blueprint can be asked for a specific ore.
        Result.Add(Entry.Key.ToLower(), Entry.Value);

        // The bare class path must keep resolving as well. Chat commands look
        // templates up that way, and keying this map by class+resource alone
        // silently broke every template -- including the geyser that already
        // worked -- with "that exact special node class is no longer proven by
        // a live node". First resource registered for a class wins here; the
        // combined key above is how a caller asks for an exact pairing.
        if (IsValid(Entry.Value.NodeClass))
        {
            const FString BareClassPath = Entry.Value.NodeClass->GetPathName().ToLower();
            if (!Result.Contains(BareClassPath))
            {
                Result.Add(BareClassPath, Entry.Value);
            }
        }
    }
    for (const TPair<FString, TArray<FString>>& Entry : ClassPathsByDisplayName)
    {
        if (Entry.Value.Num() == 1)
        {
            Result.Add(Entry.Key, ByClassPath.FindChecked(Entry.Value[0]));
            continue;
        }

        for (const FString& ClassPath : Entry.Value)
        {
            const FAIFactoryCreativeNodeTemplate& Template =
                ByClassPath.FindChecked(ClassPath);
            Result.Add(
                FString::Printf(
                    TEXT("%s [%s]"),
                    *Template.DisplayName,
                    *Template.NodeClass->GetName()).ToLower(),
                Template);
        }
    }
    return Result;
}

bool ValidateCreativeNodeTemplate(
    UWorld* World,
    const TSubclassOf<AFGResourceNode> NodeClass,
    const TSubclassOf<UFGResourceDescriptor> Resource,
    const EResourcePurity Purity,
    EResourceNodeType& OutNodeType,
    FString& OutReason)
{
    OutNodeType = EResourceNodeType::Invalid;
    OutReason.Reset();
    if (!IsValid(World))
    {
        OutReason = TEXT("the live world is unavailable");
        return false;
    }
    if (!IsValid(NodeClass) || !IsValid(Resource) ||
        !NodeClass->IsChildOf(AFGResourceNode::StaticClass()))
    {
        OutReason = TEXT("a special node template needs an exact loaded resource-node class and descriptor");
        return false;
    }
    if (Purity != RP_Inpure && Purity != RP_Normal && Purity != RP_Pure)
    {
        OutReason = TEXT("special node purity must be Impure, Normal, or Pure");
        return false;
    }

    for (TActorIterator<AFGResourceNode> It(World); It; ++It)
    {
        AFGResourceNode* const Evidence = *It;
        if (!IsValid(Evidence) || Evidence->GetClass() != NodeClass.Get())
        {
            continue;
        }

        TSubclassOf<UFGResourceDescriptor> EvidencedResource;
        if (!IsSpecialTemplateEvidence(Evidence, EvidencedResource) ||
            EvidencedResource != Resource)
        {
            continue;
        }

        OutNodeType = Evidence->GetResourceNodeType();
        return true;
    }

    OutReason = TEXT(
        "that special node class/resource pair is not proven by a live loaded node in this world");
    return false;
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

    if (AAIFactoryCreativeOrdinaryResourceNode* const CreativeNode =
            Cast<AAIFactoryCreativeOrdinaryResourceNode>(Node))
    {
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

bool GetCreativeNodeConfiguration(
    AFGResourceNodeBase* const Node,
    TSubclassOf<UFGResourceDescriptor>& OutResource,
    EResourcePurity& OutPurity,
    EResourceNodeType& OutNodeType,
    FString& OutReason)
{
    OutResource = nullptr;
    OutPurity = RP_MAX;
    OutNodeType = EResourceNodeType::Invalid;
    OutReason.Reset();

    if (!IsValid(Node) || Node->IsActorBeingDestroyed())
    {
        OutReason = TEXT("the aimed resource node is no longer live");
        return false;
    }

    if (const AAIFactoryCreativeOrdinaryResourceNode* const Ordinary =
            Cast<AAIFactoryCreativeOrdinaryResourceNode>(Node))
    {
        const FAIFactoryCreativeResourceNodeConfiguration& Configuration =
            Ordinary->GetCreativeConfiguration();
        OutResource = Configuration.ResourceClass;
        OutPurity = Configuration.Purity;
        OutNodeType = Configuration.NodeType;
    }
    else if (const AAIFactoryCreativeResourceNode* const GeyserOrLegacy =
                 Cast<AAIFactoryCreativeResourceNode>(Node))
    {
        const FAIFactoryCreativeResourceNodeConfiguration& Configuration =
            GeyserOrLegacy->GetCreativeConfiguration();
        OutResource = Configuration.ResourceClass;
        OutPurity = Configuration.Purity;
        OutNodeType = Configuration.NodeType;
    }
    else
    {
        OutReason = TEXT(
            "that is not a Copilot-owned creative node. Vanilla map nodes, Blueprint "
            "Resource Anchors, and exact mod-node templates remain owned by their original systems");
        return false;
    }

    FString ValidationReason;
    if (!AAIFactoryCreativeResourceNode::ValidateCreativeConfiguration(
            OutResource,
            OutPurity,
            OutNodeType,
            ValidationReason))
    {
        OutReason = FString::Printf(
            TEXT("the creative node's saved configuration is invalid: %s"),
            *ValidationReason);
        return false;
    }

    // A saved configuration is not enough by itself. Read the actor back too,
    // so Clone/Remove can never act on a partially loaded or stale node whose
    // runtime state no longer matches the values the mod owns.
    const AFGResourceNode* const RuntimeNode = Cast<AFGResourceNode>(Node);
    if (!IsValid(RuntimeNode) ||
        Node->GetResourceClass() != OutResource ||
        RuntimeNode->GetResourcePurity() != OutPurity ||
        Node->GetResourceNodeType() != OutNodeType)
    {
        OutReason = TEXT(
            "the creative node's live resource, purity, or node type does not match its saved configuration");
        return false;
    }
    return true;
}

namespace
{
constexpr double AIFactoryCreativeNodeRemovalConfirmationSeconds = 5.0;

struct FAIFactoryPendingCreativeNodeRemoval
{
    TWeakObjectPtr<AFGPlayerController> Player;
    TWeakObjectPtr<AFGResourceNodeBase> Node;
    TWeakObjectPtr<UWorld> World;
    FString ActorPath;
    TSubclassOf<UFGResourceDescriptor> Resource;
    EResourcePurity Purity = RP_MAX;
    EResourceNodeType NodeType = EResourceNodeType::Invalid;
    double ArmedAtSeconds = 0.0;
};

TMap<FObjectKey, FAIFactoryPendingCreativeNodeRemoval>
    AIFactoryPendingCreativeNodeRemovals;

void PruneAIFactoryCreativeNodeRemovalConfirmations(const double NowSeconds)
{
    for (auto It = AIFactoryPendingCreativeNodeRemovals.CreateIterator(); It; ++It)
    {
        const FAIFactoryPendingCreativeNodeRemoval& Pending = It.Value();
        if (!Pending.Player.IsValid() || !Pending.Node.IsValid() ||
            !Pending.World.IsValid() ||
            (NowSeconds - Pending.ArmedAtSeconds) >
                AIFactoryCreativeNodeRemovalConfirmationSeconds)
        {
            It.RemoveCurrent();
        }
    }
}
}

ECreativeNodeRemovalResult RemoveCreativeNode(
    AFGPlayerController* const RequestingPlayer,
    UWorld* const World,
    AFGResourceNodeBase* const Node,
    FString& OutReason)
{
    OutReason.Reset();
    if (!AIFactoryWorldEditAccess::CanEdit(RequestingPlayer, OutReason))
    {
        return ECreativeNodeRemovalResult::Refused;
    }
    if (!IsValid(World) || !IsValid(Node) ||
        RequestingPlayer->GetWorld() != World || Node->GetWorld() != World)
    {
        OutReason = TEXT("the aimed node is not a live actor in the requesting player's world");
        return ECreativeNodeRemovalResult::Refused;
    }
    if (!Node->HasAuthority())
    {
        OutReason = TEXT("creative-node removal must run on the authoritative game server");
        return ECreativeNodeRemovalResult::Refused;
    }

    TSubclassOf<UFGResourceDescriptor> Resource;
    EResourcePurity Purity = RP_MAX;
    EResourceNodeType NodeType = EResourceNodeType::Invalid;
    if (!GetCreativeNodeConfiguration(
            Node, Resource, Purity, NodeType, OutReason))
    {
        return ECreativeNodeRemovalResult::Refused;
    }
    if (Node->IsOccupied())
    {
        OutReason = TEXT(
            "a resource extractor occupies this creative node. Dismantle the extractor first; "
            "the node editor will never delete a player's machine with the ground");
        return ECreativeNodeRemovalResult::Refused;
    }

    const double NowSeconds = FPlatformTime::Seconds();
    PruneAIFactoryCreativeNodeRemovalConfirmations(NowSeconds);
    const FObjectKey PlayerKey(RequestingPlayer);
    const FString ActorPath = Node->GetPathName();
    if (const FAIFactoryPendingCreativeNodeRemoval* const Pending =
            AIFactoryPendingCreativeNodeRemovals.Find(PlayerKey);
        Pending == nullptr || Pending->Player.Get() != RequestingPlayer ||
        Pending->World.Get() != World || Pending->Node.Get() != Node ||
        Pending->ActorPath != ActorPath ||
        Pending->Resource != Resource || Pending->Purity != Purity ||
        Pending->NodeType != NodeType ||
        (NowSeconds - Pending->ArmedAtSeconds) >
            AIFactoryCreativeNodeRemovalConfirmationSeconds)
    {
        FAIFactoryPendingCreativeNodeRemoval Confirmation;
        Confirmation.Player = RequestingPlayer;
        Confirmation.Node = Node;
        Confirmation.World = World;
        Confirmation.ActorPath = ActorPath;
        Confirmation.Resource = Resource;
        Confirmation.Purity = Purity;
        Confirmation.NodeType = NodeType;
        Confirmation.ArmedAtSeconds = NowSeconds;
        AIFactoryPendingCreativeNodeRemovals.Add(PlayerKey, MoveTemp(Confirmation));
        OutReason = TEXT(
            "repeat Remove aimed within five seconds while still aiming at this exact node to confirm");
        return ECreativeNodeRemovalResult::ConfirmationRequired;
    }

    // Consume before mutation. A failed engine Destroy request must require a
    // fresh confirmation rather than becoming an armed delete loop.
    AIFactoryPendingCreativeNodeRemovals.Remove(PlayerKey);
    const bool bDestroyAccepted = Node->Destroy();
    if (!bDestroyAccepted || !Node->IsActorBeingDestroyed())
    {
        OutReason = TEXT("the game did not accept destruction of the creative node");
        return ECreativeNodeRemovalResult::Refused;
    }

    UE_LOG(
        LogAIFactoryCopilot,
        Display,
        TEXT("Removed creative node %s (resource=%s purity=%s nodeType=%d)"),
        *ActorPath,
        *GetNameSafe(Resource.Get()),
        *StaticEnum<EResourcePurity>()->GetDisplayNameTextByValue(
            static_cast<int64>(Purity)).ToString(),
        static_cast<int32>(NodeType));
    return ECreativeNodeRemovalResult::Removed;
}
}
