#include "AIFactoryChatCommand.h"
#include "AIFactoryBlueprintResourceAnchor.h"
#include "AIFactoryBlueprintResourceAnchorPlacement.h"
#include "AIFactoryVision.h"
#include "AIFactoryNodeEdit.h"
#include "AIFactoryCreativeNodePlacement.h"
#include "AIFactoryCreativeResourceNode.h"
#include "Resources/FGResourceNodeBase.h"
#include "Resources/FGResourceDescriptor.h"
#include "AIFactoryTerrainScan.h"

#include "AIFactorySubsystem.h"
#include "Command/CommandSender.h"
#include "Components/PrimitiveComponent.h"
#include "EngineUtils.h"
#include "Equipment/FGBuildGun.h"
#include "Equipment/FGBuildGunBuild.h"
#include "FGCharacterPlayer.h"
#include "FGConstructDisqualifier.h"
#include "FGPlayerController.h"
#include "Hologram/FGHologram.h"
#include "GameFramework/Pawn.h"

AAIFactoryChatCommand::AAIFactoryChatCommand()
{
    CommandName = TEXT("aifactory");
    Aliases.Add(TEXT("ai"));
    Aliases.Add(TEXT("codex"));
    Aliases.Add(TEXT("assistant"));
    Aliases.Add(TEXT("aicopilot"));
    Aliases.Add(TEXT("factoryai"));
    Usage = NSLOCTEXT(
        "AIFactoryCopilot",
        "ChatCommand.Usage",
        "/ai <question> | /ai <status|scan|export|all|reset|help>");
    MinNumberOfArguments = 0;
    bOnlyUsableByPlayer = true;
}

