#include "AIFactoryCopilotModule.h"

#include "AIFactoryCreativeResourceNode.h"
#include "AIFactoryCopilotUISubsystem.h"
#include "Buildables/FGBuildableResourceExtractorBase.h"
#include "Engine/GameInstance.h"
#include "Equipment/FGBuildGunBuild.h"
#include "Patching/NativeHookManager.h"
#include "Resources/FGExtractableResourceInterface.h"
#include "UObject/UnrealType.h"

DEFINE_LOG_CATEGORY(LogAIFactoryCopilot);

namespace
{
    UAIFactoryCopilotUISubsystem* AIFactoryGetPrecisionFrameUI(
        UFGBuildGunStateBuild* const BuildState)
    {
        if (!IsInGameThread() || !IsValid(BuildState))
        {
            return nullptr;
        }

        UWorld* const World = BuildState->GetWorld();
        UGameInstance* const GameInstance = IsValid(World) ? World->GetGameInstance() : nullptr;
        return IsValid(GameInstance)
            ? GameInstance->GetSubsystem<UAIFactoryCopilotUISubsystem>()
            : nullptr;
    }
}

void FAIFactoryCopilotModule::StartupModule()
{
#if WITH_EDITOR
    // The Starter Project intentionally ships empty generated Editor bodies
    // for FactoryGame implementation methods. IsAllowedOnResource is therefore
    // only a few bytes in FactoryEditor and cannot be detoured by funchook.
    // The installed game's Shipping DLL contains the real implementation this
    // compatibility layer targets. Skipping the hook here also lets the cook
    // commandlet load the mod without touching a meaningless stub.
    UE_LOG(LogAIFactoryCopilot, Display,
        TEXT("AI Factory Copilot module loaded; Creative Miner compatibility is Shipping-only"));
#else
    mCreativeNodeExtractorCompatibilityHook = SUBSCRIBE_METHOD(
        AFGBuildableResourceExtractorBase::IsAllowedOnResource,
        [](auto& Scope,
           const AFGBuildableResourceExtractorBase* const Extractor,
           const TScriptInterface<IFGExtractableResourceInterface>& Resource)
        {
            // FactoryGame executes hologram placement on the game thread. The
            // compatibility shim temporarily changes one reflected field on
            // the extractor default object, so never widen it to another
            // thread even if a third-party caller invokes the method there.
            if (!IsInGameThread() || !IsValid(Extractor))
            {
                return;
            }

            AAIFactoryCreativeOrdinaryResourceNode* const CreativeNode =
                Cast<AAIFactoryCreativeOrdinaryResourceNode>(Resource.GetObject());
            if (!IsValid(CreativeNode))
            {
                // Vanilla nodes, special mod templates, geysers, and every
                // other extractable resource take FactoryGame's untouched
                // path through this hook.
                return;
            }

            // The ordinary-node override validates its saved configuration,
            // resource descriptor, purity, node type, remaining resource, and
            // the base extractor flag before returning true.
            if (!CreativeNode->CanPlaceResourceExtractor())
            {
                return;
            }

            // CL 502094's Miner CDOs restrict ordinary extraction to the
            // Blueprint-generated BP_ResourceNode_C class. A native mod class
            // cannot inherit a Blueprint class, even though it implements the
            // complete AFGResourceNode contract. Remove only that ancestry
            // predicate for the duration of the original native call.
            FClassProperty* const RestrictionProperty =
                FindFProperty<FClassProperty>(
                    AFGBuildableResourceExtractorBase::StaticClass(),
                    TEXT("mRestrictToNodeType"));
            if (RestrictionProperty == nullptr)
            {
                static bool bLoggedMissingRestrictionProperty = false;
                if (!bLoggedMissingRestrictionProperty)
                {
                    bLoggedMissingRestrictionProperty = true;
                    UE_LOG(LogAIFactoryCopilot, Error,
                        TEXT("Creative Miner compatibility is unavailable: ")
                        TEXT("FactoryGame no longer reflects mRestrictToNodeType"));
                }
                return;
            }

            UObject* const PreviousRestriction =
                RestrictionProperty->GetObjectPropertyValue_InContainer(Extractor);
            UClass* const RequiredNodeClass = Cast<UClass>(PreviousRestriction);
            if (!IsValid(RequiredNodeClass) || CreativeNode->IsA(RequiredNodeClass))
            {
                // No restriction, or a future game/mod extractor already
                // recognises this class: use the original path unchanged.
                return;
            }

            AFGBuildableResourceExtractorBase* const MutableExtractor =
                const_cast<AFGBuildableResourceExtractorBase*>(Extractor);
            RestrictionProperty->SetObjectPropertyValue_InContainer(
                MutableExtractor, nullptr);

            // This is the important boundary: FactoryGame still checks the
            // extractor's allowed resource forms, explicit resource allowlist,
            // and any other native rule. We keep only the result of that exact
            // call and immediately restore the original class restriction.
            const bool bAllowedByRemainingNativeChecks = Scope(Extractor, Resource);
            RestrictionProperty->SetObjectPropertyValue_InContainer(
                MutableExtractor, PreviousRestriction);
            Scope.Override(bAllowedByRemainingNativeChecks);
        });

    // Rotation has to be written before FactoryGame derives the actor transform
    // from mScrollRotation. Position follows the native update so the game's
    // own locked-hologram/nudge state is what PrimaryFire serializes.
    mPrecisionFrameBeforeBuildTickHook = SUBSCRIBE_METHOD(
        UFGBuildGunStateBuild::TickState_Implementation,
        [](auto& Scope,
           UFGBuildGunStateBuild* const BuildState,
           const float DeltaTime)
        {
            if (UAIFactoryCopilotUISubsystem* const UI =
                    AIFactoryGetPrecisionFrameUI(BuildState))
            {
                UI->ApplyPrecisionFrameToBuildState(BuildState, true);
            }
        });

    mPrecisionFrameAfterBuildTickHook = SUBSCRIBE_METHOD_AFTER(
        UFGBuildGunStateBuild::TickState_Implementation,
        [](UFGBuildGunStateBuild* const BuildState, const float DeltaTime)
        {
            if (UAIFactoryCopilotUISubsystem* const UI =
                    AIFactoryGetPrecisionFrameUI(BuildState))
            {
                UI->ApplyPrecisionFrameToBuildState(BuildState, false);
            }
        });

    UE_LOG(LogAIFactoryCopilot, Display,
        TEXT("AI Factory Copilot module loaded; Creative Miner compatibility and precision frame installed"));
#endif
}

