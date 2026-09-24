using System;
using System.Collections.Generic;
using Godot;

namespace Aige;

/// <summary>
/// Story state (autoload <c>Story</c>): flags, inventory, the current objective with an optional
/// waypoint, and named game events. Everything is static, so call it from anywhere:
/// <code>
/// Story.SetFlag("saw_photo_1");
/// if (Story.HasFlag("saw_photo_1") &amp;&amp; Story.Has("knife")) Story.SetObjective("Find Murphy's room", "Stairs", pointerDelay: 30);
/// Story.On("thunder", () =&gt; Sfx.Play("thunder"), this);
/// </code>
/// </summary>
public partial class Story : Node
{
    static readonly HashSet<string> ActiveFlags = new();
    static readonly List<string> FlagOrder = new();
    static readonly List<string> Inventory = new();
    static readonly Dictionary<string, List<Action>> Handlers = new();
    static float _pointerTimer = -1f;

    /// <summary>The autoload instance.</summary>
    public static Story? Instance { get; private set; }

    /// <summary>Raised when a flag becomes set.</summary>
    public static event Action<string>? FlagSet;

    /// <summary>Raised when a flag is cleared.</summary>
    public static event Action<string>? FlagCleared;

    /// <summary>Raised when an item is added to the inventory.</summary>
    public static event Action<string>? ItemGiven;

    /// <summary>Raised when an item is removed from the inventory.</summary>
    public static event Action<string>? ItemTaken;

    /// <summary>Raised when the objective changes: (text, target or null). Empty text = no objective.</summary>
    public static event Action<string, Node3D?>? ObjectiveChanged;

    /// <summary>Raised when the waypoint pointer of the current objective becomes visible.</summary>
    public static event Action<Node3D>? PointerRevealed;

    /// <summary>Raised by <see cref="Emit"/> with the event name.</summary>
    public static event Action<string>? Emitted;

    /// <summary>Set flags, in the order they were set.</summary>
    public static IReadOnlyList<string> Flags => FlagOrder;

    /// <summary>Inventory item ids, in the order they were given.</summary>
    public static IReadOnlyList<string> Items => Inventory;

    /// <summary>Current objective text ('' when none).</summary>
    public static string Objective { get; private set; } = "";

    /// <summary>World target of the current objective (null when none).</summary>
    public static Node3D? ObjectiveTarget { get; private set; }

    /// <summary>True once the objective's waypoint pointer should be shown.</summary>
    public static bool PointerVisible { get; private set; }

    public override void _EnterTree()
    {
        Instance = this;
        ProcessMode = ProcessModeEnum.Always;
        VertexColors.Hook(GetTree());
    }

    public override void _ExitTree()
    {
        if (Instance == this) Instance = null;
    }

    // ---------------------------------------------------------------- flags

    /// <summary>Sets a story flag (no-op if already set). Doors with <c>UnlockFlag</c> and Interactables with <c>RequireFlag</c> react to it.</summary>
    public static void SetFlag(string flag)
    {
        if (string.IsNullOrEmpty(flag) || !ActiveFlags.Add(flag)) return;
        FlagOrder.Add(flag);
        FlagSet?.Invoke(flag);
        Dispatch("flag:" + flag);
    }

    /// <summary>Sets or clears a flag.</summary>
    public static void SetFlag(string flag, bool value)
    {
        if (value) SetFlag(flag);
        else ClearFlag(flag);
    }

    /// <summary>Clears a story flag (no-op if not set).</summary>
    public static void ClearFlag(string flag)
    {
        if (string.IsNullOrEmpty(flag) || !ActiveFlags.Remove(flag)) return;
        FlagOrder.Remove(flag);
        FlagCleared?.Invoke(flag);
    }

    /// <summary>True when the flag is set.</summary>
    public static bool HasFlag(string flag) => !string.IsNullOrEmpty(flag) && ActiveFlags.Contains(flag);

    /// <summary>True when every flag is set.</summary>
    public static bool HasFlags(params string[] flags)
    {
        foreach (var f in flags)
            if (!HasFlag(f)) return false;
        return true;
    }

    // ---------------------------------------------------------------- inventory

