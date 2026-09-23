using System;
using System.Collections.Generic;
using Godot;

namespace Aige;

/// <summary>
/// The game HUD (autoload <c>Hud</c>), built entirely in code: subtitles, the interaction prompt,
/// the objective (top-left) with its waypoint marker, letterbox bars, fades, and a full-screen
/// screen-FX pass (vignette, film grain, blur, darken, desaturate, flash, temperature/tint,
/// heartbeat pulse, shake). All calls are static:
/// <code>
/// Hud.Say("It smells so old in here.", 3f, "Milch");
/// Hud.Fade(1f, 2f);            // to black over 2 s
/// Hud.Fx("vignette", 0.8f, 3f); // tween any effect
/// Hud.Flash();                 // lightning
/// </code>
/// FX values are layered over the scene's Environment look (EnvironmentFx): 0 returns to it.
/// </summary>
public partial class Hud : CanvasLayer
{
    const string ShaderCode = @"
shader_type canvas_item;
render_mode unshaded;

uniform sampler2D screen_tex : hint_screen_texture, filter_linear_mipmap;
uniform float vignette = 0.0;
uniform float grain = 0.0;
uniform float blur = 0.0;
uniform float darken = 0.0;
uniform float desaturate = 0.0;
uniform float flash = 0.0;
uniform vec3 flash_color = vec3(1.0);
uniform float temperature = 0.0;
uniform float tint = 0.0;
uniform float pulse = 0.0;
uniform float fade = 0.0;
uniform vec3 fade_color = vec3(0.0);
uniform float letterbox = 0.0;

float hash12(vec2 p) {
	vec3 p3 = fract(vec3(p.xyx) * 0.1031);
	p3 += dot(p3, p3.yzx + 33.33);
	return fract((p3.x + p3.y) * p3.z);
}

void fragment() {
	vec2 c = SCREEN_UV - 0.5;
	vec2 uv = 0.5 + c * (1.0 - pulse * 0.012);
	float lod = clamp(blur, 0.0, 1.0) * 5.0 + pulse * 0.9;
	vec3 col;
	if (lod > 0.05) {
		vec2 px = SCREEN_PIXEL_SIZE * exp2(lod) * 0.7;
		col = textureLod(screen_tex, uv, lod).rgb * 0.36;
		col += textureLod(screen_tex, uv + vec2(px.x, px.y * 0.5), lod).rgb * 0.16;
		col += textureLod(screen_tex, uv - vec2(px.x, px.y * 0.5), lod).rgb * 0.16;
		col += textureLod(screen_tex, uv + vec2(-px.x * 0.5, px.y), lod).rgb * 0.16;
		col += textureLod(screen_tex, uv - vec2(-px.x * 0.5, px.y), lod).rgb * 0.16;
	} else {
		col = textureLod(screen_tex, uv, 0.0).rgb;
	}
	col *= vec3(1.0 + 0.10 * temperature + 0.03 * tint, 1.0 + 0.01 * temperature - 0.06 * tint, 1.0 - 0.12 * temperature + 0.03 * tint);
	float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
	col = mix(col, vec3(luma), clamp(desaturate, 0.0, 1.0));
	col *= 1.0 - clamp(darken, 0.0, 1.0);
	float v = clamp(vignette + pulse * 0.3, 0.0, 1.0);
	float d = length(c) * 1.4142;
	float vig = smoothstep(mix(0.5, 0.0, v), mix(1.1, 0.62, v), d) * smoothstep(0.0, 0.3, v) * mix(0.45, 1.0, v);
	col *= 1.0 - vig;
	float n = hash12(FRAGCOORD.xy + floor(TIME * 24.0) * 37.0) - 0.5;
	col += n * grain * 0.16 * (1.0 - clamp(luma, 0.0, 1.0) * 0.6);
	col = 1.0 - (1.0 - col) * (1.0 - flash_color * clamp(flash, 0.0, 1.0));
	col = mix(col, fade_color, clamp(fade, 0.0, 1.0));
	float bar = letterbox * 0.125;
	if (SCREEN_UV.y < bar || SCREEN_UV.y > 1.0 - bar) col = vec3(0.0);
	COLOR = vec4(max(col, vec3(0.0)), 1.0);
}
";

