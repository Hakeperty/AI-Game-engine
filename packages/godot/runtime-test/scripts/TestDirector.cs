using Aige;
using Godot;

namespace RuntimeTest;

/// <summary>A tiny game script, written the way AI-authored game scripts use the AIGE API.</summary>
public partial class TestDirector : Node
{
    public override void _Ready()
    {
        Story.SetObjective("Look around");
        Story.On("lightning", () => LightFlicker.Lightning(thunder: null), this);
        Story.On("test_intro_done", () => Story.SetObjective("Find the stairs", "StairsDoor", pointerDelay: 1.5f), this);
        Story.On("flag:saw_photo_1", () => Log.Info("The stairs door is unlocked now"), this);
    }
}
