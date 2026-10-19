#include "AIFactoryPlaytestMailbox.h"

#include "AIFactorySubsystem.h"
#include "AIFactorySettings.h"
#include "Command/ChatCommandLibrary.h"
#include "Command/CommandSender.h"
#include "Dom/JsonObject.h"
#include "Engine/World.h"
#include "FGGameState.h"
#include "FGPlayerController.h"
#include "HAL/FileManager.h"
#include "HAL/PlatformFileManager.h"
#include "Misc/DateTime.h"
#include "Misc/FileHelper.h"
#include "Misc/Guid.h"
#include "Misc/Paths.h"
#include "Player/SMLRemoteCallObject.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"

namespace
{
    constexpr int64 AIFactoryPlaytestMaximumRequestBytes = 16384;
    constexpr int32 AIFactoryPlaytestMaximumQuestionCharacters = 4000;
    constexpr int32 AIFactoryPlaytestMaximumConsumedIds = 256;

    FString AIFactoryPlaytestDirectory()
    {
        return FPaths::Combine(FPaths::ProjectSavedDir(), TEXT("AIFactoryCopilot/Diagnostics/Playtest"));
    }

    bool AIFactoryPlaytestWrite(const FString& Path, const TSharedRef<FJsonObject>& Object)
    {
        IFileManager& Files = IFileManager::Get();
        if (!Files.MakeDirectory(*FPaths::GetPath(Path), true)) return false;
        FString Text;
        if (!FJsonSerializer::Serialize(Object, TJsonWriterFactory<>::Create(&Text))) return false;
        const FString Temporary = Path + TEXT(".tmp");
        return FFileHelper::SaveStringToFile(Text, *Temporary,
            FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM) &&
            Files.Move(*Path, *Temporary, true, false, false, true);
    }

    bool AIFactoryPlaytestUuid(const FString& Value)
    {
        FGuid Id;
        return Value.Len() == 36 && FGuid::ParseExact(Value, EGuidFormats::DigitsWithHyphensLower, Id) &&
            Id.IsValid() && Id.ToString(EGuidFormats::DigitsWithHyphensLower) == Value;
    }

    bool AIFactoryPlaytestPublishImmutable(const FString& Path, const TSharedRef<FJsonObject>& Object)
    {
        IPlatformFile& Platform = FPlatformFileManager::Get().GetPlatformPhysical();
        if (Platform.FileExists(*Path) || !Platform.CreateDirectoryTree(*FPaths::GetPath(Path))) return false;
        // Exact local engine verification: IFileManager::Move deletes an old
        // destination first, while FWindowsPlatformFile::MoveFile delegates to
        // MoveFileW without replacement. FILEWRITE_NoReplaceExisting is ignored
        // by FFileManagerGeneric, so it is NOT our exclusivity guarantee.
        // Each attempt owns a random staging name; only the final no-replace
        // platform rename can publish an ID. Orphan/partial staging fails closed.
        const FString Staging = Path + TEXT(".") + FGuid::NewGuid().ToString(EGuidFormats::DigitsWithHyphensLower) + TEXT(".staging");
        FString Text;
        if (!FJsonSerializer::Serialize(Object, TJsonWriterFactory<>::Create(&Text))) return false;
        TUniquePtr<IFileHandle> Writer(Platform.OpenWrite(*Staging));
        if (!Writer) return false;
        FTCHARToUTF8 Utf8(*Text);
        const bool bHealthy = Writer->Write(reinterpret_cast<const uint8*>(Utf8.Get()), Utf8.Length());
        const bool bFlushed = Writer->Flush(true);
        Writer.Reset();
        return bHealthy && bFlushed && Platform.MoveFile(*Path, *Staging);
    }
}

