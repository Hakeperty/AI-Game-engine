using System;
using System.Collections.Generic;
using Godot;

namespace Aige;

/// <summary>
/// Skeletal animation for a character (AIGE <c>Animator</c>). Drives the AnimationPlayer inside the
/// entity's <c>Mesh</c> (a skinned GLB). With <see cref="Locomotion"/> it crossfades idle / walk /
/// run from how fast the entity moves. <see cref="Play"/> overrides it with any clip ('sit_up',
/// 'look_around', 'faint'...); a one-shot clip holds its last pose while a cutscene has control,
/// then locomotion takes over. <see cref="Mouth"/> (0..1) opens the jaw (voice lip-sync).
/// <code>
/// Animator.Of(hero)?.Play("look_around");
/// Animator.Of(hero)?.Play("idle_nervous", fade: 0.4f, loop: true);
/// </code>
/// </summary>
public partial class Animator : Node3D
{
    static readonly Dictionary<string, string> Aliases = new()
    {
        ["lie_sleep"] = "lie_asleep",
        ["sleep"] = "lie_asleep",
        ["sit_up_bed"] = "sit_up_in_bed",
        ["sit_up"] = "sit_up_in_bed",
        ["sit"] = "sit_idle",
        ["search_drawer"] = "search",
        ["faint_collapse"] = "faint",
        ["collapse"] = "faint",
        ["lie_unconscious"] = "lie_floor",
        ["wake_on_floor_rub_back"] = "wake_up_floor",
        ["wake_up"] = "wake_up_floor",
        ["hide_in_belt"] = "hide_item",
        ["hold"] = "hold_item",
        ["hold_knife"] = "hold_item",
        ["panting"] = "breathe_heavy",
        ["nervous"] = "idle_nervous",
    };

    static readonly string[] IdleNames = { "idle", "idle_breathing", "breathing_idle", "stand" };
    static readonly string[] WalkNames = { "walk", "walking", "walk_forward" };
    static readonly string[] RunNames = { "run", "running", "jog", "sprint" };
    static readonly string[] CrouchIdleNames = { "crouch_idle", "crouch" };
    static readonly string[] CrouchWalkNames = { "crouch_walk", "sneak" };
    static readonly string[] BlendShapeNames = { "mouth_open", "jawOpen", "MouthOpen", "mouthOpen", "jaw_open" };

    /// <summary>Extra clip files from AIGE (baked into the GLB by the exporter; kept for reference).</summary>
    [Export] public string[] Clips { get; set; } = Array.Empty<string>();

    /// <summary>Clip played at start ('idle' = locomotion).</summary>
    [Export] public string Initial { get; set; } = "idle";

    /// <summary>Crossfade idle/walk/run from movement speed.</summary>
    [Export] public bool Locomotion { get; set; } = true;

    /// <summary>Playback speed multiplier.</summary>
    [Export] public float Speed { get; set; } = 1f;

    /// <summary>Mouth opening 0..1 (set by Voice for lip-sync).</summary>
    [Export(PropertyHint.Range, "0,1")] public float Mouth { get; set; }

    /// <summary>Jaw rotation in degrees at <see cref="Mouth"/> = 1.</summary>
    [Export] public float JawOpenDegrees { get; set; } = 16f;

    /// <summary>Facial expression at start (see <see cref="FaceRig.Presets"/>: worried, fear, pain, sad...); empty = neutral.</summary>
    [Export] public string Expression { get; set; } = "";

    /// <summary>Blink now and then (characters with facial blend shapes).</summary>
    [Export] public bool Blink { get; set; } = true;

    /// <summary>Speed (m/s) the walk clip was authored for.</summary>
    [Export] public float WalkClipSpeed { get; set; } = 1.4f;

    /// <summary>Speed (m/s) the run clip was authored for.</summary>
    [Export] public float RunClipSpeed { get; set; } = 4.5f;

    /// <summary>Raised when a one-shot clip finishes: (clip).</summary>
    public event Action<string>? ClipFinished;

    AnimationPlayer? _player;
    Skeleton3D? _skeleton;
    int _jaw = -1;
    Quaternion _jawBase = Quaternion.Identity, _jawWritten = Quaternion.Identity;
    readonly List<(MeshInstance3D mesh, int index)> _mouthShapes = new();
    FaceRig? _face;

    /// <summary>The character's facial blend shapes (null before setup).</summary>
    public FaceRig? Face => _face;
    readonly Dictionary<string, string> _names = new();
    string? _idle, _walk, _run, _crouchIdle, _crouchWalk;
    string? _override, _loco;
    bool _overrideLoops, _overrideDone;
    float _mouth, _speed, _clipSpeed = 1f;
    Vector3 _lastPos;
    bool _hasLastPos;

    /// <summary>The AnimationPlayer driven by this Animator (null for static meshes).</summary>
    public AnimationPlayer? Player => _player;

