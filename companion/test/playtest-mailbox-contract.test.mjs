import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = (relative) => {
  const url = new URL(`../../${relative}`, import.meta.url);
  assert.ok(fs.existsSync(url), `missing native playtest source: ${relative}`);
  return fs.readFileSync(url, "utf8");
};

test("native playtest ingress is explicitly disabled by default and runs only on the observer game thread", () => {
  assert.equal(JSON.parse(source("Config/AIFactoryCopilot.cfg")).enablePlaytestMailbox, false);
  assert.match(source("Source/AIFactoryCopilot/Public/AIFactorySettings.h"), /bEnablePlaytestMailbox\s*=\s*false/);
  assert.match(source("Source/AIFactoryCopilot/Private/AIFactorySettings.cpp"), /TryGetBoolField\(TEXT\("enablePlaytestMailbox"\), Settings\.bEnablePlaytestMailbox\)/);
  const subsystem = source("Source/AIFactoryCopilot/Private/AIFactorySubsystem.cpp");
  assert.match(subsystem, /PlaytestMailbox\.Tick\(\*this\)/);
  const mailbox = source("Source/AIFactoryCopilot/Private/AIFactoryPlaytestMailbox.cpp");
  assert.match(mailbox, /IsInGameThread\(\)/);
  assert.match(mailbox, /bEnablePlaytestMailbox/);
  assert.match(mailbox, /NM_Client/);
  assert.doesNotMatch(mailbox, /CreateProc|ExecProcess|ConsoleCommand|SendInput|ExecutePlan/);
});

test("mailbox bounds identity, scope, time, question and operation before dispatch", () => {
  const mailbox = source("Source/AIFactoryCopilot/Private/AIFactoryPlaytestMailbox.cpp");
  for (const field of ["aifactory.playtest-request/v1", "expected_map", "expected_session", "expires_at_utc", "askall", "capture", "look"])
    assert.ok(mailbox.includes(field), `missing request contract ${field}`);
  assert.match(mailbox, /DigitsWithHyphensLower/);
  assert.match(mailbox, /ParseIso8601/);
  assert.match(mailbox, /FromMinutes\(10\)/);
  assert.match(mailbox, /MaximumQuestionCharacters\s*=\s*4000/);
  assert.match(mailbox, /MaximumRequestBytes\s*=\s*16384/);
  assert.match(mailbox, /unexpected_request_field/);
  assert.match(mailbox, /question_contains_control_character/);
  assert.match(mailbox, /expected_world_scope_does_not_match/);
  assert.match(mailbox, /operation_not_supported/);
});

test("accepted request IDs are persisted before game dispatch and never evicted for replay", () => {
  const mailbox = source("Source/AIFactoryCopilot/Private/AIFactoryPlaytestMailbox.cpp");
  assert.match(mailbox, /\.consumed/);
  assert.match(mailbox, /request_id_already_consumed/);
  assert.match(mailbox, /consumed_marker_invalid/);
  assert.match(mailbox, /consumed_marker_capacity_reached/);
  assert.match(mailbox, /persist_consumed_id_failed/);
  assert.match(mailbox, /another_request_is_in_flight/);
  assert.ok(mailbox.indexOf("if (!PersistConsumedId(") < mailbox.indexOf("Subsystem.AskBridge("));
  assert.doesNotMatch(mailbox, /ConsumedRequestIds\.(Remove|Pop|Reset|Empty)/);
  assert.match(mailbox, /interrupted_after_consumption_outcome_unknown/);
});

