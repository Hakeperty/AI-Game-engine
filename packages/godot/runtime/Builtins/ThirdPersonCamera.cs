using System;
using Godot;

namespace Aige;

/// <summary>
/// Over-the-shoulder third-person camera (<c>builtin:ThirdPersonCamera</c>), like Elden Ring or
/// Zelda: mouse / right-stick orbit with pitch limits, smoothing, collision pull-in (SpringArm3D),
/// lazy recentering behind the player while moving, and it yields to cutscene cameras.
/// The rig (SpringArm3D + Camera3D) is built in code on this Node3D.
/// <code>
/// ThirdPersonCamera.Current?.SnapBehind();
/// ThirdPersonCamera.Current!.Shoulder = -0.4f; // swap shoulders
/// </code>
/// </summary>
public partial class ThirdPersonCamera : Node3D
{
    /// <summary>Entity to follow (id, path or name; '' = the node in group 'Player').</summary>
    [Export] public string Target { get; set; } = "";

    /// <summary>Distance behind the target in meters.</summary>
    [Export] public float Distance { get; set; } = 3.1f;

    /// <summary>Pivot height above the target's origin (its feet) in meters.</summary>
    [Export] public float Height { get; set; } = 1.55f;

    /// <summary>Sideways shoulder offset in meters (negative = left shoulder).</summary>
    [Export] public float Shoulder { get; set; } = 0.45f;

    /// <summary>Vertical field of view in degrees.</summary>
    [Export] public float Fov { get; set; } = 60f;

    /// <summary>Mouse sensitivity in degrees per pixel.</summary>
    [Export] public float MouseSensitivity { get; set; } = 0.12f;

    /// <summary>Lowest pitch in degrees (negative looks down on the player).</summary>
    [Export] public float MinPitch { get; set; } = -60f;

    /// <summary>Highest pitch in degrees (positive looks up).</summary>
    [Export] public float MaxPitch { get; set; } = 35f;

    /// <summary>Right-stick look speed in degrees per second.</summary>
    [Export] public float StickSpeed { get; set; } = 150f;

    /// <summary>Invert vertical look.</summary>
    [Export] public bool InvertY { get; set; }

    /// <summary>Seconds without look input before the camera drifts back behind a moving player.</summary>
    [Export] public float RecenterDelay { get; set; } = 1.6f;

    /// <summary>Follow smoothing rate (1/s).</summary>
    [Export] public float FollowSmoothing { get; set; } = 10f;

    /// <summary>The active third-person camera.</summary>
    public static ThirdPersonCamera? Current { get; private set; }

    /// <summary>The Camera3D of the rig.</summary>
    public Camera3D Camera { get; private set; } = null!;

    Node3D _pitchPivot = null!;
    SpringArm3D _arm = null!;
    Node3D? _target;
    float _yaw, _pitch = -12f, _yawGoal, _pitchGoal = -12f, _idle, _armLength, _fovNow;
    Vector3 _pivot;
    bool _placed;

    public override void _EnterTree() => Current = this;

    public override void _ExitTree()
    {
        if (Current == this) Current = null;
        Cutscenes.Finished -= OnCutsceneFinished;
    }

    public override void _Ready()
    {
        TopLevel = true;
        _pitchPivot = new Node3D { Name = "Pitch" };
        AddChild(_pitchPivot);
        _arm = new SpringArm3D
        {
            Name = "Arm",
            SpringLength = Distance,
            Margin = 0.08f,
            CollisionMask = 1,
            Shape = new SphereShape3D { Radius = 0.18f },
        };
        _pitchPivot.AddChild(_arm);

        var existing = GetNodeOrNull<Camera3D>("Camera");
        if (existing != null)
        {
            RemoveChild(existing);
            Camera = existing;
        }
        else Camera = new Camera3D { Name = "Camera", Near = 0.05f, Far = 600f };
        _pitchPivot.AddChild(Camera);
        Camera.Fov = _fovNow = Fov;
        Camera.MakeCurrent();

        _armLength = Distance;
        Cutscenes.Finished += OnCutsceneFinished;
        if (!AigeTest.Active && DisplayServer.GetName() != "headless") Input.MouseMode = Input.MouseModeEnum.Captured;
        ResolveTarget();
        SnapBehind();
    }

    void ResolveTarget()
    {
        _target = string.IsNullOrEmpty(Target) ? Entities.Player : Entities.Find(Target) ?? Entities.Player;
        if (_target is CollisionObject3D body) _arm.AddExcludedObject(body.GetRid());
    }

    /// <summary>Places the camera behind the target immediately.</summary>
    public void SnapBehind()
    {
        if (_target == null || !IsInstanceValid(_target)) ResolveTarget();
        if (_target == null) return;
        _yaw = _yawGoal = _target.GlobalRotation.Y + MathF.PI;
        _pitch = _pitchGoal = Mathf.Clamp(-12f, MinPitch, MaxPitch);
        _pivot = _target.GlobalPosition + Vector3.Up * Height;
        _placed = true;
        ApplyRig(0f);
    }

