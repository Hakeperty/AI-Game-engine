#nullable enable
using System;
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.Rendering.Universal;
using UnityEngine.UI;

namespace Aige
{
    /// <summary>
    /// The HUD: subtitles, interaction prompt, objective + waypoint, fades, letterbox, and screen effects
    /// (vignette, grain, blur, darken, desaturate, flash, shake, heartbeat, temperature/tint, grade multipliers,
    /// master volume). All static:
    /// <code>
    /// Hud.Say("It smells so old in here.", 3f, "Milch");
    /// Hud.FadeOut(2f);  Hud.Letterbox(true);  Hud.Flash();  Hud.Shake(0.4f, 1f);
    /// Hud.Heartbeat(0.7f, bpm: 110);  Hud.Fx("vignette", 0.8f, 3f);  Hud.ResetFx(1f);
    /// </code>
    /// Effect values layer over the scene's Environment look (0 returns to it).
    /// </summary>
    [AddComponentMenu("")]
    [DefaultExecutionOrder(900)]
    public sealed class Hud : MonoBehaviour
    {
        sealed class Channel
        {
            public float Value, From, To, Time, Duration;
            public int Mode; // 0 tween, 1 flash pattern, 2 decay
        }

        readonly struct Line
        {
            public readonly string Text;
            public readonly string? Speaker;
            public readonly float Seconds;
            public Line(string text, string? speaker, float seconds) { Text = text; Speaker = speaker; Seconds = seconds; }
        }

        static readonly Color TextColor = new Color(0.935f, 0.918f, 0.886f);
        static readonly Color SpeakerColor = new Color(0.85f, 0.78f, 0.64f);
        static readonly Color MutedColor = new Color(0.75f, 0.71f, 0.64f, 0.9f);
        static readonly Color MarkerColor = new Color(0.96f, 0.93f, 0.86f);

        public static Hud? Instance { get; private set; }

        /// <summary>Raised on every heartbeat while the heartbeat effect is active (strength 0..1).</summary>
        public static event Action<float>? Beat;

        readonly Dictionary<string, Channel> _channels = new Dictionary<string, Channel>();
        readonly Queue<Line> _queue = new Queue<Line>();
        float _baseVignette, _baseGrain, _baseTemperature, _baseTint;
        float _heartPhase, _time, _gameplayAlpha, _promptAlpha, _promptTarget, _subTimer, _markerAlpha, _dofFocus, _dofAperture;
        bool _subVisible, _envApplied;
        Color _fadeColor = Color.black, _flashColor = Color.white;
        GameObject? _markerTarget;
        Vector3 _markerLocal, _shakeOffset;
        Camera? _shakeCam;

        Canvas _canvas = null!;
        CanvasGroup _gameplay = null!, _prompt = null!, _subtitle = null!;
        Image _fade = null!, _darken = null!, _flash = null!, _lbTop = null!, _lbBottom = null!, _skipFill = null!, _marker = null!;
        RectTransform _skip = null!, _markerRoot = null!, _skipTrack = null!;
        Text _objHeader = null!, _objText = null!, _keyLabel = null!, _promptLabel = null!, _speaker = null!, _line = null!, _markerText = null!;
        Volume _volume = null!;
        Vignette _vignette = null!;
        FilmGrain _grain = null!;
        DepthOfField _dof = null!;
        WhiteBalance _white = null!;

        // ------------------------------------------------------------------ static API

        /// <summary>Shows a subtitle. seconds ≤ 0 picks a reading time; queue waits for the current line.</summary>
        public static void Say(string text, float seconds = 0f, string? speaker = null, bool queue = false) =>
            Instance?.SayImpl(text, seconds, speaker, queue);

        public static void ClearSubtitles() => Instance?.ClearSubtitlesImpl();

        /// <summary>Shows the interaction prompt ("E  Examine"). PlayerController drives it.</summary>
        public static void ShowPrompt(string text, string? key = null) => Instance?.ShowPromptImpl(text, key);

        public static void HidePrompt()
        {
            if (Instance != null) Instance._promptTarget = 0f;
        }

