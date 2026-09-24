using System;
using System.Collections.Generic;
using Godot;

namespace Aige;

/// <summary>
/// Cutscene player (autoload <c>Cutscenes</c>). Runs AIGE CutsceneDocs
/// (<c>res://cutscenes/*.cutscene.json</c>): camera shots with easing, FOV and depth of field,
/// character animation and movement, voice lines, sounds, subtitles, screen FX, light tweens and
/// story events. Player input is disabled while one plays; hold <c>skip</c> to skip it.
/// <code>
/// Cutscenes.Play("res://cutscenes/cs1_wake.cutscene.json");
/// Cutscenes.Play("cs3_weapon", () =&gt; Story.SetObjective("Explore the house"));
/// if (Cutscenes.IsPlaying) return;
/// </code>
/// </summary>
public partial class Cutscenes : Node
{
    sealed class Run
    {
        public required CutsceneDoc Doc;
        public float Time;
        public float Length;
        public required bool[][] Fired;
        public required bool[] MoveDone;
        public Action? OnFinished;
        public readonly Dictionary<string, Node?> Refs = new();
    }

    /// <summary>The autoload instance.</summary>
    public static Cutscenes? Instance { get; private set; }

    /// <summary>Raised when a cutscene starts: (name, path).</summary>
    public static event Action<string, string>? Started;

    /// <summary>Raised when a cutscene ends: (name, skipped).</summary>
    public static event Action<string, bool>? Finished;

    /// <summary>Skip every cutscene as soon as it starts (the test harness sets this for <c>skipCutscenes</c>).</summary>
    public static bool AutoSkip { get; set; }

    /// <summary>How long <c>skip</c> must be held to skip a skippable cutscene.</summary>
    public static float SkipHoldSeconds { get; set; } = 1f;

    /// <summary>True while a cutscene is running.</summary>
    public static bool IsPlaying => Instance?._run != null;

    /// <summary>True while player input must be ignored: a cutscene is playing, or one ended without returning control.</summary>
    public static bool InputBlocked => Instance != null && (Instance._run != null || Instance._locked);

    /// <summary>Name of the running cutscene (null when none).</summary>
    public static string? Current => Instance?._run?.Doc.Name;

    /// <summary>Seconds since the running cutscene started (0 when none).</summary>
    public static float Time => Instance?._run?.Time ?? 0f;

    /// <summary>The dedicated cutscene camera.</summary>
    public static Camera3D? Camera => Instance?._cam;

    readonly Queue<(CutsceneDoc doc, Action? done)> _queue = new();
    readonly Dictionary<ulong, Tween> _lightTweens = new();
    readonly Dictionary<ulong, Vector3> _focusLocal = new();
    Run? _run;
    bool _locked, _skipArmed, _skipRequested;
    float _skipHold;
    Camera3D _cam = null!;
    Camera3D? _gameplayCamera;
    CameraAttributesPractical _dof = null!;

    public override void _EnterTree()
    {
        Instance = this;
    }

    public override void _ExitTree()
    {
        if (Instance == this) Instance = null;
    }

    public override void _Ready()
    {
        _cam = new Camera3D { Name = "CutsceneCamera", Near = 0.05f, Far = 800f, Fov = 50f };
        AddChild(_cam);
        _dof = new CameraAttributesPractical();
    }

    // =====================================================================================
    // Static API
    // =====================================================================================

    /// <summary>True when the game was started with <c>--aige-no-cutscenes</c> (screenshot tool); Play does nothing.</summary>
    public static bool Disabled { get; } = System.Array.IndexOf(OS.GetCmdlineUserArgs(), "--aige-no-cutscenes") >= 0;

