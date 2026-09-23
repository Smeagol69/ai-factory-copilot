#include "../../Source/AIFactoryCopilot/Private/AIFactoryBaseResourceBinding.h"
#include <cstdlib>
#include <iostream>

struct FResource
{
    bool Exclusive = true;
    bool Occupied = true;
    bool CanBecomeOccupied() const { return Exclusive; }
    bool IsOccupied() const { return Occupied; }
};
struct FInterface
{
    FResource* Object;
    bool Implemented = true;
    FResource* GetObject() const { return Object; }
    FResource* GetInterface() const { return Implemented ? Object : nullptr; }
};
struct FExtractor
{
    FInterface Current;
    FResource* Legacy = nullptr;
    FInterface GetExtractableResource() const { return Current; }
    FResource* GetResourceNode() const { return Legacy; }
};
static void Require(bool Pass, const char* Message)
{
    if (!Pass) { std::cerr << Message << '\n'; std::exit(1); }
}
int main()
{
    using AIFactoryBaseResourceBinding::Matches;
    FResource Expected, Other;
    FExtractor Miner{{&Expected}, nullptr};
    Require(Matches(&Miner, &Expected), "current miner must pass with an empty old-save field");
    Miner.Legacy = &Other;
    Require(Matches(&Miner, &Expected), "old-save state cannot override a valid current binding");
    Miner.Current.Object = &Other;
    Miner.Legacy = &Expected;
    Require(!Matches(&Miner, &Expected), "legacy match cannot hide a wrong current node");
    Miner.Current.Object = nullptr;
    Require(!Matches(&Miner, &Expected), "unbound current miner must fail");
    Miner.Current = {&Expected, false};
    Require(!Matches(&Miner, &Expected), "a matching object without its extractable interface must fail");
    Miner.Current.Implemented = true;
    Expected.Occupied = false;
    Require(!Matches(&Miner, &Expected), "an exclusive node must be claimed");
    Expected.Exclusive = false;
    Require(Matches(&Miner, &Expected), "shared resources do not require exclusive occupancy");
    Require(!Matches(static_cast<FExtractor*>(nullptr), &Expected), "missing extractor must fail");
    Require(!Matches(&Miner, static_cast<FResource*>(nullptr)), "missing node must fail");
    std::cout << "Native current-resource binding regression cases passed.\n";
}