        public static void Fade(float to, float seconds = 1f, Color? color = null) => Fx("fade", to, seconds, color);
        public static void FadeOut(float seconds = 1.5f) => Fade(1f, seconds);
        public static void FadeIn(float seconds = 1.5f) => Fade(0f, seconds);
        public static void Letterbox(bool on, float seconds = 0.8f) => Fx("letterbox", on ? 1f : 0f, seconds);

        /// <summary>Lightning-style double flash.</summary>
        public static void Flash(float strength = 0.85f, float seconds = 0.9f, Color? color = null) => Fx("flash", strength, seconds, color);

        public static void Shake(float strength = 0.5f, float seconds = 0.6f) => Fx("shake", strength, seconds);

        /// <summary>Throbbing vignette/blur in time with <paramref name="bpm"/> (plays 'heartbeat'). Strength 0 stops it.</summary>
        public static void Heartbeat(float strength, float bpm = 70f, float seconds = 1f)
        {
            Fx("heartbeat", strength, seconds);
            Fx("heartrate", bpm, seconds);
        }

        /// <summary>
        /// Tweens a screen effect: fade, vignette, blur, darken, desaturate, grain (0..1), flash and shake (hit then
        /// decay), letterbox, heartbeat (0..1), heartRate (bpm), temperature/tint (-1..1), exposure, fog, bloom,
        /// contrast, saturation (multipliers, 1 = unchanged) and volume (master, 1 = full).
        /// </summary>
        public static void Fx(string effect, float to, float seconds = 0.5f, Color? color = null) =>
            Instance?.FxImpl(effect, to, seconds, color);

        public static float GetFx(string effect) => Instance != null ? Instance.Ch(effect.ToLowerInvariant()) : 0f;

        public static void ResetFx(float seconds = 0.5f)
        {
            if (Instance == null) return;
            foreach (var name in new List<string>(Instance._channels.Keys)) Instance.FxImpl(name, DefaultOf(name), seconds, null);
        }

        /// <summary>Base look from the scene's Environment (EnvironmentFx calls this).</summary>
        public static void SetBaseLook(float vignette, float grain, float temperature, float tint)
        {
            if (Instance == null) return;
            Instance._baseVignette = vignette;
            Instance._baseGrain = grain;
            Instance._baseTemperature = temperature;
            Instance._baseTint = tint;
        }

        /// <summary>Cutscene depth of field: focus distance in meters (0 = off) and aperture 0..1.</summary>
        public static void SetDepthOfField(float focus, float aperture)
        {
            if (Instance == null) return;
            Instance._dofFocus = focus;
            Instance._dofAperture = aperture;
        }

        /// <summary>Hold-to-skip indicator: progress 0..1, negative hides it.</summary>
        public static void SetSkipProgress(float progress)
        {
            var h = Instance;
            if (h == null) return;
            h._skip.gameObject.SetActive(progress >= 0f);
            if (progress >= 0f) h._skipFill.rectTransform.anchorMax = new Vector2(Mathf.Clamp01(progress), 1f);
        }

        // ------------------------------------------------------------------ build

