#pragma once

#include "Command/ChatCommandInstance.h"
#include "AIFactoryChatCommand.generated.h"

UCLASS()
class AIFACTORYCOPILOT_API AAIFactoryChatCommand final : public AChatCommandInstance
{
    GENERATED_BODY()

public:
    AAIFactoryChatCommand();

    virtual EExecutionStatus ExecuteCommand_Implementation(
        UCommandSender* Sender,
        const TArray<FString>& Arguments,
        const FString& Label) override;

private:
    static FVector GetScanCenter(UCommandSender* Sender);
    static FString JoinArguments(const TArray<FString>& Arguments, int32 StartIndex);
    static void SendHelp(UCommandSender* Sender);
};