    static readonly Color TextColor = new(0.935f, 0.918f, 0.886f);
    static readonly Color SpeakerColor = new(0.85f, 0.78f, 0.64f);
    static readonly Color MutedColor = new(0.75f, 0.71f, 0.64f, 0.9f);
    static readonly Color MarkerColor = new(0.96f, 0.93f, 0.86f);

    sealed class Channel
    {
        public float Value, From, To, Time, Duration;
        public int Mode; // 0 tween, 1 flash (lightning pattern), 2 decay
    }

    readonly record struct Line(string Text, string? Speaker, float Seconds);

    /// <summary>The autoload instance.</summary>
    public static Hud? Instance { get; private set; }

    /// <summary>Raised on every heartbeat ('lub') while the heartbeat effect is active: strength 0..1.</summary>
    public static event Action<float>? Beat;

    readonly Dictionary<string, Channel> _channels = new();
    readonly Queue<Line> _queue = new();
    float _baseVignette, _baseGrain, _baseTemperature, _baseTint;
    float _scale = 1f, _heartPhase, _time, _gameplayAlpha, _promptAlpha, _promptTarget, _subTimer, _markerAlpha;
    bool _subVisible, _envApplied;
    Color _fadeColor = Colors.Black, _flashColor = Colors.White;
    Camera3D? _shakeCam;
    Node3D? _markerTarget;
    Vector3 _markerLocal;
    Tween? _objTween, _subTween;

    Control _root = null!, _gameplay = null!, _marker = null!;
    ColorRect _fx = null!, _objLine = null!, _skipTrack = null!, _skipFill = null!;
    ShaderMaterial _fxMat = null!;
    VBoxContainer _objective = null!, _subtitle = null!, _skip = null!;
    HBoxContainer _prompt = null!;
    PanelContainer _keycap = null!;
    Label _objHeader = null!, _objText = null!, _keyLabel = null!, _promptLabel = null!;
    Label _speakerLabel = null!, _subtitleLabel = null!, _skipLabel = null!;
    StyleBoxFlat _keyStyle = null!;
    Font _regular = null!, _medium = null!, _caps = null!;

    // =====================================================================================
    // Static API
    // =====================================================================================

    /// <summary>
    /// Shows a subtitle at the bottom of the screen. <paramref name="seconds"/> ≤ 0 picks a reading
    /// time from the length. A new line replaces the current one unless <paramref name="queue"/> is true.
    /// </summary>
    /// <example><code>Hud.Say("Three chairs... why three?", 4f, "Milch");</code></example>
    public static void Say(string text, float seconds = 0f, string? speaker = null, bool queue = false) =>
        Instance?.SayImpl(text, seconds, speaker, queue);

    /// <summary>Hides the subtitle and drops queued lines.</summary>
    public static void ClearSubtitles() => Instance?.ClearSubtitlesImpl();

    /// <summary>Shows the interaction prompt, e.g. "E  Examine". <paramref name="key"/> defaults to the 'interact' key.</summary>
    public static void ShowPrompt(string text, string? key = null) => Instance?.ShowPromptImpl(text, key);

    /// <summary>Hides the interaction prompt.</summary>
    public static void HidePrompt()
    {
        if (Instance != null) Instance._promptTarget = 0f;
    }

    /// <summary>Fades the screen: 1 = fully <paramref name="color"/> (black by default), 0 = clear. Subtitles stay visible.</summary>
    public static void Fade(float to, float seconds = 1f, Color? color = null) => Fx("fade", to, seconds, color);

    /// <summary>Fades to black.</summary>
    public static void FadeOut(float seconds = 1.5f) => Fade(1f, seconds);

    /// <summary>Fades in from black.</summary>
    public static void FadeIn(float seconds = 1.5f) => Fade(0f, seconds);

    /// <summary>Slides cinematic letterbox bars in or out.</summary>
    public static void Letterbox(bool on, float seconds = 0.8f) => Fx("letterbox", on ? 1f : 0f, seconds);

    /// <summary>A bright flash (lightning by default: a double flicker that decays over <paramref name="seconds"/>).</summary>
    public static void Flash(float strength = 0.85f, float seconds = 0.9f, Color? color = null) =>
        Fx("flash", strength, seconds, color ?? new Color(0.86f, 0.9f, 1f));

