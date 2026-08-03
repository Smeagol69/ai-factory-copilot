#include "AIFactorySubsystem.h"

#include "AIFactoryActions.h"
#include "AIFactoryCopilotModule.h"
#include "AIFactoryWaypointDisplay.h"
#include "Command/ChatCommandLibrary.h"
#include "Command/CommandSender.h"
#include "Dom/JsonObject.h"
#include "Engine/World.h"
#include "EngineUtils.h"
#include "FGCharacterPlayer.h"
#include "FGGameState.h"
#include "FGPlayerController.h"
#include "HAL/FileManager.h"
#include "HttpModule.h"
#include "Hologram/FGHologram.h"
#include "Interfaces/IHttpRequest.h"
#include "Interfaces/IHttpResponse.h"
#include "Interfaces/IPluginManager.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Player/SMLRemoteCallObject.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "Subsystem/SubsystemActorManager.h"
#include "TimerManager.h"

namespace
{
    constexpr int32 SupportedActionContractVersion = 1;

    bool IsCommittedWorldWriteResult(const TSharedPtr<FJsonValue>& Value)
    {
        const TSharedPtr<FJsonObject>* Object = nullptr;
        if (!Value.IsValid() || !Value->TryGetObject(Object) || !Object)
        {
            return false;
        }

        bool bCommitted = false;
        FString Action;
        (*Object)->TryGetBoolField(TEXT("committed"), bCommitted);
        (*Object)->TryGetStringField(TEXT("action"), Action);
        // Only the drawn overlay is exempt. Map markers were briefly listed
        // here too, on the reasoning that a waypoint is just a marker — but
        // FMapMarker is a SaveGame property, so a waypoint survives a reload
        // and clearing one is a real deletion. Persistent state belongs behind
        // the write gate however harmless it looks on screen.
        return
            bCommitted &&
            Action != TEXT("highlight") &&
            Action != TEXT("clear_highlight");
    }

    FString DescribeActionResults(const TArray<TSharedPtr<FJsonValue>>& Results)
    {
        FString Description;
        for (int32 Index = 0; Index < Results.Num(); ++Index)
        {
            const TSharedPtr<FJsonObject>* Object = nullptr;
            if (!Results[Index].IsValid() ||
                !Results[Index]->TryGetObject(Object) ||
                !Object)
            {
                Description += FString::Printf(
                    TEXT("\n  %d. unknown: invalid result"),
                    Index + 1);
                continue;
            }

            FString Action = TEXT("unknown");
            FString Status = TEXT("not_run");
            FString Reason;
            (*Object)->TryGetStringField(TEXT("action"), Action);
            (*Object)->TryGetStringField(TEXT("status"), Status);
            (*Object)->TryGetStringField(TEXT("reason"), Reason);

            const TArray<TSharedPtr<FJsonValue>>* Created = nullptr;
            const TArray<TSharedPtr<FJsonValue>>* Removed = nullptr;
            (*Object)->TryGetArrayField(TEXT("created_actor_ids"), Created);
            (*Object)->TryGetArrayField(TEXT("removed_actor_ids"), Removed);

            Description += FString::Printf(
                TEXT("\n  %d. %s: %s"),
                Index + 1,
                *Action,
                *Status);
            if (!Reason.IsEmpty())
            {
                Description += TEXT(" - ") + Reason;
            }
            if (Created && Created->Num() > 0)
            {
                Description += FString::Printf(
                    TEXT(" (created %d actor%s)"),
                    Created->Num(),
                    Created->Num() == 1 ? TEXT("") : TEXT("s"));
            }
            if (Removed && Removed->Num() > 0)
            {
                Description += FString::Printf(
                    TEXT(" (removed %d actor%s)"),
                    Removed->Num(),
                    Removed->Num() == 1 ? TEXT("") : TEXT("s"));
            }
        }
        return Description;
    }
}

