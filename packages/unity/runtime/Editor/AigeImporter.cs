#nullable enable
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.Rendering.Universal;
using UnityEngine.SceneManagement;

namespace Aige.Editor
{
    /// <summary>
    /// Builds Unity scenes from the data unity_export writes under Assets/AigeData (scenes/*.json in Unity
    /// coordinates, materials/*.json MaterialDocs, project.json). Run in batch mode with
    /// <c>-executeMethod Aige.Editor.AigeImporter.ImportAll [-aigeReport &lt;report.json&gt;]</c>, or from the menu AIGE › Import All.
    /// Generated: Assets/Scenes/&lt;scene&gt;.unity, Assets/AigeData/materials/*.mat, environments/*.asset, Settings/ (URP).
    /// </summary>
    public static class AigeImporter
    {
        public const string DataDir = "Assets/AigeData";
        const string SettingsDir = DataDir + "/Settings";
        static readonly List<string> Warnings = new List<string>();
        static readonly Dictionary<string, Material?> Materials = new Dictionary<string, Material?>();
        static Material? _particleMaterial;
        static Mesh? _cylinder;

        [MenuItem("AIGE/Import All")]
        public static void ImportAllMenu() => ImportAll();

        /// <summary>Sets up URP and project settings, builds materials and every exported scene, then writes a report.</summary>
        public static void ImportAll()
        {
            Warnings.Clear();
            Materials.Clear();
            var report = new Dictionary<string, object?>();
            var scenes = new List<object>();
            var errors = new List<string>();
            try
            {
                AssetDatabase.Refresh(ImportAssetOptions.ForceSynchronousImport);
                var project = AigeJson.Parse(ReadText(DataDir + "/project.json"), "project.json") ?? JsonNode.Null;
                SetupProject(project);
                var mainEnv = FirstEnvironment();
                SetupRenderPipeline(mainEnv);
                var sceneFiles = Directory.Exists(DataDir + "/scenes") ? Directory.GetFiles(DataDir + "/scenes", "*.json").OrderBy(f => f).ToArray() : Array.Empty<string>();
                var built = new List<string>();
                foreach (var file in sceneFiles)
                {
                    var doc = AigeJson.Parse(File.ReadAllText(file), file);
                    if (doc == null)
                    {
                        errors.Add($"Invalid scene data {file}");
                        continue;
                    }
                    var (path, count) = BuildScene(doc);
                    built.Add(path);
                    scenes.Add(new Dictionary<string, object?> { ["name"] = doc.Str("name"), ["path"] = path, ["objects"] = count });
                }
                var main = project.Str("mainScene");
                var ordered = built.OrderBy(p => Path.GetFileNameWithoutExtension(p) == main ? 0 : 1).ToList();
                EditorBuildSettings.scenes = ordered.Select(p => new EditorBuildSettingsScene(p, true)).ToArray();
                AssetDatabase.SaveAssets();
                if (ordered.Count > 0 && !Application.isBatchMode) EditorSceneManager.OpenScene(ordered[0]);
            }
            catch (Exception e)
            {
                errors.Add(e.ToString());
                Debug.LogError("[aige] Import failed: " + e);
            }
            report["ok"] = errors.Count == 0;
            report["scenes"] = scenes;
            report["warnings"] = Warnings.Distinct().ToList();
            report["errors"] = errors;
            var reportPath = Arg("aigeReport");
            if (!string.IsNullOrEmpty(reportPath)) File.WriteAllText(reportPath, AigeJson.Write(report));
            Debug.Log($"[aige] Import finished: {scenes.Count} scene(s), {Warnings.Count} warning(s), {errors.Count} error(s).");
        }

        public static string? Arg(string name)
        {
            var args = Environment.GetCommandLineArgs();
            for (var i = 0; i < args.Length - 1; i++)
                if (args[i].TrimStart('-') == name) return args[i + 1];
            return null;
        }

        static string? ReadText(string path) => File.Exists(path) ? File.ReadAllText(path) : null;

        static void Warn(string message) => Warnings.Add(message);

        // =====================================================================================
        // Project and URP setup
        // =====================================================================================

        static void SetupProject(JsonNode project)
        {
            PlayerSettings.colorSpace = ColorSpace.Linear;
            var title = project.Str("title");
            if (!string.IsNullOrEmpty(title)) PlayerSettings.productName = title;
            PlayerSettings.defaultScreenWidth = (int)project.Num("width", 1920);
            PlayerSettings.defaultScreenHeight = (int)project.Num("height", 1080);
            var settings = AssetDatabase.LoadAllAssetsAtPath("ProjectSettings/ProjectSettings.asset").FirstOrDefault();
            if (settings != null)
            {
                var so = new SerializedObject(settings);
                var handler = so.FindProperty("activeInputHandler");
                if (handler != null && handler.intValue != 2)
                {
                    handler.intValue = 2;
                    so.ApplyModifiedPropertiesWithoutUndo();
                }
            }
            EditorSettings.asyncShaderCompilation = false;
        }

        static JsonNode? FirstEnvironment()
        {
            var dir = DataDir + "/scenes";
            if (!Directory.Exists(dir)) return null;
            foreach (var file in Directory.GetFiles(dir, "*.json"))
            {
                var doc = AigeJson.Parse(File.ReadAllText(file), file);
                var main = doc?.Str("mainEnvironment");
                if (doc == null || main == null) continue;
                foreach (var e in doc.Arr("entities"))
                    if (e.Str("name") == main && e["environment"].IsObject) return e["environment"];
            }
            return null;
        }

