#include "AIFactoryCopilotUISubsystem.h"

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
                            // Opens the bridge's library page in the default
                            // browser: saved designs and blueprints, each with
                            // the phrase to say. The panel is Slate and draws
                            // plain text, so a link inside the transcript would
                            // not be clickable — a button is.
                            // No tooltip. The one that was here outlived the
                            // panel and followed the cursor around the world
                            // with no way to dismiss it -- a Slate tooltip does
                            // not go away just because the widget that owned it
                            // was hidden. "Library" says what the button does,
                            // so the tooltip was buying nothing anyway.
                            SNew(SButton)
                            .Text(FText::FromString(TEXT("Library")))
                            .OnClicked_Lambda([this]()
                            {
                                FPlatformProcess::LaunchURL(
                                    *ResolveLibraryUrl(), nullptr, nullptr);
                                return FReply::Handled();
                            })
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
FString UAIFactoryCopilotUISubsystem::ResolveLibraryUrl()
{
    const FString Configured = FAIFactorySettings::Load().BridgeUrl;

    // Keep scheme://host:port and drop the path, using only FindChar/Mid/Left.
    // An earlier attempt used FString::FindSubstring, which does not exist and
    // was caught by the compiler -- the third engine API this project has
    // guessed wrong, and the reason the rule is to verify first.
    int32 ColonAt = INDEX_NONE;
    if (Configured.FindChar(TEXT(':'), ColonAt))
    {
        const int32 HostStart = ColonAt + 3; // past "://"
        if (HostStart < Configured.Len())
        {
            const FString AfterScheme = Configured.Mid(HostStart);
            int32 PathStart = INDEX_NONE;
            if (AfterScheme.FindChar(TEXT('/'), PathStart))
            {
                return Configured.Left(HostStart + PathStart + 1);
            }
            return Configured + TEXT("/");
        }
    }
    return TEXT("http://127.0.0.1:8142/");
}

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
    return AreWriteActionsEnabled()
        ? TEXT("Ready | WRITES ENABLED | Enter sends | Shift+Enter new line | Insert or Esc closes")
        : TEXT("Ready | advisory/read-only | Enter sends | Shift+Enter new line | Insert or Esc closes");
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
