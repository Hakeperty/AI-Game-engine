#nullable enable
using System;
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.Animations;
using UnityEngine.Playables;

namespace Aige
{
    /// <summary>
    /// Plays the glTF animation clips of a character model (AIGE Animator) with cross-fades, through the
    /// Playables API on the model's Animator. With <see cref="Locomotion"/> it switches idle/walk/run from how
    /// fast the entity moves while no clip overrides it. <see cref="Mouth"/> (0..1) opens the jaw bone.
    /// <code>AigeAnimator.Of(hero)?.Play("look_around", fade: 0.3f, loop: false);</code>
    /// </summary>
    [DisallowMultipleComponent]
    public sealed class AigeAnimator : MonoBehaviour
    {
        static readonly Dictionary<string, string> Aliases = new Dictionary<string, string>
        {
            ["lie_sleep"] = "lie_asleep", ["sleep"] = "lie_asleep", ["sit_up_bed"] = "sit_up_in_bed", ["sit_up"] = "sit_up_in_bed",
            ["sit"] = "sit_idle", ["search_drawer"] = "search", ["faint_collapse"] = "faint", ["collapse"] = "faint",
            ["lie_unconscious"] = "lie_floor", ["wake_on_floor_rub_back"] = "wake_up_floor", ["wake_up"] = "wake_up_floor",
            ["hide_in_belt"] = "hide_item", ["hold"] = "hold_item", ["hold_knife"] = "hold_item", ["panting"] = "breathe_heavy",
            ["nervous"] = "idle_nervous",
        };

        static readonly string[] IdleNames = { "idle", "idle_breathing", "breathing_idle", "stand" };
        static readonly string[] WalkNames = { "walk", "walking", "walk_forward" };
        static readonly string[] RunNames = { "run", "running", "jog", "sprint" };
        static readonly string[] CrouchIdleNames = { "crouch_idle", "crouch" };
        static readonly string[] CrouchWalkNames = { "crouch_walk", "sneak" };

        /// <summary>Animation clips (the importer fills them from the model's GLB).</summary>
        public AnimationClip[] Clips = Array.Empty<AnimationClip>();
        public string Initial = "idle";
        public bool Locomotion = true;
        public float Speed = 1f;
        [Range(0, 1)] public float Mouth;
        public float JawOpenDegrees = 16f;
        /// <summary>Movement speed (m/s) at which the walk clip plays at 1x.</summary>
        public float WalkClipSpeed = 1.4f;
        public float RunClipSpeed = 4.5f;

        /// <summary>Raised when a one-shot clip reaches its end.</summary>
        public event Action<string>? ClipFinished;

        readonly Dictionary<string, int> _names = new Dictionary<string, int>();
        readonly List<AnimationClipPlayable> _playables = new List<AnimationClipPlayable>();
        readonly List<float> _weights = new List<float>();
        PlayableGraph _graph;
        Animation? _legacy;
        AnimationMixerPlayable _mixer;
        Animator? _animator;
        Transform? _jaw;
        Quaternion _jawBase = Quaternion.identity, _jawWritten = Quaternion.identity;
        int _target = -1, _idle = -1, _walk = -1, _run = -1, _crouchIdle = -1, _crouchWalk = -1;
        int _override = -1, _loco = -1;
        bool _overrideLoops, _overrideDone, _started;
        bool[] _loops = Array.Empty<bool>();
        float _fade = 0.25f, _mouth, _speed;
        Vector3 _lastPos;
        bool _hasLastPos;

        public string? CurrentClip => _target >= 0 ? Clips[_target].name : null;
        public float MoveSpeed => _speed;
        public bool Crouching { get; set; }

        public static AigeAnimator? Of(GameObject? entity)
        {
            if (entity == null) return null;
            var a = entity.GetComponent<AigeAnimator>();
            return a != null ? a : entity.GetComponentInChildren<AigeAnimator>(true);
        }

        void Start() => Init();

