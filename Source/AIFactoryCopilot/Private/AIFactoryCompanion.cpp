#include "AIFactoryCompanion.h"

#include "AIFactoryCopilotModule.h"
#include "AIFactorySettings.h"
#include "HAL/PlatformFileManager.h"
#include "HAL/PlatformProcess.h"
#include "Interfaces/IPluginManager.h"
#include "Misc/Paths.h"

namespace AIFactoryCompanion
{
namespace
{
    /** Only valid when this module created it. See the header. */
    FProcHandle LaunchedProcess;
    FString LastErrorMessage;

    FString PluginBaseDir()
    {
        const TSharedPtr<IPlugin> Plugin = IPluginManager::Get().FindPlugin(TEXT("AIFactoryCopilot"));
        return Plugin.IsValid() ? Plugin->GetBaseDir() : FString();
    }
}

FString BundledServerPath()
{
    const FString Base = PluginBaseDir();
    if (Base.IsEmpty())
    {
        return FString();
    }
    const FString Candidate = FPaths::Combine(Base, TEXT("companion"), TEXT("server.mjs"));
    return FPlatformFileManager::Get().GetPlatformFile().FileExists(*Candidate)
        ? FPaths::ConvertRelativePathToFull(Candidate)
        : FString();
}

FString LastError()
{
    return LastErrorMessage;
}

void EnsureRunning()
{
    const FAIFactorySettings Settings = FAIFactorySettings::Load();
    if (!Settings.bAutoStartCompanion)
    {
        return;
    }

    if (LaunchedProcess.IsValid() && FPlatformProcess::IsProcRunning(LaunchedProcess))
    {
        return;
    }
    if (LaunchedProcess.IsValid())
    {
        // It exited on its own -- most likely because a bridge was already
        // listening and it stood down. Release the handle before trying again.
        FPlatformProcess::CloseProc(LaunchedProcess);
        LaunchedProcess.Reset();
    }

    const FString ServerPath = BundledServerPath();
    if (ServerPath.IsEmpty())
    {
        LastErrorMessage = TEXT(
            "The bundled companion was not found in the mod folder. Reinstall the mod, "
            "or start it yourself with: node companion/server.mjs");
        UE_LOG(LogAIFactoryCopilot, Warning, TEXT("%s"), *LastErrorMessage);
        return;
    }

    const FString WorkingDirectory = FPaths::GetPath(ServerPath);
    const FString Parameters = FString::Printf(TEXT("\"%s\""), *ServerPath);

    uint32 ProcessId = 0;
    // Detached and hidden, and nothing waits on it: the game thread must never
    // block on a child process. A console window appearing over someone's game
    // would also be its own small betrayal.
    LaunchedProcess = FPlatformProcess::CreateProc(
        TEXT("node"),
        *Parameters,
        /*bLaunchDetached*/ true,
        /*bLaunchHidden*/ true,
        /*bLaunchReallyHidden*/ true,
        &ProcessId,
        /*PriorityModifier*/ 0,
        *WorkingDirectory,
        /*PipeWriteChild*/ nullptr);

    if (!LaunchedProcess.IsValid())
    {
        // Almost always means Node is not installed or not on PATH. Say that,
        // rather than "failed to start the companion", which tells a player
        // nothing they can act on.
        LastErrorMessage = TEXT(
            "Could not start the assistant: Node.js was not found. Install Node 20 or newer "
            "and restart the game. Everything else in the mod works without it.");
        UE_LOG(LogAIFactoryCopilot, Warning, TEXT("%s"), *LastErrorMessage);
        return;
    }

    LastErrorMessage.Reset();
    UE_LOG(LogAIFactoryCopilot, Display,
        TEXT("Started the bundled companion (pid %u) from %s"), ProcessId, *ServerPath);
}

void StopIfWeStartedIt()
{
    if (!LaunchedProcess.IsValid())
    {
        return;
    }
    if (FPlatformProcess::IsProcRunning(LaunchedProcess))
    {
        // KillTree: node may have spawned workers, and orphaning them would
        // leave the port held by something with no visible owner.
        FPlatformProcess::TerminateProc(LaunchedProcess, /*KillTree*/ true);
        UE_LOG(LogAIFactoryCopilot, Display, TEXT("Stopped the companion this session started."));
    }
    FPlatformProcess::CloseProc(LaunchedProcess);
    LaunchedProcess.Reset();
}
}