AAIFactorySubsystem::AAIFactorySubsystem()
{
    ReplicationPolicy = ESubsystemReplicationPolicy::SpawnOnServer;
    bReplicates = false;
    PrimaryActorTick.bCanEverTick = false;
}

AFGCharacterPlayer* AAIFactorySubsystem::FindLocalPlayerCharacter() const
{
    UWorld* World = GetWorld();
    if (!IsValid(World))
    {
        return nullptr;
    }
    // Prefer the controlled pawn: on a listen server that is the player whose
    // question this is. Fall back to the first player character in the world so
    // a dedicated server with one connected client still resolves.
    for (FConstPlayerControllerIterator It = World->GetPlayerControllerIterator(); It; ++It)
    {
        if (APlayerController* Controller = It->Get())
        {
            if (AFGCharacterPlayer* Character = Cast<AFGCharacterPlayer>(Controller->GetPawn()))
            {
                return Character;
            }
        }
    }
    for (TActorIterator<AFGCharacterPlayer> It(World); It; ++It)
    {
        if (IsValid(*It))
        {
            return *It;
        }
    }
    return nullptr;
}

AAIFactorySubsystem* AAIFactorySubsystem::Get(const UObject* WorldContext)
{
    if (!IsValid(WorldContext) || !IsValid(WorldContext->GetWorld()))
    {
        return nullptr;
    }

    USubsystemActorManager* Manager = WorldContext->GetWorld()->GetSubsystem<USubsystemActorManager>();
    return IsValid(Manager) ? Manager->GetSubsystemActor<AAIFactorySubsystem>() : nullptr;
}

void AAIFactorySubsystem::Init()
{
    Super::Init();
    Settings = FAIFactorySettings::Load();
    WorldFingerprint = FAIFactorySnapshot::ComputeWorldFingerprint(GetWorld());
    UE_LOG(LogAIFactoryCopilot, Display,
        TEXT("Authoritative scanner initialized. Bridge=%s Radius=%.1fm"),
        *Settings.BridgeUrl,
        Settings.DefaultScanRadiusMeters);
}

void AAIFactorySubsystem::BeginPlay()
{
    Super::BeginPlay();
    // The journal contains live object pointers and must never survive a world
    // transition. In particular, "undo" in a newly loaded save must not target
    // actors or a player from the previous save.
    AIFactoryActions::ClearUndoJournal();

    if (UWorld* World = GetWorld())
    {
        ActorSpawnedHandle = World->AddOnActorSpawnedHandler(
            FOnActorSpawned::FDelegate::CreateUObject(this, &AAIFactorySubsystem::HandleActorSpawned));

        for (TActorIterator<AActor> It(World); It; ++It)
        {
            AttachActorObserver(*It);
        }

        World->GetTimerManager().SetTimer(
            ObserverTimer,
            this,
            &AAIFactorySubsystem::ObserveWorld,
            Settings.ObserverIntervalSeconds,
            true);

        if (Settings.bStartupSelfTest)
        {
            UE_LOG(LogAIFactoryCopilot, Display,
                TEXT("Startup self-test enabled; authoritative export and AI chat command will run in %.1fs"),
                Settings.StartupSelfTestDelaySeconds);
            World->GetTimerManager().SetTimer(
                StartupSelfTestTimer,
                this,
                &AAIFactorySubsystem::RunStartupSelfTest,
                Settings.StartupSelfTestDelaySeconds,
                false);
        }
    }
}

void AAIFactorySubsystem::EndPlay(const EEndPlayReason::Type EndPlayReason)
{
    if (UWorld* World = GetWorld())
    {
        World->GetTimerManager().ClearTimer(ObserverTimer);
        World->GetTimerManager().ClearTimer(StartupSelfTestTimer);
        if (ActorSpawnedHandle.IsValid())
        {
            World->RemoveOnActorSpawnedHandler(ActorSpawnedHandle);
        }
    }

    AIFactoryActions::ClearUndoJournal();
    Super::EndPlay(EndPlayReason);
}