        static void SetupRenderPipeline(JsonNode? env)
        {
            Directory.CreateDirectory(SettingsDir);
            var assetPath = SettingsDir + "/AigeURP.asset";
            var rendererPath = SettingsDir + "/AigeURP_Renderer.asset";
            var asset = AssetDatabase.LoadAssetAtPath<UniversalRenderPipelineAsset>(assetPath);
            var renderer = AssetDatabase.LoadAssetAtPath<UniversalRendererData>(rendererPath);
            if (renderer == null)
            {
                renderer = ScriptableObject.CreateInstance<UniversalRendererData>();
                AssetDatabase.CreateAsset(renderer, rendererPath);
                var ppd = typeof(PostProcessData).GetMethod("GetDefaultPostProcessData", BindingFlags.Static | BindingFlags.NonPublic | BindingFlags.Public);
                renderer.postProcessData = ppd?.Invoke(null, null) as PostProcessData;
                EditorUtility.SetDirty(renderer);
            }
            if (asset == null)
            {
                asset = UniversalRenderPipelineAsset.Create(renderer);
                AssetDatabase.CreateAsset(asset, assetPath);
            }
            asset.supportsHDR = true;
            asset.msaaSampleCount = 4;
            asset.shadowDistance = 45f;
            asset.shadowCascadeCount = 4;
            asset.maxAdditionalLightsCount = 8;
            asset.supportsCameraDepthTexture = true;
            var so = new SerializedObject(asset);
            void Set(string prop, int v)
            {
                var p = so.FindProperty(prop);
                if (p != null) p.intValue = v;
                else Warn($"URP asset has no '{prop}'.");
            }
            void SetBool(string prop, bool v)
            {
                var p = so.FindProperty(prop);
                if (p != null) p.boolValue = v;
            }
            Set("m_MainLightShadowmapResolution", 4096);
            SetBool("m_AdditionalLightShadowsSupported", true);
            Set("m_AdditionalLightsShadowmapResolution", 4096);
            Set("m_AdditionalLightsPerObjectLimit", 8);
            SetBool("m_SoftShadowsSupported", true);
            Set("m_ColorGradingMode", 1);
            so.ApplyModifiedPropertiesWithoutUndo();
            EditorUtility.SetDirty(asset);

            // SSAO renderer feature from the main Environment.
            var ssao = renderer.rendererFeatures.OfType<ScreenSpaceAmbientOcclusion>().FirstOrDefault();
            var strength = env?.Num("ssao", 0.8f) ?? 0.8f;
            if (ssao == null && strength > 0f)
            {
                ssao = ScriptableObject.CreateInstance<ScreenSpaceAmbientOcclusion>();
                ssao.name = "SSAO";
                AssetDatabase.AddObjectToAsset(ssao, renderer);
                renderer.rendererFeatures.Add(ssao);
                AssetDatabase.TryGetGUIDAndLocalFileIdentifier(ssao, out _, out long localId);
                var rso = new SerializedObject(renderer);
                var map = rso.FindProperty("m_RendererFeatureMap");
                map.arraySize = renderer.rendererFeatures.Count;
                map.GetArrayElementAtIndex(map.arraySize - 1).longValue = localId;
                rso.ApplyModifiedPropertiesWithoutUndo();
            }
            if (ssao != null)
            {
                var fso = new SerializedObject(ssao);
                var i = fso.FindProperty("m_Settings.Intensity");
                if (i != null) i.floatValue = Mathf.Clamp(strength * 2.2f, 0f, 4f);
                var r = fso.FindProperty("m_Settings.Radius");
                if (r != null) r.floatValue = Mathf.Clamp((env?.Num("ssaoRadius", 0.35f) ?? 0.35f) * 0.6f, 0.05f, 1f);
                var d = fso.FindProperty("m_Settings.DirectLightingStrength");
                if (d != null) d.floatValue = 0.2f;
                fso.ApplyModifiedPropertiesWithoutUndo();
                ssao.SetActive(strength > 0f);
            }
            renderer.SetDirty();
            EditorUtility.SetDirty(renderer);

            GraphicsSettings.defaultRenderPipeline = asset;
            var current = QualitySettings.GetQualityLevel();
            for (var q = 0; q < QualitySettings.names.Length; q++)
            {
                QualitySettings.SetQualityLevel(q, false);
                QualitySettings.renderPipeline = asset;
            }
            QualitySettings.SetQualityLevel(current, false);
            AssetDatabase.SaveAssets();
        }

        // =====================================================================================
        // Materials (MaterialDoc → URP Lit)
        // =====================================================================================

        /// <summary>The URP Lit material for an exported MaterialDoc JSON (built once per import).</summary>
        public static Material? MaterialFor(string jsonPath)
        {
            if (Materials.TryGetValue(jsonPath, out var cached)) return cached;
            Material? mat = null;
            var md = AigeJson.Parse(ReadText(jsonPath), jsonPath);
            if (md == null) Warn($"Material '{jsonPath}' not found.");
            else mat = BuildMaterial(md, Path.ChangeExtension(jsonPath, ".mat"));
            Materials[jsonPath] = mat;
            return mat;
        }

        static Texture2D? Tex(string? path)
        {
            if (string.IsNullOrEmpty(path)) return null;
            var t = AssetDatabase.LoadAssetAtPath<Texture2D>(path);
            if (t == null) Warn($"Texture '{path}' not found.");
            return t;
        }

