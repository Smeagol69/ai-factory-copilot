import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const ui = fs.readFileSync(
  new URL(
    "../../Source/AIFactoryCopilot/Private/AIFactoryCopilotUISubsystem.cpp",
    import.meta.url,
  ),
  "utf8",
);

function functionSlice(source, start, next) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(next, startIndex);
  assert.ok(startIndex >= 0 && endIndex > startIndex, `${start} must precede ${next}`);
  return source.slice(startIndex, endIndex);
}

test("closing the Copilot panel restores every Slate user to the game viewport", () => {
  const hide = functionSlice(
    ui,
    "void UAIFactoryCopilotUISubsystem::HidePanel()",
    "void UAIFactoryCopilotUISubsystem::SubmitQuestion()",
  );

  const removal = hide.indexOf("RemoveViewportWidgetContent");
  const gameOnly = hide.indexOf("SetInputMode(FInputModeGameOnly())");
  const viewportFocus = hide.indexOf("SetAllUserFocusToGameViewport");
  assert.ok(removal >= 0, "HidePanel must remove its viewport widget");
  assert.ok(gameOnly > removal, "game-only input must follow widget removal");
  assert.ok(viewportFocus > gameOnly, "all-user viewport focus must follow game-only input");
  assert.match(hide, /SetAllUserFocusToGameViewport\(EFocusCause::SetDirectly\)/);
  assert.match(hide, /bFocusInputOnNextTick = false/);
  assert.doesNotMatch(hide, /SetAllUserFocus\(InputBox/);
});

test("the Insert panel forwards only the documented creative-node command through SML's server RPC", () => {
  const submit = functionSlice(
    ui,
    "void UAIFactoryCopilotUISubsystem::SubmitQuestion()",
    "TSharedRef<SWidget> UAIFactoryCopilotUISubsystem::BuildCreativeNodeSection()",
  );
  const forward = functionSlice(
    ui,
    "bool UAIFactoryCopilotUISubsystem::ForwardCreativeNodePlacementCommand(",
    "void UAIFactoryCopilotUISubsystem::ClearConversation()",
  );

  assert.match(submit, /Question\.RightChop\(1\)\.TrimStartAndEnd\(\)/);
  assert.match(submit, /CommandLine\.ParseIntoArrayWS\(CommandTokens\)/);
  assert.match(submit, /CommandTokens\.Num\(\) >= 3/);
  assert.match(submit, /CommandTokens\[0\]\.Equals\(TEXT\("ai"\), ESearchCase::IgnoreCase\)/);
  assert.match(submit, /CommandTokens\[1\]\.Equals\(TEXT\("node"\), ESearchCase::IgnoreCase\)/);
  assert.match(submit, /CommandTokens\[2\]\.Equals\(TEXT\("place"\), ESearchCase::IgnoreCase\)/);
  assert.match(submit, /ForwardCreativeNodePlacementCommand\(CommandLine, Question\)/);
  assert.match(forward, /CommandLine\.ParseIntoArrayWS\(CommandTokens\)/);
  assert.match(forward, /GetRemoteCallObjectOfClass\(USMLRemoteCallObject::StaticClass\(\)\)/);
  assert.match(forward, /RemoteCallObject->HandleChatCommand\(CommandLine\)/);
  assert.match(forward, /RemoteCallObject->HandleChatCommand\(CommandLine\);\s*HidePanel\(\);/);
  assert.doesNotMatch(forward, /AChatCommandSubsystem::RunChatCommand/);
  assert.doesNotMatch(submit, /AChatCommandSubsystem::RunChatCommand/);
});

test("the Creative Node picker only generates the existing server-validated placement handoff", () => {
  const picker = functionSlice(
    ui,
    "TSharedRef<SWidget> UAIFactoryCopilotUISubsystem::BuildCreativeNodeSection()",
    "void UAIFactoryCopilotUISubsystem::ArmCreativeNodeFromPanel(",
  );
  const arm = functionSlice(
    ui,
    "void UAIFactoryCopilotUISubsystem::ArmCreativeNodeFromPanel(",
    "bool UAIFactoryCopilotUISubsystem::ForwardCreativeNodePlacementCommand(",
  );

  assert.match(picker, /SAssignNew\(CreativeNodeResourceBox, SEditableTextBox\)/);
  assert.match(picker, /ArmCreativeNodeFromPanel\(TEXT\("impure"\)\)/);
  assert.match(picker, /ArmCreativeNodeFromPanel\(TEXT\("normal"\)\)/);
  assert.match(picker, /ArmCreativeNodeFromPanel\(TEXT\("pure"\)\)/);
  assert.match(arm, /TEXT\("ai node place %s %s"\)/);
  assert.match(arm, /ForwardCreativeNodePlacementCommand\(/);
  assert.match(arm, /Resource\.Contains\(TEXT\("\\r"\)\)/);
  assert.match(arm, /Resource\.Contains\(TEXT\("\\n"\)\)/);
  assert.match(arm, /bFocusInputOnNextTick = false/);
  assert.doesNotMatch(arm, /SpawnActor|SetActorLocation|ConfigureCreativeNode|ClientArmCreativeResourceNode/);
});

test("native Blueprint export can adopt dismantle marks without dismantling", () => {
  const section = functionSlice(
    ui,
    "TSharedRef<SWidget> UAIFactoryCopilotUISubsystem::BuildSelectionSection()",
    "void UAIFactoryCopilotUISubsystem::RefreshSelectionCost()",
  );
  const adopt = ui.slice(ui.indexOf("void UAIFactoryCopilotUISubsystem::SelectDismantleMarks()"));
  assert.ok(adopt.length > 0, "SelectDismantleMarks must remain in the source");

  assert.match(section, /Use dismantle marks/);
  assert.match(section, /SelectDismantleMarks\(\)/);
  assert.match(adopt, /GetPendingDismantleActors\(\)/);
  assert.match(adopt, /GetSelectedActor\(\)/);
  assert.match(adopt, /ClearSelectionPreview\(\)/);
  assert.match(adopt, /RefreshSelectionCost\(\)/);
  assert.match(adopt, /AIFactoryOverlay::DrawSelection/);
  assert.match(adopt, /GetNumPendingDismantleActors\(true\)/);
  assert.match(adopt, /SelectionCategoryEnabled\[Category\]/);
  assert.doesNotMatch(adopt, /DismantleCurrentBuildables|Server_DismantleActors/);
});
