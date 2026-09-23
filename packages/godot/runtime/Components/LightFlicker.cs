using System;
using System.Collections.Generic;
using Godot;

namespace Aige;

/// <summary>
/// Natural light flicker (AIGE <c>Light.flicker</c>): a child node named <c>Flicker</c> of the
/// entity's Light node (Light3D cannot be subclassed in C#), driving its parent light.
/// <see cref="Amount"/> 0.1 = candle breath, 0.5 = old bulb, 1 = dying bulb with dropouts.
/// Cutscene light tracks tween <see cref="BaseEnergy"/>. <see cref="Flash"/> adds a lightning flash;
/// <see cref="Lightning"/> strikes every light tagged 'Lightning' with a screen flash and thunder.
/// <code>
/// LightFlicker.Lightning();                       // flash + thunder 1.2 s later
/// GetNode&lt;LightFlicker&gt;("Lamp/Light/Flicker").Flash(6f);
/// </code>
/// </summary>
public partial class LightFlicker : Node
{
    /// <summary>Flicker strength 0..1.</summary>
    [Export(PropertyHint.Range, "0,1")] public float Amount { get; set; } = 0.3f;

    /// <summary>Flicker speed multiplier.</summary>
    [Export] public float Rate { get; set; } = 1f;

    /// <summary>Steady energy the flicker modulates (defaults to the light's energy).</summary>
    [Export] public float BaseEnergy { get; set; } = -1f;

    /// <summary>Light color (defaults to the light's color).</summary>
    [Export] public Color BaseColor { get; set; } = new(1, 1, 1, 0);

    readonly List<(float start, float peak, float duration)> _flashes = new();
    Light3D? _light;

    /// <summary>The light this flicker drives (its parent).</summary>
    public Light3D? Light => _light;

    /// <summary>The LightFlicker driving <paramref name="light"/> (a child of it), or null.</summary>
    public static LightFlicker? Of(Light3D? light) => light == null ? null : Entities.Component<LightFlicker>(light);
    FastNoiseLite _noise = null!;
    float _clock, _dropTimer = 2f, _drop, _dropDepth = 1f;

    public override void _Ready()
    {
        _light = GetParentOrNull<Light3D>() ?? Entities.Descendant<Light3D>(GetParent(), 2);
        if (_light == null)
        {
            Log.Warn($"LightFlicker '{GetPath()}' has no Light3D parent.");
            SetProcess(false);
            return;
        }
        if (BaseEnergy < 0f) BaseEnergy = _light.LightEnergy;
        if (BaseColor.A <= 0f) BaseColor = _light.LightColor;
        _noise = new FastNoiseLite { Seed = (int)(GetInstanceId() % 100000), Frequency = 1f, NoiseType = FastNoiseLite.NoiseTypeEnum.Simplex };
    }

    public override void _Process(double delta)
    {
        var dt = (float)delta;
        _clock += dt;
        var t = _clock * Rate;
        var f = 1f;
        if (Amount > 0f)
        {
            var slow = _noise.GetNoise1D(t * 2.3f) * 0.5f + 0.5f;
            var fast = _noise.GetNoise1D(t * 17f + 91f) * 0.5f + 0.5f;
            f = 1f - Amount * (0.38f * slow + 0.2f * fast);
            if (Amount > 0.45f)
            {
                _dropTimer -= dt;
                if (_dropTimer <= 0f)
                {
                    _dropTimer = (float)GD.RandRange(0.6, 7.0 / Amount);
                    _drop = (float)GD.RandRange(0.04, 0.22);
                    _dropDepth = Mathf.Lerp(0.7f, 0.05f, (Amount - 0.45f) / 0.55f);
                }
                if (_drop > 0f)
                {
                    _drop -= dt;
                    f *= _dropDepth;
                }
            }
        }
        if (_light == null || !IsInstanceValid(_light)) return;
        _light.LightEnergy = Mathf.Max(0f, BaseEnergy * f + FlashEnergy());
        if (_light.LightColor != BaseColor) _light.LightColor = BaseColor;
    }

    float FlashEnergy()
    {
        var e = 0f;
        for (var i = _flashes.Count - 1; i >= 0; i--)
        {
            var (start, peak, duration) = _flashes[i];
            var x = (_clock - start) / duration;
            if (x >= 1f)
            {
                _flashes.RemoveAt(i);
                continue;
            }
            e += peak * FlashPattern(x);
        }
        return e;
    }

    static float Bump(float x, float start, float width)
    {
        var u = (x - start) / width;
        return u is >= 0f and <= 1f ? MathF.Sin(u * MathF.PI) : 0f;
    }

    /// <summary>Lightning intensity over normalized time: a hit, then two after-flickers.</summary>
    public static float FlashPattern(float x) =>
        x < 0f ? 0f : Mathf.Max(MathF.Exp(-x * 9f), Mathf.Max(0.7f * Bump(x, 0.16f, 0.12f), 0.35f * Bump(x, 0.4f, 0.14f)));

    /// <summary>Adds a lightning flash of <paramref name="intensity"/> extra energy.</summary>
    public void Flash(float intensity = 8f, float duration = 0.8f) =>
        _flashes.Add((_clock, intensity, Mathf.Max(0.05f, duration)));

    /// <summary>Flashes any light (LightFlicker or a plain Light3D).</summary>
    public static void FlashLight(Light3D light, float intensity = 8f, float duration = 0.8f)
    {
        if (Of(light) is { } lf)
        {
            lf.Flash(intensity, duration);
            return;
        }
        var baseEnergy = light.LightEnergy;
        var tw = light.CreateTween();
        tw.TweenMethod(Callable.From<float>(x => light.LightEnergy = baseEnergy + intensity * FlashPattern(x)), 0f, 1f, Mathf.Max(0.05f, duration));
        tw.TweenCallback(Callable.From(() => light.LightEnergy = baseEnergy));
    }

    /// <summary>
    /// A lightning strike: flashes every light tagged <paramref name="tag"/>, flashes the screen, and
    /// plays <paramref name="thunder"/> after <paramref name="thunderDelay"/> seconds (null = no sound).
    /// </summary>
    public static void Lightning(float intensity = 8f, float duration = 0.8f, string? thunder = "thunder", float thunderDelay = 1.2f, string tag = "Lightning")
    {
        foreach (var e in Entities.Tagged(tag))
        {
            var light = e as Light3D ?? Entities.Component<Light3D>(e);
            if (light != null) FlashLight(light, intensity, duration);
        }
        Hud.Flash(0.55f, duration);
        if (string.IsNullOrEmpty(thunder) || Engine.GetMainLoop() is not SceneTree tree) return;
        if (thunderDelay <= 0f)
        {
            Thunder(thunder);
            return;
        }
        tree.CreateTimer(thunderDelay).Timeout += () => Thunder(thunder);
    }

    static void Thunder(string sound)
    {
        Sfx.Play(sound);
        Hud.Shake(0.35f, 1.2f);
    }
}