test("consumption publishes immutable per-ID markers with the verified no-replace platform move", () => {
  const mailbox = source("Source/AIFactoryCopilot/Private/AIFactoryPlaytestMailbox.cpp");
  assert.match(mailbox, /AIFactoryPlaytestPublishImmutable/);
  assert.match(mailbox, /Platform\.MoveFile\(\*Path, \*Staging\)/);
  assert.match(mailbox, /GetPlatformPhysical\(\)/);
  assert.match(mailbox, /Writer->Flush\(true\)/);
  assert.match(mailbox, /Writer\.Reset\(\)/);
  assert.match(mailbox, /orphan_consumption_staging_file/);
  assert.doesNotMatch(mailbox, /SaveLedger|\.Delete\(|\.DeleteFile\(/);
  assert.match(mailbox, /OriginalScope/);
});

test("loaded-world and exact controller scope are checked before dispatch and native action execution", () => {
  const mailbox = source("Source/AIFactoryCopilot/Private/AIFactoryPlaytestMailbox.cpp");
  const subsystem = source("Source/AIFactoryCopilot/Private/AIFactorySubsystem.cpp");
  for (const name of ["world_instance", "player", "expected_world_instance", "expected_player"])
    assert.ok(mailbox.includes(name), `missing exact playtest scope ${name}`);
  assert.match(mailbox, /FGuid::NewGuid\(\)/);
  assert.match(mailbox, /SelectedController/);
  assert.match(mailbox, /ValidateActiveScope/);
  const callbackScope = subsystem.indexOf("playtest_scope_changed_before_native_execution");
  const execution = subsystem.indexOf("AIFactoryActions::ExecutePlan(", callbackScope);
  assert.ok(callbackScope > subsystem.indexOf("HttpRequest->OnProcessRequestComplete()") && execution > callbackScope);
  assert.match(subsystem.slice(callbackScope - 300, callbackScope + 300), /ValidateActiveScope/);
});

test("askall results are correlated after native outcomes persist, and never include private payloads", () => {
  const subsystem = source("Source/AIFactoryCopilot/Private/AIFactorySubsystem.cpp");
  const writePosition = subsystem.indexOf("Could not persist enriched game action results");
  const completePosition = subsystem.indexOf("PlaytestMailbox.CompleteAsk(", writePosition);
  assert.ok(writePosition >= 0 && completePosition > writePosition);
  assert.match(subsystem, /PlaytestRequestId/);
  const mailbox = source("Source/AIFactoryCopilot/Private/AIFactoryPlaytestMailbox.cpp");
  assert.match(mailbox, /results/);
  assert.match(mailbox, /aifactory.playtest-result\/v1/);
  assert.match(mailbox, /screenshot_requested/);
  assert.match(mailbox, /capture_exported/);
  assert.match(mailbox, /RunChatCommand\(TEXT\("aifactory (?:look|export all)"\)/);
  assert.doesNotMatch(mailbox, /SetStringField\(TEXT\("(?:question|reply|api_key|image|snapshot)"\)/);
});

test("the mailbox publishes fresh game identity without a full snapshot or remote request", () => {
  const mailbox = source("Source/AIFactoryCopilot/Private/AIFactoryPlaytestMailbox.cpp");
  assert.match(mailbox, /aifactory.playtest-status\/v1/);
  assert.match(mailbox, /status\.json/);
  assert.match(mailbox, /last_tick_game_utc/);
  assert.match(mailbox, /in_flight_id/);
  assert.match(mailbox, /GetMapName\(\)/);
  assert.match(mailbox, /GetSessionName\(\)/);
  assert.doesNotMatch(mailbox, /BuildSnapshot\(|CreateRequest\(/);
});

test("the first ready heartbeat follows marker recovery and refuses unhealthy, full or busy mailboxes", () => {
  const mailbox = source("Source/AIFactoryCopilot/Private/AIFactoryPlaytestMailbox.cpp");
  const tick = mailbox.slice(mailbox.indexOf("void FAIFactoryPlaytestMailbox::Tick("));
  const load = tick.indexOf("LoadConsumedMarkers(Subsystem)");
  const ready = tick.indexOf('SetBoolField(TEXT("accepting_requests")');
  const heartbeat = tick.indexOf('TEXT("status.json")');
  assert.ok(load >= 0 && ready > load && heartbeat > ready);
  assert.match(tick, /bAcceptingRequests\s*=\s*bLiveWorld\s*&&\s*bEnabled\s*&&\s*bMarkersHealthy\s*&&\s*LedgerFailure\.IsEmpty\(\)/);
  assert.match(tick, /ConsumedRequestIds\.Num\(\)\s*<\s*AIFactoryPlaytestMaximumConsumedIds/);
  assert.match(tick, /InFlightRequestId\.IsEmpty\(\)/);
  assert.match(tick, /if \(!bAcceptingRequests\) return/);
});

test("refused requests retain a valid submitted identity while current_scope reports the actual world", () => {
  const mailbox = source("Source/AIFactoryCopilot/Private/AIFactoryPlaytestMailbox.cpp");
  const tick = mailbox.slice(mailbox.indexOf("void FAIFactoryPlaytestMailbox::Tick("));
  const refusal = tick.slice(tick.indexOf("const auto Refuse"), tick.indexOf("const TSet<FString> Fields"));
  assert.match(refusal, /WriteResult\([^;]+nullptr, RequestedScope\)/s);
  const requested = tick.slice(tick.indexOf("TSharedPtr<FJsonObject> RequestedScope"), tick.indexOf("const auto Refuse"));
  for (const field of ["map", "session", "world_instance", "player"])
    assert.ok(requested.includes(`TEXT("expected_${field}")`) && requested.includes(`TEXT("${field}")`));
  assert.match(requested, /AIFactoryPlaytestUuid\(RequestedWorldInstance\)/);
  assert.match(requested, /!RequestedMap\.IsEmpty\(\)/);
  assert.match(requested, /!RequestedSession\.IsEmpty\(\)/);
  assert.match(requested, /!RequestedPlayer\.IsEmpty\(\)/);
  assert.match(mailbox, /SetObjectField\(TEXT\("current_scope"\), CurrentScope\)/);
});
