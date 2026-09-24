#nullable enable
using System;
using System.Collections.Generic;
using UnityEngine;

namespace Aige
{
    /// <summary>
    /// AIGE ↔ Unity coordinates. AIGE is right-handed (like three.js/glTF); Unity is left-handed. AIGE data
    /// (cutscene keys, teleports) is converted by mirroring X, exactly like glTFast imports GLBs:
    /// position (x, y, z) → (-x, y, z); Euler degrees [a, b, c] (XYZ order) → Rx(a)·Ry(-b)·Rz(-c); yaw → -yaw.
    /// Models face +Z in both, so <c>transform.forward</c> is where a character looks.
    /// </summary>
    public static class Coords
    {
        /// <summary>AIGE position or direction → Unity.</summary>
        public static Vector3 Position(Vector3 aige) => new Vector3(-aige.x, aige.y, aige.z);

        /// <summary>Unity position → AIGE (the same mirror).</summary>
        public static Vector3 ToAige(Vector3 unity) => new Vector3(-unity.x, unity.y, unity.z);

        /// <summary>AIGE Euler degrees (XYZ order) → Unity rotation.</summary>
        public static Quaternion Rotation(Vector3 aigeEulerDeg) =>
            Quaternion.AngleAxis(aigeEulerDeg.x, Vector3.right) *
            Quaternion.AngleAxis(-aigeEulerDeg.y, Vector3.up) *
            Quaternion.AngleAxis(-aigeEulerDeg.z, Vector3.forward);

        /// <summary>AIGE yaw (degrees around +Y) → Unity yaw.</summary>
        public static float Yaw(float aigeYaw) => -aigeYaw;
    }

    /// <summary>
    /// AIGE light intensity → Unity (URP) intensity. The importer and cutscene light tweens use the same scale.
    /// </summary>
    public static class AigeLights
    {
        public static float PointScale = 2.4f;
        public static float DirectionalScale = 1f;
        /// <summary>Sky ambient multiplier (stands in for the bounce light Godot's SDFGI adds).</summary>
        public static float AmbientScale = 2f;

        public static float Intensity(float aige, LightType type) =>
            aige * (type == LightType.Directional ? DirectionalScale : PointScale);
    }

    /// <summary>
    /// AIGE data files exported under <c>Assets/Resources/aige/</c> with their AIGE paths:
    /// 'cutscenes/cs1.cutscene.json', 'audio/voice/hero_wake_1.ogg', 'sfx/thunder', 'ambience/storm'.
    /// </summary>
    public static class AigeAssets
    {
        public const string Root = "aige/";

        /// <summary>Normalizes 'res://x', './x', '\x' to 'x'. Godot paths of baked audio map to the Unity folders.</summary>
        public static string Clean(string path)
        {
            var p = path.Trim().Replace('\\', '/');
            if (p.StartsWith("res://")) p = p.Substring(6);
            while (p.StartsWith("./") || p.StartsWith("/")) p = p.Substring(p[0] == '.' ? 2 : 1);
            if (p.StartsWith("godot/audio/")) p = p.Substring(12);
            return p;
        }

        /// <summary>Resources.Load path: 'aige/' + the AIGE path without its last extension.</summary>
        public static string ResourcePath(string path)
        {
            var p = Clean(path);
            var slash = p.LastIndexOf('/');
            var dot = p.LastIndexOf('.');
            if (dot > slash) p = p.Substring(0, dot);
            return Root + p;
        }

        /// <summary>Text of an exported JSON document, or null.</summary>
        public static string? Text(string path) => Resources.Load<TextAsset>(ResourcePath(path))?.text;

        /// <summary>An exported audio clip, or null.</summary>
        public static AudioClip? Clip(string path) => Resources.Load<AudioClip>(ResourcePath(path));
    }

    /// <summary>Runtime logging. Messages go to the Unity console; the test harness copies them into its report.</summary>
    public static class Log
    {
        static readonly HashSet<string> Once = new HashSet<string>();

        /// <summary>Raised for every <see cref="Info"/> message (recorded as a 'log' event in test reports).</summary>
        public static event Action<string>? Message;

