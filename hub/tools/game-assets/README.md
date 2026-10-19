# Real game assets: meshes, sizes and renders from the game's own files

Owner rule (2026-10-19): renders and blueprints use only real game pieces. This
tool reads the installed game (`D:\SteamLibrary\steamapps\common\Satisfactory`,
base game and every mod under `FactoryGame/Mods` and `Mods/GameFeatures`) with
CUE4Parse and exports, per buildable class, the static meshes the game draws
(component templates and lightweight-buildable instance data), their component
transforms, their native bounds, and the materials' textures. Read-only: nothing in
the game install is written.

1. Mappings. The game ships `CommunityResources/FactoryGame.usmap`, but it writes
   OptionalProperty without its inner type, which CUE4Parse cannot read. Make a
   corrected copy (the original is untouched):

       node hub/tools/game-assets/fix-usmap.mjs "<game>/CommunityResources/FactoryGame.usmap" hub/state/game-assets/FactoryGame.fixed.usmap

2. Export (needs the .NET 10 SDK; Oodle comes from an installed Unreal Engine):

       dotnet build -c Release hub/tools/game-assets
       GameAssets probe  <classPath>
       GameAssets export <classes.txt> <outDir>     # manifest.json + meshes/*.glb + textures

3. Render with Blender 5.x, the real meshes at each piece's exact pose:

       blender -b -P hub/tools/game-assets/render_pieces.py -- <outDir>/manifest.json <pieces.json> <out.png> --view both

Engine version: GAME_UE5_6 (as the modding docs say for the current game).
Splines (belts, pipes, wires, rails) are not drawn yet; a class without an exported
mesh is a red marker, never a guess.

4. True sizes for the catalog (after a new export or a re-ingest of the catalog):

       node hub/scripts/catalog-mesh-sizes.mjs D:/SatisfactoryAssets/export/manifest.json

   Each class gets the box around the meshes the game draws for it
   (`size.source: game-mesh-bounds`). On 2026-10-19: 3,134 of 3,423 classes;
   the rest are splines, logic and other classes with no static mesh.

The full export lives outside the repo (`D:/SatisfactoryAssets/export`, about 4 GB);
the hub's real renders read it there (`GAME_ASSETS_MANIFEST` to override).
