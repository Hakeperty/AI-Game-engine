using System;
using System.Collections.Generic;
using Godot;

namespace Aige;

/// <summary>
/// Facial blend shapes of a character (MakeHuman expression units such as <c>eye_left_closure</c>,
/// <c>eyebrows_left_inner_up</c>, <c>mouth_retraction</c>): automatic blinking, named expressions that
/// cross-fade (<see cref="Presets"/>), and the lip-sync mouth. Owned by <see cref="Animator"/>; drive it with
/// <c>Animator.SetExpression("fear")</c> or a cutscene <c>face</c> track.
/// </summary>
public sealed class FaceRig
{
    /// <summary>Named expressions as expression-unit weights. Missing units are ignored.</summary>
    public static readonly Dictionary<string, Dictionary<string, float>> Presets = new(StringComparer.OrdinalIgnoreCase)
    {
        ["neutral"] = new(),
        ["worried"] = Both(("eyebrows_{s}_inner_up", 0.55f)).With(("mouth_compression", 0.25f)),
        ["fear"] = Both(("eye_{s}_opened_up", 0.75f), ("eyebrows_{s}_inner_up", 0.9f), ("eyebrows_{s}_up", 0.35f))
            .With(("mouth_retraction", 0.45f), ("neck_platysma", 0.45f), ("mouth_open", 0.12f)),
        ["terror"] = Both(("eye_{s}_opened_up", 1f), ("eyebrows_{s}_inner_up", 1f), ("eyebrows_{s}_up", 0.6f))
            .With(("mouth_retraction", 0.7f), ("neck_platysma", 0.8f), ("mouth_open", 0.3f)),
        ["scream"] = Both(("eye_{s}_opened_up", 0.7f), ("eyebrows_{s}_inner_up", 0.85f), ("eyebrows_{s}_up", 0.4f))
            .With(("mouth_retraction", 0.6f), ("neck_platysma", 0.9f), ("mouth_open", 0.55f)),
        ["pain"] = Both(("eye_{s}_slit", 0.75f), ("eyebrows_{s}_down", 0.5f), ("eyebrows_{s}_inner_up", 0.45f), ("nose_{s}_elevation", 0.5f))
            .With(("mouth_upward_retraction", 0.55f), ("mouth_compression", 0.3f), ("neck_platysma", 0.3f)),
        ["sad"] = Both(("eyebrows_{s}_inner_up", 0.8f), ("eye_{s}_slit", 0.2f)).With(("mouth_depression", 0.6f)),
        ["crying"] = Both(("eyebrows_{s}_inner_up", 1f), ("eye_{s}_slit", 0.45f), ("nose_{s}_elevation", 0.3f))
            .With(("mouth_depression", 0.8f), ("mouth_retraction", 0.3f), ("neck_platysma", 0.3f)),
        ["shock"] = Both(("eye_{s}_opened_up", 1f), ("eyebrows_{s}_up", 0.8f)).With(("mouth_open", 0.35f)),
        ["relief"] = Both(("eye_{s}_slit", 0.15f)).With(("mouth_corner_puller", 0.25f)),
        ["squint"] = Both(("eye_{s}_slit", 0.6f), ("eyebrows_{s}_down", 0.3f)),
        ["dazed"] = Both(("eye_{s}_closure", 0.45f), ("eyebrows_{s}_inner_up", 0.3f)).With(("mouth_open", 0.08f)),
        ["asleep"] = Both(("eye_{s}_closure", 1f)).With(("mouth_open", 0.05f)),
    };

    static readonly string[] BlinkL = { "eye_left_closure", "eyeBlinkLeft", "blink_l" };
    static readonly string[] BlinkR = { "eye_right_closure", "eyeBlinkRight", "blink_r" };
    static readonly string[] MouthOpen = { "mouth_open", "jawOpen", "mouthOpen", "MouthOpen", "jaw_open" };

    readonly Dictionary<string, List<(MeshInstance3D mi, int idx)>> _shapes = new(StringComparer.OrdinalIgnoreCase);
    readonly Dictionary<string, float> _current = new(StringComparer.OrdinalIgnoreCase);
    Dictionary<string, float> _target = new(StringComparer.OrdinalIgnoreCase);
    readonly RandomNumberGenerator _rng = new();
    string? _blinkL, _blinkR, _mouth;
    float _fade = 0.4f, _nextBlink = 2f, _blinkT = -1f;

