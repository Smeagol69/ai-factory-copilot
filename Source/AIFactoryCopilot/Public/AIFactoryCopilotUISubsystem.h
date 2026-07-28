#pragma once

#include "Containers/Ticker.h"
#include "CoreMinimal.h"
#include "Subsystems/GameInstanceSubsystem.h"
#include "AIFactoryCopilotUISubsystem.generated.h"

class AAIFactorySubsystem;
class AFGPlayerController;
class IInputProcessor;
class SEditableTextBox;
class SMultiLineEditableTextBox;
class STextBlock;
class SWidget;
class UCommandSender;

/**
 * Local, screenshot-free conversation panel. Insert toggles the panel and the
 * status strip follows the live pawn/crosshair while it is open.
 */
UCLASS()
class AIFACTORYCOPILOT_API UAIFactoryCopilotUISubsystem final : public UGameInstanceSubsystem
{
    GENERATED_BODY()

public:
    virtual void Initialize(FSubsystemCollectionBase& Collection) override;
    virtual void Deinitialize() override;

    void TogglePanel();
    void HidePanel();
    bool IsPanelVisible() const { return bPanelVisible; }

private:
    TSharedPtr<IInputProcessor> InputProcessor;
    TSharedPtr<SWidget> RootWidget;
    /** Multi-line so a question can be typed the way the player would say it. */
    TSharedPtr<SMultiLineEditableTextBox> InputBox;
    TSharedPtr<SMultiLineEditableTextBox> TranscriptBox;
    TSharedPtr<STextBlock> LiveStatusText;
    TSharedPtr<STextBlock> RequestStatusText;
    FTSTicker::FDelegateHandle TickerHandle;
    FDelegateHandle BridgeResultHandle;
    TWeakObjectPtr<AAIFactorySubsystem> BoundSubsystem;
    TWeakObjectPtr<UCommandSender> PendingSender;
    FString Transcript;
    double RequestStartSeconds = 0.0;
    bool bPanelVisible = false;
    bool bWaitingForAnswer = false;
    bool bPreviousShowMouseCursor = false;
    bool bSuppressedGameInput = false;
    bool bFocusInputOnNextTick = false;

    void BuildPanel();
    void ShowPanel();
    void SubmitQuestion();
    void ClearConversation();
    void AppendTranscript(const FString& Speaker, const FString& Text);
    bool Tick(float DeltaTime);
    void UpdateLiveStatus();
    bool AreWriteActionsEnabled() const;
    FString GetReadyStatus() const;
    void RefreshReadyStatus();
    AFGPlayerController* GetLocalPlayerController() const;
    UCommandSender* GetLocalCommandSender(AFGPlayerController* PlayerController) const;
    AAIFactorySubsystem* GetCopilotSubsystem() const;
    void BindToBridge(AAIFactorySubsystem* Subsystem);
    void HandleBridgeResult(
        UCommandSender* Sender,
        bool bSuccess,
        const FString& Reply,
        const FString& Provider,
        const FString& Model);
};