void AAIFactorySubsystem::ObserveWorld()
{
    const uint32 NewFingerprint = FAIFactorySnapshot::ComputeWorldFingerprint(GetWorld());
    if (NewFingerprint != WorldFingerprint)
    {
        WorldFingerprint = NewFingerprint;
        MarkWorldDirty();
    }

    // Native FMapMarker only controls whether the compass icon is in range; it
    // does not provide the resource scanner's dynamic text. Keep the Copilot's
    // own marker names synchronized to the exact live player distance instead.
    AIFactoryWaypointDisplay::Refresh(GetWorld(), FindLocalPlayerCharacter());
}

void AAIFactorySubsystem::RunStartupSelfTest()
{
    if (!Settings.bStartupSelfTest)
    {
        return;
    }

    ++StartupSelfTestAttempts;
    AFGPlayerController* PlayerController =
        IsValid(GetWorld()) ? Cast<AFGPlayerController>(GetWorld()->GetFirstPlayerController()) : nullptr;
    USMLRemoteCallObject* RemoteCallObject = IsValid(PlayerController)
        ? Cast<USMLRemoteCallObject>(
            PlayerController->GetRemoteCallObjectOfClass(USMLRemoteCallObject::StaticClass()))
        : nullptr;
    AChatCommandSubsystem* ChatCommandSubsystem = AChatCommandSubsystem::Get(this);

    if (!IsValid(RemoteCallObject) ||
        !IsValid(RemoteCallObject->CommandSender) ||
        !IsValid(ChatCommandSubsystem))
    {
        if (StartupSelfTestAttempts < 10 && IsValid(GetWorld()))
        {
            UE_LOG(LogAIFactoryCopilot, Display,
                TEXT("Startup self-test waiting for player chat services (attempt %d/10)"),
                StartupSelfTestAttempts);
            GetWorld()->GetTimerManager().SetTimer(
                StartupSelfTestTimer,
                this,
                &AAIFactorySubsystem::RunStartupSelfTest,
                2.0f,
                false);
        }
        else
        {
            UE_LOG(LogAIFactoryCopilot, Error,
                TEXT("Startup self-test could not obtain a player command sender"));
        }
        return;
    }

    const EExecutionStatus ExportStatus = ChatCommandSubsystem->RunChatCommand(
        TEXT("aifactory export 250"),
        RemoteCallObject->CommandSender);
    const FString AskCommand = FString::Printf(
        TEXT("aifactory ask \"%s\""),
        *Settings.StartupSelfTestQuestion.ReplaceCharWithEscapedChar());
    const EExecutionStatus AskStatus = ChatCommandSubsystem->RunChatCommand(
        AskCommand,
        RemoteCallObject->CommandSender);

    UE_LOG(LogAIFactoryCopilot, Display,
        TEXT("Startup self-test dispatched through SML chat commands: export=%d ask=%d"),
        static_cast<int32>(ExportStatus),
        static_cast<int32>(AskStatus));
}

void AAIFactorySubsystem::MarkWorldDirty()
{
    ++WorldRevision;
}

void AAIFactorySubsystem::HandleActorSpawned(AActor* Actor)
{
    // Action preflight uses short-lived vanilla holograms to ask the game for
    // its real placement verdict. They are validation objects, not world state.
    if (IsValid(Actor) && Actor->IsA(AFGHologram::StaticClass()))
    {
        return;
    }
    AttachActorObserver(Actor);
    MarkWorldDirty();
}

void AAIFactorySubsystem::HandleActorDestroyed(AActor* Actor)
{
    MarkWorldDirty();
}

void AAIFactorySubsystem::AttachActorObserver(AActor* Actor)
{
    if (IsValid(Actor) &&
        !Actor->IsA(AFGHologram::StaticClass()) &&
        !Actor->OnDestroyed.IsAlreadyBound(this, &AAIFactorySubsystem::HandleActorDestroyed))
    {
        Actor->OnDestroyed.AddDynamic(this, &AAIFactorySubsystem::HandleActorDestroyed);
    }
}

