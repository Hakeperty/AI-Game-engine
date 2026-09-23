using System;
using Godot;

namespace Aige;

/// <summary>
/// Realistic third-person player movement (<c>builtin:PlayerController</c>), on the player's
/// CharacterBody3D. Moves relative to the camera (walk, sprint to run, crouch), accelerates
/// smoothly, turns toward where it moves, steps up small ledges, plays footsteps, and handles
/// interaction: the nearest usable <see cref="IInteractable"/> in front shows its prompt and
/// <c>interact</c> uses it. Input is ignored while a cutscene has control.
/// <code>
/// PlayerController.Instance.InputEnabled = false; // freeze the player from a script
/// PlayerController.Instance.Teleport(new Vector3(2, 0, -3), yawDegrees: 180);
/// </code>
/// </summary>
public partial class PlayerController : CharacterBody3D
{
    /// <summary>Walking speed in m/s.</summary>
    [Export] public float WalkSpeed { get; set; } = 1.5f;

    /// <summary>Running speed (hold sprint) in m/s.</summary>
    [Export] public float RunSpeed { get; set; } = 4.5f;

    /// <summary>Crouched speed in m/s.</summary>
    [Export] public float CrouchSpeed { get; set; } = 0.9f;

    /// <summary>How fast the character reaches its target speed (1/s).</summary>
    [Export] public float Acceleration { get; set; } = 7f;

    /// <summary>How fast the character stops (1/s).</summary>
    [Export] public float Deceleration { get; set; } = 10f;

    /// <summary>How fast the character turns toward its move direction (1/s).</summary>
    [Export] public float TurnSpeed { get; set; } = 9f;

    /// <summary>Allow jumping.</summary>
    [Export] public bool CanJump { get; set; } = true;

    /// <summary>Jump take-off speed in m/s.</summary>
    [Export] public float JumpSpeed { get; set; } = 4.2f;

    /// <summary>Gravity multiplier (project gravity × this).</summary>
    [Export] public float GravityScale { get; set; } = 1f;

    /// <summary>Highest ledge (m) the character steps onto.</summary>
    [Export] public float StepHeight { get; set; } = 0.35f;

    /// <summary>Crouched capsule height as a fraction of the standing height.</summary>
    [Export] public float CrouchHeight { get; set; } = 0.62f;

    /// <summary>Footstep sound (Sfx preset or path; '' = silent).</summary>
    [Export] public string FootstepSound { get; set; } = "footstep_wood";

    /// <summary>Footstep volume 0..1 while walking (running is louder, crouching quieter).</summary>
    [Export] public float FootstepVolume { get; set; } = 0.5f;

    /// <summary>Respawn at the start position when falling below this height.</summary>
    [Export] public float KillY { get; set; } = -50f;

    /// <summary>The active player controller.</summary>
    public static PlayerController? Instance { get; private set; }

    /// <summary>False freezes player input (scripts). Cutscenes block input on their own.</summary>
    public bool InputEnabled { get; set; } = true;

    /// <summary>True while crouched.</summary>
    public bool IsCrouching { get; private set; }

    /// <summary>True while running (sprint held and moving fast).</summary>
    public bool IsRunning { get; private set; }

    /// <summary>The interactable the prompt is showing (null when none).</summary>
    public IInteractable? Target { get; private set; }

    /// <summary>Unit direction the character faces (world, horizontal).</summary>
    public Vector3 Facing => new Vector3(MathF.Sin(Rotation.Y), 0f, MathF.Cos(Rotation.Y));

    CollisionShape3D? _shape;
    CapsuleShape3D? _capsule;
    float _standHeight = 1.8f, _shapeBaseY = 0.9f, _heightNow = 1.8f;
    float _stride, _airTime, _faceTimer;
    Vector3 _spawn, _faceDir;
    string _prompt = "";
    Animator? _animator;

    public override void _EnterTree()
    {
        Instance = this;
        if (!IsInGroup("Player")) AddToGroup("Player");
    }

    public override void _ExitTree()
    {
        if (Instance == this) Instance = null;
    }

    public override void _Ready()
    {
        _spawn = GlobalPosition;
        _shape = GetNodeOrNull<CollisionShape3D>("Shape") ?? Entities.Component<CollisionShape3D>(this);
        _capsule = _shape?.Shape as CapsuleShape3D;
        if (_capsule != null && _shape != null)
        {
            _capsule = (CapsuleShape3D)_capsule.Duplicate();
            _shape.Shape = _capsule;
            _standHeight = _heightNow = _capsule.Height;
            _shapeBaseY = _shape.Position.Y;
        }
        FloorSnapLength = Mathf.Max(FloorSnapLength, 0.3f);
        FloorConstantSpeed = true;
        FloorStopOnSlope = true;
        _animator = Animator.Of(this);
    }

    /// <summary>Teleports the player (optionally turning to <paramref name="yawDegrees"/>).</summary>
    public void Teleport(Vector3 position, float? yawDegrees = null)
    {
        GlobalPosition = position;
        if (yawDegrees is { } y) Rotation = new Vector3(0f, Mathf.DegToRad(y), 0f);
        OnTeleported();
    }

