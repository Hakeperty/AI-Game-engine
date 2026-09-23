using System;
using Godot;

namespace Aige;

/// <summary>
/// A story trigger zone (AIGE <c>Trigger</c>). Listens to the entity's <c>Area</c> (its trigger
/// colliders). When a body in group <see cref="Tag"/> enters, it waits <see cref="Delay"/> seconds,
/// then plays the cutscene / voice / sound / text, sets the objective and the flag.
/// <code>
/// GetNode&lt;Trigger&gt;("TableZone/Trigger").Fired += body =&gt; Hud.Heartbeat(0.3f, 90);
/// </code>
/// </summary>
public partial class Trigger : Node3D
{
    /// <summary>Fire only once.</summary>
    [Export] public bool Once { get; set; } = true;

    /// <summary>Group of the bodies that fire it ('' = any body).</summary>
    [Export] public string Tag { get; set; } = "Player";

    /// <summary>Only fires once this flag is set.</summary>
    [Export] public string RequireFlag { get; set; } = "";

    /// <summary>Flag set when it fires.</summary>
    [Export] public string SetFlag { get; set; } = "";

    /// <summary>Cutscene to play (res:// path).</summary>
    [Export] public string Cutscene { get; set; } = "";

    /// <summary>Voice line id to play.</summary>
    [Export] public string Voice { get; set; } = "";

    /// <summary>Sound to play (res:// path or Sfx preset).</summary>
    [Export] public string Sound { get; set; } = "";

    /// <summary>Thought text shown as a subtitle.</summary>
    [Export] public string Text { get; set; } = "";

    /// <summary>New objective text.</summary>
    [Export] public string Objective { get; set; } = "";

    /// <summary>Seconds to wait after entering.</summary>
    [Export] public float Delay { get; set; }

    /// <summary>False ignores bodies entering.</summary>
    [Export] public bool Enabled { get; set; } = true;

    /// <summary>Raised on this trigger when a matching body enters (before the delay).</summary>
    public event Action<Node3D>? Fired;

    /// <summary>Raised for every trigger that fires: (trigger, body).</summary>
    public static event Action<Trigger, Node3D>? AnyFired;

    bool _done;
    Area3D? _area;

    /// <summary>The entity this component belongs to.</summary>
    public Node3D Entity => GetParentOrNull<Node3D>() ?? this;

    public override void _Ready()
    {
        var parent = GetParent();
        _area = parent as Area3D ?? parent?.GetNodeOrNull<Area3D>("Area") ?? Entities.Descendant<Area3D>(parent, 2);
        if (_area == null)
        {
            Log.Warn($"Trigger on '{Entities.NameOf(parent)}' has no trigger collider (Area).");
            return;
        }
        _area.BodyEntered += OnBodyEntered;
    }

    void OnBodyEntered(Node3D body)
    {
        if (!Enabled || (_done && Once)) return;
        if (!string.IsNullOrEmpty(Tag) && !body.IsInGroup(Tag)) return;
        if (!string.IsNullOrEmpty(RequireFlag) && !Story.HasFlag(RequireFlag)) return;
        _done = true;
        AnyFired?.Invoke(this, body);
        Fired?.Invoke(body);
        Run();
    }

    async void Run()
    {
        if (Delay > 0f)
        {
            await ToSignal(GetTree().CreateTimer(Delay), SceneTreeTimer.SignalName.Timeout);
            if (!IsInsideTree()) return;
        }
        if (!string.IsNullOrEmpty(Cutscene)) Cutscenes.Play(Cutscene);
        if (!string.IsNullOrEmpty(Voice)) global::Aige.Voice.Play(Voice);
        else if (!string.IsNullOrEmpty(Text)) Hud.Say(Text);
        if (!string.IsNullOrEmpty(Sound)) Sfx.Play(Sound, Entity.GlobalPosition);
        if (!string.IsNullOrEmpty(Objective)) Story.SetObjective(Objective);
        if (!string.IsNullOrEmpty(SetFlag)) Story.SetFlag(SetFlag);
    }

    /// <summary>Re-arms a trigger that already fired.</summary>
    public void Reset() => _done = false;
}