    /// <summary>
    /// Plays a cutscene by path ('res://cutscenes/cs1.cutscene.json') or name ('cs1'). If one is
    /// already playing, this one is queued. Returns false when the file is missing or invalid.
    /// </summary>
    public static bool Play(string pathOrName, Action? onFinished = null)
    {
        var self = Instance;
        if (self == null) return false;
        // Screenshot runs (addons/aige/Tools/capture.gd) frame the level itself, not the story.
        if (Disabled) return false;
        var doc = CutsceneDoc.Load(pathOrName);
        if (doc == null) return false;
        if (self._run != null) self._queue.Enqueue((doc, onFinished));
        else self.Start(doc, onFinished);
        return true;
    }

    /// <summary>Skips the running cutscene: remaining story events still apply, speech and sounds do not.</summary>
    public static void Skip()
    {
        if (Instance?._run != null) Instance._skipRequested = true;
    }

    /// <summary>Gives control back after a cutscene that ended with <c>returnControl: false</c>.</summary>
    public static void ReturnControl() => Instance?.ReturnControlImpl();

    // =====================================================================================
    // Playback
    // =====================================================================================

    void Start(CutsceneDoc doc, Action? onFinished)
    {
        var current = GetViewport().GetCamera3D();
        if (!_locked) _gameplayCamera = current != _cam ? current : null;
        if (current != null && current != _cam)
        {
            _cam.GlobalTransform = current.GlobalTransform;
            _cam.Fov = current.Fov;
        }
        _cam.Attributes = null;
        _cam.MakeCurrent();

        var fired = new bool[doc.Tracks.Count][];
        for (var i = 0; i < doc.Tracks.Count; i++) fired[i] = new bool[doc.Tracks[i].Items.Count];
        _run = new Run
        {
            Doc = doc,
            Length = doc.Length,
            Fired = fired,
            MoveDone = new bool[doc.Tracks.Count],
            OnFinished = onFinished,
        };
        _focusLocal.Clear();
        _skipHold = 0f;
        _skipArmed = !Input.IsActionPressed("skip");
        Hud.HidePrompt();
        Hud.Fx("letterbox", doc.Letterbox ? 1f : 0f, 0.8f);
        Log.Info($"Cutscene '{doc.Name}' ({AigeJson.F(_run.Length)} s)");
        Started?.Invoke(doc.Name, doc.Path);
        if (AutoSkip) _skipRequested = true;
        Evaluate(0f);
    }

    public override void _Process(double delta)
    {
        if (_run == null)
        {
            if (_queue.Count > 0)
            {
                var (doc, done) = _queue.Dequeue();
                Start(doc, done);
            }
            return;
        }
        if (_skipRequested)
        {
            _skipRequested = false;
            SkipNow();
            return;
        }
        var dt = (float)delta;
        if (_run.Doc.Skippable)
        {
            var held = Input.IsActionPressed("skip");
            if (!held) _skipArmed = true;
            if (_skipArmed && held)
            {
                _skipHold += dt;
                Hud.SetSkipProgress(_skipHold / SkipHoldSeconds);
                if (_skipHold >= SkipHoldSeconds)
                {
                    SkipNow();
                    return;
                }
            }
            else if (_skipHold > 0f)
            {
                _skipHold = 0f;
                Hud.SetSkipProgress(-1f);
            }
        }
        _run.Time += dt;
        Evaluate(_run.Time);
        if (_run != null && _run.Time >= _run.Length) Finish(false);
    }

    void Evaluate(float t)
    {
        var run = _run!;
        var tracks = run.Doc.Tracks;
        for (var ti = 0; ti < tracks.Count && _run == run; ti++)
        {
            var tr = tracks[ti];
            switch (tr.Type)
            {
                case "camera":
                    if (tr.CameraKeys.Count > 0) ApplyCamera(tr.CameraKeys, t);
                    break;
                case "move":
                    if (tr.MoveKeys.Count > 0 && !run.MoveDone[ti] && t >= tr.MoveKeys[0].T)
                    {
                        ApplyMove(tr, t);
                        if (t >= tr.MoveKeys[^1].T) run.MoveDone[ti] = true;
                    }
                    break;
                default:
                    var fired = run.Fired[ti];
                    for (var i = 0; i < tr.Items.Count; i++)
                    {
                        if (fired[i]) continue;
                        if (tr.Items[i].T > t) break;
                        fired[i] = true;
                        Fire(tr, tr.Items[i]);
                        if (_run != run) return;
                    }
                    break;
            }
        }
    }

