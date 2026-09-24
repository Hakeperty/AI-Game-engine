#nullable enable
using System;
using System.Collections;
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.Rendering.Universal;

namespace Aige
{
    /// <summary>
    /// Cutscene player for AIGE CutsceneDocs (Resources/aige/cutscenes/*.cutscene.json): camera shots with
    /// easing, FOV and depth of field, character animation and movement, voice lines, sounds, subtitles,
    /// screen FX, light tweens and story events. Player input is blocked while one plays; hold skip to skip.
    /// <code>
    /// Cutscenes.Play("cutscenes/cs1_wake.cutscene.json");
    /// Cutscenes.Play("cs3_weapon", () =&gt; Story.SetObjective("Explore the house"));
    /// if (Cutscenes.IsPlaying) return;
    /// </code>
    /// </summary>
    [AddComponentMenu("")]
    [DefaultExecutionOrder(800)]
    public sealed class Cutscenes : MonoBehaviour
    {
        sealed class Run
        {
            public CutsceneDoc Doc = null!;
            public float Time, Length;
            public bool[][] Fired = null!;
            public bool[] MoveDone = null!;
            public Action? OnFinished;
            public readonly Dictionary<string, GameObject?> Refs = new Dictionary<string, GameObject?>();
        }

        public static Cutscenes? Instance { get; private set; }

        /// <summary>(name, path).</summary>
        public static event Action<string, string>? Started;
        /// <summary>(name, skipped).</summary>
        public static event Action<string, bool>? Finished;

        /// <summary>Skip every cutscene as soon as it starts (tests with skipCutscenes).</summary>
        public static bool AutoSkip { get; set; }
        public static float SkipHoldSeconds { get; set; } = 1f;

        public static bool IsPlaying => Instance != null && Instance._run != null;

        /// <summary>True while player input must be ignored (a cutscene plays or one ended without returning control).</summary>
        public static bool InputBlocked => Instance != null && (Instance._run != null || Instance._locked);

        public static string? Current => Instance?._run?.Doc.Name;
        public static float Time => Instance?._run?.Time ?? 0f;

        /// <summary>The dedicated cutscene camera (enabled only while it is in use).</summary>
        public static Camera? Camera => Instance != null ? Instance._cam : null;

        readonly Queue<(CutsceneDoc doc, Action? done)> _queue = new Queue<(CutsceneDoc, Action?)>();
        readonly Dictionary<Light, Coroutine> _lightTweens = new Dictionary<Light, Coroutine>();
        readonly Dictionary<GameObject, Vector3> _focusLocal = new Dictionary<GameObject, Vector3>();
        Run? _run;
        bool _locked, _skipArmed, _skipRequested;
        float _skipHold;
        Camera _cam = null!;
        Camera? _gameplayCamera;

        void Awake()
        {
            Instance = this;
            var go = new GameObject("CutsceneCamera");
            go.transform.SetParent(transform, false);
            _cam = go.AddComponent<Camera>();
            _cam.nearClipPlane = 0.05f;
            _cam.farClipPlane = 800f;
            _cam.fieldOfView = 50f;
            _cam.depth = 50;
            var data = go.AddComponent<UniversalAdditionalCameraData>();
            data.renderPostProcessing = true;
            data.antialiasing = AntialiasingMode.SubpixelMorphologicalAntiAliasing;
            _cam.enabled = false;
        }

        void OnDestroy()
        {
            if (Instance == this) Instance = null;
        }

        /// <summary>Plays a cutscene by path or name; queued if one is playing. False when missing or invalid.</summary>
        public static bool Play(string pathOrName, Action? onFinished = null)
        {
            var self = Instance;
            if (self == null) return false;
            var doc = CutsceneDoc.Load(pathOrName);
            if (doc == null) return false;
            if (self._run != null) self._queue.Enqueue((doc, onFinished));
            else self.StartRun(doc, onFinished);
            return true;
        }

        /// <summary>Skips the running cutscene: remaining story events still apply, speech and sounds do not.</summary>
        public static void Skip()
        {
            if (Instance != null && Instance._run != null) Instance._skipRequested = true;
        }

        /// <summary>Gives control back after a cutscene that ended with returnControl: false.</summary>
        public static void ReturnControl() => Instance?.ReturnControlImpl();

