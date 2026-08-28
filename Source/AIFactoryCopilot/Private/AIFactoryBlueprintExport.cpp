#include "AIFactoryBlueprintExport.h"

#include "AIFactoryActions.h"
#include "Buildables/FGBuildable.h"
#include "Buildables/FGBuildableBlueprintDesigner.h"
#include "FGBlueprintSubsystem.h"
#include "FGCharacterPlayer.h"
#include "FGClearanceInterface.h"
#include "FGFactoryBlueprintTypes.h"
#include "FGPlayerController.h"
#include "Buildables/FGBuildableConveyorBase.h"
#include "Buildables/FGBuildableConveyorBelt.h"
#include "Buildables/FGBuildableConveyorAttachment.h"
#include "Buildables/FGBuildableManufacturer.h"
#include "Buildables/FGBuildablePipeBase.h"
#include "Buildables/FGBuildablePipeline.h"
#include "Buildables/FGBuildablePipelineAttachment.h"
#include "Buildables/FGBuildablePowerPole.h"
#include "Buildables/FGBuildableResourceExtractorBase.h"
#include "Buildables/FGBuildableWire.h"
#include "FGCircuitConnectionComponent.h"
#include "FGFactoryConnectionComponent.h"
#include "FGPipeConnectionComponent.h"
#include "FGBuildableSubsystem.h"
#include "FGLightweightBuildableSubsystem.h"
#include "FGRecipe.h"
#include "FGRecipeManager.h"
#include "Hologram/FGPipelineHologram.h"
#include "Resources/FGBuildDescriptor.h"
#include "Resources/FGBuildingDescriptor.h"
#include "UObject/UnrealType.h"
#include "UObject/UObjectIterator.h"
#include "EngineUtils.h"

/**
 * Writing a real `.sbp` from buildings that are standing in the world.
 *
 * The owner's ask is a mega blueprint: mark a whole base with the dismantle
 * tool and get one native blueprint, no size cap, extractors included, placed
 * afterwards with the game's own Build Gun. The Blueprint Designer normally
 * caps that at its own box and cannot hold a miner, because there is no ore
 * inside it to satisfy FGCDNeedsResourceNode.
 *
 * None of that is a rule about blueprints. Verified against the CL 502094
 * headers: AFGBlueprintHologram validates nothing on placement, AFGBuildable
 * has no per-buildable "can be blueprinted" flag, and extractors do not opt
 * out. The restrictions live in what you can *build inside the designer box*,
 * not in what an archive may contain.
 *
 * So this does not fight the designer. It tells one what it already has a
 * public method for being told:
 *
 *   AFGBuildableBlueprintDesigner::OnBuildableConstructedInsideDesigner()
 *     "When a buildable is constructed it informs the designer of its
 *      existence. This way we don't need to gather them to serialize."
 *
 * Then SaveBlueprint runs the game's own serialiser over that list. Three
 * public calls, no reflection, no private access.
 *
 * ---------------------------------------------------------------------------
 * THE HAZARD, AND WHY THE UNWIND IS THE MAIN EVENT
 *
 * `SetInsideBlueprintDesigner` marks a *live factory building* as belonging to
 * a designer. That is a lie told briefly for the serialiser's benefit, and if
 * it outlives this function the player's base is damaged: a designer that
 * believes it owns half a megabase will offer to dismantle it, and
 * `mReplicatedBuiltInsideBlueprintDesigner` is saved with the world.
 *
 * Every marked buildable is therefore unwound by a guard whose destructor runs
 * on every path out of here -- success, refusal, early return, or an exception
 * from inside the engine. Nothing about this function is allowed to be
 * conditional on reaching the end of it.
 */

namespace
{
    /**
     * Marks buildables as inside a designer and guarantees they are unmarked.
     *
     * Destructor-based rather than a tidy-up call at the end, because there are
     * five ways out of the export below and a forgotten one corrupts a save.
     */
    class FScopedDesignerMembership
    {
    public:
        FScopedDesignerMembership(AFGBuildableBlueprintDesigner* InDesigner)
            : Designer(InDesigner)
        {
        }

        /** Returns false if the buildable could not be adopted; nothing is marked in that case. */
        bool Adopt(AFGBuildable* Buildable)
        {
            if (!IsValid(Buildable) || !IsValid(Designer))
            {
                return false;
            }
            // Something already inside a designer is either a genuine designer
            // building or the result of an earlier export that did not unwind.
            // Either way it is not ours to move, and taking it would mean
            // handing it back to the wrong owner.
            if (Buildable->IsBuildableInsideBlueprintDesigner())
            {
                return false;
            }

            // `SetInsideBlueprintDesigner` is NOT called here, and must not be.
            //
            // It crashed the game on the first live attempt:
            //
            //   AFGBuildable::SetInsideBlueprintDesigner() FGBuildable.cpp:1131
            //   AIFactoryBlueprintExport::ExportSelection() line 208
            //
            // A check() inside it fires for a buildable that is already alive.
            // It is a construction-time API, the same as its sibling
            // SetBlueprintBuildEffectID which documents "Must be called before
            // BeginPlay". The comment on OnBuildableConstructedInsideDesigner
            // -- "when a buildable is constructed it informs the designer" --
            // describes when the game calls it, and I read it as an invitation
            // to call it later. It is not one.
            //
            // Dropping it also removes the worse hazard: mBlueprintDesigner is
            // UPROPERTY(SaveGame), so a marking that outlived the export would
            // have followed the player's factory into their save file
            // permanently. Nothing here writes a persisted field on a
            // buildable any more.
            //
            // What remains is the designer's own list, which is what
            // SaveBlueprint iterates. Whether that alone is enough is the open
            // question; if the designer also requires the back-reference, this
            // route is finished and the archive must be written directly with
            // FBlueprintArchiveObjectDataProxy instead.
            Designer->OnBuildableConstructedInsideDesigner(Buildable);
            Adopted.Add(Buildable);
            return true;
        }

        /**
         * Adopt a buildable this export spawned a moment ago.
         *
         * Adopt() refuses anything already marked as inside a designer,
         * which is right for factory buildings -- taking one would mean
         * handing it back to the wrong owner. Instances materialised by
         * FScopedMaterialisedInstances are marked at construction and would
         * trip that guard, but they are ours: spawned in this call, owned by
         * this designer, destroyed before this function returns.
         */
        bool AdoptOwned(AFGBuildable* Buildable)
        {
            if (!IsValid(Buildable) || !IsValid(Designer))
            {
                return false;
            }
            Designer->OnBuildableConstructedInsideDesigner(Buildable);
            Adopted.Add(Buildable);
            return true;
        }

        int32 Num() const { return Adopted.Num(); }

        ~FScopedDesignerMembership()
        {
            for (int32 Index = Adopted.Num() - 1; Index >= 0; --Index)
            {
                AFGBuildable* Buildable = Adopted[Index].Get();
                if (!IsValid(Buildable))
                {
                    continue;
                }
                if (IsValid(Designer))
                {
                    Designer->OnBuildableDismantledInsideDesigner(Buildable);
                }
                // No SetInsideBlueprintDesigner(nullptr) counterpart, because
                // nothing set it. See Adopt().
            }
            Adopted.Reset();
        }

    private:
        AFGBuildableBlueprintDesigner* Designer = nullptr;
        TArray<TWeakObjectPtr<AFGBuildable>> Adopted;
    };

    /**
     * Real buildables spawned from lightweight instance data, alive only for
     * the length of one export.
     *
     * Foundations and walls are not actors. The measured proof: an archive
     * exported from a whole glass-and-steel building contained 1395
     * Build_PowerPoleWall_C and zero Build_Foundation_*, while a hand-made
     * blueprint of comparable size contained 34 foundations and 114 walls.
     * Everything that survived was exactly the set that never converts to
     * lightweight. The placed copy was the wiring without the shell.
     *
     * The previous attempt armed the game's own instance converter and waited
     * for the actor count to settle. It produced nothing measurable, and the
     * settle test could not distinguish a converter that had not started from
     * one that had finished, so it fired 0.8s after arming every time. This
     * spawns the pieces directly instead: synchronous, exactly as many as were
     * asked for, and done by the time the next line runs.
     *
     * SetInsideBlueprintDesigner is called here -- the same call whose check()
     * killed the game earlier in this project. Deferred spawning is the one
     * window where it is legal: the assert demands it happen before BeginPlay,
     * and between SpawnActor(bDeferConstruction) and FinishSpawning is exactly
     * that. Marking them at construction also makes them exempt from
     * ShouldConvertToLightweight, so they cannot dissolve back into instance
     * data half way through SaveBlueprint.
     *
     * RF_Transient and destroyed on unwind on every path, because
     * mBlueprintDesigner is UPROPERTY(SaveGame) and one of these outliving the
     * export would follow the player's factory into their save file.
     */
    class FScopedMaterialisedInstances
    {
    public:
        FScopedMaterialisedInstances(
            UWorld* InWorld,
            AFGBuildableBlueprintDesigner* InDesigner,
            const TArray<FLightweightBuildableInstanceRef>& Instances)
        {
            if (Instances.Num() == 0)
            {
                return;
            }
            if (!IsValid(InWorld) || !IsValid(InDesigner))
            {
                Missing = Instances.Num();
                return;
            }

            for (const FLightweightBuildableInstanceRef& Instance : Instances)
            {
                const FRuntimeBuildableInstanceData* Data =
                    Instance.ResolveBuildableInstanceData();
                const TSubclassOf<AFGBuildable> BuildableClass = Instance.GetBuildableClass();
                if (Data == nullptr || !IsValid(BuildableClass))
                {
                    // The preview and the export are separate frames. The
                    // stable ref checks the cached identity/transform before
                    // it lets us materialise anything, so an index that was
                    // reused for another lightweight cannot be exported.
                    ++Missing;
                    continue;
                }

                FActorSpawnParameters Params;
                Params.SpawnCollisionHandlingOverride =
                    ESpawnActorCollisionHandlingMethod::AlwaysSpawn;
                Params.bDeferConstruction = true;
                Params.ObjectFlags |= RF_Transient;

                AFGBuildable* Buildable =
                    InWorld->SpawnActor<AFGBuildable>(BuildableClass, Data->Transform, Params);
                if (!IsValid(Buildable))
                {
                    ++Missing;
                    continue;
                }

                // Before BeginPlay. This is the only legal window; see above.
                Buildable->SetInsideBlueprintDesigner(InDesigner);
                Buildable->SetBuiltWithRecipe(Data->BuiltWithRecipe);
                Buildable->FinishSpawning(Data->Transform);

                if (!IsValid(Buildable))
                {
                    ++Missing;
                    continue;
                }
                // After FinishSpawning: this one touches components, which do
                // not exist until the actor is fully constructed.
                Buildable->SetCustomizationData_Native(Data->CustomizationData);
                Spawned.Add(Buildable);
            }
        }

