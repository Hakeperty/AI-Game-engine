using System.Collections.Generic;
using Godot;

namespace Aige;

/// <summary>
/// Something the player can use with the interact button. <see cref="Interactable"/> and
/// <see cref="Door"/> implement it; a game script can too (call <see cref="Interaction.Register"/>
/// in <c>_EnterTree</c> and <see cref="Interaction.Unregister"/> in <c>_ExitTree</c>).
/// </summary>
public interface IInteractable
{
    /// <summary>The entity the player interacts with.</summary>
    Node3D Entity { get; }

    /// <summary>Prompt text shown next to the key, e.g. 'Examine'.</summary>
    string PromptText { get; }

    /// <summary>Maximum distance in meters.</summary>
    float InteractRange { get; }

    /// <summary>False hides the prompt (disabled, locked behind a flag, during cutscenes...).</summary>
    bool CanInteract { get; }

    /// <summary>World point the player must be close to and facing.</summary>
    Vector3 InteractPoint { get; }

    /// <summary>Uses it. <paramref name="by"/> is the player (may be null when called from a script).</summary>
    void Interact(Node3D? by);
}

/// <summary>Registry of everything the player can interact with.</summary>
public static class Interaction
{
    static readonly List<IInteractable> Items = new();

    /// <summary>All registered interactables.</summary>
    public static IReadOnlyList<IInteractable> All => Items;

    public static void Register(IInteractable item)
    {
        if (!Items.Contains(item)) Items.Add(item);
    }

    public static void Unregister(IInteractable item) => Items.Remove(item);
}