    /// <summary>Blink now and then (off while an expression keeps the eyes shut).</summary>
    public bool Blink = true;
    /// <summary>How far lip-sync drives the mouth-open shape (the jaw bone does the rest).</summary>
    public float MouthAmount = 0.6f;
    /// <summary>The expression currently faded in.</summary>
    public string Expression { get; private set; } = "neutral";
    /// <summary>0..1 how frightened the face is (inner brows raised past "worried"): drives darting eyes and trembling.</summary>
    public float Distress => Mathf.Clamp((_current.GetValueOrDefault("eyebrows_left_inner_up") - 0.6f) / 0.35f, 0f, 1f);

    /// <summary>True when the character has facial blend shapes.</summary>
    public bool Active => _shapes.Count > 0;
    /// <summary>True when the lip-sync mouth goes through a blend shape here.</summary>
    public bool HasMouth => _mouth != null;

    public FaceRig(Node root)
    {
        _rng.Randomize();
        var stack = new Stack<Node>();
        stack.Push(root);
        while (stack.Count > 0)
        {
            var n = stack.Pop();
            if (n is MeshInstance3D mi && mi.Mesh is ArrayMesh am)
                for (var i = 0; i < am.GetBlendShapeCount(); i++)
                {
                    var name = am.GetBlendShapeName(i).ToString();
                    if (!_shapes.TryGetValue(name, out var list)) _shapes[name] = list = new();
                    list.Add((mi, i));
                }
            foreach (var c in n.GetChildren()) stack.Push(c);
        }
        _blinkL = First(BlinkL);
        _blinkR = First(BlinkR);
        _mouth = First(MouthOpen);
    }

    string? First(string[] names)
    {
        foreach (var n in names)
            if (_shapes.ContainsKey(n)) return n;
        return null;
    }

    /// <summary>Fades to a named expression (see <see cref="Presets"/>) or a single unit, scaled by weight.</summary>
    public void Set(string expression, float weight = 1f, float fade = 0.4f)
    {
        var target = new Dictionary<string, float>(StringComparer.OrdinalIgnoreCase);
        foreach (var part in expression.Split('+', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            if (Presets.TryGetValue(part, out var preset))
                foreach (var (unit, w) in preset) target[unit] = Math.Max(target.GetValueOrDefault(unit), w * weight);
            else if (_shapes.ContainsKey(part)) target[part] = Math.Max(target.GetValueOrDefault(part), weight);
            else Log.WarnOnce($"face:{part}", $"Face: unknown expression '{part}'.");
        }
        _target = target;
        _fade = Math.Max(0.01f, fade);
        Expression = expression;
    }

    public void Update(float dt, float mouth)
    {
        if (!Active) return;
        // expression cross-fade
        var rate = dt / _fade;
        foreach (var name in new List<string>(_current.Keys))
            if (!_target.ContainsKey(name)) _current[name] = Mathf.MoveToward(_current[name], 0f, rate);
        foreach (var (name, w) in _target) _current[name] = Mathf.MoveToward(_current.GetValueOrDefault(name), w, rate);

        // blinking: quick close, slower open, every 2-6 s (more often when frightened)
        var blink = 0f;
        var shut = Math.Max(_current.GetValueOrDefault(_blinkL ?? ""), _current.GetValueOrDefault(_blinkR ?? ""));
        if (Blink && _blinkL != null && shut < 0.6f)
        {
            if (_blinkT < 0f)
            {
                _nextBlink -= dt;
                if (_nextBlink <= 0f)
                {
                    _blinkT = 0f;
                    var nervous = _current.GetValueOrDefault("eyebrows_left_inner_up") > 0.5f;
                    _nextBlink = _rng.RandfRange(nervous ? 1.2f : 2.2f, nervous ? 3.5f : 6f);
                }
            }
            else
            {
                _blinkT += dt;
                blink = _blinkT < 0.06f ? _blinkT / 0.06f : Math.Max(0f, 1f - (_blinkT - 0.06f) / 0.11f);
                if (_blinkT > 0.17f) _blinkT = -1f;
            }
        }

        foreach (var (name, list) in _shapes)
        {
            var v = _current.GetValueOrDefault(name);
            if (name == _blinkL || name == _blinkR) v = Math.Max(v, blink);
            if (name == _mouth) v = Math.Max(v, mouth * MouthAmount);
            foreach (var (mi, idx) in list)
                if (GodotObject.IsInstanceValid(mi)) mi.SetBlendShapeValue(idx, Mathf.Clamp(v, 0f, 1f));
        }
    }

    static Dictionary<string, float> Both(params (string unit, float w)[] units)
    {
        var d = new Dictionary<string, float>(StringComparer.OrdinalIgnoreCase);
        foreach (var (u, w) in units)
        {
            d[u.Replace("{s}", "left")] = w;
            d[u.Replace("{s}", "right")] = w;
        }
        return d;
    }
}

static class FaceRigExt
{
    public static Dictionary<string, float> With(this Dictionary<string, float> d, params (string unit, float w)[] units)
    {
        foreach (var (u, w) in units) d[u] = w;
        return d;
    }
}

/// <summary>
/// Small signs of life applied after the animation mixer: the eyes move in quick saccades (darting when
/// frightened), and fear makes the head and hands tremble. Needs <c>eye_l</c>/<c>eye_r</c> bones for the eyes.
/// </summary>
public sealed class EyesAndTremor
{
    readonly Skeleton3D _sk;
    readonly int _eyeL, _eyeR;
    readonly (int bone, float amp, float freq)[] _tremble;
    readonly Dictionary<int, (Quaternion baseQ, Quaternion written)> _state = new();
    readonly RandomNumberGenerator _rng = new();
    Vector2 _gaze, _target;
    float _next = 1f, _t;

