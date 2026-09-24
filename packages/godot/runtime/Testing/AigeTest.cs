using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text.Json;
using Godot;

namespace Aige;

/// <summary>
/// Automated play-test harness (autoload <c>AigeTest</c>). Inactive unless Godot is started with
/// <c>-- --aige-test=&lt;test.json&gt; --aige-report=&lt;report.json&gt; [--aige-scene=res://…tscn]</c>.
/// It plays scripted inputs, teleports and camera poses, probes entity positions, takes
/// screenshots (windowed runs only), records story events and errors, writes a JSON report and
/// quits. See packages/godot/README.md for the file formats.
/// </summary>
public partial class AigeTest : Node
{
    sealed class InputStep
    {
        public float At, Duration;
        public string? Action;
        public string Type = "tap";
        public Vector2? Look;
    }

    sealed class TeleportStep
    {
        public float At;
        public string Entity = "";
        public Vector3 Position;
        public float? Yaw;
    }

    sealed record Event(float T, string Type, (string key, object? value)[] Data);

    /// <summary>True when a test is running (scripts can use it to skip menus, mouse capture...).</summary>
    public static bool Active { get; private set; }

    /// <summary>Seconds since the test started (0 when inactive).</summary>
    public static float Time => Instance?._t ?? 0f;

    /// <summary>The autoload instance.</summary>
    public static AigeTest? Instance { get; private set; }

    string _testPath = "", _reportPath = "", _scenePath = "", _capturePrefix = "";
    float _seconds = 30f, _timeScale = 1f;
    bool _skipCutscenes, _quitAfterCaptures, _headless;
    readonly List<InputStep> _inputs = new();
    readonly List<TeleportStep> _teleports = new();
    readonly List<string> _probeNames = new();
    readonly List<float> _captureAt = new();
    readonly List<(float at, string path)> _plays = new();
    readonly List<string> _startFlags = new();
    int _nextPlay;
    Vector3 _camPos, _camTarget;
    float _camFov = 60f, _camAt = -1f;
    Camera3D? _camera;

    readonly List<(float at, string action)> _releases = new();
    readonly List<(Vector2 perSecond, float until)> _looks = new();
    readonly List<Event> _events = new();
    readonly Dictionary<string, List<(float t, Vector3? pos, float yaw)>> _probes = new();
    readonly List<string> _shots = new();
    AigeLogger? _logger;
    float _t, _probeTimer;
    int _nextInput, _nextTeleport, _nextCapture, _pendingCaptures, _waitFrames;
    bool _started, _finished, _written;

    public override void _EnterTree()
    {
        Instance = this;
        foreach (var arg in OS.GetCmdlineUserArgs())
        {
            if (arg.StartsWith("--aige-test=")) _testPath = Unquote(arg["--aige-test=".Length..]);
            else if (arg.StartsWith("--aige-report=")) _reportPath = Unquote(arg["--aige-report=".Length..]);
            else if (arg.StartsWith("--aige-scene=")) _scenePath = Unquote(arg["--aige-scene=".Length..]);
        }
        Active = _testPath != "";
        if (!Active) return;
        _logger = new AigeLogger();
        OS.AddLogger(_logger);
    }

    static string Unquote(string s) => s.Trim().Trim('"');

    public override void _Ready()
    {
        if (!Active)
        {
            SetProcess(false);
            SetPhysicsProcess(false);
            return;
        }
        ProcessMode = ProcessModeEnum.Always;
        ProcessPhysicsPriority = -1000;
        _headless = DisplayServer.GetName() == "headless";
        if (_reportPath == "") _reportPath = Path.ChangeExtension(_testPath, null) + ".report.json";
        AppDomain.CurrentDomain.UnhandledException += (_, e) =>
        {
            _logger?.AddError("Unhandled exception: " + e.ExceptionObject, crash: true);
            WriteReport("crash");
        };

        if (!LoadTest()) return;
        Subscribe();
        Engine.TimeScale = _timeScale;
        Cutscenes.AutoSkip = _skipCutscenes;
        foreach (var f in _startFlags) Story.SetFlag(f);
        if (_scenePath != "") GetTree().CallDeferred(SceneTree.MethodName.ChangeSceneToFile, _scenePath);
        GD.Print($"[aige-test] {_testPath} → {_reportPath} ({_seconds} s{(_headless ? ", headless" : "")})");
    }

