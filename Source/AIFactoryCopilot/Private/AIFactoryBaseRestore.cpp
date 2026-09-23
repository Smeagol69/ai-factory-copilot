#include "AIFactoryBaseRestore.h"
#include "AIFactoryBaseTransformMatch.h"
#include "Buildables/FGBuildable.h"
#include "Buildables/FGBuildableBlueprintDesigner.h"
#include "Buildables/FGBuildableConveyorBase.h"
#include "Buildables/FGBuildableResourceExtractorBase.h"
#include "Buildables/FGBuildableWire.h"
#include "FGBlueprintSubsystem.h"
#include "FGFactoryBlueprintTypes.h"
#include "FGBuildableSubsystem.h"
#include "FGCharacterPlayer.h"
#include "FGObjectReference.h"
#include "FGCircuitConnectionComponent.h"
#include "FGLightweightBuildableSubsystem.h"
#include "Resources/FGResourceNode.h"
#include "Dom/JsonObject.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "EngineUtils.h"
#include "HAL/FileManager.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Misc/SecureHash.h"
#include "UObject/UnrealType.h"

namespace
{
    using FBaseJson = TSharedPtr<FJsonObject>;
    FBaseJson BaseObject(const FBaseJson& Json, const TCHAR* Key)
    {
        const FBaseJson* Out = nullptr;
        return Json && Json->TryGetObjectField(Key, Out) && Out ? *Out : nullptr;
    }
    FString BaseString(const FBaseJson& Json, const TCHAR* Key)
    {
        FString Out;
        if (Json) Json->TryGetStringField(Key, Out);
        return Out;
    }
    bool BaseNumber(const FBaseJson& Json, const TCHAR* Key, double& Out)
    {
        return Json && Json->TryGetNumberField(Key, Out) && FMath::IsFinite(Out);
    }
    bool BaseTransform(const FBaseJson& Json, FTransform& Out, bool bExact)
    {
        const FBaseJson Values = BaseObject(Json, bExact ? TEXT("transform") : TEXT("archive_transform"));
        const FBaseJson Bits = BaseObject(Json, TEXT("transform_float64_le_hex"));
        double V[10]; int32 Index = 0;
        for (const TCHAR* Group : { TEXT("translation"), TEXT("rotation"), TEXT("scale3d") })
        {
            const FBaseJson Fields = BaseObject(Values, Group), HexFields = BaseObject(Bits, Group);
            const int32 Count = FString(Group) == TEXT("rotation") ? 4 : 3;
            const TCHAR* Axes[] = { TEXT("x"), TEXT("y"), TEXT("z"), TEXT("w") };
            for (int32 Axis = 0; Axis < Count; ++Axis)
            {
                double Number;
                if (!BaseNumber(Fields, Axes[Axis], Number)) return false;
                if (bExact)
                {
                    const FString Hex = BaseString(HexFields, Axes[Axis]);
                    if (Hex.Len() != 16) return false;
                    uint64 Encoded = 0;
                    for (int32 Byte = 0; Byte < 8; ++Byte)
                    {
                        uint64 Value = 0;
                        for (int32 Digit = 0; Digit < 2; ++Digit)
                        {
                            const TCHAR Ch = Hex[2 * Byte + Digit];
                            const int32 N = Ch >= '0' && Ch <= '9' ? Ch - '0' : Ch >= 'a' && Ch <= 'f' ? Ch - 'a' + 10 : -1;
                            if (N < 0) return false;
                            Value = Value * 16 + N;
                        }
                        Encoded |= Value << (Byte * 8);
                    }
                    double Exact; FMemory::Memcpy(&Exact, &Encoded, sizeof(Exact));
                    if (!FMath::IsFinite(Exact) || Exact != Number) return false;
                    Number = Exact;
                }
                V[Index++] = Number;
            }
        }
        FQuat Rotation(V[3], V[4], V[5], V[6]);
        if (FMath::Abs(Rotation.SizeSquared() - 1.0) > 0.00001) return false;
        // Preserve the saved XYZ/scale exactly. Supply the engine a unit
        // quaternion for the same saved orientation; raw save bits stay in Json.
        Rotation.Normalize();
        Out = FTransform(Rotation, FVector(V[0], V[1], V[2]), FVector(V[7], V[8], V[9]));
        return !Out.ContainsNaN();
    }
    bool BaseExact(const FTransform& A, const FTransform& B)
    {
        auto Components = [](const FTransform& T)
        {
            const FVector P = T.GetLocation(), S = T.GetScale3D();
            const FQuat Q = T.GetRotation();
            return AIFactoryBaseTransformMatch::FComponents{
                {P.X, P.Y, P.Z}, {Q.X, Q.Y, Q.Z, Q.W}, {S.X, S.Y, S.Z}};
        };
        return AIFactoryBaseTransformMatch::Matches(Components(A), Components(B));
    }
    FBaseJson BaseTransformJson(const FTransform& Transform)
    {
        FBaseJson Out = MakeShared<FJsonObject>();
        auto Vector = [](const FVector& V) { FBaseJson J = MakeShared<FJsonObject>(); J->SetNumberField(TEXT("x"), V.X); J->SetNumberField(TEXT("y"), V.Y); J->SetNumberField(TEXT("z"), V.Z); return J; };
        Out->SetObjectField(TEXT("translation"), Vector(Transform.GetLocation()));
        Out->SetObjectField(TEXT("scale3d"), Vector(Transform.GetScale3D()));
        const FQuat Q = Transform.GetRotation();
        FBaseJson R = Vector(FVector(Q.X, Q.Y, Q.Z)); R->SetNumberField(TEXT("w"), Q.W);
        Out->SetObjectField(TEXT("rotation"), R); return Out;
    }
    struct FBaseActor
    {
        FBaseJson Json;
        FString Id;
        UClass* Class = nullptr;
        FTransform Exact, Archive;
        AFGBuildable* Created = nullptr;
        AFGResourceNode* Node = nullptr;
    };
    struct FBaseLight
    {
        FString Id;
        UClass* Class = nullptr;
        FRuntimeBuildableInstanceData Data;
        int32 CreatedIndex = INDEX_NONE;
    };
    UClass* BaseAsset(const FBaseJson& Instance, const TCHAR* Field)
    {
        const FString Path = BaseString(BaseObject(Instance, Field), TEXT("pathName"));
        return Path.IsEmpty() ? nullptr : LoadObject<UClass>(nullptr, *Path);
    }
    bool BaseColor(const FBaseJson& Json, FLinearColor& Out)
    {
        double R, G, B, A;
        if (!BaseNumber(Json, TEXT("r"), R) || !BaseNumber(Json, TEXT("g"), G) || !BaseNumber(Json, TEXT("b"), B) || !BaseNumber(Json, TEXT("a"), A)) return false;
        Out = FLinearColor(R, G, B, A); return true;
    }
    bool BaseLightData(const FBaseJson& Json, FBaseLight& Out)
    {
        Out.Id = BaseString(Json, TEXT("id"));
        Out.Class = LoadObject<UClass>(nullptr, *BaseString(Json, TEXT("class_path")));
        const FBaseJson Instance = BaseObject(Json, TEXT("instance"));
        if (!Out.Class || !Out.Class->IsChildOf(AFGBuildable::StaticClass()) || !Instance || !BaseTransform(Json, Out.Data.Transform, true)) return false;
        UClass* Recipe = BaseAsset(Instance, TEXT("usedRecipe"));
        if (!Recipe || !Recipe->IsChildOf(UFGRecipe::StaticClass())) return false;
        Out.Data.BuiltWithRecipe = Recipe;
        auto& Custom = Out.Data.CustomizationData;
        struct FField { const TCHAR* Name; UClass* Base; };
        const FField Fields[] = {
            {TEXT("usedSwatchSlot"), UFGFactoryCustomizationDescriptor_Swatch::StaticClass()},
            {TEXT("usedMaterial"), UFGFactoryCustomizationDescriptor_Material::StaticClass()},
            {TEXT("usedPattern"), UFGFactoryCustomizationDescriptor_Pattern::StaticClass()},
            {TEXT("usedSkin"), UFGFactoryCustomizationDescriptor_Skin::StaticClass()},
            {TEXT("usedPaintFinish"), UFGFactoryCustomizationDescriptor_PaintFinish::StaticClass()}};
        UClass* Assets[5]{};
        for (int32 I = 0; I < 5; ++I)
        {
            Assets[I] = BaseAsset(Instance, Fields[I].Name);
            if (!BaseString(BaseObject(Instance, Fields[I].Name), TEXT("pathName")).IsEmpty() && (!Assets[I] || !Assets[I]->IsChildOf(Fields[I].Base))) return false;
        }
        if (!Assets[0]) return false;
        Custom.SwatchDesc = Assets[0]; Custom.MaterialDesc = Assets[1]; Custom.PatternDesc = Assets[2]; Custom.SkinDesc = Assets[3];
        Custom.OverrideColorData.PaintFinish = Assets[4];
        if (!BaseColor(BaseObject(Instance, TEXT("primaryColor")), Custom.OverrideColorData.PrimaryColor) || !BaseColor(BaseObject(Instance, TEXT("secondaryColor")), Custom.OverrideColorData.SecondaryColor)) return false;
        double Rotation;
        if (!BaseNumber(Instance, TEXT("patternRotation"), Rotation) || Rotation < 0 || Rotation > 255 || Rotation != FMath::FloorToDouble(Rotation)) return false;
        Custom.PatternRotation = static_cast<uint8>(Rotation);
        const FBaseJson Specific = BaseObject(Instance, TEXT("instanceSpecificData"));
        bool HasSpecific = false;
        if (!Specific || !Specific->TryGetBoolField(TEXT("hasValidStruct"), HasSpecific)) return false;
        if (HasSpecific)
        {
            const FString Path = BaseString(BaseObject(Specific, TEXT("structReference")), TEXT("pathName"));
            // Exact native data observed in this save: extensible beams. Unknown
            // dynamic structs refuse, never silently become default-length beams.
            if (Path != TEXT("/Script/FactoryGame.BuildableBeamLightweightData")) return false;
            UScriptStruct* Struct = LoadObject<UScriptStruct>(nullptr, *Path);
            const FBaseJson Properties = BaseObject(Specific, TEXT("properties"));
            double Length = 0;
            if (!Struct || !Properties || Properties->Values.Num() != 1 || !BaseNumber(BaseObject(Properties, TEXT("BeamLength")), TEXT("value"), Length) || Length <= 0) return false;
            FFloatProperty* Property = FindFProperty<FFloatProperty>(Struct, TEXT("BeamLength"));
            if (!Property) return false;
            Out.Data.TypeSpecificData.InitializeAsRaw(Struct);
            Property->SetPropertyValue_InContainer(Out.Data.TypeSpecificData.GetStructValueRaw(), static_cast<float>(Length));
        }
        return true;
    }
    // Scope the Designer exception to this explicit base import. The ordinary
    // Blueprint serializer/loader retains its original blacklist afterwards.
    class FBaseDesignerLoadScope
    {
        TArray<TSubclassOf<UObject>>* Array = nullptr;
        TArray<TSubclassOf<UObject>> Saved;
    public:
        explicit FBaseDesignerLoadScope(AFGBlueprintSubsystem* Subsystem)
        {
            FArrayProperty* Property = FindFProperty<FArrayProperty>(Subsystem->GetClass(), TEXT("mBlacklistedBlueprintCollectClasses"));
            if (!Property || !CastField<FClassProperty>(Property->Inner)) return;
            Array = Property->ContainerPtrToValuePtr<TArray<TSubclassOf<UObject>>>(Subsystem);
            Saved = *Array;
            Array->RemoveAll([](const TSubclassOf<UObject>& Class) { return Class == AFGBuildableBlueprintDesigner::StaticClass(); });
        }
        bool IsReady() const { return Array != nullptr; }
        ~FBaseDesignerLoadScope() { if (Array) *Array = Saved; }
    };
    void BaseDestroy(AFGBuildable* Actor)
    {
        if (!IsValid(Actor)) return;
        if (auto* Wire = Cast<AFGBuildableWire>(Actor)) Wire->Disconnect();
        if (auto* Extractor = Cast<AFGBuildableResourceExtractorBase>(Actor)) Extractor->DisconnectExtractableResource();
        if (auto* Conveyor = Cast<AFGBuildableConveyorBase>(Actor))
            if (auto* Subsystem = AFGBuildableSubsystem::Get(Actor->GetWorld())) Subsystem->RemoveConveyor(Conveyor);
        Actor->Destroy();
    }
}