TSharedRef<FJsonObject> FAIFactoryPlaytestMailbox::Identity(AAIFactorySubsystem& Subsystem)
{
    if (WorldInstance.IsEmpty()) WorldInstance = FGuid::NewGuid().ToString(EGuidFormats::DigitsWithHyphensLower);
    UWorld* World = Subsystem.GetWorld();
    AFGGameState* State = IsValid(World) ? World->GetGameState<AFGGameState>() : nullptr;
    AFGPlayerController* Controller = IsValid(World) ? Cast<AFGPlayerController>(World->GetFirstPlayerController()) : nullptr;
    if (SelectedController.Get() != Controller || (!IsValid(Controller) && !SelectedPlayerIdentity.IsEmpty()))
    {
        SelectedController = Controller;
        SelectedPlayerIdentity = IsValid(Controller)
            ? Controller->GetPathName() + TEXT("|") + FGuid::NewGuid().ToString(EGuidFormats::DigitsWithHyphensLower) : TEXT("");
    }
    const TSharedRef<FJsonObject> Object = MakeShared<FJsonObject>();
    Object->SetStringField(TEXT("map"), IsValid(World) ? World->GetMapName() : TEXT(""));
    Object->SetStringField(TEXT("session"), IsValid(State) ? State->GetSessionName() : TEXT(""));
    Object->SetStringField(TEXT("world_instance"), WorldInstance);
    Object->SetStringField(TEXT("player"), SelectedPlayerIdentity);
    Object->SetStringField(TEXT("world_revision"), LexToString(Subsystem.GetWorldRevision()));
    Object->SetStringField(TEXT("recorded_at_game_utc"), FDateTime::UtcNow().ToIso8601());
    return Object;
}

bool FAIFactoryPlaytestMailbox::LoadConsumedMarkers(AAIFactorySubsystem& Subsystem)
{
    if (bMarkersLoaded) return LedgerFailure.IsEmpty();
    bMarkersLoaded = true;
    IFileManager& Files = IFileManager::Get();
    // Never silently discard the older replacement-based consumption format.
    if (Files.FileExists(*FPaths::Combine(AIFactoryPlaytestDirectory(), TEXT("consumed.json"))))
    {
        LedgerFailure = TEXT("legacy_consumption_ledger_requires_review");
        return false;
    }
    const FString Directory = FPaths::Combine(AIFactoryPlaytestDirectory(), TEXT("consumed"));
    TArray<FString> Names;
    Files.FindFiles(Names, *FPaths::Combine(Directory, TEXT("*")), true, false);
    if (Names.Num() > AIFactoryPlaytestMaximumConsumedIds)
    {
        LedgerFailure = TEXT("consumed_marker_capacity_reached");
        return false;
    }
    for (const FString& Name : Names)
    {
        if (Name.EndsWith(TEXT(".staging")))
            { LedgerFailure = TEXT("orphan_consumption_staging_file"); return false; }
        const FString Id = Name.LeftChop(9); // ".consumed"
        const FString Path = FPaths::Combine(Directory, Name);
        const int64 Size = Files.FileSize(*Path);
        FString Text, Schema, MarkerId, Operation, Map, Session, Instance, Player;
        TSharedPtr<FJsonObject> Marker;
        if (!Name.EndsWith(TEXT(".consumed")) || !AIFactoryPlaytestUuid(Id) || Size <= 0 || Size > 16384 ||
            !FFileHelper::LoadFileToString(Text, *Path) ||
            !FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Text), Marker) || !Marker.IsValid() ||
            !Marker->TryGetStringField(TEXT("schema"), Schema) || Schema != TEXT("aifactory.playtest-consumed/v2") ||
            !Marker->TryGetStringField(TEXT("id"), MarkerId) || MarkerId != Id ||
            !Marker->TryGetStringField(TEXT("operation"), Operation) ||
            (Operation != TEXT("capture") && Operation != TEXT("look") && Operation != TEXT("askall")) ||
            !Marker->TryGetStringField(TEXT("map"), Map) || Map.IsEmpty() ||
            !Marker->TryGetStringField(TEXT("session"), Session) || Session.IsEmpty() ||
            !Marker->TryGetStringField(TEXT("world_instance"), Instance) || !AIFactoryPlaytestUuid(Instance) ||
            !Marker->TryGetStringField(TEXT("player"), Player) || Player.IsEmpty())
        {
            LedgerFailure = TEXT("consumed_marker_invalid");
            return false;
        }
        ConsumedRequestIds.Add(Id);
        FString ReceiptText;
        TSharedPtr<FJsonObject> Receipt;
        const FString ReceiptPath = FPaths::Combine(AIFactoryPlaytestDirectory(), TEXT("results"), Id + TEXT(".json"));
        bool bTerminal = false;
        FString ReceiptId, ReceiptSchema;
        const int64 ReceiptSize = Files.FileSize(*ReceiptPath);
        bool bMatchingTerminal = ReceiptSize > 0 && ReceiptSize <= 1048576 &&
            FFileHelper::LoadFileToString(ReceiptText, *ReceiptPath) &&
            FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(ReceiptText), Receipt) && Receipt.IsValid() &&
            Receipt->TryGetStringField(TEXT("id"), ReceiptId) && ReceiptId == Id &&
            Receipt->TryGetStringField(TEXT("schema"), ReceiptSchema) && ReceiptSchema == TEXT("aifactory.playtest-result/v1") &&
            Receipt->TryGetBoolField(TEXT("terminal"), bTerminal) && bTerminal;
        if (bMatchingTerminal)
            for (const TCHAR* Field : {TEXT("map"), TEXT("session"), TEXT("world_instance"), TEXT("player"), TEXT("operation")})
            {
                FString ReceiptField;
                if (!Receipt->TryGetStringField(Field, ReceiptField) || ReceiptField != Marker->GetStringField(Field))
                    { bMatchingTerminal = false; break; }
            }
        if (bMatchingTerminal) continue;
        // A published marker without a terminal receipt is never dispatched
        // again. Recovery retains the original map/session/world/player scope.
        if (!WriteResult(Subsystem, Id, Operation, true, TEXT("outcome_unknown"),
            TEXT("interrupted_after_consumption_outcome_unknown"), nullptr, Marker))
            { LedgerFailure = TEXT("interrupted_result_persist_failed"); return false; }
    }
    return LedgerFailure.IsEmpty();
}

