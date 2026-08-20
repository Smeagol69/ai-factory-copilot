#include "AIFactoryCopilotUISubsystem.h"
#include "FGDismantleInterface.h"
#include "FGLightweightBuildableSubsystem.h"
#include "Widgets/Input/SSlider.h"
#include "EngineUtils.h"
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
                .BorderBackgroundColor(FLinearColor(0.025f, 0.035f, 0.045f, 0.985f))
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
                                .ColorAndOpacity(FLinearColor(0.92f, 0.96f, 1.0f, 1.0f))
                                .Font(FCoreStyle::GetDefaultFontStyle(TEXT("Bold"), 20))
                            ]
                            + SVerticalBox::Slot()
                            .AutoHeight()
                            .Padding(0.0f, 3.0f, 0.0f, 0.0f)
                            [
                                SAssignNew(LiveStatusText, STextBlock)
                                .Text(FText::FromString(TEXT("LIVE | waiting for a player")))
                                .ColorAndOpacity(FLinearColor(0.25f, 0.86f, 0.63f, 1.0f))
                                .Font(FCoreStyle::GetDefaultFontStyle(TEXT("Regular"), 10))
                            ]
                        ]
                        + SHorizontalBox::Slot()
                        .AutoWidth()
                        .Padding(8.0f, 0.0f)
                        [
                            SNew(SButton)
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
                        SNew(SSeparator)
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
                        .BackgroundColor(FLinearColor(0.045f, 0.06f, 0.075f, 1.0f))
                        .ForegroundColor(FLinearColor(0.92f, 0.94f, 0.96f, 1.0f))
                    ]
                    + SVerticalBox::Slot()
                    .AutoHeight()
                    .Padding(0.0f, 0.0f, 0.0f, 8.0f)
                    [
                        SAssignNew(RequestStatusText, STextBlock)
                        .Text(FText::FromString(GetReadyStatus()))
                        .ColorAndOpacity(
                            bWritesEnabled
                                ? FLinearColor(1.0f, 0.58f, 0.16f, 1.0f)
                                : FLinearColor(0.62f, 0.68f, 0.73f, 1.0f))
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
                                .BackgroundColor(FLinearColor(0.045f, 0.06f, 0.075f, 1.0f))
                                .ForegroundColor(FLinearColor(0.92f, 0.94f, 0.96f, 1.0f))
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

    AActor* FocusActor = nullptr;
    if (AFGCharacterPlayer* Character = Cast<AFGCharacterPlayer>(PlayerController->GetControlledCharacter()))
    {
        if (FUseState* UseState = Character->GetCachedUseState();
            UseState && UseState->bIsTraceHit)
        {
            FocusActor = UseState->UseHitResult.GetActor();
        }
    }

    if (!IsValid(FocusActor))
    {
        FVector ViewLocation;
        FRotator ViewRotation;
        PlayerController->GetPlayerViewPoint(ViewLocation, ViewRotation);
        FHitResult Hit;
        FCollisionQueryParams QueryParams(SCENE_QUERY_STAT(AIFactoryCopilotUILiveTrace), true, Pawn);
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
            ? FLinearColor(1.0f, 0.58f, 0.16f, 1.0f)
            : FLinearColor(0.62f, 0.68f, 0.73f, 1.0f));
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
void UAIFactoryCopilotUISubsystem::RefreshSelectionPreview()
{
    SelectionActorIds.Reset();

    AFGPlayerController* Controller = GetLocalPlayerController();
    UWorld* World = IsValid(Controller) ? Controller->GetWorld() : nullptr;
    APawn* Pawn = IsValid(Controller) ? Controller->GetPawn() : nullptr;
    if (!IsValid(World) || !IsValid(Pawn))
    {
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

    int32 Structural = 0;
    int32 Machines = 0;
    for (TActorIterator<AFGBuildable> It(World); It; ++It)
    {
        AFGBuildable* Buildable = *It;
        if (!IsValid(Buildable))
        {
            continue;
        }
        const FVector Offset = Buildable->GetActorLocation() - SelectionCentre;
        if (FMath::Abs(Offset.X) > Half.X ||
            FMath::Abs(Offset.Y) > Half.Y ||
            FMath::Abs(Offset.Z) > Half.Z)
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
        if (ClassName.Contains(TEXT("Foundation")) || ClassName.Contains(TEXT("Wall")) ||
            ClassName.Contains(TEXT("Pillar")) || ClassName.Contains(TEXT("Ramp")))
        {
            ++Structural;
        }
        else
        {
            ++Machines;
        }
    }

    // The other half of the world. Foundations and walls are converted to
    // lightweight instances and are not actors, so the iterator above cannot
    // see them -- a box over a whole building found three things and wrote a
    // blueprint that looked empty in the hologram.
    SelectionLightweight.Reset();
    LightweightCount = 0;
    if (AFGLightweightBuildableSubsystem* Lightweight =
            AFGLightweightBuildableSubsystem::Get(World))
    {
        for (const auto& Pair : Lightweight->GetAllLightweightBuildableInstances())
        {
            const TArray<FRuntimeBuildableInstanceData>& Instances = Pair.Value;
            for (int32 Index = 0; Index < Instances.Num(); ++Index)
            {
                const FVector Offset = Instances[Index].Transform.GetLocation() - SelectionCentre;
                if (FMath::Abs(Offset.X) > Half.X ||
                    FMath::Abs(Offset.Y) > Half.Y ||
                    FMath::Abs(Offset.Z) > Half.Z)
                {
                    continue;
                }
                SelectionLightweight.Add(TPair<TSubclassOf<AFGBuildable>, int32>(Pair.Key, Index));
                ++LightweightCount;
                ++Structural;
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
    Style.Color = FLinearColor(1.0f, 0.62f, 0.15f, 1.0f);
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
        SelectionCountText->SetText(FText::FromString(FString::Printf(
            TEXT("%d buildings  |  %d structure (%d lightweight), %d machines  |  %.0f x %.0f x %.0f m"),
            SelectionActorIds.Num() + LightweightCount,
            Structural,
            LightweightCount,
            Machines,
            SelectionWidthM,
            SelectionDepthM,
            SelectionHeightM)));
    }
}

void UAIFactoryCopilotUISubsystem::ClearSelectionPreview()
{
    SelectionActorIds.Reset();
    bSelectionAnchored = false;
    AFGPlayerController* Controller = GetLocalPlayerController();
    if (UWorld* World = IsValid(Controller) ? Controller->GetWorld() : nullptr)
    {
        AIFactoryOverlay::Clear(World, TEXT("selection"));
    }
    if (SelectionCountText.IsValid())
    {
        SelectionCountText->SetText(FText::FromString(TEXT("Selection cleared.")));
    }
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
    if (SelectionActorIds.Num() == 0)
    {
        AppendTranscript(TEXT("COPILOT"), TEXT("Nothing is selected. Move a slider to preview a box first."));
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
        AIFactoryBlueprintExport::ExportSelection(Context, Name, Buildables);

    // Report what the game said, not what was attempted.
    if (Result.bCommitted)
    {
        AppendTranscript(TEXT("COPILOT"), FString::Printf(
            TEXT("Wrote **%s** from %d buildings. It is in your blueprint menu now."),
            *Name,
            Buildables.Num()));
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
TSharedRef<SWidget> UAIFactoryCopilotUISubsystem::BuildSelectionSection()
{
    return SNew(SVerticalBox)
        + SVerticalBox::Slot()
        .AutoHeight()
        .Padding(0.0f, 0.0f, 0.0f, 4.0f)
        [
            SNew(STextBlock)
            .Text(FText::FromString(TEXT("SELECTION")))
            .ColorAndOpacity(FLinearColor(0.55f, 0.62f, 0.70f, 1.0f))
            .Font(FCoreStyle::GetDefaultFontStyle(TEXT("Bold"), 9))
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
                        .ColorAndOpacity(FLinearColor(0.55f, 0.62f, 0.70f, 1.0f))
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
                .Padding(0.0f, 0.0f, 6.0f, 0.0f)
                [
                    SNew(SBox)
                    .WidthOverride(18.0f)
                    [
                        SNew(STextBlock)
                        .Text(FText::FromString(TEXT("D")))
                        .ColorAndOpacity(FLinearColor(0.55f, 0.62f, 0.70f, 1.0f))
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
                .Padding(0.0f, 0.0f, 6.0f, 0.0f)
                [
                    SNew(SBox)
                    .WidthOverride(18.0f)
                    [
                        SNew(STextBlock)
                        .Text(FText::FromString(TEXT("H")))
                        .ColorAndOpacity(FLinearColor(0.55f, 0.62f, 0.70f, 1.0f))
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
                .Text(FText::FromString(TEXT("Move a slider to preview a selection.")))
                .ColorAndOpacity(FLinearColor(1.0f, 0.62f, 0.15f, 1.0f))
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
                .Text(FText::FromString(TEXT("Save blueprint")))
                .OnClicked_Lambda([this]()
                {
                    ExportSelectionAsBlueprint();
                    return FReply::Handled();
                })
            ]
            + SHorizontalBox::Slot()
            .AutoWidth()
            .Padding(6.0f, 0.0f, 0.0f, 0.0f)
            [
                SNew(SButton)
                .Text(FText::FromString(TEXT("Demolish")))
                .ButtonColorAndOpacity(FLinearColor(0.62f, 0.16f, 0.12f, 1.0f))
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
                .Text(FText::FromString(TEXT("Clear")))
                .OnClicked_Lambda([this]()
                {
                    ClearSelectionPreview();
                    return FReply::Handled();
                })
            ]
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

    // Lightweight instances go through their own handle. Highest index first,
    // because removing one shifts every index above it in that class's array.
    int32 RemovedLightweight = 0;
    if (AFGLightweightBuildableSubsystem* Lightweight =
            AFGLightweightBuildableSubsystem::Get(World))
    {
        SelectionLightweight.Sort([](const TPair<TSubclassOf<AFGBuildable>, int32>& A,
                                     const TPair<TSubclassOf<AFGBuildable>, int32>& B)
        {
            return A.Value > B.Value;
        });
        for (const TPair<TSubclassOf<AFGBuildable>, int32>& Entry : SelectionLightweight)
        {
            FLightweightBuildableInstanceRef Ref;
            Ref.Initialize(Lightweight, Entry.Key, Entry.Value);
            if (Ref.IsValid() && Ref.Remove())
            {
                ++RemovedLightweight;
            }
        }
    }

    AppendTranscript(TEXT("COPILOT"), FString::Printf(
        TEXT("Dismantled %d buildings and %d lightweight pieces. Materials refunded where they fit."),
        RemovedActors,
        RemovedLightweight));
    ClearSelectionPreview();
}