        void Init()
        {
            if (_started) return;
            _started = true;
            _animator = GetComponentInChildren<Animator>(true);
            var mesh = transform.Find("Mesh");
            if (_animator == null && mesh != null && mesh.childCount > 0) _animator = mesh.GetChild(0).gameObject.AddComponent<Animator>();
            foreach (var t in GetComponentsInChildren<Transform>(true))
                if (t.name.ToLowerInvariant().Contains("jaw")) { _jaw = t; break; }
            if (_animator == null || Clips.Length == 0)
            {
                if (Clips.Length == 0) Log.WarnOnce("anim-none:" + name, $"'{name}' has no animation clips.");
                return;
            }
            if (Clips[0].legacy)
            {
                InitLegacy();
                return;
            }
            _animator.applyRootMotion = false;
            _animator.cullingMode = AnimatorCullingMode.AlwaysAnimate;
            _graph = PlayableGraph.Create($"Aige:{name}");
            _graph.SetTimeUpdateMode(DirectorUpdateMode.GameTime);
            _mixer = AnimationMixerPlayable.Create(_graph, Clips.Length);
            var output = AnimationPlayableOutput.Create(_graph, "Animation", _animator);
            output.SetSourcePlayable(_mixer);
            _loops = new bool[Clips.Length];
            for (var i = 0; i < Clips.Length; i++)
            {
                var clip = Clips[i];
                var p = AnimationClipPlayable.Create(_graph, clip);
                p.SetApplyFootIK(false);
                _graph.Connect(p, 0, _mixer, i);
                _mixer.SetInputWeight(i, 0f);
                _playables.Add(p);
                _weights.Add(0f);
                var key = Normalize(clip.name);
                if (!_names.ContainsKey(key)) _names[key] = i;
            }
            _idle = Find(IdleNames);
            _walk = Find(WalkNames);
            _run = Find(RunNames);
            _crouchIdle = Find(CrouchIdleNames);
            _crouchWalk = Find(CrouchWalkNames);
            foreach (var i in new[] { _idle, _walk, _run, _crouchIdle, _crouchWalk })
                if (i >= 0) _loops[i] = true;
            _graph.Play();
            var initial = string.IsNullOrEmpty(Initial) ? "idle" : Initial;
            var ini = Resolve(initial);
            if (ini >= 0 && ini != _idle) Play(initial, 0f);
            else if (_idle >= 0) PlayRaw(_idle, 0f, 1f, true);
        }

        /// <summary>Legacy clips (glTFast 'Legacy' import) play on an Animation component with cross-fades.</summary>
        void InitLegacy()
        {
            _legacy = GetComponentInChildren<Animation>(true);
            if (_legacy == null)
            {
                var mesh = transform.Find("Mesh");
                var host = mesh != null && mesh.childCount > 0 ? mesh.GetChild(0).gameObject : mesh != null ? mesh.gameObject : gameObject;
                _legacy = host.AddComponent<Animation>();
            }
            _legacy.playAutomatically = false;
            _legacy.cullingType = AnimationCullingType.AlwaysAnimate;
            _loops = new bool[Clips.Length];
            for (var i = 0; i < Clips.Length; i++)
            {
                if (_legacy.GetClip(Clips[i].name) == null) _legacy.AddClip(Clips[i], Clips[i].name);
                var key = Normalize(Clips[i].name);
                if (!_names.ContainsKey(key)) _names[key] = i;
            }
            _idle = Find(IdleNames);
            _walk = Find(WalkNames);
            _run = Find(RunNames);
            _crouchIdle = Find(CrouchIdleNames);
            _crouchWalk = Find(CrouchWalkNames);
            foreach (var i in new[] { _idle, _walk, _run, _crouchIdle, _crouchWalk })
                if (i >= 0) _loops[i] = true;
            var initial = string.IsNullOrEmpty(Initial) ? "idle" : Initial;
            var ini = Resolve(initial);
            if (ini >= 0 && ini != _idle) Play(initial, 0f);
            else if (_idle >= 0) PlayRaw(_idle, 0f, 1f, true);
        }