FAIFactorySnapshotResult AAIFactorySubsystem::BuildSnapshot(const FAIFactorySnapshotRequest& Request) const
{
    return FAIFactorySnapshot::Build(GetWorld(), Request, Settings, WorldRevision);
}

bool AAIFactorySubsystem::ExportSnapshot(
    const FAIFactorySnapshotRequest& Request,
    FString& OutPath,
    FAIFactorySnapshotResult& OutResult) const
{
    OutResult = BuildSnapshot(Request);
    const FString Directory = FPaths::Combine(FPaths::ProjectSavedDir(), TEXT("AIFactoryCopilot"), TEXT("Snapshots"));
    IFileManager::Get().MakeDirectory(*Directory, true);

    OutPath = FPaths::Combine(Directory, TEXT("latest.json"));
    if (!FFileHelper::SaveStringToFile(
        OutResult.Json,
        *OutPath,
        FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM))
    {
        UE_LOG(LogAIFactoryCopilot, Error, TEXT("Failed to write snapshot to %s"), *OutPath);
        return false;
    }

    UE_LOG(LogAIFactoryCopilot, Display,
        TEXT("Exported authoritative snapshot: actors=%d recipes=%d items=%d mods=%d path=%s"),
        OutResult.ActorCount,
        OutResult.RecipeCount,
        OutResult.ItemCount,
        OutResult.ModCount,
        *OutPath);
    return true;
}