    /// <summary>Camera shake that decays over <paramref name="seconds"/> (strength 0..1).</summary>
    public static void Shake(float strength = 0.5f, float seconds = 0.6f) => Fx("shake", strength, seconds);

    /// <summary>Heartbeat pulse (vignette/blur throb in time with <paramref name="bpm"/>). Strength 0 stops it.</summary>
    public static void Heartbeat(float strength, float bpm = 70f, float seconds = 1f)
    {
        Fx("heartbeat", strength, seconds);
        Fx("heartrate", bpm, seconds);
    }

    /// <summary>
    /// Tweens a screen effect to <paramref name="to"/> over <paramref name="seconds"/>. Effects:
    /// fade, vignette, blur, darken, desaturate, grain (0..1), flash and shake (decay after the hit),
    /// letterbox, heartbeat (0..1), heartRate (bpm), temperature and tint (-1..1), and scene grade
    /// multipliers exposure, fog, bloom, contrast, saturation (1 = unchanged), plus volume (master, 1 = full).
    /// </summary>
    public static void Fx(string effect, float to, float seconds = 0.5f, Color? color = null) =>
        Instance?.FxImpl(effect, to, seconds, color);

    /// <summary>Current value of an effect channel.</summary>
    public static float GetFx(string effect) => Instance?.Ch(effect.ToLowerInvariant()) ?? 0f;

    /// <summary>Returns every effect to its default (clear screen, scene look unchanged).</summary>
    public static void ResetFx(float seconds = 0.5f)
    {
        if (Instance == null) return;
        foreach (var name in new List<string>(Instance._channels.Keys))
            Instance.FxImpl(name, DefaultOf(name), seconds, null);
    }

    /// <summary>Base look from the scene's Environment (called by EnvironmentFx).</summary>
    public static void SetBaseLook(float vignette, float grain, float temperature, float tint)
    {
        if (Instance == null) return;
        Instance._baseVignette = vignette;
        Instance._baseGrain = grain;
        Instance._baseTemperature = temperature;
        Instance._baseTint = tint;
    }

    /// <summary>Hold-to-skip indicator: progress 0..1, or negative to hide it.</summary>
    public static void SetSkipProgress(float progress)
    {
        var h = Instance;
        if (h == null) return;
        h._skip.Visible = progress >= 0f;
        if (progress >= 0f) h._skipFill.Size = new Vector2(h._skipTrack.Size.X * Mathf.Clamp(progress, 0f, 1f), h._skipTrack.Size.Y);
    }

    // =====================================================================================
    // Build
    // =====================================================================================

    public override void _EnterTree()
    {
        Instance = this;
        Layer = 50;
        ProcessMode = ProcessModeEnum.Always;
    }

    public override void _ExitTree()
    {
        if (Instance == this) Instance = null;
    }

