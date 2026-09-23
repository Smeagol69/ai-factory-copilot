#include "../../Source/AIFactoryCopilot/Private/AIFactoryBaseTransformMatch.h"
#include <cstdlib>
#include <iostream>
#include <limits>
#include <string>
#include <vector>

using AIFactoryBaseTransformMatch::FComponents;
using AIFactoryBaseTransformMatch::Matches;

static void Require(bool Pass, const char* Message)
{
    if (!Pass) { std::cerr << Message << '\n'; std::exit(1); }
}

int main(int ArgCount, char** Args)
{
    // The actual Designer Mk3 rotation that native loading normalized.
    const FComponents Saved{{1200, -2400, 500}, {0, 0, -0.4226182699203491, 0.9063078165054321}, {1, 1, 1}};
    FComponents Observed = Saved;
    Observed.Rotation[2] = -0.42261825717221485;
    Observed.Rotation[3] = 0.9063077891669691;
    Require(Matches(Saved, Observed), "native normalization must preserve orientation identity");
    for (double& V : Observed.Rotation) V = -V;
    Require(Matches(Saved, Observed), "opposite quaternion signs represent the same rotation");
    for (int Axis = 0; Axis < 3; ++Axis)
    {
        FComponents Moved = Observed;
        Moved.Translation[Axis] = std::nextafter(Moved.Translation[Axis], std::numeric_limits<double>::infinity());
        Require(!Matches(Saved, Moved), "one-ULP XYZ changes must still fail");
        Moved = Observed;
        Moved.Scale[Axis] = std::nextafter(Moved.Scale[Axis], std::numeric_limits<double>::infinity());
        Require(!Matches(Saved, Moved), "one-ULP scale changes must still fail");
    }
    FComponents Different = Observed;
    Different.Rotation[2] += 1e-8;
    Require(!Matches(Saved, Different), "a changed orientation must fail despite normalizing both quaternions");
    for (double Invalid : {0.0, 2.0, std::numeric_limits<double>::infinity(), std::numeric_limits<double>::quiet_NaN()})
    {
        Different = Observed;
        for (double& V : Different.Rotation) V = Invalid;
        Require(!Matches(Saved, Different), "invalid/nonunit rotation must fail");
    }
    const FComponents Identity{{0, 0, 0}, {0, 0, 0, 1}, {1, 1, 1}};
    Require(Matches(Identity, Identity), "identity must still match");
    std::cout << "Native transform regression cases passed.\n";
    if (ArgCount == 1) return 0;
    Require(ArgCount == 2 && std::string(Args[1]) == "--replay", "expected --replay or no arguments");

    // Optional private replay: counts, then class-id + XYZ + quaternion + scale
    // for all archive actors and all native-loader rows. No save data is built
    // into the test binary. Require a unique bijection, not merely close pairs.
    int SavedCount = 0, ObservedCount = 0;
    Require(static_cast<bool>(std::cin >> SavedCount >> ObservedCount), "missing replay counts");
    Require(SavedCount > 0 && SavedCount == ObservedCount, "loader actor count differs");
    struct FRow { int Class; FComponents Transform; };
    auto Read = []()
    {
        FRow Row{};
        std::cin >> Row.Class;
        for (double& V : Row.Transform.Translation) std::cin >> V;
        for (double& V : Row.Transform.Rotation) std::cin >> V;
        for (double& V : Row.Transform.Scale) std::cin >> V;
        Require(static_cast<bool>(std::cin), "incomplete replay row");
        return Row;
    };
    std::vector<FRow> Archive;
    std::vector<bool> Used(static_cast<size_t>(SavedCount), false);
    for (int I = 0; I < SavedCount; ++I) Archive.push_back(Read());
    for (int I = 0; I < ObservedCount; ++I)
    {
        const FRow ObservedRow = Read();
        int Match = -1;
        for (int J = 0; J < SavedCount; ++J)
            if (!Used[J] && Archive[J].Class == ObservedRow.Class && Matches(Archive[J].Transform, ObservedRow.Transform))
            {
                Require(Match == -1, "ambiguous native replay identity");
                Match = J;
            }
        Require(Match != -1, "missing native replay identity");
        Used[Match] = true;
    }
    std::cout << "Matched all " << SavedCount << " native loader actors uniquely at exact XYZ and scale.\n";
}