void AAIFactorySubsystem::AskBridge(
    UCommandSender* Sender,
    const FString& Question,
    const FAIFactorySnapshotRequest& Request,
    const bool bEchoToGameChat)
{
    if (!IsValid(Sender) || Question.TrimStartAndEnd().IsEmpty())
    {
        return;
    }

    const FString QuestionReceivedAtUtc = FDateTime::UtcNow().ToIso8601();
    FAIFactorySnapshotRequest EffectiveRequest = Request;
    if (!IsValid(EffectiveRequest.PlayerController))
    {
        EffectiveRequest.PlayerController = Sender->GetPlayer();
    }
    const FAIFactorySnapshotResult Snapshot = BuildSnapshot(EffectiveRequest);
    TSharedPtr<FJsonObject> SnapshotObject;
    const TSharedRef<TJsonReader<>> SnapshotReader = TJsonReaderFactory<>::Create(Snapshot.Json);
    if (!FJsonSerializer::Deserialize(SnapshotReader, SnapshotObject) || !SnapshotObject.IsValid())
    {
        const FString Error = TEXT("AI Factory Copilot could not serialize the current world snapshot.");
        if (bEchoToGameChat)
        {
            Sender->SendChatMessage(Error);
        }
        OnBridgeResult.Broadcast(Sender, false, Error, TEXT(""), TEXT(""));
        return;
    }

    const TSharedRef<FJsonObject> Payload = MakeShared<FJsonObject>();
    Payload->SetStringField(TEXT("schema"), TEXT("aifactory.ask"));
    Payload->SetNumberField(TEXT("schema_version"), 1);
    Payload->SetStringField(TEXT("session_id"), GetBridgeSessionId(Sender));
    Payload->SetStringField(TEXT("question_received_at_game_utc"), QuestionReceivedAtUtc);
    Payload->SetStringField(TEXT("request_sent_at_game_utc"), FDateTime::UtcNow().ToIso8601());
    Payload->SetStringField(TEXT("question"), Question);
    Payload->SetObjectField(TEXT("world_snapshot"), SnapshotObject.ToSharedRef());
    Payload->SetStringField(TEXT("response_policy"),
        TEXT("Use only supplied authoritative/calculated data. State unknowns explicitly. Never invent game state."));

    FString Body;
    const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Body);
    FJsonSerializer::Serialize(Payload, Writer);

    const TSharedRef<IHttpRequest, ESPMode::ThreadSafe> HttpRequest = FHttpModule::Get().CreateRequest();
    HttpRequest->SetURL(Settings.BridgeUrl);
    HttpRequest->SetVerb(TEXT("POST"));
    HttpRequest->SetHeader(TEXT("Content-Type"), TEXT("application/json"));
    HttpRequest->SetHeader(TEXT("X-AIFactory-Schema"), TEXT("1"));
    HttpRequest->SetContentAsString(Body);

    const TWeakObjectPtr<UCommandSender> WeakSender(Sender);
    const TWeakObjectPtr<AAIFactorySubsystem> WeakThis(this);
    FString ExpectedBridgeVersion;
    if (const TSharedPtr<IPlugin> CopilotPlugin =
            IPluginManager::Get().FindPlugin(TEXT("AIFactoryCopilot"));
        CopilotPlugin.IsValid())
    {
        ExpectedBridgeVersion = CopilotPlugin->GetDescriptor().VersionName;
    }
    HttpRequest->OnProcessRequestComplete().BindLambda(
        [WeakSender, WeakThis, bEchoToGameChat, ExpectedBridgeVersion](
            FHttpRequestPtr RequestPtr,
            FHttpResponsePtr Response,
            const bool bConnectedSuccessfully)
        {
            if (!WeakSender.IsValid() || !WeakThis.IsValid())
            {
                return;
            }

            if (!bConnectedSuccessfully || !Response.IsValid())
            {
                const FString Error =
                    TEXT("AI bridge is unreachable. Start companion/server.mjs and verify AIFactoryCopilot.cfg.");
                UE_LOG(LogAIFactoryCopilot, Error, TEXT("AI bridge request failed: no valid HTTP response"));
                if (bEchoToGameChat)
                {
                    WeakSender->SendChatMessage(Error);
                }
                WeakThis->OnBridgeResult.Broadcast(WeakSender.Get(), false, Error, TEXT(""), TEXT(""));
                return;
            }

            const FString DiagnosticsDirectory =
                FPaths::Combine(FPaths::ProjectSavedDir(), TEXT("AIFactoryCopilot"), TEXT("Diagnostics"));
            IFileManager::Get().MakeDirectory(*DiagnosticsDirectory, true);
            const FString DiagnosticsPath =
                FPaths::Combine(DiagnosticsDirectory, TEXT("latest-bridge-response.json"));
            if (!FFileHelper::SaveStringToFile(
                Response->GetContentAsString(),
                *DiagnosticsPath,
                FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM))
            {
                UE_LOG(LogAIFactoryCopilot, Warning,
                    TEXT("Could not persist AI bridge diagnostic response to %s"),
                    *DiagnosticsPath);
            }

            TSharedPtr<FJsonObject> ResponseJson;
            const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Response->GetContentAsString());
            if (!FJsonSerializer::Deserialize(Reader, ResponseJson) || !ResponseJson.IsValid())
            {
                const FString Error = FString::Printf(
                    TEXT("AI bridge returned invalid JSON (HTTP %d)."),
                    Response->GetResponseCode());
                UE_LOG(LogAIFactoryCopilot, Error,
                    TEXT("AI bridge returned invalid JSON: http=%d path=%s"),
                    Response->GetResponseCode(),
                    *DiagnosticsPath);
                if (bEchoToGameChat)
                {
                    WeakSender->SendChatMessage(Error);
                }
                WeakThis->OnBridgeResult.Broadcast(WeakSender.Get(), false, Error, TEXT(""), TEXT(""));
                return;
            }

            FString Reply;
            if (!ResponseJson->TryGetStringField(TEXT("reply"), Reply))
            {
                FString Error;
                ResponseJson->TryGetStringField(TEXT("error"), Error);
                Reply = Error.IsEmpty() ? TEXT("AI bridge returned no reply.") : Error;
            }
            FString Provider;
            FString Model;
            ResponseJson->TryGetStringField(TEXT("provider"), Provider);
            ResponseJson->TryGetStringField(TEXT("model"), Model);
            const bool bSuccess =
                Response->GetResponseCode() >= 200 &&
                Response->GetResponseCode() < 300 &&
                ResponseJson->HasField(TEXT("reply"));

            // A reply may carry world-mutating actions. They run here, on the
            // server, after the answer is parsed — never inside the bridge,
            // which has no authority over the world.
            const TArray<TSharedPtr<FJsonValue>>* Actions = nullptr;
            if (bSuccess && ResponseJson->TryGetArrayField(TEXT("actions"), Actions) && Actions)
            {
                const FAIFactorySettings ActionSettings = FAIFactorySettings::Load();
                int32 ActionContractVersion = 0;
                FString BridgeVersion;
                const bool bHasActionContract = ResponseJson->TryGetNumberField(
                    TEXT("action_contract_version"),
                    ActionContractVersion);
                const bool bHasBridgeVersion = ResponseJson->TryGetStringField(
                    TEXT("bridge_version"),
                    BridgeVersion);

                FString RefusalReason;
                if (Actions->Num() > 0 &&
                    (!bHasActionContract ||
                     ActionContractVersion != SupportedActionContractVersion))
                {
                    RefusalReason = FString::Printf(
                        TEXT("unsupported action contract (expected %d, received %s)"),
                        SupportedActionContractVersion,
                        bHasActionContract
                            ? *LexToString(ActionContractVersion)
                            : TEXT("missing"));
                }
                else if (Actions->Num() > 0 &&
                    (!bHasBridgeVersion ||
                     ExpectedBridgeVersion.IsEmpty() ||
                     BridgeVersion != ExpectedBridgeVersion))
                {
                    RefusalReason = FString::Printf(
                        TEXT("bridge/mod version mismatch (mod %s, bridge %s)"),
                        ExpectedBridgeVersion.IsEmpty()
                            ? TEXT("unknown")
                            : *ExpectedBridgeVersion,
                        bHasBridgeVersion ? *BridgeVersion : TEXT("missing"));
                }
                else if (Actions->Num() > ActionSettings.MaxActionsPerReply)
                {
                    RefusalReason = FString::Printf(
                        TEXT("action plan contains %d steps, exceeding maxActionsPerReply=%d"),
                        Actions->Num(),
                        ActionSettings.MaxActionsPerReply);
                }

                TArray<TSharedPtr<FJsonValue>> ActionResults;
                FString ActionSummary;
                if (RefusalReason.IsEmpty())
                {
                    ActionSummary = AIFactoryActions::ExecutePlan(
                        WeakThis->GetWorld(),
                        WeakThis->FindLocalPlayerCharacter(),
                        *Actions,
                        ActionSettings.bAllowWriteActions,
                        LexToString(WeakThis->GetWorldRevision()),
                        ActionResults);
                }
                else
                {
                    ActionSummary = TEXT("No actions ran: ") + RefusalReason + TEXT(".");
                    UE_LOG(LogAIFactoryCopilot, Error,
                        TEXT("AI bridge action plan refused whole: %s"),
                        *RefusalReason);
                }

                if (!ActionSummary.IsEmpty())
                {
                    Reply += TEXT("\n\n") + ActionSummary;
                    Reply += DescribeActionResults(ActionResults);
                    if (RefusalReason.IsEmpty() && !ActionSettings.bAllowWriteActions)
                    {
                        Reply += TEXT(
                            "\nWrite actions are off, so nothing was changed. "
                            "Set \"allowWriteActions\": true in the copilot config to let these run.");
                    }
                }

                const bool bCommittedWorldWrite =
                    ActionResults.ContainsByPredicate(IsCommittedWorldWriteResult);
                if (bCommittedWorldWrite)
                {
                    // Teleports do not spawn or destroy an actor, so they need
                    // an explicit revision change even though build/dismantle
                    // actions are also observed by the actor callbacks.
                    WeakThis->MarkWorldDirty();
                }

                ResponseJson->SetArrayField(TEXT("game_action_results"), ActionResults);
                ResponseJson->SetStringField(TEXT("game_action_summary"), ActionSummary);
                ResponseJson->SetBoolField(
                    TEXT("game_write_actions_enabled"),
                    ActionSettings.bAllowWriteActions);
                ResponseJson->SetBoolField(
                    TEXT("game_world_was_mutated"),
                    bCommittedWorldWrite);
                ResponseJson->SetBoolField(
                    TEXT("game_actions_refused"),
                    !RefusalReason.IsEmpty());
                ResponseJson->SetStringField(
                    TEXT("game_actions_refusal_reason"),
                    RefusalReason);
                ResponseJson->SetNumberField(
                    TEXT("game_actions_requested_count"),
                    Actions->Num());
                ResponseJson->SetNumberField(
                    TEXT("game_actions_executed_count"),
                    ActionResults.Num());
                ResponseJson->SetBoolField(
                    TEXT("game_actions_truncated"),
                    false);
                ResponseJson->SetStringField(
                    TEXT("game_world_revision_after"),
                    LexToString(WeakThis->GetWorldRevision()));
                UE_LOG(LogAIFactoryCopilot, Display,
                    TEXT("AI bridge actions: requested=%d executed=%d writes_enabled=%d"),
                    Actions->Num(),
                    ActionResults.Num(),
                    ActionSettings.bAllowWriteActions ? 1 : 0);
            }
            ResponseJson->SetStringField(TEXT("reply_with_game_outcome"), Reply);
            FString EnrichedResponse;
            const TSharedRef<TJsonWriter<>> EnrichedWriter =
                TJsonWriterFactory<>::Create(&EnrichedResponse);
            if (!FJsonSerializer::Serialize(ResponseJson.ToSharedRef(), EnrichedWriter) ||
                !FFileHelper::SaveStringToFile(
                    EnrichedResponse,
                    *DiagnosticsPath,
                    FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM))
            {
                UE_LOG(LogAIFactoryCopilot, Warning,
                    TEXT("Could not persist enriched game action results to %s"),
                    *DiagnosticsPath);
            }
            UE_LOG(LogAIFactoryCopilot, Display,
                TEXT("AI bridge answer received: http=%d provider=%s model=%s reply_chars=%d path=%s"),
                Response->GetResponseCode(),
                Provider.IsEmpty() ? TEXT("unknown") : *Provider,
                Model.IsEmpty() ? TEXT("unknown") : *Model,
                Reply.Len(),
                *DiagnosticsPath);
            if (bEchoToGameChat)
            {
                AAIFactorySubsystem::SendChatInChunks(WeakSender.Get(), Reply);
            }
            WeakThis->OnBridgeResult.Broadcast(WeakSender.Get(), bSuccess, Reply, Provider, Model);
        });

    if (!HttpRequest->ProcessRequest())
    {
        const FString Error = TEXT("AI Factory Copilot could not start the bridge request.");
        if (bEchoToGameChat)
        {
            Sender->SendChatMessage(Error);
        }
        OnBridgeResult.Broadcast(Sender, false, Error, TEXT(""), TEXT(""));
        return;
    }

    if (bEchoToGameChat)
    {
        Sender->SendChatMessage(FString::Printf(
            TEXT("AI Factory Copilot captured your exact position and focus; analyzing %d verified actors..."),
            Snapshot.ActorCount));
    }
}