    /// <summary>Clip currently shown (override or locomotion state).</summary>
    public string? CurrentClip => _override ?? _loco;

    /// <summary>Horizontal speed of the entity in m/s (smoothed).</summary>
    public float MoveSpeed => _speed;

    /// <summary>Use crouch clips for locomotion when the model has them.</summary>
    public bool Crouching { get; set; }

    /// <summary>The entity this component belongs to.</summary>
    public Node3D Entity => GetParentOrNull<Node3D>() ?? this;

    /// <summary>The Animator of an entity (the entity itself, a child, or null).</summary>
    /// <summary>Fades the face to a named expression (FaceRig.Presets) or unit; "a+b" combines them.</summary>
    public void SetExpression(string expression, float weight = 1f, float fade = 0.4f) => _face?.Set(expression, weight, fade);

    public static Animator? Of(Node? entity)
    {
        if (entity == null) return null;
        if (entity is Animator a) return a;
        return entity.GetNodeOrNull<Animator>("Animator") ?? Entities.Component<Animator>(entity);
    }

    public override void _Ready()
    {
        var entity = Entity;
        var mesh = entity.GetNodeOrNull("Mesh");
        _player = Entities.Descendant<AnimationPlayer>(mesh) ?? Entities.Descendant<AnimationPlayer>(entity, 6);
        _skeleton = Entities.Descendant<Skeleton3D>(mesh) ?? Entities.Descendant<Skeleton3D>(entity, 6);
        if (_skeleton != null)
        {
            for (var i = 0; i < _skeleton.GetBoneCount(); i++)
                if (_skeleton.GetBoneName(i).ToLowerInvariant().Contains("jaw"))
                {
                    _jaw = i;
                    break;
                }
        }
        FindMouthShapes(mesh ?? entity);
        _face = new FaceRig(mesh ?? entity) { Blink = Blink };
        if (!string.IsNullOrEmpty(Expression)) _face.Set(Expression, 1f, 0.01f);

        if (_player != null)
        {
            foreach (var name in _player.GetAnimationList())
            {
                var key = Normalize(name);
                _names.TryAdd(key, name);
                _names.TryAdd(name.ToLowerInvariant(), name);
            }
            _idle = Find(IdleNames);
            _walk = Find(WalkNames);
            _run = Find(RunNames);
            _crouchIdle = Find(CrouchIdleNames);
            _crouchWalk = Find(CrouchWalkNames);
            foreach (var n in new[] { _idle, _walk, _run, _crouchIdle, _crouchWalk })
                if (n != null) _player.GetAnimation(n).LoopMode = Animation.LoopModeEnum.Linear;
            _player.AnimationFinished += OnFinished;
            _player.MixerApplied += ApplyJaw;
        }

        var initial = string.IsNullOrEmpty(Initial) ? "idle" : Initial;
        if (Resolve(initial) is { } clip && clip != _idle) Play(initial, 0f);
        else if (_idle != null) PlayRaw(_idle, 0f, 1f);
    }

    void FindMouthShapes(Node root)
    {
        var stack = new Stack<Node>();
        stack.Push(root);
        while (stack.Count > 0)
        {
            var n = stack.Pop();
            if (n is MeshInstance3D mi && mi.Mesh != null)
            {
                foreach (var shape in BlendShapeNames)
                {
                    var idx = mi.FindBlendShapeByName(shape);
                    if (idx < 0) continue;
                    _mouthShapes.Add((mi, idx));
                    break;
                }
            }
            foreach (var c in n.GetChildren()) stack.Push(c);
        }
    }

    static string Normalize(string name)
    {
        var s = name;
        var cut = Math.Max(s.LastIndexOf('|'), s.LastIndexOf('/'));
        if (cut >= 0) s = s[(cut + 1)..];
        return s.ToLowerInvariant().Replace(' ', '_').Replace('-', '_');
    }

    string? Find(string[] candidates)
    {
        foreach (var c in candidates)
            if (_names.TryGetValue(c, out var n)) return n;
        return null;
    }

    /// <summary>Animation name for a clip or alias (null if the model has no such clip).</summary>
    public string? Resolve(string clip)
    {
        if (_player == null || string.IsNullOrEmpty(clip)) return null;
        if (_player.HasAnimation(clip)) return clip;
        var key = Normalize(clip);
        if (_names.TryGetValue(key, out var n)) return n;
        if (Aliases.TryGetValue(key, out var alias) && _names.TryGetValue(alias, out n)) return n;
        foreach (var (k, v) in Aliases)
            if (v == key && _names.TryGetValue(k, out n)) return n;
        return null;
    }

    /// <summary>True when the model has this clip (or alias).</summary>
    public bool HasClip(string clip) => Resolve(clip) != null;