    bool LoadTest()
    {
        JsonElement? root = null;
        try
        {
            root = AigeJson.Parse(System.IO.File.ReadAllText(_testPath), _testPath);
        }
        catch (Exception e)
        {
            _logger?.AddError($"Cannot read test file '{_testPath}': {e.Message}");
        }
        if (root is not { } r)
        {
            _logger?.AddError($"Invalid test file '{_testPath}'.");
            Finish("bad_test");
            return false;
        }
        _seconds = r.Num("seconds", 30f);
        _timeScale = Mathf.Max(0.01f, r.Num("timeScale", 1f));
        _skipCutscenes = r.Bool("skipCutscenes", false);
        _quitAfterCaptures = r.Bool("quitAfterCaptures", false);
        _capturePrefix = r.Str("capturePrefix") ?? ProjectSettings.GlobalizePath("user://aige-shot");
        if (_capturePrefix.StartsWith("res://") || _capturePrefix.StartsWith("user://")) _capturePrefix = ProjectSettings.GlobalizePath(_capturePrefix);
        else if (!Path.IsPathRooted(_capturePrefix)) _capturePrefix = Path.GetFullPath(Path.Combine(Path.GetDirectoryName(Path.GetFullPath(_testPath)) ?? "", _capturePrefix));
        foreach (var t in r.Arr("teleport"))
        {
            t.TryVec3("position", out var p);
            _teleports.Add(new TeleportStep { At = t.Num("at", 0f), Entity = t.Str("entity") ?? "", Position = p, Yaw = t.NumOrNull("yaw") });
        }
        foreach (var i in r.Arr("inputs"))
        {
            var step = new InputStep
            {
                At = i.Num("at", 0f),
                Action = i.Str("action"),
                Type = i.Str("type") ?? "tap",
                Duration = i.Num("duration", 0f),
            };
            if (i.TryVec3("look", out var look)) step.Look = new Vector2(look.X, look.Y);
            _inputs.Add(step);
        }
        foreach (var p in r.Arr("probes"))
            if (p.ValueKind == JsonValueKind.String) _probeNames.Add(p.GetString()!);
        // "flags": story flags set before the scene starts (e.g. skip the intro); "play": [{at, cutscene}] starts cutscenes
        foreach (var f in r.Arr("flags"))
            if (f.ValueKind == JsonValueKind.String) _startFlags.Add(f.GetString()!);
        foreach (var p in r.Arr("play"))
            if (p.Str("cutscene") is { } cs) _plays.Add((p.Num("at", 0f), cs));
        _plays.Sort((a, b) => a.at.CompareTo(b.at));
        foreach (var c in r.Arr("captureAt"))
            if (c.ValueKind == JsonValueKind.Number) _captureAt.Add((float)c.GetDouble());
        if (r.Get("camera") is { } cam)
        {
            cam.TryVec3("position", out _camPos);
            cam.TryVec3("target", out _camTarget);
            _camFov = cam.Num("fov", 60f);
            _camAt = cam.Num("at", 0f);
        }
        _inputs.Sort((a, b) => a.At.CompareTo(b.At));
        _teleports.Sort((a, b) => a.At.CompareTo(b.At));
        _captureAt.Sort();
        foreach (var n in _probeNames) _probes[n] = new List<(float, Vector3?, float)>();
        return true;
    }

