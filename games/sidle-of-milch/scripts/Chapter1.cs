using Aige;
using Godot;

/// <summary>
/// Chapter 1 story flow (see STORY.md): Milch wakes in the cabin, searches the ground floor, the stairs
/// unlock, he faints in Murphy's empty room, wakes in the morning and leaves the cabin. Cutscenes, triggers
/// and interactables do the moment-to-moment work; this script ties the beats together.
/// </summary>
public partial class Chapter1 : Node3D
{
    /// <summary>Seconds of free play before the pointer to the next goal appears.</summary>
    [Export] public float PointerDelay = 30f;

    public override void _Ready()
    {
        Story.On("flag:woke_up", () => Story.SetObjective("Look around", "Photo_1", pointerDelay: PointerDelay), this);
        Story.On("flag:entered_hall", () => Story.SetObjective("Search the kitchen", "Table", pointerDelay: PointerDelay), this);
        Story.On("flag:heard_thunder", () => Story.SetObjective("Look around the house"), this);
        Story.On("flag:found_bathroom", CheckGroundFloor, this);
        Story.On("flag:found_storage", CheckGroundFloor, this);
        Story.On("flag:has_knife", CheckGroundFloor, this);
        Story.On("fainted", () => Cutscenes.Play("res://cutscenes/cs5_morning.cutscene.json"), this);
        Story.On("flag:leave_cabin", () => Story.SetObjective("Leave the cabin", "Door_Front", pointerDelay: PointerDelay), this);
        Story.On("chapter_end", () => Log.Info("Chapter 1 complete"), this);
        CallDeferred(MethodName.Begin);
    }

    private void Begin()
    {
        if (!Story.HasFlag("woke_up")) Cutscenes.Play("res://cutscenes/cs1_wake.cutscene.json");
    }

    /// <summary>The stairs unlock once the kitchen, bathroom and storage room have all been explored.</summary>
    private void CheckGroundFloor()
    {
        if (Story.HasFlag("stairs_unlocked") || !Story.HasFlags("has_knife", "found_bathroom", "found_storage")) return;
        Story.SetFlag("stairs_unlocked");
        Voice.Play("milch_stairs_open");
        Story.SetObjective("Find Murphy's room", "Door_Stairs", pointerDelay: PointerDelay);
    }
}
