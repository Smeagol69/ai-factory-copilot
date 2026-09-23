# Saved-base transform comparison

`base-transform-match.cpp` exercises the production comparison header directly.
It accepts the native Designer rotation normalization and opposite quaternion
signs, but rejects changed orientations, invalid rotations, and one-ULP changes
(one representable double step) on every XYZ and scale axis.

From an x64 Visual Studio developer PowerShell at the repository root:

```powershell
cl /nologo /std:c++17 /EHsc /W4 /WX tests/native/base-transform-match.cpp "/Fe:$env:TEMP/aifactory-base-transform-match.exe" "/Fo:$env:TEMP/aifactory-base-transform-match.obj"
& "$env:TEMP/aifactory-base-transform-match.exe"
```

With `--replay` and redirected stdin, it can replay a private native-loader result.
The first two integers are saved and observed actor counts. Then supply all saved
archive rows followed by all `native_loader_readback` rows, one row per actor:

```text
class_integer_id X Y Z quaternion_X quaternion_Y quaternion_Z quaternion_W scale_X scale_Y scale_Z
```

Use the same class-to-integer mapping for both lists. The test requires a unique
one-to-one match of every actor using the production comparer. Keep save data and
runtime diagnostics outside the repository. This replay verifies actor identity
matching; it does not claim construction, lightweight spawning or save/reload
persistence succeeded in the game.

## Current miner resource binding

`base-resource-binding.cpp` exercises the production resource-readback predicate
with separate current and legacy fields. A current binding must work with a null
legacy field; a matching legacy field must never hide a wrong/unbound current
resource, missing interface or unclaimed exclusive node.

```powershell
cl /nologo /std:c++17 /EHsc /W4 /WX tests/native/base-resource-binding.cpp "/Fe:$env:TEMP/aifactory-base-resource-binding.exe" "/Fo:$env:TEMP/aifactory-base-resource-binding.obj"
& "$env:TEMP/aifactory-base-resource-binding.exe"
```