    void Subscribe()
    {
        Story.FlagSet += f => Record("flag_set", ("flag", f));
        Story.FlagCleared += f => Record("flag_cleared", ("flag", f));
        Story.ItemGiven += i => Record("item_given", ("item", i));
        Story.ItemTaken += i => Record("item_taken", ("item", i));
        Story.ObjectiveChanged += (text, target) => Record("objective", ("text", text), ("target", target?.Name.ToString()));
        Story.PointerRevealed += target => Record("log", ("message", $"waypoint pointer shown: {target.Name}"));
        Story.Emitted += n => Record("emit", ("name", n));
        Interactable.AnyInteracted += (i, _) => Record("interact", ("entity", Entities.NameOf(i.Entity)), ("prompt", i.Prompt));
        Door.AnyToggled += (d, open) => Record("door_open", ("entity", Entities.NameOf(d.Entity)), ("open", open));
        Door.AnyLocked += d => Record("door_locked", ("entity", Entities.NameOf(d.Entity)), ("text", d.LockedText));
        Trigger.AnyFired += (tr, body) => Record("trigger", ("entity", Entities.NameOf(tr.Entity)), ("body", Entities.NameOf(body)));
        Cutscenes.Started += (name, path) => Record("cutscene_start", ("name", name), ("path", path));
        Cutscenes.Finished += (name, skipped) => Record("cutscene_end", ("name", name), ("skipped", skipped));
        Voice.Started += (id, speaker, text) => Record("voice", ("id", id), ("speaker", speaker), ("text", text));
        Sfx.Played += (name, found) => Record("sound", ("name", name), ("found", found));
        Log.Message += m => Record("log", ("message", m));
    }

    void Record(string type, params (string key, object? value)[] data)
    {
        if (!_written) _events.Add(new Event(MathF.Round(_t, 2), type, data));
    }

    public override void _PhysicsProcess(double delta)
    {
        if (!Active || _finished) return;
        if (_logger is { Crashed: true })
        {
            Finish("crash");
            return;
        }
        if (!_started)
        {
            var scene = GetTree().CurrentScene;
            if (scene != null && (_scenePath == "" || scene.SceneFilePath == _scenePath)) _started = true;
            else
            {
                if (++_waitFrames > 600)
                {
                    _logger?.AddError($"Scene '{(_scenePath == "" ? "main scene" : _scenePath)}' did not load.");
                    Finish("scene_not_loaded");
                }
                return;
            }
        }

        var dt = (float)delta;
        _t += dt;

        while (_nextTeleport < _teleports.Count && _teleports[_nextTeleport].At <= _t) DoTeleport(_teleports[_nextTeleport++]);
        while (_nextPlay < _plays.Count && _plays[_nextPlay].at <= _t) Cutscenes.Play(_plays[_nextPlay++].path);
        for (var i = _releases.Count - 1; i >= 0; i--)
        {
            if (_releases[i].at > _t) continue;
            Release(_releases[i].action);
            _releases.RemoveAt(i);
        }
        while (_nextInput < _inputs.Count && _inputs[_nextInput].At <= _t) DoInput(_inputs[_nextInput++]);
        for (var i = _looks.Count - 1; i >= 0; i--)
        {
            PushLook(_looks[i].perSecond * dt);
            if (_t >= _looks[i].until) _looks.RemoveAt(i);
        }

        if (_camAt >= 0f && _t >= _camAt) UpdateCamera();

        _probeTimer += dt;
        if (_probeTimer >= 0.5f - 1e-4f)
        {
            _probeTimer = 0f;
            Probe();
        }

        while (_nextCapture < _captureAt.Count && _captureAt[_nextCapture] <= _t)
        {
            var at = _captureAt[_nextCapture++];
            if (_headless) Record("log", ("message", $"screenshot at {at}s skipped (headless)"));
            else Capture(at);
        }

        var capturesDone = _nextCapture >= _captureAt.Count && _pendingCaptures == 0;
        if (_quitAfterCaptures && _captureAt.Count > 0 && capturesDone) Finish("captures_done");
        else if (_t >= _seconds && _pendingCaptures == 0) Finish("done");
    }

    void DoTeleport(TeleportStep step)
    {
        var node = Entities.Find(step.Entity);
        if (node == null)
        {
            _logger?.AddError($"Test teleport: entity '{step.Entity}' not found.");
            return;
        }
        if (node is PlayerController pc) pc.Teleport(step.Position, step.Yaw);
        else Entities.Teleport(node, step.Position, step.Yaw is { } y ? new Vector3(0f, y, 0f) : null);
        Record("log", ("message", $"teleport {step.Entity} → {Fmt(step.Position)}"));
    }