FAIFactoryActionResult AIFactoryBaseRestore::Restore(const FAIFactoryActionContext& Context,
    const FString& PackageName, FAIFactoryUndoStep& OutUndo)
{
    const FString Action = TEXT("restore_base");
    auto Refuse = [&](const FString& Reason) { return FAIFactoryActionResult::Refuse(Action, Reason); };
    if (!Context.World || Context.World->GetNetMode() == NM_Client || !IsValid(Context.Player)) return Refuse(TEXT("restore_requires_authoritative_player_world"));
    if (PackageName.IsEmpty() || PackageName.Len() > 80) return Refuse(TEXT("invalid_base_package_name"));
    for (TCHAR Ch : PackageName) if (!(Ch >= 'a' && Ch <= 'z') && !(Ch >= 'A' && Ch <= 'Z') && !(Ch >= '0' && Ch <= '9') && Ch != '_' && Ch != '-') return Refuse(TEXT("invalid_base_package_name"));
    const FString Directory = FPaths::Combine(FPaths::ProjectSavedDir(), TEXT("AIFactoryCopilot/BaseTransfers"), PackageName);
    FString Text;
    FBaseJson Package;
    if (!FFileHelper::LoadFileToString(Text, *FPaths::Combine(Directory, TEXT("restore.json"))) ||
        !FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Text), Package) || !Package ||
        BaseString(Package, TEXT("schema")) != TEXT("aifactory.native-base/v1") ||
        BaseString(Package, TEXT("placement_policy")) != TEXT("absolute_saved_transforms_no_snapping")) return Refuse(TEXT("invalid_or_missing_base_package"));
    const FBaseJson Source = BaseObject(Package, TEXT("source"));
    const FString Map = BaseString(Source, TEXT("map_name"));
    if (Map.IsEmpty() || !Context.World->GetMapName().EndsWith(Map)) return Refuse(TEXT("base_map_does_not_match_destination"));
    double Build;
    if (!BaseNumber(Source, TEXT("build_version"), Build) || Build != 502094) return Refuse(TEXT("base_package_game_build_not_supported"));
    // The owner authorizes saved-base transfers without material charges.
    // This native import does not use construction purchases or change the
    // player's/session's no-build-cost setting. Normal write gates still apply.
    auto* Blueprint = AFGBlueprintSubsystem::Get(Context.World);
    auto* Light = AFGLightweightBuildableSubsystem::Get(Context.World);
    if (!Blueprint || !Light) return Refuse(TEXT("base_restore_subsystem_missing"));
    const TArray<TSharedPtr<FJsonValue>>* Assets = nullptr;
    if (!Package->TryGetArrayField(TEXT("required_assets"), Assets)) return Refuse(TEXT("base_asset_dependencies_missing"));
    for (const auto& Asset : *Assets)
    {
        FString Path;
        if (!Asset || !Asset->TryGetString(Path) || !Path.StartsWith(TEXT("/")) || !LoadObject<UObject>(nullptr, *Path))
            return Refuse(TEXT("required_base_asset_not_available:") + Path);
    }
    TArray<uint8> Archive, Config;
    if (!FFileHelper::LoadFileToArray(Archive, *FPaths::Combine(Directory, TEXT("actors.sbp"))) ||
        !FFileHelper::LoadFileToArray(Config, *FPaths::Combine(Directory, TEXT("actors.sbpcfg"))) ||
        FMD5::HashBytes(Archive.GetData(), Archive.Num()) != BaseString(Package, TEXT("archive_md5")) ||
        FMD5::HashBytes(Config.GetData(), Config.Num()) != BaseString(Package, TEXT("config_md5"))) return Refuse(TEXT("base_archive_checksum_mismatch"));
    const TArray<TSharedPtr<FJsonValue>> *ActorRows = nullptr, *LightRows = nullptr;
    if (!Package->TryGetArrayField(TEXT("actors"), ActorRows) || !Package->TryGetArrayField(TEXT("lightweight"), LightRows)) return Refuse(TEXT("base_piece_lists_missing"));
    double Count, ActorCount;
    if (!BaseNumber(Package, TEXT("piece_count"), Count) || !BaseNumber(Package, TEXT("actor_count"), ActorCount) || Count != ActorRows->Num() + LightRows->Num() || ActorCount != ActorRows->Num() || Count <= 0) return Refuse(TEXT("base_piece_count_mismatch"));
    TArray<FBaseActor> Actors; TArray<FBaseLight> Lights; TSet<FString> Ids; FBox Bounds(ForceInit);
    for (const auto& Value : *ActorRows)
    {
        const FBaseJson* Json = nullptr;
        if (!Value || !Value->TryGetObject(Json) || !Json) return Refuse(TEXT("invalid_base_actor"));
        FBaseActor& Actor = Actors.AddDefaulted_GetRef(); Actor.Json = *Json; Actor.Id = BaseString(*Json, TEXT("id"));
        Actor.Class = LoadObject<UClass>(nullptr, *BaseString(*Json, TEXT("class_path")));
        if (!Actor.Class || !Actor.Class->IsChildOf(AFGBuildable::StaticClass()) || !BaseTransform(*Json, Actor.Exact, true) || !BaseTransform(*Json, Actor.Archive, false) || Actor.Id.IsEmpty() || Ids.Contains(Actor.Id)) return Refuse(TEXT("invalid_or_unavailable_base_actor:") + Actor.Id);
        Ids.Add(Actor.Id); Bounds += Actor.Exact.GetLocation();
        const FString NodePath = BaseString(*Json, TEXT("resource_node"));
        if (!NodePath.IsEmpty())
        {
            // Save paths are level-relative (Persistent_Level:PersistentLevel.X),
            // whereas GetPathName() includes the full /Game/... package. Let
            // the game's save resolver bind the reference in this world.
            FObjectReferenceDisc NodeReference;
            NodeReference.PathName = NodePath;
            if (!(*Json)->TryGetStringField(TEXT("resource_node_level"), NodeReference.LevelName))
            {
                // Older transfer packages retained only the path. The known
                // persistent-map prefix is sufficient; never guess a sublevel.
                if (!NodePath.StartsWith(Map + TEXT(":"))) return Refuse(TEXT("saved_resource_node_level_missing:") + NodePath);
                NodeReference.LevelName = Map;
            }
            Actor.Node = NodeReference.Resolve<AFGResourceNode>(Context.World);
            if (!IsValid(Actor.Node) || Actor.Node->GetWorld() != Context.World)
                return Refuse(TEXT("original_resource_node_not_loaded_or_missing:") + NodePath);
            auto* Extractor = Cast<AFGBuildableResourceExtractorBase>(Actor.Class->GetDefaultObject());
            TScriptInterface<IFGExtractableResourceInterface> Resource(Actor.Node);
            if (!Extractor || !Extractor->IsAllowedOnResource(Resource)) return Refuse(TEXT("original_resource_node_incompatible:") + NodePath);
            if (Actor.Node->IsOccupied()) return Refuse(TEXT("original_resource_node_occupied:") + NodePath);
            if (!Extractor->CanOccupyResource(Resource)) return Refuse(TEXT("original_resource_node_cannot_be_occupied:") + NodePath);
        }
    }
    // Canonically equivalent quaternions (including opposite signs) cannot
    // distinguish coincident same-class actors. Refuse before native spawning.
    for (int32 I = 0; I < Actors.Num(); ++I)
        for (int32 J = 0; J < I; ++J)
            if (Actors[I].Class == Actors[J].Class && BaseExact(Actors[I].Archive, Actors[J].Archive))
                return Refuse(TEXT("ambiguous_native_actor_identity_in_package:") + Actors[I].Id);
    for (const auto& Value : *LightRows)
    {
        const FBaseJson* Json = nullptr;
        if (!Value || !Value->TryGetObject(Json) || !Json) return Refuse(TEXT("invalid_base_lightweight"));
        FBaseLight& Instance = Lights.AddDefaulted_GetRef();
        if (!BaseLightData(*Json, Instance) || Instance.Id.IsEmpty() || Ids.Contains(Instance.Id)) return Refuse(TEXT("invalid_or_unsupported_lightweight:") + BaseString(*Json, TEXT("id")));
        Ids.Add(Instance.Id); Bounds += Instance.Data.Transform.GetLocation();
    }
    TSet<AFGBuildable*> Before;
    for (TActorIterator<AFGBuildable> It(Context.World); It; ++It)
    {
        Before.Add(*It);
        if (Bounds.IsInsideOrOn(It->GetActorLocation())) return Refuse(TEXT("destination_contains_buildables_in_base_region"));
        // A HUB is session-owned; never overwrite/rebind an existing one.
        if (It->GetClass()->GetPathName().Contains(TEXT("/TradingPost/")))
            for (const FBaseActor& Actor : Actors) if (Actor.Class == It->GetClass()) return Refuse(TEXT("destination_already_has_a_hub"));
    }
    TMap<UClass*, TSet<int32>> BeforeLights;
    for (const auto& Pair : Light->GetAllLightweightBuildableInstances())
        for (int32 I = 0; I < Pair.Value.Num(); ++I) if (Pair.Value[I].IsValid())
        {
            BeforeLights.FindOrAdd(Pair.Key.Get()).Add(I);
            if (Bounds.IsInsideOrOn(Pair.Value[I].Transform.GetLocation())) return Refuse(TEXT("destination_contains_lightweight_pieces_in_base_region"));
        }
    FAIFactoryActionResult Result; Result.Action = Action; Result.bAccepted = true; Result.bDryRun = Context.bDryRun;
    Result.Predicted = MakeShared<FJsonObject>(); Result.Predicted->SetStringField(TEXT("base_name"), PackageName);
    Result.Predicted->SetNumberField(TEXT("pieces"), Count); Result.Predicted->SetStringField(TEXT("placement"), TEXT("absolute_saved_transforms_no_snapping"));
    Result.Predicted->SetStringField(TEXT("cost_policy"), TEXT("saved_base_transfer_no_material_charge"));
    Result.Predicted->SetStringField(TEXT("resource_resolution"), TEXT("source_save_reference_in_destination_world"));
    Result.Predicted->SetStringField(TEXT("position_and_scale_comparison"), TEXT("exact_saved_values"));
    Result.Predicted->SetStringField(TEXT("rotation_comparison"), TEXT("normalized_quaternion_equivalence"));
    Result.Predicted->SetNumberField(TEXT("rotation_component_tolerance"), AIFactoryBaseTransformMatch::RotationComponentTolerance);
    TArray<TSharedPtr<FJsonValue>> NodeBindings;
    for (const FBaseActor& Actor : Actors) if (Actor.Node)
    {
        FBaseJson Binding = MakeShared<FJsonObject>();
        Binding->SetStringField(TEXT("source_id"), Actor.Id);
        Binding->SetStringField(TEXT("saved_resource_node"), BaseString(Actor.Json, TEXT("resource_node")));
        Binding->SetStringField(TEXT("resolved_resource_node"), Actor.Node->GetPathName());
        NodeBindings.Add(MakeShared<FJsonValueObject>(Binding));
    }
    Result.Predicted->SetArrayField(TEXT("resource_node_bindings"), NodeBindings);
    if (Context.bDryRun) { Result.Status = TEXT("dry_run"); return Result; }

    // Unique private descriptor name; never overwrite an existing user Blueprint.
    const FString NativeName = TEXT("AIFactoryTransfer_") + FGuid::NewGuid().ToString(EGuidFormats::Digits);
    const FString Session = Blueprint->GetSessionBlueprintPath();
    const FString Sbp = FPaths::Combine(Session, NativeName + TEXT(".sbp"));
    const FString Cfg = FPaths::Combine(Session, NativeName + TEXT(".sbpcfg"));
    IFileManager::Get().MakeDirectory(*Session, true);
    if (!FFileHelper::SaveArrayToFile(Archive, *Sbp) || !FFileHelper::SaveArrayToFile(Config, *Cfg))
    {
        IFileManager::Get().Delete(*Sbp); IFileManager::Get().Delete(*Cfg);
        return Refuse(TEXT("could_not_stage_native_base_archive"));
    }
    Blueprint->RefreshBlueprintsAndDescriptors();
    const bool Read = Blueprint->ReadBlueprintFromDisc(NativeName);
    UFGBlueprintDescriptor* Descriptor = Read ? Blueprint->GetBlueprintDescriptorByNameString(NativeName) : nullptr;
    FString Failure;
    TArray<TSharedPtr<FJsonValue>> LoaderReadback;
    TArray<TSharedPtr<FJsonValue>> TransformFailures;
    TArray<AFGBuildable*> Loaded;
    if (!Descriptor) Failure = TEXT("native_base_archive_not_readable");
    else
    {
        FBaseDesignerLoadScope Scope(Blueprint);
        if (!Scope.IsReady()) Failure = TEXT("native_designer_load_scope_unavailable");
        else Blueprint->LoadStoredBlueprint(Descriptor, FTransform::Identity, Loaded, false, nullptr, Context.Player, nullptr,
            [&](AFGBuildable* Buildable, int32)
            {
                if (!IsValid(Buildable)) { Failure = TEXT("native_loader_returned_invalid_actor"); return; }
                FBaseJson NativeRow = MakeShared<FJsonObject>();
                NativeRow->SetStringField(TEXT("class_path"), Buildable->GetClass()->GetPathName());
                NativeRow->SetStringField(TEXT("runtime_id"), Buildable->GetPathName());
                NativeRow->SetObjectField(TEXT("transform_before_exact_restore"), BaseTransformJson(Buildable->GetActorTransform()));
                LoaderReadback.Add(MakeShared<FJsonValueObject>(NativeRow));
                FBaseActor* Match = nullptr;
                for (FBaseActor& Candidate : Actors)
                    if (!Candidate.Created && Candidate.Class == Buildable->GetClass() && BaseExact(Candidate.Archive, Buildable->GetActorTransform()))
                    {
                        if (Match) { Failure = TEXT("ambiguous_native_actor_identity"); return; }
                        Match = &Candidate;
                    }
                if (!Match) { if (Failure.IsEmpty()) Failure = TEXT("native_actor_has_unexpected_class_or_transform:") + Buildable->GetClass()->GetPathName(); return; }
                Match->Created = Buildable;
                NativeRow->SetStringField(TEXT("source_id"), Match->Id);
                if (!Buildable->SetActorTransform(Match->Exact, false, nullptr, ETeleportType::TeleportPhysics) && Failure.IsEmpty())
                    Failure = TEXT("native_actor_transform_set_failed:") + Match->Id;
            },
            [&]()
            {
                for (FBaseActor& Actor : Actors)
                    if (!IsValid(Actor.Created)) { if (Failure.IsEmpty()) Failure = TEXT("native_loader_omitted_saved_actor:") + Actor.Id; }
                    else if (Actor.Node)
                    {
                        auto* Extractor = Cast<AFGBuildableResourceExtractorBase>(Actor.Created);
                        if (!Extractor) Failure = TEXT("saved_extractor_class_mismatch");
                        else Extractor->SetResourceNode(Actor.Node);
                    }
            });
    }
    IFileManager::Get().Delete(*Sbp); IFileManager::Get().Delete(*Cfg);
    Blueprint->RefreshBlueprintsAndDescriptors();
    TMap<FString, AFGBuildable*> CreatedById;
    for (FBaseActor& Actor : Actors)
    {
        if (!IsValid(Actor.Created) || !BaseExact(Actor.Exact, Actor.Created->GetActorTransform()))
        {
            if (Failure.IsEmpty()) Failure = TEXT("native_actor_exact_transform_readback_failed:") + Actor.Id;
            FBaseJson Mismatch = MakeShared<FJsonObject>();
            Mismatch->SetStringField(TEXT("source_id"), Actor.Id);
            Mismatch->SetObjectField(TEXT("expected_transform"), BaseTransformJson(Actor.Exact));
            if (IsValid(Actor.Created)) Mismatch->SetObjectField(TEXT("observed_transform"), BaseTransformJson(Actor.Created->GetActorTransform()));
            TransformFailures.Add(MakeShared<FJsonValueObject>(Mismatch));
            continue;
        }
        CreatedById.Add(Actor.Id, Actor.Created);
        if (Actor.Node)
        {
            auto* Extractor = Cast<AFGBuildableResourceExtractorBase>(Actor.Created);
            if (!Extractor || Extractor->GetResourceNode() != Actor.Node) Failure = TEXT("restored_miner_resource_readback_failed");
        }
    }
    // Resolve the recorded component identity, not merely a circuit count.
    auto Endpoint = [&](const FBaseJson& Json) -> UFGCircuitConnectionComponent*
    {
        AFGBuildable* const* Owner = CreatedById.Find(BaseString(Json, TEXT("actor_id")));
        if (!Owner) return nullptr;
        TInlineComponentArray<UFGCircuitConnectionComponent*> Components(*Owner);
        for (auto* Component : Components) if (Component->GetName() == BaseString(Json, TEXT("component_name"))) return Component;
        return nullptr;
    };
    if (Failure.IsEmpty()) for (FBaseActor& Actor : Actors)
        if (const FBaseJson WireJson = BaseObject(Actor.Json, TEXT("wire")))
        {
            auto* Wire = Cast<AFGBuildableWire>(Actor.Created);
            auto* From = Endpoint(BaseObject(WireJson, TEXT("from"))); auto* To = Endpoint(BaseObject(WireJson, TEXT("to")));
            if (!Wire || !From || !To) Failure = TEXT("restored_wire_endpoint_missing");
            else
            {
                if (Wire->GetConnection(0) != From || Wire->GetConnection(1) != To) { Wire->Disconnect(); Wire->Connect(From, To); }
                if (Wire->GetConnection(0) != From || Wire->GetConnection(1) != To) Failure = TEXT("restored_wire_endpoint_readback_failed");
            }
        }
    if (Failure.IsEmpty()) for (FBaseLight& Instance : Lights)
    {
        FRuntimeBuildableInstanceData RuntimeData = Instance.Data;
        Instance.CreatedIndex = Light->AddFromBuildableInstanceData(Instance.Class, RuntimeData);
        const auto* Observed = Light->GetRuntimeDataForBuildableClassAndIndex(Instance.Class, Instance.CreatedIndex);
        if (!Observed || !Observed->IsValid() || !BaseExact(Observed->Transform, Instance.Data.Transform) ||
            !(Observed->CustomizationData == Instance.Data.CustomizationData) || !Observed->TypeSpecificData.Identical(Instance.Data.TypeSpecificData))
        { Failure = TEXT("lightweight_exact_readback_failed:") + Instance.Id; break; }
    }
    TArray<AFGBuildable*> NewActors;
    for (TActorIterator<AFGBuildable> It(Context.World); It; ++It) if (!Before.Contains(*It)) NewActors.Add(*It);
    if (Failure.IsEmpty() && NewActors.Num() != Actors.Num()) Failure = TEXT("native_restore_created_missing_or_extra_actors");
    TArray<TPair<UClass*, int32>> NewLights;
    for (const auto& Pair : Light->GetAllLightweightBuildableInstances())
        for (int32 I = 0; I < Pair.Value.Num(); ++I) if (Pair.Value[I].IsValid() && !BeforeLights.FindOrAdd(Pair.Key.Get()).Contains(I)) NewLights.Emplace(Pair.Key.Get(), I);
    if (Failure.IsEmpty() && NewLights.Num() != Lights.Num()) Failure = TEXT("native_restore_created_missing_or_extra_lightweights");
    if (!Failure.IsEmpty())
    {
        for (const auto& Pair : NewLights) Light->RemoveByInstanceIndex(Pair.Key, Pair.Value);
        for (int32 I = NewActors.Num() - 1; I >= 0; --I) BaseDestroy(NewActors[I]);
        Result.bAccepted = false; Result.Status = TEXT("failed"); Result.Reason = Failure;
        Result.Observed = MakeShared<FJsonObject>(); Result.Observed->SetBoolField(TEXT("rollback_attempted"), true);
        Result.Observed->SetArrayField(TEXT("native_loader_readback"), LoaderReadback);
        Result.Observed->SetArrayField(TEXT("exact_transform_readback_failures"), TransformFailures);
        bool RolledBack = true;
        for (AFGBuildable* Actor : NewActors) if (IsValid(Actor) && !Actor->IsActorBeingDestroyed()) RolledBack = false;
        for (const auto& Pair : NewLights)
        {
            const auto* Data = Light->GetRuntimeDataForBuildableClassAndIndex(Pair.Key, Pair.Value);
            if (Data && Data->IsValid()) RolledBack = false;
        }
        Result.Observed->SetBoolField(TEXT("created_buildables_removed"), RolledBack);
        return Result;
    }
    OutUndo.Action = Action; OutUndo.Player = Context.Player; OutUndo.RecordedAt = FDateTime::UtcNow(); OutUndo.Description = TEXT("Restored base ") + PackageName;
    TArray<TSharedPtr<FJsonValue>> Readback;
    for (const FBaseActor& Actor : Actors)
    {
        OutUndo.DismantleActors.Add(Actor.Created); OutUndo.SpawnedBuildables.Add(Actor.Created);
        Result.CreatedActorIds.Add(Actor.Created->GetPathName());
        FBaseJson Row = MakeShared<FJsonObject>(); Row->SetStringField(TEXT("source_id"), Actor.Id); Row->SetStringField(TEXT("runtime_id"), Actor.Created->GetPathName());
        Row->SetStringField(TEXT("class_path"), Actor.Class->GetPathName()); Row->SetObjectField(TEXT("transform"), BaseTransformJson(Actor.Created->GetActorTransform()));
        Readback.Add(MakeShared<FJsonValueObject>(Row));
    }
    for (const FBaseLight& Instance : Lights)
    {
        FAIFactoryLightweightUndoRef Ref; Ref.BuildableClass = Instance.Class; Ref.BuiltWithRecipe = Instance.Data.BuiltWithRecipe; Ref.RuntimeIndex = Instance.CreatedIndex; Ref.Transform = Instance.Data.Transform;
        OutUndo.LightweightBuildables.Add(Ref);
        const auto* Observed = Light->GetRuntimeDataForBuildableClassAndIndex(Instance.Class, Instance.CreatedIndex);
        FBaseJson Row = MakeShared<FJsonObject>(); Row->SetStringField(TEXT("source_id"), Instance.Id);
        Row->SetStringField(TEXT("runtime_id"), FString::Printf(TEXT("%s:%d"), *Instance.Class->GetPathName(), Instance.CreatedIndex));
        Row->SetStringField(TEXT("class_path"), Instance.Class->GetPathName()); Row->SetObjectField(TEXT("transform"), BaseTransformJson(Observed->Transform));
        Readback.Add(MakeShared<FJsonValueObject>(Row));
    }
    Result.Observed = MakeShared<FJsonObject>(); Result.Observed->SetArrayField(TEXT("pieces"), Readback);
    Result.Observed->SetBoolField(TEXT("all_saved_transforms_match"), true); Result.Observed->SetNumberField(TEXT("piece_count"), Readback.Num());
    Result.Observed->SetStringField(TEXT("scope"), TEXT("created_by_this_restore")); Result.Observed->SetBoolField(TEXT("complete"), true); Result.Observed->SetStringField(TEXT("map_name"), Map);
    Result.Warnings.Add(TEXT("Immediate native geometry, miner and power-wire readback passed. Save/reload persistence and arbitrary mod state require a live check."));
    Result.bCommitted = true; Result.bUndoable = true; Result.Status = TEXT("committed"); Result.UndoDescription = OutUndo.Description;
    return Result;
}
