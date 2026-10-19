// Reads Satisfactory's own asset packages (base game and installed mods) with the
// game's shipped mappings (CommunityResources/FactoryGame.usmap) and exports the real
// static meshes of buildable classes as glTF, with their component transforms and
// native bounds. Read-only: nothing in the game install is written.
//
//   GameAssets probe  <classPath>
//   GameAssets export <classes.txt> <outDir>
using System.Text.Json;
using CUE4Parse.Compression;
using CUE4Parse.FileProvider;
using CUE4Parse.MappingsProvider.Usmap;
using CUE4Parse.UE4.Assets.Exports;
using CUE4Parse.UE4.Assets.Exports.StaticMesh;
using CUE4Parse.UE4.Objects.Core.Math;
using CUE4Parse.UE4.Objects.UObject;
using CUE4Parse.UE4.Versions;
using CUE4Parse_Conversion;
using CUE4Parse_Conversion.Options;
using CUE4Parse.UE4.Assets.Exports.Texture;
using CUE4Parse.UE4.Assets.Exports.Material;
using CUE4Parse_Conversion.Writers.UEFormat.Enums;

const string Game = @"D:\SteamLibrary\steamapps\common\Satisfactory";
string Oodle = Environment.GetEnvironmentVariable("OODLE_DLL") ?? @"D:\Modding\Satisfactory\UnrealEngine-CSS\Engine\Binaries\DotNET\AutomationTool\oo2core_9_win64.dll";
var ue = Enum.Parse<EGame>(Environment.GetEnvironmentVariable("UE_GAME") ?? "GAME_UE5_6");