        void StartRun(CutsceneDoc doc, Action? onFinished)
        {
            var current = Entities.ActiveCamera;
            if (!_locked) _gameplayCamera = current != _cam ? current : null;
            if (current != null && current != _cam)
            {
                _cam.transform.SetPositionAndRotation(current.transform.position, current.transform.rotation);
                _cam.fieldOfView = current.fieldOfView;
            }
            SetCutsceneCamera(true);
            var fired = new bool[doc.Tracks.Count][];
            for (var i = 0; i < doc.Tracks.Count; i++) fired[i] = new bool[doc.Tracks[i].Items.Count];
            _run = new Run { Doc = doc, Length = doc.Length, Fired = fired, MoveDone = new bool[doc.Tracks.Count], OnFinished = onFinished };
            _focusLocal.Clear();
            _skipHold = 0f;
            _skipArmed = !AigeInput.Pressed("skip");
            Hud.HidePrompt();
            Hud.Fx("letterbox", doc.Letterbox ? 1f : 0f, 0.8f);
            Log.Info($"Cutscene '{doc.Name}' ({AigeJson.F(_run.Length)} s)");
            Started?.Invoke(doc.Name, doc.Path);
            if (AutoSkip) _skipRequested = true;
            Evaluate(0f);
        }

        void SetCutsceneCamera(bool on)
        {
            _cam.enabled = on;
            var listener = _cam.GetComponent<AudioListener>();
            if (on && _gameplayCamera != null) _gameplayCamera.enabled = false;
            if (!on)
            {
                Hud.SetDepthOfField(0f, 0f);
                if (listener != null) Destroy(listener);
            }
            else if (listener == null && FindAnyObjectByType<AudioListener>() == null) _cam.gameObject.AddComponent<AudioListener>();
        }

        void Update()
        {
            if (_run == null)
            {
                if (_queue.Count > 0)
                {
                    var (doc, done) = _queue.Dequeue();
                    StartRun(doc, done);
                }
                return;
            }
            if (_skipRequested)
            {
                _skipRequested = false;
                SkipNow();
                return;
            }
            var dt = UnityEngine.Time.deltaTime;
            if (_run.Doc.Skippable)
            {
                var held = AigeInput.Pressed("skip");
                if (!held) _skipArmed = true;
                if (_skipArmed && held)
                {
                    _skipHold += dt;
                    Hud.SetSkipProgress(_skipHold / SkipHoldSeconds);
                    if (_skipHold >= SkipHoldSeconds)
                    {
                        SkipNow();
                        return;
                    }
                }
                else if (_skipHold > 0f)
                {
                    _skipHold = 0f;
                    Hud.SetSkipProgress(-1f);
                }
            }
            _run.Time += dt;
            Evaluate(_run.Time);
            if (_run != null && _run.Time >= _run.Length) Finish(false);
        }

        void Evaluate(float t)
        {
            var run = _run!;
            var tracks = run.Doc.Tracks;
            for (var ti = 0; ti < tracks.Count && _run == run; ti++)
            {
                var tr = tracks[ti];
                switch (tr.Type)
                {
                    case "camera":
                        if (tr.CameraKeys.Count > 0) ApplyCamera(tr.CameraKeys, t);
                        break;
                    case "move":
                        if (tr.MoveKeys.Count > 0 && !run.MoveDone[ti] && t >= tr.MoveKeys[0].T)
                        {
                            ApplyMove(tr, t);
                            if (t >= tr.MoveKeys[tr.MoveKeys.Count - 1].T) run.MoveDone[ti] = true;
                        }
                        break;
                    default:
                        var fired = run.Fired[ti];
                        for (var i = 0; i < tr.Items.Count; i++)
                        {
                            if (fired[i]) continue;
                            if (tr.Items[i].T > t) break;
                            fired[i] = true;
                            Fire(tr, tr.Items[i]);
                            if (_run != run) return;
                        }
                        break;
                }
            }
        }

        void SkipNow()
        {
            var run = _run;
            if (run == null) return;
            Voice.Stop();
            Hud.ClearSubtitles();
            var tracks = run.Doc.Tracks;
            for (var ti = 0; ti < tracks.Count; ti++)
            {
                var tr = tracks[ti];
                if (tr.Type == "move")
                {
                    if (tr.MoveKeys.Count > 0 && !run.MoveDone[ti]) ApplyMove(tr, float.MaxValue);
                    continue;
                }
                var fired = run.Fired[ti];
                CutsceneItemDoc? lastClip = null;
                for (var i = 0; i < tr.Items.Count; i++)
                {
                    if (fired[i]) continue;
                    fired[i] = true;
                    var it = tr.Items[i];
                    switch (tr.Type)
                    {
                        case "event": ApplyEvent(it); break;
                        case "fx":
                            if (it.Effect != "flash" && it.Effect != "shake") Hud.Fx(it.Effect ?? "", it.To, 0f, it.Color);
                            break;
                        case "light": TweenLight(it, true); break;
                        case "animation": lastClip = it; break;
                    }
                }
                if (lastClip != null) AigeAnimator.Of(Ref(tr.Actor))?.Play(lastClip.Clip ?? "", 0.2f, lastClip.Loop, lastClip.Speed);
            }
            Log.Info($"Cutscene '{run.Doc.Name}' skipped");
            Finish(true);
        }

