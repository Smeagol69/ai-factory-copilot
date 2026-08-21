#include "AIFactoryChatCommand.h"
#include "AIFactoryVision.h"
#include "AIFactoryTerrainScan.h"

#include "AIFactorySubsystem.h"
#include "Command/CommandSender.h"
#include "FGPlayerController.h"
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
    Sender->SendChatMessage(TEXT("/ai status | scan [radius_m] | terrain [radius_m] [step_m] | look | export [radius_m|all]"));
    Sender->SendChatMessage(TEXT("Examples: /ai what should I do here?  /ai is this machine connected correctly?"));
}
