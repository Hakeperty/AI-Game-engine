#nullable enable
using UnityEngine;

namespace Aige
{
    /// <summary>
    /// AIGE ParticleSystem presets as a Unity ParticleSystem filling the <see cref="Area"/> box around the entity:
    /// dust (motes in light), rain, snow, embers, fireflies, smoke, sparks, leaves.
    /// </summary>
    [DisallowMultipleComponent]
    public sealed class AigeParticles : MonoBehaviour
    {
        public string Preset = "dust";
        public int Count = 300;
        /// <summary>Box size in meters.</summary>
        public Vector3 Area = new Vector3(4, 3, 4);
        public Color Color = Color.white;
        /// <summary>Particle size in meters.</summary>
        public float Size = 0.02f;
        public float Speed = 1f;
        public float Opacity = 0.6f;
        public bool Emitting = true;
        /// <summary>Particle material (the importer assigns a URP particle material).</summary>
        public Material? Material;

        UnityEngine.ParticleSystem? _ps;
        static Texture2D? _dot;

        public UnityEngine.ParticleSystem? System => _ps;

        void Start() => Build();

        /// <summary>(Re)builds the particle system from the fields.</summary>
        public void Build()
        {
            if (_ps == null)
            {
                var go = new GameObject("Particles");
                go.transform.SetParent(transform, false);
                _ps = go.AddComponent<UnityEngine.ParticleSystem>();
                _ps.Stop(true, UnityEngine.ParticleSystem.ParticleSystemStopBehavior.StopEmittingAndClear);
            }
            var ps = _ps;
            var main = ps.main;
            var emission = ps.emission;
            var shape = ps.shape;
            var vel = ps.velocityOverLifetime;
            var noise = ps.noise;
            var col = ps.colorOverLifetime;
            main.playOnAwake = false;
            main.loop = true;
            main.maxParticles = Mathf.Max(1, Count);
            main.simulationSpace = ParticleSystemSimulationSpace.World;
            main.startColor = new Color(Color.r, Color.g, Color.b, Opacity);
            main.startSize = new UnityEngine.ParticleSystem.MinMaxCurve(Size * 0.6f, Size * 1.4f);
            main.gravityModifier = 0f;
            shape.enabled = true;
            shape.shapeType = ParticleSystemShapeType.Box;
            shape.scale = new Vector3(Mathf.Abs(Area.x), Mathf.Abs(Area.y), Mathf.Abs(Area.z));
            vel.enabled = false;
            noise.enabled = false;
            var lifetime = 6f;
            switch (Preset)
            {
                case "rain":
                    lifetime = 1.2f;
                    main.startSpeed = 0f;
                    vel.enabled = true;
                    vel.space = ParticleSystemSimulationSpace.World;
                    vel.y = new UnityEngine.ParticleSystem.MinMaxCurve(-9f * Speed);
                    vel.x = new UnityEngine.ParticleSystem.MinMaxCurve(0f);
                    vel.z = new UnityEngine.ParticleSystem.MinMaxCurve(0f);
                    break;
                case "snow":
                case "leaves":
                    lifetime = 8f;
                    main.startSpeed = 0f;
                    vel.enabled = true;
                    vel.space = ParticleSystemSimulationSpace.World;
                    vel.y = new UnityEngine.ParticleSystem.MinMaxCurve(-0.6f * Speed);
                    vel.x = new UnityEngine.ParticleSystem.MinMaxCurve(0f);
                    vel.z = new UnityEngine.ParticleSystem.MinMaxCurve(0f);
                    noise.enabled = true;
                    noise.strength = 0.4f * Speed;
                    noise.frequency = 0.4f;
                    break;
                case "embers":
                case "sparks":
                    lifetime = Preset == "sparks" ? 0.8f : 3f;
                    main.startSpeed = new UnityEngine.ParticleSystem.MinMaxCurve(0.2f * Speed, 1.2f * Speed);
                    main.gravityModifier = Preset == "sparks" ? 0.6f : -0.05f;
                    noise.enabled = true;
                    noise.strength = 0.3f;
                    break;
                case "smoke":
                    lifetime = 6f;
                    main.startSpeed = new UnityEngine.ParticleSystem.MinMaxCurve(0.05f * Speed, 0.25f * Speed);
                    main.gravityModifier = -0.02f;
                    main.startSize = new UnityEngine.ParticleSystem.MinMaxCurve(Size * 10f, Size * 30f);
                    break;
                case "fireflies":
                    lifetime = 5f;
                    main.startSpeed = 0f;
                    noise.enabled = true;
                    noise.strength = 0.25f * Speed;
                    noise.frequency = 0.3f;
                    break;
                default: // dust motes drifting in the light
                    lifetime = 10f;
                    main.startSpeed = new UnityEngine.ParticleSystem.MinMaxCurve(0f, 0.02f * Speed);
                    noise.enabled = true;
                    noise.strength = 0.05f * Speed;
                    noise.frequency = 0.25f;
                    noise.scrollSpeed = 0.05f;
                    break;
            }
            main.startLifetime = new UnityEngine.ParticleSystem.MinMaxCurve(lifetime * 0.7f, lifetime);
            emission.rateOverTime = Count / lifetime;
            col.enabled = true;
            var grad = new Gradient();
            grad.SetKeys(
                new[] { new GradientColorKey(Color.white, 0f), new GradientColorKey(Color.white, 1f) },
                new[] { new GradientAlphaKey(0f, 0f), new GradientAlphaKey(1f, 0.15f), new GradientAlphaKey(1f, 0.8f), new GradientAlphaKey(0f, 1f) });
            col.color = grad;

            var r = ps.GetComponent<ParticleSystemRenderer>();
            r.renderMode = Preset == "rain" ? ParticleSystemRenderMode.Stretch : ParticleSystemRenderMode.Billboard;
            if (Preset == "rain") r.velocityScale = 0.02f;
            r.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
            r.receiveShadows = false;
            r.sharedMaterial = Material != null ? Material : DefaultMaterial();

            if (Emitting)
            {
                ps.Simulate(lifetime, true, true);
                ps.Play(true);
            }
        }