    public EyesAndTremor(Skeleton3D sk)
    {
        _sk = sk;
        _rng.Randomize();
        _eyeL = sk.FindBone("eye_l");
        _eyeR = sk.FindBone("eye_r");
        var list = new List<(int, float, float)>();
        foreach (var (name, amp, freq) in new[] { ("head", 1.2f, 7.3f), ("hand_l", 2.4f, 9.1f), ("hand_r", 2.4f, 8.6f), ("forearm_l", 0.9f, 6.2f), ("forearm_r", 0.9f, 6.7f) })
        {
            var i = sk.FindBone(name);
            if (i >= 0) list.Add((i, amp, freq));
        }
        _tremble = list.ToArray();
    }

    /// <summary><paramref name="fear"/> 0..1: how often and far the eyes dart, how hard he trembles.</summary>
    public void Apply(float dt, float fear)
    {
        if (!GodotObject.IsInstanceValid(_sk)) return;
        _t += dt;
        if (_eyeL >= 0 || _eyeR >= 0)
        {
            _next -= dt;
            if (_next <= 0f)
            {
                var range = Mathf.Lerp(1f, 2.2f, fear);
                _target = new Vector2(_rng.RandfRange(-8f, 8f) * range, _rng.RandfRange(-3.5f, 3.5f) * range);
                _next = _rng.RandfRange(Mathf.Lerp(0.6f, 0.2f, fear), Mathf.Lerp(2.6f, 0.8f, fear));
            }
            // a saccade snaps in ~40 ms, then the eye holds with a tiny drift
            _gaze = _gaze.Lerp(_target, 1f - Mathf.Exp(-dt * 35f));
            var yaw = _gaze.X + Mathf.Sin(_t * 13.1f) * 0.25f;
            var pitch = _gaze.Y + Mathf.Sin(_t * 11.7f) * 0.2f;
            var q = Quaternion.FromEuler(new Vector3(Mathf.DegToRad(-pitch), Mathf.DegToRad(yaw), 0f));
            Set(_eyeL, q);
            Set(_eyeR, q);
        }
        if (fear > 0.01f)
            foreach (var (bone, amp, freq) in _tremble)
            {
                var a = Mathf.DegToRad(amp * fear);
                var x = (Mathf.Sin(_t * freq * 6.283f) + 0.5f * Mathf.Sin(_t * freq * 2.1f * 6.283f + 1.3f)) * a;
                var z = (Mathf.Sin(_t * freq * 1.3f * 6.283f + 0.7f) + 0.4f * Mathf.Sin(_t * freq * 3.2f * 6.283f)) * a;
                Set(bone, Quaternion.FromEuler(new Vector3(x, 0f, z)));
            }
    }

    // applies an offset on top of what the mixer wrote this frame (never on top of our own last write)
    void Set(int bone, Quaternion offset)
    {
        if (bone < 0) return;
        var current = _sk.GetBonePoseRotation(bone);
        (Quaternion baseQ, Quaternion written) st = _state.TryGetValue(bone, out var s) ? s : (Quaternion.Identity, Quaternion.Identity);
        var baseQ = current.IsEqualApprox(st.written) ? st.baseQ : current;
        var w = baseQ * offset;
        _sk.SetBonePoseRotation(bone, w);
        _state[bone] = (baseQ, w);
    }
}
