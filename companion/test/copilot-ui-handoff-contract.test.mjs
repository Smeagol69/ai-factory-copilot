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
    "void UAIFactoryCopilotUISubsystem::ClearConversation()",
  );

  assert.match(submit, /Question\.RightChop\(1\)\.TrimStartAndEnd\(\)/);
  assert.match(submit, /CommandLine\.ParseIntoArrayWS\(CommandTokens\)/);
  assert.match(submit, /CommandTokens\.Num\(\) >= 3/);
  assert.match(submit, /CommandTokens\[0\]\.Equals\(TEXT\("ai"\), ESearchCase::IgnoreCase\)/);
  assert.match(submit, /CommandTokens\[1\]\.Equals\(TEXT\("node"\), ESearchCase::IgnoreCase\)/);
  assert.match(submit, /CommandTokens\[2\]\.Equals\(TEXT\("place"\), ESearchCase::IgnoreCase\)/);
  assert.match(submit, /GetRemoteCallObjectOfClass\(USMLRemoteCallObject::StaticClass\(\)\)/);
  assert.match(submit, /RemoteCallObject->HandleChatCommand\(CommandLine\)/);
  assert.match(submit, /RemoteCallObject->HandleChatCommand\(CommandLine\);\s*HidePanel\(\);/);
  assert.doesNotMatch(submit, /AChatCommandSubsystem::RunChatCommand/);
});
