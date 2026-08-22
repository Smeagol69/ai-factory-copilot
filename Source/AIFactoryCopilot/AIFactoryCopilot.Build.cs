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
        // a zip they never knew to fetch. It is ~1 MB of plain .mjs with zero npm
        // dependencies, so bundling costs almost nothing.
        //
        // `test/` is deliberately not shipped -- 750 tests are for this repo, not
        // for a player's install.
        RuntimeDependencies.Add(
            "$(PluginDir)/companion/server.mjs",
            StagedFileType.NonUFS);
        RuntimeDependencies.Add(
            "$(PluginDir)/companion/package.json",
            StagedFileType.NonUFS);
        RuntimeDependencies.Add(
            "$(PluginDir)/companion/lib/...",
            StagedFileType.NonUFS);
        RuntimeDependencies.Add(
            "$(PluginDir)/companion/data/...",
            StagedFileType.NonUFS);
    }
}
