#nullable enable
using System.Collections;
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.Rendering.Universal;

namespace Aige
{
    /// <summary>
    /// One AIGE Environment component: the look (URP Volume profile), sky, fog and ambient light. The importer
    /// fills it and builds <see cref="Profile"/>; <see cref="EnvironmentFx"/> applies the active one.
    /// </summary>
    [DisallowMultipleComponent]
    public sealed class AigeEnvironment : MonoBehaviour
    {
        public VolumeProfile? Profile;
        public Material? Skybox;
        public Color Background = new Color(0.1f, 0.12f, 0.16f);
        public Color FogColor = new Color(0.1f, 0.12f, 0.16f);
        public float FogDensity;
        public float Ambient = 1f;
        public float SkyEnergy = 1f;
        public Color AmbientColor = new Color(0.13f, 0.14f, 0.17f);
        /// <summary>Trilight ambient sampled from the sky (the importer averages the HDRI); used when <see cref="Trilight"/>.</summary>
        public bool Trilight;
        public Color AmbientSky = Color.gray, AmbientEquator = Color.gray, AmbientGround = Color.black;
        public string ToneMapping = "aces";
        public float Exposure = 1f;
        public float Contrast = 1.05f;
        public float Saturation = 1f;
        public float Bloom = 0.25f;
        public float BloomThreshold = 0.9f;
        public float Vignette = 0.25f;
        public float Grain = 0.12f;
        public float Temperature;
        public float Tint;
        public float ChromaticAberration;
        public float Ssao = 0.8f;
        public float SsaoRadius = 0.35f;
        public Vector3 SunDirection = new Vector3(0.4f, 0.45f, -0.8f);

        /// <summary>A Volume profile with this environment's post-processing (tonemapping, grade, bloom, lens).</summary>
        public VolumeProfile BuildProfile()
        {
            var p = ScriptableObject.CreateInstance<VolumeProfile>();
            p.name = name;
            var tm = p.Add<Tonemapping>(true);
            tm.mode.value = ToneMapping == "none" ? TonemappingMode.None : ToneMapping == "neutral" ? TonemappingMode.Neutral : TonemappingMode.ACES;
            var ca = p.Add<ColorAdjustments>(true);
            ca.postExposure.value = Mathf.Log(Mathf.Max(0.01f, Exposure), 2f);
            ca.contrast.value = Mathf.Clamp((Contrast - 1f) * 100f, -100f, 100f);
            ca.saturation.value = Mathf.Clamp((Saturation - 1f) * 100f, -100f, 100f);
            ca.colorFilter.overrideState = false;
            ca.hueShift.overrideState = false;
            var bloom = p.Add<UnityEngine.Rendering.Universal.Bloom>(true);
            bloom.intensity.value = Bloom * 1.2f;
            bloom.threshold.value = BloomThreshold;
            bloom.scatter.value = 0.65f;
            bloom.highQualityFiltering.value = true;
            foreach (var param in new VolumeParameter[] { bloom.tint, bloom.clamp, bloom.dirtTexture, bloom.dirtIntensity, bloom.filter, bloom.downscale, bloom.maxIterations })
                param.overrideState = false;
            var v = p.Add<UnityEngine.Rendering.Universal.Vignette>(true);
            v.intensity.value = Mathf.Clamp01(Vignette * 0.7f);
            v.smoothness.value = 0.45f;
            v.center.overrideState = false;
            var g = p.Add<FilmGrain>(true);
            g.type.value = FilmGrainLookup.Medium2;
            g.intensity.value = Mathf.Clamp01(Grain);
            g.response.value = 0.75f;
            g.texture.overrideState = false;
            var wb = p.Add<WhiteBalance>(true);
            wb.temperature.value = Mathf.Clamp(Temperature, -1f, 1f) * 40f;
            wb.tint.value = Mathf.Clamp(Tint, -1f, 1f) * 40f;
            var chroma = p.Add<UnityEngine.Rendering.Universal.ChromaticAberration>(true);
            chroma.intensity.value = Mathf.Clamp01(ChromaticAberration);
            return p;
        }