        ~FScopedMaterialisedInstances()
        {
            for (int32 Index = Spawned.Num() - 1; Index >= 0; --Index)
            {
                AFGBuildable* Buildable = Spawned[Index];
                if (IsValid(Buildable))
                {
                    // Materialised pieces are structural and so never chained,
                    // but the guard is one cast and the failure it prevents is a
                    // chain ticking a dead pointer.
                    if (AFGBuildableConveyorBase* Conveyor =
                            Cast<AFGBuildableConveyorBase>(Buildable))
                    {
                        if (AFGBuildableSubsystem* Buildables =
                                AFGBuildableSubsystem::Get(Buildable->GetWorld()))
                        {
                            Buildables->RemoveConveyor(Conveyor);
                        }
                    }
                    Buildable->Destroy();
                }
            }
            Spawned.Reset();
        }

        const TArray<AFGBuildable*>& Get() const { return Spawned; }
        int32 Num() const { return Spawned.Num(); }
        int32 NumMissing() const { return Missing; }

    private:
        TArray<AFGBuildable*> Spawned;
        int32 Missing = 0;
    };

    /** Any Blueprint Designer standing in the world. The player must own one. */
    AFGBuildableBlueprintDesigner* FindAnyDesigner(UWorld* World)
    {
        if (!IsValid(World))
        {
            return nullptr;
        }
        for (TActorIterator<AFGBuildableBlueprintDesigner> It(World); It; ++It)
        {
            if (IsValid(*It))
            {
                return *It;
            }
        }
        return nullptr;
    }

    UClass* FindGeneratedClassByPath(const FString& ClassPath)
    {
        if (ClassPath.IsEmpty())
        {
            return nullptr;
        }
        if (UClass* Direct = FindObject<UClass>(nullptr, *ClassPath))
        {
            return Direct;
        }
        if (UClass* Loaded = LoadObject<UClass>(nullptr, *ClassPath))
        {
            return Loaded;
        }
        for (TObjectIterator<UClass> It; It; ++It)
        {
            if (It->GetName() == ClassPath || It->GetPathName() == ClassPath)
            {
                return *It;
            }
        }
        return nullptr;
    }

    struct FResolvedGeneratedPart
    {
        FAIFactoryGeneratedBlueprintPart Source;
        TSubclassOf<UFGRecipe> BuildRecipe;
        TSubclassOf<UFGRecipe> ProductionRecipe;
        TSubclassOf<AFGBuildable> BuildableClass;
    };

    bool ResolveGeneratedPart(
        const FAIFactoryGeneratedBlueprintPart& Part,
        UWorld* World,
        FResolvedGeneratedPart& Out,
        FString& OutReason)
    {
        if (Part.PartId.TrimStartAndEnd().IsEmpty())
        {
            OutReason = TEXT("generated_part_id_is_required");
            return false;
        }
        if (Part.Role != TEXT("floor") && Part.Role != TEXT("pillar") &&
            Part.Role != TEXT("wall") && Part.Role != TEXT("roof") &&
            Part.Role != TEXT("ramp") && Part.Role != TEXT("machine") &&
            Part.Role != TEXT("standalone"))
        {
            OutReason = TEXT("generated_part_role_is_unsupported:") + Part.PartId;
            return false;
        }
        if (Part.RelativeTransform.ContainsNaN())
        {
            OutReason = TEXT("generated_part_transform_is_not_finite:") + Part.PartId;
            return false;
        }

        UClass* RecipeObject = FindGeneratedClassByPath(Part.BuildRecipeClassPath);
        if (!RecipeObject || !RecipeObject->IsChildOf(UFGRecipe::StaticClass()))
        {
            OutReason = TEXT("generated_build_recipe_not_found:") + Part.BuildRecipeClassPath;
            return false;
        }
        const TSubclassOf<UFGRecipe> BuildRecipe = RecipeObject;

        TSubclassOf<AFGBuildable> BuildableClass = nullptr;
        for (const FItemAmount& Product : UFGRecipe::GetProducts(BuildRecipe))
        {
            if (Product.ItemClass &&
                Product.ItemClass->IsChildOf(UFGBuildingDescriptor::StaticClass()))
            {
                const TSubclassOf<UFGBuildingDescriptor> Descriptor{ Product.ItemClass.Get() };
                BuildableClass = UFGBuildingDescriptor::GetBuildableClass(Descriptor);
                break;
            }
        }
        if (!BuildableClass)
        {
            OutReason = TEXT("generated_recipe_is_not_a_build_recipe:") + Part.BuildRecipeClassPath;
            return false;
        }
        if (BuildableClass->HasAnyClassFlags(CLASS_Abstract))
        {
            OutReason = TEXT("generated_buildable_class_is_abstract:") + BuildableClass->GetPathName();
            return false;
        }

        // These classes need topology or a native placement target, not just a
        // transform. Serialising an unconnected spline, wire, attachment, or
        // extractor would create a file that looks populated but cannot work.
        if (BuildableClass->IsChildOf(AFGBuildableConveyorBase::StaticClass()) ||
            BuildableClass->IsChildOf(AFGBuildableConveyorAttachment::StaticClass()) ||
            BuildableClass->IsChildOf(AFGBuildablePipeBase::StaticClass()) ||
            BuildableClass->IsChildOf(AFGBuildablePipelineAttachment::StaticClass()) ||
            BuildableClass->IsChildOf(AFGBuildableWire::StaticClass()) ||
            BuildableClass->IsChildOf(AFGBuildableResourceExtractorBase::StaticClass()))
        {
            OutReason = TEXT("generated_buildable_needs_an_unimplemented_native_topology:") +
                BuildableClass->GetPathName();
            return false;
        }

        AFGRecipeManager* RecipeManager = AFGRecipeManager::Get(World);
        if (!IsValid(RecipeManager))
        {
            OutReason = TEXT("no_recipe_manager");
            return false;
        }
        if (!RecipeManager->IsRecipeAvailable(BuildRecipe))
        {
            OutReason = TEXT("generated_build_recipe_is_not_unlocked:") +
                RecipeObject->GetPathName();
            return false;
        }
        if (!RecipeManager->IsBuildingAvailable(BuildableClass))
        {
            OutReason = TEXT("generated_building_is_not_unlocked:") +
                BuildableClass->GetPathName();
            return false;
        }

        TSubclassOf<UFGRecipe> ProductionRecipe = nullptr;
        if (!Part.ProductionRecipeClassPath.IsEmpty())
        {
            UClass* ProductionObject = FindGeneratedClassByPath(Part.ProductionRecipeClassPath);
            if (!ProductionObject || !ProductionObject->IsChildOf(UFGRecipe::StaticClass()))
            {
                OutReason = TEXT("generated_production_recipe_not_found:") +
                    Part.ProductionRecipeClassPath;
                return false;
            }
            ProductionRecipe = ProductionObject;
            if (!RecipeManager->IsRecipeAvailable(ProductionRecipe))
            {
                OutReason = TEXT("generated_production_recipe_is_not_unlocked:") +
                    ProductionObject->GetPathName();
                return false;
            }
            if (!UFGRecipe::IsProducedIn(ProductionRecipe, BuildableClass))
            {
                OutReason = TEXT("generated_production_recipe_is_not_compatible:") +
                    ProductionObject->GetPathName();
                return false;
            }
        }

        Out.Source = Part;
        Out.BuildRecipe = BuildRecipe;
        Out.ProductionRecipe = ProductionRecipe;
        Out.BuildableClass = BuildableClass;
        return true;
    }

    struct FStagedGeneratedPart
    {
        FResolvedGeneratedPart Resolved;
        AFGBuildable* Buildable = nullptr;
        FBox CollisionBounds = FBox(ForceInit);
        FString BoundsSource;
    };

    bool ResolveGeneratedTopologyRecipe(
        const FString& RecipeClassPath,
        UWorld* World,
        UClass* RequiredBuildableBase,
        TSubclassOf<UFGRecipe>& OutRecipe,
        TSubclassOf<AFGBuildable>& OutBuildableClass,
        FString& OutReason)
    {
        UClass* RecipeObject = FindGeneratedClassByPath(RecipeClassPath);
        if (!RecipeObject || !RecipeObject->IsChildOf(UFGRecipe::StaticClass()))
        {
            OutReason = TEXT("generated_topology_recipe_not_found:") + RecipeClassPath;
            return false;
        }
        const TSubclassOf<UFGRecipe> Recipe = RecipeObject;

        TSubclassOf<AFGBuildable> BuildableClass = nullptr;
        for (const FItemAmount& Product : UFGRecipe::GetProducts(Recipe))
        {
            if (Product.ItemClass &&
                Product.ItemClass->IsChildOf(UFGBuildingDescriptor::StaticClass()))
            {
                const TSubclassOf<UFGBuildingDescriptor> Descriptor{Product.ItemClass.Get()};
                BuildableClass = UFGBuildingDescriptor::GetBuildableClass(Descriptor);
                break;
            }
        }
        if (!BuildableClass || !BuildableClass->IsChildOf(RequiredBuildableBase) ||
            BuildableClass->HasAnyClassFlags(CLASS_Abstract))
        {
            OutReason = TEXT("generated_topology_recipe_has_wrong_buildable_type:") +
                RecipeClassPath;
            return false;
        }

        AFGRecipeManager* RecipeManager = AFGRecipeManager::Get(World);
        if (!IsValid(RecipeManager))
        {
            OutReason = TEXT("no_recipe_manager");
            return false;
        }
        if (!RecipeManager->IsRecipeAvailable(Recipe))
        {
            OutReason = TEXT("generated_topology_recipe_is_not_unlocked:") +
                RecipeObject->GetPathName();
            return false;
        }
        if (!RecipeManager->IsBuildingAvailable(BuildableClass))
        {
            OutReason = TEXT("generated_topology_building_is_not_unlocked:") +
                BuildableClass->GetPathName();
            return false;
        }

        OutRecipe = Recipe;
        OutBuildableClass = BuildableClass;
        return true;
    }

    UFGFactoryConnectionComponent* ResolveGeneratedFactoryConnection(
        AFGBuildable* Buildable,
        const FString& ExplicitName,
        const EFactoryConnectionDirection Wanted,
        FString& OutReason)
    {
        if (!IsValid(Buildable))
        {
            OutReason = TEXT("generated_conveyor_endpoint_buildable_is_invalid");
            return nullptr;
        }

        TInlineComponentArray<UFGFactoryConnectionComponent*> Components;
        Buildable->GetComponents(Components);
        TArray<UFGFactoryConnectionComponent*> Candidates;
        for (UFGFactoryConnectionComponent* Component : Components)
        {
            if (!IsValid(Component) || Component->IsConnected())
            {
                continue;
            }
            const EFactoryConnectionDirection Direction = Component->GetDirection();
            if (Direction != Wanted && Direction != EFactoryConnectionDirection::FCD_ANY)
            {
                continue;
            }
            if (!ExplicitName.IsEmpty() &&
                Component->GetName() != ExplicitName &&
                !Component->GetPathName().EndsWith(TEXT(".") + ExplicitName))
            {
                continue;
            }
            Candidates.Add(Component);
        }
        if (Candidates.Num() != 1)
        {
            OutReason = FString::Printf(
                TEXT("generated_conveyor_endpoint_requires_exactly_one_free_matching_connector:%s:candidates=%d"),
                *Buildable->GetName(),
                Candidates.Num());
            return nullptr;
        }
        return Candidates[0];
    }