        static Material BuildMaterial(JsonNode md, string matPath)
        {
            var shader = Shader.Find("Universal Render Pipeline/Lit");
            var mat = AssetDatabase.LoadAssetAtPath<Material>(matPath);
            if (mat == null)
            {
                mat = new Material(shader);
                AssetDatabase.CreateAsset(mat, matPath);
            }
            else
            {
                mat.shader = shader;
                mat.shaderKeywords = Array.Empty<string>();
            }
            var color = AigeJson.ParseColor(md.Str("color") ?? "#ffffff");
            var opacity = md.Num("opacity", 1f);
            mat.SetColor("_BaseColor", new Color(color.r, color.g, color.b, opacity));
            var repeat = md["mapRepeat"];
            var su = repeat.IsArray ? repeat[0].AsFloat(1f) : 1f;
            var sv = repeat.IsArray ? repeat[1].AsFloat(1f) : 1f;
            var map = Tex(md.Str("map"));
            mat.SetTexture("_BaseMap", map);
            mat.SetTextureScale("_BaseMap", new Vector2(su, sv));
            mat.SetTextureOffset("_BaseMap", new Vector2(0f, 1f - sv));
            var normal = Tex(md.Str("normalMap"));
            mat.SetTexture("_BumpMap", normal);
            mat.SetFloat("_BumpScale", md.Num("normalScale", 1f));
            var metal = md.Num("metalness", 0f);
            var rough = md.Num("roughness", 0.8f);
            var orm = md.Str("ormMap");
            var mask = !string.IsNullOrEmpty(orm) ? MaskFor(orm!, metal, rough) : null;
            mat.SetTexture("_MetallicGlossMap", mask);
            mat.SetTexture("_OcclusionMap", mask);
            mat.SetFloat("_OcclusionStrength", md.Num("aoIntensity", 1f));
            mat.SetFloat("_Metallic", mask != null ? 1f : metal);
            mat.SetFloat("_Smoothness", mask != null ? 1f : 1f - rough);
            mat.SetFloat("_SmoothnessTextureChannel", 0f);
            var emissive = AigeJson.ParseColor(md.Str("emissive") ?? "#000000");
            var ei = md.Num("emissiveIntensity", 1f);
            if (emissive.maxColorComponent > 0.001f && ei > 0f)
            {
                mat.SetColor("_EmissionColor", emissive * ei);
                mat.EnableKeyword("_EMISSION");
                mat.globalIlluminationFlags = MaterialGlobalIlluminationFlags.RealtimeEmissive;
            }
            else mat.SetColor("_EmissionColor", Color.black);
            mat.SetFloat("_Cull", md.Bool("doubleSided", false) ? 0f : 2f);
            var transparent = opacity < 0.999f;
            mat.SetFloat("_Surface", transparent ? 1f : 0f);
            mat.SetFloat("_Blend", 0f);
            try
            {
                UnityEditor.Rendering.Universal.ShaderGUI.BaseShaderGUI.SetMaterialKeywords(mat, UnityEditor.Rendering.Universal.ShaderGUI.LitGUI.SetMaterialKeywords);
            }
            catch (Exception e)
            {
                Warn($"Material keywords for {matPath}: {e.Message}");
            }
            EditorUtility.SetDirty(mat);
            return mat;
        }

        /// <summary>
        /// URP Lit reads metallic (R) + smoothness (A) and occlusion (G) from masks, glTF packs AO (R), roughness (G),
        /// metalness (B). Repacks once per (texture, factors) into materials/&lt;name&gt;_mask.png.
        /// </summary>
        static Texture2D? MaskFor(string ormPath, float metal, float rough)
        {
            var full = Path.GetFullPath(ormPath);
            if (!File.Exists(full))
            {
                Warn($"Texture '{ormPath}' not found.");
                return null;
            }
            var name = Path.GetFileNameWithoutExtension(ormPath);
            var outPath = $"{DataDir}/materials/{name}_m{Mathf.RoundToInt(metal * 100)}_r{Mathf.RoundToInt(rough * 100)}_mask.png";
            if (!File.Exists(outPath) || File.GetLastWriteTimeUtc(outPath) < File.GetLastWriteTimeUtc(full))
            {
                var src = new Texture2D(2, 2, TextureFormat.RGBA32, false, true);
                src.LoadImage(File.ReadAllBytes(full));
                var px = src.GetPixels32();
                for (var i = 0; i < px.Length; i++)
                {
                    var p = px[i];
                    var m = (byte)Mathf.Clamp(p.b * metal, 0, 255);
                    var s = (byte)Mathf.Clamp(255f - p.g * rough, 0, 255);
                    px[i] = new Color32(m, p.r, 0, s);
                }
                var dst = new Texture2D(src.width, src.height, TextureFormat.RGBA32, false, true);
                dst.SetPixels32(px);
                dst.Apply();
                Directory.CreateDirectory(Path.GetDirectoryName(outPath)!);
                File.WriteAllBytes(outPath, dst.EncodeToPNG());
                UnityEngine.Object.DestroyImmediate(src);
                UnityEngine.Object.DestroyImmediate(dst);
                AssetDatabase.ImportAsset(outPath, ImportAssetOptions.ForceSynchronousImport);
            }
            return AssetDatabase.LoadAssetAtPath<Texture2D>(outPath);
        }

        static Material ColorMaterial(string hex)
        {
            var key = "color:" + hex;
            if (Materials.TryGetValue(key, out var m) && m != null) return m;
            var path = $"{DataDir}/materials/_color_{hex.TrimStart('#')}.mat";
            var mat = AssetDatabase.LoadAssetAtPath<Material>(path);
            if (mat == null)
            {
                mat = new Material(Shader.Find("Universal Render Pipeline/Lit"));
                Directory.CreateDirectory(Path.GetDirectoryName(path)!);
                AssetDatabase.CreateAsset(mat, path);
            }
            mat.SetColor("_BaseColor", AigeJson.ParseColor(hex));
            mat.SetFloat("_Smoothness", 0.3f);
            EditorUtility.SetDirty(mat);
            Materials[key] = mat;
            return mat;
        }

        static Material ParticleMaterial()
        {
            if (_particleMaterial != null) return _particleMaterial;
            var path = DataDir + "/materials/_particle.mat";
            var mat = AssetDatabase.LoadAssetAtPath<Material>(path);
            if (mat == null)
            {
                mat = new Material(Shader.Find("Universal Render Pipeline/Particles/Unlit"));
                Directory.CreateDirectory(Path.GetDirectoryName(path)!);
                AssetDatabase.CreateAsset(mat, path);
            }
            var texPath = DataDir + "/materials/_particle.png";
            if (!File.Exists(texPath))
            {
                const int n = 64;
                var t = new Texture2D(n, n, TextureFormat.RGBA32, false);
                for (var y = 0; y < n; y++)
                for (var x = 0; x < n; x++)
                {
                    var d = Vector2.Distance(new Vector2(x + 0.5f, y + 0.5f), new Vector2(n / 2f, n / 2f)) / (n / 2f);
                    var a = Mathf.Clamp01(1f - d);
                    t.SetPixel(x, y, new Color(1, 1, 1, a * a));
                }
                File.WriteAllBytes(texPath, t.EncodeToPNG());
                AssetDatabase.ImportAsset(texPath, ImportAssetOptions.ForceSynchronousImport);
            }
            mat.SetTexture("_BaseMap", AssetDatabase.LoadAssetAtPath<Texture2D>(texPath));
            mat.SetFloat("_Surface", 1f);
            mat.SetFloat("_Blend", 0f);
            try
            {
                UnityEditor.Rendering.Universal.ShaderGUI.BaseShaderGUI.SetMaterialKeywords(mat);
            }
            catch (Exception e)
            {
                Warn("Particle material keywords: " + e.Message);
            }
            EditorUtility.SetDirty(mat);
            return _particleMaterial = mat;
        }