    public override void _Ready()
    {
        _regular = MakeFont(400);
        _medium = MakeFont(600);
        _caps = new FontVariation { BaseFont = MakeFont(600), SpacingGlyph = 3 };

        _root = FullRect(new Control { Name = "Root" });
        AddChild(_root);

        _fx = FullRect(new ColorRect { Name = "ScreenFx", Color = Colors.White, Visible = false });
        _fxMat = new ShaderMaterial { Shader = new Shader { Code = ShaderCode } };
        _fx.Material = _fxMat;
        _root.AddChild(_fx);

        _gameplay = FullRect(new Control { Name = "Gameplay" });
        _root.AddChild(_gameplay);

        _marker = FullRect(new Control { Name = "Waypoint" });
        _marker.Draw += DrawMarker;
        _gameplay.AddChild(_marker);

        // Objective (top-left)
        _objective = new VBoxContainer { Name = "Objective", MouseFilter = Control.MouseFilterEnum.Ignore, Modulate = new Color(1, 1, 1, 0) };
        _objHeader = MakeLabel("OBJECTIVE", _caps, MutedColor);
        _objLine = new ColorRect { Color = new Color(MutedColor, 0.5f), MouseFilter = Control.MouseFilterEnum.Ignore };
        _objText = MakeLabel("", _regular, TextColor);
        _objText.AutowrapMode = TextServer.AutowrapMode.WordSmart;
        _objective.AddChild(_objHeader);
        _objective.AddChild(_objLine);
        _objective.AddChild(_objText);
        _gameplay.AddChild(_objective);

        // Interaction prompt (bottom-center)
        _prompt = new HBoxContainer { Name = "Prompt", MouseFilter = Control.MouseFilterEnum.Ignore, Modulate = new Color(1, 1, 1, 0) };
        _prompt.Alignment = BoxContainer.AlignmentMode.Center;
        _keyStyle = new StyleBoxFlat
        {
            BgColor = new Color(0.02f, 0.02f, 0.025f, 0.45f),
            BorderColor = new Color(TextColor, 0.85f),
            AntiAliasing = true,
        };
        _keycap = new PanelContainer { MouseFilter = Control.MouseFilterEnum.Ignore };
        _keycap.AddThemeStyleboxOverride("panel", _keyStyle);
        _keyLabel = MakeLabel("E", _medium, TextColor);
        _keyLabel.HorizontalAlignment = HorizontalAlignment.Center;
        _keyLabel.VerticalAlignment = VerticalAlignment.Center;
        _keycap.AddChild(_keyLabel);
        _promptLabel = MakeLabel("", _regular, TextColor);
        _promptLabel.VerticalAlignment = VerticalAlignment.Center;
        _prompt.AddChild(_keycap);
        _prompt.AddChild(_promptLabel);
        _gameplay.AddChild(_prompt);

        // Subtitles (bottom-center, above everything but the skip hint)
        _subtitle = new VBoxContainer { Name = "Subtitles", MouseFilter = Control.MouseFilterEnum.Ignore, Modulate = new Color(1, 1, 1, 0) };
        _subtitle.Alignment = BoxContainer.AlignmentMode.End;
        _speakerLabel = MakeLabel("", _caps, SpeakerColor);
        _speakerLabel.HorizontalAlignment = HorizontalAlignment.Center;
        _subtitleLabel = MakeLabel("", _regular, TextColor);
        _subtitleLabel.HorizontalAlignment = HorizontalAlignment.Center;
        _subtitleLabel.AutowrapMode = TextServer.AutowrapMode.WordSmart;
        _subtitle.AddChild(_speakerLabel);
        _subtitle.AddChild(_subtitleLabel);
        _root.AddChild(_subtitle);

        // Hold-to-skip (bottom-right)
        _skip = new VBoxContainer { Name = "Skip", MouseFilter = Control.MouseFilterEnum.Ignore, Visible = false };
        _skipLabel = MakeLabel($"Hold  {KeyName("skip", "Space")}  to skip", _regular, MutedColor);
        _skipLabel.HorizontalAlignment = HorizontalAlignment.Right;
        _skipTrack = new ColorRect { Color = new Color(1, 1, 1, 0.15f), MouseFilter = Control.MouseFilterEnum.Ignore };
        _skipFill = new ColorRect { Color = new Color(TextColor, 0.9f), MouseFilter = Control.MouseFilterEnum.Ignore };
        _skipTrack.AddChild(_skipFill);
        _skip.AddChild(_skipLabel);
        _skip.AddChild(_skipTrack);
        _root.AddChild(_skip);

        Story.ObjectiveChanged += OnObjectiveChanged;
        GetViewport().SizeChanged += Layout;
        Layout();
    }

    static T FullRect<T>(T c) where T : Control
    {
        c.SetAnchorsPreset(Control.LayoutPreset.FullRect);
        c.MouseFilter = Control.MouseFilterEnum.Ignore;
        return c;
    }

    static Font MakeFont(int weight) => new SystemFont
    {
        FontNames = new[] { "Segoe UI", "Inter", "Helvetica Neue", "Roboto", "Noto Sans", "DejaVu Sans", "Arial", "sans-serif" },
        FontWeight = weight,
        Antialiasing = TextServer.FontAntialiasing.Gray,
    };

    static Label MakeLabel(string text, Font font, Color color) => new()
    {
        Text = text,
        MouseFilter = Control.MouseFilterEnum.Ignore,
        LabelSettings = new LabelSettings
        {
            Font = font,
            FontColor = color,
            ShadowColor = new Color(0, 0, 0, 0.75f),
            ShadowOffset = new Vector2(0, 2),
            ShadowSize = 5,
        },
    };