        /// <summary>Applies sky, ambient light and fog to RenderSettings (fog scaled by <paramref name="fogMul"/>).</summary>
        public void ApplyRenderSettings(float fogMul = 1f)
        {
            RenderSettings.skybox = Skybox;
            if (Trilight)
            {
                RenderSettings.ambientMode = AmbientMode.Trilight;
                var k = Ambient * AigeLights.AmbientScale;
                RenderSettings.ambientSkyColor = AmbientSky * k;
                RenderSettings.ambientEquatorColor = AmbientEquator * k;
                RenderSettings.ambientGroundColor = AmbientGround * k;
            }
            else if (Skybox != null)
            {
                RenderSettings.ambientMode = AmbientMode.Skybox;
                RenderSettings.ambientIntensity = Ambient;
            }
            else
            {
                RenderSettings.ambientMode = AmbientMode.Flat;
                RenderSettings.ambientLight = AmbientColor * Ambient;
            }
            RenderSettings.fog = FogDensity > 0f;
            RenderSettings.fogMode = FogMode.Exponential;
            RenderSettings.fogColor = FogColor;
            RenderSettings.fogDensity = FogDensity * fogMul;
        }
    }

    /// <summary>
    /// The scene's active look (root 'Environment' object with a global Volume). Switch at runtime with
    /// <c>EnvironmentFx.Switch("Environment_Morning", 4f)</c> or the cutscene event <c>emit: "env:Environment_Morning"</c>
    /// (Godot paths like 'env:res://godot/environments/house-Environment_Morning.tres' work too).
    /// </summary>
    [DisallowMultipleComponent]
    public sealed class EnvironmentFx : MonoBehaviour
    {
        public AigeEnvironment? Active;

        public static EnvironmentFx? Current { get; private set; }

        Volume _main = null!, _fade = null!;
        VolumeProfile? _runtime;
        float _mExposure = 1f, _mFog = 1f, _mBloom = 1f, _mContrast = 1f, _mSaturation = 1f;
        Coroutine? _switch;

        void Awake()
        {
            Current = this;
            _main = GetComponent<Volume>();
            if (_main == null) _main = gameObject.AddComponent<Volume>();
            _main.isGlobal = true;
            var fadeGo = new GameObject("EnvironmentFade");
            fadeGo.transform.SetParent(transform, false);
            _fade = fadeGo.AddComponent<Volume>();
            _fade.isGlobal = true;
            _fade.priority = _main.priority + 1;
            _fade.weight = 0f;
            Adopt(Active);
        }

        void OnDestroy()
        {
            if (Current == this) Current = null;
        }

        void Adopt(AigeEnvironment? env)
        {
            Active = env;
            if (env == null)
            {
                Hud.SetBaseLook(0.25f, 0.12f, 0f, 0f);
                return;
            }
            _runtime = env.Profile != null ? Instantiate(env.Profile) : env.BuildProfile();
            _main.sharedProfile = _runtime;
            env.ApplyRenderSettings(_mFog);
            DynamicGI.UpdateEnvironment();
            Hud.SetBaseLook(env.Vignette, env.Grain, env.Temperature, env.Tint);
            ApplyMultipliers(_mExposure, _mFog, _mBloom, _mContrast, _mSaturation);
        }

        /// <summary>Finds an environment by entity name, id or exported path ('house-Environment_Morning.tres').</summary>
        public static AigeEnvironment? Find(string reference)
        {
            var r = reference.Trim().Replace('\\', '/');
            r = r.Substring(r.LastIndexOf('/') + 1);
            var dot = r.LastIndexOf('.');
            if (dot > 0) r = r.Substring(0, dot);
            var all = FindObjectsByType<AigeEnvironment>(FindObjectsInactive.Include, FindObjectsSortMode.None);
            foreach (var e in all)
                {
                var ent = e.GetComponent<AigeEntity>();
                if (e.name == r || (ent != null && ent.Id == r)) return e;
            }
            var dash = r.IndexOf('-');
            if (dash >= 0)
            {
                var tail = r.Substring(dash + 1);
                foreach (var e in all)
                    if (e.name == tail) return e;
            }
            return null;
        }