    void SkipNow()
    {
        var run = _run;
        if (run == null) return;
        Voice.Stop();
        Hud.ClearSubtitles();
        var tracks = run.Doc.Tracks;
        for (var ti = 0; ti < tracks.Count; ti++)
        {
            var tr = tracks[ti];
            if (tr.Type == "move")
            {
                if (tr.MoveKeys.Count > 0 && !run.MoveDone[ti]) ApplyMove(tr, float.MaxValue);
                continue;
            }
            var fired = run.Fired[ti];
            CutsceneItemDoc? lastClip = null;
            for (var i = 0; i < tr.Items.Count; i++)
            {
                if (fired[i]) continue;
                fired[i] = true;
                var it = tr.Items[i];
                switch (tr.Type)
                {
                    case "event":
                        ApplyEvent(it);
                        break;
                    case "fx" when it.Effect is not ("flash" or "shake"):
                        Hud.Fx(it.Effect ?? "", it.To, 0f, it.Color);
                        break;
                    case "light":
                        TweenLight(it, instant: true);
                        break;
                    case "animation":
                        lastClip = it;
                        break;
                }
            }
            if (lastClip != null) Animator.Of(Ref(tr.Actor))?.Play(lastClip.Clip ?? "", 0.2f, lastClip.Loop, lastClip.Speed);
        }
        Log.Info($"Cutscene '{run.Doc.Name}' skipped");
        Finish(true);
    }

    void Finish(bool skipped)
    {
        var run = _run;
        if (run == null) return;
        _run = null;
        Hud.SetSkipProgress(-1f);
        if (run.Doc.ReturnControl) ReturnControlImpl();
        else _locked = true;
        Finished?.Invoke(run.Doc.Name, skipped);
        run.OnFinished?.Invoke();
    }

    void ReturnControlImpl()
    {
        _locked = false;
        if (_run != null) return;
        if (Hud.GetFx("letterbox") > 0f) Hud.Fx("letterbox", 0f, 0.6f);
        _cam.Attributes = null;
        var cam = _gameplayCamera != null && IsInstanceValid(_gameplayCamera) && _gameplayCamera.IsInsideTree()
            ? _gameplayCamera
            : ThirdPersonCamera.Current?.Camera;
        cam?.MakeCurrent();
        _gameplayCamera = null;
    }

    // =====================================================================================
    // Tracks
    // =====================================================================================

    Node? Ref(string? reference)
    {
        if (string.IsNullOrEmpty(reference) || _run == null) return null;
        if (_run.Refs.TryGetValue(reference, out var n) && n != null && IsInstanceValid(n)) return n;
        n = Entities.FindNode(reference);
        if (n == null) Log.WarnOnce($"cs-ref:{_run.Doc.Name}:{reference}", $"Cutscene '{_run.Doc.Name}': entity '{reference}' not found.");
        _run.Refs[reference] = n;
        return n;
    }

    Vector3 Point(PointRef p, bool look)
    {
        if (p.Entity == null) return p.Position;
        if (Ref(p.Entity) is not Node3D n) return p.Position;
        if (!look)
        {
            var cam = Entities.Component<Camera3D>(n);
            return cam?.GlobalPosition ?? n.GlobalPosition;
        }
        var id = n.GetInstanceId();
        if (!_focusLocal.TryGetValue(id, out var local))
            _focusLocal[id] = local = n.GlobalTransform.AffineInverse() * Entities.FocusPoint(n);
        return n.GlobalTransform * local;
    }