bool FAIFactoryPlaytestMailbox::PersistConsumedId(const FString& RequestId, const FString& Operation,
    const TSharedRef<FJsonObject>& Scope)
{
    const TSharedRef<FJsonObject> Marker = MakeShared<FJsonObject>();
    Marker->Values = Scope->Values;
    Marker->SetStringField(TEXT("schema"), TEXT("aifactory.playtest-consumed/v2"));
    Marker->SetStringField(TEXT("id"), RequestId);
    Marker->SetStringField(TEXT("operation"), Operation);
    if (!AIFactoryPlaytestPublishImmutable(FPaths::Combine(AIFactoryPlaytestDirectory(), TEXT("consumed"), RequestId + TEXT(".consumed")), Marker))
        { LedgerFailure = TEXT("persist_consumed_id_failed"); return false; }
    ConsumedRequestIds.Add(RequestId);
    InFlightRequestId = RequestId;
    InFlightOperation = Operation;
    InFlightScope = Marker;
    return true;
}

bool FAIFactoryPlaytestMailbox::WriteResult(AAIFactorySubsystem& Subsystem, const FString& RequestId,
    const FString& Operation, const bool bAccepted, const FString& State,
    const FString& Reason, const TSharedPtr<FJsonObject>& Response, const TSharedPtr<FJsonObject>& OriginalScope)
{
    const TSharedRef<FJsonObject> CurrentScope = Identity(Subsystem);
    const TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
    const TSharedPtr<FJsonObject> SavedScope = OriginalScope.IsValid() ? OriginalScope :
        (RequestId == InFlightRequestId ? InFlightScope : nullptr);
    Result->Values = SavedScope.IsValid() ? SavedScope->Values : CurrentScope->Values;
    Result->SetObjectField(TEXT("current_scope"), CurrentScope);
    Result->SetStringField(TEXT("recorded_at_game_utc"), FDateTime::UtcNow().ToIso8601());
    Result->SetStringField(TEXT("schema"), TEXT("aifactory.playtest-result/v1"));
    Result->SetStringField(TEXT("id"), RequestId);
    Result->SetStringField(TEXT("operation"), Operation);
    Result->SetBoolField(TEXT("accepted"), bAccepted);
    Result->SetStringField(TEXT("state"), State);
    Result->SetBoolField(TEXT("terminal"), State != TEXT("accepted"));
    Result->SetStringField(TEXT("reason"), Reason);
    if (Response.IsValid())
    {
        // Keep only native outcome evidence. Questions, model prose, snapshots,
        // screenshot bytes and other private provider payloads never go here.
        for (const TCHAR* Field : {TEXT("game_action_results"), TEXT("game_world_was_mutated"),
            TEXT("game_actions_refused"), TEXT("game_actions_refusal_reason"),
            TEXT("game_actions_requested_count"), TEXT("game_actions_executed_count"),
            TEXT("game_world_revision_after"), TEXT("game_client_blueprint_preview_dispatched")})
        {
            if (const TSharedPtr<FJsonValue>* Value = Response->Values.Find(Field)) Result->SetField(Field, *Value);
        }
    }
    FString BoundedCheck;
    if (!FJsonSerializer::Serialize(Result, TJsonWriterFactory<>::Create(&BoundedCheck))) return false;
    if (BoundedCheck.Len() > 262144)
    {
        // At most 1 MiB even for four-byte UTF-8 text. The retained native
        // diagnostics remain the complete evidence if a very large plan wins.
        Result->RemoveField(TEXT("game_action_results"));
        Result->SetBoolField(TEXT("game_action_results_omitted_due_to_size"), true);
    }
    return AIFactoryPlaytestWrite(FPaths::Combine(AIFactoryPlaytestDirectory(), TEXT("results"), RequestId + TEXT(".json")), Result);
}