    UFGCircuitConnectionComponent* ResolveGeneratedCircuitConnection(
        AFGBuildable* Buildable,
        const FString& ExplicitName,
        FString& OutReason)
    {
        if (!IsValid(Buildable))
        {
            OutReason = TEXT("generated_power_endpoint_buildable_is_invalid");
            return nullptr;
        }

        TInlineComponentArray<UFGCircuitConnectionComponent*> Components;
        Buildable->GetComponents(Components);
        TArray<UFGCircuitConnectionComponent*> Candidates;
        for (UFGCircuitConnectionComponent* Component : Components)
        {
            if (!IsValid(Component) || Component->IsHidden() ||
                Component->GetNumFreeConnections() <= 0)
            {
                continue;
            }
            if (!ExplicitName.IsEmpty() &&
                Component->GetName() != ExplicitName &&
                !Component->GetPathName().EndsWith(TEXT(".") + ExplicitName))
            {
                continue;
            }
            Candidates.Add(Component);
        }
        if (Candidates.Num() != 1)
        {
            OutReason = FString::Printf(
                TEXT("generated_power_endpoint_requires_exactly_one_free_matching_connector:%s:candidates=%d"),
                *Buildable->GetName(),
                Candidates.Num());
            return nullptr;
        }
        return Candidates[0];
    }

    UFGPipeConnectionComponentBase* ResolveGeneratedPipeConnection(
        AFGBuildable* Buildable,
        const FString& ExplicitName,
        const EPipeConnectionType Wanted,
        FString& OutReason)
    {
        if (!IsValid(Buildable))
        {
            OutReason = TEXT("generated_pipeline_endpoint_buildable_is_invalid");
            return nullptr;
        }

        TInlineComponentArray<UFGPipeConnectionComponentBase*> Components;
        Buildable->GetComponents(Components);
        TArray<UFGPipeConnectionComponentBase*> Candidates;
        for (UFGPipeConnectionComponentBase* Component : Components)
        {
            if (!IsValid(Component) || Component->IsConnected())
            {
                continue;
            }
            if (!ExplicitName.IsEmpty() &&
                Component->GetName() != ExplicitName &&
                !Component->GetPathName().EndsWith(TEXT(".") + ExplicitName))
            {
                continue;
            }
            if (ExplicitName.IsEmpty())
            {
                const EPipeConnectionType Actual = Component->GetPipeConnectionType();
                const bool bDirectionMatches =
                    Actual == EPipeConnectionType::PCT_ANY || Actual == Wanted;
                if (!bDirectionMatches)
                {
                    continue;
                }
            }
            Candidates.Add(Component);
        }
        if (Candidates.Num() != 1)
        {
            OutReason = FString::Printf(
                TEXT("generated_pipeline_endpoint_requires_exactly_one_free_matching_connector:%s:candidates=%d"),
                *Buildable->GetName(),
                Candidates.Num());
            return nullptr;
        }
        return Candidates[0];
    }

    bool ResolveGeneratedPipelineMaximumLength(
        const TSubclassOf<UFGRecipe> BuildRecipe,
        double& OutMaximumLength)
    {
        OutMaximumLength = 0.0;
        for (const FItemAmount& Product : UFGRecipe::GetProducts(BuildRecipe))
        {
            if (!Product.ItemClass ||
                !Product.ItemClass->IsChildOf(UFGBuildDescriptor::StaticClass()))
            {
                continue;
            }
            const TSubclassOf<UFGBuildDescriptor> Descriptor(Product.ItemClass.Get());
            UClass* HologramClass = UFGBuildDescriptor::GetHologramClass(Descriptor);
            if (!IsValid(HologramClass) ||
                !HologramClass->IsChildOf(AFGPipelineHologram::StaticClass()))
            {
                continue;
            }
            const FFloatProperty* Property = FindFProperty<FFloatProperty>(
                HologramClass,
                TEXT("mMaxSplineLength"));
            const UObject* Default = HologramClass->GetDefaultObject();
            if (!Property || !IsValid(Default))
            {
                return false;
            }
            const float Value = Property->GetPropertyValue_InContainer(Default);
            if (!FMath::IsFinite(Value) || Value <= 0.0f)
            {
                return false;
            }
            OutMaximumLength = Value;
            return true;
        }
        return false;
    }

    bool IsFiniteGeneratedBounds(const FBox& Bounds)
    {
        return Bounds.IsValid &&
            !Bounds.Min.ContainsNaN() &&
            !Bounds.Max.ContainsNaN() &&
            Bounds.GetSize().GetAbsMax() > KINDA_SMALL_NUMBER;
    }

    /**
     * Resolve the same spatial contract Satisfactory uses for hologram
     * clearance before falling back to registered primitive bounds.
     *
     * Lightweight structural actors such as foundations intentionally have no
     * registered colliding render primitive on the authoritative server. The
     * first live generated Blueprint therefore returned an invalid actor box
     * for a perfectly valid 8x8x2 m foundation. Their FFGClearanceData remains
     * present because it is the native placement contract. It is expressed in
     * actor-relative space, so transform it into the staged world before pair
     * testing. Ordinary machines may instead expose registered primitives;
     * those remain exact native fallbacks, with non-colliding components last
     * so a server-only visual/collision mode cannot erase their dimensions.
     */
    bool ResolveGeneratedNativeBounds(
        AFGBuildable* Buildable,
        FBox& OutBounds,
        FString& OutSource)
    {
        OutBounds = FBox(ForceInit);
        OutSource.Reset();
        if (!IsValid(Buildable))
        {
            return false;
        }

        TArray<FFGClearanceData> ClearanceData;
        IFGClearanceInterface::Execute_GetClearanceData(Buildable, ClearanceData);
        FBox ClearanceBounds(ForceInit);
        for (const FFGClearanceData& Clearance : ClearanceData)
        {
            if (!Clearance.IsValid())
            {
                continue;
            }
            const FBox LocalBounds = Clearance.GetTransformedClearanceBox();
            if (!IsFiniteGeneratedBounds(LocalBounds))
            {
                continue;
            }
            ClearanceBounds += LocalBounds.TransformBy(Buildable->GetActorTransform());
        }
        if (IsFiniteGeneratedBounds(ClearanceBounds))
        {
            OutBounds = ClearanceBounds;
            OutSource = TEXT("native_clearance_data");
            return true;
        }

        const FBox CollidingComponents =
            Buildable->GetComponentsBoundingBox(false, true);
        if (IsFiniteGeneratedBounds(CollidingComponents))
        {
            OutBounds = CollidingComponents;
            OutSource = TEXT("registered_colliding_components");
            return true;
        }

        const FBox AllPrimitiveComponents =
            Buildable->GetComponentsBoundingBox(true, true);
        if (IsFiniteGeneratedBounds(AllPrimitiveComponents))
        {
            OutBounds = AllPrimitiveComponents;
            OutSource = TEXT("registered_primitive_components");
            return true;
        }
        return false;
    }

    class FScopedGeneratedBuildables
    {
    public:
        FScopedGeneratedBuildables(
            UWorld* World,
            AFGBuildableBlueprintDesigner* Designer,
            const TArray<FResolvedGeneratedPart>& Parts,
            const TArray<FAIFactoryGeneratedBlueprintConveyor>& Conveyors,
            const TArray<FAIFactoryGeneratedBlueprintPowerWire>& PowerWires,
            const TArray<FAIFactoryGeneratedBlueprintPipeline>& Pipelines)
            : StagingWorld(World), StagingDesigner(Designer)
        {
            if (!IsValid(World) || !IsValid(Designer))
            {
                Failure = TEXT("generated_blueprint_staging_world_or_designer_is_invalid");
                return;
            }

            for (const FResolvedGeneratedPart& Part : Parts)
            {
                const FTransform WorldTransform =
                    Part.Source.RelativeTransform * Designer->GetActorTransform();
                FActorSpawnParameters Params;
                Params.SpawnCollisionHandlingOverride =
                    ESpawnActorCollisionHandlingMethod::AlwaysSpawn;
                Params.bDeferConstruction = true;
                Params.ObjectFlags |= RF_Transient;

                AFGBuildable* Buildable =
                    World->SpawnActor<AFGBuildable>(Part.BuildableClass, WorldTransform, Params);
                if (!IsValid(Buildable))
                {
                    Failure = TEXT("generated_buildable_spawn_failed:") + Part.Source.PartId;
                    return;
                }
                SpawnedActors.Add(Buildable);

                // This must remain before BeginPlay. The exact same construction
                // window is used by lightweight materialisation in the proven
                // selection exporter; calling it on an already-live actor
                // asserts and previously crashed a real save.
                Buildable->SetInsideBlueprintDesigner(Designer);
                Buildable->SetBuiltWithRecipe(Part.BuildRecipe);
                Buildable->FinishSpawning(WorldTransform);
                if (!IsValid(Buildable) || !Buildable->IsA(Part.BuildableClass))
                {
                    Failure = TEXT("generated_buildable_finish_spawning_failed:") +
                        Part.Source.PartId;
                    return;
                }

                if (Part.ProductionRecipe)
                {
                    AFGBuildableManufacturer* Manufacturer =
                        Cast<AFGBuildableManufacturer>(Buildable);
                    UFGInventoryComponent* Input = IsValid(Manufacturer)
                        ? Manufacturer->GetInputInventory()
                        : nullptr;
                    UFGInventoryComponent* Output = IsValid(Manufacturer)
                        ? Manufacturer->GetOutputInventory()
                        : nullptr;
                    TArray<TSubclassOf<UFGRecipe>> AvailableRecipes;
                    if (IsValid(Manufacturer))
                    {
                        Manufacturer->GetAvailableRecipes(AvailableRecipes);
                    }
                    if (!IsValid(Manufacturer) ||
                        !IsValid(Input) || !IsValid(Output) ||
                        !Input->IsEmpty() || !Output->IsEmpty() ||
                        !AvailableRecipes.Contains(Part.ProductionRecipe))
                    {
                        Failure = TEXT("generated_manufacturer_recipe_could_not_be_applied:") +
                            Part.Source.PartId;
                        return;
                    }
                    Manufacturer->SetRecipe(Part.ProductionRecipe);
                    if (Manufacturer->GetCurrentRecipe() != Part.ProductionRecipe)
                    {
                        Failure = TEXT("generated_manufacturer_recipe_readback_failed:") +
                            Part.Source.PartId;
                        return;
                    }
                }

                FStagedGeneratedPart& Staged = StagedParts.AddDefaulted_GetRef();
                Staged.Resolved = Part;
                Staged.Buildable = Buildable;
                if (!ResolveGeneratedNativeBounds(
                        Buildable,
                        Staged.CollisionBounds,
                        Staged.BoundsSource))
                {
                    Failure = TEXT("generated_buildable_has_no_finite_native_clearance_or_component_bounds:") +
                        Part.Source.PartId;
                    return;
                }
                BuildablesByPartId.Add(Part.Source.PartId, Buildable);
            }

            for (const FAIFactoryGeneratedBlueprintConveyor& Conveyor : Conveyors)
            {
                if (!StageConveyor(Conveyor))
                {
                    return;
                }
            }
            for (const FAIFactoryGeneratedBlueprintPowerWire& Wire : PowerWires)
            {
                if (!StagePowerWire(Wire))
                {
                    return;
                }
            }
            for (const FAIFactoryGeneratedBlueprintPipeline& Pipeline : Pipelines)
            {
                if (!StagePipeline(Pipeline))
                {
                    return;
                }
            }
        }

