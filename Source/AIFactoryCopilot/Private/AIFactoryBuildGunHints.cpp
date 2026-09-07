#include "AIFactoryBuildGunHints.h"

#include "Blueprint/UserWidget.h"
#include "Blueprint/WidgetBlueprintLibrary.h"
#include "FGPlayerController.h"
#include "InputCoreTypes.h"
#include "UI/FGButtonHintBar.h"
#include "UI/FGUserWidget.h"

namespace
{
    /** Local axis names, matching FAIFactoryAxisRotationState's 0/1/2. */
    const TCHAR* AxisName(const int32 Axis)
    {
        return Axis == 0 ? TEXT("X") : Axis == 1 ? TEXT("Y") : TEXT("Z");
    }

    FFGButtonHintDescription MakeHint(
        const FKey& Key,
        const FKey& ComboKey,
        const FString& Text)
    {
        FFGButtonHintDescription Hint;
        // Key rather than InputAction: these are the mod's own bindings and
        // have no entry in FactoryGame's mapping contexts to look up.
        Hint.Key = Key;
        Hint.ComboKey = ComboKey;
        Hint.HintText = FText::FromString(Text);
        Hint.Variant = EFGKeyHintVariant::Default;
        Hint.Disabled = false;
        return Hint;
    }
}

UFGButtonHintBar* FAIFactoryBuildGunHints::FindGameplayHintBar(AFGPlayerController* const Controller)
{
    if (!IsValid(Controller))
    {
        return nullptr;
    }

    TArray<UUserWidget*> Found;
    UWidgetBlueprintLibrary::GetAllWidgetsOfClass(
        Controller, Found, UFGButtonHintBar::StaticClass(), false);

    for (UUserWidget* const Widget : Found)
    {
        UFGButtonHintBar* const Candidate = Cast<UFGButtonHintBar>(Widget);
        if (!IsValid(Candidate) || Candidate->mHintBarIsAlwaysHidden)
        {
            continue;
        }
        // Only the on-screen gameplay bar is in the viewport and visible while
        // the Build Gun is out; menu bars live inside their own windows.
        if (Candidate->IsInViewport() && Candidate->IsVisible())
        {
            return Candidate;
        }
    }
    return nullptr;
}

void FAIFactoryBuildGunHints::RemoveOwnedHints(UFGButtonHintBar* const Target)
{
    if (!IsValid(Target) || OwnedHintTexts.Num() == 0)
    {
        return;
    }
    // Backwards so each removal cannot shift an index still to be examined.
    for (int32 Index = Target->mButtonHints.Num() - 1; Index >= 0; --Index)
    {
        const FString Text = Target->mButtonHints[Index].HintText.ToString();
        if (OwnedHintTexts.Contains(Text))
        {
            FFGButtonHintDescription Removed;
            Target->RemoveButtonHintAtIndex(Index, Removed);
        }
    }
}

void FAIFactoryBuildGunHints::Update(
    AFGPlayerController* const Controller,
    const bool bCanStart,
    const bool bEnabled,
    const int32 Axis,
    const FRotator& Rotation)
{
    UFGButtonHintBar* const Target = FindGameplayHintBar(Controller);

    // The bar this was last attached to is gone or has been replaced: drop the
    // ownership record rather than trying to edit a dead widget.
    if (Bar.Get() != Target)
    {
        if (UFGButtonHintBar* const Previous = Bar.Get(); IsValid(Previous))
        {
            RemoveOwnedHints(Previous);
        }
        OwnedHintTexts.Reset();
        LastSignature.Reset();
        Bar = Target;
    }

    if (!IsValid(Target))
    {
        OwnedHintTexts.Reset();
        LastSignature.Reset();
        return;
    }

    TArray<FString> Desired;
    if (bEnabled)
    {
        Desired.Add(TEXT("Rotate axis: exit"));
        Desired.Add(FString::Printf(
            TEXT("Axis %s  —  P %.0f°  Y %.0f°  R %.0f°"),
            AxisName(Axis),
            Rotation.Pitch,
            Rotation.Yaw,
            Rotation.Roll));
        Desired.Add(TEXT("Turn  (Ctrl 1°, Shift 45°)"));
    }
    else if (bCanStart)
    {
        Desired.Add(TEXT("Rotate axis"));
    }

    // Re-assert only when what should be showing changed, or when the bar
    // rebuilt itself and dropped the rows.
    FString Signature;
    for (const FString& Text : Desired)
    {
        Signature.Append(Text);
        Signature.AppendChar(TEXT('|'));
    }
    bool bStillPresent = true;
    for (const FString& Text : OwnedHintTexts)
    {
        const bool bFound = Target->mButtonHints.ContainsByPredicate(
            [&Text](const FFGButtonHintDescription& Hint)
            {
                return Hint.HintText.ToString() == Text;
            });
        if (!bFound)
        {
            bStillPresent = false;
            break;
        }
    }
    if (Signature == LastSignature && bStillPresent)
    {
        return;
    }

    RemoveOwnedHints(Target);
    OwnedHintTexts.Reset();

    static const TArray<TPair<FKey, FKey>> Keys = {
        { EKeys::F5, FKey() },
        { EKeys::PageUp, EKeys::PageDown },
        { EKeys::MouseScrollUp, FKey() },
    };
    for (int32 Index = 0; Index < Desired.Num(); ++Index)
    {
        const TPair<FKey, FKey>& Binding = Keys[Index];
        Target->InsertButtonHint(
            MakeHint(Binding.Key, Binding.Value, Desired[Index]), Index);
        OwnedHintTexts.Add(Desired[Index]);
    }
    LastSignature = Signature;
}

void FAIFactoryBuildGunHints::Clear()
{
    if (UFGButtonHintBar* const Target = Bar.Get(); IsValid(Target))
    {
        RemoveOwnedHints(Target);
    }
    Bar.Reset();
    OwnedHintTexts.Reset();
    LastSignature.Reset();
}
