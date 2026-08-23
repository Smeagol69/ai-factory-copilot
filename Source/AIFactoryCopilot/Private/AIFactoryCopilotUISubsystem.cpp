#include "AIFactoryCopilotUISubsystem.h"
#include "AIFactoryUpgrade.h"
#include "Hologram/FGHologram.h"
#include "AIFactoryCompanion.h"
#include "FGDismantleInterface.h"
#include "FGLightweightBuildableSubsystem.h"
#include "Buildables/FGBuildableFactory.h"
#include "Buildables/FGBuildableFactoryBuilding.h"
#include "Buildables/FGBuildableConveyorBase.h"
#include "Buildables/FGBuildablePipeBase.h"
#include "Buildables/FGBuildableConveyorAttachment.h"
#include "Buildables/FGBuildableWire.h"
#include "Buildables/FGBuildablePowerPole.h"
#include "Widgets/Input/SCheckBox.h"
#include "Widgets/Input/SSlider.h"
#include "EngineUtils.h"
#include "FGRecipe.h"
#include "Resources/FGItemDescriptor.h"
#include "Buildables/FGBuildable.h"
#include "AIFactoryOverlay.h"
#include "AIFactoryBlueprintExport.h"

#include "AIFactorySettings.h"
#include "AIFactorySnapshot.h"
#include "AIFactorySubsystem.h"
#include "Command/CommandSender.h"
#include "Containers/Ticker.h"
#include "Engine/GameInstance.h"
#include "Engine/GameViewportClient.h"
#include "Engine/World.h"
#include "FGCharacterPlayer.h"
#include "FGPlayerController.h"
#include "FGUseableInterface.h"
#include "Framework/Application/IInputProcessor.h"
#include "Framework/Application/SlateApplication.h"
#include "GameFramework/Pawn.h"
#include "HAL/PlatformTime.h"
#include "InputCoreTypes.h"
#include "Player/SMLRemoteCallObject.h"
#include "Styling/CoreStyle.h"
#include "Widgets/Input/SButton.h"
#include "Widgets/Input/SEditableTextBox.h"
#include "Widgets/Input/SMultiLineEditableTextBox.h"
#include "Widgets/Layout/SBorder.h"
#include "Widgets/Layout/SBox.h"
#include "Widgets/Layout/SSeparator.h"
#include "Widgets/SBoxPanel.h"
#include "Widgets/SOverlay.h"
#include "Widgets/Text/STextBlock.h"

namespace
{
    class FAIFactoryInputProcessor final : public IInputProcessor
    {
    public:
        explicit FAIFactoryInputProcessor(UAIFactoryCopilotUISubsystem* InOwner)
            : Owner(InOwner)
        {
        }

        virtual void Tick(
            const float DeltaTime,
            FSlateApplication& SlateApplication,
            TSharedRef<ICursor> Cursor) override
        {
        }

        virtual bool HandleKeyDownEvent(
            FSlateApplication& SlateApplication,
            const FKeyEvent& InKeyEvent) override
        {
            if (!Owner.IsValid())
            {
                return false;
            }
            if (InKeyEvent.GetKey() == EKeys::Insert)
            {
                Owner->TogglePanel();
                return true;
            }
            if (InKeyEvent.GetKey() == EKeys::Escape && Owner->IsPanelVisible())
            {
                Owner->HidePanel();
                return true;
            }
            return false;
        }

    private:
        TWeakObjectPtr<UAIFactoryCopilotUISubsystem> Owner;
    };
}

/**
 * The game's own palette, so the panel does not announce itself as a mod.
 *
 * Satisfactory's HUD is warm and near-neutral: near-black grounds, one
 * orange accent, off-white text. The panel previously used eleven ad-hoc
 * colours, most of them blue-tinted greys, which is the single thing that
 * makes an overlay look bolted on before you have read any of it.
 *
 * Greys here are deliberately warm-neutral -- blue is slightly *below* red
 * and green rather than above -- which is what matches the game's chrome.
 */
namespace AIFactoryPalette
{
    /** FICSIT orange: the milestone rules, build-menu accents, hotbar edges. */
    const FLinearColor Orange(0.98f, 0.58f, 0.16f, 1.0f);
    /** The same orange at rule/edge weight. */
    const FLinearColor OrangeRule(0.98f, 0.58f, 0.16f, 0.55f);
    /** Panel ground. Nearly opaque -- the game's own panels barely show through. */
    const FLinearColor Panel(0.021f, 0.022f, 0.024f, 0.955f);
    /** Inset fields: transcript, text boxes. */
    const FLinearColor Field(0.045f, 0.047f, 0.050f, 1.0f);
    /** Buttons sit just above the panel ground, never lighter than the text. */
    const FLinearColor Button(0.115f, 0.112f, 0.105f, 1.0f);
    const FLinearColor Text(0.905f, 0.900f, 0.885f, 1.0f);
    const FLinearColor TextMuted(0.545f, 0.535f, 0.510f, 1.0f);
    const FLinearColor Danger(0.72f, 0.20f, 0.13f, 1.0f);
    const FLinearColor Good(0.46f, 0.80f, 0.34f, 1.0f);
}

void UAIFactoryCopilotUISubsystem::Initialize(FSubsystemCollectionBase& Collection)
{
    Super::Initialize(Collection);

    if (FSlateApplication::IsInitialized())
    {
        InputProcessor = MakeShared<FAIFactoryInputProcessor>(this);
        FSlateApplication::Get().RegisterInputPreProcessor(InputProcessor, 0);
    }

    TickerHandle = FTSTicker::GetCoreTicker().AddTicker(
        FTickerDelegate::CreateUObject(this, &UAIFactoryCopilotUISubsystem::Tick),
        0.2f);
}

void UAIFactoryCopilotUISubsystem::Deinitialize()
{
    HidePanel();

    if (BoundSubsystem.IsValid() && BridgeResultHandle.IsValid())
    {
        BoundSubsystem->OnBridgeResult.Remove(BridgeResultHandle);
    }
    BridgeResultHandle.Reset();
    BoundSubsystem.Reset();

    if (TickerHandle.IsValid())
    {
        FTSTicker::GetCoreTicker().RemoveTicker(TickerHandle);
        TickerHandle.Reset();
    }

    if (InputProcessor.IsValid() && FSlateApplication::IsInitialized())
    {
        FSlateApplication::Get().UnregisterInputPreProcessor(InputProcessor);
    }
    InputProcessor.Reset();
    RootWidget.Reset();
    InputBox.Reset();
    TranscriptBox.Reset();
    LiveStatusText.Reset();
    RequestStatusText.Reset();

    Super::Deinitialize();
}

void UAIFactoryCopilotUISubsystem::BuildPanel()
{
    if (RootWidget.IsValid())
    {
        return;
    }

    const bool bWritesEnabled = AreWriteActionsEnabled();
    Transcript =
        TEXT("COPILOT\n")
        TEXT("Ask me anything, however you want to word it. I read the save directly: every Send ")
        TEXT("captures the whole world, your exact position, camera, and what you are looking at. ")
        TEXT("Numbers come from deterministic solvers, not guesswork, and when a question needs ")
        TEXT("outside knowledge I check the official wiki, docs, and forums and cite what I used.\n\n");
    Transcript += bWritesEnabled
        ? TEXT("WARNING: WORLD WRITES ARE ENABLED. Committed actions can change this save; ")
          TEXT("each plan is revision-gated, preflighted, and reported below after execution.\n")
        : TEXT("World writes are disabled. Placement, teleport, dismantle, and undo requests ")
          TEXT("are validated as previews and cannot change the save.\n");

    RootWidget =
        SNew(SOverlay)
        + SOverlay::Slot()
        .HAlign(HAlign_Right)
        .VAlign(VAlign_Center)
        .Padding(FMargin(32.0f))
        [
            SNew(SBox)
            .WidthOverride(760.0f)
            .HeightOverride(700.0f)
            [
                SNew(SBorder)
                .Padding(FMargin(18.0f))
                .BorderImage(FCoreStyle::Get().GetBrush(TEXT("WhiteBrush")))
                .BorderBackgroundColor(AIFactoryPalette::Panel)
                [
                    SNew(SVerticalBox)
                    + SVerticalBox::Slot()
                    .AutoHeight()
                    .Padding(0.0f, 0.0f, 0.0f, 10.0f)
                    [
                        SNew(SHorizontalBox)
                        + SHorizontalBox::Slot()
                        .FillWidth(1.0f)
                        .VAlign(VAlign_Center)
                        [
                            SNew(SVerticalBox)
                            + SVerticalBox::Slot()
                            .AutoHeight()
                            [
                                SNew(STextBlock)
                                .Text(FText::FromString(TEXT("AI FACTORY COPILOT")))
                                .ColorAndOpacity(AIFactoryPalette::Orange)
                                .Font(FCoreStyle::GetDefaultFontStyle(TEXT("Bold"), 20))
                            ]
                            + SVerticalBox::Slot()
                            .AutoHeight()
                            .Padding(0.0f, 3.0f, 0.0f, 0.0f)
                            [
                                SAssignNew(LiveStatusText, STextBlock)
                                .Text(FText::FromString(TEXT("LIVE | waiting for a player")))
                                .ColorAndOpacity(AIFactoryPalette::Good)
                                .Font(FCoreStyle::GetDefaultFontStyle(TEXT("Regular"), 10))
                            ]
                        ]
                        + SHorizontalBox::Slot()
                        .AutoWidth()
                        .Padding(8.0f, 0.0f)
                        [
                            SNew(SButton)
                            .Text(FText::FromString(TEXT("Help")))
                            .ButtonColorAndOpacity(AIFactoryPalette::Button)
                            .ForegroundColor(AIFactoryPalette::Orange)
                            .ToolTipText(FText::FromString(TEXT(
                                "What to type here, what to type in the game chat, and the command list.")))
                            .OnClicked_Lambda([this]()
                            {
                                ShowCommandHelp(false);
                                return FReply::Handled();
                            })
                        ]
                        + SHorizontalBox::Slot()
                        .AutoWidth()
                        .Padding(8.0f, 0.0f)
                        [
                            SNew(SButton)
                            .ButtonColorAndOpacity(AIFactoryPalette::Button)
                            .ForegroundColor(AIFactoryPalette::Orange)
                            .Text(FText::FromString(TEXT("Reset")))
                            .OnClicked_Lambda([this]()
                            {
                                ClearConversation();
                                return FReply::Handled();
                            })
                        ]
                        + SHorizontalBox::Slot()
                        .AutoWidth()
                        [
                            SNew(SButton)
                            .ButtonColorAndOpacity(AIFactoryPalette::Button)
                            .ForegroundColor(AIFactoryPalette::Orange)
                            .Text(FText::FromString(TEXT("Close")))
                            .OnClicked_Lambda([this]()
                            {
                                HidePanel();
                                return FReply::Handled();
                            })
                        ]
                    ]
                    + SVerticalBox::Slot()
                    .AutoHeight()
                    [
                        SNew(SBorder)
                        .Padding(FMargin(0.0f, 1.0f))
                        .BorderImage(FCoreStyle::Get().GetBrush(TEXT("WhiteBrush")))
                        .BorderBackgroundColor(AIFactoryPalette::OrangeRule)
                    ]
                    + SVerticalBox::Slot()
                    .FillHeight(1.0f)
                    .Padding(0.0f, 12.0f)
                    [
                        SAssignNew(TranscriptBox, SMultiLineEditableTextBox)
                        .Text(FText::FromString(Transcript))
                        .IsReadOnly(true)
                        .AutoWrapText(true)
                        .AlwaysShowScrollbars(true)
                        .BackgroundColor(AIFactoryPalette::Field)
                        .ForegroundColor(AIFactoryPalette::Text)
                    ]
                    + SVerticalBox::Slot()
                    .AutoHeight()
                    .Padding(0.0f, 0.0f, 0.0f, 8.0f)
                    [
                        SAssignNew(RequestStatusText, STextBlock)
                        .Text(FText::FromString(GetReadyStatus()))
                        .ColorAndOpacity(
                            bWritesEnabled
                                ? AIFactoryPalette::Orange
                                : AIFactoryPalette::TextMuted)
                        .Font(FCoreStyle::GetDefaultFontStyle(TEXT("Regular"), 10))
                    ]
                    + SVerticalBox::Slot()
                    .AutoHeight()
                    .Padding(0.0f, 0.0f, 0.0f, 8.0f)
                    [
                        BuildSelectionSection()
                    ]
                    + SVerticalBox::Slot()
                    .AutoHeight()
                    [
                        SNew(SHorizontalBox)
                        + SHorizontalBox::Slot()
                        .FillWidth(1.0f)
                        .Padding(0.0f, 0.0f, 10.0f, 0.0f)
                        [
                            SNew(SBox)
                            .MinDesiredHeight(64.0f)
                            .MaxDesiredHeight(150.0f)
                            [
                                // Enter sends; Shift+Enter adds a line, so a long
                                // question can be written out in full.
                                SAssignNew(InputBox, SMultiLineEditableTextBox)
                                .HintText(FText::FromString(TEXT(
                                    "Ask anything in your own words - this machine, here, your whole factory, "
                                    "where to build, a mod, or the wiki. Enter sends, Shift+Enter for a new line.")))
                                .AutoWrapText(true)
                                .AllowMultiLine(true)
                                .ModiferKeyForNewLine(EModifierKey::Shift)
                                .BackgroundColor(AIFactoryPalette::Field)
                                .ForegroundColor(AIFactoryPalette::Text)
                                .OnTextCommitted_Lambda([this](const FText&, const ETextCommit::Type CommitType)
                                {
                                    if (CommitType == ETextCommit::OnEnter)
                                    {
                                        SubmitQuestion();
                                    }
                                })
                            ]
                        ]
                        + SHorizontalBox::Slot()
                        .AutoWidth()
                        [
                            SNew(SButton)
                            .ButtonColorAndOpacity(AIFactoryPalette::Button)
                            .ForegroundColor(AIFactoryPalette::Orange)
                            .Text(FText::FromString(TEXT("Send")))
                            .OnClicked_Lambda([this]()
                            {
                                SubmitQuestion();
                                return FReply::Handled();
                            })
                        ]
                    ]
                ]
            ]
        ];
}