        static Mesh CylinderMesh()
        {
            if (_cylinder != null) return _cylinder;
            var path = DataDir + "/materials/_cylinder_collider.asset";
            _cylinder = AssetDatabase.LoadAssetAtPath<Mesh>(path);
            if (_cylinder != null) return _cylinder;
            const int seg = 16;
            var verts = new List<Vector3>();
            var tris = new List<int>();
            for (var i = 0; i < seg; i++)
            {
                var a = i * Mathf.PI * 2f / seg;
                verts.Add(new Vector3(Mathf.Cos(a) * 0.5f, -0.5f, Mathf.Sin(a) * 0.5f));
                verts.Add(new Vector3(Mathf.Cos(a) * 0.5f, 0.5f, Mathf.Sin(a) * 0.5f));
            }
            for (var i = 0; i < seg; i++)
            {
                int a = i * 2, b = (i * 2 + 2) % (seg * 2);
                tris.AddRange(new[] { a, a + 1, b, b, a + 1, b + 1 });
                if (i > 0 && i < seg - 1)
                {
                    tris.AddRange(new[] { 0, b, a });
                    tris.AddRange(new[] { 1, a + 1, b + 1 });
                }
            }
            _cylinder = new Mesh { name = "CylinderCollider" };
            _cylinder.SetVertices(verts);
            _cylinder.SetTriangles(tris, 0);
            _cylinder.RecalculateNormals();
            _cylinder.RecalculateBounds();
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            AssetDatabase.CreateAsset(_cylinder, path);
            return _cylinder;
        }

        // =====================================================================================
        // Scenes
        // =====================================================================================

        static Vector3 V3(JsonNode n, Vector3 fallback) => n.TryVec3(out var v) ? v : fallback;

        static Quaternion Q(JsonNode n) =>
            n.IsArray && n.Items.Count >= 4 ? new Quaternion(n[0].AsFloat(), n[1].AsFloat(), n[2].AsFloat(), n[3].AsFloat(1f)) : Quaternion.identity;

        static (string path, int count) BuildScene(JsonNode doc)
        {
            var sceneName = doc.Str("name") ?? "scene";
            var scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            var root = new GameObject(sceneName);
            var byId = new Dictionary<string, GameObject>();
            var entities = doc.Arr("entities");
            var envs = new Dictionary<string, AigeEnvironment>();
            var inactive = new List<GameObject>();
            foreach (var e in entities)
            {
                var go = new GameObject(e.Str("name") ?? "Entity");
                var id = e.Str("id") ?? "";
                byId[id] = go;
            }
            foreach (var e in entities)
            {
                var go = byId[e.Str("id") ?? ""];
                var parent = e.Str("parent");
                go.transform.SetParent(parent != null && byId.TryGetValue(parent, out var p) ? p.transform : root.transform, false);
                go.transform.localPosition = V3(e["position"], Vector3.zero);
                go.transform.localRotation = Q(e["rotation"]);
                go.transform.localScale = V3(e["scale"], Vector3.one);
                try
                {
                    BuildEntity(go, e, sceneName, envs);
                }
                catch (Exception ex)
                {
                    Warn($"{go.name}: {ex.Message}");
                    Debug.LogException(ex);
                }
                if (!e.Bool("active", true)) inactive.Add(go);
            }

            // Environment: the root 'Environment' object with the global Volume and EnvironmentFx.
            var mainName = doc.Str("mainEnvironment");
            if (mainName != null && envs.TryGetValue(mainName, out var mainEnv))
            {
                var envGo = new GameObject("Environment");
                var vol = envGo.AddComponent<Volume>();
                vol.isGlobal = true;
                vol.sharedProfile = mainEnv.Profile;
                var fx = envGo.AddComponent<EnvironmentFx>();
                fx.Active = mainEnv;
                mainEnv.ApplyRenderSettings();
                RenderSettings.defaultReflectionMode = DefaultReflectionMode.Skybox;
                if (mainEnv.Skybox == null)
                    foreach (var cam in root.GetComponentsInChildren<Camera>(true))
                    {
                        cam.clearFlags = CameraClearFlags.SolidColor;
                        cam.backgroundColor = mainEnv.Background;
                    }
            }
            else
            {
                var s = doc["settings"];
                RenderSettings.skybox = null;
                RenderSettings.ambientMode = AmbientMode.Flat;
                var amb = doc.Arr("ambient");
                var color = amb.Count > 0 ? AigeJson.ParseColor(amb[0].Str("color") ?? "#ffffff") * amb[0].Num("intensity", 1f)
                    : AigeJson.ParseColor(s.Str("ambientColor") ?? "#ffffff") * s.Num("ambientIntensity", 0.4f);
                RenderSettings.ambientLight = color;
                foreach (var cam in root.GetComponentsInChildren<Camera>(true))
                {
                    cam.clearFlags = CameraClearFlags.SolidColor;
                    cam.backgroundColor = AigeJson.ParseColor(s.Str("background") ?? "#87b5e0");
                }
            }
            var sun = root.GetComponentsInChildren<Light>(true).FirstOrDefault(l => l.type == LightType.Directional && l.gameObject.activeInHierarchy && l.intensity > 0f);
            if (sun != null) RenderSettings.sun = sun;
            foreach (var go in inactive) go.SetActive(false);
            DynamicGI.UpdateEnvironment();

            Directory.CreateDirectory("Assets/Scenes");
            var path = $"Assets/Scenes/{sceneName}.unity";
            EditorSceneManager.SaveScene(scene, path);
            return (path, byId.Count);
        }

