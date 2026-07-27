#pragma once

#include "CoreMinimal.h"
#include "UObject/Interface.h"
#include "AIFactoryDataProvider.generated.h"

/**
 * Optional compatibility contract for custom mod actors whose semantics cannot
 * be reconstructed from standard FactoryGame classes and reflection alone.
 *
 * Implementations must return JSON composed only from authoritative internal
 * state. Adapter data is kept separate from automatically discovered fields.
 */
UINTERFACE(BlueprintType)
class AIFACTORYCOPILOT_API UAIFactoryDataProvider : public UInterface
{
    GENERATED_BODY()
};

class AIFACTORYCOPILOT_API IAIFactoryDataProvider
{
    GENERATED_BODY()

public:
    UFUNCTION(BlueprintNativeEvent, BlueprintCallable, Category = "AI Factory Copilot")
    int32 GetAIFactorySchemaVersion() const;

    UFUNCTION(BlueprintNativeEvent, BlueprintCallable, Category = "AI Factory Copilot")
    FString GetAIFactoryAuthoritativeDataJson() const;

    UFUNCTION(BlueprintNativeEvent, BlueprintCallable, Category = "AI Factory Copilot")
    TArray<FName> GetAIFactoryCapabilityTags() const;

    UFUNCTION(BlueprintNativeEvent, BlueprintCallable, Category = "AI Factory Copilot")
    bool IsAIFactoryDataComplete() const;
};

