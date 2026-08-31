import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const header = fs.readFileSync(
  new URL("../../Source/AIFactoryCopilot/Public/AIFactoryNodeEdit.h", import.meta.url),
  "utf8",
);
const nodeEdit = fs.readFileSync(
  new URL("../../Source/AIFactoryCopilot/Private/AIFactoryNodeEdit.cpp", import.meta.url),
  "utf8",
);
const chat = fs.readFileSync(
  new URL("../../Source/AIFactoryCopilot/Private/AIFactoryChatCommand.cpp", import.meta.url),
  "utf8",
);

function functionSlice(source, start, next) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(next, startIndex);
  assert.ok(startIndex >= 0 && endIndex > startIndex, start + " must precede " + next);
  return source.slice(startIndex, endIndex);
}

test("creative-node configuration readback refuses every actor the mod does not own", () => {
  const readback = functionSlice(
    nodeEdit,
    "bool GetCreativeNodeConfiguration(",
    "namespace\n{\nconstexpr double AIFactoryCreativeNodeRemovalConfirmationSeconds",
  );

  assert.match(header, /bool GetCreativeNodeConfiguration\(/);
  assert.match(readback, /Cast<AAIFactoryCreativeOrdinaryResourceNode>\(Node\)/);
  assert.match(readback, /Cast<AAIFactoryCreativeResourceNode>\(Node\)/);
  assert.match(readback, /that is not a Copilot-owned creative node/);
  assert.match(readback, /ValidateCreativeConfiguration\(/);
  assert.match(readback, /Node->GetResourceClass\(\) != OutResource/);
  assert.match(readback, /Cast<AFGResourceNode>\(Node\)/);
  assert.match(readback, /RuntimeNode->GetResourcePurity\(\) != OutPurity/);
  assert.match(readback, /Node->GetResourceNodeType\(\) != OutNodeType/);
  assert.doesNotMatch(readback, /AFGResourceNodeGeyser|AAIFactoryBlueprintAnchorNode|SetResourceClassOverride/);
});

test("creative-node removal is server gated, actor-stable, occupied-safe, and confirmed twice", () => {
  const removal = nodeEdit.slice(nodeEdit.indexOf("ECreativeNodeRemovalResult RemoveCreativeNode("));
  const canEdit = removal.indexOf("AIFactoryWorldEditAccess::CanEdit");
  const ownership = removal.indexOf("GetCreativeNodeConfiguration(");
  const occupied = removal.indexOf("Node->IsOccupied()");
  const confirmation = removal.indexOf("AIFactoryPendingCreativeNodeRemovals.Find(PlayerKey)");
  const destroy = removal.indexOf("Node->Destroy()");

  assert.match(header, /enum class ECreativeNodeRemovalResult/);
  assert.ok(canEdit >= 0, "world-edit permission must be checked");
  assert.ok(ownership > canEdit, "Copilot ownership must follow permission");
  assert.ok(occupied > ownership, "occupation must be checked after ownership");
  assert.ok(confirmation > occupied, "confirmation must follow every safety gate");
  assert.ok(destroy > confirmation, "destruction must be last");
  assert.match(removal, /Pending->Node\.Get\(\) != Node/);
  assert.match(removal, /Pending->ActorPath != ActorPath/);
  assert.match(removal, /Pending->Resource != Resource/);
  assert.match(removal, /Pending->Purity != Purity/);
  assert.match(removal, /Pending->NodeType != NodeType/);
  assert.match(nodeEdit, /AIFactoryCreativeNodeRemovalConfirmationSeconds = 5\.0/);
  assert.match(removal, /AIFactoryPendingCreativeNodeRemovals\.Remove\(PlayerKey\);[\s\S]*Node->Destroy\(\)/);
  assert.match(removal, /!bDestroyAccepted \|\| !Node->IsActorBeingDestroyed\(\)/);
  assert.doesNotMatch(removal, /SetResourceClassOverride|DismantleCurrentBuildables|Server_DismantleActors/);
});

test("clone reuses exact saved configuration and the normal authoritative Build Gun path", () => {
  assert.match(chat, /Arguments\[1\]\.Equals\(TEXT\("clone"\)/);
  assert.match(chat, /GetCreativeNodeConfiguration\(\s*Target, Resource, Purity, NodeType, Reason\)/);
  assert.match(chat, /AIFactoryCreativeNodePlacement::ArmForPlayer\(\s*NodePlayer, Resource, Purity, NodeType, Reason\)/);
  assert.match(chat, /the original node is unchanged/);
  assert.match(chat, /Arguments\[1\]\.Equals\(TEXT\("remove"\)/);
  assert.match(chat, /AIFactoryNodeEdit::RemoveCreativeNode\(/);
});