/**
 * The library page on whichever bridge this install is configured to use.
 *
 * Derived from BridgeUrl rather than hardcoded, so a player who moved the
 * bridge to another port gets a button that still works. `/v1/ask` is the
 * endpoint; the library is served from the same origin's root.
 */

void UAIFactoryCopilotUISubsystem::TogglePanel()
{
    if (bPanelVisible)
    {
        HidePanel();
    }
    else
    {
        ShowPanel();
    }
}

void UAIFactoryCopilotUISubsystem::ShowPanel()
{
    if (bPanelVisible)
    {
        return;
    }

    BuildPanel();
    UGameInstance* GameInstance = GetGameInstance();
    UGameViewportClient* Viewport =
        IsValid(GameInstance) ? GameInstance->GetGameViewportClient() : nullptr;
    AFGPlayerController* PlayerController = GetLocalPlayerController();
    if (!IsValid(Viewport) || !RootWidget.IsValid() || !IsValid(PlayerController))
    {
        return;
    }

    Viewport->AddViewportWidgetContent(RootWidget.ToSharedRef(), 10000);
    bPanelVisible = true;
    bPreviousShowMouseCursor = PlayerController->bShowMouseCursor;
    PlayerController->bShowMouseCursor = true;
    PlayerController->SetIgnoreMoveInput(true);
    PlayerController->SetIgnoreLookInput(true);
    bSuppressedGameInput = true;

    // This is a conversation surface, not an overlay the player should control
    // the game through. UI-only mode prevents a question containing WASD or
    // hotkeys from moving the pawn when Slate focus is delayed by one frame.
    FInputModeUIOnly InputMode;
    InputMode.SetLockMouseToViewportBehavior(EMouseLockMode::DoNotLock);
    InputMode.SetWidgetToFocus(InputBox);
    PlayerController->SetInputMode(InputMode);
    if (FSlateApplication::IsInitialized() && InputBox.IsValid())
    {
        FSlateApplication::Get().SetAllUserFocus(InputBox, EFocusCause::SetDirectly);
        FSlateApplication::Get().SetKeyboardFocus(InputBox, EFocusCause::SetDirectly);
    }
    // AddViewportWidgetContent can place the widget into the Slate path on the
    // following frame. Repeat focus once from Tick so the first typed character
    // reliably lands in the editor in packaged builds.
    bFocusInputOnNextTick = true;
    UpdateLiveStatus();
    RefreshReadyStatus();
}

void UAIFactoryCopilotUISubsystem::HidePanel()
{
    if (!bPanelVisible)
    {
        return;
    }

    UGameInstance* GameInstance = GetGameInstance();
    UGameViewportClient* Viewport =
        IsValid(GameInstance) ? GameInstance->GetGameViewportClient() : nullptr;
    if (IsValid(Viewport) && RootWidget.IsValid())
    {
        Viewport->RemoveViewportWidgetContent(RootWidget.ToSharedRef());
    }

    if (AFGPlayerController* PlayerController = GetLocalPlayerController())
    {
        if (bSuppressedGameInput)
        {
            PlayerController->SetIgnoreMoveInput(false);
            PlayerController->SetIgnoreLookInput(false);
            bSuppressedGameInput = false;
        }
        PlayerController->bShowMouseCursor = bPreviousShowMouseCursor;
        PlayerController->SetInputMode(FInputModeGameOnly());
    }
    else
    {
        bSuppressedGameInput = false;
    }
    bFocusInputOnNextTick = false;
    bPanelVisible = false;
}

void UAIFactoryCopilotUISubsystem::SubmitQuestion()
{
    if (bWaitingForAnswer || !InputBox.IsValid())
    {
        return;
    }

    FString Question = InputBox->GetText().ToString().TrimStartAndEnd();
    if (Question.IsEmpty())
    {
        return;
    }

    // A slash command typed here cannot work: this box sends a question to the
    // assistant, and chat commands are run by the game's own console. Answering
    // locally costs nothing and catches the mistake where it happens -- the
    // alternative is a model politely answering something adjacent while the
    // command never runs, which is indistinguishable from a broken feature.
    if (Question.StartsWith(TEXT("/")))
    {
        InputBox->SetText(FText::GetEmpty());
        AppendTranscript(TEXT("YOU"), Question);
        ShowCommandHelp(true);
        return;
    }

    AFGPlayerController* PlayerController = GetLocalPlayerController();
    UCommandSender* Sender = GetLocalCommandSender(PlayerController);
    AAIFactorySubsystem* Subsystem = GetCopilotSubsystem();
    if (!IsValid(PlayerController) || !IsValid(Sender) || !IsValid(Subsystem))
    {
        if (RequestStatusText.IsValid())
        {
            RequestStatusText->SetText(FText::FromString(
                TEXT("The save/player bridge is not ready yet. Load a save and try again.")));
        }
        return;
    }

    BindToBridge(Subsystem);
    PendingSender = Sender;
    bWaitingForAnswer = true;
    RequestStartSeconds = FPlatformTime::Seconds();
    InputBox->SetText(FText::GetEmpty());
    AppendTranscript(TEXT("YOU"), Question);
    if (RequestStatusText.IsValid())
    {
        RequestStatusText->SetText(FText::FromString(
            TEXT("Capturing the authoritative world, exact position, and crosshair target...")));
    }

    const FAIFactorySettings& Settings = Subsystem->GetSettings();
    FAIFactorySnapshotRequest Request;
    Request.PlayerController = PlayerController;
    Request.Center = IsValid(PlayerController->GetPawn())
        ? PlayerController->GetPawn()->GetActorLocation()
        : FVector::ZeroVector;
    Request.RadiusMeters = Settings.DefaultScanRadiusMeters;
    Request.bUseRadius = !Settings.bUIWholeWorldSnapshot;
    Request.bIncludeContentCatalog = Settings.bIncludeContentCatalog;
    Request.bIncludeReflectedProperties = Settings.bIncludeReflectedProperties;
    Subsystem->AskBridge(Sender, Question, Request, false);
}

void UAIFactoryCopilotUISubsystem::ClearConversation()
{
    AFGPlayerController* PlayerController = GetLocalPlayerController();
    UCommandSender* Sender = GetLocalCommandSender(PlayerController);
    if (AAIFactorySubsystem* Subsystem = GetCopilotSubsystem(); IsValid(Subsystem) && IsValid(Sender))
    {
        Subsystem->ResetBridgeConversation(Sender);
    }
    Transcript =
        TEXT("COPILOT\nConversation cleared. The next message will capture a new authoritative world state.\n");
    if (TranscriptBox.IsValid())
    {
        TranscriptBox->SetText(FText::FromString(Transcript));
    }
    if (RequestStatusText.IsValid())
    {
        RefreshReadyStatus();
    }
    bFocusInputOnNextTick = true;
}