    /// <summary>Adds an item to the inventory (no-op if already held).</summary>
    public static void Give(string item)
    {
        if (string.IsNullOrEmpty(item) || Inventory.Contains(item)) return;
        Inventory.Add(item);
        ItemGiven?.Invoke(item);
        Dispatch("item:" + item);
    }

    /// <summary>Removes an item. Returns false when it was not held.</summary>
    public static bool Take(string item)
    {
        if (!Inventory.Remove(item)) return false;
        ItemTaken?.Invoke(item);
        return true;
    }

    /// <summary>True when the item is in the inventory.</summary>
    public static bool Has(string item) => Inventory.Contains(item);

    // ---------------------------------------------------------------- objective

    /// <summary>
    /// Sets the objective shown top-left. With a <paramref name="target"/>, a subtle waypoint marker
    /// appears on it after <paramref name="pointerDelay"/> seconds of free play (0 = at once).
    /// </summary>
    /// <example><code>Story.SetObjective("Search the kitchen", kitchenTable, pointerDelay: 30);</code></example>
    public static void SetObjective(string text, Node3D? target = null, float pointerDelay = 0f)
    {
        Objective = text ?? "";
        ObjectiveTarget = string.IsNullOrEmpty(Objective) ? null : target;
        PointerVisible = false;
        _pointerTimer = ObjectiveTarget != null ? Math.Max(0f, pointerDelay) : -1f;
        ObjectiveChanged?.Invoke(Objective, ObjectiveTarget);
        if (_pointerTimer == 0f) RevealPointer();
    }

    /// <summary>Sets the objective with a target entity reference (id, path or name).</summary>
    /// <example><code>Story.SetObjective("Find Murphy's room", "StairsDoor", pointerDelay: 45);</code></example>
    public static void SetObjective(string text, string targetRef, float pointerDelay = 0f)
    {
        var target = Entities.Find(targetRef);
        if (target == null && !string.IsNullOrEmpty(targetRef)) Log.Warn($"Objective target '{targetRef}' not found.");
        SetObjective(text, target, pointerDelay);
    }

    /// <summary>Removes the objective.</summary>
    public static void ClearObjective() => SetObjective("");

    /// <summary>Shows the waypoint pointer now (if the objective has a target).</summary>
    public static void RevealPointer()
    {
        if (ObjectiveTarget == null || PointerVisible) return;
        PointerVisible = true;
        _pointerTimer = -1f;
        PointerRevealed?.Invoke(ObjectiveTarget);
    }

    public override void _Process(double delta)
    {
        if (ObjectiveTarget != null && !IsInstanceValid(ObjectiveTarget))
        {
            ObjectiveTarget = null;
            PointerVisible = false;
            _pointerTimer = -1f;
        }
        if (_pointerTimer > 0f && !Cutscenes.InputBlocked && !GetTree().Paused)
        {
            _pointerTimer -= (float)delta;
            if (_pointerTimer <= 0f) RevealPointer();
        }
    }

    // ---------------------------------------------------------------- events

    /// <summary>
    /// Raises a named game event (cutscene 'emit' events land here too). Built-in events:
    /// 'env:&lt;res path&gt;' cross-fades the scene to another Environment (EnvironmentFx.Switch).
    /// </summary>
    public static void Emit(string name)
    {
        if (string.IsNullOrEmpty(name)) return;
        Emitted?.Invoke(name);
        if (name.StartsWith("env:")) EnvironmentFx.Switch(name[4..]);
        Dispatch(name);
    }

    /// <summary>
    /// Runs <paramref name="handler"/> whenever <see cref="Emit"/> is called with <paramref name="name"/>.
    /// Also accepts 'flag:&lt;flag&gt;' and 'item:&lt;item&gt;'. With an <paramref name="owner"/> node the
    /// handler is removed automatically when that node leaves the tree.
    /// </summary>
    /// <example><code>Story.On("flag:knife_found", () =&gt; Hud.Say("Lucky."), this);</code></example>
    public static void On(string name, Action handler, Node? owner = null)
    {
        if (!Handlers.TryGetValue(name, out var list)) Handlers[name] = list = new List<Action>();
        list.Add(handler);
        if (owner != null) owner.TreeExiting += () => Off(name, handler);
    }

    /// <summary>Removes a handler added with <see cref="On"/>.</summary>
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
