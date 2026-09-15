#include "AIFactoryCaptureGeometry.h"

#if defined(AIFACTORY_CAPTURE_GEOMETRY_STANDALONE) || WITH_DEV_AUTOMATION_TESTS
#include <iostream>

namespace AIFactoryCaptureGeometryTests
{
    bool Run()
    {
        using AIFactoryCaptureGeometry::ComputeDimensions;
        using Vector = std::array<double, 3>;
        using Cells = std::array<std::int32_t, 3>;
        bool Passed = true;
        const auto Check = [&Passed](const char* Name, const Vector& Min, const Vector& Max,
            const Vector& Origin, bool ExpectedValid, const Cells& Expected = Cells{})
        {
            Cells Actual = {-1, -1, -1};
            const bool Valid = ComputeDimensions(Min, Max, Origin, Actual);
            if (Valid != ExpectedValid || (Valid && Actual != Expected) ||
                (!Valid && Actual != Cells{-1, -1, -1}))
            {
                std::cerr << "Capture geometry failed: " << Name << '\n';
                Passed = false;
            }
        };
        Check("one full foundation", {-400, -400, -200}, {400, 400, 0}, {0, 0, -200}, true, {1, 1, 1});
        Check("150m capture exceeds designer", {-7500, -400, 0}, {7500, 400, 900}, {0, 0, 0}, true, {19, 1, 2});
        Check("snapped pivot expands nearer-centred envelope", {-100, -100, 0}, {700, 700, 800}, {0, 0, 0}, true, {2, 2, 1});
        Check("negative coordinates", {-1700, -1700, -500}, {-900, -900, 300}, {-1600, -1600, -500}, true, {2, 2, 1});
        Check("far world origin", {649000, 100000, -1000}, {650600, 101600, 600}, {649600, 100800, -1000}, true, {3, 2, 2});
        Check("exact cell boundary", {-800, -400, 0}, {800, 400, 800}, {0, 0, 0}, true, {2, 1, 1});
        Check("fraction beyond cell must round up", {-800, -400, 0}, {800.01, 400, 800.01}, {0, 0, 0}, true, {3, 1, 2});
        Check("flat wall retains a nonzero header", {-400, 0, 0}, {400, 0, 400}, {0, 0, 0}, true, {1, 1, 1});
        Check("floor cannot clip selection", {-400, -400, -1}, {400, 400, 800}, {0, 0, 0}, false);
        Check("inverted bounds", {1, 0, 0}, {0, 0, 1}, {0, 0, 0}, false);
        const double NaN = std::numeric_limits<double>::quiet_NaN();
        const double Inf = std::numeric_limits<double>::infinity();
        Check("NaN bounds", {NaN, 0, 0}, {1, 1, 1}, {0, 0, 0}, false);
        Check("infinite origin", {0, 0, 0}, {1, 1, 1}, {Inf, 0, 0}, false);
        Check("integer overflow", {-1.e15, 0, 0}, {1.e15, 1, 1}, {0, 0, 0}, false);
        Check("floating overflow", {-1.e308, 0, 0}, {1.e308, 1, 1}, {0, 0, 0}, false);
        return Passed;
    }
}

#if defined(AIFACTORY_CAPTURE_GEOMETRY_STANDALONE)
int main()
{
    if (!AIFactoryCaptureGeometryTests::Run()) return 1;
    std::cout << "14 capture geometry cases passed\n";
    return 0;
}
#else
#include "Misc/AutomationTest.h"
IMPLEMENT_SIMPLE_AUTOMATION_TEST(FAIFactoryCaptureGeometryTest,
    "AIFactoryCopilot.Blueprints.CaptureDimensions",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FAIFactoryCaptureGeometryTest::RunTest(const FString& Parameters)
{
    return TestTrue(TEXT("Native capture envelope numerical cases"), AIFactoryCaptureGeometryTests::Run());
}
#endif
#endif
