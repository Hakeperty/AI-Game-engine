using System;
using Godot;

namespace Aige;

/// <summary>
/// A hinged door (AIGE <c>Door</c>). A child of the door entity (an AnimatableBody3D whose origin is
/// the hinge); it swings the entity around its local Y axis. Locked doors say <see cref="LockedText"/>
/// until <see cref="UnlockFlag"/> is set.
/// <code>
/// Story.SetFlag("upstairs_unlocked");            // unlocks doors with that UnlockFlag
/// GetNode&lt;Door&gt;("StairsDoor/Door").Open();
/// </code>
/// </summary>
public partial class Door : Node3D, IInteractable
{
    /// <summary>Open angle in degrees (negative swings the other way).</summary>
    [Export] public float OpenAngle { get; set; } = 100f;

    /// <summary>Swings per second.</summary>
    [Export] public float Speed { get; set; } = 1.6f;

    /// <summary>Locked (until <see cref="UnlockFlag"/> is set, or <see cref="Unlock"/> is called).</summary>
    [Export] public bool Locked { get; set; }

    /// <summary>Story flag that unlocks the door.</summary>
    [Export] public string UnlockFlag { get; set; } = "";

    /// <summary>Thought shown when trying a locked door.</summary>
    [Export] public string LockedText { get; set; } = "It won't open.";

    /// <summary>Start open.</summary>
    [Export] public bool StartOpen { get; set; }

    /// <summary>Prompt text.</summary>
    [Export] public string Prompt { get; set; } = "Open";

    /// <summary>Interaction range in meters.</summary>
    [Export] public float Range { get; set; } = 1.8f;

    /// <summary>Raised when the door opens (true) or closes (false): (door, open).</summary>
    public static event Action<Door, bool>? AnyToggled;

    /// <summary>Raised when the player tries a locked door.</summary>
    public static event Action<Door>? AnyLocked;

    Node3D _body = null!;
    Basis _closed;
    float _amount;
    bool _unlocked;
    Vector3? _local;

    /// <summary>True when open (or opening).</summary>
    public bool IsOpen { get; private set; }

    /// <summary>True while the door is locked.</summary>
    public bool IsLocked =>
        !_unlocked && (Locked || !string.IsNullOrEmpty(UnlockFlag)) &&
        !(!string.IsNullOrEmpty(UnlockFlag) && Story.HasFlag(UnlockFlag));

    public Node3D Entity => _body ?? GetParentOrNull<Node3D>() ?? this;
    public string PromptText => IsOpen ? "Close" : Prompt;
    public float InteractRange => Range;
    public bool CanInteract => IsInsideTree() && Entity.IsVisibleInTree() && !Cutscenes.InputBlocked;

    public Vector3 InteractPoint
    {
        get
        {
            // Center of the closed door leaf, so it stays reachable while it swings.
            var e = Entity;
            if (_local == null)
            {
                var p = Entities.FocusPoint(e);
                _local = e.GlobalTransform.AffineInverse() * p;
            }
            var parent = e.GetParentOrNull<Node3D>();
            var closed = new Transform3D(_closed, e.Position);
            var world = parent != null ? parent.GlobalTransform * closed : closed;
            return world * _local.Value;
        }
    }

    public override void _EnterTree() => Interaction.Register(this);

    public override void _ExitTree() => Interaction.Unregister(this);

    public override void _Ready()
    {
        _body = GetParentOrNull<Node3D>() ?? this;
        _closed = _body.Basis;
        if (StartOpen)
        {
            IsOpen = true;
            _amount = 1f;
            Apply();
        }
    }

    public void Interact(Node3D? by = null)
    {
        if (IsLocked)
        {
            AnyLocked?.Invoke(this);
            Hud.Say(LockedText, 2.8f);
            Sfx.PlayFirst(new[] { "door_locked", "door_rattle", "locked" }, Entity.GlobalPosition, 0.8f);
            return;
        }
        if (IsOpen) Close();
        else Open();
    }

    /// <summary>Opens the door (ignores the lock).</summary>
    public void Open()
    {
        if (IsOpen) return;
        IsOpen = true;
        Sfx.PlayFirst(new[] { "door_open", "creak" }, Entity.GlobalPosition, 0.85f, (float)GD.RandRange(0.95, 1.05));
        AnyToggled?.Invoke(this, true);
    }

    /// <summary>Closes the door.</summary>
    public void Close()
    {
        if (!IsOpen) return;
        IsOpen = false;
        Sfx.PlayFirst(new[] { "door_close", "door_open", "creak" }, Entity.GlobalPosition, 0.75f, (float)GD.RandRange(0.95, 1.05));
        AnyToggled?.Invoke(this, false);
    }

    /// <summary>Unlocks the door permanently.</summary>
    public void Unlock()
    {
        _unlocked = true;
        Locked = false;
    }

    public override void _PhysicsProcess(double delta)
    {
        var target = IsOpen ? 1f : 0f;
        if (Mathf.IsEqualApprox(_amount, target)) return;
        _amount = Mathf.MoveToward(_amount, target, (float)delta * Speed);
        Apply();
    }

    void Apply()
    {
        var angle = Mathf.DegToRad(OpenAngle) * Easing.Smooth(_amount);
        _body.Basis = _closed * new Basis(Vector3.Up, angle);
    }
}