        ~FScopedGeneratedBuildables()
        {
            for (int32 Index = SpawnedActors.Num() - 1; Index >= 0; --Index)
            {
                if (AFGBuildable* Buildable = SpawnedActors[Index]; IsValid(Buildable))
                {
                    if (AFGBuildableWire* Wire = Cast<AFGBuildableWire>(Buildable))
                    {
                        Wire->Disconnect();
                    }
                    if (AFGBuildableConveyorBase* Conveyor =
                            Cast<AFGBuildableConveyorBase>(Buildable))
                    {
                        if (IsValid(Conveyor->GetConnection0()) &&
                            Conveyor->GetConnection0()->IsConnected())
                        {
                            Conveyor->GetConnection0()->ClearConnection();
                        }
                        if (IsValid(Conveyor->GetConnection1()) &&
                            Conveyor->GetConnection1()->IsConnected())
                        {
                            Conveyor->GetConnection1()->ClearConnection();
                        }
                        if (AFGBuildableSubsystem* Buildables =
                                AFGBuildableSubsystem::Get(Buildable->GetWorld()))
                        {
                            Buildables->RemoveConveyor(Conveyor);
                        }
                    }
                    if (AFGBuildablePipeline* Pipeline =
                            Cast<AFGBuildablePipeline>(Buildable))
                    {
                        if (IsValid(Pipeline->GetConnection0()) &&
                            Pipeline->GetConnection0()->IsConnected())
                        {
                            Pipeline->GetConnection0()->ClearConnection();
                        }
                        if (IsValid(Pipeline->GetConnection1()) &&
                            Pipeline->GetConnection1()->IsConnected())
                        {
                            Pipeline->GetConnection1()->ClearConnection();
                        }
                    }
                    Buildable->Destroy();
                }
            }
            SpawnedActors.Reset();
            StagedParts.Reset();
        }

        const TArray<FStagedGeneratedPart>& Get() const { return StagedParts; }
        const TArray<AFGBuildable*>& GetAll() const { return SpawnedActors; }
        bool IsComplete(const int32 Expected) const
        {
            return Failure.IsEmpty() && StagedParts.Num() == Expected;
        }
        const FString& GetFailure() const { return Failure; }
        int32 NumConveyors() const { return StagedConveyors; }
        int32 NumPowerWires() const { return StagedPowerWires; }
        int32 NumPipelines() const { return StagedPipelines; }
        int32 NumAllBuildables() const { return SpawnedActors.Num(); }

    private:
        bool StageConveyor(const FAIFactoryGeneratedBlueprintConveyor& Link)
        {
            AFGBuildable* FromBuildable = BuildablesByPartId.FindRef(Link.FromPartId);
            AFGBuildable* ToBuildable = BuildablesByPartId.FindRef(Link.ToPartId);
            if (!IsValid(FromBuildable) || !IsValid(ToBuildable) ||
                FromBuildable == ToBuildable)
            {
                Failure = TEXT("generated_conveyor_part_reference_is_invalid:") + Link.LinkId;
                return false;
            }

            FString ConnectorFailure;
            UFGFactoryConnectionComponent* From = ResolveGeneratedFactoryConnection(
                FromBuildable,
                Link.FromConnectorName,
                EFactoryConnectionDirection::FCD_OUTPUT,
                ConnectorFailure);
            if (!IsValid(From))
            {
                Failure = ConnectorFailure + TEXT(":") + Link.LinkId + TEXT(":from");
                return false;
            }
            UFGFactoryConnectionComponent* To = ResolveGeneratedFactoryConnection(
                ToBuildable,
                Link.ToConnectorName,
                EFactoryConnectionDirection::FCD_INPUT,
                ConnectorFailure);
            if (!IsValid(To))
            {
                Failure = ConnectorFailure + TEXT(":") + Link.LinkId + TEXT(":to");
                return false;
            }

            TSubclassOf<UFGRecipe> BuildRecipe;
            TSubclassOf<AFGBuildable> BuildableClass;
            FString RecipeFailure;
            if (!ResolveGeneratedTopologyRecipe(
                    Link.BuildRecipeClassPath,
                    StagingWorld,
                    AFGBuildableConveyorBelt::StaticClass(),
                    BuildRecipe,
                    BuildableClass,
                    RecipeFailure))
            {
                Failure = RecipeFailure + TEXT(":") + Link.LinkId;
                return false;
            }

            // v2's first transport primitive is intentionally narrow and
            // exact: one straight native belt between collinear machine ports.
            // Non-collinear routes need explicit poles/lifts and multiple
            // native spline pieces; silently drawing a curve here would bypass
            // the hologram's bend and incline contract.
            const FVector Start = From->GetConnectorLocation(false);
            const FVector End = To->GetConnectorLocation(false);
            const FVector Delta = End - Start;
            const double Distance = Delta.Size();
            if (!FMath::IsFinite(Distance) || Distance <= KINDA_SMALL_NUMBER)
            {
                Failure = TEXT("generated_conveyor_endpoints_have_no_finite_separation:") +
                    Link.LinkId;
                return false;
            }
            const FVector Travel = Delta / Distance;
            const double FromAlignment = FVector::DotProduct(
                From->GetConnectorNormal().GetSafeNormal(), Travel);
            const double ToAlignment = FVector::DotProduct(
                To->GetConnectorNormal().GetSafeNormal(), Travel);
            constexpr double MinimumStraightAlignment = 0.995;
            if (FromAlignment < MinimumStraightAlignment ||
                ToAlignment > -MinimumStraightAlignment)
            {
                Failure = FString::Printf(
                    TEXT("generated_conveyor_requires_explicit_multi_leg_route:%s:from_alignment=%.3f,to_alignment=%.3f"),
                    *Link.LinkId,
                    FromAlignment,
                    ToAlignment);
                return false;
            }

            const FTransform BeltTransform = StagingDesigner->GetActorTransform();
            const FVector LocalStart = BeltTransform.InverseTransformPosition(Start);
            const FVector LocalEnd = BeltTransform.InverseTransformPosition(End);
            const FVector LocalDelta = LocalEnd - LocalStart;
            TArray<FSplinePointData> SplineData{
                FSplinePointData(LocalStart, LocalDelta),
                FSplinePointData(LocalEnd, LocalDelta),
            };

            FActorSpawnParameters Params;
            Params.SpawnCollisionHandlingOverride =
                ESpawnActorCollisionHandlingMethod::AlwaysSpawn;
            Params.bDeferConstruction = true;
            Params.ObjectFlags |= RF_Transient;
            AFGBuildableConveyorBelt* Belt = Cast<AFGBuildableConveyorBelt>(
                StagingWorld->SpawnActor<AFGBuildable>(BuildableClass, BeltTransform, Params));
            if (!IsValid(Belt))
            {
                Failure = TEXT("generated_conveyor_spawn_failed:") + Link.LinkId;
                return false;
            }
            SpawnedActors.Add(Belt);
            Belt->SetInsideBlueprintDesigner(StagingDesigner);
            Belt->SetBuiltWithRecipe(BuildRecipe);
            TArray<FSplinePointData>* MutableSpline = Belt->GetMutableSplinePointData();
            if (MutableSpline == nullptr)
            {
                Failure = TEXT("generated_conveyor_has_no_mutable_native_spline:") + Link.LinkId;
                return false;
            }
            *MutableSpline = MoveTemp(SplineData);
            Belt->FinishSpawning(BeltTransform);

            UFGFactoryConnectionComponent* BeltInput = Belt->GetConnection0();
            UFGFactoryConnectionComponent* BeltOutput = Belt->GetConnection1();
            if (!IsValid(BeltInput) || !IsValid(BeltOutput) ||
                !BeltInput->CanConnectTo(From) || !BeltOutput->CanConnectTo(To))
            {
                Failure = TEXT("generated_conveyor_native_connections_rejected_endpoints:") +
                    Link.LinkId;
                return false;
            }
            BeltInput->SetConnection(From);
            BeltOutput->SetConnection(To);
            const bool bInputExact = BeltInput->GetConnection() == From &&
                From->GetConnection() == BeltInput;
            const bool bOutputExact = BeltOutput->GetConnection() == To &&
                To->GetConnection() == BeltOutput;
            if (!bInputExact || !bOutputExact)
            {
                Failure = TEXT("generated_conveyor_endpoint_readback_failed:") + Link.LinkId;
                return false;
            }
            ++StagedConveyors;
            return true;
        }