        void Awake()
        {
            Instance = this;
            var root = new GameObject("AigeHud", typeof(RectTransform));
            root.transform.SetParent(transform, false);
            _canvas = root.AddComponent<Canvas>();
            _canvas.renderMode = RenderMode.ScreenSpaceOverlay;
            _canvas.sortingOrder = 100;
            var scaler = root.AddComponent<CanvasScaler>();
            scaler.uiScaleMode = CanvasScaler.ScaleMode.ScaleWithScreenSize;
            scaler.referenceResolution = new Vector2(1920, 1080);
            scaler.matchWidthOrHeight = 0.5f;
            var font = Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf");

            _darken = Full(root.transform, "Darken", Color.black);
            _lbTop = Bar(root.transform, "LetterboxTop", true);
            _lbBottom = Bar(root.transform, "LetterboxBottom", false);

            _gameplay = Group(root.transform, "Gameplay");
            var obj = Rect(_gameplay.transform, "Objective", new Vector2(0, 1), new Vector2(0, 1), new Vector2(56, -52), new Vector2(760, 90));
            _objHeader = Label(obj, "Header", font, 17, MutedColor, TextAnchor.UpperLeft, new Vector2(0, 0), new Vector2(760, 24));
            _objHeader.text = "OBJECTIVE";
            _objText = Label(obj, "Text", font, 26, TextColor, TextAnchor.UpperLeft, new Vector2(0, -28), new Vector2(760, 40));
            obj.gameObject.SetActive(false);

            _markerRoot = Rect(_gameplay.transform, "Marker", new Vector2(0, 0), new Vector2(0, 0), Vector2.zero, new Vector2(30, 30));
            _markerRoot.pivot = new Vector2(0.5f, 0.5f);
            _marker = new GameObject("Diamond", typeof(RectTransform), typeof(Image)).GetComponent<Image>();
            _marker.transform.SetParent(_markerRoot, false);
            _marker.rectTransform.sizeDelta = new Vector2(16, 16);
            _marker.rectTransform.localRotation = Quaternion.Euler(0, 0, 45);
            _marker.color = MarkerColor;
            _markerText = Label(_markerRoot, "Distance", font, 17, MarkerColor, TextAnchor.UpperCenter, new Vector2(-60, -18), new Vector2(120, 24));

            _prompt = Group(root.transform, "Prompt");
            var pr = (RectTransform)_prompt.transform;
            pr.anchorMin = pr.anchorMax = new Vector2(0.5f, 0f);
            pr.anchoredPosition = new Vector2(0, 250);
            pr.sizeDelta = new Vector2(900, 50);
            var cap = new GameObject("Key", typeof(RectTransform), typeof(Image)).GetComponent<Image>();
            cap.transform.SetParent(pr, false);
            cap.color = new Color(0.94f, 0.92f, 0.88f, 0.92f);
            cap.rectTransform.sizeDelta = new Vector2(40, 40);
            cap.rectTransform.anchoredPosition = new Vector2(-60, 0);
            _keyLabel = Label(cap.rectTransform, "Label", font, 22, new Color(0.08f, 0.08f, 0.08f), TextAnchor.MiddleCenter, new Vector2(-20, 20), new Vector2(40, 40));
            _promptLabel = Label(pr, "Text", font, 26, TextColor, TextAnchor.MiddleLeft, new Vector2(-30, 25), new Vector2(600, 50));
            _prompt.alpha = 0f;

            _subtitle = Group(root.transform, "Subtitle");
            var sr = (RectTransform)_subtitle.transform;
            sr.anchorMin = sr.anchorMax = new Vector2(0.5f, 0f);
            sr.anchoredPosition = new Vector2(0, 150);
            sr.sizeDelta = new Vector2(1400, 110);
            _speaker = Label(sr, "Speaker", font, 21, SpeakerColor, TextAnchor.LowerCenter, new Vector2(-700, 55), new Vector2(1400, 28));
            _line = Label(sr, "Line", font, 31, TextColor, TextAnchor.UpperCenter, new Vector2(-700, 22), new Vector2(1400, 80));
            _subtitle.alpha = 0f;

            _skip = Rect(root.transform, "Skip", new Vector2(1, 0), new Vector2(1, 0), new Vector2(-260, 70), new Vector2(220, 40));
            var skipLabel = Label(_skip, "Label", font, 18, MutedColor, TextAnchor.UpperRight, new Vector2(0, 0), new Vector2(220, 22));
            skipLabel.text = "Hold to skip";
            _skipTrack = Rect(_skip, "Track", new Vector2(0, 0), new Vector2(1, 0), new Vector2(0, 4), new Vector2(0, 3));
            _skipTrack.gameObject.AddComponent<Image>().color = new Color(1, 1, 1, 0.2f);
            _skipFill = new GameObject("Fill", typeof(RectTransform), typeof(Image)).GetComponent<Image>();
            _skipFill.transform.SetParent(_skipTrack, false);
            _skipFill.rectTransform.anchorMin = Vector2.zero;
            _skipFill.rectTransform.anchorMax = new Vector2(0, 1);
            _skipFill.rectTransform.offsetMin = _skipFill.rectTransform.offsetMax = Vector2.zero;
            _skipFill.color = TextColor;
            _skip.gameObject.SetActive(false);

            _flash = Full(root.transform, "Flash", Color.white);
            _fade = Full(root.transform, "Fade", Color.black);

            var vol = new GameObject("AigeHudVolume");
            vol.transform.SetParent(transform, false);
            _volume = vol.AddComponent<Volume>();
            _volume.isGlobal = true;
            _volume.priority = 50;
            var profile = ScriptableObject.CreateInstance<VolumeProfile>();
            _vignette = profile.Add<Vignette>(true);
            _vignette.smoothness.value = 0.45f;
            _grain = profile.Add<FilmGrain>(true);
            _grain.type.value = FilmGrainLookup.Medium2;
            _grain.response.value = 0.75f;
            _dof = profile.Add<DepthOfField>(true);
            _dof.mode.value = DepthOfFieldMode.Off;
            _white = profile.Add<WhiteBalance>(true);
            _volume.sharedProfile = profile;

            RenderPipelineManager.beginCameraRendering += BeginCamera;
            RenderPipelineManager.endCameraRendering += EndCamera;
        }