        void Finish(bool skipped)
        {
            var run = _run;
            if (run == null) return;
            _run = null;
            Hud.SetSkipProgress(-1f);
            if (run.Doc.ReturnControl) ReturnControlImpl();
            else _locked = true;
            Finished?.Invoke(run.Doc.Name, skipped);
            run.OnFinished?.Invoke();
        }

        void ReturnControlImpl()
        {
            _locked = false;
            if (_run != null) return;
            if (Hud.GetFx("letterbox") > 0f) Hud.Fx("letterbox", 0f, 0.6f);
            var cam = _gameplayCamera != null ? _gameplayCamera : ThirdPersonCamera.Current != null ? ThirdPersonCamera.Current.Camera : null;
            if (cam != null) cam.enabled = true;
            SetCutsceneCamera(false);
            _gameplayCamera = null;
        }

        GameObject? Ref(string? reference)
        {
            if (string.IsNullOrEmpty(reference) || _run == null) return null;
            if (_run.Refs.TryGetValue(reference!, out var n) && n != null) return n;
            n = Entities.Find(reference);
            if (n == null) Log.WarnOnce($"cs-ref:{_run.Doc.Name}:{reference}", $"Cutscene '{_run.Doc.Name}': entity '{reference}' not found.");
            _run.Refs[reference!] = n;
            return n;
        }

        Vector3 Point(PointRef p, bool look)
        {
            if (p.Entity == null) return p.Position;
            var n = Ref(p.Entity);
            if (n == null) return p.Position;
            if (!look)
            {
                var cam = n.GetComponentInChildren<Camera>(true);
                return cam != null ? cam.transform.position : n.transform.position;
            }
            if (!_focusLocal.TryGetValue(n, out var local))
                _focusLocal[n] = local = n.transform.InverseTransformPoint(Entities.FocusPoint(n));
            return n.transform.TransformPoint(local);
        }

        static (T a, T b, float w) Segment<T>(List<T> keys, float t, Func<T, float> time, Func<T, float, float> weight)
        {
            if (keys.Count == 1 || t <= time(keys[0])) return (keys[0], keys[0], 0f);
            var last = keys[keys.Count - 1];
            if (t >= time(last)) return (last, last, 0f);
            var i = 0;
            while (i < keys.Count - 2 && time(keys[i + 1]) <= t) i++;
            var a = keys[i];
            var b = keys[i + 1];
            var span = time(b) - time(a);
            var x = span > 0f ? (t - time(a)) / span : 1f;
            return (a, b, weight(b, x));
        }

        void ApplyCamera(List<CameraKeyDoc> keys, float t)
        {
            var (a, b, w) = Segment(keys, t, k => k.T, (next, x) => next.Cut || next.Ease == "hold" ? 0f : Easing.Apply(next.Ease, x));
            var pos = Vector3.Lerp(Point(a.Position, false), Point(b.Position, false), w);
            var look = Vector3.Lerp(Point(a.LookAt, true), Point(b.LookAt, true), w);
            var fov = Mathf.Lerp(a.Fov, b.Fov, w);
            var shake = Mathf.Lerp(a.Shake, b.Shake, w);
            var dir = look - pos;
            if (dir.sqrMagnitude < 1e-6f) dir = _cam.transform.forward;
            var up = Mathf.Abs(Vector3.Dot(dir.normalized, Vector3.up)) > 0.999f ? Vector3.forward : Vector3.up;
            var rot = Quaternion.LookRotation(dir, up);
            if (shake > 0f)
            {
                var tt = _run!.Time;
                var off = new Vector3(Mathf.Sin(tt * 13.7f) + 0.5f * Mathf.Sin(tt * 31.3f), Mathf.Sin(tt * 17.9f + 1.1f) + 0.5f * Mathf.Sin(tt * 27.1f), 0f);
                pos += rot * off * shake * 0.05f;
                rot = rot * Quaternion.AngleAxis(Mathf.Sin(tt * 9.3f) * shake * 1.1f, Vector3.forward);
            }
            _cam.transform.SetPositionAndRotation(pos, rot);
            _cam.fieldOfView = Mathf.Clamp(fov, 5f, 150f);
            Hud.SetDepthOfField(Mathf.Lerp(a.Focus, b.Focus, w), Mathf.Lerp(a.Aperture, b.Aperture, w));
        }

        void ApplyMove(CutsceneTrackDoc tr, float t)
        {
            var node = Ref(tr.Actor);
            if (node == null) return;
            var (a, b, w) = Segment(tr.MoveKeys, t, k => k.T, (next, x) => Easing.Apply(next.Ease, x));
            Quaternion? rot = null;
            if (a.Rotation != null || b.Rotation != null)
                rot = Quaternion.Slerp(a.Rotation ?? b.Rotation!.Value, b.Rotation ?? a.Rotation!.Value, w);
            var cc = node.GetComponent<CharacterController>();
            if (cc != null) cc.enabled = false;
            node.transform.position = Vector3.Lerp(a.Position, b.Position, w);
            if (rot != null) node.transform.rotation = rot.Value;
            if (cc != null) cc.enabled = true;
        }