void AAIFactorySubsystem::ResetBridgeConversation(UCommandSender* Sender)
{
    if (!IsValid(Sender))
    {
        return;
    }

    const TSharedRef<FJsonObject> Payload = MakeShared<FJsonObject>();
    Payload->SetStringField(TEXT("schema"), TEXT("aifactory.session.reset"));
    Payload->SetNumberField(TEXT("schema_version"), 1);
    Payload->SetStringField(TEXT("session_id"), GetBridgeSessionId(Sender));

    FString Body;
    const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Body);
    FJsonSerializer::Serialize(Payload, Writer);

    const TSharedRef<IHttpRequest, ESPMode::ThreadSafe> HttpRequest = FHttpModule::Get().CreateRequest();
    HttpRequest->SetURL(GetBridgeResetUrl());
    HttpRequest->SetVerb(TEXT("POST"));
    HttpRequest->SetHeader(TEXT("Content-Type"), TEXT("application/json"));
    HttpRequest->SetHeader(TEXT("X-AIFactory-Schema"), TEXT("1"));
    HttpRequest->SetContentAsString(Body);

    const TWeakObjectPtr<UCommandSender> WeakSender(Sender);
    HttpRequest->OnProcessRequestComplete().BindLambda(
        [WeakSender](FHttpRequestPtr RequestPtr, FHttpResponsePtr Response, const bool bConnectedSuccessfully)
        {
            if (!WeakSender.IsValid())
            {
                return;
            }
            if (!bConnectedSuccessfully || !Response.IsValid())
            {
                WeakSender->SendChatMessage(TEXT("AI bridge is unreachable; conversation was not reset."));
                return;
            }
            if (Response->GetResponseCode() < 200 || Response->GetResponseCode() >= 300)
            {
                WeakSender->SendChatMessage(FString::Printf(
                    TEXT("AI bridge could not reset the conversation (HTTP %d)."),
                    Response->GetResponseCode()));
                return;
            }
            WeakSender->SendChatMessage(TEXT("AI Factory Copilot conversation reset for this save and player."));
        });

    if (!HttpRequest->ProcessRequest())
    {
        Sender->SendChatMessage(TEXT("AI Factory Copilot could not start the reset request."));
    }
}