void FAIFactoryPlaytestMailbox::Interrupt(AAIFactorySubsystem& Subsystem)
{
    if (InFlightRequestId.IsEmpty()) return;
    if (!WriteResult(Subsystem, InFlightRequestId, InFlightOperation, true, TEXT("outcome_unknown"),
        TEXT("interrupted_after_consumption_outcome_unknown")))
    {
        LedgerFailure = TEXT("interrupted_result_persist_failed");
        return;
    }
    InFlightRequestId.Empty();
    InFlightOperation.Empty();
    InFlightScope.Reset();
}

void FAIFactoryPlaytestMailbox::CompleteAsk(AAIFactorySubsystem& Subsystem, const FString& RequestId,
    const TSharedPtr<FJsonObject>& Response, const bool bOutcomesPersisted, const FString& Failure)
{
    if (RequestId.IsEmpty() || RequestId != InFlightRequestId) return;
    const bool bComplete = Response.IsValid() && bOutcomesPersisted && Failure.IsEmpty();
    const bool bScopeRefused = Failure.StartsWith(TEXT("playtest_scope_changed"));
    if (!WriteResult(Subsystem, RequestId, TEXT("askall"), true,
        bComplete ? TEXT("completed") : (bScopeRefused ? TEXT("refused") : TEXT("outcome_unknown")),
        bComplete ? TEXT("native_response_processed") : Failure, Response))
    {
        LedgerFailure = TEXT("terminal_result_persist_failed");
        return;
    }
    InFlightRequestId.Empty();
    InFlightOperation.Empty();
    InFlightScope.Reset();
}

bool FAIFactoryPlaytestMailbox::ValidateActiveScope(AAIFactorySubsystem& Subsystem,
    const FString& RequestId, UCommandSender* Sender)
{
    if (RequestId.IsEmpty() || RequestId != InFlightRequestId || !InFlightScope.IsValid()) return false;
    const TSharedRef<FJsonObject> Current = Identity(Subsystem);
    for (const TCHAR* Field : {TEXT("map"), TEXT("session"), TEXT("world_instance"), TEXT("player")})
        if (Current->GetStringField(Field) != InFlightScope->GetStringField(Field)) return false;
    return IsValid(Sender) && SelectedController.IsValid() && Sender->GetPlayer() == SelectedController.Get() &&
        Subsystem.GetWorld() == SelectedController->GetWorld() &&
        Subsystem.GetWorld()->GetNetMode() != NM_Client;
}