EExecutionStatus AAIFactoryChatCommand::ExecuteCommand_Implementation(
    UCommandSender* Sender,
    const TArray<FString>& Arguments,
    const FString& Label)
{
    if (!IsValid(Sender))
    {
        return EExecutionStatus::UNCOMPLETED;
    }

    AAIFactorySubsystem* Subsystem = AAIFactorySubsystem::Get(Sender);
    if (!IsValid(Subsystem))
    {
        Sender->SendChatMessage(TEXT("AI Factory Copilot subsystem is not available in this world."));
        return EExecutionStatus::UNCOMPLETED;
    }

    if (Arguments.IsEmpty() || Arguments[0].Equals(TEXT("help"), ESearchCase::IgnoreCase))
    {
        SendHelp(Sender);
        return EExecutionStatus::COMPLETED;
    }

    const FString Subcommand = Arguments[0].ToLower();
    if (Subcommand == TEXT("status"))
    {
        const FAIFactorySettings& Settings = Subsystem->GetSettings();
        Sender->SendChatMessage(FString::Printf(
            TEXT("AI Factory Copilot ready | revision=%llu fingerprint=%u bridge=%s default-radius=%.0fm"),
            static_cast<unsigned long long>(Subsystem->GetWorldRevision()),
            Subsystem->GetWorldFingerprint(),
            *Settings.BridgeUrl,
            Settings.DefaultScanRadiusMeters));
        return EExecutionStatus::COMPLETED;
    }

    FAIFactorySnapshotRequest Request;
    Request.Center = GetScanCenter(Sender);
    Request.PlayerController = Sender->GetPlayer();
    Request.bUseRadius = true;
    Request.RadiusMeters = Subsystem->GetSettings().DefaultScanRadiusMeters;
    Request.bIncludeContentCatalog = Subsystem->GetSettings().bIncludeContentCatalog;
    Request.bIncludeReflectedProperties = Subsystem->GetSettings().bIncludeReflectedProperties;

    if (Subcommand == TEXT("scan"))
    {
        if (Arguments.Num() >= 2)
        {
            Request.RadiusMeters = FMath::Clamp(FCString::Atof(*Arguments[1]), 1.0f, 100000.0f);
        }
        const FAIFactorySnapshotResult Snapshot = Subsystem->BuildSnapshot(Request);
        Sender->SendChatMessage(FString::Printf(
            TEXT("Verified scan: actors=%d buildables=%d nodes=%d players=%d vehicles=%d pickups=%d adapters=%d recipes=%d items=%d mods=%d radius=%.0fm revision=%llu%s"),
            Snapshot.ActorCount,
            Snapshot.BuildableCount,
            Snapshot.ResourceNodeCount,
            Snapshot.PlayerCount,
            Snapshot.VehicleCount,
            Snapshot.PickupCount,
            Snapshot.AdapterActorCount,
            Snapshot.RecipeCount,
            Snapshot.ItemCount,
            Snapshot.ModCount,
            Request.RadiusMeters,
            static_cast<unsigned long long>(Subsystem->GetWorldRevision()),
            Snapshot.bActorLimitReached ? TEXT(" [actor limit reached]") : TEXT("")));
        return EExecutionStatus::COMPLETED;
    }

    if (Subcommand == TEXT("node"))
    {
        auto* NodePlayer = Sender->GetPlayer();
        UWorld* NodeWorld = IsValid(NodePlayer) ? NodePlayer->GetWorld() : nullptr;
        if (!IsValid(NodeWorld))
        {
            Sender->SendChatMessage(TEXT("No world."));
            return EExecutionStatus::UNCOMPLETED;
        }

        // Listing costs nothing and is what someone types first.
        const TMap<FString, TSubclassOf<UFGResourceDescriptor>> Known =
            AIFactoryNodeEdit::KnownResources(NodeWorld);
        const TMap<FString, TSubclassOf<UFGResourceDescriptor>> CreativeKnown =
            AIFactoryNodeEdit::KnownCreativeResources(NodeWorld);
        const TMap<FString, FAIFactoryCreativeNodeTemplate> TemplateKnown =
            AIFactoryNodeEdit::KnownCreativeNodeTemplates(NodeWorld);
        if (!Arguments.IsValidIndex(1))
        {
            TArray<FString> Names;
            for (const TPair<FString, TSubclassOf<UFGResourceDescriptor>>& Entry : CreativeKnown)
            {
                Names.Add(Entry.Key);
            }
            Names.Sort();
            Sender->SendChatMessage(FString::Printf(
                TEXT("Look at a node and run: /ai node <resource>. Registered resources: %s. ")
                TEXT("Use 'original' to undo a vanilla-node override. To place a new mod-owned node anywhere, ")
                TEXT("run /ai node place <resource> [impure|normal|pure]. The spawner also accepts liquid, gas, "
                TEXT("and geyser descriptors. Exact special mod nodes discovered in this live world ")
                TEXT("also appear in the panel's Node Spawner without being approximated as generic resources.")),
                *FString::Join(Names, TEXT(", "))));
            return EExecutionStatus::COMPLETED;
        }

        if (Arguments[1].Equals(TEXT("place-template"), ESearchCase::IgnoreCase))
        {
            if (!Arguments.IsValidIndex(2) || Arguments.Num() > 4)
            {
                Sender->SendChatMessage(TEXT(
                    "This command is generated by the Node Spawner for an exact discovered mod-node class. "
                    "Open the Copilot panel, select Node Spawner, and click its purity button."));
                return EExecutionStatus::BAD_ARGUMENTS;
            }

            EResourcePurity Purity = RP_Normal;
            if (Arguments.IsValidIndex(3))
            {
                const FString WantedPurity = Arguments[3].ToLower();
                if (WantedPurity == TEXT("impure"))
                {
                    Purity = RP_Inpure;
                }
                else if (WantedPurity == TEXT("normal"))
                {
                    Purity = RP_Normal;
                }
                else if (WantedPurity == TEXT("pure"))
                {
                    Purity = RP_Pure;
                }
                else
                {
                    Sender->SendChatMessage(TEXT("Purity must be impure, normal, or pure."));
                    return EExecutionStatus::BAD_ARGUMENTS;
                }
            }

            const FAIFactoryCreativeNodeTemplate* const Template =
                TemplateKnown.Find(Arguments[2].ToLower());
            if (Template == nullptr)
            {
                Sender->SendChatMessage(TEXT(
                    "That exact special node class is no longer proven by a live node. "
                    "Press Rescan in the Node Spawner and choose it again."));
                return EExecutionStatus::UNCOMPLETED;
            }

            FString Reason;
            if (!AIFactoryCreativeNodePlacement::ArmTemplateForPlayer(
                    NodePlayer,
                    Template->NodeClass,
                    Template->Resource,
                    Purity,
                    Reason))
            {
                Sender->SendChatMessage(FString::Printf(
                    TEXT("Special node template was not armed: %s."), *Reason));
                return EExecutionStatus::UNCOMPLETED;
            }

            Sender->SendChatMessage(FString::Printf(
                TEXT("Exact %s (%s) mod-node template armed. Place its normal Build Gun hologram; ")
                TEXT("the server will re-prove and construct %s, preserving that mod's behavior."),
                *Template->DisplayName,
                *StaticEnum<EResourcePurity>()->GetDisplayNameTextByValue(
                    static_cast<int64>(Purity)).ToString(),
                *Template->NodeClass->GetPathName()));
            return EExecutionStatus::COMPLETED;
        }

        if (Arguments[1].Equals(TEXT("place"), ESearchCase::IgnoreCase))
        {
            if (!Arguments.IsValidIndex(2))
            {
                Sender->SendChatMessage(TEXT(
                    "Usage: /ai node place <resource> [impure|normal|pure]. "
                    "The resource must be a registered solid, liquid, gas, or geyser descriptor."));
                return EExecutionStatus::BAD_ARGUMENTS;
            }

            EResourcePurity Purity = RP_Normal;
            int32 ResourceEnd = Arguments.Num();
            const FString LastArgument = Arguments.Last().ToLower();
            if (LastArgument == TEXT("impure"))
            {
                Purity = RP_Inpure;
                --ResourceEnd;
            }
            else if (LastArgument == TEXT("normal"))
            {
                Purity = RP_Normal;
                --ResourceEnd;
            }
            else if (LastArgument == TEXT("pure"))
            {
                Purity = RP_Pure;
                --ResourceEnd;
            }

            TArray<FString> ResourceWords;
            for (int32 Index = 2; Index < ResourceEnd; ++Index)
            {
                ResourceWords.Add(Arguments[Index]);
            }
            const FString WantedResource = FString::Join(ResourceWords, TEXT(" ")).ToLower();
            const TSubclassOf<UFGResourceDescriptor>* const Found = CreativeKnown.Find(WantedResource);
            if (Found == nullptr)
            {
                Sender->SendChatMessage(FString::Printf(
                    TEXT("No registered creative resource is called '%s'. Run /ai node with no argument to list them."),
                    *FString::Join(ResourceWords, TEXT(" "))));
                return EExecutionStatus::UNCOMPLETED;
            }

            const EResourceNodeType NodeType =
                AAIFactoryCreativeResourceNode::NodeTypeForResource(*Found);
            FString Reason;
            if (!AIFactoryCreativeNodePlacement::ArmForPlayer(
                    NodePlayer,
                    *Found,
                    Purity,
                    NodeType,
                    Reason))
            {
                Sender->SendChatMessage(FString::Printf(
                    TEXT("Creative node was not armed: %s."), *Reason));
                return EExecutionStatus::UNCOMPLETED;
            }

            Sender->SendChatMessage(FString::Printf(
                TEXT("Creative %s (%s) %s Build Gun arming was requested. ")
                TEXT("Place the hologram where you want it; this creates a new mod-owned infinite node and does not alter a map node. ")
                TEXT("Confirm the request by seeing the hologram; if it does not appear, equip the Build Gun and run the command again. ")
                TEXT("If you have already clicked a placement, wait for that placement to finish before changing its resource."),
                *UFGItemDescriptor::GetItemName(*Found).ToString(),
                *StaticEnum<EResourcePurity>()->GetDisplayNameTextByValue(
                    static_cast<int64>(Purity)).ToString(),
                NodeType == EResourceNodeType::Geyser ? TEXT("geyser")
                : UFGItemDescriptor::GetForm(*Found) == EResourceForm::RF_LIQUID ? TEXT("liquid")
                : UFGItemDescriptor::GetForm(*Found) == EResourceForm::RF_GAS ? TEXT("gas")
                : TEXT("solid")));
            return EExecutionStatus::COMPLETED;
        }

        // The node under the crosshair. Same trace the placement lane uses.
        // Resolved the way the game does. The previous version traced
        // ECC_Visibility directly and hit an AbstractInstanceManager, so it
        // reported nothing under a crosshair that was squarely on a node.
        AFGResourceNodeBase* Target =
            AIFactoryNodeEdit::NodeUnderCrosshair(Cast<APlayerController>(NodePlayer));
        if (!IsValid(Target))
        {
            Sender->SendChatMessage(TEXT(
                "Look directly at a resource node and run it again — nothing under the crosshair is one."));
            return EExecutionStatus::UNCOMPLETED;
        }

        const FString Wanted = Arguments[1].ToLower();
        TSubclassOf<UFGResourceDescriptor> Resource = nullptr;
        if (Wanted != TEXT("original") && Wanted != TEXT("reset"))
        {
            const TSubclassOf<UFGResourceDescriptor>* Found = Known.Find(Wanted);
            if (Found == nullptr)
            {
                Sender->SendChatMessage(FString::Printf(
                    TEXT("No registered solid resource is called '%s'. Run /ai node with no argument to list them."),
                    *Arguments[1]));
                return EExecutionStatus::UNCOMPLETED;
            }
            Resource = *Found;
        }

        FString Reason;
        if (!AIFactoryNodeEdit::SetNodeResource(NodePlayer, NodeWorld, Target, Resource, Reason))
        {
            Sender->SendChatMessage(FString::Printf(TEXT("Not changed: %s."), *Reason));
            return EExecutionStatus::UNCOMPLETED;
        }

        // Name the original as well, so the way back is on screen rather than
        // something to remember.
        const TSubclassOf<UFGResourceDescriptor> Original = Target->GetResourceClassOriginal();
        const bool bCreativeTarget =
            Target->IsA<AAIFactoryCreativeResourceNode>() ||
            Target->IsA<AAIFactoryCreativeOrdinaryResourceNode>();
        Sender->SendChatMessage(IsValid(Resource) && bCreativeTarget
            ? FString::Printf(
                TEXT("This creative node now yields %s. It is a new mod-owned node, so it has no vanilla original to restore."),
                *UFGItemDescriptor::GetItemName(Resource).ToString())
            : IsValid(Resource)
            ? FString::Printf(
                TEXT("This node now yields %s (originally %s). /ai node original puts it back."),
                *UFGItemDescriptor::GetItemName(Resource).ToString(),
                IsValid(Original) ? *UFGItemDescriptor::GetItemName(Original).ToString() : TEXT("unknown"))
            : FString::Printf(TEXT("Node restored to %s."),
                IsValid(Original) ? *UFGItemDescriptor::GetItemName(Original).ToString() : TEXT("its original resource")));
        return EExecutionStatus::COMPLETED;
    }

    if (Subcommand == TEXT("anchor") || Subcommand == TEXT("blueprintanchor"))
    {
        AFGPlayerController* const AnchorPlayer = Sender->GetPlayer();
        UWorld* const AnchorWorld = IsValid(AnchorPlayer) ? AnchorPlayer->GetWorld() : nullptr;
        if (!IsValid(AnchorWorld))
        {
            Sender->SendChatMessage(TEXT("No world."));
            return EExecutionStatus::UNCOMPLETED;
        }

        const TMap<FString, TSubclassOf<UFGResourceDescriptor>> Known =
            AIFactoryNodeEdit::KnownResources(AnchorWorld);
        if (!Arguments.IsValidIndex(1))
        {
            TArray<FString> Names;
            for (const TPair<FString, TSubclassOf<UFGResourceDescriptor>>& Entry : Known)
            {
                Names.Add(Entry.Key);
            }
            Names.Sort();
            Sender->SendChatMessage(FString::Printf(
                TEXT("Usage: /ai anchor <resource> [impure|normal|pure]. This arms a native Blueprint Resource Anchor in your Build Gun. Known solid resources: %s"),
                *FString::Join(Names, TEXT(", "))));
            return EExecutionStatus::COMPLETED;
        }

        const TSubclassOf<UFGResourceDescriptor>* const Resource =
            Known.Find(Arguments[1].ToLower());
        if (Resource == nullptr)
        {
            Sender->SendChatMessage(FString::Printf(
                TEXT("No known map resource called '%s'. Run /ai anchor with no arguments to list the exact available choices."),
                *Arguments[1]));
            return EExecutionStatus::UNCOMPLETED;
        }

        EResourcePurity Purity = RP_Normal;
        if (Arguments.IsValidIndex(2))
        {
            const FString WantedPurity = Arguments[2].ToLower();
            if (WantedPurity == TEXT("impure") || WantedPurity == TEXT("inpure"))
            {
                Purity = RP_Inpure;
            }
            else if (WantedPurity == TEXT("normal"))
            {
                Purity = RP_Normal;
            }
            else if (WantedPurity == TEXT("pure"))
            {
                Purity = RP_Pure;
            }
            else
            {
                Sender->SendChatMessage(TEXT("Purity must be impure, normal, or pure."));
                return EExecutionStatus::BAD_ARGUMENTS;
            }
        }

        FString Reason;
        if (!AIFactoryBlueprintResourceAnchorPlacement::ArmForPlayer(
                AnchorPlayer, *Resource, Purity, Reason))
        {
            Sender->SendChatMessage(FString::Printf(TEXT("Blueprint Resource Anchor was not armed: %s."), *Reason));
            return EExecutionStatus::UNCOMPLETED;
        }

        Sender->SendChatMessage(FString::Printf(
            TEXT("Blueprint Resource Anchor armed for %s (%s). Place it inside the native Blueprint Designer, then place a Miner Mk.1–Mk.3 on its node. The Miner still uses Satisfactory's normal snap, occupancy, and resource checks."),
            *UFGItemDescriptor::GetItemName(*Resource).ToString(),
            *StaticEnum<EResourcePurity>()->GetNameStringByValue(static_cast<int64>(Purity))));
        return EExecutionStatus::COMPLETED;
    }

    if (Subcommand == TEXT("terrain"))
    {
        // Defaults chosen to cover a cove or a build site in one go without
        // a visible freeze: 120 m at a 4 m pitch is about nine thousand
        // traces. Both are overridable because measuring a rock face wants a
        // finer pitch than surveying a valley.
        const double ScanRadius = Arguments.IsValidIndex(1)
            ? FCString::Atod(*Arguments[1])
            : 120.0;
        const double ScanStep = Arguments.IsValidIndex(2)
            ? FCString::Atod(*Arguments[2])
            : 4.0;

        auto* ScanPlayer = Sender->GetPlayer();
        UWorld* ScanWorld = IsValid(ScanPlayer) ? ScanPlayer->GetWorld() : nullptr;
        if (!IsValid(ScanWorld))
        {
            Sender->SendChatMessage(TEXT("No world to scan."));
            return EExecutionStatus::UNCOMPLETED;
        }

        // A frame is captured alongside, because a height field without a
        // picture is a grid of numbers nobody can orient. The two together
        // are what make a scan readable.
        AIFactoryVision::RequestFrame(ScanWorld, TEXT("terrain_scan"), true);

        const FString Written = AIFactoryTerrainScan::ScanToFile(
            ScanWorld,
            GetScanCenter(Sender),
            ScanRadius,
            ScanStep,
            TEXT("chat_command"));

        Sender->SendChatMessage(Written.IsEmpty()
            ? TEXT("The terrain scan could not be written.")
            : FString::Printf(
                TEXT("Scanned %.0f m at ~%.0f m spacing -> %s"),
                ScanRadius,
                ScanStep,
                *Written));
        return EExecutionStatus::COMPLETED;
    }

    if (Subcommand == TEXT("look"))
    {
        // On demand, so a player can hand over a view without enabling the
        // timer at all. Reports the directory rather than the filename: the
        // PNG does not exist yet when this returns.
        auto* CommandPlayer = Sender->GetPlayer();
        UWorld* CommandWorld = IsValid(CommandPlayer) ? CommandPlayer->GetWorld() : nullptr;
        AIFactoryVision::RequestFrame(CommandWorld, TEXT("requested"), true);
        Sender->SendChatMessage(FString::Printf(
            TEXT("Capturing a frame to %s (the file lands a moment from now)."),
            *AIFactoryVision::VisionDirectory()));
        return EExecutionStatus::COMPLETED;
    }

    if (Subcommand == TEXT("why"))
    {
        // Ask the live hologram why it refuses, instead of inferring it from
        // what the node looks like. Every property difference between a working
        // map node and a spawned one has been eliminated -- collision profile,
        // node class, mResourcesLeft, Build Gun ownership -- and a Miner still
        // reports "Must be placed on a Resource Node!". The hologram records
        // the actual reason in mConstructDisqualifiers, which is not a
        // UPROPERTY and so cannot be reached by the snapshot's reflection.
        AFGPlayerController* const WhyPlayer = Sender->GetPlayer();
        AFGCharacterPlayer* const WhyCharacter = IsValid(WhyPlayer)
            ? Cast<AFGCharacterPlayer>(WhyPlayer->GetPawn())
            : nullptr;
        AFGBuildGun* const WhyGun = IsValid(WhyCharacter) ? WhyCharacter->GetBuildGun() : nullptr;
        if (!IsValid(WhyGun))
        {
            Sender->SendChatMessage(TEXT("Equip the Build Gun first, then aim and run this again."));
            return EExecutionStatus::UNCOMPLETED;
        }

        UFGBuildGunStateBuild* const WhyState = Cast<UFGBuildGunStateBuild>(
            WhyGun->GetBuildGunStateFor(EBuildGunState::BGS_BUILD));
        AFGHologram* const WhyHologram = IsValid(WhyState) ? WhyState->GetHologram() : nullptr;
        if (!IsValid(WhyHologram))
        {
            Sender->SendChatMessage(TEXT(
                "No active hologram. Select the building (for example Miner Mk.1), aim at the "
                "node so the placement preview is showing, then run this again."));
            return EExecutionStatus::UNCOMPLETED;
        }

        TArray<TSubclassOf<UFGConstructDisqualifier>> Disqualifiers;
        WhyHologram->GetConstructDisqualifiers(Disqualifiers);

        // The Build Gun's own hit result is the input the hologram snaps from,
        // and it is not the same query as the camera/use traces the snapshot
        // records. GetHitResult is FORCEINLINE, so reading it costs no exported
        // symbol -- unlike UpdateMeshFromDescriptor, which linked in the editor
        // and failed the Shipping build.
        const FHitResult& GunHit = WhyGun->GetHitResult();
        FString Report = FString::Printf(
            TEXT("Hologram %s: canConstruct=%s, %d disqualifier(s) || gun hit: actor=%s class=%s comp=%s dist=%.2fm"),
            *GetNameSafe(WhyHologram->GetClass()),
            WhyHologram->CanConstruct() ? TEXT("true") : TEXT("false"),
            Disqualifiers.Num(),
            *GetNameSafe(GunHit.GetActor()),
            GunHit.GetActor() != nullptr ? *GetNameSafe(GunHit.GetActor()->GetClass()) : TEXT("none"),
            *GetNameSafe(GunHit.GetComponent()),
            GunHit.Distance / 100.0f);
        for (const TSubclassOf<UFGConstructDisqualifier>& Disqualifier : Disqualifiers)
        {
            Report += FString::Printf(TEXT(" | %s"), *GetNameSafe(Disqualifier.Get()));
        }
        // Both the working and failing cases hit the landscape, at the same
        // component -- so the hologram is not snapping from the hit actor at
        // all. It takes the hit LOCATION and searches nearby for an extractable
        // resource. The question is therefore why that search finds a vanilla
        // node and not ours, which comes down to what our box actually looks
        // like to a collision query at runtime. Report it rather than trusting
        // that SetCollisionProfileName("Resource") survived the two
        // SetCollisionResponseToChannel calls that follow it.
        UWorld* const WhyWorld = WhyGun->GetWorld();
        const FVector Probe = GunHit.ImpactPoint;
        if (IsValid(WhyWorld) && GunHit.bBlockingHit)
        {
            AFGResourceNode* Nearest = nullptr;
            double NearestDistSq = TNumericLimits<double>::Max();
            for (TActorIterator<AFGResourceNode> It(WhyWorld); It; ++It)
            {
                AFGResourceNode* const Candidate = *It;
                if (!IsValid(Candidate)) { continue; }
                const double DistSq = FVector::DistSquared(Candidate->GetActorLocation(), Probe);
                if (DistSq < NearestDistSq) { NearestDistSq = DistSq; Nearest = Candidate; }
            }
            if (IsValid(Nearest))
            {
                Report += FString::Printf(
                    TEXT(" || nearest node: %s (%s) at %.2fm"),
                    *Nearest->GetName(),
                    *GetNameSafe(Nearest->GetClass()),
                    FMath::Sqrt(NearestDistSq) / 100.0f);

                // Every primitive on that node, with what a query would see.
                TInlineComponentArray<UPrimitiveComponent*> Prims(Nearest);
                for (UPrimitiveComponent* const Prim : Prims)
                {
                    if (!IsValid(Prim)) { continue; }
                    Report += FString::Printf(
                        TEXT(" | %s enabled=%d objType=%d resp[Resource=%d Hologram=%d BuildGun=%d Vis=%d]"),
                        *Prim->GetName(),
                        static_cast<int32>(Prim->GetCollisionEnabled()),
                        static_cast<int32>(Prim->GetCollisionObjectType()),
                        static_cast<int32>(Prim->GetCollisionResponseToChannel(ECC_GameTraceChannel3)),
                        static_cast<int32>(Prim->GetCollisionResponseToChannel(ECC_GameTraceChannel2)),
                        static_cast<int32>(Prim->GetCollisionResponseToChannel(ECC_GameTraceChannel5)),
                        static_cast<int32>(Prim->GetCollisionResponseToChannel(ECC_Visibility)));
                }
            }
        }

        UE_LOG(LogAIFactoryCopilot, Display, TEXT("%s"), *Report);
        Sender->SendChatMessage(Report);
        return EExecutionStatus::COMPLETED;
    }

    if (Subcommand == TEXT("export"))
    {
        if (Arguments.Num() >= 2 && Arguments[1].Equals(TEXT("all"), ESearchCase::IgnoreCase))
        {
            Request.bUseRadius = false;
        }
        else if (Arguments.Num() >= 2)
        {
            Request.RadiusMeters = FMath::Clamp(FCString::Atof(*Arguments[1]), 1.0f, 100000.0f);
        }

        FString Path;
        FAIFactorySnapshotResult Snapshot;
        if (!Subsystem->ExportSnapshot(Request, Path, Snapshot))
        {
            Sender->SendChatMessage(TEXT("Snapshot export failed. Check FactoryGame.log."));
            return EExecutionStatus::UNCOMPLETED;
        }
        Sender->SendChatMessage(FString::Printf(
            TEXT("Exported %d verified actors, %d recipes, and %d items to %s"),
            Snapshot.ActorCount,
            Snapshot.RecipeCount,
            Snapshot.ItemCount,
            *Path));
        return EExecutionStatus::COMPLETED;
    }

    if (Subcommand == TEXT("ask") || Subcommand == TEXT("askall"))
    {
        if (Arguments.Num() < 2)
        {
            Sender->SendChatMessage(FString::Printf(
                TEXT("Usage: /aifactory %s <question>"),
                *Subcommand));
            return EExecutionStatus::BAD_ARGUMENTS;
        }
        Request.bUseRadius = Subcommand != TEXT("askall");
        Subsystem->AskBridge(Sender, JoinArguments(Arguments, 1), Request);
        return EExecutionStatus::COMPLETED;
    }

    if (Subcommand == TEXT("all"))
    {
        if (Arguments.Num() < 2)
        {
            Sender->SendChatMessage(TEXT("Usage: /ai all <question>"));
            return EExecutionStatus::BAD_ARGUMENTS;
        }
        Request.bUseRadius = false;
        Subsystem->AskBridge(Sender, JoinArguments(Arguments, 1), Request);
        return EExecutionStatus::COMPLETED;
    }

    if (Subcommand == TEXT("reset"))
    {
        Subsystem->ResetBridgeConversation(Sender);
        return EExecutionStatus::COMPLETED;
    }

    // Anything that is not an administrative subcommand is a natural-language
    // question. This makes "/ai what should I build here?" the primary UX.
    Subsystem->AskBridge(Sender, JoinArguments(Arguments, 0), Request);
    return EExecutionStatus::COMPLETED;
}