        void Fire(CutsceneTrackDoc tr, CutsceneItemDoc it)
        {
            switch (tr.Type)
            {
                case "animation":
                    var anim = AigeAnimator.Of(Ref(tr.Actor));
                    if (anim == null) Log.WarnOnce($"cs-anim:{tr.Actor}", $"Cutscene: '{tr.Actor}' has no AigeAnimator.");
                    else anim.Play(it.Clip ?? "", it.Fade, it.Loop, it.Speed);
                    break;
                case "voice":
                    Voice.Play(it.Line ?? "", Ref(it.Actor), it.Subtitle);
                    break;
                case "sound":
                    var where = it.At != null ? Ref(it.At) : null;
                    var sound = !string.IsNullOrEmpty(it.Clip) ? it.Clip : it.Sfx;
                    if (!string.IsNullOrEmpty(sound)) Sfx.Play(sound!, where != null ? where.transform.position : (Vector3?)null, it.Volume);
                    break;
                case "subtitle":
                    Hud.Say(it.Text ?? "", it.Duration, it.Speaker);
                    break;
                case "fx":
                    Hud.Fx(it.Effect ?? "", it.To, it.Duration, it.Color);
                    break;
                case "light":
                    TweenLight(it, false);
                    break;
                case "event":
                    ApplyEvent(it);
                    break;
            }
        }

        void TweenLight(CutsceneItemDoc it, bool instant)
        {
            var ent = Ref(it.Entity);
            var light = ent != null ? ent.GetComponentInChildren<Light>(true) : null;
            if (light == null)
            {
                Log.WarnOnce($"cs-light:{it.Entity}", $"Cutscene: '{it.Entity}' has no light.");
                return;
            }
            if (_lightTweens.TryGetValue(light, out var old) && old != null) StopCoroutine(old);
            var flicker = light.GetComponent<LightFlicker>();
            var intensity = AigeLights.Intensity(it.Intensity, light.type);
            if (instant || it.Duration <= 0f)
            {
                SetLight(light, flicker, intensity, it.Color ?? LightColor(light, flicker));
                return;
            }
            _lightTweens[light] = StartCoroutine(LightTween(light, flicker, intensity, it.Color, it.Duration));
        }

        static Color LightColor(Light l, LightFlicker? f) => f != null ? f.BaseColor : l.color;

        static void SetLight(Light l, LightFlicker? f, float intensity, Color color)
        {
            if (f != null)
            {
                f.BaseEnergy = intensity;
                f.BaseColor = color;
            }
            else
            {
                l.intensity = intensity;
                l.color = color;
            }
        }

        IEnumerator LightTween(Light light, LightFlicker? flicker, float to, Color? toColor, float seconds)
        {
            var from = flicker != null ? flicker.BaseEnergy : light.intensity;
            var fromColor = LightColor(light, flicker);
            for (var t = 0f; t < seconds && light != null; t += UnityEngine.Time.deltaTime)
            {
                var x = Mathf.Sin(Mathf.Clamp01(t / seconds) * Mathf.PI * 0.5f);
                SetLight(light, flicker, Mathf.Lerp(from, to, x), toColor != null ? Color.Lerp(fromColor, toColor.Value, x) : fromColor);
                yield return null;
            }
            if (light != null) SetLight(light, flicker, to, toColor ?? fromColor);
        }

        void ApplyEvent(CutsceneItemDoc it)
        {
            if (!string.IsNullOrEmpty(it.SetFlag)) Story.SetFlag(it.SetFlag!);
            if (!string.IsNullOrEmpty(it.ClearFlag)) Story.ClearFlag(it.ClearFlag!);
            if (!string.IsNullOrEmpty(it.Enable)) Entities.SetEnabled(Ref(it.Enable), true);
            if (!string.IsNullOrEmpty(it.Disable)) Entities.SetEnabled(Ref(it.Disable), false);
            if (!string.IsNullOrEmpty(it.Give)) Story.Give(it.Give!);
            if (!string.IsNullOrEmpty(it.Take)) Story.Take(it.Take!);
            if (it.Objective != null) Story.SetObjective(it.Objective);
            if (!string.IsNullOrEmpty(it.TeleportEntity))
            {
                var n = Ref(it.TeleportEntity);
                if (n != null) Entities.Teleport(n, it.TeleportPosition, it.TeleportRotation);
            }
            if (!string.IsNullOrEmpty(it.Emit)) Story.Emit(it.Emit!);
        }
    }
}
