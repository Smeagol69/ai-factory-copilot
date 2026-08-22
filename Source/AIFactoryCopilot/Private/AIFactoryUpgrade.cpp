#include "AIFactoryUpgrade.h"

#include "AIFactoryCopilotModule.h"
#include "Buildables/FGBuildable.h"
#include "FGRecipe.h"
#include "FGRecipeManager.h"
#include "Resources/FGBuildingDescriptor.h"

namespace AIFactoryUpgrade
{
bool ParseTier(const FString& BuildableClassName, FString& OutFamily, int32& OutTier)
{
    OutFamily.Reset();
    OutTier = 0;

    // Build_ConveyorBeltMk3_C -> ConveyorBeltMk3
    FString Working = BuildableClassName;
    Working.RemoveFromStart(TEXT("Build_"));
    Working.RemoveFromEnd(TEXT("_C"));

    // Find the trailing MkN. Scanning from the end matters: a name may contain
    // digits elsewhere (Build_Foundation_8x4_C) and only the final Mk marker is
    // the tier.
    int32 MarkerIndex = INDEX_NONE;
    if (!Working.FindLastChar('M', MarkerIndex))
    {
        return false;
    }
    // Walk back through every 'M' until one starts a real MkN suffix.
    while (MarkerIndex != INDEX_NONE)
    {
        const FString Candidate = Working.Mid(MarkerIndex);
        if (Candidate.StartsWith(TEXT("Mk"), ESearchCase::CaseSensitive) && Candidate.Len() > 2)
        {
            const FString Digits = Candidate.Mid(2);
            if (Digits.IsNumeric())
            {
                OutTier = FCString::Atoi(*Digits);
                OutFamily = Working.Left(MarkerIndex);
                // The whole point: vanilla writes ConstructorMk1, the mod writes
                // Constructor_Mk2. Without this they are two families and a Mk1
                // is reported as already maxed.
                while (OutFamily.EndsWith(TEXT("_")))
                {
                    OutFamily.LeftChopInline(1);
                }
                return !OutFamily.IsEmpty() && OutTier > 0;
            }
        }
        if (MarkerIndex == 0)
        {
            break;
        }
        const FString Head = Working.Left(MarkerIndex);
        int32 NextIndex = INDEX_NONE;
        if (!Head.FindLastChar('M', NextIndex))
        {
            break;
        }
        MarkerIndex = NextIndex;
    }
    return false;
}

namespace
{
    /**
     * family name -> the highest unlocked tier in it.
     *
     * Built once. The previous version walked all available recipes and all
     * their products for *every* buildable asked about -- with 248 unlocked
     * recipes and a 3,859-building selection that is around a million
     * iterations per Upgrade click, recomputing one answer over and over.
     */
    TMap<FString, FUpgradeTarget> CachedFamilyTop;
    int32 CachedRecipeCount = -1;

    /**
     * The available-recipe count is a sufficient cache key: recipes are only
     * ever added, never removed, so unlocking Miner Mk.4 changes the count and
     * the map rebuilds. It cannot go stale in the direction that matters.
     */
    const TMap<FString, FUpgradeTarget>& FamilyTopMap(AFGRecipeManager* Recipes)
    {
        const TArray<TSubclassOf<UFGRecipe>>& Available = Recipes->GetAllAvailableRecipes();
        if (Available.Num() == CachedRecipeCount)
        {
            return CachedFamilyTop;
        }

        CachedFamilyTop.Reset();
        for (const TSubclassOf<UFGRecipe>& Recipe : Available)
        {
            if (!IsValid(Recipe))
            {
                continue;
            }
            for (const FItemAmount& Product : UFGRecipe::GetProducts(Recipe))
            {
                // TSubclassOf's constructor does not verify the hierarchy, so a
                // straight cast would hand a non-building descriptor to
                // GetBuildableClass and read whatever overlapped.
                UClass* const ProductClass = Product.ItemClass.Get();
                if (ProductClass == nullptr ||
                    !ProductClass->IsChildOf(UFGBuildingDescriptor::StaticClass()))
                {
                    continue;
                }
                const TSubclassOf<UFGBuildingDescriptor> Building(ProductClass);
                const TSubclassOf<AFGBuildable> Candidate =
                    UFGBuildingDescriptor::GetBuildableClass(Building);
                if (!IsValid(Candidate))
                {
                    continue;
                }

                FString Family;
                int32 Tier = 0;
                if (!ParseTier(Candidate->GetName(), Family, Tier))
                {
                    continue;
                }

                FUpgradeTarget& Top = CachedFamilyTop.FindOrAdd(Family);
                if (Tier > Top.Tier)
                {
                    Top.BuildableClass = Candidate;
                    Top.Recipe = Recipe;
                    Top.Tier = Tier;
                }
            }
        }

        CachedRecipeCount = Available.Num();
        UE_LOG(LogAIFactoryCopilot, Verbose,
            TEXT("Upgrade: cached %d tiered families from %d recipes"),
            CachedFamilyTop.Num(), CachedRecipeCount);
        return CachedFamilyTop;
    }
}

FUpgradeTarget FindMaxTier(UWorld* World, TSubclassOf<AFGBuildable> BuildableClass)
{
    FUpgradeTarget Target;
    if (!IsValid(World) || !IsValid(BuildableClass))
    {
        return Target;
    }

    FString Family;
    int32 CurrentTier = 0;
    if (!ParseTier(BuildableClass->GetName(), Family, CurrentTier))
    {
        // Untiered. Not a failure -- most of a base is foundations.
        return Target;
    }

    AFGRecipeManager* Recipes = AFGRecipeManager::Get(World);
    if (!IsValid(Recipes))
    {
        return Target;
    }

    const FUpgradeTarget* Top = FamilyTopMap(Recipes).Find(Family);
    if (Top == nullptr || Top->Tier <= CurrentTier)
    {
        // Already at the top of its family, which is the common case.
        return Target;
    }
    return *Top;
}
}