    /// <summary>Called after the player was moved by a script, cutscene or test.</summary>
    public void OnTeleported()
    {
        Velocity = Vector3.Zero;
        _stride = 0f;
        ThirdPersonCamera.Current?.SnapBehind();
    }

    bool Blocked => !InputEnabled || Cutscenes.InputBlocked;

    public override void _PhysicsProcess(double delta)
    {
        var dt = (float)delta;
        if (Cutscenes.IsPlaying)
        {
            // Cutscenes move the player themselves; stay out of the way.
            Velocity = Vector3.Zero;
            SetTarget(null);
            return;
        }

        var blocked = Blocked;
        var input = blocked ? Vector2.Zero : Input.GetVector("move_left", "move_right", "move_forward", "move_back");
        var wantsRun = !blocked && Input.IsActionPressed("sprint");
        if (!blocked && Input.IsActionJustPressed("crouch")) SetCrouch(!IsCrouching);
        if (IsCrouching && wantsRun) SetCrouch(false);
        UpdateCrouchShape(dt);

        // Camera-relative direction
        var cam = GetViewport().GetCamera3D();
        var basis = cam?.GlobalBasis ?? GlobalBasis;
        var forward = -basis.Z;
        forward.Y = 0f;
        forward = forward.LengthSquared() > 1e-4f ? forward.Normalized() : Vector3.Forward;
        var right = new Vector3(-forward.Z, 0f, forward.X);
        var dir = right * input.X - forward * input.Y;
        var amount = Mathf.Min(1f, dir.Length());
        if (amount > 1e-3f) dir /= dir.Length();

        var top = IsCrouching ? CrouchSpeed : wantsRun ? RunSpeed : WalkSpeed;
        var desired = dir * top * amount;
        var horizontal = new Vector3(Velocity.X, 0f, Velocity.Z);
        var rate = desired.LengthSquared() >= horizontal.LengthSquared() ? Acceleration : Deceleration;
        if (!IsOnFloor()) rate *= 0.25f;
        horizontal = horizontal.Lerp(desired, Easing.Damp(rate, dt));
        IsRunning = wantsRun && horizontal.Length() > (WalkSpeed + RunSpeed) * 0.5f;

        // Turn toward movement (or toward what we just used).
        if (_faceTimer > 0f)
        {
            _faceTimer -= dt;
            if (_faceDir.LengthSquared() > 1e-4f) TurnTo(_faceDir, dt, TurnSpeed * 0.8f);
        }
        else if (amount > 0.1f)
        {
            var turnRate = TurnSpeed * Mathf.Lerp(1f, 0.55f, Mathf.Clamp((horizontal.Length() - WalkSpeed) / (RunSpeed - WalkSpeed), 0f, 1f));
            TurnTo(dir, dt, turnRate);
        }

        // Gravity and jumping
        var vy = Velocity.Y;
        if (IsOnFloor())
        {
            if (_airTime > 0.35f) Footstep(1.2f);
            _airTime = 0f;
            vy = Mathf.Min(vy, 0f);
            if (CanJump && !blocked && !IsCrouching && Input.IsActionJustPressed("jump")) vy = JumpSpeed;
        }
        else
        {
            _airTime += dt;
            vy += GetGravity().Y * GravityScale * dt;
        }

        var before = GlobalPosition;
        Velocity = new Vector3(horizontal.X, vy, horizontal.Z);
        MoveAndSlide();
        if (IsOnFloor() && horizontal.LengthSquared() > 0.01f && IsOnWall()) TryStepUp(horizontal, dt, before);

        // Footsteps by distance travelled
        if (IsOnFloor())
        {
            var moved = GlobalPosition - before;
            moved.Y = 0f;
            var speed = horizontal.Length();
            _stride += moved.Length();
            var strideLength = Mathf.Lerp(0.72f, 1.35f, Mathf.Clamp((speed - WalkSpeed) / (RunSpeed - WalkSpeed), 0f, 1f));
            if (IsCrouching) strideLength = 0.55f;
            if (speed > 0.25f && _stride >= strideLength)
            {
                _stride = 0f;
                Footstep(IsCrouching ? 0.45f : IsRunning ? 1.5f : 1f);
            }
        }

        if (GlobalPosition.Y < KillY) Teleport(_spawn);
        if (_animator != null && IsInstanceValid(_animator)) _animator.Crouching = IsCrouching;

        UpdateInteraction(blocked);
    }

    void TurnTo(Vector3 dir, float dt, float rate)
    {
        var yaw = MathF.Atan2(dir.X, dir.Z);
        Rotation = new Vector3(0f, Mathf.LerpAngle(Rotation.Y, yaw, Easing.Damp(rate, dt)), 0f);
    }