        void OnDestroy()
        {
            RenderPipelineManager.beginCameraRendering -= BeginCamera;
            RenderPipelineManager.endCameraRendering -= EndCamera;
            if (Instance == this) Instance = null;
        }

        static RectTransform Rect(Transform parent, string name, Vector2 anchorMin, Vector2 anchorMax, Vector2 pos, Vector2 size)
        {
            var rt = new GameObject(name, typeof(RectTransform)).GetComponent<RectTransform>();
            rt.SetParent(parent, false);
            rt.anchorMin = anchorMin;
            rt.anchorMax = anchorMax;
            rt.pivot = new Vector2(0, 1);
            rt.anchoredPosition = pos;
            rt.sizeDelta = size;
            return rt;
        }

        static CanvasGroup Group(Transform parent, string name)
        {
            var rt = new GameObject(name, typeof(RectTransform)).GetComponent<RectTransform>();
            rt.SetParent(parent, false);
            rt.anchorMin = Vector2.zero;
            rt.anchorMax = Vector2.one;
            rt.offsetMin = rt.offsetMax = Vector2.zero;
            var g = rt.gameObject.AddComponent<CanvasGroup>();
            g.interactable = false;
            g.blocksRaycasts = false;
            return g;
        }

        static Image Full(Transform parent, string name, Color c)
        {
            var img = new GameObject(name, typeof(RectTransform), typeof(Image)).GetComponent<Image>();
            img.transform.SetParent(parent, false);
            var rt = img.rectTransform;
            rt.anchorMin = Vector2.zero;
            rt.anchorMax = Vector2.one;
            rt.offsetMin = rt.offsetMax = Vector2.zero;
            img.color = new Color(c.r, c.g, c.b, 0f);
            img.raycastTarget = false;
            img.enabled = false;
            return img;
        }

        static Image Bar(Transform parent, string name, bool top)
        {
            var img = new GameObject(name, typeof(RectTransform), typeof(Image)).GetComponent<Image>();
            img.transform.SetParent(parent, false);
            var rt = img.rectTransform;
            rt.anchorMin = new Vector2(0, top ? 1 : 0);
            rt.anchorMax = new Vector2(1, top ? 1 : 0);
            rt.pivot = new Vector2(0.5f, top ? 1 : 0);
            rt.sizeDelta = new Vector2(0, 0);
            img.color = Color.black;
            img.raycastTarget = false;
            return img;
        }

        static Text Label(RectTransform parent, string name, Font font, int size, Color color, TextAnchor anchor, Vector2 pos, Vector2 box)
        {
            var t = new GameObject(name, typeof(RectTransform), typeof(Text)).GetComponent<Text>();
            t.transform.SetParent(parent, false);
            t.rectTransform.anchorMin = t.rectTransform.anchorMax = new Vector2(0.5f, 0.5f);
            t.rectTransform.pivot = new Vector2(0, 1);
            if (parent.pivot == new Vector2(0, 1)) t.rectTransform.anchorMin = t.rectTransform.anchorMax = new Vector2(0, 1);
            t.rectTransform.anchoredPosition = pos;
            t.rectTransform.sizeDelta = box;
            t.font = font;
            t.fontSize = size;
            t.color = color;
            t.alignment = anchor;
            t.horizontalOverflow = HorizontalWrapMode.Wrap;
            t.verticalOverflow = VerticalWrapMode.Overflow;
            t.raycastTarget = false;
            var shadow = t.gameObject.AddComponent<Shadow>();
            shadow.effectColor = new Color(0, 0, 0, 0.75f);
            shadow.effectDistance = new Vector2(1.5f, -1.5f);
            return t;
        }