    /// <summary>Display name of the first keyboard key bound to an action.</summary>
    public static string KeyName(string action, string fallback)
    {
        if (!InputMap.HasAction(action)) return fallback;
        foreach (var ev in InputMap.ActionGetEvents(action))
        {
            if (ev is not InputEventKey k) continue;
            var code = k.PhysicalKeycode != Key.None ? k.PhysicalKeycode : k.Keycode;
            var s = OS.GetKeycodeString(code);
            if (!string.IsNullOrEmpty(s)) return s;
        }
        return fallback;
    }

    void Layout()
    {
        var size = GetViewport().GetVisibleRect().Size;
        _scale = Mathf.Max(0.5f, size.Y / 1080f);
        var s = _scale;
        int Px(float v) => Mathf.RoundToInt(v * s);

        _subtitleLabel.LabelSettings.FontSize = Px(32);
        _speakerLabel.LabelSettings.FontSize = Px(18);
        _promptLabel.LabelSettings.FontSize = Px(22);
        _keyLabel.LabelSettings.FontSize = Px(17);
        _objHeader.LabelSettings.FontSize = Px(14);
        _objText.LabelSettings.FontSize = Px(25);
        _skipLabel.LabelSettings.FontSize = Px(17);
        foreach (var l in new[] { _subtitleLabel, _speakerLabel, _promptLabel, _keyLabel, _objHeader, _objText, _skipLabel })
        {
            l.LabelSettings.ShadowSize = Math.Max(2, Px(5));
            l.LabelSettings.ShadowOffset = new Vector2(0, Math.Max(1, Px(2)));
        }

        _subtitle.AnchorLeft = 0.14f;
        _subtitle.AnchorRight = 0.86f;
        _subtitle.AnchorTop = 1f;
        _subtitle.AnchorBottom = 1f;
        _subtitle.OffsetLeft = 0;
        _subtitle.OffsetRight = 0;
        _subtitle.OffsetTop = -Px(230);
        _subtitle.OffsetBottom = -Px(58);
        _subtitle.AddThemeConstantOverride("separation", Px(4));

        _prompt.AnchorLeft = 0.5f;
        _prompt.AnchorRight = 0.5f;
        _prompt.AnchorTop = 1f;
        _prompt.AnchorBottom = 1f;
        _prompt.GrowHorizontal = Control.GrowDirection.Both;
        _prompt.OffsetLeft = 0;
        _prompt.OffsetRight = 0;
        _prompt.OffsetTop = -Px(292);
        _prompt.OffsetBottom = -Px(252);
        _prompt.AddThemeConstantOverride("separation", Px(12));
        _keycap.CustomMinimumSize = new Vector2(Px(32), Px(32));
        _keyStyle.SetBorderWidthAll(Math.Max(1, Px(1.5f)));
        _keyStyle.SetCornerRadiusAll(Px(5));
        _keyStyle.SetContentMarginAll(Px(4));
        _keyStyle.ContentMarginLeft = Px(9);
        _keyStyle.ContentMarginRight = Px(9);

        _objective.AnchorLeft = 0;
        _objective.AnchorTop = 0;
        _objective.OffsetLeft = Px(60);
        _objective.OffsetTop = Px(54);
        _objective.OffsetRight = Px(60 + 560);
        _objective.OffsetBottom = Px(54 + 120);
        _objective.AddThemeConstantOverride("separation", Px(6));
        _objLine.CustomMinimumSize = new Vector2(Px(40), Math.Max(1, Px(1.5f)));
        _objLine.SizeFlagsHorizontal = Control.SizeFlags.ShrinkBegin;

        _skip.AnchorLeft = 1;
        _skip.AnchorRight = 1;
        _skip.AnchorTop = 1;
        _skip.AnchorBottom = 1;
        _skip.OffsetLeft = -Px(380);
        _skip.OffsetRight = -Px(60);
        _skip.OffsetTop = -Px(100);
        _skip.OffsetBottom = -Px(56);
        _skipTrack.CustomMinimumSize = new Vector2(0, Math.Max(1, Px(2)));
    }

    // =====================================================================================
    // Subtitles, prompt, objective
    // =====================================================================================

    void SayImpl(string text, float seconds, string? speaker, bool queue)
    {
        if (string.IsNullOrWhiteSpace(text)) return;
        if (seconds <= 0f) seconds = Mathf.Clamp(1.4f + text.Length * 0.06f, 2.2f, 9f);
        var line = new Line(text, speaker, seconds);
        if (queue && _subVisible)
        {
            _queue.Enqueue(line);
            return;
        }
        _queue.Clear();
        ShowLine(line);
    }