        bool StagePowerWire(const FAIFactoryGeneratedBlueprintPowerWire& Link)
        {
            AFGBuildable* FromBuildable = BuildablesByPartId.FindRef(Link.FromPartId);
            AFGBuildable* ToBuildable = BuildablesByPartId.FindRef(Link.ToPartId);
            if (!IsValid(FromBuildable) || !IsValid(ToBuildable) ||
                FromBuildable == ToBuildable)
            {
                Failure = TEXT("generated_power_wire_part_reference_is_invalid:") + Link.LinkId;
                return false;
            }

            FString ConnectorFailure;
            UFGCircuitConnectionComponent* From = ResolveGeneratedCircuitConnection(
                FromBuildable,
                Link.FromConnectorName,
                ConnectorFailure);
            if (!IsValid(From))
            {
                Failure = ConnectorFailure + TEXT(":") + Link.LinkId + TEXT(":from");
                return false;
            }
            UFGCircuitConnectionComponent* To = ResolveGeneratedCircuitConnection(
                ToBuildable,
                Link.ToConnectorName,
                ConnectorFailure);
            if (!IsValid(To))
            {
                Failure = ConnectorFailure + TEXT(":") + Link.LinkId + TEXT(":to");
                return false;
            }
            if (From->GetCircuitType() != To->GetCircuitType())
            {
                Failure = TEXT("generated_power_wire_circuit_types_do_not_match:") + Link.LinkId;
                return false;
            }

            TSubclassOf<UFGRecipe> BuildRecipe;
            TSubclassOf<AFGBuildable> BuildableClass;
            FString RecipeFailure;
            if (!ResolveGeneratedTopologyRecipe(
                    Link.BuildRecipeClassPath,
                    StagingWorld,
                    AFGBuildableWire::StaticClass(),
                    BuildRecipe,
                    BuildableClass,
                    RecipeFailure))
            {
                Failure = RecipeFailure + TEXT(":") + Link.LinkId;
                return false;
            }

            const AFGBuildableWire* WireDefault =
                BuildableClass->GetDefaultObject<AFGBuildableWire>();
            const AFGBuildablePowerPole* FromPole =
                Cast<AFGBuildablePowerPole>(FromBuildable);
            const AFGBuildablePowerPole* ToPole =
                Cast<AFGBuildablePowerPole>(ToBuildable);
            const bool bPowerTowerLink =
                IsValid(FromPole) && IsValid(ToPole) &&
                FromPole->GetPowerPoleType() == EPowerPoleType::PPT_TOWER &&
                ToPole->GetPowerPoleType() == EPowerPoleType::PPT_TOWER;
            const double MaximumLength = IsValid(WireDefault)
                ? (bPowerTowerLink
                    ? WireDefault->mMaxPowerTowerLength
                    : WireDefault->mMaxLength)
                : 0.0;
            const double EndpointDistance = FVector::Distance(
                From->GetComponentLocation(),
                To->GetComponentLocation());
            if (!FMath::IsFinite(MaximumLength) || MaximumLength <= 0.0 ||
                !FMath::IsFinite(EndpointDistance) || EndpointDistance > MaximumLength)
            {
                Failure = FString::Printf(
                    TEXT("generated_power_wire_exceeds_native_length:%s:distance_cm=%.1f,max_cm=%.1f"),
                    *Link.LinkId,
                    EndpointDistance,
                    MaximumLength);
                return false;
            }

            const FTransform WireTransform = StagingDesigner->GetActorTransform();
            FActorSpawnParameters Params;
            Params.SpawnCollisionHandlingOverride =
                ESpawnActorCollisionHandlingMethod::AlwaysSpawn;
            Params.bDeferConstruction = true;
            Params.ObjectFlags |= RF_Transient;
            AFGBuildableWire* Wire = Cast<AFGBuildableWire>(
                StagingWorld->SpawnActor<AFGBuildable>(BuildableClass, WireTransform, Params));
            if (!IsValid(Wire))
            {
                Failure = TEXT("generated_power_wire_spawn_failed:") + Link.LinkId;
                return false;
            }
            SpawnedActors.Add(Wire);
            Wire->SetInsideBlueprintDesigner(StagingDesigner);
            Wire->SetBuiltWithRecipe(BuildRecipe);
            Wire->FinishSpawning(WireTransform);
            if (!Wire->Connect(From, To) ||
                Wire->GetConnection(0) != From || Wire->GetConnection(1) != To)
            {
                Failure = TEXT("generated_power_wire_endpoint_readback_failed:") + Link.LinkId;
                return false;
            }
            TArray<AFGBuildableWire*> FromWires;
            TArray<AFGBuildableWire*> ToWires;
            From->GetWires(FromWires);
            To->GetWires(ToWires);
            if (!FromWires.Contains(Wire) || !ToWires.Contains(Wire))
            {
                Failure = TEXT("generated_power_wire_reciprocal_component_readback_failed:") +
                    Link.LinkId;
                return false;
            }
            ++StagedPowerWires;
            return true;
        }

        bool StagePipeline(const FAIFactoryGeneratedBlueprintPipeline& Link)
        {
            AFGBuildable* FromBuildable = BuildablesByPartId.FindRef(Link.FromPartId);
            AFGBuildable* ToBuildable = BuildablesByPartId.FindRef(Link.ToPartId);
            if (!IsValid(FromBuildable) || !IsValid(ToBuildable) ||
                FromBuildable == ToBuildable)
            {
                Failure = TEXT("generated_pipeline_part_reference_is_invalid:") + Link.LinkId;
                return false;
            }

            FString ConnectorFailure;
            UFGPipeConnectionComponentBase* From = ResolveGeneratedPipeConnection(
                FromBuildable,
                Link.FromConnectorName,
                EPipeConnectionType::PCT_PRODUCER,
                ConnectorFailure);
            if (!IsValid(From))
            {
                Failure = ConnectorFailure + TEXT(":") + Link.LinkId + TEXT(":from");
                return false;
            }
            UFGPipeConnectionComponentBase* To = ResolveGeneratedPipeConnection(
                ToBuildable,
                Link.ToConnectorName,
                EPipeConnectionType::PCT_CONSUMER,
                ConnectorFailure);
            if (!IsValid(To))
            {
                Failure = ConnectorFailure + TEXT(":") + Link.LinkId + TEXT(":to");
                return false;
            }

            TSubclassOf<UFGRecipe> BuildRecipe;
            TSubclassOf<AFGBuildable> BuildableClass;
            FString RecipeFailure;
            if (!ResolveGeneratedTopologyRecipe(
                    Link.BuildRecipeClassPath,
                    StagingWorld,
                    AFGBuildablePipeline::StaticClass(),
                    BuildRecipe,
                    BuildableClass,
                    RecipeFailure))
            {
                Failure = RecipeFailure + TEXT(":") + Link.LinkId;
                return false;
            }

            // v3 intentionally starts with the same narrow primitive that made
            // v2 conveyors auditable: one straight native spline between two
            // exact, oppositely facing ports. Junctions, supports and pumps
            // must become explicit generated parts before bent/elevated routes
            // are allowed; a synthetic curve would bypass the hologram's bend
            // radius and head-lift semantics.
            const FVector Start = From->GetConnectorLocation(false);
            const FVector End = To->GetConnectorLocation(false);
            const FVector Delta = End - Start;
            const double Distance = Delta.Size();
            double MaximumLength = 0.0;
            if (!FMath::IsFinite(Distance) ||
                Distance < AFGPipelineHologram::MINIMUM_HOLOGRAM_LENGTH ||
                !ResolveGeneratedPipelineMaximumLength(BuildRecipe, MaximumLength) ||
                Distance > MaximumLength)
            {
                Failure = FString::Printf(
                    TEXT("generated_pipeline_length_outside_native_hologram_limits:%s:distance_cm=%.1f,min_cm=%.1f,max_cm=%.1f"),
                    *Link.LinkId,
                    Distance,
                    static_cast<double>(AFGPipelineHologram::MINIMUM_HOLOGRAM_LENGTH),
                    MaximumLength);
                return false;
            }
            const FVector Travel = Delta / Distance;
            const double FromAlignment = FVector::DotProduct(
                From->GetConnectorNormal().GetSafeNormal(),
                Travel);
            const double ToAlignment = FVector::DotProduct(
                To->GetConnectorNormal().GetSafeNormal(),
                Travel);
            constexpr double MinimumStraightAlignment = 0.995;
            if (FromAlignment < MinimumStraightAlignment ||
                ToAlignment > -MinimumStraightAlignment)
            {
                Failure = FString::Printf(
                    TEXT("generated_pipeline_requires_explicit_multi_leg_route:%s:from_alignment=%.3f,to_alignment=%.3f"),
                    *Link.LinkId,
                    FromAlignment,
                    ToAlignment);
                return false;
            }
            if (!From->CanConnectTo(To) || !To->CanConnectTo(From) ||
                !From->CheckCompatibility(To, nullptr) ||
                !To->CheckCompatibility(From, nullptr))
            {
                Failure = TEXT("generated_pipeline_native_endpoints_are_incompatible:") +
                    Link.LinkId;
                return false;
            }

            const FTransform PipeTransform = StagingDesigner->GetActorTransform();
            const FVector LocalStart = PipeTransform.InverseTransformPosition(Start);
            const FVector LocalEnd = PipeTransform.InverseTransformPosition(End);
            const FVector LocalDelta = LocalEnd - LocalStart;
            TArray<FSplinePointData> SplineData{
                FSplinePointData(LocalStart, LocalDelta),
                FSplinePointData(LocalEnd, LocalDelta),
            };

            FActorSpawnParameters Params;
            Params.SpawnCollisionHandlingOverride =
                ESpawnActorCollisionHandlingMethod::AlwaysSpawn;
            Params.bDeferConstruction = true;
            Params.ObjectFlags |= RF_Transient;
            AFGBuildablePipeline* Pipeline = Cast<AFGBuildablePipeline>(
                StagingWorld->SpawnActor<AFGBuildable>(
                    BuildableClass,
                    PipeTransform,
                    Params));
            if (!IsValid(Pipeline))
            {
                Failure = TEXT("generated_pipeline_spawn_failed:") + Link.LinkId;
                return false;
            }
            SpawnedActors.Add(Pipeline);
            Pipeline->SetInsideBlueprintDesigner(StagingDesigner);
            Pipeline->SetBuiltWithRecipe(BuildRecipe);
            TArray<FSplinePointData>* MutableSpline =
                Pipeline->GetMutableSplinePointData();
            if (MutableSpline == nullptr)
            {
                Failure = TEXT("generated_pipeline_has_no_mutable_native_spline:") +
                    Link.LinkId;
                return false;
            }
            *MutableSpline = MoveTemp(SplineData);
            Pipeline->FinishSpawning(PipeTransform);

            UFGPipeConnectionComponentBase* PipeStart = Pipeline->GetConnection0();
            UFGPipeConnectionComponentBase* PipeEnd = Pipeline->GetConnection1();
            if (!IsValid(PipeStart) || !IsValid(PipeEnd) ||
                !PipeStart->CanConnectTo(From) || !PipeEnd->CanConnectTo(To) ||
                !PipeStart->CheckCompatibility(From, nullptr) ||
                !PipeEnd->CheckCompatibility(To, nullptr))
            {
                Failure = TEXT("generated_pipeline_native_connections_rejected_endpoints:") +
                    Link.LinkId;
                return false;
            }
            PipeStart->SetConnection(From);
            PipeEnd->SetConnection(To);
            const bool bStartExact = PipeStart->GetConnection() == From &&
                From->GetConnection() == PipeStart;
            const bool bEndExact = PipeEnd->GetConnection() == To &&
                To->GetConnection() == PipeEnd;
            if (!bStartExact || !bEndExact)
            {
                Failure = TEXT("generated_pipeline_endpoint_readback_failed:") + Link.LinkId;
                return false;
            }
            ++StagedPipelines;
            return true;
        }

        UWorld* StagingWorld = nullptr;
        AFGBuildableBlueprintDesigner* StagingDesigner = nullptr;
        TArray<AFGBuildable*> SpawnedActors;
        TArray<FStagedGeneratedPart> StagedParts;
        TMap<FString, AFGBuildable*> BuildablesByPartId;
        int32 StagedConveyors = 0;
        int32 StagedPowerWires = 0;
        int32 StagedPipelines = 0;
        FString Failure;
    };