    static (T a, T b, float w) Segment<T>(List<T> keys, float t, Func<T, float> time, Func<T, T, float, float> weight)
    {
        if (keys.Count == 1 || t <= time(keys[0])) return (keys[0], keys[0], 0f);
        if (t >= time(keys[^1])) return (keys[^1], keys[^1], 0f);
        var i = 0;
        while (i < keys.Count - 2 && time(keys[i + 1]) <= t) i++;
        var a = keys[i];
        var b = keys[i + 1];
        var span = time(b) - time(a);
        var x = span > 0f ? (t - time(a)) / span : 1f;
        return (a, b, weight(a, b, x));
    }

    void ApplyCamera(List<CameraKeyDoc> keys, float t)
    {
        var (a, b, w) = Segment(keys, t, k => k.T, (_, next, x) => next.Cut || next.Ease == "hold" ? 0f : Easing.Apply(next.Ease, x));
        var pos = Point(a.Position, false).Lerp(Point(b.Position, false), w);
        var look = Point(a.LookAt, true).Lerp(Point(b.LookAt, true), w);
        var fov = Mathf.Lerp(a.Fov, b.Fov, w);
        var shake = Mathf.Lerp(a.Shake, b.Shake, w);
        var focus = Mathf.Lerp(a.Focus, b.Focus, w);
        var aperture = Mathf.Lerp(a.Aperture, b.Aperture, w);

        var dir = look - pos;
        if (dir.LengthSquared() < 1e-6f) dir = -_cam.GlobalBasis.Z;
        var up = MathF.Abs(dir.Normalized().Dot(Vector3.Up)) > 0.999f ? Vector3.Forward : Vector3.Up;
        var basis = Basis.LookingAt(dir, up);
        if (shake > 0f)
        {
            var tt = _run!.Time;
            var off = new Vector3(MathF.Sin(tt * 13.7f) + 0.5f * MathF.Sin(tt * 31.3f), MathF.Sin(tt * 17.9f + 1.1f) + 0.5f * MathF.Sin(tt * 27.1f), 0f);
            pos += basis * off * shake * 0.05f;
            basis = basis.Rotated(basis.Z.Normalized(), MathF.Sin(tt * 9.3f) * shake * 0.02f);
        }
        _cam.GlobalTransform = new Transform3D(basis, pos);
        _cam.Fov = Mathf.Clamp(fov, 5f, 150f);

        if (focus > 0.01f)
        {
            _dof.DofBlurFarEnabled = true;
            _dof.DofBlurFarDistance = focus + Mathf.Max(0.4f, focus * 0.35f);
            _dof.DofBlurFarTransition = Mathf.Max(1f, focus * 1.2f);
            _dof.DofBlurNearEnabled = focus > 0.8f;
            _dof.DofBlurNearDistance = focus * 0.55f;
            _dof.DofBlurNearTransition = focus * 0.4f;
            _dof.DofBlurAmount = Mathf.Lerp(0.04f, 0.3f, Mathf.Clamp(aperture, 0f, 1f));
            if (_cam.Attributes != _dof) _cam.Attributes = _dof;
        }
        else if (_cam.Attributes != null) _cam.Attributes = null;
    }

    void ApplyMove(CutsceneTrackDoc tr, float t)
    {
        if (Ref(tr.Actor) is not Node3D node) return;
        var (a, b, w) = Segment(tr.MoveKeys, t, k => k.T, (_, next, x) => Easing.Apply(next.Ease, x));
        node.GlobalPosition = a.Position.Lerp(b.Position, w);
        if (a.Rotation != null || b.Rotation != null)
        {
            var qa = ToQuat(a.Rotation ?? b.Rotation!.Value);
            var qb = ToQuat(b.Rotation ?? a.Rotation!.Value);
            node.GlobalBasis = new Basis(qa.Slerp(qb, w)).Scaled(node.GlobalBasis.Scale);
        }
        if (node is CharacterBody3D body) body.Velocity = Vector3.Zero;
    }

    static Quaternion ToQuat(Vector3 eulerDeg) =>
        Basis.FromEuler(new Vector3(Mathf.DegToRad(eulerDeg.X), Mathf.DegToRad(eulerDeg.Y), Mathf.DegToRad(eulerDeg.Z)), EulerOrder.Xyz).GetRotationQuaternion();