        static void BuildEntity(GameObject go, JsonNode e, string sceneName, Dictionary<string, AigeEnvironment> envs)
        {
            var ent = go.AddComponent<AigeEntity>();
            ent.Id = e.Str("id") ?? "";
            ent.Tags = e.Arr("tags").Select(t => t.AsString ?? "").Where(t => t.Length > 0).ToArray();
            if (ent.HasTag("Player")) go.tag = "Player";

            var mesh = e["mesh"];
            GameObject? model = null;
            if (mesh.IsObject) model = BuildMesh(go, mesh);

            var solid = new List<JsonNode>();
            var triggers = new List<JsonNode>();
            foreach (var c in e.Arr("colliders")) (c.Bool("isTrigger", false) ? triggers : solid).Add(c);
            foreach (var c in solid) AddCollider(go, c, model, false);
            if (triggers.Count > 0)
            {
                var area = Child(go, "Area");
                foreach (var c in triggers) AddCollider(area, c, model, true);
                area.AddComponent<TriggerArea>();
            }

            var ch = e["character"];
            if (ch.IsObject)
            {
                var cc = go.AddComponent<CharacterController>();
                var h = ch.Num("height", 1.8f);
                var r = ch.Num("radius", 0.4f);
                cc.height = h;
                cc.radius = r;
                cc.center = new Vector3(0, h / 2f, 0);
                cc.stepOffset = Mathf.Min(ch.Num("stepHeight", 0.35f), h * 0.5f);
                cc.slopeLimit = ch.Num("maxSlope", 50f);
                cc.skinWidth = Mathf.Max(0.01f, r * 0.1f);
                cc.minMoveDistance = 0f;
            }
            var rb = e["rigidbody"];
            if (rb.IsObject && rb.Str("kind") != "fixed")
            {
                var body = go.AddComponent<Rigidbody>();
                body.mass = rb.Num("mass", 1f);
                body.linearDamping = rb.Num("linearDamping", 0f);
                body.angularDamping = rb.Num("angularDamping", 0.05f);
                body.useGravity = Mathf.Abs(rb.Num("gravityScale", 1f)) > 0.001f;
                body.isKinematic = rb.Str("kind") == "kinematic";
                body.interpolation = RigidbodyInterpolation.Interpolate;
                if (rb.Bool("lockRotation", false)) body.constraints = RigidbodyConstraints.FreezeRotation;
                if (rb.Bool("ccd", false)) body.collisionDetectionMode = CollisionDetectionMode.ContinuousDynamic;
            }

            var light = e["light"];
            if (light.IsObject) BuildLight(go, light);
            var camera = e["camera"];
            if (camera.IsObject) BuildCamera(go, camera);

            var n = 0;
            foreach (var a in e.Arr("audio"))
            {
                var clip = AssetDatabase.LoadAssetAtPath<AudioClip>(a.Str("clip") ?? "");
                if (clip == null)
                {
                    Warn($"{go.name}: audio clip '{a.Str("clip")}' not found.");
                    continue;
                }
                var child = Child(go, n++ == 0 ? "Audio" : $"Audio_{n}");
                var src = child.AddComponent<AudioSource>();
                src.clip = clip;
                src.playOnAwake = false;
                var spatial = a.Bool("spatial", false);
                var range = a.Num("range", 12f);
                src.spatialBlend = spatial ? 1f : 0f;
                src.rolloffMode = AudioRolloffMode.Logarithmic;
                src.minDistance = Mathf.Max(0.5f, range / 4f);
                src.maxDistance = range * 1.5f;
                src.dopplerLevel = 0f;
                src.loop = a.Bool("loop", false);
                src.volume = a.Num("volume", 0.8f);
                var aa = child.AddComponent<AigeAudio>();
                aa.Volume = src.volume;
                aa.Loop = src.loop;
                aa.PlayOnStart = a.Bool("playOnStart", false);
                aa.Range = range;
            }

            foreach (var c in e.Arr("components"))
            {
                var type = c.Str("type");
                Component? comp = type switch
                {
                    "Interactable" => go.AddComponent<Interactable>(),
                    "Door" => go.AddComponent<Door>(),
                    "Trigger" => go.AddComponent<Trigger>(),
                    "ParticleSystem" => go.AddComponent<AigeParticles>(),
                    "Animator" => go.AddComponent<AigeAnimator>(),
                    _ => null,
                };
                if (comp == null)
                {
                    Warn($"{go.name}: component '{type}' has no Unity version.");
                    continue;
                }
                SetProps(comp, c["props"], type == "Animator" ? new[] { "clips" } : Array.Empty<string>());
                if (comp is AigeAnimator anim)
                {
                    var modelPath = mesh.Str("model");
                    anim.Clips = modelPath == null ? Array.Empty<AnimationClip>()
                        : AssetDatabase.LoadAllAssetRepresentationsAtPath(modelPath).OfType<AnimationClip>().Where(k => !k.name.StartsWith("__preview__")).ToArray();
                    if (anim.Clips.Length == 0) Warn($"{go.name}: the model has no animation clips.");
                }
                if (comp is AigeParticles ps) ps.Material = ParticleMaterial();
            }

            foreach (var s in e.Arr("scripts"))
            {
                Type? t = null;
                var nameOf = s.Str("name") ?? "";
                if (s.Str("kind") == "builtin") t = typeof(PlayerController).Assembly.GetType("Aige." + nameOf);
                else
                {
                    var ms = AssetDatabase.LoadAssetAtPath<MonoScript>(s.Str("path") ?? "");
                    t = ms != null ? ms.GetClass() : null;
                    if (t == null)
                    {
                        Warn($"{go.name}: script '{s.Str("path")}' has no compiled class '{nameOf}' (fix its C# errors; the class must match the file name).");
                        continue;
                    }
                }
                if (t == null || !typeof(MonoBehaviour).IsAssignableFrom(t))
                {
                    Warn($"{go.name}: script '{nameOf}' is not a MonoBehaviour.");
                    continue;
                }
                var existing = go.GetComponent(t);
                var comp = existing != null ? existing : go.AddComponent(t);
                SetProps(comp, s["props"], Array.Empty<string>());
            }

            var env = e["environment"];
            if (env.IsObject) envs[go.name] = BuildEnvironment(go, env, sceneName);
        }