    bool IsGeneratedStructuralRole(const FString& Role)
    {
        return Role == TEXT("floor") || Role == TEXT("pillar") ||
            Role == TEXT("wall") || Role == TEXT("roof") || Role == TEXT("ramp");
    }

    /**
     * Conservative internal collision check over the native actors we staged.
     *
     * Adjacent/snapped structural pieces intentionally share collision bounds,
     * so structure-to-structure pairs are recorded but not rejected. A machine
     * may touch its floor by at most one decimetre. Every other volumetric AABB
     * intersection refuses the file. Final site/terrain clearance remains the
     * vanilla Blueprint hologram's job when the player chooses where to place.
     */
    bool ValidateGeneratedInternalBounds(
        const TArray<FStagedGeneratedPart>& Parts,
        FString& OutReason,
        int32& OutStructuralContacts,
        FBox& OutCombinedBounds)
    {
        OutStructuralContacts = 0;
        OutCombinedBounds = FBox(ForceInit);
        for (const FStagedGeneratedPart& Part : Parts)
        {
            OutCombinedBounds += Part.CollisionBounds;
        }

        constexpr double MeaningfulPenetrationCm = 1.0;
        constexpr double MaximumFloorMachineContactCm = 10.0;
        for (int32 LeftIndex = 0; LeftIndex < Parts.Num(); ++LeftIndex)
        {
            for (int32 RightIndex = LeftIndex + 1; RightIndex < Parts.Num(); ++RightIndex)
            {
                const FStagedGeneratedPart& Left = Parts[LeftIndex];
                const FStagedGeneratedPart& Right = Parts[RightIndex];
                const FVector OverlapMin(
                    FMath::Max(Left.CollisionBounds.Min.X, Right.CollisionBounds.Min.X),
                    FMath::Max(Left.CollisionBounds.Min.Y, Right.CollisionBounds.Min.Y),
                    FMath::Max(Left.CollisionBounds.Min.Z, Right.CollisionBounds.Min.Z));
                const FVector OverlapMax(
                    FMath::Min(Left.CollisionBounds.Max.X, Right.CollisionBounds.Max.X),
                    FMath::Min(Left.CollisionBounds.Max.Y, Right.CollisionBounds.Max.Y),
                    FMath::Min(Left.CollisionBounds.Max.Z, Right.CollisionBounds.Max.Z));
                const FVector Penetration = OverlapMax - OverlapMin;
                if (Penetration.X <= MeaningfulPenetrationCm ||
                    Penetration.Y <= MeaningfulPenetrationCm ||
                    Penetration.Z <= MeaningfulPenetrationCm)
                {
                    continue;
                }

                const FString& LeftRole = Left.Resolved.Source.Role;
                const FString& RightRole = Right.Resolved.Source.Role;
                if (IsGeneratedStructuralRole(LeftRole) &&
                    IsGeneratedStructuralRole(RightRole))
                {
                    ++OutStructuralContacts;
                    continue;
                }

                const FStagedGeneratedPart* Floor = nullptr;
                const FStagedGeneratedPart* Machine = nullptr;
                if (LeftRole == TEXT("floor") && RightRole == TEXT("machine"))
                {
                    Floor = &Left;
                    Machine = &Right;
                }
                else if (RightRole == TEXT("floor") && LeftRole == TEXT("machine"))
                {
                    Floor = &Right;
                    Machine = &Left;
                }
                if (Floor && Machine &&
                    Machine->CollisionBounds.GetCenter().Z >= Floor->CollisionBounds.GetCenter().Z &&
                    Penetration.Z <= MaximumFloorMachineContactCm)
                {
                    continue;
                }

                OutReason = FString::Printf(
                    TEXT("generated_internal_collision:%s:%s:penetration_cm=%.1f,%.1f,%.1f"),
                    *Left.Resolved.Source.PartId,
                    *Right.Resolved.Source.PartId,
                    Penetration.X,
                    Penetration.Y,
                    Penetration.Z);
                return false;
            }
        }
        return true;
    }

    bool ValidateGeneratedNativeTopologyReadback(
        const TArray<AFGBuildable*>& Loaded,
        const int32 ExpectedBuildables,
        const int32 ExpectedConfiguredManufacturers,
        const int32 ExpectedConveyors,
        const int32 ExpectedPowerWires,
        const int32 ExpectedPipelines,
        TSharedRef<FJsonObject> Observed,
        FString& OutReason)
    {
        int32 ValidBuildables = 0;
        int32 ConfiguredManufacturers = 0;
        int32 ConveyorCount = 0;
        int32 ExactConveyorLinks = 0;
        int32 PowerWireCount = 0;
        int32 ExactPowerWireLinks = 0;
        int32 PipelineCount = 0;
        int32 ExactPipelineLinks = 0;

        for (AFGBuildable* Buildable : Loaded)
        {
            if (!IsValid(Buildable))
            {
                continue;
            }
            ++ValidBuildables;
            if (AFGBuildableManufacturer* Manufacturer =
                    Cast<AFGBuildableManufacturer>(Buildable))
            {
                if (Manufacturer->GetCurrentRecipe())
                {
                    ++ConfiguredManufacturers;
                }
            }
            if (AFGBuildableConveyorBase* Conveyor =
                    Cast<AFGBuildableConveyorBase>(Buildable))
            {
                ++ConveyorCount;
                UFGFactoryConnectionComponent* BeltInput = Conveyor->GetConnection0();
                UFGFactoryConnectionComponent* BeltOutput = Conveyor->GetConnection1();
                UFGFactoryConnectionComponent* Source =
                    IsValid(BeltInput) ? BeltInput->GetConnection() : nullptr;
                UFGFactoryConnectionComponent* Destination =
                    IsValid(BeltOutput) ? BeltOutput->GetConnection() : nullptr;
                const bool bExact =
                    IsValid(Source) && IsValid(Destination) &&
                    Source->GetConnection() == BeltInput &&
                    Destination->GetConnection() == BeltOutput &&
                    Source->GetDirection() != EFactoryConnectionDirection::FCD_INPUT &&
                    Destination->GetDirection() != EFactoryConnectionDirection::FCD_OUTPUT;
                if (bExact)
                {
                    ++ExactConveyorLinks;
                }
            }
            if (AFGBuildableWire* Wire = Cast<AFGBuildableWire>(Buildable))
            {
                ++PowerWireCount;
                UFGCircuitConnectionComponent* First = Wire->GetConnection(0);
                UFGCircuitConnectionComponent* Second = Wire->GetConnection(1);
                TArray<AFGBuildableWire*> FirstWires;
                TArray<AFGBuildableWire*> SecondWires;
                if (IsValid(First))
                {
                    First->GetWires(FirstWires);
                }
                if (IsValid(Second))
                {
                    Second->GetWires(SecondWires);
                }
                if (IsValid(First) && IsValid(Second) && First != Second &&
                    FirstWires.Contains(Wire) && SecondWires.Contains(Wire))
                {
                    ++ExactPowerWireLinks;
                }
            }
            if (AFGBuildablePipeline* Pipeline =
                    Cast<AFGBuildablePipeline>(Buildable))
            {
                ++PipelineCount;
                UFGPipeConnectionComponentBase* First = Pipeline->GetConnection0();
                UFGPipeConnectionComponentBase* Second = Pipeline->GetConnection1();
                UFGPipeConnectionComponentBase* FirstPeer =
                    IsValid(First) ? First->GetConnection() : nullptr;
                UFGPipeConnectionComponentBase* SecondPeer =
                    IsValid(Second) ? Second->GetConnection() : nullptr;
                if (IsValid(FirstPeer) && IsValid(SecondPeer) &&
                    FirstPeer != SecondPeer &&
                    FirstPeer->GetConnection() == First &&
                    SecondPeer->GetConnection() == Second)
                {
                    ++ExactPipelineLinks;
                }
            }
        }

        Observed->SetNumberField(TEXT("native_loaded_buildables"), ValidBuildables);
        Observed->SetNumberField(
            TEXT("native_loaded_configured_manufacturers"),
            ConfiguredManufacturers);
        Observed->SetNumberField(TEXT("native_loaded_conveyors"), ConveyorCount);
        Observed->SetNumberField(
            TEXT("native_loaded_exact_reciprocal_conveyor_links"),
            ExactConveyorLinks);
        Observed->SetNumberField(TEXT("native_loaded_power_wires"), PowerWireCount);
        Observed->SetNumberField(
            TEXT("native_loaded_exact_reciprocal_power_wire_links"),
            ExactPowerWireLinks);
        Observed->SetNumberField(TEXT("native_loaded_pipelines"), PipelineCount);
        Observed->SetNumberField(
            TEXT("native_loaded_exact_reciprocal_pipeline_links"),
            ExactPipelineLinks);

        if (ValidBuildables != ExpectedBuildables)
        {
            OutReason = FString::Printf(
                TEXT("native_blueprint_buildable_count_readback_mismatch:expected=%d,actual=%d"),
                ExpectedBuildables,
                ValidBuildables);
            return false;
        }
        if (ConfiguredManufacturers != ExpectedConfiguredManufacturers)
        {
            OutReason = FString::Printf(
                TEXT("native_blueprint_manufacturer_recipe_readback_mismatch:expected=%d,actual=%d"),
                ExpectedConfiguredManufacturers,
                ConfiguredManufacturers);
            return false;
        }
        if (ConveyorCount != ExpectedConveyors || ExactConveyorLinks != ExpectedConveyors)
        {
            OutReason = FString::Printf(
                TEXT("native_blueprint_conveyor_topology_readback_mismatch:expected=%d,actors=%d,exact_links=%d"),
                ExpectedConveyors,
                ConveyorCount,
                ExactConveyorLinks);
            return false;
        }
        if (PowerWireCount != ExpectedPowerWires ||
            ExactPowerWireLinks != ExpectedPowerWires)
        {
            OutReason = FString::Printf(
                TEXT("native_blueprint_power_topology_readback_mismatch:expected=%d,actors=%d,exact_links=%d"),
                ExpectedPowerWires,
                PowerWireCount,
                ExactPowerWireLinks);
            return false;
        }
        if (PipelineCount != ExpectedPipelines ||
            ExactPipelineLinks != ExpectedPipelines)
        {
            OutReason = FString::Printf(
                TEXT("native_blueprint_pipeline_topology_readback_mismatch:expected=%d,actors=%d,exact_links=%d"),
                ExpectedPipelines,
                PipelineCount,
                ExactPipelineLinks);
            return false;
        }
        return true;
    }
}