    void DoInput(InputStep step)
    {
        if (step.Look is { } look)
        {
            if (step.Duration > 0f) _looks.Add((look / step.Duration, _t + step.Duration));
            else PushLook(look);
        }
        if (string.IsNullOrEmpty(step.Action)) return;
        if (!InputMap.HasAction(step.Action))
        {
            _logger?.AddError($"Test input: unknown action '{step.Action}'.");
            return;
        }
        switch (step.Type)
        {
            case "down":
                Press(step.Action);
                break;
            case "up":
                Release(step.Action);
                break;
            default:
                Press(step.Action);
                _releases.Add((_t + Mathf.Max(0.1f, step.Duration), step.Action));
                break;
        }
    }

    void Press(string action)
    {
        Input.ActionPress(action, 1f);
        GetViewport().PushInput(new InputEventAction { Action = action, Pressed = true, Strength = 1f });
    }

    void Release(string action)
    {
        Input.ActionRelease(action);
        GetViewport().PushInput(new InputEventAction { Action = action, Pressed = false });
    }

    void PushLook(Vector2 delta)
    {
        if (delta == Vector2.Zero) return;
        var center = GetViewport().GetVisibleRect().Size / 2f;
        GetViewport().PushInput(new InputEventMouseMotion { Relative = delta, ScreenRelative = delta, Position = center, GlobalPosition = center });
    }

    void UpdateCamera()
    {
        if (_camera == null)
        {
            _camera = new Camera3D { Name = "TestCamera", Fov = _camFov, Near = 0.05f, Far = 800f };
            AddChild(_camera);
            var dir = _camTarget - _camPos;
            if (dir.LengthSquared() < 1e-6f) dir = Vector3.Forward;
            var up = MathF.Abs(dir.Normalized().Dot(Vector3.Up)) > 0.999f ? Vector3.Forward : Vector3.Up;
            _camera.GlobalTransform = new Transform3D(Basis.LookingAt(dir, up), _camPos);
        }
        if (!_camera.Current) _camera.MakeCurrent();
    }

    void Probe()
    {
        var t = MathF.Round(_t, 2);
        foreach (var name in _probeNames)
        {
            var n = Entities.Find(name);
            _probes[name].Add(n == null ? (t, null, 0f) : (t, n.GlobalPosition, MathF.Round(n.GlobalRotationDegrees.Y, 1)));
        }
    }

    async void Capture(float at)
    {
        _pendingCaptures++;
        var path = $"{_capturePrefix}-{at.ToString("0.##", CultureInfo.InvariantCulture)}s.png";
        try
        {
            await ToSignal(RenderingServer.Singleton, RenderingServer.SignalName.FramePostDraw);
            var image = GetViewport().GetTexture().GetImage();
            var dir = Path.GetDirectoryName(path);
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
            var err = image.SavePng(path);
            if (err == Error.Ok) _shots.Add(path.Replace('\\', '/'));
            else _logger?.AddError($"Screenshot '{path}' failed: {err}");
        }
        catch (Exception e)
        {
            _logger?.AddError($"Screenshot '{path}' failed: {e.Message}");
        }
        finally
        {
            _pendingCaptures--;
        }
    }

    void Finish(string reason)
    {
        if (_finished) return;
        _finished = true;
        var ok = WriteReport(reason);
        foreach (var (_, action) in _releases) Input.ActionRelease(action);
        GetTree().Quit(ok ? 0 : 1);
    }

    public override void _Notification(int what)
    {
        if (what == NotificationWMCloseRequest && Active) WriteReport("closed");
    }

    public override void _ExitTree()
    {
        if (Active) WriteReport("exit");
    }

    static string Fmt(Vector3 v) => $"[{AigeJson.F(v.X)}, {AigeJson.F(v.Y)}, {AigeJson.F(v.Z)}]";

