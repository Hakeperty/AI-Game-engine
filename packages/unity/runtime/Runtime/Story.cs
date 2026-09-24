#nullable enable
using System;
using System.Collections.Generic;
using UnityEngine;

namespace Aige
{
    /// <summary>
    /// Story state: flags, inventory, the current objective with an optional waypoint, and named game
    /// events. Everything is static, so call it from anywhere:
    /// <code>
    /// Story.SetFlag("saw_photo_1");
    /// if (Story.HasFlag("saw_photo_1") &amp;&amp; Story.Has("knife")) Story.SetObjective("Find Murphy's room", "Door_Stairs", pointerDelay: 30);
    /// Story.On("thunder", () =&gt; Sfx.Play("thunder"), this);
    /// </code>
    /// </summary>
    [AddComponentMenu("")]
    public sealed class Story : MonoBehaviour
    {
        static readonly HashSet<string> ActiveFlags = new HashSet<string>();
        static readonly List<string> FlagOrder = new List<string>();
        static readonly List<string> Inventory = new List<string>();
        static readonly Dictionary<string, List<Action>> Handlers = new Dictionary<string, List<Action>>();
        static float _pointerTimer = -1f;

        public static Story? Instance { get; private set; }

        public static event Action<string>? FlagSet;
        public static event Action<string>? FlagCleared;
        public static event Action<string>? ItemGiven;
        public static event Action<string>? ItemTaken;
        /// <summary>(text, target or null). Empty text = no objective.</summary>
        public static event Action<string, GameObject?>? ObjectiveChanged;
        public static event Action<GameObject>? PointerRevealed;
        public static event Action<string>? Emitted;

        public static IReadOnlyList<string> Flags => FlagOrder;
        public static IReadOnlyList<string> Items => Inventory;
        public static string Objective { get; private set; } = "";
        public static GameObject? ObjectiveTarget { get; private set; }
        public static bool PointerVisible { get; private set; }

        void Awake() => Instance = this;

        void OnDestroy()
        {
            if (Instance == this) Instance = null;
        }

        /// <summary>Sets a story flag (no-op if set). Doors with UnlockFlag and Interactables with RequireFlag react to it.</summary>
        public static void SetFlag(string flag)
        {
            if (string.IsNullOrEmpty(flag) || !ActiveFlags.Add(flag)) return;
            FlagOrder.Add(flag);
            FlagSet?.Invoke(flag);
            Dispatch("flag:" + flag);
        }

        public static void SetFlag(string flag, bool value)
        {
            if (value) SetFlag(flag);
            else ClearFlag(flag);
        }

        public static void ClearFlag(string flag)
        {
            if (string.IsNullOrEmpty(flag) || !ActiveFlags.Remove(flag)) return;
            FlagOrder.Remove(flag);
            FlagCleared?.Invoke(flag);
        }

        public static bool HasFlag(string flag) => !string.IsNullOrEmpty(flag) && ActiveFlags.Contains(flag);

        public static bool HasFlags(params string[] flags)
        {
            foreach (var f in flags)
                if (!HasFlag(f)) return false;
            return true;
        }

        /// <summary>Adds an item to the inventory (no-op if held).</summary>
        public static void Give(string item)
        {
            if (string.IsNullOrEmpty(item) || Inventory.Contains(item)) return;
            Inventory.Add(item);
            ItemGiven?.Invoke(item);
            Dispatch("item:" + item);
        }

        public static bool Take(string item)
        {
            if (!Inventory.Remove(item)) return false;
            ItemTaken?.Invoke(item);
            return true;
        }

        public static bool Has(string item) => Inventory.Contains(item);

        /// <summary>
        /// Sets the objective shown top-left. With a target, a subtle waypoint appears on it after
        /// <paramref name="pointerDelay"/> seconds of free play (0 = at once).
        /// </summary>
        public static void SetObjective(string text, GameObject? target = null, float pointerDelay = 0f)
        {
            Objective = text ?? "";
            ObjectiveTarget = string.IsNullOrEmpty(Objective) ? null : target;
            PointerVisible = false;
            _pointerTimer = ObjectiveTarget != null ? Mathf.Max(0f, pointerDelay) : -1f;
            ObjectiveChanged?.Invoke(Objective, ObjectiveTarget);
            if (_pointerTimer == 0f) RevealPointer();
        }

        /// <summary>Sets the objective with a target entity reference (id, path or name).</summary>
        /// <example><code>Story.SetObjective("Find Murphy's room", "Door_Stairs", pointerDelay: 45);</code></example>
        public static void SetObjective(string text, string targetRef, float pointerDelay = 0f)
        {
            var target = Entities.Find(targetRef);
            if (target == null && !string.IsNullOrEmpty(targetRef)) Log.Warn($"Objective target '{targetRef}' not found.");
            SetObjective(text, target, pointerDelay);
        }

        public static void ClearObjective() => SetObjective("");

        public static void RevealPointer()
        {
            if (ObjectiveTarget == null || PointerVisible) return;
            PointerVisible = true;
            _pointerTimer = -1f;
            PointerRevealed?.Invoke(ObjectiveTarget);
        }

        void Update()
        {
            if (ObjectiveTarget == null && _pointerTimer >= 0f)
            {
                _pointerTimer = -1f;
                PointerVisible = false;
            }
            if (_pointerTimer > 0f && !Cutscenes.InputBlocked && Time.timeScale > 0f)
            {
                _pointerTimer -= Time.deltaTime;
                if (_pointerTimer <= 0f) RevealPointer();
            }
        }

        /// <summary>
        /// Raises a named game event (cutscene 'emit' events land here too). Built-in: 'env:&lt;environment&gt;'
        /// cross-fades to another Environment (EnvironmentFx.Switch; the entity name or an exported path).
        /// </summary>
        public static void Emit(string name)
        {
            if (string.IsNullOrEmpty(name)) return;
            Emitted?.Invoke(name);
            if (name.StartsWith("env:")) EnvironmentFx.Switch(name.Substring(4));
            Dispatch(name);
        }

        /// <summary>
        /// Runs <paramref name="handler"/> on <see cref="Emit"/>(name); also 'flag:&lt;flag&gt;' and 'item:&lt;item&gt;'.
        /// With an <paramref name="owner"/> the handler is removed when the owner's GameObject is destroyed.
        /// </summary>
        /// <example><code>Story.On("flag:has_knife", () =&gt; Hud.Say("Lucky."), this);</code></example>
        public static void On(string name, Action handler, Component? owner = null)
        {
            if (!Handlers.TryGetValue(name, out var list)) Handlers[name] = list = new List<Action>();
            list.Add(handler);
            if (owner != null) AigeLifetime.Of(owner.gameObject).Destroyed += () => Off(name, handler);
        }

        public static void Off(string name, Action handler)
        {
            if (Handlers.TryGetValue(name, out var list)) list.Remove(handler);
        }

        static void Dispatch(string name)
        {
            if (!Handlers.TryGetValue(name, out var list) || list.Count == 0) return;
            foreach (var h in list.ToArray())
            {
                try
                {
                    h();
                }
                catch (Exception e)
                {
                    Log.Error($"Story handler for '{name}' failed: {e}");
                }
            }
        }

        /// <summary>Clears all flags, items and the objective (new game).</summary>
        public static void Reset()
        {
            ActiveFlags.Clear();
            FlagOrder.Clear();
            Inventory.Clear();
            SetObjective("");
        }
    }
}