void FAIFactoryPlaytestMailbox::Tick(AAIFactorySubsystem& Subsystem)
{
    check(IsInGameThread());
    UWorld* World = Subsystem.GetWorld();
    const bool bEnabled = FAIFactorySettings::Load().bEnablePlaytestMailbox;
    const bool bAuthority = IsValid(World) && World->GetNetMode() != NM_Client;
    const TSharedRef<FJsonObject> Status = Identity(Subsystem);
    const bool bLiveWorld = bAuthority && !Status->GetStringField(TEXT("session")).IsEmpty() && SelectedController.IsValid();
    // The very first ready heartbeat must include marker validation/recovery.
    // A fresh world alone cannot promise that persisted consumption is usable.
    // Disabled observation does not load or repair the consumption store.
    const bool bMarkersHealthy = bEnabled && bLiveWorld && LoadConsumedMarkers(Subsystem);
    const bool bAcceptingRequests = bLiveWorld && bEnabled && bMarkersHealthy && LedgerFailure.IsEmpty() &&
        ConsumedRequestIds.Num() < AIFactoryPlaytestMaximumConsumedIds && InFlightRequestId.IsEmpty();
    FString StatusReason = LastStatusReason;
    if (!LedgerFailure.IsEmpty()) StatusReason = LedgerFailure;
    else if (!bEnabled) StatusReason = TEXT("disabled");
    else if (!bAuthority) StatusReason = TEXT("not_server_authoritative");
    else if (!bLiveWorld) StatusReason = TEXT("live_player_world_not_ready");
    else if (!bMarkersHealthy) StatusReason = TEXT("consumed_markers_not_ready");
    else if (ConsumedRequestIds.Num() >= AIFactoryPlaytestMaximumConsumedIds) StatusReason = TEXT("consumed_marker_capacity_reached");
    else if (!InFlightRequestId.IsEmpty()) StatusReason = TEXT("another_request_is_in_flight");
    Status->SetStringField(TEXT("schema"), TEXT("aifactory.playtest-status/v1"));
    Status->SetBoolField(TEXT("enabled"), bEnabled);
    Status->SetBoolField(TEXT("live_world"), bLiveWorld);
    Status->SetBoolField(TEXT("accepting_requests"), bAcceptingRequests);
    Status->SetStringField(TEXT("last_tick_game_utc"), FDateTime::UtcNow().ToIso8601());
    Status->SetStringField(TEXT("in_flight_id"), InFlightRequestId);
    Status->SetNumberField(TEXT("consumed_ids"), ConsumedRequestIds.Num());
    Status->SetNumberField(TEXT("maximum_consumed_ids"), AIFactoryPlaytestMaximumConsumedIds);
    Status->SetStringField(TEXT("reason"), StatusReason);
    if (!AIFactoryPlaytestWrite(FPaths::Combine(AIFactoryPlaytestDirectory(), TEXT("status.json")), Status)) return;
    if (!bAcceptingRequests) return;

    const FString RequestPath = FPaths::Combine(AIFactoryPlaytestDirectory(), TEXT("request.json"));
    const int64 Size = IFileManager::Get().FileSize(*RequestPath);
    if (Size == -1) return;
    if (Size <= 0 || Size > AIFactoryPlaytestMaximumRequestBytes)
    {
        LastStatusReason = TEXT("request_size_out_of_bounds");
        return;
    }
    FString Text;
    if (!FFileHelper::LoadFileToString(Text, *RequestPath) || Text == LastRequestText) return;
    LastRequestText = Text;
    TSharedPtr<FJsonObject> Request;
    if (!FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Text), Request) || !Request.IsValid())
    {
        LastStatusReason = TEXT("request_json_invalid");
        return;
    }
    FString Id;
    if (!Request->TryGetStringField(TEXT("id"), Id) || !AIFactoryPlaytestUuid(Id))
    {
        LastStatusReason = TEXT("request_id_requires_lowercase_uuid");
        return;
    }
    // Preserve the original receipt when a producer leaves/replays request.json.
    if (ConsumedRequestIds.Contains(Id))
    {
        LastStatusReason = TEXT("request_id_already_consumed");
        return;
    }
    FString Operation;
    Request->TryGetStringField(TEXT("operation"), Operation);
    // Refusal identifies the submitted job, even when its old world/player is
    // precisely why it was refused. This is receipt data, never live authority;
    // WriteResult independently records the actual identity in current_scope.
    TSharedPtr<FJsonObject> RequestedScope;
    FString RequestedMap, RequestedSession, RequestedWorldInstance, RequestedPlayer;
    if (Request->TryGetStringField(TEXT("expected_map"), RequestedMap) && !RequestedMap.IsEmpty() &&
        Request->TryGetStringField(TEXT("expected_session"), RequestedSession) && !RequestedSession.IsEmpty() &&
        Request->TryGetStringField(TEXT("expected_world_instance"), RequestedWorldInstance) && AIFactoryPlaytestUuid(RequestedWorldInstance) &&
        Request->TryGetStringField(TEXT("expected_player"), RequestedPlayer) && !RequestedPlayer.IsEmpty())
    {
        RequestedScope = MakeShared<FJsonObject>();
        RequestedScope->SetStringField(TEXT("map"), RequestedMap);
        RequestedScope->SetStringField(TEXT("session"), RequestedSession);
        RequestedScope->SetStringField(TEXT("world_instance"), RequestedWorldInstance);
        RequestedScope->SetStringField(TEXT("player"), RequestedPlayer);
    }
    const auto Refuse = [&](const FString& Reason)
    {
        LastStatusReason = Reason;
        WriteResult(Subsystem, Id, Operation, false, TEXT("refused"), Reason, nullptr, RequestedScope);
    };
    const TSet<FString> Fields = {TEXT("schema"), TEXT("id"), TEXT("expires_at_utc"), TEXT("expected_map"),
        TEXT("expected_session"), TEXT("expected_world_instance"), TEXT("expected_player"), TEXT("operation"), TEXT("question")};
    for (const TPair<FString, TSharedPtr<FJsonValue>>& Field : Request->Values)
        if (!Fields.Contains(Field.Key)) { Refuse(TEXT("unexpected_request_field")); return; }
    FString Schema, ExpectedMap, ExpectedSession, ExpectedWorldInstance, ExpectedPlayer, ExpiryText;
    FDateTime Expiry;
    const FDateTime Now = FDateTime::UtcNow();
    if (!Request->TryGetStringField(TEXT("schema"), Schema) || Schema != TEXT("aifactory.playtest-request/v1"))
        { Refuse(TEXT("unsupported_request_schema")); return; }
    if (!Request->TryGetStringField(TEXT("expires_at_utc"), ExpiryText) || !ExpiryText.EndsWith(TEXT("Z")) ||
        !FDateTime::ParseIso8601(*ExpiryText, Expiry) || Expiry <= Now || Expiry > Now + FTimespan::FromMinutes(10))
        { Refuse(TEXT("request_expiry_must_be_future_utc_within_ten_minutes")); return; }
    if (!Request->TryGetStringField(TEXT("expected_map"), ExpectedMap) ||
        !Request->TryGetStringField(TEXT("expected_session"), ExpectedSession) ||
        !Request->TryGetStringField(TEXT("expected_world_instance"), ExpectedWorldInstance) ||
        !Request->TryGetStringField(TEXT("expected_player"), ExpectedPlayer) ||
        ExpectedMap != Status->GetStringField(TEXT("map")) || ExpectedSession != Status->GetStringField(TEXT("session")) ||
        ExpectedWorldInstance != Status->GetStringField(TEXT("world_instance")) || ExpectedPlayer != Status->GetStringField(TEXT("player")))
        { Refuse(TEXT("expected_world_scope_does_not_match")); return; }
    if (Operation != TEXT("capture") && Operation != TEXT("look") && Operation != TEXT("askall"))
        { Refuse(TEXT("operation_not_supported")); return; }
    FString Question;
    if (Operation == TEXT("askall"))
    {
        if (!Request->TryGetStringField(TEXT("question"), Question) || Question.TrimStartAndEnd().IsEmpty() ||
            Question.Len() > AIFactoryPlaytestMaximumQuestionCharacters)
            { Refuse(TEXT("question_requires_one_to_4000_characters")); return; }
        for (const TCHAR Character : Question)
            if (Character < 32 || Character == 127) { Refuse(TEXT("question_contains_control_character")); return; }
    }
    else if (Request->HasField(TEXT("question"))) { Refuse(TEXT("question_only_allowed_for_askall")); return; }
    if (!InFlightRequestId.IsEmpty()) { Refuse(TEXT("another_request_is_in_flight")); return; }
    if (!LedgerFailure.IsEmpty()) { Refuse(LedgerFailure); return; }
    if (ConsumedRequestIds.Num() >= AIFactoryPlaytestMaximumConsumedIds)
        { Refuse(TEXT("consumed_marker_capacity_reached")); return; }
    AFGPlayerController* Controller = Cast<AFGPlayerController>(World->GetFirstPlayerController());
    USMLRemoteCallObject* Rco = IsValid(Controller)
        ? Cast<USMLRemoteCallObject>(Controller->GetRemoteCallObjectOfClass(USMLRemoteCallObject::StaticClass())) : nullptr;
    AChatCommandSubsystem* Commands = AChatCommandSubsystem::Get(&Subsystem);
    if (!IsValid(Rco) || !IsValid(Rco->CommandSender) || !IsValid(Commands))
        { Refuse(TEXT("player_command_sender_not_ready")); return; }
    if (!PersistConsumedId(Id, Operation, Status)) { Refuse(TEXT("persist_consumed_id_failed")); return; }
    if (!WriteResult(Subsystem, Id, Operation, true, TEXT("accepted"), TEXT("consumed_before_dispatch")))
    {
        LedgerFailure = TEXT("accepted_result_persist_failed");
        return;
    }
    LastStatusReason.Empty();
    if (!ValidateActiveScope(Subsystem, Id, Rco->CommandSender))
    {
        WriteResult(Subsystem, Id, Operation, true, TEXT("refused"), TEXT("playtest_scope_changed_before_dispatch"));
        InFlightRequestId.Empty();
        InFlightOperation.Empty();
        InFlightScope.Reset();
        return;
    }
    if (Operation == TEXT("askall"))
    {
        FAIFactorySnapshotRequest Capture;
        Capture.PlayerController = Controller;
        Capture.bUseRadius = false;
        Capture.bIncludeContentCatalog = Subsystem.GetSettings().bIncludeContentCatalog;
        Capture.bIncludeReflectedProperties = Subsystem.GetSettings().bIncludeReflectedProperties;
        Subsystem.AskBridge(Rco->CommandSender, Question, Capture, false, Id);
        return;
    }
    // Only these two constant commands enter SML. No request text is parsed as
    // console/chat commands. COMPLETED means the command returned, not that an
    // asynchronous screenshot already exists or has useful pixels.
    const EExecutionStatus CommandStatus = Operation == TEXT("capture")
        ? Commands->RunChatCommand(TEXT("aifactory export all"), Rco->CommandSender)
        : Commands->RunChatCommand(TEXT("aifactory look"), Rco->CommandSender);
    const bool bCompleted = CommandStatus == EExecutionStatus::COMPLETED;
    if (!WriteResult(Subsystem, Id, Operation, true, bCompleted ? TEXT("completed") : TEXT("failed"),
        bCompleted ? (Operation == TEXT("capture") ? TEXT("capture_exported") : TEXT("screenshot_requested"))
            : TEXT("native_command_did_not_complete")))
        { LedgerFailure = TEXT("terminal_result_persist_failed"); return; }
    InFlightRequestId.Empty();
    InFlightOperation.Empty();
    InFlightScope.Reset();
}
