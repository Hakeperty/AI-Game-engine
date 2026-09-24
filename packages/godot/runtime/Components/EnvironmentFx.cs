using System;
using Godot;

namespace Aige;

/// <summary>
/// Scene look (AIGE <c>Environment</c>), attached to the root <c>WorldEnvironment</c>. Hands the
/// screen-space extras (vignette, grain, temperature, tint) to <see cref="Hud"/>, applies cutscene
/// grade multipliers (exposure, fog, bloom, contrast, saturation), adds light shafts, and
/// cross-fades to another Environment with <see cref="Switch"/>.
/// <code>
/// EnvironmentFx.Switch("res://godot/environments/house-morning.tres", 4f); // night → morning
/// Story.Emit("env:res://godot/environments/house-morning.tres");           // same, from a cutscene event
/// </code>
/// </summary>
public partial class EnvironmentFx : WorldEnvironment
{
    /// <summary>Vignette 0..1.</summary>
    [Export] public float Vignette { get; set; } = 0.25f;

    /// <summary>Film grain 0..1.</summary>
    [Export] public float Grain { get; set; } = 0.12f;

    /// <summary>White balance: -1 cold blue … +1 warm orange.</summary>
    [Export] public float Temperature { get; set; }

    /// <summary>-1 green … +1 magenta.</summary>
    [Export] public float Tint { get; set; }

    /// <summary>Visible light beams for spot lights (0 = off, 0.5 = subtle).</summary>
    [Export] public float LightShafts { get; set; }

    /// <summary>Chromatic aberration 0..1 (lens fringing at the edges of the frame).</summary>
    [Export] public float Chromatic { get; set; }

    /// <summary>The EnvironmentFx of the running scene.</summary>
    public static EnvironmentFx? Current { get; private set; }

    struct Look
    {
        public float Exposure, AmbientEnergy, SkyContribution, BgEnergy, FogDensity, FogLightEnergy, FogHeightDensity,
            FogSkyAffect, VolFogDensity, Glow, Contrast, Saturation, Brightness, SkyEnergy, GroundEnergy,
            Vignette, Grain, Temperature, Tint, LightShafts;
        public Color AmbientColor, BgColor, FogColor, VolFogAlbedo, SkyTop, SkyHorizon, GroundBottom, GroundHorizon;
    }

    Godot.Environment? _known;
    Look _look, _from, _to;
    float _fadeT, _fadeDuration;
    float _mExposure = 1f, _mFog = 1f, _mBloom = 1f, _mContrast = 1f, _mSaturation = 1f;
    bool _dirty;

    public override void _EnterTree() => Current = this;

    public override void _ExitTree()
    {
        if (Current == this) Current = null;
    }

    public override void _Ready()
    {
        // Work on a private copy so runtime changes never leak into the cached .tres.
        if (Environment != null) Environment = (Godot.Environment)Environment.Duplicate(true);
        Adopt(Environment);
    }

    /// <summary>
    /// Cross-fades the running scene to the Environment at <paramref name="resPath"/> over
    /// <paramref name="fadeSeconds"/> (exposure, ambient, fog, sky colors and the screen look blend;
    /// incompatible skies switch under a quick fade to black).
    /// </summary>
    public static bool Switch(string resPath, float fadeSeconds = 2f)
    {
        var path = AigeJson.ResPath(resPath.Trim());
        var target = ResourceLoader.Exists(path) ? ResourceLoader.Load<Godot.Environment>(path) : null;
        if (target == null)
        {
            Log.Error($"Environment '{path}' not found.");
            return false;
        }
        if (Current == null)
        {
            Log.Warn("EnvironmentFx.Switch: the scene has no Environment node.");
            return false;
        }
        Current.CrossFade(target, fadeSeconds);
        return true;
    }

    /// <summary>Grade multipliers from cutscene fx (1 = unchanged). Called by Hud.</summary>
    public void ApplyMultipliers(float exposure, float fog, float bloom, float contrast, float saturation)
    {
        _mExposure = exposure;
        _mFog = fog;
        _mBloom = bloom;
        _mContrast = contrast;
        _mSaturation = saturation;
        _dirty = true;
    }

