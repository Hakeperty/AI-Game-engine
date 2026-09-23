using System;
using System.Collections.Generic;
using Godot;

namespace Aige;

/// <summary>
/// Ambient particles in a box around the entity (AIGE <c>ParticleSystem</c>): 'dust' (motes that
/// only show where light falls), 'rain', 'snow', 'embers', 'fireflies', 'smoke', 'sparks', 'leaves'.
/// Built as GPUParticles3D with soft textures generated in code.
/// <code>GetNode&lt;ParticleSystem&gt;("Bedroom/ParticleSystem").Emitting = false;</code>
/// </summary>
public partial class ParticleSystem : Node3D
{
    /// <summary>Preset name.</summary>
    [Export] public string Preset { get; set; } = "dust";

    /// <summary>Number of particles alive.</summary>
    [Export] public int Count { get; set; } = 300;

    /// <summary>Box size in meters, centered on the entity.</summary>
    [Export] public Vector3 Area { get; set; } = new(4f, 2.5f, 4f);

    /// <summary>Particle color.</summary>
    [Export] public Color Color { get; set; } = new(1f, 0.953f, 0.839f);

    /// <summary>Particle size in meters.</summary>
    [Export] public float Size { get; set; } = 0.02f;

    /// <summary>Speed multiplier.</summary>
    [Export] public float Speed { get; set; } = 1f;

    /// <summary>Opacity 0..1.</summary>
    [Export] public float Opacity { get; set; } = 0.6f;

    static readonly Dictionary<string, Texture2D> Textures = new();

    GpuParticles3D? _particles;

    /// <summary>Turns emission on or off (existing particles finish their life).</summary>
    public bool Emitting
    {
        get => _particles?.Emitting ?? false;
        set
        {
            if (_particles != null) _particles.Emitting = value;
        }
    }

    public override void _Ready() => Build();

    /// <summary>Drops the shared particle textures (called at exit).</summary>
    public static void ClearCache() => Textures.Clear();