        /// <summary>Cross-fades to another Environment over <paramref name="fadeSeconds"/>.</summary>
        public static bool Switch(string reference, float fadeSeconds = 2f)
        {
            var env = Find(reference);
            if (env == null)
            {
                Log.Error($"Environment '{reference}' not found (use the Environment entity's name).");
                return false;
            }
            if (Current == null)
            {
                Log.Warn("EnvironmentFx.Switch: the scene has no Environment object.");
                return false;
            }
            if (Current._switch != null) Current.StopCoroutine(Current._switch);
            Current._switch = Current.StartCoroutine(Current.CrossFade(env, fadeSeconds));
            return true;
        }

        IEnumerator CrossFade(AigeEnvironment to, float seconds)
        {
            var from = Active;
            if (from == null || seconds <= 0f)
            {
                Adopt(to);
                yield break;
            }
            var target = to.Profile != null ? Instantiate(to.Profile) : to.BuildProfile();
            _fade.sharedProfile = target;
            var skySwapped = false;
            for (var t = 0f; t < seconds; t += Time.deltaTime)
            {
                var x = Easing.Smooth(t / seconds);
                _fade.weight = x;
                RenderSettings.fogColor = Color.Lerp(from.FogColor, to.FogColor, x);
                RenderSettings.fogDensity = Mathf.Lerp(from.FogDensity, to.FogDensity, x) * _mFog;
                RenderSettings.fog = RenderSettings.fogDensity > 0f;
                if (from.Trilight && to.Trilight)
                {
                    float ka = from.Ambient * AigeLights.AmbientScale, kb = to.Ambient * AigeLights.AmbientScale;
                    RenderSettings.ambientSkyColor = Color.Lerp(from.AmbientSky * ka, to.AmbientSky * kb, x);
                    RenderSettings.ambientEquatorColor = Color.Lerp(from.AmbientEquator * ka, to.AmbientEquator * kb, x);
                    RenderSettings.ambientGroundColor = Color.Lerp(from.AmbientGround * ka, to.AmbientGround * kb, x);
                }
                else RenderSettings.ambientIntensity = Mathf.Lerp(from.Ambient, to.Ambient, x);
                Hud.SetBaseLook(Mathf.Lerp(from.Vignette, to.Vignette, x), Mathf.Lerp(from.Grain, to.Grain, x),
                    Mathf.Lerp(from.Temperature, to.Temperature, x), Mathf.Lerp(from.Tint, to.Tint, x));
                if (!skySwapped && x >= 0.5f)
                {
                    skySwapped = true;
                    RenderSettings.skybox = to.Skybox;
                    DynamicGI.UpdateEnvironment();
                }
                yield return null;
            }
            _fade.weight = 0f;
            _fade.sharedProfile = null;
            Adopt(to);
            _switch = null;
        }

        /// <summary>Grade multipliers from Hud.Fx (exposure, fog, bloom, contrast, saturation; 1 = unchanged).</summary>
        public void ApplyMultipliers(float exposure, float fog, float bloom, float contrast, float saturation)
        {
            _mExposure = exposure;
            _mFog = fog;
            _mBloom = bloom;
            _mContrast = contrast;
            _mSaturation = saturation;
            var env = Active;
            if (env == null || _runtime == null) return;
            if (_runtime.TryGet<ColorAdjustments>(out var ca))
            {
                ca.postExposure.value = Mathf.Log(Mathf.Max(0.01f, env.Exposure * exposure), 2f);
                ca.contrast.value = Mathf.Clamp((env.Contrast * contrast - 1f) * 100f, -100f, 100f);
                ca.saturation.value = Mathf.Clamp((env.Saturation * saturation - 1f) * 100f, -100f, 100f);
            }
            if (_runtime.TryGet<UnityEngine.Rendering.Universal.Bloom>(out var b)) b.intensity.value = env.Bloom * 1.2f * bloom;
            if (_switch == null) RenderSettings.fogDensity = env.FogDensity * fog;
        }
    }
}
