#nullable enable
using System;
using System.Collections.Generic;
using System.IO;
using UnityEngine;

namespace Aige
{
    /// <summary>
    /// Automated play-test harness (inactive unless a test is given). A test comes from the command line
    /// (<c>-aige-test=&lt;test.json&gt; -aige-report=&lt;report.json&gt;</c>) or the AIGE_TEST / AIGE_REPORT environment
    /// variables (the editor's batch play-test sets them). It presses actions at scripted times, teleports
    /// entities, samples probes, takes screenshots, records story events and writes a JSON report, then quits.
    /// Positions in tests and reports are AIGE coordinates.
    /// </summary>
    [AddComponentMenu("")]
    [DefaultExecutionOrder(-1000)]
    public sealed class AigeTest : MonoBehaviour
    {
        sealed class TimedInput
        {
            public float At;
            public string? Action;
            public string Type = "tap";
            public Vector2? Look;
            public bool Done;
        }

        /// <summary>True during automated play-tests: skip menus and mouse capture.</summary>
        public static bool Active { get; private set; }

        /// <summary>Raised when the report has been written (the editor harness exits on it).</summary>
        public static event Action<string>? Completed;

        readonly List<TimedInput> _inputs = new List<TimedInput>();
        readonly List<(float at, string entity, Vector3 pos, float? yaw, bool done)> _teleports = new List<(float, string, Vector3, float?, bool)>();
        readonly List<object> _events = new List<object>();
        readonly List<string> _errors = new List<string>(), _logs = new List<string>(), _shots = new List<string>();
        readonly Dictionary<string, List<object>> _probes = new Dictionary<string, List<object>>();
        readonly List<float> _captureAt = new List<float>();
        readonly List<string> _release = new List<string>();
        string _reportPath = "", _capturePrefix = "";
        string[] _probeNames = Array.Empty<string>();
        float _seconds = 20f, _time, _nextProbe, _cameraAt;
        bool _quitAfterCaptures, _finished, _hasCamera;
        Vector3 _camPos, _camTarget;
        float _camFov = 60f;
        int _captureIndex;
        Camera? _fixedCam;

        void Awake()
        {
            var test = Arg("aige-test") ?? Environment.GetEnvironmentVariable("AIGE_TEST");
            if (string.IsNullOrEmpty(test)) return;
            _reportPath = Arg("aige-report") ?? Environment.GetEnvironmentVariable("AIGE_REPORT") ?? Path.ChangeExtension(test, ".report.json");
            var doc = AigeJson.Parse(File.Exists(test) ? File.ReadAllText(test) : null, test!);
            if (doc == null)
            {
                _errors.Add($"Test file '{test}' not found or invalid.");
                Active = true;
                Finish();
                return;
            }
            Active = true;
            AigeInput.DevicesEnabled = false;
            Time.captureFramerate = 60;
            _seconds = doc.Num("seconds", 20f);
            Time.timeScale = Mathf.Clamp(doc.Num("timeScale", 1f), 0.1f, 8f);
            Cutscenes.AutoSkip = doc.Bool("skipCutscenes", false);
            foreach (var t in doc.Arr("teleport"))
            {
                t.TryVec3("position", out var p);
                _teleports.Add((t.Num("at", 0), t.Str("entity") ?? "", p, t.NumOrNull("yaw"), false));
            }
            foreach (var i in doc.Arr("inputs"))
            {
                var look = i["look"];
                _inputs.Add(new TimedInput
                {
                    At = i.Num("at", 0),
                    Action = i.Str("action"),
                    Type = i.Str("type") ?? "tap",
                    Look = look.IsArray ? new Vector2(look[0].AsFloat(), look[1].AsFloat()) : (Vector2?)null,
                });
            }
            _inputs.Sort((a, b) => a.At.CompareTo(b.At));
            var probes = new List<string>();
            foreach (var p in doc.Arr("probes"))
                if (p.AsString != null) probes.Add(p.AsString);
            _probeNames = probes.ToArray();
            foreach (var c in doc.Arr("captureAt")) _captureAt.Add(c.AsFloat());
            _captureAt.Sort();
            _capturePrefix = doc.Str("capturePrefix") ?? Path.Combine(Path.GetDirectoryName(_reportPath) ?? ".", "shot");
            _quitAfterCaptures = doc.Bool("quitAfterCaptures", false);
            var cam = doc["camera"];
            if (cam.IsObject && cam.TryVec3("position", out var cp) && cam.TryVec3("target", out var ct))
            {
                _hasCamera = true;
                _camPos = Coords.Position(cp);
                _camTarget = Coords.Position(ct);
                _camFov = cam.Num("fov", 60f);
                _cameraAt = cam.Num("at", 0f);
            }
            Subscribe();
            Log.Info($"AIGE test: {_seconds} s, {_inputs.Count} inputs, report {_reportPath}");
        }