void UAIFactoryCopilotUISubsystem::AppendTranscript(const FString& Speaker, const FString& Text)
{
    if (!Transcript.IsEmpty() && !Transcript.EndsWith(TEXT("\n")))
    {
        Transcript += TEXT("\n");
    }
    Transcript += FString::Printf(TEXT("\n%s\n%s\n"), *Speaker, *Text);
    if (TranscriptBox.IsValid())
    {
        TranscriptBox->SetText(FText::FromString(Transcript));
        TranscriptBox->ScrollTo(ETextLocation::EndOfDocument);
    }
}

bool UAIFactoryCopilotUISubsystem::Tick(const float DeltaTime)
{
    // Runs whether or not the panel is open: a conversion armed before the
    // player closed it still has to finish and be cleaned up.
    TickStagedExport();
    if (bPanelVisible)
    {
        if (bFocusInputOnNextTick && InputBox.IsValid() && FSlateApplication::IsInitialized())
        {
            FSlateApplication::Get().SetAllUserFocus(InputBox, EFocusCause::SetDirectly);
            FSlateApplication::Get().SetKeyboardFocus(InputBox, EFocusCause::SetDirectly);
            bFocusInputOnNextTick = false;
        }
        UpdateLiveStatus();

        // A grounded answer can involve solver calls and a wiki search, so show
        // that the request is still alive rather than appearing to hang.
        if (bWaitingForAnswer && RequestStatusText.IsValid())
        {
            const double ElapsedSeconds = FPlatformTime::Seconds() - RequestStartSeconds;
            RequestStatusText->SetText(FText::FromString(FString::Printf(
                TEXT("Thinking, running solvers, and checking sources... %.0fs"),
                ElapsedSeconds)));
        }
    }
    return true;
}

/**
 * Use the same target hierarchy for a one-piece blueprint selection that the
 * live status line shows: Satisfactory's own usable hit is more precise than
 * a generic visibility trace, and the trace is only the fallback for a
 * buildable without a use prompt.
 */
AActor* UAIFactoryCopilotUISubsystem::GetAimedActor(const bool bRequireBuildable) const
{
    AFGPlayerController* PlayerController = GetLocalPlayerController();
    APawn* Pawn = IsValid(PlayerController) ? PlayerController->GetPawn() : nullptr;
    if (!IsValid(PlayerController) || !IsValid(Pawn))
    {
        return nullptr;
    }

    AActor* FocusActor = nullptr;
    if (AFGCharacterPlayer* Character =
            Cast<AFGCharacterPlayer>(PlayerController->GetControlledCharacter()))
    {
        if (FUseState* UseState = Character->GetCachedUseState();
            UseState && UseState->bIsTraceHit)
        {
            FocusActor = UseState->UseHitResult.GetActor();
        }
    }

    // The usable target of a miner can be the resource node rather than the
    // miner itself. For an exact blueprint selection that is not enough: let
    // the visibility trace have a chance to resolve the actual buildable.
    if (bRequireBuildable && !IsValid(Cast<AFGBuildable>(FocusActor)))
    {
        FocusActor = nullptr;
    }

    if (!IsValid(FocusActor))
    {
        FVector ViewLocation;
        FRotator ViewRotation;
        PlayerController->GetPlayerViewPoint(ViewLocation, ViewRotation);
        FHitResult Hit;
        FCollisionQueryParams QueryParams(
            SCENE_QUERY_STAT(AIFactoryCopilotUIAimedSelectionTrace), true, Pawn);
        if (UWorld* World = PlayerController->GetWorld())
        {
            World->LineTraceSingleByChannel(
                Hit,
                ViewLocation,
                ViewLocation + ViewRotation.Vector() * 25000.0,
                ECC_Visibility,
                QueryParams);
            FocusActor = Hit.GetActor();
        }
    }
    return IsValid(FocusActor) ? FocusActor : nullptr;
}

void UAIFactoryCopilotUISubsystem::UpdateLiveStatus()
{
    if (!LiveStatusText.IsValid())
    {
        return;
    }

    AFGPlayerController* PlayerController = GetLocalPlayerController();
    APawn* Pawn = IsValid(PlayerController) ? PlayerController->GetPawn() : nullptr;
    if (!IsValid(PlayerController) || !IsValid(Pawn))
    {
        LiveStatusText->SetText(FText::FromString(TEXT("LIVE | waiting for a controlled player")));
        return;
    }

    AActor* FocusActor = GetAimedActor();

    const FVector Location = Pawn->GetActorLocation() / 100.0;
    const FString FocusName = IsValid(FocusActor) ? FocusActor->GetName() : TEXT("nothing");
    LiveStatusText->SetText(FText::FromString(FString::Printf(
        TEXT("LIVE | X %.2fm  Y %.2fm  Z %.2fm | looking at: %s"),
        Location.X,
        Location.Y,
        Location.Z,
        *FocusName)));
}

bool UAIFactoryCopilotUISubsystem::AreWriteActionsEnabled() const
{
    if (const AAIFactorySubsystem* Subsystem = GetCopilotSubsystem();
        IsValid(Subsystem))
    {
        return Subsystem->GetSettings().bAllowWriteActions;
    }
    return FAIFactorySettings::Load().bAllowWriteActions;
}

FString UAIFactoryCopilotUISubsystem::GetReadyStatus() const
{
    // Two halves, because half of this mod does not need the assistant at all.
    //
    // The selection sliders and the blueprint export are entirely local C++:
    // they read the world, draw the overlay, and call the serialiser without a
    // single HTTP request. Someone who installs this from SML and never sets up
    // the companion still gets unrestricted mega blueprints, and the panel
    // should say so rather than reading as broken.
    const FString Keys = TEXT("Enter sends | Shift+Enter new line | Insert or Esc closes");
    if (!bBridgeAnswered && bBridgeEverTried)
    {
        // Prefer the launcher's own reason. "Assistant offline" is true and
        // useless; "Node.js was not found" is something a player can fix.
        const FString LaunchError = AIFactoryCompanion::LastError();
        if (!LaunchError.IsEmpty())
        {
            return LaunchError + TEXT(" | ") + Keys;
        }
        return TEXT("Assistant offline — sliders and Save blueprint still work | ") + Keys;
    }
    return AreWriteActionsEnabled()
        ? TEXT("Ready | WRITES ENABLED | ") + Keys
        : TEXT("Ready | advisory/read-only | ") + Keys;
}

void UAIFactoryCopilotUISubsystem::RefreshReadyStatus()
{
    if (!RequestStatusText.IsValid())
    {
        return;
    }
    const bool bWritesEnabled = AreWriteActionsEnabled();
    RequestStatusText->SetText(FText::FromString(GetReadyStatus()));
    RequestStatusText->SetColorAndOpacity(
        bWritesEnabled
            ? AIFactoryPalette::Orange
            : AIFactoryPalette::TextMuted);
}

AFGPlayerController* UAIFactoryCopilotUISubsystem::GetLocalPlayerController() const
{
    const UGameInstance* GameInstance = GetGameInstance();
    UWorld* World = IsValid(GameInstance) ? GameInstance->GetWorld() : nullptr;
    return IsValid(World) ? Cast<AFGPlayerController>(World->GetFirstPlayerController()) : nullptr;
}

UCommandSender* UAIFactoryCopilotUISubsystem::GetLocalCommandSender(
    AFGPlayerController* PlayerController) const
{
    if (!IsValid(PlayerController))
    {
        return nullptr;
    }
    USMLRemoteCallObject* RemoteCallObject = Cast<USMLRemoteCallObject>(
        PlayerController->GetRemoteCallObjectOfClass(USMLRemoteCallObject::StaticClass()));
    return IsValid(RemoteCallObject) ? RemoteCallObject->CommandSender : nullptr;
}

AAIFactorySubsystem* UAIFactoryCopilotUISubsystem::GetCopilotSubsystem() const
{
    AFGPlayerController* PlayerController = GetLocalPlayerController();
    return IsValid(PlayerController) ? AAIFactorySubsystem::Get(PlayerController) : nullptr;
}

void UAIFactoryCopilotUISubsystem::BindToBridge(AAIFactorySubsystem* Subsystem)
{
    if (BoundSubsystem.Get() == Subsystem && BridgeResultHandle.IsValid())
    {
        return;
    }
    if (BoundSubsystem.IsValid() && BridgeResultHandle.IsValid())
    {
        BoundSubsystem->OnBridgeResult.Remove(BridgeResultHandle);
    }
    BoundSubsystem = Subsystem;
    BridgeResultHandle = Subsystem->OnBridgeResult.AddUObject(
        this,
        &UAIFactoryCopilotUISubsystem::HandleBridgeResult);
}

void UAIFactoryCopilotUISubsystem::HandleBridgeResult(
    UCommandSender* Sender,
    const bool bSuccess,
    const FString& Reply,
    const FString& Provider,
    const FString& Model)
{
    if (!PendingSender.IsValid() || PendingSender.Get() != Sender)
    {
        return;
    }

    PendingSender.Reset();
    bWaitingForAnswer = false;
    // Remember whether the assistant half is actually reachable, so the
    // status line can distinguish "offline" from "broken".
    bBridgeEverTried = true;
    bBridgeAnswered = bSuccess;
    const FString Speaker = bSuccess
        ? FString::Printf(TEXT("COPILOT  [%s / %s]"), *Provider, *Model)
        : TEXT("COPILOT ERROR");
    AppendTranscript(Speaker, Reply);
    if (RequestStatusText.IsValid())
    {
        if (bSuccess)
        {
            RefreshReadyStatus();
        }
        else
        {
            RequestStatusText->SetText(FText::FromString(
                TEXT("Request failed; the error is shown above.")));
        }
    }
    if (bPanelVisible && InputBox.IsValid() && FSlateApplication::IsInitialized())
    {
        FSlateApplication::Get().SetAllUserFocus(InputBox, EFocusCause::SetDirectly);
        FSlateApplication::Get().SetKeyboardFocus(InputBox, EFocusCause::SetDirectly);
    }
}

/**
 * Slider position to metres.
 *
 * Not linear: a factory selection is usually tens of metres and occasionally
 * hundreds, so a linear 1..1000 slider would spend most of its travel in sizes
 * nobody wants. Squaring the normalised value gives fine control at the small
 * end where the work happens, and still reaches 1 km at the far right.
 */
float UAIFactoryCopilotUISubsystem::SliderToMetres(float Normalised)
{
    const float Clamped = FMath::Clamp(Normalised, 0.0f, 1.0f);
    return FMath::RoundToFloat(5.0f + (Clamped * Clamped * 995.0f));
}