    void Fire(CutsceneTrackDoc tr, CutsceneItemDoc it)
    {
        switch (tr.Type)
        {
            case "animation":
                var anim = Animator.Of(Ref(tr.Actor));
                if (anim == null) Log.WarnOnce($"cs-anim:{tr.Actor}", $"Cutscene: '{tr.Actor}' has no Animator.");
                else anim.Play(it.Clip ?? "", it.Fade, it.Loop, it.Speed);
                break;
            case "voice":
                Voice.Play(it.Line ?? "", Ref(it.Actor), it.Subtitle);
                break;
            case "sound":
                Vector3? at = it.At != null && Ref(it.At) is Node3D where ? where.GlobalPosition : null;
                var sound = !string.IsNullOrEmpty(it.Clip) ? it.Clip : it.Sfx;
                if (!string.IsNullOrEmpty(sound)) Sfx.Play(sound, at, it.Volume);
                break;
            case "subtitle":
                Hud.Say(it.Text ?? "", it.Duration, it.Speaker);
                break;
            case "fx":
                Hud.Fx(it.Effect ?? "", it.To, it.Duration, it.Color);
                break;
            case "light":
                TweenLight(it, instant: false);
                break;
            case "event":
                ApplyEvent(it);
                break;
        }
    }

    void TweenLight(CutsceneItemDoc it, bool instant)
    {
        var ent = Ref(it.Entity);
        var light = ent as Light3D ?? Entities.Component<Light3D>(ent) ?? Entities.Descendant<Light3D>(ent, 3);
        if (light == null)
        {
            Log.WarnOnce($"cs-light:{it.Entity}", $"Cutscene: '{it.Entity}' has no light.");
            return;
        }
        // A flickering light is driven by its LightFlicker child: tween that one's base values.
        var flicker = LightFlicker.Of(light);
        GodotObject target = flicker != null ? flicker : light;
        var energyProp = flicker != null ? LightFlicker.PropertyName.BaseEnergy : (StringName)"light_energy";
        var colorProp = flicker != null ? LightFlicker.PropertyName.BaseColor : (StringName)"light_color";
        var id = light.GetInstanceId();
        if (_lightTweens.TryGetValue(id, out var old) && old.IsValid()) old.Kill();
        if (instant || it.Duration <= 0f)
        {
            target.Set(energyProp, it.Intensity);
            if (it.Color is { } c) target.Set(colorProp, c);
            return;
        }
        var tw = CreateTween();
        tw.TweenProperty(target, new NodePath(energyProp), it.Intensity, it.Duration).SetTrans(Tween.TransitionType.Sine);
        if (it.Color is { } col) tw.Parallel().TweenProperty(target, new NodePath(colorProp), col, it.Duration);
        _lightTweens[id] = tw;
    }

    void ApplyEvent(CutsceneItemDoc it)
    {
        if (!string.IsNullOrEmpty(it.SetFlag)) Story.SetFlag(it.SetFlag);
        if (!string.IsNullOrEmpty(it.ClearFlag)) Story.ClearFlag(it.ClearFlag);
        if (!string.IsNullOrEmpty(it.Enable)) Entities.SetEnabled(Ref(it.Enable), true);
        if (!string.IsNullOrEmpty(it.Disable)) Entities.SetEnabled(Ref(it.Disable), false);
        if (!string.IsNullOrEmpty(it.Give)) Story.Give(it.Give);
        if (!string.IsNullOrEmpty(it.Take)) Story.Take(it.Take);
        if (it.Objective != null) Story.SetObjective(it.Objective);
        if (!string.IsNullOrEmpty(it.TeleportEntity) && Ref(it.TeleportEntity) is Node3D n)
            Entities.Teleport(n, it.TeleportPosition, it.TeleportRotation);
        if (!string.IsNullOrEmpty(it.Emit)) Story.Emit(it.Emit);
    }
}
