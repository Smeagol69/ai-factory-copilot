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
    /**
     * Whether the assistant half is actually there.
     *
     * Tracked so the panel can say "assistant offline" instead of "Ready"
     * when no companion is running. The selection and export half needs no
     * bridge, so an offline panel is degraded rather than broken -- which is
     * the difference between a mod someone keeps installed and one they
     * uninstall on the first launch.
     */
    bool bBridgeEverTried = false;
    bool bBridgeAnswered = false;

    /**
     * The box selection, as a panel rather than as a sentence.
     *
     * The owner asked for "a slider, and it shows a preview of what's going to
     * be saved", so clicking a megabase piece by piece with the dismantle tool
     * is not the only way in. Everything here is deliberately local: the world
     * is right there, so a drag queries actors and repaints the highlight
     * without a bridge round trip. An HTTP call per slider frame would never
     * feel like a slider.
     */
    TSharedPtr<class SSlider> WidthSlider;
    TSharedPtr<class SSlider> DepthSlider;
    TSharedPtr<class SSlider> HeightSlider;
    TSharedPtr<STextBlock> SelectionCountText;
    TSharedPtr<class SEditableTextBox> BlueprintNameBox;

    /** Metres, full extent rather than half: "100" means 100 m across. */
    float SelectionWidthM = 60.0f;
    float SelectionDepthM = 60.0f;
    float SelectionHeightM = 40.0f;
    /** Where the box is anchored. Set when the player first opens a preview. */
    FVector SelectionCentre = FVector::ZeroVector;
    bool bSelectionAnchored = false;
    /** The exact ids currently lit up, and therefore the exact ids an export writes. */
    TArray<FString> SelectionActorIds;
    /**
     * Lightweight instances caught by the same box.
     *
     * Foundations and walls are not actors -- the subsystem owns them as
     * instance data -- so they are counted and removed through a separate
     * path. Kept as class plus index because that pair is what the
     * subsystem addresses them by; a pointer would be meaningless.
     */
    TArray<TPair<TSubclassOf<class AFGBuildable>, int32>> SelectionLightweight;
    int32 LightweightCount = 0;
    /** Demolish is destructive, so it arms on the first click and fires on the second. */
    double DemolishArmedAt = 0.0;
    void DemolishSelection();

    TSharedRef<SWidget> BuildSelectionSection();
    /** Re-query the box, repaint the highlight, update the count. */
    void RefreshSelectionPreview();
    void ClearSelectionPreview();
    void ExportSelectionAsBlueprint();
    /** Slider position 0..1 mapped to a usable range of metres. */
    static float SliderToMetres(float Normalised);
    static float MetresToSlider(float Metres);

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