float UAIFactoryCopilotUISubsystem::MetresToSlider(float Metres)
{
    const float Above = FMath::Max(0.0f, Metres - 5.0f);
    return FMath::Clamp(FMath::Sqrt(Above / 995.0f), 0.0f, 1.0f);
}

/**
 * Everything inside the box, highlighted, counted.
 *
 * The overlay takes explicit actor ids and bypasses its own radius filter, so
 * what lights up is exactly the set an export would write -- not an
 * approximation of it. That equality is the whole point: the preview is what
 * earns the right to export without the player having marked each piece.
 */
namespace
{
    /**
     * Which bucket a buildable class falls in.
     *
     * By hierarchy, not by name. Substring matching on class names is how
     * `Build_Wall_Door_8x4_01_C` ends up counted as structure and
     * `Build_WallMountedFrackingSmasher_C` ends up there with it.
     *
     * Transport and power are tested first because they are the narrow
     * cases; structure before machines because the important fact --
     * checked in the headers, not assumed -- is that
     * AFGBuildableFactoryBuilding descends from AFGBuildable and NOT from
     * AFGBuildableFactory. If it did, turning machines off would silently
     * take every foundation and wall with it.
     *
     * Works on a UClass, so actors and lightweight instances classify
     * through exactly the same path.
     */
    int32 CategoryIndexFor(const UClass* BuildableClass)
    {
        if (BuildableClass == nullptr)
        {
            return 4;
        }
        if (BuildableClass->IsChildOf(AFGBuildableConveyorBase::StaticClass()) ||
            BuildableClass->IsChildOf(AFGBuildablePipeBase::StaticClass()) ||
            BuildableClass->IsChildOf(AFGBuildableConveyorAttachment::StaticClass()))
        {
            return 2;
        }
        if (BuildableClass->IsChildOf(AFGBuildableWire::StaticClass()) ||
            BuildableClass->IsChildOf(AFGBuildablePowerPole::StaticClass()))
        {
            return 3;
        }
        if (BuildableClass->IsChildOf(AFGBuildableFactoryBuilding::StaticClass()))
        {
            return 0;
        }
        if (BuildableClass->IsChildOf(AFGBuildableFactory::StaticClass()))
        {
            return 1;
        }
        // Beams, railings, catwalks, ladders, signs. No shared base class, so
        // they land here -- which is why 'other' is a visible toggle with a
        // count rather than an invisible default.
        return 4;
    }
}

void UAIFactoryCopilotUISubsystem::RefreshSelectionPreview()
{
    SelectionActorIds.Reset();
    SelectionLightweight.Reset();
    LightweightCount = 0;
    SelectionRecipeCounts.Reset();
    for (int32 Index = 0; Index < 5; ++Index)
    {
        SelectionCategoryCounts[Index] = 0;
    }

    AFGPlayerController* Controller = GetLocalPlayerController();
    UWorld* World = IsValid(Controller) ? Controller->GetWorld() : nullptr;
    APawn* Pawn = IsValid(Controller) ? Controller->GetPawn() : nullptr;
    if (!IsValid(World) || !IsValid(Pawn))
    {
        SyncDimensionEntries();
    RefreshSelectionCost();

    if (SelectionCountText.IsValid())
        {
            SelectionCountText->SetText(FText::FromString(TEXT("No player to centre a selection on.")));
        }
        return;
    }

    // Anchored once, so dragging a slider grows the box around where the
    // player was standing rather than following them across the map.
    if (!bSelectionAnchored)
    {
        SelectionCentre = Pawn->GetActorLocation();
        bSelectionAnchored = true;
    }

    const FVector Half(
        SelectionWidthM * 50.0,
        SelectionDepthM * 50.0,
        SelectionHeightM * 50.0);

    // Overlap, not pivot. A pillar runs from the platform down to the terrain
    // with its origin at the foot, so a point test asks whether its foot is
    // inside the box when the question is whether the pillar passes through it.
    // Measured: an export of a whole building contained zero pillars, and the
    // snapshot showed none as actors -- they were in the lightweight map all
    // along and this test threw them away.
    const FBox SelectionBox(SelectionCentre - Half, SelectionCentre + Half);

    for (TActorIterator<AFGBuildable> It(World); It; ++It)
    {
        AFGBuildable* Buildable = *It;
        if (!IsValid(Buildable))
        {
            continue;
        }
        // GetCachedBounds is world space -- CalculateBounds documents a zero
        // extent 'at the buildable location' as valid. A buildable whose bounds
        // were never cached falls back to the old point test rather than being
        // dropped, so this can only ever select more than before, never less.
        const FBox ActorBounds = Buildable->GetCachedBounds();
        const bool bActorFits = ActorBounds.IsValid != 0
            ? (bSelectionStrictFit
                ? (SelectionBox.IsInsideOrOn(ActorBounds.Min) && SelectionBox.IsInsideOrOn(ActorBounds.Max))
                : ActorBounds.Intersect(SelectionBox))
            : SelectionBox.IsInsideOrOn(Buildable->GetActorLocation());
        if (!bActorFits)
        {
            continue;
        }
        const int32 ActorCategory = CategoryIndexFor(Buildable->GetClass());
        if (!SelectionCategoryEnabled[ActorCategory])
        {
            continue;
        }
        // A Blueprint Designer cannot be inside its own blueprint, and it is
        // also the thing doing the serialising.
        const FString ClassName = Buildable->GetClass()->GetName();
        if (ClassName.Contains(TEXT("BlueprintDesigner")))
        {
            continue;
        }
        SelectionActorIds.Add(Buildable->GetPathName());
        ++SelectionCategoryCounts[ActorCategory];
        // Tallied here rather than in a second pass: this loop already holds
        // the buildable, and the cost line used to re-walk the entire world
        // to find it again.
        if (const TSubclassOf<UFGRecipe> Recipe = Buildable->GetBuiltWithRecipe())
        {
            SelectionRecipeCounts.FindOrAdd(Recipe) += 1;
        }
    }

    // The other half of the world. Foundations and walls are converted to
    // lightweight instances and are not actors, so the iterator above cannot
    // see them -- a box over a whole building found three things and wrote a
    // blueprint that looked empty in the hologram.
    if (AFGLightweightBuildableSubsystem* Lightweight =
            AFGLightweightBuildableSubsystem::Get(World))
    {
        for (const auto& Pair : Lightweight->GetAllLightweightBuildableInstances())
        {
            const TArray<FRuntimeBuildableInstanceData>& Instances = Pair.Value;
            for (int32 Index = 0; Index < Instances.Num(); ++Index)
            {
                const FRuntimeBuildableInstanceData& Instance = Instances[Index];
                if (!Instance.IsValid())
                {
                    continue;
                }
                // BoundingBox is local space -- the field says so -- so it has to
                // be moved onto the instance before it means anything.
                const FBox InstanceBounds = Instance.BoundingBox.IsValid != 0
                    ? Instance.BoundingBox.TransformBy(Instance.Transform)
                    : FBox(Instance.Transform.GetLocation(), Instance.Transform.GetLocation());
                const bool bInstanceFits = bSelectionStrictFit
                    ? (SelectionBox.IsInsideOrOn(InstanceBounds.Min) && SelectionBox.IsInsideOrOn(InstanceBounds.Max))
                    : SelectionBox.Intersect(InstanceBounds);
                if (!bInstanceFits)
                {
                    continue;
                }
                const int32 InstanceCategory = CategoryIndexFor(Pair.Key);
                if (!SelectionCategoryEnabled[InstanceCategory])
                {
                    continue;
                }
                FLightweightBuildableInstanceRef Ref;
                Ref.Initialize(Lightweight, Pair.Key, Index);
                if (!Ref.IsValid())
                {
                    continue;
                }
                SelectionLightweight.Add(MoveTemp(Ref));
                ++LightweightCount;
                ++SelectionCategoryCounts[InstanceCategory];
                if (const TSubclassOf<UFGRecipe> Recipe = Instance.BuiltWithRecipe)
                {
                    SelectionRecipeCounts.FindOrAdd(Recipe) += 1;
                }
            }
        }
    }
    FAIFactoryOverlayQuery Query;
    Query.ActorIds = SelectionActorIds;
    // MaxResults caps the draw, so it has to admit everything the box caught
    // or the highlight would show less than an export writes -- and that
    // equality is the only reason a preview can stand in for marking each piece.
    Query.MaxResults = FMath::Max(1, SelectionActorIds.Num());
    Query.RadiusMeters = 1.0;

    FAIFactoryOverlayStyle Style;
    // Amber, so a selection reads differently from the green search overlay.
    Style.Color = AIFactoryPalette::Orange;
    Style.bDrawTracers = false;
    Style.LifetimeSeconds = 0.0f;

    AIFactoryOverlay::Draw(
        World,
        Cast<AFGCharacterPlayer>(Pawn),
        TEXT("selection"),
        Query,
        Style);

    if (SelectionCountText.IsValid())
    {
        // The breakdown is what makes the filters legible: a player who
        // unticks Machines can see the number it removed, rather than
        // guessing whether the filter did anything.
        static const TCHAR* CategoryNames[5] =
            { TEXT("structure"), TEXT("machines"), TEXT("transport"), TEXT("power"), TEXT("other") };
        FString Breakdown;
        for (int32 Index = 0; Index < 5; ++Index)
        {
            if (!Breakdown.IsEmpty())
            {
                Breakdown += TEXT("  ");
            }
            Breakdown += SelectionCategoryEnabled[Index]
                ? FString::Printf(TEXT("%s %d"), CategoryNames[Index], SelectionCategoryCounts[Index])
                : FString::Printf(TEXT("%s off"), CategoryNames[Index]);
        }
        SelectionCountText->SetText(FText::FromString(FString::Printf(
            TEXT("%d selected (%d lightweight)  |  %s  |  %.0f x %.0f x %.0f m%s"),
            SelectionActorIds.Num() + LightweightCount,
            LightweightCount,
            *Breakdown,
            SelectionWidthM,
            SelectionDepthM,
            SelectionHeightM,
            bSelectionStrictFit ? TEXT("  |  fully inside only") : TEXT(""))));
    }
}

void UAIFactoryCopilotUISubsystem::ClearSelectionPreview()
{
    SelectionActorIds.Reset();
    SelectionLightweight.Reset();
    LightweightCount = 0;
    SelectionRecipeCounts.Reset();
    for (int32 Index = 0; Index < 5; ++Index)
    {
        SelectionCategoryCounts[Index] = 0;
    }
    RefreshSelectionCost();
    bSelectionAnchored = false;
    AFGPlayerController* Controller = GetLocalPlayerController();
    if (UWorld* World = IsValid(Controller) ? Controller->GetWorld() : nullptr)
    {
        AIFactoryOverlay::Clear(World, TEXT("selection"));
    }
    if (SelectionCountText.IsValid())
    {
        SelectionCountText->SetText(FText::FromString(TEXT("Cleared. Drag a slider or type a size to start a new selection.")));
    }
}