        static string? Arg(string name)
        {
            var args = Environment.GetCommandLineArgs();
            for (var i = 0; i < args.Length; i++)
            {
                var a = args[i].TrimStart('-');
                if (a.StartsWith(name + "=")) return a.Substring(name.Length + 1);
                if (a == name && i + 1 < args.Length) return args[i + 1];
            }
            return null;
        }

        void Event(string type, object? data = null) =>
            _events.Add(new Dictionary<string, object?> { ["t"] = Mathf.Round(_time * 100f) / 100f, ["type"] = type, ["data"] = data });

        void Subscribe()
        {
            Story.FlagSet += f => Event("flag_set", new Dictionary<string, object?> { ["flag"] = f });
            Story.FlagCleared += f => Event("flag_cleared", new Dictionary<string, object?> { ["flag"] = f });
            Story.ItemGiven += i => Event("item_given", new Dictionary<string, object?> { ["item"] = i });
            Story.ItemTaken += i => Event("item_taken", new Dictionary<string, object?> { ["item"] = i });
            Story.ObjectiveChanged += (t, target) => Event("objective", new Dictionary<string, object?> { ["text"] = t, ["target"] = target != null ? target.name : null });
            Story.Emitted += n => Event("emit", new Dictionary<string, object?> { ["name"] = n });
            Interactable.AnyInteracted += (i, _) => Event("interact", new Dictionary<string, object?> { ["entity"] = i.name, ["prompt"] = i.Prompt });
            Door.AnyToggled += (d, open) => Event("door_open", new Dictionary<string, object?> { ["entity"] = d.name, ["open"] = open });
            Door.AnyLocked += d => Event("door_locked", new Dictionary<string, object?> { ["entity"] = d.name });
            Trigger.AnyFired += (t, body) => Event("trigger", new Dictionary<string, object?> { ["entity"] = t.name, ["body"] = body.name });
            Cutscenes.Started += (n, p) => Event("cutscene_start", new Dictionary<string, object?> { ["name"] = n, ["path"] = p });
            Cutscenes.Finished += (n, s) => Event("cutscene_end", new Dictionary<string, object?> { ["name"] = n, ["skipped"] = s });
            Voice.Started += (id, speaker, text) => Event("voice", new Dictionary<string, object?> { ["id"] = id, ["speaker"] = speaker, ["text"] = text });
            Sfx.Played += (n, found) => Event("sound", new Dictionary<string, object?> { ["name"] = n, ["found"] = found });
            Log.Message += m =>
            {
                _logs.Add(m);
                Event("log", new Dictionary<string, object?> { ["message"] = m });
            };
            Log.Problem += (m, isError) =>
            {
                if (isError) _errors.Add(m);
                else _logs.Add("warning: " + m);
            };
            Application.logMessageReceived += (msg, stack, type) =>
            {
                // Editor-only noise (search indexing, package tooling) does not fail a play-test.
                if (stack.Contains("UnityEditor.") && !stack.Contains("Aige") && !stack.Contains("Assets/")) return;
                if (type == LogType.Exception) _errors.Add($"{msg}\n{stack}".Trim());
                else if (type == LogType.Error && !msg.StartsWith("[aige]")) _errors.Add(msg);
            };
        }

