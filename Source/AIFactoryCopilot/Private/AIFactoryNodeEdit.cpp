#include "AIFactoryNodeEdit.h"

#include "AIFactoryCopilotModule.h"
#include "EngineUtils.h"
#include "Resources/FGResourceDescriptor.h"
#include "Resources/FGResourceDeposit.h"
#include "Resources/FGResourceNodeBase.h"

namespace AIFactoryNodeEdit
{
TMap<FString, TSubclassOf<UFGResourceDescriptor>> KnownResources(UWorld* World)
{
    TMap<FString, TSubclassOf<UFGResourceDescriptor>> Result;
    if (!IsValid(World))
    {
        return Result;
    }

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
        if (!IsValid(Resource))
        {
            continue;
        }
        const FString Name = UFGItemDescriptor::GetItemName(Resource).ToString();
        if (!Name.IsEmpty())
        {
            Result.Add(Name.ToLower(), Resource);
        }
    }
    return Result;
}

bool SetNodeResource(
    UWorld* World,
    AFGResourceNodeBase* Node,
    TSubclassOf<UFGResourceDescriptor> Resource,
    FString& OutReason)
{
    OutReason.Reset();

    if (!IsValid(World) || !IsValid(Node))
    {
        OutReason = TEXT("no node to change");
        return false;
    }

    // Writes belong on the server. A client-side override would be overwritten
    // by the next replication anyway, so this would fail silently rather than
    // loudly, which is worse.
    if (World->GetNetMode() == NM_Client)
    {
        OutReason = TEXT("only the host can change a node");
        return false;
    }

    // A deposit is not a node, and the class hierarchy hides that:
    // AFGResourceDeposit derives from AFGResourceNode, so a plain cast accepts
    // one happily. Deposits are the finite hand-mined lumps -- retargeting one
    // yields a few items by hand and nothing a miner can ever stand on.
    //
    // This is not a rare misfire. Around the owner's hub the capture counts 19
    // deposits against 10 nodes, so aiming at a deposit is the *likely* outcome.
    // It cost a real debugging session: the override applied correctly, the rock
    // read "Coal", the node beside it still read "Limestone", and it looked like
    // the feature was broken.
    if (Node->IsA<AFGResourceDeposit>())
    {
        OutReason = TEXT(
            "that is a resource deposit, not a node. Deposits are the small finite "
            "lumps you hand-mine; a miner cannot be built on one, so changing what "
            "it yields gains you almost nothing. Aim at the larger node -- its "
            "prompt names a purity, like \"Limestone (Normal)\", where a deposit's "
            "does not");
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