        bool Ready => _graph.IsValid() || _legacy != null;

        void OnDestroy()
        {
            if (_graph.IsValid()) _graph.Destroy();
        }

        static string Normalize(string name)
        {
            var s = name;
            var cut = Math.Max(s.LastIndexOf('|'), s.LastIndexOf('/'));
            if (cut >= 0) s = s.Substring(cut + 1);
            return s.ToLowerInvariant().Replace(' ', '_').Replace('-', '_');
        }

        int Find(string[] candidates)
        {
            foreach (var c in candidates)
                if (_names.TryGetValue(c, out var i)) return i;
            return -1;
        }

        /// <summary>Clip index for a name or AIGE alias (-1 when missing).</summary>
        public int Resolve(string clip)
        {
            if (string.IsNullOrEmpty(clip)) return -1;
            var key = Normalize(clip);
            if (_names.TryGetValue(key, out var i)) return i;
            if (Aliases.TryGetValue(key, out var alias) && _names.TryGetValue(alias, out i)) return i;
            foreach (var kv in Aliases)
                if (kv.Value == key && _names.TryGetValue(kv.Key, out i)) return i;
            return -1;
        }

        public bool HasClip(string clip)
        {
            Init();
            return Resolve(clip) >= 0;
        }

        /// <summary>Cross-fades to a clip. loop null = the clip's default (locomotion clips loop). False when missing.</summary>
        public bool Play(string clip, float fade = 0.25f, bool? loop = null, float speed = 1f)
        {
            Init();
            var i = Resolve(clip);
            if (i < 0 || !Ready)
            {
                Log.WarnOnce($"anim:{name}:{clip}", !Ready ? $"'{name}' has no animated model; cannot play '{clip}'." : $"'{name}' has no clip '{clip}'.");
                return false;
            }
            var loops = loop ?? _loops[i];
            if (Locomotion && (i == _idle || i == _walk || i == _run) && loop != false)
            {
                Release(fade);
                return true;
            }
            _override = i;
            _overrideLoops = loops;
            _overrideDone = false;
            PlayRaw(i, fade, speed, loops);
            return true;
        }

        /// <summary>Returns to locomotion (idle/walk/run).</summary>
        public void Release(float fade = 0.35f)
        {
            _override = -1;
            _overrideDone = false;
            _loco = -1;
            UpdateLocomotion(fade);
        }

        void PlayRaw(int i, float fade, float speed, bool loop)
        {
            if (_legacy != null)
            {
                var clipName = Clips[i].name;
                var st = _legacy[clipName];
                if (st == null) return;
                st.speed = Speed * speed;
                st.wrapMode = loop ? WrapMode.Loop : WrapMode.ClampForever;
                if (i != _target || !loop) st.time = 0f;
                if (fade <= 0f) _legacy.Play(clipName);
                else _legacy.CrossFade(clipName, fade);
                _loops[i] = loop || _loops[i] && (i == _idle || i == _walk || i == _run);
                _target = i;
                return;
            }
            if (i != _target || !loop)
            {
                _playables[i].SetTime(0);
                _playables[i].SetSpeed(Speed * speed);
            }
            _loops[i] = loop || _loops[i] && (i == _idle || i == _walk || i == _run);
            _target = i;
            _fade = Mathf.Max(0f, fade);
            if (_fade <= 0f)
                for (var k = 0; k < _weights.Count; k++) _weights[k] = k == i ? 1f : 0f;
        }

