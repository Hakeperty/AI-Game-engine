#nullable enable
using System;
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace Aige
{
    /// <summary>Identity of an AIGE entity: its id ('e12') and tags ('Player', 'Furniture'). Added by the importer.</summary>
    [DisallowMultipleComponent]
    public sealed class AigeEntity : MonoBehaviour
    {
        public string Id = "";
        public string[] Tags = Array.Empty<string>();

        public bool HasTag(string tag) => Array.IndexOf(Tags, tag) >= 0;
    }

    /// <summary>
    /// Finds AIGE entities in the loaded scenes, including inactive ones. A reference is an entity id
    /// ('e12'), a path from the scene root ('Level/Kitchen/Fridge') or a name ('Fridge'), tried in that order.
    /// </summary>
    public static class Entities
    {
        static AigeEntity[]? _cache;
        static int _cacheFrame = -1;

        static Entities()
        {
            SceneManager.sceneLoaded += (_, __) => _cache = null;
            SceneManager.sceneUnloaded += _ => _cache = null;
        }

        static AigeEntity[] All()
        {
            if (_cache == null || (_cacheFrame != Time.frameCount && Array.Exists(_cache, e => e == null)))
            {
                _cache = UnityEngine.Object.FindObjectsByType<AigeEntity>(FindObjectsInactive.Include, FindObjectsSortMode.None);
                _cacheFrame = Time.frameCount;
            }
            return _cache;
        }

        /// <summary>Call after creating entities from code so lookups see them.</summary>
        public static void Invalidate() => _cache = null;

        /// <summary>Finds an entity by id, path or name (null when missing).</summary>
        /// <example><code>var fridge = Entities.Find("Kitchen/Fridge");</code></example>
        public static GameObject? Find(string? reference)
        {
            if (string.IsNullOrWhiteSpace(reference)) return null;
            var r = reference!.Trim().TrimStart('%');
            var all = All();
            foreach (var e in all)
                if (e != null && e.Id == r) return e.gameObject;
            if (r.Contains("/"))
            {
                foreach (var e in all)
                    if (e != null && PathMatches(e.transform, r)) return e.gameObject;
                r = r.Substring(r.LastIndexOf('/') + 1);
            }
            foreach (var e in all)
                if (e != null && e.name == r) return e.gameObject;
            var go = GameObject.Find(r);
            return go;
        }

        static bool PathMatches(Transform t, string path)
        {
            var parts = path.Trim('/').Split('/');
            for (var i = parts.Length - 1; i >= 0; i--)
            {
                if (t == null || t.name != parts[i]) return false;
                t = t.parent;
            }
            return true;
        }

        /// <summary>Finds an entity and returns its component <typeparamref name="T"/> (on it or its children).</summary>
        public static T? Find<T>(string? reference) where T : Component => Component<T>(Find(reference));

        /// <summary>All entities with an AIGE tag.</summary>
        public static IEnumerable<GameObject> Tagged(string tag)
        {
            foreach (var e in All())
                if (e != null && e.HasTag(tag)) yield return e.gameObject;
        }

        /// <summary>The player: the PlayerController, else the first entity tagged 'Player'.</summary>
        public static GameObject? Player
        {
            get
            {
                if (PlayerController.Instance != null) return PlayerController.Instance.gameObject;
                foreach (var p in Tagged("Player")) return p;
                return null;
            }
        }

        /// <summary>A component on the entity, else on its children (inactive included).</summary>
        public static T? Component<T>(GameObject? entity) where T : Component
        {
            if (entity == null) return null;
            var c = entity.GetComponent<T>();
            return c != null ? c : entity.GetComponentInChildren<T>(true);
        }

        /// <summary>Shows or hides an entity with everything on it (rendering, colliders, scripts, audio).</summary>
        public static void SetEnabled(GameObject? entity, bool enabled)
        {
            if (entity != null) entity.SetActive(enabled);
        }

        /// <summary>A good point to look at on an entity: head height for characters, else the center of its meshes.</summary>
        public static Vector3 FocusPoint(GameObject go)
        {
            if (go.GetComponent<CharacterController>() != null || go.CompareTag("Player"))
                return go.transform.position + Vector3.up * 1.55f;
            var b = WorldBounds(go);
            return b?.center ?? go.transform.position;
        }

        /// <summary>World bounds of the visible renderers under <paramref name="go"/> (null if none).</summary>
        public static Bounds? WorldBounds(GameObject go)
        {
            Bounds? result = null;
            foreach (var r in go.GetComponentsInChildren<Renderer>())
            {
                if (!r.enabled || r is ParticleSystemRenderer) continue;
                if (result == null) result = r.bounds;
                else
                {
                    var b = result.Value;
                    b.Encapsulate(r.bounds);
                    result = b;
                }
            }
            return result;
        }

        /// <summary>Moves an entity to a Unity world position/rotation. Characters stop; the camera follows.</summary>
        public static void Teleport(GameObject go, Vector3 position, Quaternion? rotation = null)
        {
            var cc = go.GetComponent<CharacterController>();
            if (cc != null) cc.enabled = false;
            go.transform.position = position;
            if (rotation != null) go.transform.rotation = rotation.Value;
            if (cc != null) cc.enabled = true;
            var rb = go.GetComponent<Rigidbody>();
            if (rb != null && !rb.isKinematic) rb.linearVelocity = Vector3.zero;
            var pc = go.GetComponent<PlayerController>();
            if (pc != null) pc.OnTeleported();
        }

        /// <summary>Teleport with AIGE coordinates (position [x,y,z] and Euler degrees), as cutscenes and tests use.</summary>
        public static void TeleportAige(GameObject go, Vector3 aigePosition, Vector3? aigeEulerDeg = null) =>
            Teleport(go, Coords.Position(aigePosition), aigeEulerDeg != null ? Coords.Rotation(aigeEulerDeg.Value) : (Quaternion?)null);

        public static string NameOf(GameObject? go) => go == null ? "" : go.name;

        /// <summary>True when <paramref name="node"/> is <paramref name="ancestor"/> or inside it.</summary>
        public static bool IsInside(Transform? node, Transform? ancestor) =>
            node != null && ancestor != null && (node == ancestor || node.IsChildOf(ancestor));

        /// <summary>The camera that renders the game right now (cutscene, gameplay or main).</summary>
        public static Camera? ActiveCamera
        {
            get
            {
                if (Cutscenes.Camera != null && Cutscenes.Camera.enabled) return Cutscenes.Camera;
                if (ThirdPersonCamera.Current != null && ThirdPersonCamera.Current.Camera != null && ThirdPersonCamera.Current.Camera.enabled)
                    return ThirdPersonCamera.Current.Camera;
                var main = Camera.main;
                if (main != null) return main;
                Camera? best = null;
                foreach (var c in Camera.allCameras)
                    if (best == null || c.depth > best.depth) best = c;
                return best;
            }
        }
    }
}
