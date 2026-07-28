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
    }
}
