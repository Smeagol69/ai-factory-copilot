#include "AIFactoryGeneratedGeometry.h"

#if WITH_DEV_AUTOMATION_TESTS
#include "Misc/AutomationTest.h"

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FAIFactoryGeneratedGeometryTest,
    "AIFactoryCopilot.Blueprints.ExactGeneratedGeometry", EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FAIFactoryGeneratedGeometryTest::RunTest(const FString& Parameters)
{
    using namespace AIFactoryGeneratedGeometry;
    const FTransform Archive(FRotator(0, 90, 0), FVector(100, -200, 10));
    const FTransform Relative(FRotator::ZeroRotator, FVector(400, 400, 50));
    const FTransform ExpectedTransform = Relative * Archive;
    TestTrue(TEXT("Archive frame gives the hand-computed native location"),
        ExpectedTransform.GetLocation().Equals(FVector(-300, 200, 60), 0.001));
    TArray<FPart> Expected = {{TEXT("floor-1"), TEXT("/Game/Foundation"), ExpectedTransform},
        {TEXT("wall-1"), TEXT("/Game/Wall"), FTransform(FRotator(0, 180, 0), FVector(900, 0, 100))}};
    TArray<FPart> Actual = {{TEXT(""), Expected[1].ClassPath, Expected[1].Transform},
        {TEXT(""), Expected[0].ClassPath, Expected[0].Transform}};
    int32 Matched = 0; FString Reason;
    TestTrue(TEXT("Unordered exact native class and transforms match"), Match(Expected, Actual, Matched, Reason));
    TestEqual(TEXT("Every planned piece was checked"), Matched, 2);

    Actual[1].Transform.AddToTranslation(FVector(0.05, 0, 0));
    TestTrue(TEXT("Half-millimetre serialization drift is within stated tolerance"), Match(Expected, Actual, Matched, Reason));
    Actual[1].Transform.AddToTranslation(FVector(0.2, 0, 0));
    TestFalse(TEXT("Misplaced piece refuses exact readback"), Match(Expected, Actual, Matched, Reason));
    TestTrue(TEXT("Failure identifies planned piece"), Reason.Contains(TEXT("floor-1")));
    Actual[1].Transform = Expected[0].Transform;
    Actual[1].ClassPath = TEXT("/Game/WrongFoundation");
    TestFalse(TEXT("Matching location is insufficient when class differs"), Match(Expected, Actual, Matched, Reason));
    Actual[1] = Expected[0];
    Actual[0].Transform.SetRotation(FRotator(0, 90, 0).Quaternion());
    TestFalse(TEXT("Wrong wall rotation refuses exact readback"), Match(Expected, Actual, Matched, Reason));
    Actual[0] = Expected[1];
    Actual[0].Transform.SetScale3D(FVector(1, 1, 2));
    TestFalse(TEXT("Wrong scale refuses exact readback"), Match(Expected, Actual, Matched, Reason));
    Actual[0] = Expected[1];
    Actual.Add(Expected[0]);
    TestFalse(TEXT("Duplicate indistinguishable observed actors are ambiguous"), Match(Expected, Actual, Matched, Reason));
    Actual.Pop();
    Expected.Add({TEXT("second-floor"), Expected[0].ClassPath, Expected[0].Transform});
    TestFalse(TEXT("One observed actor cannot satisfy two planned parts"), Match(Expected, Actual, Matched, Reason));
    return true;
}
#endif
