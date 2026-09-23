using System;
using Godot;

namespace Aige;

/// <summary>
/// Something the player can examine, pick up or use (AIGE <c>Interactable</c>). A child node of the
/// entity. When the player is close and facing it, the HUD shows "E  <see cref="Prompt"/>"; on
/// interact it plays the cutscene, else the voice line, else the text, gives the item (hiding the
/// entity) and sets the flag.
/// <code>
/// var photo = GetNode&lt;Interactable&gt;("Photo1/Interactable");
/// photo.Interacted += by =&gt; Story.SetObjective("Look around");
/// </code>
/// </summary>
public partial class Interactable : Node3D, IInteractable
{
    /// <summary>Prompt text ('Examine', 'Pick up', 'Open drawer'...).</summary>
    [Export] public string Prompt { get; set; } = "Examine";

    /// <summary>Maximum distance in meters.</summary>
    [Export] public float Range { get; set; } = 1.8f;

    /// <summary>Only usable once.</summary>
    [Export] public bool Once { get; set; }

    /// <summary>Hidden until this story flag is set ('' = always).</summary>
    [Export] public string RequireFlag { get; set; } = "";

    /// <summary>Story flag set on interact.</summary>
    [Export] public string SetFlag { get; set; } = "";

    /// <summary>Cutscene played on interact (res:// path).</summary>
    [Export] public string Cutscene { get; set; } = "";

    /// <summary>Voice line id played on interact (when there is no cutscene).</summary>
    [Export] public string Voice { get; set; } = "";

    /// <summary>Thought text shown as a subtitle (when there is no cutscene or voice line).</summary>
    [Export] public string Text { get; set; } = "";

    /// <summary>Item id given on interact; the entity is then hidden.</summary>
    [Export] public string Item { get; set; } = "";

    /// <summary>False disables it (no prompt).</summary>
    [Export] public bool Enabled { get; set; } = true;

    /// <summary>Raised on this interactable after it was used (the argument is the player or null).</summary>
    public event Action<Node3D?>? Interacted;

    /// <summary>Raised for every interactable that is used: (interactable, by).</summary>
    public static event Action<Interactable, Node3D?>? AnyInteracted;

    Vector3? _local;

    /// <summary>The entity this component belongs to.</summary>
    public Node3D Entity => GetParentOrNull<Node3D>() ?? this;

    public string PromptText => Prompt;
    public float InteractRange => Range;

    public bool CanInteract =>
        Enabled && IsInsideTree() && Entity.IsVisibleInTree() && !Cutscenes.InputBlocked &&
        (string.IsNullOrEmpty(RequireFlag) || Story.HasFlag(RequireFlag));

    /// <summary>Center of the entity's meshes (what the player must face).</summary>
    public Vector3 InteractPoint
    {
        get
        {
            var e = Entity;
            _local ??= e.GlobalTransform.AffineInverse() * Entities.FocusPoint(e);
            return e.GlobalTransform * _local.Value;
        }
    }

    public override void _EnterTree() => Interaction.Register(this);

    public override void _ExitTree() => Interaction.Unregister(this);

    /// <summary>Uses the interactable (also callable from scripts).</summary>
    public void Interact(Node3D? by = null)
    {
        if (!Enabled) return;
        AnyInteracted?.Invoke(this, by);
        Interacted?.Invoke(by);
        if (!string.IsNullOrEmpty(Cutscene)) Cutscenes.Play(Cutscene);
        else if (!string.IsNullOrEmpty(Voice)) global::Aige.Voice.Play(Voice);
        else if (!string.IsNullOrEmpty(Text)) Hud.Say(Text);
        if (!string.IsNullOrEmpty(Item))
        {
            Story.Give(Item);
            Sfx.TryPlay("pickup", Entity.GlobalPosition, 0.6f, notify: false);
            Entities.SetEnabled(Entity, false);
        }
        if (!string.IsNullOrEmpty(SetFlag)) Story.SetFlag(SetFlag);
        if (Once) Enabled = false;
    }
}