    /// <summary>Rebuilds the particles after changing properties.</summary>
    public void Build()
    {
        _particles?.QueueFree();
        var preset = Preset.ToLowerInvariant();
        var area = new Vector3(MathF.Max(0.05f, Area.X), MathF.Max(0.05f, Area.Y), MathF.Max(0.05f, Area.Z));
        var speed = MathF.Max(0.01f, Speed);
        var pm = new ParticleProcessMaterial
        {
            EmissionShape = ParticleProcessMaterial.EmissionShapeEnum.Box,
            EmissionBoxExtents = area / 2f,
            Gravity = Vector3.Zero,
            Spread = 180f,
            ScaleMin = 0.6f,
            ScaleMax = 1.4f,
        };
        var mat = new StandardMaterial3D
        {
            BillboardMode = BaseMaterial3D.BillboardModeEnum.Particles,
            BillboardKeepScale = true,
            Transparency = BaseMaterial3D.TransparencyEnum.Alpha,
            VertexColorUseAsAlbedo = true,
            AlbedoColor = new Color(Color, Opacity),
            ShadingMode = BaseMaterial3D.ShadingModeEnum.Unshaded,
            CullMode = BaseMaterial3D.CullModeEnum.Disabled,
        };
        var quad = new QuadMesh { Size = new Vector2(Size, Size) };
        var lifetime = 6.0;
        var offset = Vector3.Zero;

        switch (preset)
        {
            case "rain":
            {
                var fall = 9f * speed;
                lifetime = area.Y / fall;
                pm.EmissionBoxExtents = new Vector3(area.X / 2f, 0.02f, area.Z / 2f);
                offset.Y = area.Y / 2f;
                pm.Direction = Vector3.Down;
                pm.Spread = 2f;
                pm.InitialVelocityMin = fall * 0.9f;
                pm.InitialVelocityMax = fall * 1.1f;
                pm.ParticleFlagAlignY = true;
                mat.BillboardMode = BaseMaterial3D.BillboardModeEnum.FixedY;
                mat.AlbedoTexture = Texture("streak");
                quad.Size = new Vector2(Size * 0.6f, MathF.Max(0.25f, Size * 18f));
                pm.ColorRamp = Ramp(0.05f, 0.9f);
                break;
            }
            case "snow":
            {
                var fall = 0.6f * speed;
                lifetime = area.Y / fall;
                pm.EmissionBoxExtents = new Vector3(area.X / 2f, 0.02f, area.Z / 2f);
                offset.Y = area.Y / 2f;
                pm.Direction = Vector3.Down;
                pm.Spread = 15f;
                pm.InitialVelocityMin = fall * 0.8f;
                pm.InitialVelocityMax = fall * 1.2f;
                Turbulence(pm, 0.35f * speed, 1.2f, 0.08f);
                mat.AlbedoTexture = Texture("dot");
                pm.ColorRamp = Ramp(0.08f, 0.9f);
                break;
            }
            case "embers":
                lifetime = 3.5 / speed;
                pm.EmissionBoxExtents = new Vector3(area.X / 2f, area.Y * 0.1f, area.Z / 2f);
                offset.Y = -area.Y * 0.4f;
                pm.Direction = Vector3.Up;
                pm.Spread = 25f;
                pm.InitialVelocityMin = 0.3f * speed;
                pm.InitialVelocityMax = 0.8f * speed;
                pm.Gravity = new Vector3(0, 0.4f * speed, 0);
                Turbulence(pm, 1.2f * speed, 0.8f, 0.15f);
                mat.BlendMode = BaseMaterial3D.BlendModeEnum.Add;
                mat.AlbedoTexture = Texture("dot");
                pm.ColorRamp = Ramp(0.05f, 0.5f, new Color(1f, 0.55f, 0.18f), new Color(0.6f, 0.08f, 0.02f));
                break;
            case "fireflies":
                lifetime = 7.0 / speed;
                pm.InitialVelocityMin = 0.02f;
                pm.InitialVelocityMax = 0.12f * speed;
                Turbulence(pm, 0.6f * speed, 1.5f, 0.12f);
                mat.BlendMode = BaseMaterial3D.BlendModeEnum.Add;
                mat.AlbedoTexture = Texture("glow");
                pm.ColorRamp = Pulse();
                break;
            case "smoke":
                lifetime = 7.0 / speed;
                pm.EmissionBoxExtents = new Vector3(area.X * 0.3f, area.Y * 0.05f, area.Z * 0.3f);
                offset.Y = -area.Y * 0.4f;
                pm.Direction = Vector3.Up;
                pm.Spread = 12f;
                pm.InitialVelocityMin = 0.2f * speed;
                pm.InitialVelocityMax = 0.45f * speed;
                pm.Gravity = new Vector3(0, 0.05f * speed, 0);
                pm.DampingMin = 0.05f;
                pm.DampingMax = 0.15f;
                pm.AngleMin = -180f;
                pm.AngleMax = 180f;
                pm.AngularVelocityMin = -12f;
                pm.AngularVelocityMax = 12f;
                pm.ScaleCurve = Curve(0.35f, 1.6f);
                Turbulence(pm, 0.4f * speed, 2f, 0.06f);
                quad.Size = new Vector2(MathF.Max(Size, 0.02f) * 25f, MathF.Max(Size, 0.02f) * 25f);
                mat.ShadingMode = BaseMaterial3D.ShadingModeEnum.PerPixel;
                mat.ProximityFadeEnabled = true;
                mat.ProximityFadeDistance = 0.6f;
                mat.AlbedoTexture = Texture("smoke");
                pm.ColorRamp = Ramp(0.15f, 0.55f);
                break;
            case "sparks":
                lifetime = 0.9 / speed;
                pm.EmissionShape = ParticleProcessMaterial.EmissionShapeEnum.Sphere;
                pm.EmissionSphereRadius = MathF.Min(area.X, area.Z) * 0.05f;
                pm.Direction = Vector3.Up;
                pm.Spread = 55f;
                pm.InitialVelocityMin = 1.5f * speed;
                pm.InitialVelocityMax = 3.5f * speed;
                pm.Gravity = new Vector3(0, -9.8f, 0);
                pm.ParticleFlagAlignY = true;
                mat.BillboardMode = BaseMaterial3D.BillboardModeEnum.FixedY;
                mat.BlendMode = BaseMaterial3D.BlendModeEnum.Add;
                mat.AlbedoTexture = Texture("streak");
                quad.Size = new Vector2(Size * 0.8f, Size * 6f);
                pm.ColorRamp = Ramp(0.0f, 0.4f, new Color(1f, 0.85f, 0.5f), new Color(1f, 0.35f, 0.05f));
                break;
            case "leaves":
                lifetime = 8.0 / speed;
                pm.EmissionBoxExtents = new Vector3(area.X / 2f, 0.05f, area.Z / 2f);
                offset.Y = area.Y / 2f;
                pm.Direction = Vector3.Down;
                pm.Spread = 30f;
                pm.InitialVelocityMin = 0.1f * speed;
                pm.InitialVelocityMax = 0.3f * speed;
                pm.Gravity = new Vector3(0, -0.35f * speed, 0);
                pm.AngleMin = -180f;
                pm.AngleMax = 180f;
                pm.AngularVelocityMin = -90f;
                pm.AngularVelocityMax = 90f;
                Turbulence(pm, 1.1f * speed, 1.4f, 0.2f);
                quad.Size = new Vector2(MathF.Max(Size, 0.02f) * 3f, MathF.Max(Size, 0.02f) * 3f);
                mat.ShadingMode = BaseMaterial3D.ShadingModeEnum.PerPixel;
                mat.Transparency = BaseMaterial3D.TransparencyEnum.AlphaScissor;
                mat.AlphaScissorThreshold = 0.4f;
                mat.AlbedoTexture = Texture("leaf");
                pm.ColorRamp = Ramp(0.03f, 0.92f);
                break;
            default: // dust: lit (and shadowed) motes that drift slowly; they glow in light beams only.
                lifetime = 10.0 / speed;
                pm.InitialVelocityMin = 0f;
                pm.InitialVelocityMax = 0.03f * speed;
                pm.Gravity = new Vector3(0, -0.004f * speed, 0);
                Turbulence(pm, 0.25f * speed, 1.8f, 0.03f);
                mat.ShadingMode = BaseMaterial3D.ShadingModeEnum.PerPixel;
                mat.BacklightEnabled = true;
                mat.Backlight = new Color(1, 1, 1);
                mat.Roughness = 1f;
                mat.DisableAmbientLight = true; // visible only where real light falls
                mat.AlbedoTexture = Texture("dot");
                pm.ColorRamp = Ramp(0.2f, 0.8f);
                break;
        }

        quad.Material = mat;
        _particles = new GpuParticles3D
        {
            Name = "Particles",
            Amount = Math.Max(1, Count),
            Lifetime = Math.Max(0.1, lifetime),
            Preprocess = Math.Max(0.1, lifetime),
            ProcessMaterial = pm,
            DrawPass1 = quad,
            Position = offset,
            VisibilityAabb = new Aabb(-area / 2f - offset - Vector3.One, area + Vector3.One * 2f),
            CastShadow = GeometryInstance3D.ShadowCastingSetting.Off,
        };
        AddChild(_particles);
    }

