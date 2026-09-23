#pragma once

namespace AIFactoryBaseResourceBinding
{
    // The current SDK's GetResourceNode() reads only an old-save migration
    // field. A current miner can leave it null while mining normally. Verify
    // the same interface used by production and the authoritative scanner.
    template <typename TExtractor, typename TResource>
    bool Matches(const TExtractor* Extractor, const TResource* Expected)
    {
        if (!Extractor || !Expected) return false;
        const auto Bound = Extractor->GetExtractableResource();
        return Bound.GetObject() == Expected && Bound.GetInterface() != nullptr &&
            (!Expected->CanBecomeOccupied() || Expected->IsOccupied());
    }
}
