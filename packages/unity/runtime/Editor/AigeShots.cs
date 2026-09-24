#nullable enable
using System;
using System.Collections.Generic;
using System.IO;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.Rendering.Universal;

namespace Aige.Editor
{
    /// <summary>
    /// Renders fixed camera views of a scene to PNG (the final URP look: lights, shadows, post-processing).
    /// Batch mode with graphics: <c>-executeMethod Aige.Editor.AigeShots.Capture -aigeShots &lt;request.json&gt;</c>, where the
    /// request is <c>{"scene":"Assets/Scenes/house.unity","width":1280,"height":720,"out":"&lt;dir&gt;",
    /// "views":[{"position":[x,y,z],"target":[x,y,z],"fov":60}]}</c> in Unity coordinates. Writes &lt;out&gt;/shots.json.
    /// </summary>
    public static class AigeShots
    {
        public static void Capture()
        {
            var requestPath = AigeImporter.Arg("aigeShots");
            var files = new List<string>();
            var errors = new List<string>();
            var outDir = ".";
            try
            {
                var req = AigeJson.Parse(requestPath != null && File.Exists(requestPath) ? File.ReadAllText(requestPath) : null, "shots request")
                          ?? throw new InvalidOperationException("Missing -aigeShots request file.");
                outDir = req.Str("out") ?? Path.GetDirectoryName(requestPath) ?? ".";
                Directory.CreateDirectory(outDir);
                var scene = req.Str("scene") ?? "";
                if (!File.Exists(scene)) throw new InvalidOperationException($"Scene '{scene}' not found (run unity_export first).");
                EditorSettings.asyncShaderCompilation = false;
                EditorSceneManager.OpenScene(scene, OpenSceneMode.Single);
                DynamicGI.UpdateEnvironment();
                var w = (int)req.Num("width", 1280);
                var h = (int)req.Num("height", 720);
                var i = 0;
                foreach (var v in req.Arr("views"))
                {
                    v.TryVec3("position", out var pos);
                    v.TryVec3("target", out var target);
                    var path = Path.Combine(outDir, $"view-{i++}.png");
                    Render(pos, target, v.Num("fov", 60f), w, h, path);
                    files.Add(Path.GetFullPath(path));
                }
            }
            catch (Exception e)
            {
                errors.Add(e.Message);
                Debug.LogError("[aige] Screenshot failed: " + e);
            }
            File.WriteAllText(Path.Combine(outDir, "shots.json"), AigeJson.Write(new Dictionary<string, object?> { ["files"] = files, ["errors"] = errors }));
        }

        static void Render(Vector3 pos, Vector3 target, float fov, int w, int h, string path)
        {
            var go = new GameObject("AigeShotCamera");
            try
            {
                var cam = go.AddComponent<Camera>();
                var data = go.AddComponent<UniversalAdditionalCameraData>();
                data.renderPostProcessing = true;
                data.antialiasing = AntialiasingMode.SubpixelMorphologicalAntiAliasing;
                data.antialiasingQuality = AntialiasingQuality.High;
                var dir = target - pos;
                go.transform.SetPositionAndRotation(pos, Quaternion.LookRotation(dir.sqrMagnitude > 1e-6f ? dir : Vector3.forward, Vector3.up));
                cam.fieldOfView = fov;
                cam.nearClipPlane = 0.05f;
                cam.farClipPlane = 600f;
                var sky = RenderSettings.skybox;
                if (sky == null)
                {
                    cam.clearFlags = CameraClearFlags.SolidColor;
                    cam.backgroundColor = RenderSettings.fogColor;
                }
                var rt = new RenderTexture(w, h, 24, RenderTextureFormat.ARGB32, RenderTextureReadWrite.sRGB) { antiAliasing = 1 };
                cam.targetTexture = rt;
                for (var pass = 0; pass < 3; pass++) cam.Render(); // warm up shaders, TAA-free history, volumes
                var prev = RenderTexture.active;
                RenderTexture.active = rt;
                var tex = new Texture2D(w, h, TextureFormat.RGB24, false);
                tex.ReadPixels(new Rect(0, 0, w, h), 0, 0);
                tex.Apply();
                RenderTexture.active = prev;
                File.WriteAllBytes(path, tex.EncodeToPNG());
                cam.targetTexture = null;
                UnityEngine.Object.DestroyImmediate(tex);
                rt.Release();
                UnityEngine.Object.DestroyImmediate(rt);
            }
            finally
            {
                UnityEngine.Object.DestroyImmediate(go);
            }
        }
    }
}
