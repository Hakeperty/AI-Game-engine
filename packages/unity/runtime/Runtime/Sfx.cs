#nullable enable
using System;
using System.Collections.Generic;
using UnityEngine;

namespace Aige
{
    /// <summary>
    /// One-shot sounds. A name ('thunder') plays the baked story sound Resources/aige/sfx/thunder; a path
    /// ('audio/sfx/drawer.ogg') plays an exported clip.
    /// <code>
    /// Sfx.Play("thunder");
    /// Sfx.Play("creak", door.transform.position, volume: 0.6f, pitch: 0.95f);   // 3D
    /// Sfx.TryPlay("heartbeat");                                                  // silent if missing
    /// </code>
    /// </summary>
    [AddComponentMenu("")]
    public sealed class Sfx : MonoBehaviour
    {
        const int MaxVoices = 32;
        static readonly Dictionary<string, AudioClip?> Cache = new Dictionary<string, AudioClip?>();

        public static Sfx? Instance { get; private set; }

        /// <summary>(name, found).</summary>
        public static event Action<string, bool>? Played;

        readonly List<AudioSource> _flat = new List<AudioSource>();
        readonly List<AudioSource> _spatial = new List<AudioSource>();

        void Awake() => Instance = this;

        void OnDestroy()
        {
            if (Instance != this) return;
            Instance = null;
            Cache.Clear();
        }

        /// <summary>AIGE path of a sound: names map to 'sfx/&lt;name&gt;'.</summary>
        public static string PathOf(string nameOrPath) =>
            nameOrPath.Contains("/") || nameOrPath.Contains(".") ? AigeAssets.Clean(nameOrPath) : "sfx/" + nameOrPath;

        public static AudioClip? Load(string nameOrPath)
        {
            var path = PathOf(nameOrPath);
            if (Cache.TryGetValue(path, out var c)) return c;
            c = AigeAssets.Clip(path);
            Cache[path] = c;
            return c;
        }

        public static bool Exists(string nameOrPath) => Load(nameOrPath) != null;

        /// <summary>Plays a sound (3D at <paramref name="at"/> when given). Warns once when it does not exist.</summary>
        public static bool Play(string nameOrPath, Vector3? at = null, float volume = 1f, float pitch = 1f, bool notify = true)
        {
            if (Exists(nameOrPath)) return TryPlay(nameOrPath, at, volume, pitch, notify);
            Log.WarnOnce("sfx:" + nameOrPath, $"Sound '{nameOrPath}' not found (Resources/aige/{PathOf(nameOrPath)}).");
            if (notify) Played?.Invoke(nameOrPath, false);
            return false;
        }

        public static bool PlayAt(string nameOrPath, GameObject where, float volume = 1f, float pitch = 1f) =>
            Play(nameOrPath, where.transform.position, volume, pitch);

        /// <summary>Plays a sound if it exists; silent otherwise.</summary>
        public static bool TryPlay(string nameOrPath, Vector3? at = null, float volume = 1f, float pitch = 1f, bool notify = true)
        {
            var clip = Load(nameOrPath);
            var sfx = Instance;
            if (clip == null || sfx == null) return false;
            var src = at != null ? sfx.Spatial() : sfx.Flat();
            if (at != null) src.transform.position = at.Value;
            src.clip = clip;
            src.volume = Mathf.Clamp01(volume);
            src.pitch = pitch;
            src.Play();
            if (notify) Played?.Invoke(nameOrPath, true);
            return true;
        }

        /// <summary>Plays the first sound of the list that exists.</summary>
        public static bool PlayFirst(string[] names, Vector3? at = null, float volume = 1f, float pitch = 1f)
        {
            foreach (var n in names)
                if (TryPlay(n, at, volume, pitch)) return true;
            return false;
        }

        /// <summary>Reports a sound played by other means (AudioSource components) to listeners and tests.</summary>
        public static void Notify(string name, bool found = true) => Played?.Invoke(name, found);

        /// <summary>Master volume 0..1 (Hud.Fx("volume", ...) drives it).</summary>
        public static void SetMasterVolume(float volume) => AudioListener.volume = Mathf.Clamp01(volume);

        AudioSource Flat()
        {
            foreach (var p in _flat)
                if (!p.isPlaying) return p;
            if (_flat.Count >= MaxVoices) return _flat[0];
            var s = gameObject.AddComponent<AudioSource>();
            s.playOnAwake = false;
            s.spatialBlend = 0f;
            _flat.Add(s);
            return s;
        }