        // ------------------------------------------------------------------ subtitles, prompt

        void SayImpl(string text, float seconds, string? speaker, bool queue)
        {
            if (string.IsNullOrEmpty(text)) return;
            if (seconds <= 0f) seconds = Mathf.Clamp(1.2f + text.Length * 0.055f, 2f, 9f);
            var line = new Line(text, speaker, seconds);
            if (queue && _subVisible) _queue.Enqueue(line);
            else
            {
                _queue.Clear();
                ShowLine(line);
            }
        }

        void ShowLine(Line l)
        {
            _speaker.text = string.IsNullOrEmpty(l.Speaker) ? "" : l.Speaker!.ToUpperInvariant();
            _line.text = l.Text;
            _subTimer = l.Seconds;
            _subVisible = true;
        }

        void ClearSubtitlesImpl()
        {
            _queue.Clear();
            _subVisible = false;
        }

        void ShowPromptImpl(string text, string? key)
        {
            _keyLabel.text = key ?? AigeInput.KeyName("interact", "E");
            _promptLabel.text = text;
            _promptTarget = 1f;
        }

        // ------------------------------------------------------------------ effects

        static float DefaultOf(string name)
        {
            switch (name)
            {
                case "exposure": case "fog": case "bloom": case "contrast": case "saturation": case "volume": return 1f;
                case "heartrate": return 70f;
                default: return 0f;
            }
        }

        float Ch(string name) => _channels.TryGetValue(name, out var c) ? c.Value : DefaultOf(name);

        Channel GetChannel(string name)
        {
            if (!_channels.TryGetValue(name, out var c))
            {
                var d = DefaultOf(name);
                _channels[name] = c = new Channel { Value = d, From = d, To = d };
            }
            return c;
        }

        void FxImpl(string effect, float to, float seconds, Color? color)
        {
            var name = effect.ToLowerInvariant();
            switch (name)
            {
                case "fade":
                    if (color != null) _fadeColor = color.Value;
                    break;
                case "flash":
                    _flashColor = color ?? new Color(0.86f, 0.9f, 1f);
                    break;
                case "vignette": case "blur": case "darken": case "desaturate": case "shake": case "letterbox": case "heartbeat":
                case "heartrate": case "exposure": case "fog": case "bloom": case "contrast": case "saturation": case "temperature":
                case "tint": case "grain": case "volume":
                    break;
                default:
                    Log.WarnOnce("fx:" + name, $"Unknown screen effect '{effect}'.");
                    return;
            }
            var c = GetChannel(name);
            c.Mode = name == "flash" ? 1 : name == "shake" ? 2 : 0;
            c.Time = 0f;
            c.Duration = Mathf.Max(0f, seconds);
            if (c.Mode == 0)
            {
                c.From = c.Value;
                c.To = to;
                if (c.Duration <= 0f) c.Value = to;
            }
            else
            {
                c.From = to;
                c.To = 0f;
                c.Value = to;
                if (c.Duration <= 0f) c.Duration = name == "flash" ? 0.6f : 0.5f;
            }
        }

        static float Bump(float x, float start, float width)
        {
            var u = (x - start) / width;
            return u >= 0f && u <= 1f ? Mathf.Sin(u * Mathf.PI) : 0f;
        }

        static float HeartEnvelope(float p) => Mathf.Max(Bump(p, 0f, 0.13f), 0.62f * Bump(p, 0.2f, 0.15f));

        static float Screen(float a, float b) => 1f - (1f - Mathf.Clamp01(a)) * (1f - Mathf.Clamp01(b));