    void CrossFade(Godot.Environment target, float seconds)
    {
        var from = Environment;
        var work = (Godot.Environment)target.Duplicate(true);
        var toLook = Read(work, target);
        var compatible = from != null && from.BackgroundMode == work.BackgroundMode &&
                         (from.Sky?.SkyMaterial is ProceduralSkyMaterial) == (work.Sky?.SkyMaterial is ProceduralSkyMaterial) &&
                         (from.Sky == null) == (work.Sky == null);
        if (seconds <= 0f)
        {
            Environment = work;
            Adopt(work);
            return;
        }
        if (!compatible)
        {
            Hud.Fade(1f, seconds * 0.4f);
            GetTree().CreateTimer(seconds * 0.45f).Timeout += () =>
            {
                if (!IsInsideTree()) return;
                Environment = work;
                Adopt(work);
                Hud.Fade(0f, seconds * 0.55f);
            };
            return;
        }
        _from = _look;
        _to = toLook;
        _fadeT = 0f;
        _fadeDuration = seconds;
        Environment = work;
        _known = work;
        _look = _from;
        ApplyLightShafts(work, Mathf.Max(_from.LightShafts, _to.LightShafts));
        _dirty = true;
    }

    void Adopt(Godot.Environment? env)
    {
        _known = env;
        Hud.Chromatic = env != null && env.HasMeta("aige_fx") && env.GetMeta("aige_fx").AsGodotDictionary().TryGetValue("chromatic", out var ca)
            ? ca.AsSingle()
            : Chromatic;
        _fadeDuration = 0f;
        if (env == null)
        {
            Hud.SetBaseLook(Vignette, Grain, Temperature, Tint);
            return;
        }
        _look = Read(env, env);
        ApplyLightShafts(env, _look.LightShafts);
        _dirty = true;
    }

    /// <summary>Screen extras from the resource's <c>aige_fx</c> metadata, else this node's properties.</summary>
    (Vector4 fx, float shafts) FxAndShafts(Godot.Environment env)
    {
        if (!env.HasMeta("aige_fx")) return (new Vector4(Vignette, Grain, Temperature, Tint), LightShafts);
        var d = env.GetMeta("aige_fx").AsGodotDictionary();
        float F(string k, float fallback) => d.TryGetValue(k, out var v) ? v.AsSingle() : fallback;
        return (new Vector4(F("vignette", Vignette), F("grain", Grain), F("temperature", Temperature), F("tint", Tint)), F("lightShafts", LightShafts));
    }

    Look Read(Godot.Environment e, Godot.Environment metaSource)
    {
        var (fx, shafts) = FxAndShafts(metaSource);
        var sky = e.Sky?.SkyMaterial as ProceduralSkyMaterial;
        return new Look
        {
            Exposure = e.TonemapExposure,
            AmbientEnergy = e.AmbientLightEnergy,
            AmbientColor = e.AmbientLightColor,
            SkyContribution = e.AmbientLightSkyContribution,
            BgColor = e.BackgroundColor,
            BgEnergy = e.BackgroundEnergyMultiplier,
            FogDensity = e.FogEnabled ? e.FogDensity : 0f,
            FogColor = e.FogLightColor,
            FogLightEnergy = e.FogLightEnergy,
            FogHeightDensity = e.FogHeightDensity,
            FogSkyAffect = e.FogSkyAffect,
            VolFogDensity = e.VolumetricFogEnabled ? e.VolumetricFogDensity : 0f,
            VolFogAlbedo = e.VolumetricFogAlbedo,
            Glow = e.GlowEnabled ? e.GlowIntensity : 0f,
            Contrast = e.AdjustmentEnabled ? e.AdjustmentContrast : 1f,
            Saturation = e.AdjustmentEnabled ? e.AdjustmentSaturation : 1f,
            Brightness = e.AdjustmentEnabled ? e.AdjustmentBrightness : 1f,
            SkyTop = sky?.SkyTopColor ?? default,
            SkyHorizon = sky?.SkyHorizonColor ?? default,
            GroundBottom = sky?.GroundBottomColor ?? default,
            GroundHorizon = sky?.GroundHorizonColor ?? default,
            SkyEnergy = sky?.SkyEnergyMultiplier ?? 1f,
            GroundEnergy = sky?.GroundEnergyMultiplier ?? 1f,
            Vignette = fx.X,
            Grain = fx.Y,
            Temperature = fx.Z,
            Tint = fx.W,
            LightShafts = shafts,
        };
    }