    /// <summary>
    /// Plays a clip with a crossfade. <paramref name="loop"/> null keeps the clip's own loop mode.
    /// Returns false when the clip is missing.
    /// </summary>
    public bool Play(string clip, float fade = 0.25f, bool? loop = null, float speed = 1f)
    {
        var name = Resolve(clip);
        if (name == null || _player == null)
        {
            Log.WarnOnce($"anim:{Entities.NameOf(Entity)}:{clip}",
                _player == null ? $"'{Entities.NameOf(Entity)}' has no AnimationPlayer; cannot play '{clip}'." : $"'{Entities.NameOf(Entity)}' has no clip '{clip}'.");
            return false;
        }
        var anim = _player.GetAnimation(name);
        if (loop != null) anim.LoopMode = loop.Value ? Animation.LoopModeEnum.Linear : Animation.LoopModeEnum.None;
        if (Locomotion && (name == _idle || name == _walk || name == _run) && loop != false)
        {
            Release(fade);
            return true;
        }
        _override = name;
        _overrideLoops = anim.LoopMode != Animation.LoopModeEnum.None;
        _overrideDone = false;
        _clipSpeed = speed;
        PlayRaw(name, fade, speed);
        return true;
    }

    /// <summary>Ends a clip override and returns to locomotion.</summary>
    public void Release(float fade = 0.35f)
    {
        _override = null;
        _overrideDone = false;
        _loco = null;
        UpdateLocomotion(fade);
    }

    void PlayRaw(string name, float fade, float speed)
    {
        if (_player == null) return;
        _player.SpeedScale = Speed * speed;
        _player.Play(name, fade <= 0f ? 0.0 : fade);
        if (fade <= 0f) _player.Advance(0);
    }

    void OnFinished(StringName name)
    {
        if (_override == null || name.ToString() != _override) return;
        _overrideDone = true;
        ClipFinished?.Invoke(name);
    }

    public override void _Process(double delta)
    {
        var dt = (float)delta;
        MeasureSpeed(dt);

        _mouth = Mathf.Lerp(_mouth, Mathf.Clamp(Mouth, 0f, 1f), Easing.Damp(30f, delta));
        if (_face is { HasMouth: true }) _face.Update(dt, _mouth);
        else
        {
            _face?.Update(dt, 0f);
            foreach (var (mesh, index) in _mouthShapes)
                if (IsInstanceValid(mesh)) mesh.SetBlendShapeValue(index, _mouth);
        }
        if (_player == null) ApplyJaw();

        if (_player == null) return;
        if (_override != null)
        {
            var moving = _speed > 0.35f;
            var release = _overrideLoops ? moving && !Cutscenes.IsPlaying : _overrideDone && (moving || !Cutscenes.InputBlocked);
            if (release) Release();
            return;
        }
        UpdateLocomotion(0.3f);
    }

    void MeasureSpeed(float dt)
    {
        var pos = Entity.GlobalPosition;
        if (_hasLastPos && dt > 0f)
        {
            var d = pos - _lastPos;
            d.Y = 0f;
            var v = d.Length() / dt;
            if (v > 15f) v = _speed; // teleport
            _speed = Mathf.Lerp(_speed, v, Easing.Damp(10f, dt));
        }
        _lastPos = pos;
        _hasLastPos = true;
    }

    void UpdateLocomotion(float fade)
    {
        if (_player == null || !Locomotion) return;
        string? want;
        var scale = 1f;
        var runFrom = (WalkClipSpeed + RunClipSpeed) * 0.5f;
        if (Crouching && _crouchIdle != null)
        {
            want = _speed > 0.15f && _crouchWalk != null ? _crouchWalk : _crouchIdle;
            if (want == _crouchWalk) scale = Mathf.Clamp(_speed / (WalkClipSpeed * 0.6f), 0.5f, 1.5f);
        }
        else if (_speed < 0.15f || _walk == null) want = _idle;
        else if (_speed < runFrom || _run == null)
        {
            want = _walk;
            scale = Mathf.Clamp(_speed / WalkClipSpeed, 0.45f, _run == null ? 2.2f : 1.6f);
        }
        else
        {
            want = _run;
            scale = Mathf.Clamp(_speed / RunClipSpeed, 0.6f, 1.4f);
        }
        if (want == null) return;
        if (want != _loco)
        {
            _loco = want;
            _player.Play(want, fade);
        }
        _player.SpeedScale = Speed * scale;
    }

    void ApplyJaw()
    {
        if (_skeleton == null || _jaw < 0 || !IsInstanceValid(_skeleton)) return;
        var current = _skeleton.GetBonePoseRotation(_jaw);
        if (!current.IsEqualApprox(_jawWritten)) _jawBase = current;
        var q = _jawBase * new Quaternion(Vector3.Right, Mathf.DegToRad(JawOpenDegrees * _mouth));
        _skeleton.SetBonePoseRotation(_jaw, q);
        _jawWritten = q;
    }
}