    void ShowLine(Line line)
    {
        _speakerLabel.Text = string.IsNullOrEmpty(line.Speaker) ? "" : line.Speaker.ToUpperInvariant();
        _speakerLabel.Visible = !string.IsNullOrEmpty(line.Speaker);
        _subtitleLabel.Text = line.Text;
        _subTimer = line.Seconds;
        var wasVisible = _subVisible;
        _subVisible = true;
        _subTween?.Kill();
        _subTween = CreateTween();
        if (!wasVisible) _subtitle.Modulate = new Color(1, 1, 1, 0);
        _subTween.TweenProperty(_subtitle, "modulate:a", 1.0, wasVisible ? 0.12 : 0.25);
    }

    void ClearSubtitlesImpl()
    {
        _queue.Clear();
        if (!_subVisible) return;
        _subVisible = false;
        _subTween?.Kill();
        _subTween = CreateTween();
        _subTween.TweenProperty(_subtitle, "modulate:a", 0.0, 0.35);
    }

    void ShowPromptImpl(string text, string? key)
    {
        _promptLabel.Text = text;
        _keyLabel.Text = key ?? KeyName("interact", "E");
        _promptTarget = 1f;
    }

    void OnObjectiveChanged(string text, Node3D? target)
    {
        var s = _scale;
        _objTween?.Kill();
        _objTween = CreateTween();
        if (_objective.Modulate.A > 0.01f) _objTween.TweenProperty(_objective, "modulate:a", 0.0, 0.3);
        _objTween.TweenCallback(Callable.From(() => _objText.Text = text));
        if (string.IsNullOrEmpty(text)) return;
        var x = 60f * s;
        _objTween.TweenProperty(_objective, "modulate:a", 1.0, 0.9).SetTrans(Tween.TransitionType.Sine);
        _objTween.Parallel().TweenProperty(_objective, "position:x", x, 0.9).From(x - 16f * s)
            .SetTrans(Tween.TransitionType.Cubic).SetEase(Tween.EaseType.Out);
        _objTween.TweenInterval(8.0);
        _objTween.TweenProperty(_objective, "modulate:a", 0.6, 2.0);
    }

    // =====================================================================================
    // FX
    // =====================================================================================