/**
 * Select one building the player deliberately has under their crosshair.
 *
 * This is deliberately not a tiny box: a miner's resource-node footprint and
 * cached bounds make a strict box selection awkward, and silently widening a
 * user's exact request would be worse than asking them to aim again. Sliders
 * remain the route for a whole floor or base; touching a slider after this
 * starts a fresh box preview as the panel already says.
 */
void UAIFactoryCopilotUISubsystem::SelectAimedBuildable()
{
    AFGBuildable* Buildable = Cast<AFGBuildable>(GetAimedActor(true));
    if (!IsValid(Buildable))
    {
        AppendTranscript(TEXT("COPILOT"), TEXT(
            "Aim directly at one built machine, belt, power piece, or structure, then choose Select aimed."));
        return;
    }

    const FString ClassName = Buildable->GetClass()->GetName();
    if (ClassName.Contains(TEXT("BlueprintDesigner")))
    {
        AppendTranscript(TEXT("COPILOT"), TEXT(
            "The Blueprint Designer cannot be part of the blueprint it is writing. Aim at a factory building instead."));
        return;
    }
    if (Buildable->IsBuildableInsideBlueprintDesigner())
    {
        AppendTranscript(TEXT("COPILOT"), TEXT(
            "That building already belongs to a Blueprint Designer. Aim at a buildable in the world instead."));
        return;
    }

    const int32 Category = CategoryIndexFor(Buildable->GetClass());
    if (!SelectionCategoryEnabled[Category])
    {
        static const TCHAR* CategoryNames[5] =
            { TEXT("Structure"), TEXT("Machines"), TEXT("Belts/pipes"), TEXT("Power"), TEXT("Other") };
        AppendTranscript(TEXT("COPILOT"), FString::Printf(
            TEXT("That aimed building is %s, but its selection filter is off. Turn it on, then select it again."),
            CategoryNames[Category]));
        return;
    }

    // Clear makes the exact selection a replacement rather than a hidden
    // addition to the last box. It also resets stable lightweight refs so an
    // aimed actor can never serialize an invisible old foundation selection.
    ClearSelectionPreview();
    SelectionActorIds.Add(Buildable->GetPathName());
    ++SelectionCategoryCounts[Category];
    if (const TSubclassOf<UFGRecipe> Recipe = Buildable->GetBuiltWithRecipe())
    {
        SelectionRecipeCounts.FindOrAdd(Recipe) += 1;
    }
    RefreshSelectionCost();

    AFGPlayerController* Controller = GetLocalPlayerController();
    UWorld* World = IsValid(Controller) ? Controller->GetWorld() : nullptr;
    if (IsValid(World))
    {
        FAIFactoryOverlayQuery Query;
        Query.ActorIds = SelectionActorIds;
        Query.MaxResults = 1;
        Query.RadiusMeters = 1.0;

        FAIFactoryOverlayStyle Style;
        Style.Color = AIFactoryPalette::Orange;
        Style.bDrawTracers = false;
        Style.LifetimeSeconds = 0.0f;
        AIFactoryOverlay::Draw(
            World,
            Cast<AFGCharacterPlayer>(Controller->GetPawn()),
            TEXT("selection"),
            Query,
            Style);
    }

    if (SelectionCountText.IsValid())
    {
        SelectionCountText->SetText(FText::FromString(FString::Printf(
            TEXT("1 selected exactly: %s | move a slider to start a new box selection"),
            *Buildable->GetName())));
    }
    AppendTranscript(TEXT("COPILOT"), FString::Printf(
        TEXT("Selected **%s** exactly. This is ready to save as a native blueprint."),
        *Buildable->GetName()));
}

/**
 * Export exactly what is lit up.
 *
 * Calls the exporter directly rather than going through the bridge: the ids
 * are already resolved here, and a round trip could only lose or stale them.
 */
void UAIFactoryCopilotUISubsystem::ExportSelectionAsBlueprint()
{
    const FString Name = BlueprintNameBox.IsValid()
        ? BlueprintNameBox->GetText().ToString().TrimStartAndEnd()
        : FString();
    if (Name.IsEmpty())
    {
        AppendTranscript(TEXT("COPILOT"), TEXT("Give the blueprint a name first."));
        return;
    }
    // Counted together: a box holding nothing but foundations is a perfectly
    // good selection, and refusing it because no *actor* was caught is how the
    // structural half stayed invisible in the first place.
    if (SelectionActorIds.Num() + LightweightCount == 0)
    {
        AppendTranscript(TEXT("COPILOT"), TEXT("Nothing is selected. Set a size first — the box centres on where you stand."));
        return;
    }

    AFGPlayerController* Controller = GetLocalPlayerController();
    UWorld* World = IsValid(Controller) ? Controller->GetWorld() : nullptr;
    if (!IsValid(World))
    {
        return;
    }

    // Resolve the ids to live buildables now, so a piece dismantled since the
    // preview is caught here rather than half way through serialising.
    TArray<AFGBuildable*> Buildables;
    TSet<FString> Wanted(SelectionActorIds);
    for (TActorIterator<AFGBuildable> It(World); It; ++It)
    {
        AFGBuildable* Buildable = *It;
        if (IsValid(Buildable) && Wanted.Contains(Buildable->GetPathName()))
        {
            Buildables.Add(Buildable);
        }
    }
    if (Buildables.Num() != SelectionActorIds.Num())
    {
        AppendTranscript(TEXT("COPILOT"), FString::Printf(
            TEXT("%d of the %d selected buildings are gone. Re-preview before exporting."),
            SelectionActorIds.Num() - Buildables.Num(),
            SelectionActorIds.Num()));
        return;
    }

    FAIFactoryActionContext Context;
    Context.World = World;
    Context.Player = Cast<AFGCharacterPlayer>(Controller->GetPawn());
    Context.bDryRun = false;

    const FAIFactoryActionResult Result =
        AIFactoryBlueprintExport::ExportSelection(
            Context, Name, Buildables, SelectionLightweight);

    // Report what the game said, not what was attempted.
    if (Result.bCommitted)
    {
        // The structural count is named separately because it is the half that
        // used to vanish silently, and a number the player can compare against
        // the panel is what makes a partial capture visible.
        AppendTranscript(TEXT("COPILOT"), FString::Printf(
            TEXT("Wrote **%s** from %d buildings, %d of them structure. ")
            TEXT("It is in your blueprint menu now."),
            *Name,
            Buildables.Num() + LightweightCount,
            LightweightCount));
        ClearSelectionPreview();
    }
    else
    {
        AppendTranscript(TEXT("COPILOT"), FString::Printf(
            TEXT("The export did not complete: %s"),
            Result.Reason.IsEmpty() ? TEXT("the game gave no reason") : *Result.Reason));
    }
}

/**
 * The selection section.
 *
 * Three sliders, a live count, a name, and one button that writes the
 * blueprint. Deliberately the whole workflow in one strip: the owner's
 * complaint was having to mark a megabase piece by piece, so anything that
 * makes them leave this panel mid-task defeats the point.
 */
/**
 * One labelled category toggle.
 *
 * Repaints on change rather than waiting for the next slider nudge, because
 * the whole point is to see what the filter removed.
 */
TSharedRef<SWidget> UAIFactoryCopilotUISubsystem::MakeCategoryToggle(
    int32 CategoryIndex,
    const FString& Label)
{
    return SNew(SHorizontalBox)
        + SHorizontalBox::Slot()
        .AutoWidth()
        .VAlign(VAlign_Center)
        [
            SNew(SCheckBox)
            .IsChecked_Lambda([this, CategoryIndex]()
            {
                return SelectionCategoryEnabled[CategoryIndex]
                    ? ECheckBoxState::Checked
                    : ECheckBoxState::Unchecked;
            })
            .OnCheckStateChanged_Lambda([this, CategoryIndex](ECheckBoxState State)
            {
                SelectionCategoryEnabled[CategoryIndex] = (State == ECheckBoxState::Checked);
                if (bSelectionAnchored)
                {
                    RefreshSelectionPreview();
                }
            })
        ]
        + SHorizontalBox::Slot()
        .AutoWidth()
        .VAlign(VAlign_Center)
        .Padding(3.0f, 0.0f, 10.0f, 0.0f)
        [
            SNew(STextBlock)
            .Text(FText::FromString(Label))
            .ColorAndOpacity(AIFactoryPalette::Text)
            .Font(FCoreStyle::GetDefaultFontStyle(TEXT("Regular"), 9))
        ];
}