        void Update()
        {
            MeasureSpeed(Time.deltaTime);
            _mouth = Mathf.Lerp(_mouth, Mathf.Clamp01(Mouth), Easing.Damp(30f, Time.deltaTime));
            if (!Ready) return;

            if (_override >= 0)
            {
                var moving = _speed > 0.35f;
                var release = _overrideLoops ? moving && !Cutscenes.IsPlaying : _overrideDone && (moving || !Cutscenes.InputBlocked);
                if (release) Release();
            }
            else UpdateLocomotion(0.3f);

            if (_legacy != null)
            {
                if (_override >= 0 && _override == _target && !_overrideLoops && !_overrideDone)
                {
                    var st = _legacy[Clips[_override].name];
                    if (st != null && st.time >= st.length)
                    {
                        _overrideDone = true;
                        ClipFinished?.Invoke(Clips[_override].name);
                    }
                }
                return;
            }

            // Loop or hold one-shots; cross-fade weights.
            for (var i = 0; i < _playables.Count; i++)
            {
                var p = _playables[i];
                var len = Mathf.Max(0.0001f, Clips[i].length);
                var t = (float)p.GetTime();
                if (_weights[i] > 0f || i == _target)
                {
                    if (t >= len)
                    {
                        if (i == _target && (_loops[i] || (_override == i && _overrideLoops))) p.SetTime(t % len);
                        else
                        {
                            p.SetTime(len - 0.001f);
                            if (i == _override && !_overrideDone)
                            {
                                _overrideDone = true;
                                ClipFinished?.Invoke(Clips[i].name);
                            }
                        }
                    }
                }
                var goal = i == _target ? 1f : 0f;
                _weights[i] = _fade <= 0f ? goal : Mathf.MoveTowards(_weights[i], goal, Time.deltaTime / _fade);
            }
            var sum = 0f;
            foreach (var w in _weights) sum += w;
            for (var i = 0; i < _weights.Count; i++) _mixer.SetInputWeight(i, sum > 0f ? _weights[i] / sum : 0f);
        }

        void LateUpdate()
        {
            if (_jaw == null) return;
            var current = _jaw.localRotation;
            if (Quaternion.Angle(current, _jawWritten) > 0.01f) _jawBase = current;
            var q = _jawBase * Quaternion.AngleAxis(JawOpenDegrees * _mouth, Vector3.right);
            _jaw.localRotation = q;
            _jawWritten = q;
        }

        void MeasureSpeed(float dt)
        {
            var pos = transform.position;
            if (_hasLastPos && dt > 0f)
            {
                var d = pos - _lastPos;
                d.y = 0f;
                var v = d.magnitude / dt;
                if (v > 15f) v = _speed;
                _speed = Mathf.Lerp(_speed, v, Easing.Damp(10f, dt));
            }
            _lastPos = pos;
            _hasLastPos = true;
        }

        void UpdateLocomotion(float fade)
        {
            if (!Ready || !Locomotion) return;
            int want;
            var scale = 1f;
            var runFrom = (WalkClipSpeed + RunClipSpeed) * 0.5f;
            if (Crouching && _crouchIdle >= 0)
            {
                want = _speed > 0.15f && _crouchWalk >= 0 ? _crouchWalk : _crouchIdle;
                if (want == _crouchWalk) scale = Mathf.Clamp(_speed / (WalkClipSpeed * 0.6f), 0.5f, 1.5f);
            }
            else if (_speed < 0.15f || _walk < 0) want = _idle;
            else if (_speed < runFrom || _run < 0)
            {
                want = _walk;
                scale = Mathf.Clamp(_speed / WalkClipSpeed, 0.45f, _run < 0 ? 2.2f : 1.6f);
            }
            else
            {
                want = _run;
                scale = Mathf.Clamp(_speed / RunClipSpeed, 0.6f, 1.4f);
            }
            if (want < 0) return;
            if (want != _loco)
            {
                _loco = want;
                PlayRaw(want, fade, 1f, true);
            }
            if (_legacy != null)
            {
                var st = _legacy[Clips[want].name];
                if (st != null) st.speed = Speed * scale;
            }
            else _playables[want].SetSpeed(Speed * scale);
        }
    }
}