namespace AIFactoryBlueprintExport
{

FAIFactoryActionResult ExportSelection(
    const FAIFactoryActionContext& Context,
    const FString& BlueprintName,
    const TArray<AFGBuildable*>& Buildables,
    const TArray<FLightweightBuildableInstanceRef>& LightweightInstances)
{
    const FString Action = TEXT("export_native_blueprint");

    if (BlueprintName.TrimStartAndEnd().IsEmpty())
    {
        return FAIFactoryActionResult::Refuse(Action, TEXT("blueprint_name_is_required"));
    }
    if (Buildables.Num() == 0 && LightweightInstances.Num() == 0)
    {
        return FAIFactoryActionResult::Refuse(Action, TEXT("nothing_was_selected"));
    }
    if (!IsValid(Context.World))
    {
        return FAIFactoryActionResult::Refuse(Action, TEXT("no_world"));
    }

    AFGBuildableBlueprintDesigner* Designer = FindAnyDesigner(Context.World);
    if (!IsValid(Designer))
    {
        // Deliberately not spawning one. A designer is a real building the
        // player pays for and places, and conjuring one to serve an export
        // would leave an object in their world they did not ask for.
        return FAIFactoryActionResult::Refuse(
            Action,
            TEXT("no_blueprint_designer_in_this_world_build_one_first"));
    }

    const TSharedRef<FJsonObject> Predicted = MakeShared<FJsonObject>();
    Predicted->SetStringField(TEXT("blueprint_name"), BlueprintName);
    Predicted->SetNumberField(TEXT("selected_buildables"), Buildables.Num());
    Predicted->SetNumberField(TEXT("selected_lightweight_buildables"), LightweightInstances.Num());
    Predicted->SetStringField(TEXT("designer"), Designer->GetPathName());
    Predicted->SetBoolField(TEXT("designer_had_buildings"), Designer->HasBuildings());

    // A designer already holding something is mid-edit for the player. Adding
    // a megabase to it would silently fold their work into this archive.
    if (Designer->HasBuildings())
    {
        FAIFactoryActionResult Refusal = FAIFactoryActionResult::Refuse(
            Action,
            TEXT("the_blueprint_designer_is_not_empty_clear_it_first"));
        Refusal.Predicted = Predicted;
        return Refusal;
    }

    int32 InvalidLightweight = 0;
    for (const FLightweightBuildableInstanceRef& Instance : LightweightInstances)
    {
        if (!Instance.IsValid())
        {
            ++InvalidLightweight;
        }
    }
    Predicted->SetNumberField(TEXT("lightweight_invalid_before_export"), InvalidLightweight);
    if (InvalidLightweight > 0)
    {
        FAIFactoryActionResult Refusal = FAIFactoryActionResult::Refuse(
            Action,
            TEXT("selected_lightweight_instance_changed_repreview_required"));
        Refusal.Predicted = Predicted;
        return Refusal;
    }

    if (Context.bDryRun)
    {
        Predicted->SetStringField(
            TEXT("would_call"),
            TEXT("OnBuildableConstructedInsideDesigner per buildable, then SaveBlueprint"));
        FAIFactoryActionResult Result;
        Result.Action = Action;
        Result.bAccepted = true;
        Result.bDryRun = true;
        Result.Status = TEXT("dry_run");
        Result.Predicted = Predicted;
        return Result;
    }

    FAIFactoryActionResult Result;
    Result.Action = Action;
    Result.Predicted = Predicted;

    // Declared before the membership guard so it unwinds *after* it: the
    // designer must let go of these before they are destroyed, or its list
    // keeps pointers to dead actors.
    FScopedMaterialisedInstances Materialised(Context.World, Designer, LightweightInstances);
    Predicted->SetNumberField(TEXT("lightweight_requested"), LightweightInstances.Num());
    Predicted->SetNumberField(TEXT("lightweight_materialised"), Materialised.Num());
    Predicted->SetNumberField(TEXT("lightweight_missing"), Materialised.NumMissing());
    if (Materialised.NumMissing() > 0)
    {
        Result.Status = TEXT("failed");
        Result.Reason = TEXT("selected_lightweight_instance_changed_repreview_required");
        return Result;
    }

    int32 Skipped = 0;
    {
        // Scope matters: the guard unwinds at the closing brace, before any
        // readback, so the world is already correct when we ask what happened.
        FScopedDesignerMembership Membership(Designer);
        for (AFGBuildable* Buildable : Buildables)
        {
            if (!Membership.Adopt(Buildable))
            {
                ++Skipped;
            }
        }

        for (AFGBuildable* Buildable : Materialised.Get())
        {
            if (!Membership.AdoptOwned(Buildable))
            {
                ++Skipped;
            }
        }

        const int32 ExpectedAdopted = Buildables.Num() + LightweightInstances.Num();
        if (Skipped > 0 || Membership.Num() != ExpectedAdopted)
        {
            Result.Status = TEXT("failed");
            Result.Reason = TEXT("one_or_more_selected_buildables_could_not_be_adopted_by_the_designer");
            Predicted->SetNumberField(TEXT("adopted"), Membership.Num());
            Predicted->SetNumberField(TEXT("skipped"), Skipped);
            return Result;
        }

        FBlueprintRecord Record;
        Record.BlueprintName = BlueprintName;
        Record.BlueprintDescription = TEXT("Exported from a dismantle selection by AI Factory Copilot.");

        AFGPlayerController* Controller =
            IsValid(Context.Player) ? Cast<AFGPlayerController>(Context.Player->GetController()) : nullptr;

        Designer->SaveBlueprint(Record, Controller);

        Predicted->SetNumberField(TEXT("adopted"), Membership.Num());
        Predicted->SetNumberField(TEXT("skipped"), Skipped);
    }

    // Read back from the game, not from the fact that SaveBlueprint returned.
    // It is void, so it tells us nothing on its own; the only honest evidence
    // that an archive exists is the subsystem finding a descriptor for it.
    const TSharedRef<FJsonObject> Observed = MakeShared<FJsonObject>();
    Observed->SetBoolField(TEXT("designer_left_empty"), !Designer->HasBuildings());

    AFGBlueprintSubsystem* Subsystem = AFGBlueprintSubsystem::GetBlueprintSubsystem(Context.World);
    bool bRegistered = false;
    if (IsValid(Subsystem))
    {
        Subsystem->RefreshBlueprintsAndDescriptors();
        bRegistered = Subsystem->ReadBlueprintFromDisc(BlueprintName);
    }
    Observed->SetBoolField(TEXT("blueprint_readable_from_disc"), bRegistered);
    Observed->SetBoolField(TEXT("subsystem_available"), IsValid(Subsystem));
    Result.Observed = Observed;

    if (!bRegistered)
    {
        Result.Status = TEXT("failed");
        Result.Reason = TEXT("save_ran_but_no_archive_could_be_read_back");
        return Result;
    }

    Result.bAccepted = true;
    Result.bCommitted = true;
    Result.Status = TEXT("committed");
    // Deliberately not undoable. The journal reverses world changes, and this
    // wrote a file; "undo" here would mean deleting a blueprint the player can
    // now see in their library, which is not what they would expect it to mean.
    Result.bUndoable = false;
    Result.UndoDescription =
        TEXT("Exported blueprints are files, not world changes; delete it from the blueprint menu.");
    return Result;
}

FAIFactoryActionResult GenerateLayout(
    const FAIFactoryActionContext& Context,
    const FString& BlueprintName,
    const FString& BlueprintDescription,
    const TArray<FAIFactoryGeneratedBlueprintPart>& Parts,
    const TArray<FAIFactoryGeneratedBlueprintConveyor>& Conveyors,
    const TArray<FAIFactoryGeneratedBlueprintPowerWire>& PowerWires,
    const TArray<FAIFactoryGeneratedBlueprintPipeline>& Pipelines,
    const FString& LayoutSchema)
{
    const FString Action = TEXT("generate_native_blueprint");
    if (BlueprintName.TrimStartAndEnd().IsEmpty())
    {
        return FAIFactoryActionResult::Refuse(Action, TEXT("blueprint_name_is_required"));
    }
    if (Parts.Num() == 0)
    {
        return FAIFactoryActionResult::Refuse(
            Action,
            TEXT("generated_blueprint_needs_at_least_one_buildable"));
    }
    if (!IsValid(Context.World))
    {
        return FAIFactoryActionResult::Refuse(Action, TEXT("no_world"));
    }
    if (Context.World->GetNetMode() == NM_Client)
    {
        return FAIFactoryActionResult::Refuse(Action, TEXT("not_server_authoritative"));
    }
    const bool bSchemaV1 = LayoutSchema == TEXT("aifactory.generated-blueprint/v1");
    const bool bSchemaV2 = LayoutSchema == TEXT("aifactory.generated-blueprint/v2");
    const bool bSchemaV3 = LayoutSchema == TEXT("aifactory.generated-blueprint/v3");
    if (!bSchemaV1 && !bSchemaV2 && !bSchemaV3)
    {
        return FAIFactoryActionResult::Refuse(
            Action,
            TEXT("unsupported_generated_blueprint_schema"));
    }
    if (bSchemaV1 &&
        (Conveyors.Num() > 0 || PowerWires.Num() > 0 || Pipelines.Num() > 0))
    {
        return FAIFactoryActionResult::Refuse(
            Action,
            TEXT("generated_blueprint_v1_cannot_carry_topology"));
    }
    if (bSchemaV2 && Pipelines.Num() > 0)
    {
        return FAIFactoryActionResult::Refuse(
            Action,
            TEXT("generated_blueprint_v2_cannot_carry_pipelines"));
    }
    if (Context.bRequireUnchangedWorld &&
        !Context.ExpectedWorldRevision.IsEmpty() &&
        !Context.ActualWorldRevision.IsEmpty() &&
        Context.ExpectedWorldRevision != Context.ActualWorldRevision)
    {
        return FAIFactoryActionResult::Refuse(
            Action,
            FString::Printf(
                TEXT("world_revision_moved:expected=%s,actual=%s"),
                *Context.ExpectedWorldRevision,
                *Context.ActualWorldRevision));
    }

    AFGBuildableBlueprintDesigner* Designer = FindAnyDesigner(Context.World);
    if (!IsValid(Designer))
    {
        return FAIFactoryActionResult::Refuse(
            Action,
            TEXT("no_blueprint_designer_in_this_world_build_one_first"));
    }
    if (Designer->HasBuildings())
    {
        return FAIFactoryActionResult::Refuse(
            Action,
            TEXT("the_blueprint_designer_is_not_empty_clear_it_first"));
    }

    TSet<FString> PartIds;
    TArray<FResolvedGeneratedPart> Resolved;
    Resolved.Reserve(Parts.Num());
    int32 ConfiguredManufacturers = 0;
    for (const FAIFactoryGeneratedBlueprintPart& Part : Parts)
    {
        if (PartIds.Contains(Part.PartId))
        {
            return FAIFactoryActionResult::Refuse(
                Action,
                TEXT("generated_blueprint_part_ids_must_be_unique:" ) + Part.PartId);
        }
        PartIds.Add(Part.PartId);

        FResolvedGeneratedPart& Entry = Resolved.AddDefaulted_GetRef();
        FString Failure;
        if (!ResolveGeneratedPart(Part, Context.World, Entry, Failure))
        {
            return FAIFactoryActionResult::Refuse(Action, Failure);
        }
        if (Entry.ProductionRecipe)
        {
            ++ConfiguredManufacturers;
        }
    }

    TSet<FString> TopologyIds;
    const auto ValidateLinkIdentity = [&PartIds, &TopologyIds](
        const FString& LinkId,
        const FString& FromPartId,
        const FString& ToPartId,
        FString& OutFailure)
    {
        if (LinkId.TrimStartAndEnd().IsEmpty())
        {
            OutFailure = TEXT("generated_topology_link_id_is_required");
            return false;
        }
        if (TopologyIds.Contains(LinkId))
        {
            OutFailure = TEXT("generated_topology_link_ids_must_be_unique:") + LinkId;
            return false;
        }
        if (!PartIds.Contains(FromPartId) || !PartIds.Contains(ToPartId) ||
            FromPartId == ToPartId)
        {
            OutFailure = TEXT("generated_topology_part_reference_is_invalid:") + LinkId;
            return false;
        }
        TopologyIds.Add(LinkId);
        return true;
    };
    for (const FAIFactoryGeneratedBlueprintConveyor& Conveyor : Conveyors)
    {
        FString Failure;
        if (!ValidateLinkIdentity(
                Conveyor.LinkId,
                Conveyor.FromPartId,
                Conveyor.ToPartId,
                Failure))
        {
            return FAIFactoryActionResult::Refuse(Action, Failure);
        }
    }
    for (const FAIFactoryGeneratedBlueprintPowerWire& Wire : PowerWires)
    {
        FString Failure;
        if (!ValidateLinkIdentity(
                Wire.LinkId,
                Wire.FromPartId,
                Wire.ToPartId,
                Failure))
        {
            return FAIFactoryActionResult::Refuse(Action, Failure);
        }
    }
    for (const FAIFactoryGeneratedBlueprintPipeline& Pipeline : Pipelines)
    {
        FString Failure;
        if (!ValidateLinkIdentity(
                Pipeline.LinkId,
                Pipeline.FromPartId,
                Pipeline.ToPartId,
                Failure))
        {
            return FAIFactoryActionResult::Refuse(Action, Failure);
        }
    }

    const TSharedRef<FJsonObject> Predicted = MakeShared<FJsonObject>();
    Predicted->SetStringField(TEXT("blueprint_name"), BlueprintName);
    Predicted->SetStringField(TEXT("layout_schema"), LayoutSchema);
    Predicted->SetNumberField(TEXT("resolved_buildables"), Resolved.Num());
    Predicted->SetNumberField(TEXT("configured_manufacturers"), ConfiguredManufacturers);
    Predicted->SetNumberField(TEXT("requested_conveyors"), Conveyors.Num());
    Predicted->SetNumberField(TEXT("requested_power_wires"), PowerWires.Num());
    Predicted->SetNumberField(TEXT("requested_pipelines"), Pipelines.Num());
    Predicted->SetStringField(TEXT("designer"), Designer->GetPathName());
    Predicted->SetBoolField(TEXT("designer_had_buildings"), Designer->HasBuildings());
    Predicted->SetStringField(
        TEXT("staging"),
        TEXT("RF_Transient deferred native actors; destroyed before return"));
    Predicted->SetStringField(
        TEXT("collision_validation"),
        TEXT("native FFGClearanceData first, registered primitive bounds fallback; final site clearance belongs to the vanilla Blueprint hologram"));

    if (Context.bDryRun)
    {
        FAIFactoryActionResult Result;
        Result.Action = Action;
        Result.bAccepted = true;
        Result.bDryRun = true;
        Result.Status = TEXT("dry_run");
        Result.Predicted = Predicted;
        return Result;
    }

    FAIFactoryActionResult Result;
    Result.Action = Action;
    Result.Predicted = Predicted;

    FScopedGeneratedBuildables Staging(
        Context.World,
        Designer,
        Resolved,
        Conveyors,
        PowerWires,
        Pipelines);
    if (!Staging.IsComplete(Resolved.Num()))
    {
        Result.Status = TEXT("failed");
        Result.Reason = Staging.GetFailure().IsEmpty()
            ? TEXT("generated_blueprint_staging_count_mismatch")
            : Staging.GetFailure();
        return Result;
    }

    TMap<FString, int32> BoundsSourceCounts;
    for (const FStagedGeneratedPart& Part : Staging.Get())
    {
        BoundsSourceCounts.FindOrAdd(Part.BoundsSource) += 1;
    }
    const TSharedRef<FJsonObject> BoundsSources = MakeShared<FJsonObject>();
    for (const TPair<FString, int32>& Entry : BoundsSourceCounts)
    {
        BoundsSources->SetNumberField(Entry.Key, Entry.Value);
    }
    Predicted->SetObjectField(TEXT("native_bounds_sources"), BoundsSources);
    Predicted->SetNumberField(TEXT("staged_conveyors"), Staging.NumConveyors());
    Predicted->SetNumberField(TEXT("staged_power_wires"), Staging.NumPowerWires());
    Predicted->SetNumberField(TEXT("staged_pipelines"), Staging.NumPipelines());

    FString CollisionFailure;
    int32 StructuralContacts = 0;
    FBox CombinedBounds(ForceInit);
    if (!ValidateGeneratedInternalBounds(
            Staging.Get(),
            CollisionFailure,
            StructuralContacts,
            CombinedBounds))
    {
        Result.Status = TEXT("failed");
        Result.Reason = CollisionFailure;
        return Result;
    }
    Predicted->SetNumberField(TEXT("allowed_structural_contact_pairs"), StructuralContacts);
    if (CombinedBounds.IsValid)
    {
        const FVector Size = CombinedBounds.GetSize();
        const TSharedRef<FJsonObject> BoundsJson = MakeShared<FJsonObject>();
        BoundsJson->SetNumberField(TEXT("x"), Size.X);
        BoundsJson->SetNumberField(TEXT("y"), Size.Y);
        BoundsJson->SetNumberField(TEXT("z"), Size.Z);
        Predicted->SetObjectField(TEXT("measured_native_size_cm"), BoundsJson);
    }

    int32 Adopted = 0;
    {
        FScopedDesignerMembership Membership(Designer);
        for (AFGBuildable* Buildable : Staging.GetAll())
        {
            if (!Membership.AdoptOwned(Buildable))
            {
                Result.Status = TEXT("failed");
                Result.Reason = TEXT("generated_buildable_could_not_be_adopted:") +
                    (IsValid(Buildable) ? Buildable->GetName() : TEXT("invalid"));
                return Result;
            }
        }
        Adopted = Membership.Num();
        if (Adopted != Staging.NumAllBuildables())
        {
            Result.Status = TEXT("failed");
            Result.Reason = TEXT("generated_blueprint_adopted_count_mismatch");
            return Result;
        }

        FBlueprintRecord Record;
        Record.BlueprintName = BlueprintName;
        Record.BlueprintDescription = BlueprintDescription.IsEmpty()
            ? TEXT("AI-designed native Blueprint generated by AI Factory Copilot.")
            : BlueprintDescription;

        AFGPlayerController* Controller = IsValid(Context.Player)
            ? Cast<AFGPlayerController>(Context.Player->GetController())
            : nullptr;
        Designer->SaveBlueprint(Record, Controller);
    }
    Predicted->SetNumberField(TEXT("adopted"), Adopted);

    const TSharedRef<FJsonObject> Observed = MakeShared<FJsonObject>();
    Observed->SetBoolField(TEXT("designer_left_empty"), !Designer->HasBuildings());
    Observed->SetNumberField(TEXT("staged_buildables"), Staging.NumAllBuildables());
    Observed->SetNumberField(TEXT("staged_conveyors"), Staging.NumConveyors());
    Observed->SetNumberField(TEXT("staged_power_wires"), Staging.NumPowerWires());
    Observed->SetNumberField(TEXT("staged_pipelines"), Staging.NumPipelines());

    AFGBlueprintSubsystem* Subsystem =
        AFGBlueprintSubsystem::GetBlueprintSubsystem(Context.World);
    bool bReadable = false;
    bool bExactNativeReadback = bSchemaV1;
    FString NativeReadbackFailure;
    if (IsValid(Subsystem))
    {
        Subsystem->RefreshBlueprintsAndDescriptors();
        bReadable = Subsystem->ReadBlueprintFromDisc(BlueprintName);
        if (bReadable && (bSchemaV2 || bSchemaV3))
        {
            UFGBlueprintDescriptor* Descriptor =
                Subsystem->GetBlueprintDescriptorByNameString(BlueprintName);
            Observed->SetBoolField(
                TEXT("native_readback_descriptor_resolved"),
                IsValid(Descriptor));
            if (IsValid(Descriptor))
            {
                // Load the file Satisfactory just wrote into the subsystem's
                // existing isolated Blueprint world. The subsystem owns that
                // world's lifecycle; recreating it here could invalidate native
                // preview state. This is stronger than trusting SaveBlueprint or
                // parsing only a header: all native objects are reconstructed,
                // including component references and FWireInstance endpoints.
                TArray<AFGBuildable*> NativeLoaded;
                Subsystem->LoadStoredBlueprint(
                    Descriptor,
                    FTransform::Identity,
                    NativeLoaded,
                    /*useBlueprintWorld*/ true,
                    /*designer*/ nullptr,
                    Context.Player);
                bExactNativeReadback = ValidateGeneratedNativeTopologyReadback(
                    NativeLoaded,
                    Staging.NumAllBuildables(),
                    ConfiguredManufacturers,
                    Conveyors.Num(),
                    PowerWires.Num(),
                    Pipelines.Num(),
                    Observed,
                    NativeReadbackFailure);
            }
            else
            {
                NativeReadbackFailure =
                    TEXT("native_blueprint_descriptor_did_not_resolve_after_refresh");
            }
        }
    }
    Observed->SetBoolField(TEXT("subsystem_available"), IsValid(Subsystem));
    Observed->SetBoolField(TEXT("blueprint_readable_from_disc"), bReadable);
    Observed->SetBoolField(TEXT("exact_native_topology_readback"), bExactNativeReadback);
    Observed->SetBoolField(TEXT("all_staging_is_transient"), true);
    Result.Observed = Observed;

    if (!Designer->HasBuildings() && bReadable && bExactNativeReadback)
    {
        Result.bAccepted = true;
        Result.bCommitted = true;
        Result.Status = TEXT("committed");
        Result.bUndoable = false;
        Result.UndoDescription =
            TEXT("Generated blueprints are files; delete this one from the native blueprint menu.");
        return Result;
    }

    Result.Status = TEXT("failed");
    Result.Reason = Designer->HasBuildings()
        ? TEXT("generated_blueprint_designer_membership_did_not_unwind")
        : (!bReadable
            ? TEXT("generated_blueprint_save_ran_but_native_readback_failed")
            : (NativeReadbackFailure.IsEmpty()
                ? TEXT("generated_blueprint_exact_native_topology_readback_failed")
                : NativeReadbackFailure));
    return Result;
}

}