TSharedRef<SWidget> UAIFactoryCopilotUISubsystem::BuildSelectionSection()
{
    return SNew(SVerticalBox)
        + SVerticalBox::Slot()
        .AutoHeight()
        .Padding(0.0f, 0.0f, 0.0f, 4.0f)
        [
            SNew(STextBlock)
            .Text(FText::FromString(TEXT("SELECTION")))
            .ColorAndOpacity(AIFactoryPalette::Orange)
            .Font(FCoreStyle::GetDefaultFontStyle(TEXT("Bold"), 9))
        ]
        // section rule: the game underlines every heading in orange, and that
        // one line does more for belonging than any amount of colour matching.
        + SVerticalBox::Slot()
        .AutoHeight()
        .Padding(0.0f, 0.0f, 0.0f, 8.0f)
        [
            SNew(SBorder)
            .Padding(FMargin(0.0f, 1.0f))
            .BorderImage(FCoreStyle::Get().GetBrush(TEXT("WhiteBrush")))
            .BorderBackgroundColor(AIFactoryPalette::OrangeRule)
        ]
        + SVerticalBox::Slot()
        .AutoHeight()
        [
            SNew(SHorizontalBox)
                + SHorizontalBox::Slot()
                .AutoWidth()
                .VAlign(VAlign_Center)
                .Padding(0.0f, 0.0f, 6.0f, 0.0f)
                [
                    SNew(SBox)
                    .WidthOverride(18.0f)
                    [
                        SNew(STextBlock)
                        .Text(FText::FromString(TEXT("W")))
                        .ColorAndOpacity(AIFactoryPalette::Orange)
                        .Font(FCoreStyle::GetDefaultFontStyle(TEXT("Bold"), 10))
                    ]
                ]
                + SHorizontalBox::Slot()
                .FillWidth(1.0f)
                .VAlign(VAlign_Center)
                .Padding(0.0f, 0.0f, 12.0f, 0.0f)
                [
                    SAssignNew(WidthSlider, SSlider)
                    .Value(MetresToSlider(SelectionWidthM))
                    .OnValueChanged_Lambda([this](float NewValue)
                    {
                        SelectionWidthM = SliderToMetres(NewValue);
                        RefreshSelectionPreview();
                    })
                ]
                + SHorizontalBox::Slot()
                .AutoWidth()
                .VAlign(VAlign_Center)
                .Padding(6.0f, 0.0f, 0.0f, 0.0f)
                [
                    MakeDimensionEntry(0)
                ]
                + SHorizontalBox::Slot()
                .AutoWidth()
                .VAlign(VAlign_Center)
                .Padding(0.0f, 0.0f, 6.0f, 0.0f)
                [
                    SNew(SBox)
                    .WidthOverride(18.0f)
                    [
                        SNew(STextBlock)
                        .Text(FText::FromString(TEXT("D")))
                        .ColorAndOpacity(AIFactoryPalette::Orange)
                        .Font(FCoreStyle::GetDefaultFontStyle(TEXT("Bold"), 10))
                    ]
                ]
                + SHorizontalBox::Slot()
                .FillWidth(1.0f)
                .VAlign(VAlign_Center)
                .Padding(0.0f, 0.0f, 12.0f, 0.0f)
                [
                    SAssignNew(DepthSlider, SSlider)
                    .Value(MetresToSlider(SelectionDepthM))
                    .OnValueChanged_Lambda([this](float NewValue)
                    {
                        SelectionDepthM = SliderToMetres(NewValue);
                        RefreshSelectionPreview();
                    })
                ]
                + SHorizontalBox::Slot()
                .AutoWidth()
                .VAlign(VAlign_Center)
                .Padding(6.0f, 0.0f, 0.0f, 0.0f)
                [
                    MakeDimensionEntry(1)
                ]
                + SHorizontalBox::Slot()
                .AutoWidth()
                .VAlign(VAlign_Center)
                .Padding(0.0f, 0.0f, 6.0f, 0.0f)
                [
                    SNew(SBox)
                    .WidthOverride(18.0f)
                    [
                        SNew(STextBlock)
                        .Text(FText::FromString(TEXT("H")))
                        .ColorAndOpacity(AIFactoryPalette::Orange)
                        .Font(FCoreStyle::GetDefaultFontStyle(TEXT("Bold"), 10))
                    ]
                ]
                + SHorizontalBox::Slot()
                .FillWidth(1.0f)
                .VAlign(VAlign_Center)
                .Padding(0.0f, 0.0f, 12.0f, 0.0f)
                [
                    SAssignNew(HeightSlider, SSlider)
                    .Value(MetresToSlider(SelectionHeightM))
                    .OnValueChanged_Lambda([this](float NewValue)
                    {
                        SelectionHeightM = SliderToMetres(NewValue);
                        RefreshSelectionPreview();
                    })
                ]
                + SHorizontalBox::Slot()
                .AutoWidth()
                .VAlign(VAlign_Center)
                .Padding(6.0f, 0.0f, 0.0f, 0.0f)
                [
                    MakeDimensionEntry(2)
                ]
        ]
        + SVerticalBox::Slot()
        .AutoHeight()
        .Padding(0.0f, 8.0f, 0.0f, 0.0f)
        [
            SNew(SHorizontalBox)
            + SHorizontalBox::Slot().AutoWidth()[ MakeCategoryToggle(0, TEXT("Structure")) ]
            + SHorizontalBox::Slot().AutoWidth()[ MakeCategoryToggle(1, TEXT("Machines")) ]
            + SHorizontalBox::Slot().AutoWidth()[ MakeCategoryToggle(2, TEXT("Belts/pipes")) ]
            + SHorizontalBox::Slot().AutoWidth()[ MakeCategoryToggle(3, TEXT("Power")) ]
            + SHorizontalBox::Slot().AutoWidth()[ MakeCategoryToggle(4, TEXT("Other")) ]
        ]
        + SVerticalBox::Slot()
        .AutoHeight()
        .Padding(0.0f, 4.0f, 0.0f, 0.0f)
        [
            SNew(SHorizontalBox)
            + SHorizontalBox::Slot()
            .AutoWidth()
            .VAlign(VAlign_Center)
            [
                SNew(SCheckBox)
                .IsChecked_Lambda([this]()
                {
                    return bSelectionStrictFit ? ECheckBoxState::Checked : ECheckBoxState::Unchecked;
                })
                .OnCheckStateChanged_Lambda([this](ECheckBoxState State)
                {
                    bSelectionStrictFit = (State == ECheckBoxState::Checked);
                    if (bSelectionAnchored)
                    {
                        RefreshSelectionPreview();
                    }
                })
            ]
            + SHorizontalBox::Slot()
            .AutoWidth()
            .VAlign(VAlign_Center)
            .Padding(3.0f, 0.0f, 12.0f, 0.0f)
            [
                SNew(STextBlock)
                .Text(FText::FromString(TEXT("Only fully inside the box")))
                .ColorAndOpacity(AIFactoryPalette::Text)
                .Font(FCoreStyle::GetDefaultFontStyle(TEXT("Regular"), 9))
            ]
            + SHorizontalBox::Slot()
            .AutoWidth()
            [
                SNew(SButton)
                .ButtonColorAndOpacity(AIFactoryPalette::Button)
                .ForegroundColor(AIFactoryPalette::Orange)
                .Text(FText::FromString(TEXT("Move box here")))
                .ToolTipText(FText::FromString(TEXT(
                    "Re-centre the box on where you are standing now, keeping the slider sizes.")))
                .OnClicked_Lambda([this]()
                {
                    // Re-anchor without clearing. Clearing would make the player
                    // dial all three dimensions back in every time they walked
                    // somewhere, which is the thing that makes a box selector
                    // tedious on a large base.
                    bSelectionAnchored = false;
                    RefreshSelectionPreview();
                    return FReply::Handled();
                })
            ]
            + SHorizontalBox::Slot()
            .AutoWidth()
            .Padding(6.0f, 0.0f, 0.0f, 0.0f)
            [
                SNew(SButton)
                .ButtonColorAndOpacity(AIFactoryPalette::Button)
                .ForegroundColor(AIFactoryPalette::Orange)
                .Text(FText::FromString(TEXT("Select aimed")))
                .ToolTipText(FText::FromString(TEXT(
                    "Replace the current selection with exactly the buildable under your crosshair. "
                    "This never expands into a box.")))
                .OnClicked_Lambda([this]()
                {
                    SelectAimedBuildable();
                    return FReply::Handled();
                })
            ]
        ]
        + SVerticalBox::Slot()
        .AutoHeight()
        .Padding(0.0f, 6.0f, 0.0f, 0.0f)
        [
            SNew(SHorizontalBox)
            + SHorizontalBox::Slot()
            .FillWidth(1.0f)
            .VAlign(VAlign_Center)
            [
                SAssignNew(SelectionCountText, STextBlock)
                .Text(FText::FromString(TEXT("Nothing selected. Drag a slider or type a size, then tick what to include.")))
                .ColorAndOpacity(AIFactoryPalette::Orange)
                .Font(FCoreStyle::GetDefaultFontStyle(TEXT("Regular"), 10))
            ]
            + SHorizontalBox::Slot()
            .AutoWidth()
            .Padding(8.0f, 0.0f, 0.0f, 0.0f)
            [
                SNew(SBox)
                .WidthOverride(150.0f)
                [
                    SAssignNew(BlueprintNameBox, SEditableTextBox)
                    .HintText(FText::FromString(TEXT("blueprint name")))
                ]
            ]
            + SHorizontalBox::Slot()
            .AutoWidth()
            .Padding(6.0f, 0.0f, 0.0f, 0.0f)
            [
                SNew(SButton)
                .ButtonColorAndOpacity(AIFactoryPalette::Button)
                .ForegroundColor(AIFactoryPalette::Orange)
                .Text(FText::FromString(TEXT("Save blueprint")))
                .OnClicked_Lambda([this]()
                {
                    BeginStagedExport(BlueprintNameBox.IsValid()
                        ? BlueprintNameBox->GetText().ToString().TrimStartAndEnd()
                        : FString());
                    return FReply::Handled();
                })
            ]
            + SHorizontalBox::Slot()
            .AutoWidth()
            .Padding(6.0f, 0.0f, 0.0f, 0.0f)
            [
                SNew(SButton)
                .Text(FText::FromString(TEXT("Upgrade")))
                .ButtonColorAndOpacity(AIFactoryPalette::Button)
                .ForegroundColor(AIFactoryPalette::Orange)
                .ToolTipText(FText::FromString(TEXT(
                    "Replace every selected building with the highest tier you have unlocked. "
                    "Connections are preserved. Costs materials.")))
                .OnClicked_Lambda([this]()
                {
                    UpgradeSelection();
                    return FReply::Handled();
                })
            ]
            + SHorizontalBox::Slot()
            .AutoWidth()
            .Padding(6.0f, 0.0f, 0.0f, 0.0f)
            [
                SNew(SButton)
                .Text(FText::FromString(TEXT("Demolish")))
                .ButtonColorAndOpacity(AIFactoryPalette::Danger)
                .ForegroundColor(AIFactoryPalette::Text)
                .OnClicked_Lambda([this]()
                {
                    DemolishSelection();
                    return FReply::Handled();
                })
            ]
            + SHorizontalBox::Slot()
            .AutoWidth()
            .Padding(6.0f, 0.0f, 0.0f, 0.0f)
            [
                SNew(SButton)
                .ButtonColorAndOpacity(AIFactoryPalette::Button)
                .ForegroundColor(AIFactoryPalette::TextMuted)
                .Text(FText::FromString(TEXT("Clear")))
                .OnClicked_Lambda([this]()
                {
                    ClearSelectionPreview();
                    return FReply::Handled();
                })
            ]
        ]
        // What it would cost to rebuild. Borrowed from the SMART! panel, whose
        // best line states what a placement will produce before you commit --
        // the equivalent question for a mega-blueprint is not how many
        // buildings but whether you can afford to place it.
        + SVerticalBox::Slot()
        .AutoHeight()
        .Padding(0.0f, 4.0f, 0.0f, 0.0f)
        [
            SAssignNew(SelectionCostText, STextBlock)
            .Text(FText::GetEmpty())
            .ColorAndOpacity(AIFactoryPalette::TextMuted)
            .Font(FCoreStyle::GetDefaultFontStyle(TEXT("Regular"), 9))
        ];
}