        void Update()
        {
            if (!Active || _finished) return;
            foreach (var a in _release) AigeInput.SetForced(a, false);
            _release.Clear();
            _time += Time.deltaTime;

            for (var i = 0; i < _teleports.Count; i++)
            {
                var t = _teleports[i];
                if (t.done || t.at > _time) continue;
                _teleports[i] = (t.at, t.entity, t.pos, t.yaw, true);
                var go = Entities.Find(t.entity);
                if (go == null) _errors.Add($"Teleport: entity '{t.entity}' not found.");
                else Entities.TeleportAige(go, t.pos, t.yaw != null ? new Vector3(0, t.yaw.Value, 0) : (Vector3?)null);
            }
            foreach (var input in _inputs)
            {
                if (input.Done || input.At > _time) continue;
                input.Done = true;
                if (input.Look != null) AigeInput.AddLook(input.Look.Value);
                if (string.IsNullOrEmpty(input.Action)) continue;
                if (input.Type == "down") AigeInput.SetForced(input.Action!, true);
                else if (input.Type == "up") AigeInput.SetForced(input.Action!, false);
                else
                {
                    AigeInput.SetForced(input.Action!, true);
                    _release.Add(input.Action!);
                }
            }
            if (_time >= _nextProbe)
            {
                _nextProbe += 0.5f;
                foreach (var name in _probeNames)
                {
                    var go = Entities.Find(name);
                    if (go == null) continue;
                    if (!_probes.TryGetValue(name, out var list)) _probes[name] = list = new List<object>();
                    list.Add(new Dictionary<string, object?>
                    {
                        ["t"] = Mathf.Round(_time * 100f) / 100f,
                        ["position"] = Coords.ToAige(go.transform.position),
                        ["yaw"] = Mathf.Round(Mathf.DeltaAngle(0f, -go.transform.eulerAngles.y) * 10f) / 10f,
                    });
                }
            }
            if (_hasCamera && _time >= _cameraAt) PlaceFixedCamera();
            if (_captureIndex < _captureAt.Count && _time >= _captureAt[_captureIndex])
            {
                Capture($"{_capturePrefix}-{_captureIndex}.png");
                _captureIndex++;
                if (_quitAfterCaptures && _captureIndex >= _captureAt.Count) Finish();
            }
            if (_time >= _seconds) Finish();
        }

        void PlaceFixedCamera()
        {
            if (_fixedCam == null)
            {
                _fixedCam = new GameObject("AigeTestCamera").AddComponent<Camera>();
                var data = _fixedCam.gameObject.AddComponent<UnityEngine.Rendering.Universal.UniversalAdditionalCameraData>();
                data.renderPostProcessing = true;
                _fixedCam.depth = 100;
            }
            _fixedCam.transform.position = _camPos;
            _fixedCam.transform.rotation = Quaternion.LookRotation(_camTarget - _camPos, Vector3.up);
            _fixedCam.fieldOfView = _camFov;
            _fixedCam.nearClipPlane = 0.05f;
        }

        void Capture(string path)
        {
            var cam = _fixedCam != null ? _fixedCam : Entities.ActiveCamera;
            if (cam == null)
            {
                _errors.Add("Screenshot: no camera.");
                return;
            }
            try
            {
                var w = Screen.width > 64 ? Screen.width : 1280;
                var h = Screen.height > 64 ? Screen.height : 720;
                var rt = RenderTexture.GetTemporary(w, h, 24, RenderTextureFormat.ARGB32);
                var prev = cam.targetTexture;
                cam.targetTexture = rt;
                cam.Render();
                cam.targetTexture = prev;
                var active = RenderTexture.active;
                RenderTexture.active = rt;
                var tex = new Texture2D(w, h, TextureFormat.RGB24, false);
                tex.ReadPixels(new Rect(0, 0, w, h), 0, 0);
                tex.Apply();
                RenderTexture.active = active;
                RenderTexture.ReleaseTemporary(rt);
                Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(path)) ?? ".");
                File.WriteAllBytes(path, tex.EncodeToPNG());
                Destroy(tex);
                _shots.Add(Path.GetFullPath(path));
            }
            catch (Exception e)
            {
                _errors.Add($"Screenshot failed: {e.Message}");
            }
        }

        void Finish()
        {
            if (_finished) return;
            _finished = true;
            var report = new Dictionary<string, object?>
            {
                ["ok"] = _errors.Count == 0,
                ["seconds"] = Mathf.Round(_time * 100f) / 100f,
                ["errors"] = _errors,
                ["logs"] = _logs,
                ["events"] = _events,
                ["probes"] = _probes,
                ["final"] = new Dictionary<string, object?>
                {
                    ["flags"] = new List<string>(Story.Flags),
                    ["inventory"] = new List<string>(Story.Items),
                    ["objective"] = Story.Objective,
                    ["cutscene"] = Cutscenes.Current,
                    ["scene"] = UnityEngine.SceneManagement.SceneManager.GetActiveScene().name,
                },
                ["screenshots"] = _shots,
            };
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(_reportPath)) ?? ".");
                File.WriteAllText(_reportPath, AigeJson.Write(report));
            }
            catch (Exception e)
            {
                Debug.LogError($"[aige] Could not write the test report: {e.Message}");
            }
            Completed?.Invoke(_reportPath);
#if UNITY_EDITOR
            UnityEditor.EditorApplication.isPlaying = false;
#else
            Application.Quit(_errors.Count == 0 ? 0 : 1);
#endif
        }
    }
}