FVector AAIFactoryChatCommand::GetScanCenter(UCommandSender* Sender)
{
    if (IsValid(Sender))
    {
        if (AFGPlayerController* PlayerController = Sender->GetPlayer())
        {
            if (APawn* Pawn = PlayerController->GetPawn())
            {
                return Pawn->GetActorLocation();
            }
        }
    }
    return FVector::ZeroVector;
}

FString AAIFactoryChatCommand::JoinArguments(const TArray<FString>& Arguments, const int32 StartIndex)
{
    TArray<FString> Slice;
    for (int32 Index = StartIndex; Index < Arguments.Num(); ++Index)
    {
        Slice.Add(Arguments[Index]);
    }
    return FString::Join(Slice, TEXT(" "));
}

void AAIFactoryChatCommand::SendHelp(UCommandSender* Sender)
{
    Sender->SendChatMessage(TEXT("/ai <question> - chat using a fresh nearby snapshot, exact position, and current crosshair focus"));
    Sender->SendChatMessage(TEXT("/ai all <question> - chat using the whole-world live snapshot"));
    Sender->SendChatMessage(TEXT("/ai reset - clear this save/player conversation"));
    Sender->SendChatMessage(TEXT("/ai status | scan | terrain [radius_m] [step_m] | look | node [resource] | anchor <resource> [impure|normal|pure] | export [radius_m|all]"));
    Sender->SendChatMessage(TEXT("Examples: /ai what should I do here?  /ai is this machine connected correctly?"));
}