        AudioSource Spatial()
        {
            foreach (var p in _spatial)
                if (!p.isPlaying) return p;
            if (_spatial.Count >= MaxVoices) return _spatial[0];
            var go = new GameObject("Sfx3D");
            go.transform.SetParent(transform, false);
            var s = go.AddComponent<AudioSource>();
            s.playOnAwake = false;
            s.spatialBlend = 1f;
            s.rolloffMode = AudioRolloffMode.Logarithmic;
            s.minDistance = 1.5f;
            s.maxDistance = 45f;
            s.dopplerLevel = 0f;
            _spatial.Add(s);
            return s;
        }
    }

    /// <summary>
    /// Voice lines with subtitles and lip-sync. Loads Resources/aige/audio/voice/&lt;id&gt; (VoiceLineDoc JSON + audio),
    /// shows the subtitle and drives the speaker's <see cref="AigeAnimator.Mouth"/> (jaw bone) from the mouth curve.
    /// <code>
    /// float seconds = Voice.Play("milch_wake_1");
    /// Voice.Play("milch_scream_1", milch, subtitle: false);
    /// </code>
    /// </summary>
    [AddComponentMenu("")]
    public sealed class Voice : MonoBehaviour
    {
        public static Voice? Instance { get; private set; }

        /// <summary>(id, speaker, text).</summary>
        public static event Action<string, string, string>? Started;
        public static event Action<string>? Finished;

        /// <summary>Extra seconds the subtitle stays after the line ends.</summary>
        public static float SubtitleLinger { get; set; } = 0.6f;

        AudioSource _player = null!;
        VoiceLineDoc? _line;
        AigeAnimator? _mouth;
        float _elapsed, _length;

        public static bool IsPlaying => Instance != null && Instance._line != null;
        public static string? Current => Instance?._line?.Id;

        void Awake()
        {
            Instance = this;
            _player = gameObject.AddComponent<AudioSource>();
            _player.playOnAwake = false;
            _player.spatialBlend = 0f;
            _player.priority = 0;
        }

        void OnDestroy()
        {
            if (Instance == this) Instance = null;
        }

        /// <summary>Plays a voice line; returns its length in seconds (0 when missing).</summary>
        public static float Play(string id, GameObject? actor = null, bool subtitle = true, float volume = 1f) =>
            Instance != null ? Instance.PlayImpl(id, actor, subtitle, volume) : 0f;

        public static void Stop()
        {
            var v = Instance;
            if (v == null || v._line == null) return;
            v._player.Stop();
            Hud.ClearSubtitles();
            v.End();
        }

        public static float DurationOf(string id) => VoiceLineDoc.Load(id)?.Duration ?? 0f;

        float PlayImpl(string id, GameObject? actor, bool subtitle, float volume)
        {
            var doc = VoiceLineDoc.Load(id);
            if (doc == null)
            {
                Log.Error($"Voice line '{id}' not found (expected Resources/aige/audio/voice/{id}.json).");
                return 0f;
            }
            if (_line != null) End();
            _line = doc;
            _elapsed = 0f;
            if (actor == null && !string.IsNullOrEmpty(doc.Speaker)) actor = Entities.Find(doc.Speaker);
            _mouth = AigeAnimator.Of(actor);
            var clip = AigeAssets.Clip(doc.Audio);
            if (clip != null)
            {
                _player.clip = clip;
                _player.volume = Mathf.Clamp01(volume);
                _player.Play();
            }
            else Log.WarnOnce("voice-audio:" + doc.Audio, $"Voice audio '{doc.Audio}' is missing; showing the subtitle only.");
            var length = Mathf.Max(doc.Duration, clip != null ? clip.length : 0f);
            if (length <= 0f) length = Mathf.Clamp(1f + doc.Text.Length * 0.06f, 1.5f, 8f);
            _length = length;
            if (subtitle && !string.IsNullOrEmpty(doc.Text)) Hud.Say(doc.Text, length + SubtitleLinger, doc.Speaker);
            Started?.Invoke(doc.Id, doc.Speaker, doc.Text);
            return length;
        }

        void End()
        {
            var id = _line?.Id;
            _line = null;
            if (_mouth != null) _mouth.Mouth = 0f;
            _mouth = null;
            if (id != null) Finished?.Invoke(id);
        }

        void Update()
        {
            if (_line == null) return;
            _elapsed += Time.deltaTime;
            if (_mouth != null)
                _mouth.Mouth = _line.MouthAt(_player.isPlaying ? _player.time : _elapsed);
            if ((_elapsed >= _length && !_player.isPlaying) || _elapsed >= _length + 0.5f) End();
        }
    }
}
