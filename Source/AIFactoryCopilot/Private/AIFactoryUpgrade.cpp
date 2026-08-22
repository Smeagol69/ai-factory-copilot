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
        // Untiered building. Not a failure -- most of a base is foundations.
        return Target;
    }

    AFGRecipeManager* Recipes = AFGRecipeManager::Get(World);
    if (!IsValid(Recipes))
    {
        return Target;
    }

    int32 BestTier = CurrentTier;
    for (const TSubclassOf<UFGRecipe>& Recipe : Recipes->GetAllAvailableRecipes())
    {
        if (!IsValid(Recipe))
        {
            continue;
        }
        for (const FItemAmount& Product : UFGRecipe::GetProducts(Recipe))
        {
            // Only building descriptors resolve to a buildable class, which is
            // what keeps items out of this entirely. Desc_GunpowderMk2_C is a
            // tiered *item*, and a name-driven search would have tried to
            // upgrade gunpowder.
            // TSubclassOf's constructor does not verify the hierarchy: casting
            // straight from the product would hand a non-building descriptor to
            // GetBuildableClass and read whatever mBuildableClass happened to
            // overlap. Check the class relationship explicitly.
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

            FString CandidateFamily;
            int32 CandidateTier = 0;
            if (!ParseTier(Candidate->GetName(), CandidateFamily, CandidateTier))
            {
                continue;
            }
            if (CandidateFamily != Family || CandidateTier <= BestTier)
            {
                continue;
            }

            BestTier = CandidateTier;
            Target.BuildableClass = Candidate;
            Target.Recipe = Recipe;
            Target.Tier = CandidateTier;
        }
    }

    if (Target.IsValid())
    {
        UE_LOG(LogAIFactoryCopilot, Verbose,
            TEXT("Upgrade: %s (Mk%d) -> %s (Mk%d)"),
            *BuildableClass->GetName(), CurrentTier,
            *Target.BuildableClass->GetName(), Target.Tier);
    }
    return Target;
}
}