    static void Turbulence(ParticleProcessMaterial pm, float strength, float scale, float influence)
    {
        pm.TurbulenceEnabled = true;
        pm.TurbulenceNoiseStrength = strength;
        pm.TurbulenceNoiseScale = scale;
        pm.TurbulenceNoiseSpeedRandom = 0.2f;
        pm.TurbulenceInfluenceMin = influence * 0.5f;
        pm.TurbulenceInfluenceMax = influence;
    }

    /// <summary>Alpha fade in over [0, fadeIn] and out over [fadeOut, 1] of the lifetime.</summary>
    static GradientTexture1D Ramp(float fadeIn, float fadeOut, Color? from = null, Color? to = null)
    {
        var a = from ?? Colors.White;
        var b = to ?? a;
        var g = new Gradient();
        g.SetColor(0, new Color(a, 0f));
        g.SetOffset(0, 0f);
        g.SetColor(1, new Color(b, 0f));
        g.SetOffset(1, 1f);
        g.AddPoint(Mathf.Max(0.001f, fadeIn), new Color(a.Lerp(b, fadeIn), 1f));
        g.AddPoint(Mathf.Min(0.999f, fadeOut), new Color(a.Lerp(b, fadeOut), 1f));
        return new GradientTexture1D { Gradient = g };
    }