        static Material DefaultMaterial()
        {
            var shader = Shader.Find("Universal Render Pipeline/Particles/Unlit") ?? Shader.Find("Sprites/Default");
            var m = new Material(shader);
            if (_dot == null)
            {
                const int n = 32;
                _dot = new Texture2D(n, n, TextureFormat.RGBA32, false);
                for (var y = 0; y < n; y++)
                for (var x = 0; x < n; x++)
                {
                    var d = Vector2.Distance(new Vector2(x + 0.5f, y + 0.5f), new Vector2(n / 2f, n / 2f)) / (n / 2f);
                    _dot.SetPixel(x, y, new Color(1, 1, 1, Mathf.Clamp01(1f - d) * Mathf.Clamp01(1f - d)));
                }
                _dot.Apply();
            }
            m.mainTexture = _dot;
            if (m.HasProperty("_BaseMap")) m.SetTexture("_BaseMap", _dot);
            if (m.HasProperty("_Surface"))
            {
                m.SetFloat("_Surface", 1f);
                m.SetFloat("_Blend", 0f);
                m.SetOverrideTag("RenderType", "Transparent");
                m.SetFloat("_SrcBlend", (float)UnityEngine.Rendering.BlendMode.SrcAlpha);
                m.SetFloat("_DstBlend", (float)UnityEngine.Rendering.BlendMode.OneMinusSrcAlpha);
                m.SetFloat("_ZWrite", 0f);
                m.EnableKeyword("_SURFACE_TYPE_TRANSPARENT");
                m.renderQueue = 3000;
            }
            return m;
        }

        public void SetEmitting(bool on)
        {
            Emitting = on;
            if (_ps == null) return;
            if (on) _ps.Play(true);
            else _ps.Stop(true, UnityEngine.ParticleSystem.ParticleSystemStopBehavior.StopEmitting);
        }
    }
}