    static Look Lerp(Look a, Look b, float t)
    {
        float L(float x, float y) => Mathf.Lerp(x, y, t);
        Color C(Color x, Color y) => x.Lerp(y, t);
        return new Look
        {
            Exposure = L(a.Exposure, b.Exposure),
            AmbientEnergy = L(a.AmbientEnergy, b.AmbientEnergy),
            AmbientColor = C(a.AmbientColor, b.AmbientColor),
            SkyContribution = L(a.SkyContribution, b.SkyContribution),
            BgColor = C(a.BgColor, b.BgColor),
            BgEnergy = L(a.BgEnergy, b.BgEnergy),
            FogDensity = L(a.FogDensity, b.FogDensity),
            FogColor = C(a.FogColor, b.FogColor),
            FogLightEnergy = L(a.FogLightEnergy, b.FogLightEnergy),
            FogHeightDensity = L(a.FogHeightDensity, b.FogHeightDensity),
            FogSkyAffect = L(a.FogSkyAffect, b.FogSkyAffect),
            VolFogDensity = L(a.VolFogDensity, b.VolFogDensity),
            VolFogAlbedo = C(a.VolFogAlbedo, b.VolFogAlbedo),
            Glow = L(a.Glow, b.Glow),
            Contrast = L(a.Contrast, b.Contrast),
            Saturation = L(a.Saturation, b.Saturation),
            Brightness = L(a.Brightness, b.Brightness),
            SkyTop = C(a.SkyTop, b.SkyTop),
            SkyHorizon = C(a.SkyHorizon, b.SkyHorizon),
            GroundBottom = C(a.GroundBottom, b.GroundBottom),
            GroundHorizon = C(a.GroundHorizon, b.GroundHorizon),
            SkyEnergy = L(a.SkyEnergy, b.SkyEnergy),
            GroundEnergy = L(a.GroundEnergy, b.GroundEnergy),
            Vignette = L(a.Vignette, b.Vignette),
            Grain = L(a.Grain, b.Grain),
            Temperature = L(a.Temperature, b.Temperature),
            Tint = L(a.Tint, b.Tint),
            LightShafts = L(a.LightShafts, b.LightShafts),
        };
    }

    void Write(Godot.Environment e, Look l)
    {
        e.TonemapExposure = l.Exposure * _mExposure;
        e.AmbientLightEnergy = l.AmbientEnergy;
        e.AmbientLightColor = l.AmbientColor;
        e.AmbientLightSkyContribution = l.SkyContribution;
        e.BackgroundColor = l.BgColor;
        e.BackgroundEnergyMultiplier = l.BgEnergy;
        var fog = l.FogDensity * _mFog;
        e.FogEnabled = fog > 1e-5f;
        e.FogDensity = fog;
        e.FogLightColor = l.FogColor;
        e.FogLightEnergy = l.FogLightEnergy;
        e.FogHeightDensity = l.FogHeightDensity;
        e.FogSkyAffect = l.FogSkyAffect;
        var vol = l.VolFogDensity * _mFog;
        e.VolumetricFogEnabled = vol > 1e-5f;
        e.VolumetricFogDensity = vol;
        e.VolumetricFogAlbedo = l.VolFogAlbedo;
        var glow = l.Glow * _mBloom;
        e.GlowEnabled = glow > 1e-4f;
        e.GlowIntensity = glow;
        e.AdjustmentEnabled = true;
        e.AdjustmentContrast = l.Contrast * _mContrast;
        e.AdjustmentSaturation = l.Saturation * _mSaturation;
        e.AdjustmentBrightness = l.Brightness;
        if (e.Sky?.SkyMaterial is ProceduralSkyMaterial sky && l.SkyTop.A > 0f)
        {
            sky.SkyTopColor = l.SkyTop;
            sky.SkyHorizonColor = l.SkyHorizon;
            sky.GroundBottomColor = l.GroundBottom;
            sky.GroundHorizonColor = l.GroundHorizon;
            sky.SkyEnergyMultiplier = l.SkyEnergy;
            sky.GroundEnergyMultiplier = l.GroundEnergy;
        }
        Hud.SetBaseLook(l.Vignette, l.Grain, l.Temperature, l.Tint);
    }

    void ApplyLightShafts(Godot.Environment env, float amount)
    {
        if (amount <= 0f) return;
        if (!env.VolumetricFogEnabled || env.VolumetricFogDensity < 0.004f)
        {
            env.VolumetricFogEnabled = true;
            env.VolumetricFogDensity = 0.004f + 0.012f * amount;
            _look.VolFogDensity = env.VolumetricFogDensity;
        }
        var root = GetTree().CurrentScene ?? GetParent();
        foreach (var light in root.FindChildren("*", "SpotLight3D", true, false))
            if (light is SpotLight3D spot) spot.LightVolumetricFogEnergy = 1f + 4f * amount;
    }

    public override void _Process(double delta)
    {
        if (Environment != _known)
        {
            Adopt(Environment);
            return;
        }
        if (_fadeDuration > 0f)
        {
            _fadeT += (float)delta;
            var t = Easing.Smooth(_fadeT / _fadeDuration);
            _look = Lerp(_from, _to, t);
            if (_fadeT >= _fadeDuration) _fadeDuration = 0f;
            _dirty = true;
        }
        if (_dirty && Environment != null)
        {
            Write(Environment, _look);
            _dirty = false;
        }
    }
}
