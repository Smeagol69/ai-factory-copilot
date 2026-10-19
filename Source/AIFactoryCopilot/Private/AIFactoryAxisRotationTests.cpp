#include "AIFactoryAxisRotationState.h"

#if WITH_DEV_AUTOMATION_TESTS
#include "Misc/AutomationTest.h"

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FAIFactoryAxisRotationTest,
    "AIFactoryCopilot.BuildGun.AxisRotation", EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FAIFactoryAxisRotationTest::RunTest(const FString& Parameters)
{
    FAIFactoryAxisRotationState State;
    State.Scroll(1.0f, false, false);
    TestTrue(TEXT("Inactive wheel input is inert"), State.Rotation.Equals(FQuat::Identity));
    State.Begin(FQuat::Identity);
    TestEqual(TEXT("Default axis is local Z"), State.Axis, 2);
    State.Cycle(1);
    TestEqual(TEXT("Next wraps Z to X"), State.Axis, 0);
    State.Cycle(-1);
    TestEqual(TEXT("Previous wraps X to Z"), State.Axis, 2);
    for (int32 I = 0; I < 24; ++I) State.Scroll(1.0f, false, false);
    TestTrue(TEXT("24 normal steps complete a turn"), State.Rotation.Equals(FQuat::Identity, 1.e-6));

    State.Begin(FRotator(0, 90, 0).Quaternion());
    const FQuat Before = State.Rotation;
    State.Cycle(1);
    State.Scroll(2.0f, false, true);
    TestTrue(TEXT("X rotation follows the already-rotated object's local X"),
        State.Rotation.GetAxisX().Equals(Before.GetAxisX(), 1.e-6));
    TestTrue(TEXT("A 90-degree local roll moves local Y to previous local Z"),
        State.Rotation.GetAxisY().Equals(Before.GetAxisZ(), 1.e-6));
    State.Scroll(-2.0f, false, true);
    TestTrue(TEXT("Inverse restores the original orientation"), State.Rotation.Equals(Before, 1.e-6));

    State.Begin(FQuat::Identity);
    State.Cycle(-1);
    State.Scroll(6.0f, false, false);
    TestTrue(TEXT("Local Y tilts forward up/down rather than producing yaw"),
        FMath::Abs(State.Rotation.GetAxisX().Z) > 0.999);
    State.Cycle(1);
    State.Scroll(1.0f, true, true);
    TestTrue(TEXT("Fine modifier takes precedence over coarse"),
        FMath::IsNearlyEqual(State.Rotation.AngularDistance(FQuat(FVector::RightVector, PI / 2.0)),
            FMath::DegreesToRadians(1.0), 1.e-6));
    TestTrue(TEXT("Combined tilted edits remain normalized"), State.Rotation.IsNormalized());
    State.Reset();
    TestFalse(TEXT("Reset disables editing"), State.bEnabled);
    TestTrue(TEXT("Next hologram inherits no rotation"), State.Rotation.Equals(FQuat::Identity));
    return true;
}
#endif