    /// <summary>Slow glow pulses for fireflies.</summary>
    static GradientTexture1D Pulse()
    {
        var g = new Gradient();
        g.SetColor(0, new Color(1, 1, 1, 0));
        g.SetColor(1, new Color(1, 1, 1, 0));
        float[] on = { 0.12f, 0.2f, 0.45f, 0.55f, 0.78f, 0.86f };
        for (var i = 0; i < on.Length; i += 2)
        {
            g.AddPoint(on[i], new Color(1, 1, 1, 1));
            g.AddPoint(on[i + 1], new Color(1, 1, 1, 0.05f));
        }
        return new GradientTexture1D { Gradient = g };
    }

    static CurveTexture Curve(float start, float end)
    {
        var c = new Curve();
        c.AddPoint(new Vector2(0, start));
        c.AddPoint(new Vector2(1, end));
        return new CurveTexture { Curve = c };
    }

    /// <summary>Soft particle textures, generated once.</summary>
    static Texture2D Texture(string kind)
    {
        if (Textures.TryGetValue(kind, out var t)) return t;
        const int n = 64;
        var img = Image.CreateEmpty(n, n, false, Image.Format.Rgba8);
        var noise = new FastNoiseLite { Frequency = 0.08f, Seed = 7 };
        for (var y = 0; y < n; y++)
        for (var x = 0; x < n; x++)
        {
            var u = (x + 0.5f) / n * 2f - 1f;
            var v = (y + 0.5f) / n * 2f - 1f;
            var r = MathF.Sqrt(u * u + v * v);
            float a;
            var c = 1f;
            switch (kind)
            {
                case "streak":
                    a = MathF.Max(0f, 1f - MathF.Abs(u) * 1.2f) * MathF.Max(0f, 1f - MathF.Abs(v));
                    a *= a;
                    break;
                case "glow":
                    a = MathF.Exp(-r * r * 5f) + 0.9f * MathF.Exp(-r * r * 60f);
                    break;
                case "smoke":
                    var nn = noise.GetNoise2D(x, y) * 0.5f + 0.5f;
                    a = MathF.Max(0f, 1f - r) * (0.55f + 0.45f * nn);
                    a = a * a * (3f - 2f * a);
                    break;
                case "leaf":
                    var ex = u / 0.45f;
                    var ey = v / 0.95f;
                    a = ex * ex + ey * ey <= 1f ? 1f : 0f;
                    c = MathF.Abs(u) < 0.04f ? 0.6f : 0.85f + 0.15f * (noise.GetNoise2D(x * 3, y * 3) * 0.5f + 0.5f);
                    break;
                default:
                    a = MathF.Max(0f, 1f - r);
                    a = a * a * (3f - 2f * a);
                    break;
            }
            img.SetPixel(x, y, new Color(c, c, c, Mathf.Clamp(a, 0f, 1f)));
        }
        img.GenerateMipmaps();
        t = ImageTexture.CreateFromImage(img);
        Textures[kind] = t;
        return t;
    }
}