    /// <summary>Adds look input in degrees (positive x turns right, positive y looks down).</summary>
    public void AddLook(float yawDegrees, float pitchDegrees)
    {
        _yawGoal -= Mathf.DegToRad(yawDegrees);
        _pitchGoal = Mathf.Clamp(_pitchGoal - pitchDegrees * (InvertY ? -1f : 1f), MinPitch, MaxPitch);
        _idle = 0f;
    }

    void OnCutsceneFinished(string name, bool skipped)
    {
        if (Cutscenes.InputBlocked || _target == null || !IsInstanceValid(_target)) return;
        if (_pivot.DistanceTo(_target.GlobalPosition + Vector3.Up * Height) > 1.5f) SnapBehind();
    }

    public override void _UnhandledInput(InputEvent e)
    {
        if (Cutscenes.InputBlocked) return;
        switch (e)
        {
            case InputEventMouseMotion motion when Input.MouseMode == Input.MouseModeEnum.Captured || AigeTest.Active:
                AddLook(motion.Relative.X * MouseSensitivity, motion.Relative.Y * MouseSensitivity);
                break;
            case InputEventMouseButton { Pressed: true } when !AigeTest.Active && Input.MouseMode != Input.MouseModeEnum.Captured:
                Input.MouseMode = Input.MouseModeEnum.Captured;
                break;
        }
        if (e.IsActionPressed("pause") && Input.MouseMode == Input.MouseModeEnum.Captured) Input.MouseMode = Input.MouseModeEnum.Visible;
    }

    public override void _Process(double delta)
    {
        if (_target == null || !IsInstanceValid(_target))
        {
            ResolveTarget();
            if (_target == null) return;
        }
        if (!_placed) SnapBehind();
        if (Cutscenes.IsPlaying) return;
        var dt = (float)delta;

        if (!Cutscenes.InputBlocked && InputMap.HasAction("look_left"))
        {
            var stick = Input.GetVector("look_left", "look_right", "look_up", "look_down");
            if (stick.LengthSquared() > 0.001f) AddLook(stick.X * StickSpeed * dt, stick.Y * StickSpeed * dt * 0.7f);
        }

        // Lazy recenter behind a moving player.
        _idle += dt;
        var velocity = _target is CharacterBody3D body ? body.Velocity : Vector3.Zero;
        velocity.Y = 0f;
        var speed = velocity.Length();
        if (_idle > RecenterDelay && speed > 0.6f)
        {
            var behind = MathF.Atan2(velocity.X, velocity.Z) + MathF.PI;
            var diff = Mathf.AngleDifference(_yawGoal, behind);
            if (MathF.Abs(diff) < Mathf.DegToRad(135f))
                _yawGoal += diff * Easing.Damp(0.35f + speed * 0.12f, dt);
            _pitchGoal = Mathf.Lerp(_pitchGoal, Mathf.Clamp(-10f, MinPitch, MaxPitch), Easing.Damp(0.4f, dt));
        }

        ApplyRig(dt);
    }

    void ApplyRig(float dt)
    {
        if (_target == null) return;
        var goal = _target.GlobalPosition + Vector3.Up * Height;
        if (dt <= 0f || _pivot.DistanceTo(goal) > 4f) _pivot = goal;
        else
        {
            var k = Easing.Damp(FollowSmoothing, dt);
            var kY = Easing.Damp(FollowSmoothing * 0.6f, dt);
            _pivot = new Vector3(Mathf.Lerp(_pivot.X, goal.X, k), Mathf.Lerp(_pivot.Y, goal.Y, kY), Mathf.Lerp(_pivot.Z, goal.Z, k));
        }
        var r = dt <= 0f ? 1f : Easing.Damp(22f, dt);
        _yaw = Mathf.LerpAngle(_yaw, _yawGoal, r);
        _pitch = Mathf.Lerp(_pitch, _pitchGoal, r);

        GlobalPosition = _pivot;
        GlobalRotation = new Vector3(0f, _yaw, 0f);
        _pitchPivot.Rotation = new Vector3(Mathf.DegToRad(_pitch), 0f, 0f);

        // Shoulder offset shrinks when the arm is pulled in (tight spaces).
        _arm.SpringLength = Distance;
        var hit = _arm.GetHitLength();
        _armLength = hit < _armLength || dt <= 0f ? hit : Mathf.Lerp(_armLength, hit, Easing.Damp(4f, dt));
        var shoulder = Shoulder * Mathf.Clamp(_armLength / Mathf.Max(0.1f, Distance), 0.35f, 1f);
        _arm.Position = new Vector3(shoulder, 0f, 0f);
        Camera.Position = _arm.Position + new Vector3(0f, 0f, Mathf.Max(0.15f, _armLength));

        var sprint = PlayerController.Instance is { IsRunning: true } ? 4f : 0f;
        _fovNow = dt <= 0f ? Fov + sprint : Mathf.Lerp(_fovNow, Fov + sprint, Easing.Damp(3f, dt));
        Camera.Fov = _fovNow;
    }
}