FString AAIFactorySubsystem::GetBridgeSessionId(UCommandSender* Sender) const
{
    const UWorld* World = GetWorld();
    FString SessionName = TEXT("unknown-session");
    if (IsValid(World))
    {
        if (const AFGGameState* GameState = World->GetGameState<AFGGameState>())
        {
            SessionName = GameState->GetSessionName();
        }
    }
    return FString::Printf(
        TEXT("%s:%s:%s"),
        IsValid(World) ? *World->GetMapName() : TEXT("unknown-map"),
        *SessionName,
        IsValid(Sender) ? *Sender->GetSenderName() : TEXT("unknown-player"));
}

FString AAIFactorySubsystem::GetBridgeResetUrl() const
{
    FString Url = Settings.BridgeUrl;
    constexpr int32 AskPathLength = 7;
    if (Url.EndsWith(TEXT("/v1/ask"), ESearchCase::IgnoreCase))
    {
        Url.LeftChopInline(AskPathLength);
        Url += TEXT("/v1/reset");
        return Url;
    }
    if (!Url.EndsWith(TEXT("/")))
    {
        Url += TEXT("/");
    }
    Url += TEXT("v1/reset");
    return Url;
}

void AAIFactorySubsystem::SendChatInChunks(UCommandSender* Sender, const FString& Message)
{
    if (!IsValid(Sender))
    {
        return;
    }

    constexpr int32 MaximumChunkLength = 480;
    FString Remaining = Message;
    while (!Remaining.IsEmpty())
    {
        int32 SplitAt = FMath::Min(MaximumChunkLength, Remaining.Len());
        if (SplitAt < Remaining.Len())
        {
            int32 NewlineIndex = INDEX_NONE;
            int32 SpaceIndex = INDEX_NONE;
            Remaining.FindLastChar(TEXT('\n'), NewlineIndex);
            const FString Candidate = Remaining.Left(SplitAt);
            Candidate.FindLastChar(TEXT(' '), SpaceIndex);
            if (NewlineIndex > 0 && NewlineIndex < SplitAt)
            {
                SplitAt = NewlineIndex;
            }
            else if (SpaceIndex > 0)
            {
                SplitAt = SpaceIndex;
            }
        }

        Sender->SendChatMessage(Remaining.Left(SplitAt).TrimStartAndEnd());
        Remaining.RightChopInline(SplitAt);
        Remaining.TrimStartInline();
    }
}
