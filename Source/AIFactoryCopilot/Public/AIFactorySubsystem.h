#pragma once

#include "AIFactorySettings.h"
#include "AIFactorySnapshot.h"
#include "Subsystem/ModSubsystem.h"
#include "AIFactorySubsystem.generated.h"

class UCommandSender;

DECLARE_MULTICAST_DELEGATE_FiveParams(
    FAIFactoryBridgeResult,
    UCommandSender*,
    bool,
    const FString&,
    const FString&,
    const FString&);

UCLASS()
class AIFACTORYCOPILOT_API AAIFactorySubsystem final : public AModSubsystem
{
    GENERATED_BODY()

public:
    AAIFactorySubsystem();

    static AAIFactorySubsystem* Get(const UObject* WorldContext);

    const FAIFactorySettings& GetSettings() const { return Settings; }
    uint64 GetWorldRevision() const { return WorldRevision; }
    uint32 GetWorldFingerprint() const { return WorldFingerprint; }

    FAIFactorySnapshotResult BuildSnapshot(const FAIFactorySnapshotRequest& Request) const;
    bool ExportSnapshot(
        const FAIFactorySnapshotRequest& Request,
        FString& OutPath,
        FAIFactorySnapshotResult& OutResult) const;
    void AskBridge(
        UCommandSender* Sender,
        const FString& Question,
        const FAIFactorySnapshotRequest& Request,
        bool bEchoToGameChat = true);
    void ResetBridgeConversation(UCommandSender* Sender);
    FAIFactoryBridgeResult OnBridgeResult;

protected:
    virtual void Init() override;
    virtual void BeginPlay() override;
    virtual void EndPlay(const EEndPlayReason::Type EndPlayReason) override;

private:
    FAIFactorySettings Settings;
    uint64 WorldRevision = 1;
    uint32 WorldFingerprint = 0;
    FTimerHandle ObserverTimer;
    FTimerHandle StartupSelfTestTimer;
    FDelegateHandle ActorSpawnedHandle;
    int32 StartupSelfTestAttempts = 0;

    void ObserveWorld();
    void RunStartupSelfTest();
    void MarkWorldDirty();
    void HandleActorSpawned(AActor* Actor);

    UFUNCTION()
    void HandleActorDestroyed(AActor* Actor);

    void AttachActorObserver(AActor* Actor);
    FString GetBridgeSessionId(UCommandSender* Sender) const;
    FString GetBridgeResetUrl() const;
    static void SendChatInChunks(UCommandSender* Sender, const FString& Message);
};
