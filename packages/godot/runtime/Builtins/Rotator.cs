using Godot;

namespace Aige;

/// <summary>
/// Spins its entity (<c>builtin:Rotator</c>). <see cref="Speed"/> is degrees per second per axis
/// (a Vector3) or a single number for the Y axis.
/// </summary>
public partial class Rotator : Node3D
{
    /// <summary>Degrees per second: Vector3 per axis, or a number (Y axis).</summary>
    [Export] public Variant Speed { get; set; } = new Vector3(0f, 90f, 0f);

    /// <summary>'self' (local axes) or 'world'.</summary>
    [Export] public string Space { get; set; } = "self";

    public override void _Process(double delta)
    {
        var speed = Speed.VariantType switch
        {
            Variant.Type.Vector3 => Speed.AsVector3(),
            Variant.Type.Float or Variant.Type.Int => new Vector3(0f, Speed.AsSingle(), 0f),
            _ => Vector3.Zero,
        };
        var r = speed * (float)delta;
        if (r == Vector3.Zero) return;
        if (Space == "world")
        {
            if (r.X != 0f) GlobalRotate(Vector3.Right, Mathf.DegToRad(r.X));
            if (r.Y != 0f) GlobalRotate(Vector3.Up, Mathf.DegToRad(r.Y));
            if (r.Z != 0f) GlobalRotate(Vector3.Back, Mathf.DegToRad(r.Z));
        }
        else
        {
            if (r.X != 0f) RotateObjectLocal(Vector3.Right, Mathf.DegToRad(r.X));
            if (r.Y != 0f) RotateObjectLocal(Vector3.Up, Mathf.DegToRad(r.Y));
            if (r.Z != 0f) RotateObjectLocal(Vector3.Back, Mathf.DegToRad(r.Z));
        }
    }
}