/**
 * Dismantle everything in the selection.
 *
 * The most destructive thing in this mod, so it arms rather than fires: the
 * first click reports what would go and starts a five second window, the
 * second click inside that window does it. A single misclick cannot delete a
 * base, and the count is on screen while deciding.
 *
 * Dismantled, not destroyed. IFGDismantleInterface refunds the materials the
 * way the player's own dismantle tool does; Destroy() would silently eat
 * them.
 */
void UAIFactoryCopilotUISubsystem::DemolishSelection()
{
    const int32 Total = SelectionActorIds.Num() + LightweightCount;
    if (Total == 0)
    {
        AppendTranscript(TEXT("COPILOT"), TEXT("Nothing is selected."));
        return;
    }

    const double Now = FPlatformTime::Seconds();
    if (DemolishArmedAt <= 0.0 || (Now - DemolishArmedAt) > 5.0)
    {
        DemolishArmedAt = Now;
        AppendTranscript(TEXT("COPILOT"), FString::Printf(
            TEXT("Demolish will dismantle %d buildings (%d of them lightweight). ")
            TEXT("Click Demolish again within five seconds to confirm. Materials are refunded."),
            Total,
            LightweightCount));
        return;
    }
    DemolishArmedAt = 0.0;

    AFGPlayerController* Controller = GetLocalPlayerController();
    UWorld* World = IsValid(Controller) ? Controller->GetWorld() : nullptr;
    if (!IsValid(World))
    {
        return;
    }

    int32 RemovedActors = 0;
    TSet<FString> Wanted(SelectionActorIds);
    TArray<AFGBuildable*> Doomed;
    for (TActorIterator<AFGBuildable> It(World); It; ++It)
    {
        AFGBuildable* Buildable = *It;
        if (IsValid(Buildable) && Wanted.Contains(Buildable->GetPathName()))
        {
            Doomed.Add(Buildable);
        }
    }
    // Gathered first, then dismantled: removing actors while iterating the
    // world is how you get a stale pointer, and this file has already seen
    // one conveyor-chain crash of exactly that shape.
    for (AFGBuildable* Buildable : Doomed)
    {
        if (!IsValid(Buildable))
        {
            continue;
        }
        if (Buildable->GetClass()->ImplementsInterface(UFGDismantleInterface::StaticClass()))
        {
            IFGDismantleInterface::Execute_Dismantle(Buildable);
            ++RemovedActors;
        }
    }

    // Lightweight refs preserve identity even if another removal makes the
    // subsystem compact/reuse an array index, so removing this preview cannot
    // spill into a structural piece that was never selected.
    int32 RemovedLightweight = 0;
    for (FLightweightBuildableInstanceRef& Ref : SelectionLightweight)
    {
        if (Ref.IsValid() && Ref.Remove())
        {
            ++RemovedLightweight;
        }
    }

    AppendTranscript(TEXT("COPILOT"), FString::Printf(
        TEXT("Dismantled %d buildings and %d lightweight pieces. Materials refunded where they fit."),
        RemovedActors,
        RemovedLightweight));
    ClearSelectionPreview();
}

/**
 * Arm the game's instance converter over the selection, then wait.
 *
 * Nothing is exported here. The converter turns lightweight instances into
 * real buildables over the next few ticks, and only then does the actor
 * query see a whole building rather than its machines.
 */
void UAIFactoryCopilotUISubsystem::BeginStagedExport(const FString& Name)
{
    if (Name.IsEmpty())
    {
        AppendTranscript(TEXT("COPILOT"), TEXT("Give the blueprint a name first."));
        return;
    }
    if (SelectionActorIds.Num() + LightweightCount == 0)
    {
        AppendTranscript(TEXT("COPILOT"), TEXT("Nothing is selected. Set a size first — the box centres on where you stand."));
        return;
    }
    if (!PendingExportName.IsEmpty())
    {
        AppendTranscript(TEXT("COPILOT"), TEXT("An export is already in progress."));
        return;
    }

    AFGPlayerController* Controller = GetLocalPlayerController();
    UWorld* World = IsValid(Controller) ? Controller->GetWorld() : nullptr;
    if (!IsValid(World))
    {
        return;
    }

    // Materialising is synchronous now -- the exporter spawns the lightweight
    // pieces itself -- so there is nothing to stage and nothing to wait for.
    // The converter path below is kept but no longer used; see TickStagedExport.
    ExportSelectionAsBlueprint();
}

/** Drop the converter. Safe to call when none was ever armed. */
void UAIFactoryCopilotUISubsystem::EndConversion()
{
    AFGPlayerController* Controller = GetLocalPlayerController();
    UWorld* World = IsValid(Controller) ? Controller->GetWorld() : nullptr;
    if (IsValid(World) && ConversionInstigator.IsValid())
    {
        if (AFGLightweightBuildableSubsystem* Lightweight =
                AFGLightweightBuildableSubsystem::Get(World))
        {
            Lightweight->RemoveInstanceConverterInstigator(ConversionInstigator.Get());
        }
    }
    ConversionInstigator.Reset();
}

/**
 * Watch the count until conversion settles, then export.
 *
 * Stable for three consecutive polls is the signal. A fixed delay would be a
 * guess about someone else's frame budget; this measures the thing it
 * actually depends on. Ten seconds is a hard ceiling so a converter that
 * never settles cannot wedge the panel.
 */
/**
 * No longer in the export path, and left inert on purpose.
 *
 * This waited on AddInstanceConverterInstigator to materialise lightweight
 * pieces. It never produced a measurable conversion, and the settle test could
 * not distinguish a converter that had not started from one that had finished:
 * at a 0.2s ticker and three stable polls it fired 0.8s after arming, every
 * time. The exporter spawns the pieces directly now. Kept rather than deleted
 * because the converter is still the right tool if the direct spawn ever turns
 * out to be too heavy for a very large selection -- but nothing calls this, so
 * PendingExportName stays empty and it returns immediately.
 */
void UAIFactoryCopilotUISubsystem::TickStagedExport()
{
    if (PendingExportName.IsEmpty())
    {
        return;
    }

    RefreshSelectionPreview();
    const int32 Count = SelectionActorIds.Num();
    if (Count == PendingExportLastCount)
    {
        ++PendingExportStableTicks;
    }
    else
    {
        PendingExportStableTicks = 0;
        PendingExportLastCount = Count;
    }

    const bool bSettled = PendingExportStableTicks >= 3;
    const bool bTimedOut = (FPlatformTime::Seconds() - PendingExportStartedAt) > 10.0;
    if (!bSettled && !bTimedOut)
    {
        return;
    }

    const FString Name = PendingExportName;
    PendingExportName.Reset();

    if (bTimedOut && !bSettled)
    {
        AppendTranscript(TEXT("COPILOT"), FString::Printf(
            TEXT("Conversion did not settle in ten seconds; exporting the %d actors that did appear. ")
            TEXT("Some structure may be missing."),
            Count));
    }

    // The name box drives ExportSelectionAsBlueprint, so restore it in case
    // the player edited it while waiting.
    if (BlueprintNameBox.IsValid())
    {
        BlueprintNameBox->SetText(FText::FromString(Name));
    }
    ExportSelectionAsBlueprint();
    EndConversion();
}

/**
 * One typed dimension field, paired with its slider.
 *
 * Axis 0/1/2 is width, depth, height. Committed on enter or focus loss, never
 * per keystroke -- re-running the world query while someone is halfway through
 * typing '120' would repaint a selection for '1' and then '12'.
 */
TSharedRef<SWidget> UAIFactoryCopilotUISubsystem::MakeDimensionEntry(int32 Axis)
{
    TSharedPtr<SEditableTextBox>& Slot =
        Axis == 0 ? WidthEntry : (Axis == 1 ? DepthEntry : HeightEntry);
    return SNew(SBox)
        .WidthOverride(56.0f)
        [
            SAssignNew(Slot, SEditableTextBox)
            .Justification(ETextJustify::Right)
            .SelectAllTextWhenFocused(true)
            .OnTextCommitted_Lambda([this, Axis](const FText& NewText, ETextCommit::Type)
            {
                ApplyTypedDimension(Axis, NewText.ToString());
            })
        ];
}

/** Push the current metres into the boxes without fighting an active edit. */
void UAIFactoryCopilotUISubsystem::SyncDimensionEntries()
{
    const TSharedPtr<SEditableTextBox> Boxes[3] = { WidthEntry, DepthEntry, HeightEntry };
    const double Values[3] = { SelectionWidthM, SelectionDepthM, SelectionHeightM };
    for (int32 Index = 0; Index < 3; ++Index)
    {
        // Never overwrite a box the player is typing in.
        if (Boxes[Index].IsValid() && !Boxes[Index]->HasKeyboardFocus())
        {
            Boxes[Index]->SetText(FText::FromString(FString::Printf(TEXT("%.0f"), Values[Index])));
        }
    }
}

/**
 * Accept a typed dimension.
 *
 * Rejects nonsense by leaving the value alone and resyncing, rather than
 * clamping silently to something the player did not ask for -- a box that
 * snaps 'abc' to 5 looks broken; one that snaps back to its old value reads
 * as refusal.
 */
void UAIFactoryCopilotUISubsystem::ApplyTypedDimension(int32 Axis, const FString& Value)
{
    const FString Trimmed = Value.TrimStartAndEnd();
    if (!Trimmed.IsNumeric())
    {
        SyncDimensionEntries();
        return;
    }
    const double Metres = FMath::Clamp(FCString::Atod(*Trimmed), 5.0, 1000.0);
    if (Axis == 0) { SelectionWidthM = Metres; }
    else if (Axis == 1) { SelectionDepthM = Metres; }
    else { SelectionHeightM = Metres; }

    // Move the slider to match, or the two disagree the moment one is dragged.
    const TSharedPtr<SSlider> Sliders[3] = { WidthSlider, DepthSlider, HeightSlider };
    if (Sliders[Axis].IsValid())
    {
        Sliders[Axis]->SetValue(MetresToSlider(Metres));
    }
    SyncDimensionEntries();
    RefreshSelectionPreview();
}

/**
 * What the selection would cost to rebuild.
 *
 * Borrowed from the SMART! panel, whose best line is the one stating what a
 * placement will produce before you commit to it. The equivalent question for
 * a mega-blueprint is not "how many buildings" but "can I afford to place
 * this", and a count answers the wrong one.
 *
 * Summed from each buildable's own GetBuiltWithRecipe through
 * UFGRecipe::GetIngredients -- the game's numbers, not a table.
 *
 * Lightweight instances are counted too: their runtime data carries
 * BuiltWithRecipe, and leaving foundations out of a build cost would understate
 * it enormously on exactly the selections that need the figure most.
 */
