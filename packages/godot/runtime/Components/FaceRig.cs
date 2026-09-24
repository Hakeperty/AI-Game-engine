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
