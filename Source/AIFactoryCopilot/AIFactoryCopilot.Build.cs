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
            "SlateCore"
        });
    }
}
