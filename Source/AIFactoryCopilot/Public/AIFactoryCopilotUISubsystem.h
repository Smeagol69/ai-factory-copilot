#pragma once

#include "Containers/Ticker.h"
#include "CoreMinimal.h"
#include "FGLightweightBuildableSubsystem.h"
#include "Subsystems/GameInstanceSubsystem.h"
#include "AIFactoryCopilotUISubsystem.generated.h"

class AAIFactorySubsystem;
class AActor;
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
     * path. The public stable ref protects against a reused runtime-array
     * index between preview and export/dismantle.
     */
    TArray<FLightweightBuildableInstanceRef> SelectionLightweight;
    int32 LightweightCount = 0;

    /**
     * Which kinds of building a box accepts, indexed to match the order in
     * CategoryIndexFor(): structure, machines, transport, power, other.
     *
     * All on by default, so a selection behaves exactly as before until the
     * player chooses to narrow it. Turning a filter on should be their
     * decision, not a surprise.
     */
    bool SelectionCategoryEnabled[5] = { true, true, true, true, true };
    /** Tallies from the last preview, so the count line explains the filters. */
    int32 SelectionCategoryCounts[5] = { 0, 0, 0, 0, 0 };
    /**
     * Require a building to sit entirely inside the box rather than merely
     * touch it. Off by default because touching is what makes long pieces
     * like pillars selectable at all; on, it is far more precise in a dense
     * factory where boxes inevitably clip a neighbour.
     */
    bool bSelectionStrictFit = false;
    /** What the selection would cost to rebuild, summed from real recipes. */
    TSharedPtr<class STextBlock> SelectionCostText;
    /** Typed entry beside each slider: a slider cannot hit exactly 48 m. */
    TSharedPtr<class SEditableTextBox> WidthEntry;
    TSharedPtr<class SEditableTextBox> DepthEntry;
    TSharedPtr<class SEditableTextBox> HeightEntry;
    /**
     * Distinct build recipes in the selection, with counts.
     *
     * Filled by the preview pass that is already walking these buildings, so
     * the cost line needs no world iteration of its own. Keyed by recipe
     * rather than by building because the ingredient lookup is per recipe --
     * a thousand identical foundations is one lookup, not a thousand.
     */
    TMap<TSubclassOf<class UFGRecipe>, int32> SelectionRecipeCounts;
    void RefreshSelectionCost();
    void SyncDimensionEntries();
    void ApplyTypedDimension(int32 Axis, const FString& Value);
    TSharedRef<SWidget> MakeDimensionEntry(int32 Axis);
    TSharedRef<SWidget> MakeCategoryToggle(int32 CategoryIndex, const FString& Label);
    /** Demolish is destructive, so it arms on the first click and fires on the second. */
    double DemolishArmedAt = 0.0;
    void DemolishSelection();
    /** Replace every selected building with the top tier unlocked. Armed, like Demolish. */
    double UpgradeArmedAt = 0.0;
    void UpgradeSelection();

    /**
     * A staged export, waiting on the game to materialise instances.
     *
     * Lightweight buildables become real actors only once an instance
     * converter has run over them, and that takes ticks. Rather than
     * guessing a delay, the count is watched until it stops rising.
     */
    FString PendingExportName;
    TWeakObjectPtr<AActor> ConversionInstigator;
    int32 PendingExportLastCount = -1;
    int32 PendingExportStableTicks = 0;
    double PendingExportStartedAt = 0.0;
    void BeginStagedExport(const FString& Name);
    void TickStagedExport();
    void EndConversion();

    TSharedRef<SWidget> BuildSelectionSection();
    /** Re-query the box, repaint the highlight, update the count. */
    void RefreshSelectionPreview();
    void ClearSelectionPreview();
    /**
     * The exact currently aimed actor, from the game's usable-hit state or
     * visibility trace. A buildable-only query deliberately falls through
     * when the usable target is a resource node or another non-buildable.
     */
    AActor* GetAimedActor(bool bRequireBuildable = false) const;
    /** Replace the preview with exactly one eligible buildable under the crosshair. */
    void SelectAimedBuildable();
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