    /// <summary>Writes the report now. Returns whether the run is ok.</summary>
    bool WriteReport(string reason)
    {
        var (logs, errors) = _logger?.Snapshot() ?? (Array.Empty<string>(), Array.Empty<string>());
        var crashed = _logger?.Crashed ?? false;
        var ok = errors.Length == 0 && !crashed && reason is "done" or "captures_done";
        if (_written) return ok;
        _written = true;
        if (_logger != null)
        {
            _logger.Enabled = false;
            OS.RemoveLogger(_logger);
        }

        using var stream = new MemoryStream();
        using (var w = new Utf8JsonWriter(stream, new JsonWriterOptions { Indented = true }))
        {
            w.WriteStartObject();
            w.WriteBoolean("ok", ok);
            w.WriteString("reason", reason);
            w.WriteNumber("seconds", Math.Round(_t, 2));
            w.WriteStartArray("errors");
            foreach (var e in errors) w.WriteStringValue(e);
            w.WriteEndArray();
            w.WriteStartArray("logs");
            foreach (var l in logs) w.WriteStringValue(l);
            w.WriteEndArray();

            w.WriteStartArray("events");
            foreach (var ev in _events)
            {
                w.WriteStartObject();
                w.WriteNumber("t", ev.T);
                w.WriteString("type", ev.Type);
                w.WriteStartObject("data");
                foreach (var (key, value) in ev.Data)
                {
                    w.WritePropertyName(key);
                    WriteValue(w, value);
                }
                w.WriteEndObject();
                w.WriteEndObject();
            }
            w.WriteEndArray();

            w.WriteStartObject("probes");
            foreach (var (name, samples) in _probes)
            {
                w.WriteStartArray(name);
                foreach (var (t, pos, yaw) in samples)
                {
                    w.WriteStartObject();
                    w.WriteNumber("t", t);
                    if (pos is { } p)
                    {
                        w.WritePropertyName("position");
                        WriteValue(w, p);
                        w.WriteNumber("yaw", yaw);
                    }
                    else w.WriteBoolean("missing", true);
                    w.WriteEndObject();
                }
                w.WriteEndArray();
            }
            w.WriteEndObject();

            w.WriteStartObject("final");
            w.WritePropertyName("flags");
            WriteValue(w, Story.Flags.ToArray());
            w.WritePropertyName("inventory");
            WriteValue(w, Story.Items.ToArray());
            w.WriteString("objective", Story.Objective);
            w.WritePropertyName("cutscene");
            WriteValue(w, Cutscenes.Current);
            var scene = GetTree()?.CurrentScene;
            w.WritePropertyName("scene");
            WriteValue(w, scene == null ? null : scene.HasMeta("aige_scene") ? scene.GetMeta("aige_scene").AsString() : scene.Name.ToString());
            w.WriteEndObject();

            w.WriteStartArray("screenshots");
            foreach (var s in _shots) w.WriteStringValue(s);
            w.WriteEndArray();
            w.WriteEndObject();
        }
        try
        {
            var dir = Path.GetDirectoryName(_reportPath);
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
            System.IO.File.WriteAllBytes(_reportPath, stream.ToArray());
            GD.Print($"[aige-test] report: {_reportPath} (ok={ok.ToString().ToLowerInvariant()}, {reason})");
        }
        catch (Exception e)
        {
            GD.PrintErr($"[aige-test] cannot write report '{_reportPath}': {e.Message}");
        }
        return ok;
    }

    static void WriteValue(Utf8JsonWriter w, object? value)
    {
        switch (value)
        {
            case null:
                w.WriteNullValue();
                break;
            case string s:
                w.WriteStringValue(s);
                break;
            case bool b:
                w.WriteBooleanValue(b);
                break;
            case int i:
                w.WriteNumberValue(i);
                break;
            case float f:
                w.WriteNumberValue(Math.Round(f, 3));
                break;
            case double d:
                w.WriteNumberValue(Math.Round(d, 3));
                break;
            case Vector3 v:
                w.WriteStartArray();
                w.WriteNumberValue(Math.Round(v.X, 3));
                w.WriteNumberValue(Math.Round(v.Y, 3));
                w.WriteNumberValue(Math.Round(v.Z, 3));
                w.WriteEndArray();
                break;
            case string[] arr:
                w.WriteStartArray();
                foreach (var x in arr) w.WriteStringValue(x);
                w.WriteEndArray();
                break;
            default:
                w.WriteStringValue(value.ToString());
                break;
        }
    }
}
