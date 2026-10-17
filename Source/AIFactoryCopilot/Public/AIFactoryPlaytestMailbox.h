#pragma once

#include "CoreMinimal.h"

class AAIFactorySubsystem;
class FJsonObject;
class AFGPlayerController;
class UCommandSender;

/** Opt-in local test ingress. The observer owns its game-thread lifetime.
 * Fixed paths, bounded requests, persistent consumption before dispatch, and
 * existing game/bridge execution only: never a second world-write executor.
 */
struct FAIFactoryPlaytestMailbox
{
    void Tick(AAIFactorySubsystem& Subsystem);
    void CompleteAsk(AAIFactorySubsystem& Subsystem, const FString& RequestId,
        const TSharedPtr<FJsonObject>& Response, bool bOutcomesPersisted, const FString& Failure);
    void Interrupt(AAIFactorySubsystem& Subsystem);
    bool ValidateActiveScope(AAIFactorySubsystem& Subsystem, const FString& RequestId, UCommandSender* Sender);

private:
    bool bMarkersLoaded = false;
    FString LedgerFailure;
    TArray<FString> ConsumedRequestIds;
    FString InFlightRequestId;
    FString InFlightOperation;
    FString LastRequestText;
    FString LastStatusReason;
    FString WorldInstance;
    FString SelectedPlayerIdentity;
    TWeakObjectPtr<AFGPlayerController> SelectedController;
    TSharedPtr<FJsonObject> InFlightScope;

    TSharedRef<FJsonObject> Identity(AAIFactorySubsystem& Subsystem);
    bool LoadConsumedMarkers(AAIFactorySubsystem& Subsystem);
    bool PersistConsumedId(const FString& RequestId, const FString& Operation, const TSharedRef<FJsonObject>& Scope);
    bool WriteResult(AAIFactorySubsystem& Subsystem, const FString& RequestId,
        const FString& Operation, bool bAccepted, const FString& State,
        const FString& Reason, const TSharedPtr<FJsonObject>& Response = nullptr,
        const TSharedPtr<FJsonObject>& OriginalScope = nullptr);
};