        /// <summary>Raised for every warning and error: (message, isError).</summary>
        public static event Action<string, bool>? Problem;

        /// <example><code>Log.Info("Hero found the knife");</code></example>
        public static void Info(string message)
        {
            Debug.Log("[aige] " + message);
            Message?.Invoke(message);
        }

        /// <summary>A warning (does not fail a test run).</summary>
        public static void Warn(string message)
        {
            Debug.LogWarning("[aige] " + message);
            Problem?.Invoke(message, false);
        }

        /// <summary>An error (fails a test run).</summary>
        public static void Error(string message)
        {
            Debug.LogError("[aige] " + message);
            Problem?.Invoke(message, true);
        }

        /// <summary>A warning printed only the first time <paramref name="key"/> is seen.</summary>
        public static void WarnOnce(string key, string message)
        {
            if (Once.Add(key)) Warn(message);
        }
    }

    /// <summary>
    /// Something the player can use with the interact button. <see cref="Interactable"/> and <see cref="Door"/>
    /// implement it; a game script can too (register in OnEnable, unregister in OnDisable).
    /// </summary>
    public interface IInteractable
    {
        GameObject Entity { get; }
        string PromptText { get; }
        float InteractRange { get; }
        bool CanInteract { get; }
        Vector3 InteractPoint { get; }
        void Interact(GameObject? by);
    }

    /// <summary>Registry of everything the player can interact with.</summary>
    public static class Interaction
    {
        static readonly List<IInteractable> Items = new List<IInteractable>();
        public static IReadOnlyList<IInteractable> All => Items;

        public static void Register(IInteractable item)
        {
            if (!Items.Contains(item)) Items.Add(item);
        }

        public static void Unregister(IInteractable item) => Items.Remove(item);
    }

    /// <summary>Easing curves used by cutscene keys ('linear', 'in', 'out', 'inOut', 'hold').</summary>
    public static class Easing
    {
        public static float Apply(string? ease, float t)
        {
            t = Mathf.Clamp01(t);
            switch (ease)
            {
                case "linear": return t;
                case "in": return t * t * t;
                case "out": return 1f - Mathf.Pow(1f - t, 3f);
                case "hold": return t >= 1f ? 1f : 0f;
                default: return t < 0.5f ? 4f * t * t * t : 1f - Mathf.Pow(-2f * t + 2f, 3f) / 2f;
            }
        }

        /// <summary>Hermite smoothstep.</summary>
        public static float Smooth(float t)
        {
            t = Mathf.Clamp01(t);
            return t * t * (3f - 2f * t);
        }

        /// <summary>Frame-rate independent exponential smoothing factor for a rate (1/s).</summary>
        public static float Damp(float rate, float dt) => 1f - Mathf.Exp(-rate * dt);
    }

    /// <summary>Runs a callback when its GameObject is destroyed (used by <see cref="Story.On"/> owners).</summary>
    [AddComponentMenu("")]
    public sealed class AigeLifetime : MonoBehaviour
    {
        public event Action? Destroyed;
        void OnDestroy() => Destroyed?.Invoke();

        public static AigeLifetime Of(GameObject go)
        {
            var l = go.GetComponent<AigeLifetime>();
            return l != null ? l : go.AddComponent<AigeLifetime>();
        }
    }

    /// <summary>
    /// Creates the AIGE services once per game, before the first scene loads (the equivalent of Godot autoloads):
    /// a persistent 'AIGE' object with <see cref="Story"/>, <see cref="Hud"/>, <see cref="Voice"/>, <see cref="Sfx"/>,
    /// <see cref="Cutscenes"/> and <see cref="AigeTest"/>.
    /// </summary>
    public static class AigeRuntime
    {
        public static GameObject? Root { get; private set; }

        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.BeforeSceneLoad)]
        static void Boot()
        {
            if (Root != null) return;
            Root = new GameObject("AIGE");
            UnityEngine.Object.DontDestroyOnLoad(Root);
            Root.AddComponent<Story>();
            Root.AddComponent<Sfx>();
            Root.AddComponent<Hud>();
            Root.AddComponent<Voice>();
            Root.AddComponent<Cutscenes>();
            Root.AddComponent<AigeTest>();
        }
    }
}