    void TryStepUp(Vector3 horizontal, float dt, Vector3 before)
    {
        var step = Vector3.Up * StepHeight;
        var from = GlobalTransform;
        if (TestMove(from, step)) return;
        var raised = from.Translated(step);
        var ahead = horizontal.Normalized() * Mathf.Max(0.08f, horizontal.Length() * dt);
        if (TestMove(raised, ahead)) return;
        var moved = raised.Translated(ahead);
        var hit = new KinematicCollision3D();
        if (!TestMove(moved, -step * 1.1f, hit)) return;
        if (hit.GetNormal().AngleTo(Vector3.Up) > FloorMaxAngle) return;
        GlobalPosition = moved.Origin + hit.GetTravel();
    }

    void SetCrouch(bool crouch)
    {
        if (!crouch && IsCrouching && _capsule != null)
        {
            // Only stand up when there is head room.
            if (TestMove(GlobalTransform, Vector3.Up * (_standHeight - _heightNow + 0.05f))) return;
        }
        IsCrouching = crouch;
    }

    void UpdateCrouchShape(float dt)
    {
        if (_capsule == null || _shape == null) return;
        var target = IsCrouching ? _standHeight * CrouchHeight : _standHeight;
        if (Mathf.IsEqualApprox(_heightNow, target)) return;
        _heightNow = Mathf.MoveToward(_heightNow, target, dt * 3f);
        _capsule.Height = Mathf.Max(_heightNow, _capsule.Radius * 2f);
        _shape.Position = new Vector3(_shape.Position.X, _shapeBaseY * (_heightNow / _standHeight), _shape.Position.Z);
    }

    void Footstep(float loudness)
    {
        if (string.IsNullOrEmpty(FootstepSound)) return;
        var pitch = (float)GD.RandRange(0.9, 1.1) * (IsRunning ? 1.04f : 1f);
        Sfx.TryPlay(FootstepSound, GlobalPosition + Vector3.Up * 0.05f, Mathf.Clamp(FootstepVolume * loudness, 0f, 1f), pitch, notify: false);
    }

    // ------------------------------------------------------------------ interaction

    void UpdateInteraction(bool blocked)
    {
        var target = blocked ? null : FindTarget();
        SetTarget(target);
        if (target != null && Input.IsActionJustPressed("interact"))
        {
            var to = target.InteractPoint - GlobalPosition;
            to.Y = 0f;
            _faceDir = to.LengthSquared() > 1e-4f ? to.Normalized() : Vector3.Zero;
            _faceTimer = 0.45f;
            target.Interact(this);
            _prompt = "";
        }
    }

    void SetTarget(IInteractable? target)
    {
        var text = target?.PromptText ?? "";
        if (target == Target && text == _prompt) return;
        Target = target;
        _prompt = text;
        if (target == null) Hud.HidePrompt();
        else Hud.ShowPrompt(text);
    }

    /// <summary>The best interactable: close, in front of the player or camera, and in line of sight.</summary>
    public IInteractable? FindTarget()
    {
        var eye = GlobalPosition + Vector3.Up * Mathf.Min(1.5f, _heightNow * 0.8f);
        var chest = GlobalPosition + Vector3.Up * (_heightNow * 0.55f);
        var cam = GetViewport().GetCamera3D();
        var camForward = cam != null ? -cam.GlobalBasis.Z : Facing;
        IInteractable? best = null;
        var bestScore = float.MaxValue;
        foreach (var it in Interaction.All)
        {
            if (!it.CanInteract) continue;
            var p = it.InteractPoint;
            var flat = p - GlobalPosition;
            flat.Y = 0f;
            var height = p.Y - GlobalPosition.Y;
            if (height < -0.6f || height > _heightNow + 0.7f) continue;
            var distance = Mathf.Max(flat.Length(), (p - chest).Length() * 0.85f);
            if (distance > it.InteractRange) continue;
            var dirFlat = flat.LengthSquared() > 1e-4f ? flat.Normalized() : Facing;
            var facing = dirFlat.Dot(Facing);
            var viewDir = (p - (cam?.GlobalPosition ?? eye)).Normalized();
            var looking = viewDir.Dot(camForward);
            var front = Mathf.Max(facing, looking * 1.1f - 0.1f);
            if (front < 0.25f && distance > 0.7f) continue;
            var score = distance * (1.6f - front);
            if (score >= bestScore || !LineOfSight(eye, p, it.Entity)) continue;
            best = it;
            bestScore = score;
        }
        return best;
    }

    bool LineOfSight(Vector3 from, Vector3 to, Node3D entity)
    {
        var space = GetWorld3D().DirectSpaceState;
        var query = PhysicsRayQueryParameters3D.Create(from, to, CollisionMask, new Godot.Collections.Array<Rid> { GetRid() });
        var hit = space.IntersectRay(query);
        if (hit.Count == 0) return true;
        var collider = hit["collider"].As<Node>();
        if (Entities.IsInside(collider, entity) || Entities.IsInside(entity, collider)) return true;
        var position = hit["position"].AsVector3();
        return position.DistanceTo(to) < 0.25f;
    }
}