        static GameObject Child(GameObject parent, string name)
        {
            var c = new GameObject(name);
            c.transform.SetParent(parent.transform, false);
            return c;
        }

        static GameObject? BuildMesh(GameObject go, JsonNode mesh)
        {
            GameObject? inst = null;
            var modelPath = mesh.Str("model");
            if (modelPath != null)
            {
                var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(modelPath);
                if (prefab == null) Warn($"{go.name}: model '{modelPath}' did not import (see the Unity log for glTFast errors).");
                else
                {
                    inst = (GameObject)PrefabUtility.InstantiatePrefab(prefab, go.transform);
                    inst.name = "Mesh";
                    inst.transform.localPosition = Vector3.zero;
                    inst.transform.localRotation = Quaternion.identity;
                    inst.transform.localScale = Vector3.one;
                }
            }
            if (inst == null)
            {
                var prim = mesh.Str("primitive") ?? "box";
                var (ptype, scale) = prim switch
                {
                    "sphere" => (PrimitiveType.Sphere, Vector3.one),
                    "cylinder" => (PrimitiveType.Cylinder, new Vector3(1f, 0.5f, 1f)),
                    "cone" => (PrimitiveType.Cylinder, new Vector3(1f, 0.5f, 1f)),
                    "capsule" => (PrimitiveType.Capsule, new Vector3(0.5f, 0.5f, 0.5f)),
                    "plane" => (PrimitiveType.Plane, new Vector3(0.1f, 1f, 0.1f)),
                    "torus" => (PrimitiveType.Sphere, new Vector3(1.3f, 0.3f, 1.3f)),
                    _ => (PrimitiveType.Cube, Vector3.one),
                };
                if (prim == "cone" || prim == "torus") Warn($"{go.name}: primitive '{prim}' is approximated in Unity.");
                inst = GameObject.CreatePrimitive(ptype);
                UnityEngine.Object.DestroyImmediate(inst.GetComponent<Collider>());
                inst.name = "Mesh";
                inst.transform.SetParent(go.transform, false);
                inst.transform.localScale = scale;
                var matPath = mesh.Str("material");
                var mat = matPath != null ? MaterialFor(matPath) : null;
                inst.GetComponent<Renderer>().sharedMaterial = mat != null ? mat : ColorMaterial(mesh.Str("color") ?? "#ffffff");
            }
            else ApplyPartMaterials(go, inst, mesh);

            var cast = mesh.Bool("castShadow", true);
            var receive = mesh.Bool("receiveShadow", true);
            var visible = mesh.Bool("visible", true);
            foreach (var r in inst.GetComponentsInChildren<Renderer>(true))
            {
                var transparent = r.sharedMaterials.Any(m => m != null && m.renderQueue >= 2900);
                r.shadowCastingMode = cast && !transparent ? ShadowCastingMode.On : ShadowCastingMode.Off;
                r.receiveShadows = receive;
                if (!visible) r.enabled = false;
            }
            return inst;
        }

        /// <summary>MeshRenderer.material (all parts) and .materials (per part name) → shared URP materials.</summary>
        static void ApplyPartMaterials(GameObject go, GameObject inst, JsonNode mesh)
        {
            var all = mesh.Str("material");
            var parts = new Dictionary<string, string>();
            foreach (var kv in mesh["parts"].Fields)
                if (kv.Value.AsString != null) parts[kv.Key] = kv.Value.AsString;
            if (all == null && parts.Count == 0) return;
            var matched = new HashSet<string>();
            foreach (var r in inst.GetComponentsInChildren<Renderer>(true))
            {
                string? path = null;
                for (var t = r.transform; t != null && t != inst.transform.parent; t = t.parent)
                {
                    var n = t.name;
                    if (parts.TryGetValue(n, out path)) { matched.Add(n); break; }
                    var us = n.LastIndexOf('_');
                    if (us > 0 && int.TryParse(n.Substring(us + 1), out _) && parts.TryGetValue(n.Substring(0, us), out path))
                    {
                        matched.Add(n.Substring(0, us));
                        break;
                    }
                }
                path ??= all;
                if (path == null) continue;
                var mat = MaterialFor(path);
                if (mat == null) continue;
                var mats = r.sharedMaterials;
                for (var i = 0; i < mats.Length; i++) mats[i] = mat;
                r.sharedMaterials = mats;
            }
            foreach (var p in parts.Keys)
                if (!matched.Contains(p)) Warn($"{go.name}: model has no part '{p}' for its material.");
        }

        static void AddCollider(GameObject go, JsonNode c, GameObject? model, bool trigger)
        {
            var shape = c.Str("shape") ?? "box";
            var center = V3(c["center"], Vector3.zero);
            var size = V3(c["size"], Vector3.one);
            var radius = c.Num("radius", 0.5f);
            var height = c.Num("height", 1f);
            Collider? col = null;
            switch (shape)
            {
                case "sphere":
                    var sc = go.AddComponent<SphereCollider>();
                    sc.center = center;
                    sc.radius = radius;
                    col = sc;
                    break;
                case "capsule":
                    var cap = go.AddComponent<CapsuleCollider>();
                    cap.center = center;
                    cap.radius = radius;
                    cap.height = height;
                    cap.direction = 1;
                    col = cap;
                    break;
                case "cylinder":
                    var holder = Child(go, "Cylinder");
                    holder.transform.localPosition = center;
                    holder.transform.localScale = new Vector3(radius * 2f, height, radius * 2f);
                    var mc = holder.AddComponent<MeshCollider>();
                    mc.sharedMesh = CylinderMesh();
                    mc.convex = true;
                    mc.isTrigger = trigger;
                    return;
                case "mesh":
                case "convex":
                    if (model != null)
                    {
                        var any = false;
                        foreach (var mf in model.GetComponentsInChildren<MeshFilter>(true))
                        {
                            if (mf.sharedMesh == null) continue;
                            var target = mf.gameObject == go ? go : mf.gameObject;
                            var m = target.AddComponent<MeshCollider>();
                            m.sharedMesh = mf.sharedMesh;
                            m.convex = shape == "convex" || trigger;
                            m.isTrigger = trigger;
                            any = true;
                        }
                        if (any) return;
                    }
                    goto default;
                default:
                    var bc = go.AddComponent<BoxCollider>();
                    bc.center = center;
                    bc.size = size;
                    col = bc;
                    break;
            }
            col.isTrigger = trigger;
        }