OodleHelper.Initialize(Oodle);
var provider = new DefaultFileProvider(Path.Combine(Game, "FactoryGame"), SearchOption.AllDirectories, new VersionContainer(ue), StringComparer.OrdinalIgnoreCase);
// The shipped mappings need fix-usmap.mjs first (OptionalProperty without an inner type).
provider.MappingsContainer = new FileUsmapTypeMappingsProvider(Environment.GetEnvironmentVariable("USMAP") ?? Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../state/game-assets/FactoryGame.fixed.usmap")), StringComparer.OrdinalIgnoreCase);
provider.Initialize();
provider.Mount();
Console.Error.WriteLine($"mounted {provider.Files.Count} files ({ue})");

// "/SS_Mod/Builders/Steel/Build_X.Build_X_C" -> package "SS_Mod/Builders/Steel/Build_X"; "/Game/..." -> "FactoryGame/Content/..."
string PackageOf(string classPath) {
  string p = classPath.Split(".")[0].TrimStart('/');
  var slash = p.IndexOf("/");
  var (root, rest) = (p[..slash], p[(slash + 1)..]);
  var candidates = root == "Game" ? new[] { "FactoryGame/Content/" + rest }
    : new[] { $"FactoryGame/Mods/{root}/Content/{rest}", $"FactoryGame/Mods/GameFeatures/{root}/Content/{rest}", $"FactoryGame/Plugins/{root}/Content/{rest}" };
  foreach (var c in candidates) if (provider.Files.ContainsKey(c + ".uasset")) return c;
  throw new FileNotFoundException("No package for " + classPath);
}

// Every static mesh a buildable class draws, from its component templates.
List<object> MeshComponents(string classPath, Dictionary<string, UStaticMesh> meshes) {
  var found = new List<object>();
  var pkg = provider.LoadPackage(PackageOf(classPath));
  void Add(string component, string componentClass, UStaticMesh mesh, FVector loc, FQuat q, FVector scale) {
    var key = mesh.GetPathName();
    meshes[key] = mesh;
    var b = mesh.RenderData?.Bounds;
    found.Add(new {
      component, componentClass, mesh = key,
      location = new { x = loc.X, y = loc.Y, z = loc.Z }, rotation_quat = new { x = q.X, y = q.Y, z = q.Z, w = q.W }, scale = new { x = scale.X, y = scale.Y, z = scale.Z },
      bounds = b is null ? null : new { origin = new { x = b.Origin.X, y = b.Origin.Y, z = b.Origin.Z }, extent = new { x = b.BoxExtent.X, y = b.BoxExtent.Y, z = b.BoxExtent.Z } },
    });
  }
  foreach (var export in pkg.GetExports()) {
    // Lightweight buildables (foundations, walls…): a list of mesh instances on the class.
    if (export.TryGetValue(out CUE4Parse.UE4.Assets.Objects.FStructFallback[] instances, "Instances")) {
      var n = 0;
      foreach (var inst in instances) {
        n++;
        if (!inst.TryGetValue(out FPackageIndex instRef, "StaticMesh") || instRef.IsNull || !instRef.TryLoad(out UStaticMesh? instMesh) || instMesh is null) continue;
        var t = inst.GetOrDefault("RelativeTransform", FTransform.Identity);
        Add($"{export.Name}[{n}]", export.ExportType, instMesh, t.Translation, t.Rotation, t.Scale3D);
      }
      continue;
    }
    if (!export.TryGetValue(out FPackageIndex meshRef, "StaticMesh") || meshRef.IsNull) continue;
    if (!meshRef.TryLoad(out UStaticMesh? mesh) || mesh is null) continue;
    var loc = export.GetOrDefault("RelativeLocation", new FVector(0, 0, 0));
    var rot = export.GetOrDefault("RelativeRotation", new FRotator(0, 0, 0));
    var scale = export.GetOrDefault("RelativeScale3D", new FVector(1, 1, 1));
    var q = rot.Quaternion();
    Add(export.Name, export.ExportType, mesh, loc, q, scale);
  }
  return found;
}

var json = new JsonSerializerOptions { WriteIndented = true };
if (args.Length >= 2 && args[0] == "dump") {
  var pkg = provider.LoadPackage(PackageOf(args[1]));
  foreach (var e in pkg.GetExports()) { var j = Newtonsoft.Json.JsonConvert.SerializeObject(e, Newtonsoft.Json.Formatting.Indented); Console.WriteLine($"== {e.Name} : {e.ExportType} ({j.Length} chars)"); foreach (var line in j.Split('\n').Where(l => Environment.GetEnvironmentVariable("DUMP_ALL") == "1" || l.Contains("Mesh", StringComparison.OrdinalIgnoreCase)).Take(200)) Console.WriteLine("   " + line.Trim()); }
  return;
}
if (args.Length >= 2 && args[0] == "find") {
  foreach (var k in provider.Files.Keys.Where(k => k.Contains(args[1], StringComparison.OrdinalIgnoreCase)).Take(25)) Console.WriteLine(k);
  return;
}
if (args.Length >= 2 && args[0] == "probe") {
  var meshes = new Dictionary<string, UStaticMesh>();
  Console.WriteLine(JsonSerializer.Serialize(MeshComponents(args[1], meshes), json));
  return;
}
if (args.Length >= 3 && args[0] == "export") {
  var outDir = args[2]; Directory.CreateDirectory(outDir);
  var meshes = new Dictionary<string, UStaticMesh>();
  var manifest = new Dictionary<string, object>();
  foreach (var cls in File.ReadAllLines(args[1]).Select(l => l.Trim()).Where(l => l.Length > 0 && !l.StartsWith('#'))) {
    try { manifest[cls] = new { components = MeshComponents(cls, meshes) }; }
    catch (Exception e) { manifest[cls] = new { error = e.Message }; Console.Error.WriteLine($"{cls}: {e.Message}"); }
  }
  var options = new ExportOptions(EMeshFormat.Gltf2, ENaniteMeshFormat.NoNanite, EMeshQuality.Highest, ETexturePlatform.DesktopMobile, ETextureFormat.Png, 0, false, false, EMaterialDepth.TopLayerOnly, Environment.GetEnvironmentVariable("EXPORT_MATERIALS") != "0", false, ESocketFormat.None, EFileCompressionFormat.None);
  var session = new ExportSession(null!);
  foreach (var mesh in meshes.Values) session.Add(mesh);
  var results = await session.RunAsync(Path.Combine(outDir, "meshes"), options, null!, CancellationToken.None);
  var files = new Dictionary<string, string?>();
  // Results name packages ("FactoryGame/Content/…", "Mod/…"); components name objects ("/Game/…", "/Mod/…").
  string Norm(string k) => k.StartsWith("/Game/") ? "FactoryGame/Content/" + k[6..] : k.TrimStart('/');
  var byNorm = meshes.Keys.ToDictionary(Norm, k => k);
  foreach (var r in results) { files[byNorm.GetValueOrDefault(r.ObjectPath, r.ObjectPath)] = r.Success ? r.DiskFilePaths?.FirstOrDefault() : null; if (!r.Success) Console.Error.WriteLine($"{r.ObjectPath}: {r.Error?.Message}"); }
  File.WriteAllText(Path.Combine(outDir, "manifest.json"), JsonSerializer.Serialize(new { game = Game, ue = ue.ToString(), classes = manifest, meshFiles = files }, json));
  Console.WriteLine($"{manifest.Count} classes, {meshes.Count} meshes, {files.Values.Count(v => v != null)} exported -> {outDir}");
  return;
}
Console.Error.WriteLine("usage: GameAssets probe <classPath> | export <classes.txt> <outDir>");