    static float DefaultOf(string name) => name switch
    {
        "exposure" or "fog" or "bloom" or "contrast" or "saturation" or "volume" => 1f,
        "heartrate" => 70f,
        _ => 0f,
    };

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
            case "fade" when color != null:
                _fadeColor = color.Value;
                break;
            case "flash":
                _flashColor = color ?? new Color(0.86f, 0.9f, 1f);
                break;
            case "fade" or "vignette" or "blur" or "darken" or "desaturate" or "shake" or "letterbox" or "heartbeat"
                or "heartrate" or "exposure" or "fog" or "bloom" or "contrast" or "saturation" or "temperature"
                or "tint" or "grain" or "volume":
                break;
            default:
                Log.WarnOnce("fx:" + name, $"Unknown screen effect '{effect}'.");
                return;
        }
        var c = GetChannel(name);
        c.Mode = name switch
        {
            "flash" => 1,
            "shake" => 2,
            _ => 0,
        };
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
        return u is >= 0f and <= 1f ? MathF.Sin(u * MathF.PI) : 0f;
    }

    static float HeartEnvelope(float p) => Mathf.Max(Bump(p, 0f, 0.13f), 0.62f * Bump(p, 0.2f, 0.15f));

    public override void _Process(double delta)
    {
        var dt = (float)delta;
        _time += dt;

        foreach (var c in _channels.Values)
        {
            if (c.Time >= c.Duration) continue;
            c.Time += dt;
            var x = c.Duration > 0 ? Mathf.Clamp(c.Time / c.Duration, 0f, 1f) : 1f;
            c.Value = c.Mode switch
            {
                1 => x >= 1f ? 0f : c.From * LightFlicker.FlashPattern(x),
                2 => c.From * (1f - x) * (1f - x),
                _ => Mathf.Lerp(c.From, c.To, Easing.Smooth(x)),
            };
        }

        // Heartbeat
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
                if (heart > 0.1f) Sfx.TryPlay(Sfx.Exists("heartbeat") ? "heartbeat" : "heartbeat_single", null, Mathf.Clamp(heart, 0f, 1f), 1f, notify: false);
            }
            else if (prev == 0f) Beat?.Invoke(heart);
            pulse = heart * HeartEnvelope(_heartPhase);
        }
        else _heartPhase = 0f;

        UpdateShader(pulse);
        UpdateShake();
        UpdateEnvironment();
        UpdateUi(dt);
    }

    static float Screen(float a, float b) => 1f - (1f - Mathf.Clamp(a, 0f, 1f)) * (1f - Mathf.Clamp(b, 0f, 1f));

    void UpdateShader(float pulse)
    {
        var vignette = Screen(_baseVignette, Ch("vignette"));
        var grain = Screen(_baseGrain, Ch("grain"));
        var temperature = Mathf.Clamp(_baseTemperature + Ch("temperature"), -1f, 1f);
        var tint = Mathf.Clamp(_baseTint + Ch("tint"), -1f, 1f);
        float blur = Ch("blur"), darken = Ch("darken"), desat = Ch("desaturate"), flash = Ch("flash"), fade = Ch("fade"), lb = Ch("letterbox");
        var active = vignette + grain + Mathf.Abs(temperature) + Mathf.Abs(tint) + blur + darken + desat + flash + fade + lb + pulse > 0.002f;
        _fx.Visible = active;
        if (!active) return;
        _fxMat.SetShaderParameter("vignette", vignette);
        _fxMat.SetShaderParameter("grain", grain);
        _fxMat.SetShaderParameter("temperature", temperature);
        _fxMat.SetShaderParameter("tint", tint);
        _fxMat.SetShaderParameter("blur", blur);
        _fxMat.SetShaderParameter("darken", darken);
        _fxMat.SetShaderParameter("desaturate", desat);
        _fxMat.SetShaderParameter("flash", flash);
        _fxMat.SetShaderParameter("flash_color", new Vector3(_flashColor.R, _flashColor.G, _flashColor.B));
        _fxMat.SetShaderParameter("fade", fade);
        _fxMat.SetShaderParameter("fade_color", new Vector3(_fadeColor.R, _fadeColor.G, _fadeColor.B));
        _fxMat.SetShaderParameter("letterbox", lb);
        _fxMat.SetShaderParameter("pulse", pulse);
    }

    void UpdateShake()
    {
        var shake = Ch("shake");
        var cam = GetViewport().GetCamera3D();
        if (_shakeCam != null && (_shakeCam != cam || shake <= 0.0001f))
        {
            if (IsInstanceValid(_shakeCam))
            {
                _shakeCam.HOffset = 0f;
                _shakeCam.VOffset = 0f;
            }
            _shakeCam = null;
        }
        if (shake <= 0.0001f || cam == null) return;
        var a = shake * shake * 0.14f;
        var t = _time;
        cam.HOffset = a * (MathF.Sin(t * 37.1f) + 0.5f * MathF.Sin(t * 23.3f + 1.3f)) / 1.5f;
        cam.VOffset = a * (MathF.Sin(t * 41.7f + 0.4f) + 0.5f * MathF.Sin(t * 19.1f)) / 1.5f;
        _shakeCam = cam;
    }

    void UpdateEnvironment()
    {
        float exposure = Ch("exposure"), fog = Ch("fog"), bloom = Ch("bloom"), contrast = Ch("contrast"), saturation = Ch("saturation");
        var changed = MathF.Abs(exposure - 1f) + MathF.Abs(fog - 1f) + MathF.Abs(bloom - 1f) + MathF.Abs(contrast - 1f) + MathF.Abs(saturation - 1f) > 0.0005f;
        if (changed || _envApplied)
        {
            EnvironmentFx.Current?.ApplyMultipliers(exposure, fog, bloom, contrast, saturation);
            _envApplied = changed;
        }
        if (_channels.TryGetValue("volume", out var vol) && (vol.Time < vol.Duration || vol.Time == 0f))
            Sfx.SetMasterVolume(vol.Value);
    }

    void UpdateUi(float dt)
    {
        var show = !Cutscenes.InputBlocked && Ch("fade") < 0.5f;
        _gameplayAlpha = Mathf.MoveToward(_gameplayAlpha, show ? 1f : 0f, dt * 3f);
        _gameplay.Modulate = new Color(1, 1, 1, _gameplayAlpha);

        _promptAlpha = Mathf.MoveToward(_promptAlpha, _promptTarget, dt * 7f);
        _prompt.Modulate = new Color(1, 1, 1, _promptAlpha);

        if (_subVisible)
        {
            _subTimer -= dt;
            if (_subTimer <= 0f)
            {
                if (_queue.Count > 0) ShowLine(_queue.Dequeue());
                else ClearSubtitlesImpl();
            }
        }

        _marker.QueueRedraw();
    }

    // =====================================================================================
    // Waypoint marker
    // =====================================================================================

    void DrawMarker()
    {
        var target = Story.ObjectiveTarget;
        var cam = GetViewport().GetCamera3D();
        var want = Story.PointerVisible && target != null && IsInstanceValid(target) && cam != null;
        _markerAlpha = Mathf.MoveToward(_markerAlpha, want ? 1f : 0f, (float)GetProcessDeltaTime() * 0.8f);
        if (!want || _markerAlpha <= 0.001f || target == null || cam == null) return;

        if (_markerTarget != target)
        {
            _markerTarget = target;
            _markerLocal = target.GlobalTransform.AffineInverse() * Entities.FocusPoint(target);
        }
        var world = target.GlobalTransform * _markerLocal;
        var from = PlayerController.Instance?.GlobalPosition ?? cam.GlobalPosition;
        var dist = from.DistanceTo(world);
        var near = Mathf.Clamp((dist - 1.5f) / 2f, 0f, 1f);
        var alpha = _markerAlpha * near * (0.72f + 0.18f * MathF.Sin(_time * 2.2f));
        if (alpha <= 0.002f) return;

        var s = _scale;
        var size = GetViewport().GetVisibleRect().Size;
        var margin = 70f * s;
        var behind = cam.IsPositionBehind(world);
        var p = cam.UnprojectPosition(world);
        var color = new Color(MarkerColor, alpha);
        var shadow = new Color(0, 0, 0, alpha * 0.45f);
        var inside = !behind && p.X > margin && p.X < size.X - margin && p.Y > margin && p.Y < size.Y - margin;
        if (inside)
        {
            var r = 9f * s;
            Vector2[] diamond = { p + new Vector2(0, -r), p + new Vector2(r, 0), p + new Vector2(0, r), p + new Vector2(-r, 0), p + new Vector2(0, -r) };
            var shadowPts = new Vector2[diamond.Length];
            for (var i = 0; i < diamond.Length; i++) shadowPts[i] = diamond[i] + new Vector2(0, 1.5f * s);
            _marker.DrawPolyline(shadowPts, shadow, 2.5f * s, true);
            _marker.DrawPolyline(diamond, color, 1.6f * s, true);
            _marker.DrawCircle(p, 2.2f * s, color);
            var text = $"{Mathf.RoundToInt(dist)} m";
            var fs = Mathf.RoundToInt(15 * s);
            _marker.DrawString(_regular, p + new Vector2(-60 * s, r + 20 * s + 1.5f * s), text, HorizontalAlignment.Center, 120 * s, fs, shadow);
            _marker.DrawString(_regular, p + new Vector2(-60 * s, r + 20 * s), text, HorizontalAlignment.Center, 120 * s, fs, color);
            return;
        }

        // Off-screen: a chevron on the screen edge pointing toward the target.
        var center = size / 2f;
        var dir = p - center;
        if (behind) dir = -dir;
        if (dir.LengthSquared() < 1f) dir = new Vector2(0, 1);
        dir = dir.Normalized();
        var half = center - new Vector2(margin, margin);
        var k = Mathf.Min(MathF.Abs(half.X / (dir.X == 0 ? 1e-4f : dir.X)), MathF.Abs(half.Y / (dir.Y == 0 ? 1e-4f : dir.Y)));
        var tip = center + dir * k;
        var side = new Vector2(-dir.Y, dir.X);
        var len = 11f * s;
        Vector2[] chevron = { tip - dir * len + side * len * 0.8f, tip, tip - dir * len - side * len * 0.8f };
        _marker.DrawPolyline(chevron, shadow, 3.2f * s, true);
        _marker.DrawPolyline(chevron, color, 2f * s, true);
    }
}