        static void BuildLight(GameObject go, JsonNode l)
        {
            var child = Child(go, "Light");
            child.transform.localRotation = Quaternion.Euler(0f, 180f, 0f); // AIGE lights shine along -Z
            var light = child.AddComponent<Light>();
            var type = l.Str("type") ?? "point";
            light.type = type == "directional" ? LightType.Directional : type == "spot" ? LightType.Spot : LightType.Point;
            light.color = AigeJson.ParseColor(l.Str("color") ?? "#ffffff");
            light.intensity = AigeLights.Intensity(l.Num("intensity", 1f), light.type);
            light.range = l.Num("range", 30f);
            if (light.type == LightType.Spot)
            {
                light.spotAngle = Mathf.Clamp(l.Num("angle", 30f) * 2f, 1f, 179f);
                light.innerSpotAngle = light.spotAngle * 0.7f;
            }
            light.shadows = l.Bool("shadows", false) ? LightShadows.Soft : LightShadows.None;
            light.shadowNormalBias = 0.3f;
            light.lightmapBakeType = LightmapBakeType.Realtime;
            var flicker = l.Num("flicker", 0f);
            if (flicker > 0f) child.AddComponent<LightFlicker>().Amount = flicker;
        }

        static void BuildCamera(GameObject go, JsonNode c)
        {
            var child = Child(go, "Camera");
            child.transform.localRotation = Quaternion.Euler(0f, 180f, 0f); // AIGE cameras look along -Z
            var cam = child.AddComponent<Camera>();
            cam.fieldOfView = c.Num("fov", 60f);
            cam.nearClipPlane = Mathf.Min(c.Num("near", 0.1f), 0.05f);
            cam.farClipPlane = c.Num("far", 500f);
            var data = child.AddComponent<UniversalAdditionalCameraData>();
            data.renderPostProcessing = true;
            data.antialiasing = AntialiasingMode.SubpixelMorphologicalAntiAliasing;
            data.antialiasingQuality = AntialiasingQuality.High;
            if (c.Bool("primary", true))
            {
                child.tag = "MainCamera";
                child.AddComponent<AudioListener>();
            }
            else cam.enabled = false;
        }

        static AigeEnvironment BuildEnvironment(GameObject go, JsonNode env, string sceneName)
        {
            var e = go.AddComponent<AigeEnvironment>();
            e.ToneMapping = env.Str("toneMapping") ?? "aces";
            e.Exposure = env.Num("exposure", 1f);
            e.Contrast = env.Num("contrast", 1.05f);
            e.Saturation = env.Num("saturation", 1f);
            e.Bloom = env.Num("bloom", 0.25f);
            e.BloomThreshold = env.Num("bloomThreshold", 0.9f);
            e.Vignette = env.Num("vignette", 0.25f);
            e.Grain = env.Num("grain", 0.12f);
            e.Temperature = env.Num("temperature", 0f);
            e.Tint = env.Num("tint", 0f);
            e.ChromaticAberration = env.Num("chromaticAberration", 0f);
            e.Ssao = env.Num("ssao", 0.8f);
            e.SsaoRadius = env.Num("ssaoRadius", 0.35f);
            e.FogColor = AigeJson.ParseColor(env.Str("fogColor") ?? "#1a1f2a");
            e.Background = e.FogColor;
            e.FogDensity = env.Num("fogDensity", 0f);
            e.Ambient = env.Num("ambient", 1f);
            e.SkyEnergy = env.Num("skyEnergy", 1f);
            e.SunDirection = V3(env["sunDirection"], new Vector3(0.4f, 0.45f, -0.8f));
            if (env.Num("volumetricFog", 0f) > 0f) Warn($"{go.name}: volumetric fog is not available in URP (exponential fog is used).");

            var dir = DataDir + "/environments";
            Directory.CreateDirectory(dir);
            var baseName = $"{sceneName}-{go.name}";
            var hdri = env.Str("hdri");
            var sky = env.Str("sky") ?? "none";
            Material? skyMat = null;
            if (hdri != null)
            {
                var tex = AssetDatabase.LoadAssetAtPath<Texture>(hdri);
                if (tex == null) Warn($"{go.name}: HDRI '{hdri}' not found.");
                else
                {
                    skyMat = SkyMaterial($"{dir}/{baseName}-sky.mat", "Skybox/Panoramic");
                    skyMat.SetTexture("_MainTex", tex);
                    skyMat.SetFloat("_Mapping", 1f);
                    skyMat.SetFloat("_ImageType", 0f);
                    skyMat.SetFloat("_Exposure", e.SkyEnergy);
                    skyMat.SetFloat("_Rotation", Mathf.Repeat(env.Num("hdriRotation", 0f), 360f));
                }
            }
            else if (sky != "none")
            {
                skyMat = SkyMaterial($"{dir}/{baseName}-sky.mat", "Skybox/Procedural");
                var night = sky == "night" || sky == "storm";
                skyMat.SetFloat("_Exposure", (night ? 0.15f : sky == "overcast" ? 0.8f : 1.1f) * e.SkyEnergy);
                skyMat.SetFloat("_AtmosphereThickness", sky == "dawn" || sky == "dusk" ? 1.6f : night ? 0.6f : 1f);
                skyMat.SetColor("_SkyTint", night ? new Color(0.15f, 0.18f, 0.25f) : new Color(0.5f, 0.55f, 0.6f));
                skyMat.SetColor("_GroundColor", new Color(0.2f, 0.19f, 0.18f));
            }
            if (skyMat != null) EditorUtility.SetDirty(skyMat);
            e.Skybox = skyMat;

            var profilePath = $"{dir}/{baseName}.asset";
            if (AssetDatabase.LoadAssetAtPath<VolumeProfile>(profilePath) != null) AssetDatabase.DeleteAsset(profilePath);
            var profile = e.BuildProfile();
            AssetDatabase.CreateAsset(profile, profilePath);
            foreach (var c in profile.components) AssetDatabase.AddObjectToAsset(c, profile);
            AssetDatabase.SaveAssets();
            e.Profile = AssetDatabase.LoadAssetAtPath<VolumeProfile>(profilePath);
            return e;
        }