        void Update()
        {
            var dt = Time.unscaledDeltaTime;
            _time += dt;
            foreach (var c in _channels.Values)
            {
                if (c.Time >= c.Duration) continue;
                c.Time += dt;
                var x = c.Duration > 0 ? Mathf.Clamp01(c.Time / c.Duration) : 1f;
                c.Value = c.Mode == 1 ? (x >= 1f ? 0f : c.From * LightFlicker.FlashPattern(x))
                    : c.Mode == 2 ? c.From * (1f - x) * (1f - x)
                    : Mathf.Lerp(c.From, c.To, Easing.Smooth(x));
            }

            var heart = Ch("heartbeat");
            var pulse = 0f;
            if (heart > 0.001f)
            {
                var prev = _heartPhase;
                _heartPhase += dt * Mathf.Max(20f, Ch("heartrate")) / 60f;
                if (_heartPhase >= 1f)
                {
                    _heartPhase -= 1f;
                    Beat?.Invoke(heart);
                    if (heart > 0.1f) Sfx.TryPlay(Sfx.Exists("heartbeat") ? "heartbeat" : "heartbeat_single", null, Mathf.Clamp01(heart), 1f, false);
                }
                else if (prev == 0f) Beat?.Invoke(heart);
                pulse = heart * HeartEnvelope(_heartPhase);
            }
            else _heartPhase = 0f;

            UpdateOverlays();
            UpdateVolume(pulse);
            UpdateEnvironment();
            UpdateUi(dt);
        }

        void UpdateOverlays()
        {
            float fade = Ch("fade"), darken = Ch("darken"), flash = Ch("flash"), lb = Ch("letterbox");
            SetOverlay(_fade, _fadeColor, fade);
            SetOverlay(_darken, Color.black, darken * 0.85f);
            SetOverlay(_flash, _flashColor, flash);
            var h = lb * 0.11f * 1080f;
            _lbTop.rectTransform.sizeDelta = new Vector2(0, h);
            _lbBottom.rectTransform.sizeDelta = new Vector2(0, h);
        }

        static void SetOverlay(Image img, Color c, float a)
        {
            img.enabled = a > 0.001f;
            if (img.enabled) img.color = new Color(c.r, c.g, c.b, Mathf.Clamp01(a));
        }

        void UpdateVolume(float pulse)
        {
            _vignette.intensity.value = Mathf.Clamp01(Screen(_baseVignette, Ch("vignette")) * 0.7f + pulse * 0.3f);
            _grain.intensity.value = Mathf.Clamp01(Screen(_baseGrain, Ch("grain")));
            _white.temperature.value = Mathf.Clamp(_baseTemperature + Ch("temperature"), -1f, 1f) * 40f;
            _white.tint.value = Mathf.Clamp(_baseTint + Ch("tint"), -1f, 1f) * 40f;
            var blur = Mathf.Clamp01(Ch("blur") + pulse * 0.35f);
            if (blur > 0.01f)
            {
                _dof.mode.value = DepthOfFieldMode.Gaussian;
                _dof.gaussianStart.value = 0f;
                _dof.gaussianEnd.value = Mathf.Lerp(25f, 0.2f, blur);
                _dof.gaussianMaxRadius.value = Mathf.Lerp(0.5f, 1.5f, blur);
                _dof.highQualitySampling.value = true;
            }
            else if (_dofFocus > 0.01f)
            {
                _dof.mode.value = DepthOfFieldMode.Bokeh;
                _dof.focusDistance.value = _dofFocus;
                _dof.aperture.value = Mathf.Lerp(8f, 1.4f, Mathf.Clamp01(_dofAperture));
                _dof.focalLength.value = 50f;
            }
            else _dof.mode.value = DepthOfFieldMode.Off;
        }

        void UpdateEnvironment()
        {
            float exposure = Ch("exposure"), fog = Ch("fog"), bloom = Ch("bloom"), contrast = Ch("contrast");
            var saturation = Ch("saturation") * (1f - Mathf.Clamp01(Ch("desaturate")));
            var changed = Mathf.Abs(exposure - 1f) + Mathf.Abs(fog - 1f) + Mathf.Abs(bloom - 1f) + Mathf.Abs(contrast - 1f) + Mathf.Abs(saturation - 1f) > 0.0005f;
            if (changed || _envApplied)
            {
                EnvironmentFx.Current?.ApplyMultipliers(exposure, fog, bloom, contrast, saturation);
                _envApplied = changed;
            }
            if (_channels.TryGetValue("volume", out var vol) && (vol.Time < vol.Duration || vol.Time == 0f)) Sfx.SetMasterVolume(vol.Value);
        }