void FAIFactoryCopilotModule::ShutdownModule()
{
#if !WITH_EDITOR
    if (mPrecisionFrameBeforeBuildTickHook.IsValid())
    {
        UNSUBSCRIBE_METHOD(
            UFGBuildGunStateBuild::TickState_Implementation,
            mPrecisionFrameBeforeBuildTickHook);
        mPrecisionFrameBeforeBuildTickHook.Reset();
    }
    if (mPrecisionFrameAfterBuildTickHook.IsValid())
    {
        UNSUBSCRIBE_METHOD(
            UFGBuildGunStateBuild::TickState_Implementation,
            mPrecisionFrameAfterBuildTickHook);
        mPrecisionFrameAfterBuildTickHook.Reset();
    }
    if (mCreativeNodeExtractorCompatibilityHook.IsValid())
    {
        UNSUBSCRIBE_METHOD(
            AFGBuildableResourceExtractorBase::IsAllowedOnResource,
            mCreativeNodeExtractorCompatibilityHook);
        mCreativeNodeExtractorCompatibilityHook.Reset();
    }
#endif
    UE_LOG(LogAIFactoryCopilot, Display, TEXT("AI Factory Copilot module unloaded"));
}

IMPLEMENT_GAME_MODULE(FAIFactoryCopilotModule, AIFactoryCopilot);
