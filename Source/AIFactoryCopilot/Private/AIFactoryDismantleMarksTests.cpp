#include "AIFactoryDismantleMarks.h"

#if defined(AIFACTORY_DISMANTLE_MARKS_STANDALONE) || WITH_DEV_AUTOMATION_TESTS
#include <cstdio>
#include <limits>
namespace AIFactoryDismantleMarksTests
{
    bool Run()
    {
        using AIFactoryDismantleMarks::Resolve;
        struct FCase { const char* Name; std::int32_t Pending, Returned; bool LastIsAimed, Valid; std::int32_t Keep; bool AimedOnly; };
        const FCase Cases[] = {
            {"nine marks, aim duplicates a mark", 9, 9, true, true, 9, false},
            {"nine marks plus unmarked crosshair", 9, 10, true, true, 9, false},
            {"nine marks with no crosshair", 9, 9, false, true, 9, false},
            {"no marks and one aimed object", 0, 1, true, true, 1, true},
            {"empty selection", 0, 0, false, true, 0, false},
            {"pending marks cannot become aim fallback", 9, 1, true, false, 0, false},
            {"missing returned mark", 9, 8, true, false, 0, false},
            {"empty list with pending marks", 9, 0, false, false, 0, false},
            {"unknown extra object", 9, 10, false, false, 0, false},
            {"multiple extra objects", 9, 11, true, false, 0, false},
            {"unidentified aimed fallback", 0, 1, false, false, 0, false},
            {"negative count", -1, 0, false, false, 0, false},
            {"integer boundary", std::numeric_limits<std::int32_t>::max(), std::numeric_limits<std::int32_t>::max(), true, true, std::numeric_limits<std::int32_t>::max(), false}
        };
        for (const auto& Case : Cases)
        {
            const auto Actual = Resolve(Case.Pending, Case.Returned, Case.LastIsAimed);
            if (Actual.Valid != Case.Valid || Actual.KeepCount != Case.Keep || Actual.AimedOnly != Case.AimedOnly)
            {
                std::printf("Dismantle marks regression: %s\n", Case.Name);
                return false;
            }
        }
        return true;
    }
}
#if defined(AIFACTORY_DISMANTLE_MARKS_STANDALONE)
int main()
{
    if (!AIFactoryDismantleMarksTests::Run()) return 1;
    std::printf("13 dismantle selection cases passed\n");
    return 0;
}
#else
#include "Misc/AutomationTest.h"
IMPLEMENT_SIMPLE_AUTOMATION_TEST(FAIFactoryDismantleMarksTest,
    "AIFactoryCopilot.Blueprints.DismantleMarks",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FAIFactoryDismantleMarksTest::RunTest(const FString& Parameters)
{
    return TestTrue(TEXT("Native pending marks and crosshair selection cases"), AIFactoryDismantleMarksTests::Run());
}
#endif
#endif