        void UpdateUi(float dt)
        {
            var show = !Cutscenes.InputBlocked && Ch("fade") < 0.5f;
            _gameplayAlpha = Mathf.MoveTowards(_gameplayAlpha, show ? 1f : 0f, dt * 3f);
            _gameplay.alpha = _gameplayAlpha;
            _promptAlpha = Mathf.MoveTowards(_promptAlpha, show ? _promptTarget : 0f, dt * 7f);
            _prompt.alpha = _promptAlpha;

            _objText.transform.parent.gameObject.SetActive(!string.IsNullOrEmpty(Story.Objective));
            _objText.text = Story.Objective;

            if (_subVisible)
            {
                _subTimer -= dt;
                if (_subTimer <= 0f)
                {
                    if (_queue.Count > 0) ShowLine(_queue.Dequeue());
                    else ClearSubtitlesImpl();
                }
            }
            _subtitle.alpha = Mathf.MoveTowards(_subtitle.alpha, _subVisible ? 1f : 0f, dt * 6f);
            UpdateMarker(dt);
        }

        void UpdateMarker(float dt)
        {
            var target = Story.ObjectiveTarget;
            var cam = Entities.ActiveCamera;
            var want = Story.PointerVisible && target != null && cam != null;
            _markerAlpha = Mathf.MoveTowards(_markerAlpha, want ? 1f : 0f, dt * 0.8f);
            if (!want || _markerAlpha <= 0.001f || target == null || cam == null)
            {
                _markerRoot.gameObject.SetActive(false);
                return;
            }
            if (_markerTarget != target)
            {
                _markerTarget = target;
                _markerLocal = target.transform.InverseTransformPoint(Entities.FocusPoint(target));
            }
            var world = target.transform.TransformPoint(_markerLocal);
            var from = PlayerController.Instance != null ? PlayerController.Instance.transform.position : cam.transform.position;
            var dist = Vector3.Distance(from, world);
            var alpha = _markerAlpha * Mathf.Clamp01((dist - 1.5f) / 2f) * (0.72f + 0.18f * Mathf.Sin(_time * 2.2f));
            _markerRoot.gameObject.SetActive(alpha > 0.002f);
            if (alpha <= 0.002f) return;
            var canvasRect = (RectTransform)_canvas.transform;
            var scale = canvasRect.rect.width / Mathf.Max(1f, cam.pixelWidth);
            var sp = cam.WorldToScreenPoint(world);
            var behind = sp.z < 0f;
            var p = new Vector2(sp.x, sp.y) * scale;
            var size = canvasRect.rect.size;
            const float margin = 70f;
            if (behind || p.x < margin || p.x > size.x - margin || p.y < margin || p.y > size.y - margin)
            {
                var center = size / 2f;
                var dir = (p - center) * (behind ? -1f : 1f);
                if (dir.sqrMagnitude < 1f) dir = Vector2.down;
                dir.Normalize();
                var half = center - new Vector2(margin, margin);
                var k = Mathf.Min(Mathf.Abs(half.x / (dir.x == 0 ? 1e-4f : dir.x)), Mathf.Abs(half.y / (dir.y == 0 ? 1e-4f : dir.y)));
                p = center + dir * k;
                _markerText.text = "";
            }
            else _markerText.text = $"{Mathf.RoundToInt(dist)} m";
            _markerRoot.anchoredPosition = p;
            _marker.color = new Color(MarkerColor.r, MarkerColor.g, MarkerColor.b, alpha);
            _markerText.color = new Color(MarkerColor.r, MarkerColor.g, MarkerColor.b, alpha);
        }

        // Camera shake is applied only while a camera renders, so rigs never accumulate it.
        void BeginCamera(ScriptableRenderContext ctx, Camera cam)
        {
            var shake = Ch("shake");
            if (shake <= 0.0001f || cam.cameraType != CameraType.Game) return;
            var a = shake * shake * 0.14f;
            var t = _time;
            _shakeOffset = cam.transform.rotation * new Vector3(
                a * (Mathf.Sin(t * 37.1f) + 0.5f * Mathf.Sin(t * 23.3f + 1.3f)) / 1.5f,
                a * (Mathf.Sin(t * 41.7f + 0.4f) + 0.5f * Mathf.Sin(t * 19.1f)) / 1.5f, 0f);
            cam.transform.position += _shakeOffset;
            _shakeCam = cam;
        }

        void EndCamera(ScriptableRenderContext ctx, Camera cam)
        {
            if (_shakeCam != cam) return;
            cam.transform.position -= _shakeOffset;
            _shakeCam = null;
        }
    }
}