        static Material SkyMaterial(string path, string shaderName)
        {
            var shader = Shader.Find(shaderName);
            var mat = AssetDatabase.LoadAssetAtPath<Material>(path);
            if (mat == null)
            {
                mat = new Material(shader);
                AssetDatabase.CreateAsset(mat, path);
            }
            else mat.shader = shader;
            return mat;
        }

        // =====================================================================================
        // Props (AIGE names/values → public fields, case-insensitive)
        // =====================================================================================

        /// <summary>Assigns AIGE props to a component's serialized fields (walkSpeed → WalkSpeed).</summary>
        public static void SetProps(Component comp, JsonNode props, string[] skip)
        {
            var type = comp.GetType();
            var fields = type.GetFields(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)
                .Where(f => f.IsPublic || f.GetCustomAttribute<SerializeField>() != null)
                .ToList();
            foreach (var kv in props.Fields)
            {
                if (skip.Contains(kv.Key)) continue;
                var key = kv.Key.Replace("_", "");
                var f = fields.FirstOrDefault(x => string.Equals(x.Name.TrimStart('_').Replace("_", ""), key, StringComparison.OrdinalIgnoreCase));
                if (f == null)
                {
                    Warn($"{comp.gameObject.name}: {type.Name} has no field for prop '{kv.Key}'.");
                    continue;
                }
                var v = Convert(kv.Value, f.FieldType, f.Name);
                if (v == null && !(kv.Value.IsNull))
                {
                    Warn($"{comp.gameObject.name}: prop '{kv.Key}' can't be assigned to {type.Name}.{f.Name} ({f.FieldType.Name}).");
                    continue;
                }
                f.SetValue(comp, v);
            }
            EditorUtility.SetDirty(comp);
        }

        static object? Convert(JsonNode v, Type t, string field)
        {
            if (t == typeof(float)) return v.IsNumber ? (object)v.AsFloat() : null;
            if (t == typeof(int)) return v.IsNumber ? (object)(int)Math.Round(v.AsFloat()) : null;
            if (t == typeof(bool)) return v.Value is bool b ? (object)b : null;
            if (t == typeof(string)) return v.AsString ?? (v.IsNumber ? v.AsFloat().ToString(System.Globalization.CultureInfo.InvariantCulture) : null);
            if (t == typeof(Vector3))
            {
                if (v.TryVec3(out var vec)) return vec;
                if (v.IsNumber) return field == "Speed" ? new Vector3(0f, v.AsFloat(), 0f) : Vector3.one * v.AsFloat();
                return null;
            }
            if (t == typeof(Vector2)) return v.IsArray && v.Items.Count >= 2 ? (object)new Vector2(v[0].AsFloat(), v[1].AsFloat()) : null;
            if (t == typeof(Color)) return v.AsString != null ? (object)AigeJson.ParseColor(v.AsString) : null;
            if (t == typeof(string[])) return v.IsArray ? v.Items.Select(i => i.AsString ?? "").ToArray() : null;
            if (t.IsEnum && v.AsString != null)
                try { return Enum.Parse(t, v.AsString, true); }
                catch (ArgumentException) { return null; }
            return null;
        }
    }

    /// <summary>
    /// Import settings for exported textures: normal maps become Normal Map textures, packed data maps (ORM,
    /// masks) are linear. Roles come from Assets/AigeData/textures.json (written by unity_export) or the file name.
    /// </summary>
    public sealed class AigeTexturePostprocessor : AssetPostprocessor
    {
        static Dictionary<string, string>? _roles;

        public override uint GetVersion() => 2;

        static string? RoleOf(string path)
        {
            if (_roles == null)
            {
                _roles = new Dictionary<string, string>();
                var file = AigeImporter.DataDir + "/textures.json";
                var doc = File.Exists(file) ? AigeJson.Parse(File.ReadAllText(file), file) : null;
                if (doc != null)
                    foreach (var kv in doc.Fields)
                        if (kv.Value.AsString != null) _roles[kv.Key] = kv.Value.AsString;
            }
            if (_roles.TryGetValue(path, out var role)) return role;
            var name = Path.GetFileNameWithoutExtension(path).ToLowerInvariant();
            if (name.EndsWith("_mask")) return "linear";
            if (name.Contains("_nor_") || name.EndsWith("_normal") || name.Contains("_nor_gl")) return "normal";
            if (name.Contains("_arm_") || name.Contains("_orm")) return "linear";
            return null;
        }

        void OnPreprocessTexture()
        {
            if (!assetPath.StartsWith(AigeImporter.DataDir + "/")) return;
            var importer = (TextureImporter)assetImporter;
            var role = RoleOf(assetPath);
            importer.maxTextureSize = 2048;
            importer.mipmapEnabled = true;
            if (role == "normal") importer.textureType = TextureImporterType.NormalMap;
            else if (role == "linear") importer.sRGBTexture = false;
            else if (role == "hdri")
            {
                importer.maxTextureSize = 4096;
                importer.wrapModeU = TextureWrapMode.Repeat;
                importer.wrapModeV = TextureWrapMode.Clamp;
            }
        }
    }
}
