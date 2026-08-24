using UnrealBuildTool;

public class AIFactoryCopilot : ModuleRules
{
    public AIFactoryCopilot(ReadOnlyTargetRules Target) : base(Target)
    {
        CppStandard = CppStandardVersion.Cpp20;
        DefaultBuildSettings = BuildSettingsVersion.Latest;

        PublicDependencyModuleNames.AddRange(new[]
        {
            "Core",
            "CoreUObject",
            "Engine",
            "FactoryGame",
            "SML"
        });

        PrivateDependencyModuleNames.AddRange(new[]
        {
            "HTTP",
            "InputCore",
            "Json",
            "JsonUtilities",
            "Projects",
            "Slate",
            "SlateCore",
            "UMG"
        });

        // SML loads the mod icon from this fixed loose-file path at runtime.
        // Declare it as NonUFS so Alpakit's UAT staging, archive, and
        // CopyToGameDirectory flows all carry the same file.
        RuntimeDependencies.Add(
            "$(PluginDir)/Resources/Icon128.png",
            StagedFileType.NonUFS);

        // The companion bridge ships inside the mod rather than beside it.
        //
        // It was a second download and a second install step, which is one step
        // too many for anyone installing from a mod manager: the mod would load,
        // the panel would say the assistant was offline, and the reason would be
        // a zip they never knew to fetch. The bridge now has a lock-pinned native
        // blueprint reader, so its small production node_modules tree is staged
        // too; leaving it out would make the game's auto-started bridge crash at
        // module import on a clean SML install.
        //
        // `test/` is deliberately not shipped -- 750 tests are for this repo, not
        // for a player's install.
        RuntimeDependencies.Add(
            "$(PluginDir)/companion/server.mjs",
            StagedFileType.NonUFS);
        RuntimeDependencies.Add(
            "$(PluginDir)/companion/package.json",
            StagedFileType.NonUFS);
        // The standalone installer consumes this lockfile transactionally. Keep
        // it beside the bundled source so a released mod and companion package
        // identify the same pinned parser dependency without shipping a
        // developer's local node_modules tree.
        RuntimeDependencies.Add(
            "$(PluginDir)/companion/package-lock.json",
            StagedFileType.NonUFS);
        RuntimeDependencies.Add(
            "$(PluginDir)/companion/lib/...",
            StagedFileType.NonUFS);
        RuntimeDependencies.Add(
            "$(PluginDir)/companion/data/...",
            StagedFileType.NonUFS);
        RuntimeDependencies.Add(
            "$(PluginDir)/companion/node_modules/...",
            StagedFileType.NonUFS);
    }
}