/**
 * What the selection would cost to rebuild.
 *
 * Formatting only. The recipes were tallied by the preview pass that already
 * walked these buildings; this used to repeat that walk in full and then call
 * GetIngredients once per building -- 4,443 lookups on one of the owner's
 * selections, on every slider frame. Keyed by recipe, a thousand identical
 * foundations cost one lookup.
 *
 * Borrowed from the SMART! panel, whose best line states what a placement will
 * produce before you commit. The equivalent question for a mega-blueprint is
 * not how many buildings but whether you can afford to place it.
 */
void UAIFactoryCopilotUISubsystem::RefreshSelectionCost()
{
    if (!SelectionCostText.IsValid())
    {
        return;
    }
    if (SelectionRecipeCounts.Num() == 0)
    {
        SelectionCostText->SetText(FText::GetEmpty());
        return;
    }

    AFGPlayerController* Controller = GetLocalPlayerController();
    UWorld* World = IsValid(Controller) ? Controller->GetWorld() : nullptr;
    if (!IsValid(World))
    {
        return;
    }

    TMap<TSubclassOf<UFGItemDescriptor>, int64> Totals;
    for (const TPair<TSubclassOf<UFGRecipe>, int32>& Entry : SelectionRecipeCounts)
    {
        if (!IsValid(Entry.Key))
        {
            continue;
        }
        for (const FItemAmount& Ingredient : UFGRecipe::GetIngredients(World, Entry.Key))
        {
            if (IsValid(Ingredient.ItemClass))
            {
                Totals.FindOrAdd(Ingredient.ItemClass) +=
                    static_cast<int64>(Ingredient.Amount) * Entry.Value;
            }
        }
    }

    if (Totals.Num() == 0)
    {
        SelectionCostText->SetText(FText::FromString(
            TEXT("Cost unavailable — none of these carry a build recipe.")));
        return;
    }

    Totals.ValueSort([](int64 A, int64 B) { return A > B; });
    FString Line;
    int32 Shown = 0;
    for (const TPair<TSubclassOf<UFGItemDescriptor>, int64>& Total : Totals)
    {
        if (Shown >= 5)
        {
            Line += FString::Printf(TEXT("  +%d more"), Totals.Num() - Shown);
            break;
        }
        if (Shown > 0)
        {
            Line += TEXT("   ");
        }
        Line += FString::Printf(TEXT("%lld %s"),
            Total.Value,
            *UFGItemDescriptor::GetItemName(Total.Key).ToString());
        ++Shown;
    }
    SelectionCostText->SetText(FText::FromString(TEXT("Rebuild cost:  ") + Line));
}

/**
 * Replace every selected building with the highest tier unlocked.
 *
 * TryUpgrade is the game's own swap -- what happens when a Mk.2 belt is built
 * over a Mk.1 -- and it preserves connections. Dismantling and rebuilding would
 * not, which is why this goes through a hologram rather than doing it directly.
 *
 * Armed like Demolish. It spends materials on every building it touches, and at
 * the scale this selector reaches there is no undoing it.
 *
 * Lightweight instances are deliberately not upgraded. Foundations and walls are
 * untiered, so there is nothing to upgrade them to, and materialising thousands
 * of them to discover that would be a long freeze for no result.
 */
void UAIFactoryCopilotUISubsystem::UpgradeSelection()
{
    if (SelectionActorIds.Num() == 0)
    {
        AppendTranscript(TEXT("COPILOT"), TEXT(
            "Nothing upgradable is selected. Structure is untiered — tick Machines or Belts/pipes."));
        return;
    }

    AFGPlayerController* Controller = GetLocalPlayerController();
    UWorld* World = IsValid(Controller) ? Controller->GetWorld() : nullptr;
    if (!IsValid(World))
    {
        return;
    }

    // Resolve first, so the armed message states the real number rather than the
    // selection size. Most of a selection is usually already at top tier.
    TArray<TPair<AFGBuildable*, AIFactoryUpgrade::FUpgradeTarget>> Planned;
    TSet<FString> Wanted(SelectionActorIds);
    for (TActorIterator<AFGBuildable> It(World); It; ++It)
    {
        AFGBuildable* Buildable = *It;
        if (!IsValid(Buildable) || !Wanted.Contains(Buildable->GetPathName()))
        {
            continue;
        }
        const AIFactoryUpgrade::FUpgradeTarget Target =
            AIFactoryUpgrade::FindMaxTier(World, Buildable->GetClass());
        if (Target.IsValid() && Target.BuildableClass != Buildable->GetClass())
        {
            Planned.Add(TPair<AFGBuildable*, AIFactoryUpgrade::FUpgradeTarget>(Buildable, Target));
        }
    }

    if (Planned.Num() == 0)
    {
        AppendTranscript(TEXT("COPILOT"), FString::Printf(TEXT(
            "Nothing to upgrade — all %d selected buildings are already at the highest tier you have unlocked."),
            SelectionActorIds.Num()));
        return;
    }

    const double Now = FPlatformTime::Seconds();
    if (UpgradeArmedAt <= 0.0 || (Now - UpgradeArmedAt) > 5.0)
    {
        UpgradeArmedAt = Now;
        // Name what changes, not just how many. "46 buildings" tells you nothing
        // about whether the plan is what you meant.
        TMap<FString, int32> Moves;
        for (const TPair<AFGBuildable*, AIFactoryUpgrade::FUpgradeTarget>& Entry : Planned)
        {
            const FString Move = FString::Printf(TEXT("%s -> Mk%d"),
                *Entry.Key->GetClass()->GetName().Replace(TEXT("Build_"), TEXT("")).Replace(TEXT("_C"), TEXT("")),
                Entry.Value.Tier);
            Moves.FindOrAdd(Move) += 1;
        }
        FString Summary;
        int32 Shown = 0;
        for (const TPair<FString, int32>& Move : Moves)
        {
            if (Shown >= 6)
            {
                Summary += FString::Printf(TEXT(", +%d more kinds"), Moves.Num() - Shown);
                break;
            }
            Summary += (Shown > 0 ? TEXT(", ") : TEXT(""));
            Summary += FString::Printf(TEXT("%d x %s"), Move.Value, *Move.Key);
            ++Shown;
        }
        AppendTranscript(TEXT("COPILOT"), FString::Printf(TEXT(
            "Upgrade will replace %d of %d selected buildings: %s. This spends materials and cannot be undone. ")
            TEXT("Click Upgrade again within five seconds to confirm."),
            Planned.Num(), SelectionActorIds.Num(), *Summary));
        return;
    }
    UpgradeArmedAt = 0.0;

    int32 Upgraded = 0;
    int32 Refused = 0;
    for (const TPair<AFGBuildable*, AIFactoryUpgrade::FUpgradeTarget>& Entry : Planned)
    {
        AFGBuildable* Old = Entry.Key;
        if (!IsValid(Old))
        {
            // A previous upgrade in this same pass may have consumed it: a belt
            // swap can replace its neighbours.
            continue;
        }

        AFGHologram* Hologram = AFGHologram::SpawnHologramFromRecipe(
            Entry.Value.Recipe,
            Controller,
            Old->GetActorLocation(),
            Controller->GetPawn());
        if (!IsValid(Hologram))
        {
            ++Refused;
            continue;
        }

        // TryUpgrade both tests and positions: it sets the hologram's transform
        // from the actor it is replacing, so nothing here computes a placement.
        FHitResult Hit;
        Hit.HitObjectHandle = FActorInstanceHandle(Old);
        Hit.ImpactPoint = Old->GetActorLocation();
        Hit.Location = Old->GetActorLocation();
        Hit.Normal = FVector::UpVector;
        Hit.ImpactNormal = FVector::UpVector;

        if (!Hologram->TryUpgrade(Hit) || !Hologram->IsUpgrade())
        {
            // Not an upgrade path the game recognises. Leave the building alone
            // rather than dismantling and rebuilding, which would lose its
            // connections and its contents.
            Hologram->Destroy();
            ++Refused;
            continue;
        }

        TArray<AActor*> Children;
        AActor* Constructed = Hologram->Construct(
            Children,
            AFGBuildableSubsystem::Get(World)->GetNewNetConstructionID());
        Hologram->Destroy();

        if (IsValid(Constructed))
        {
            ++Upgraded;
        }
        else
        {
            ++Refused;
        }
    }

    AppendTranscript(TEXT("COPILOT"), FString::Printf(TEXT(
        "Upgraded %d buildings.%s"),
        Upgraded,
        Refused > 0
            ? *FString::Printf(TEXT(" %d were left alone — the game did not offer an upgrade path for them."), Refused)
            : TEXT("")));
    RefreshSelectionPreview();
}

/**
 * The two input paths, and what belongs in each.
 *
 * Written out rather than linked to documentation, because the moment someone
 * needs this they are in a game with a panel open, not reading a README.
 */
void UAIFactoryCopilotUISubsystem::ShowCommandHelp(bool bBecauseSlashWasTyped)
{
    FString Text;
    if (bBecauseSlashWasTyped)
    {
        Text += TEXT(
            "That is a chat command, and this box is not the chat console — it sends "
            "questions to the assistant, so nothing ran.\n\n"
            "Press **Enter** to open the game's chat, then type it there.\n\n");
    }

    Text += TEXT(
        "**Two places to type, and they do different things.**\n\n"
        "*This box* — plain questions in your own words. No slash. \"what is this "
        "machine\", \"what resources are near me\", \"is my hub well placed\".\n\n"
        "*The game chat* (**Enter**) — commands that act on the world:\n\n"
        "  `/aifactory look` — capture a screenshot for the assistant to read\n"
        "  `/aifactory terrain [radius_m] [step_m]` — scan ground height, slope and water\n"
        "  `/aifactory node` — list this map's resources\n"
        "  `/aifactory node <resource>` — retarget the node you are looking at\n"
        "  `/aifactory node original` — put that node back\n"
        "  `/aifactory scan [radius_m]` — capture an actor snapshot\n"
        "  `/aifactory export [radius_m|all]` — write the snapshot to disk\n"
        "  `/aifactory status` — what the mod and bridge think is going on\n\n"
        "**And most things need no typing at all.** The buttons above do the "
        "selection work: size the box, tick what to include, then Save blueprint, "
        "Upgrade, or Demolish.");

    AppendTranscript(TEXT("COPILOT"), Text);
}
