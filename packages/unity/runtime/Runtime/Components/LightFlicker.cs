#nullable enable
using System.Collections;
using System.Collections.Generic;
using UnityEngine;

namespace Aige
{
    /// <summary>
    /// Flickers the Light on the same GameObject (AIGE Light.flicker): 0 = steady, 1 = a dying bulb.
    /// Cutscene light tweens drive <see cref="BaseEnergy"/>/<see cref="BaseColor"/>.
    /// <code>LightFlicker.Lightning();   // flash every light tagged 'Lightning', flash the screen, thunder</code>
    /// </summary>
    [RequireComponent(typeof(Light))]
    public sealed class LightFlicker : MonoBehaviour
    {
        [Range(0, 1)] public float Amount = 0.3f;
        public float Rate = 1f;
        /// <summary>Intensity without flicker (negative = the light's intensity at start).</summary>
        public float BaseEnergy = -1f;
        /// <summary>Color without flicker (alpha 0 = the light's color at start).</summary>
        public Color BaseColor = new Color(1, 1, 1, 0);

        readonly List<(float start, float peak, float duration)> _flashes = new List<(float, float, float)>();
        Light _light = null!;
        float _clock, _dropTimer = 2f, _drop, _dropDepth = 1f, _seed;

        public Light Light => _light;

        public static LightFlicker? Of(Light? light) => light == null ? null : light.GetComponent<LightFlicker>();

        void Awake()
        {
            _light = GetComponent<Light>();
            if (BaseEnergy < 0f) BaseEnergy = _light.intensity;
            if (BaseColor.a <= 0f) BaseColor = _light.color;
            _seed = Random.value * 100f;
        }

        void Update()
        {
            var dt = Time.deltaTime;
            _clock += dt;
            var t = _clock * Rate;
            var f = 1f;
            if (Amount > 0f)
            {
                var slow = Mathf.PerlinNoise(_seed, t * 2.3f);
                var fast = Mathf.PerlinNoise(_seed + 37f, t * 17f);
                f = 1f - Amount * (0.38f * slow + 0.2f * fast);
                if (Amount > 0.45f)
                {
                    _dropTimer -= dt;
                    if (_dropTimer <= 0f)
                    {
                        _dropTimer = Random.Range(0.6f, 7f / Amount);
                        _drop = Random.Range(0.04f, 0.22f);
                        _dropDepth = Mathf.Lerp(0.7f, 0.05f, (Amount - 0.45f) / 0.55f);
                    }
                    if (_drop > 0f)
                    {
                        _drop -= dt;
                        f *= _dropDepth;
                    }
                }
            }
            _light.intensity = Mathf.Max(0f, BaseEnergy * f + FlashEnergy());
            _light.color = BaseColor;
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
            return u >= 0f && u <= 1f ? Mathf.Sin(u * Mathf.PI) : 0f;
        }

        /// <summary>Lightning intensity pattern over x = 0..1 (a strike and two after-flashes).</summary>
        public static float FlashPattern(float x) =>
            x < 0f ? 0f : Mathf.Max(Mathf.Exp(-x * 9f), Mathf.Max(0.7f * Bump(x, 0.16f, 0.12f), 0.35f * Bump(x, 0.4f, 0.14f)));

        public void Flash(float intensity = 8f, float duration = 0.8f) => _flashes.Add((_clock, intensity, Mathf.Max(0.05f, duration)));

        /// <summary>Flashes any light (with or without a LightFlicker).</summary>
        public static void FlashLight(Light light, float intensity = 8f, float duration = 0.8f)
        {
            var lf = Of(light);
            if (lf != null)
            {
                lf.Flash(intensity, duration);
                return;
            }
            var runner = Story.Instance;
            if (runner != null) runner.StartCoroutine(FlashRoutine(light, intensity, Mathf.Max(0.05f, duration)));
        }

        static IEnumerator FlashRoutine(Light light, float intensity, float duration)
        {
            var baseEnergy = light.intensity;
            for (var t = 0f; t < duration && light != null; t += Time.deltaTime)
            {
                light.intensity = baseEnergy + intensity * FlashPattern(t / duration);
                yield return null;
            }
            if (light != null) light.intensity = baseEnergy;
        }

        /// <summary>Flashes every light tagged <paramref name="tag"/>, flashes the screen, then plays thunder and shakes.</summary>
        public static void Lightning(float intensity = 8f, float duration = 0.8f, string? thunder = "thunder", float thunderDelay = 1.2f, string tag = "Lightning")
        {
            foreach (var e in Entities.Tagged(tag))
            {
                var light = e.GetComponentInChildren<Light>(true);
                if (light != null) FlashLight(light, intensity, duration);
            }
            Hud.Flash(0.55f, duration);
            if (string.IsNullOrEmpty(thunder) || Story.Instance == null) return;
            Story.Instance.StartCoroutine(Thunder(thunder!, thunderDelay));
        }

        static IEnumerator Thunder(string sound, float delay)
        {
            if (delay > 0f) yield return new WaitForSeconds(delay);
            Sfx.Play(sound);
            Hud.Shake(0.35f, 1.2f);
        }
    }
}
