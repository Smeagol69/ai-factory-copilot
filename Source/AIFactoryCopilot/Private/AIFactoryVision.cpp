#include "AIFactoryVision.h"

#include "AIFactoryCopilotModule.h"
#include "AIFactorySettings.h"
#include "Dom/JsonObject.h"
#include "FGCharacterPlayer.h"
#include "FGPlayerController.h"
#include "GameFramework/PlayerController.h"
#include "HAL/PlatformFileManager.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "UnrealClient.h"

namespace AIFactoryVision
{
namespace
{
    /**
     * Which slot the next frame goes into.
     *
     * A ring rather than an ever-growing folder: a capture every ten seconds
     * would otherwise fill a disk over a long session, and old frames stop being
     * interesting long before they stop taking up space.
     */
    int32 NextFrameIndex = 0;

    FString FrameName(int32 Index)
    {
        return FString::Printf(TEXT("frame-%03d.png"), Index);
    }

    /** Best effort; a missing player is not a reason to skip the picture. */
    TSharedRef<FJsonObject> PlayerJson(UWorld* World)
    {
        const TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
        APlayerController* Controller = IsValid(World) ? World->GetFirstPlayerController() : nullptr;
        APawn* Pawn = IsValid(Controller) ? Controller->GetPawn() : nullptr;
        if (!IsValid(Pawn))
        {
            return Result;
        }

        const FVector Location = Pawn->GetActorLocation();
        const TSharedRef<FJsonObject> LocationJson = MakeShared<FJsonObject>();
        LocationJson->SetNumberField(TEXT("x"), Location.X);
        LocationJson->SetNumberField(TEXT("y"), Location.Y);
        LocationJson->SetNumberField(TEXT("z"), Location.Z);
        Result->SetObjectField(TEXT("location"), LocationJson);

        // Control rotation, not actor rotation: where the camera points is what
        // the picture shows, and the pawn's own yaw can differ from it.
        const FRotator View = IsValid(Controller) ? Controller->GetControlRotation() : Pawn->GetActorRotation();
        const TSharedRef<FJsonObject> RotationJson = MakeShared<FJsonObject>();
        RotationJson->SetNumberField(TEXT("pitch"), View.Pitch);
        RotationJson->SetNumberField(TEXT("yaw"), View.Yaw);
        RotationJson->SetNumberField(TEXT("roll"), View.Roll);
        Result->SetObjectField(TEXT("view_rotation"), RotationJson);
        return Result;
    }
}

FString VisionDirectory()
{
    const FString Directory = FPaths::Combine(
        FPaths::ProjectSavedDir(),
        TEXT("AIFactoryCopilot"),
        TEXT("Vision"));
    IPlatformFile& File = FPlatformFileManager::Get().GetPlatformFile();
    if (!File.DirectoryExists(*Directory))
    {
        File.CreateDirectoryTree(*Directory);
    }
    return Directory;
}

bool IsEnabled()
{
    return FAIFactorySettings::Load().bVisionEnabled;
}

void RequestFrame(UWorld* World, const FString& Reason, bool bWithUI)
{
    // Deliberately NOT gated on bVisionEnabled. That setting governs the
    // observer's automatic capture; an explicit request -- a chat command, a
    // button -- is the player asking, and asking is consent. Gating here would
    // have made `/aifactory look` silently do nothing while replying that it
    // had captured a frame.
    const FAIFactorySettings Settings = FAIFactorySettings::Load();

    const FString Directory = VisionDirectory();
    const int32 History = FMath::Max(1, Settings.VisionFrameHistory);
    const int32 Index = NextFrameIndex % History;
    NextFrameIndex = (NextFrameIndex + 1) % History;

    const FString FramePath = FPaths::Combine(Directory, FrameName(Index));

    // The absolute path is honoured as-is: CreateViewportScreenShotFilename
    // keeps any filename containing a slash and only prefixes the default
    // screenshot directory for bare names. Verified in UnrealClient.cpp rather
    // than assumed, because a wrong guess here writes frames somewhere nobody
    // ever looks and everything downstream reports "no frame captured".
    FScreenshotRequest::RequestScreenshot(FramePath, bWithUI, /*bAddUniqueSuffix*/ false);

    // The sidecar is written now, not when the PNG lands. Capture is
    // asynchronous and there is no reliable completion hook here, so the
    // contract is: the JSON describes the frame that was *requested*, and a
    // reader that finds no PNG yet should wait a beat rather than conclude the
    // capture failed.
    const TSharedRef<FJsonObject> Meta = MakeShared<FJsonObject>();
    Meta->SetStringField(TEXT("captured_at_utc"), FDateTime::UtcNow().ToIso8601());
    Meta->SetStringField(TEXT("reason"), Reason);
    Meta->SetStringField(TEXT("image"), FramePath);
    Meta->SetNumberField(TEXT("frame_index"), Index);
    Meta->SetNumberField(TEXT("frame_history"), History);
    Meta->SetBoolField(TEXT("includes_ui"), bWithUI);
    Meta->SetObjectField(TEXT("player"), PlayerJson(World));

    FString Serialised;
    const TSharedRef<TJsonWriter<>> Writer =
        TJsonWriterFactory<>::Create(&Serialised);
    FJsonSerializer::Serialize(Meta, Writer);

    // Two files: one that always names the newest frame, and one per frame so a
    // reader can walk backwards through the history and see what changed.
    FFileHelper::SaveStringToFile(Serialised, *FPaths::Combine(Directory, TEXT("latest.json")));
    FFileHelper::SaveStringToFile(
        Serialised,
        *FPaths::Combine(Directory, FString::Printf(TEXT("frame-%03d.json"), Index)));

    UE_LOG(LogAIFactoryCopilot, Verbose,
        TEXT("Vision frame %d requested (%s) -> %s"), Index, *Reason, *FramePath);
}
}
