using System;
using System.Collections.Generic;
using Godot;

namespace Aige;

/// <summary>
/// One-shot sounds (autoload <c>Sfx</c>). A preset name plays
/// <c>res://godot/audio/sfx/&lt;preset&gt;.ogg</c>; any res:// (or project-relative) path works too.
/// With a position the sound is 3D.
/// <code>
/// Sfx.Play("thunder");
/// Sfx.Play("creak", door.GlobalPosition, volume: 0.6f);
/// Sfx.Play("res://audio/sfx/drawer.ogg");
/// </code>
/// </summary>
public partial class Sfx : Node
{
    const int MaxVoices = 32;

    /// <summary>The autoload instance.</summary>
    public static Sfx? Instance { get; private set; }

    /// <summary>Raised for every sound played through Sfx or an AudioSource: (name, found).</summary>
    public static event Action<string, bool>? Played;

    static readonly Dictionary<string, AudioStream?> Cache = new();
    readonly List<AudioStreamPlayer> _flat = new();
    readonly List<AudioStreamPlayer3D> _spatial = new();

    public override void _EnterTree()
    {
        Instance = this;
    }

    public override void _ExitTree()
    {
        if (Instance != this) return;
        Instance = null;
        Cache.Clear();
        ParticleSystem.ClearCache();
    }

    /// <summary>Resolves a preset name or path to a res:// path.</summary>
    public static string PathOf(string nameOrPath)
    {
        if (nameOrPath.StartsWith("res://") || nameOrPath.StartsWith("user://")) return nameOrPath;
        if (nameOrPath.Contains('/') || nameOrPath.Contains('.')) return AigeJson.ResPath(nameOrPath);
        var ogg = $"res://godot/audio/sfx/{nameOrPath}.ogg";
        if (ResourceLoader.Exists(ogg)) return ogg;
        var wav = $"res://godot/audio/sfx/{nameOrPath}.wav";
        return ResourceLoader.Exists(wav) ? wav : ogg;
    }

    /// <summary>Loads (and caches) a sound. Null when it does not exist.</summary>
    public static AudioStream? Load(string nameOrPath)
    {
        var path = PathOf(nameOrPath);
        if (Cache.TryGetValue(path, out var s)) return s;
        s = ResourceLoader.Exists(path) ? ResourceLoader.Load<AudioStream>(path) : null;
        Cache[path] = s;
        return s;
    }

    /// <summary>True when the preset or path exists.</summary>
    public static bool Exists(string nameOrPath) => Load(nameOrPath) != null;

    /// <summary>
    /// Plays a sound once. <paramref name="at"/> makes it positional. Volume is 0..1, pitch 1 = normal.
    /// Returns false (and warns once) when the sound does not exist.
    /// </summary>
    public static bool Play(string nameOrPath, Vector3? at = null, float volume = 1f, float pitch = 1f, bool notify = true)
    {
        if (Exists(nameOrPath)) return TryPlay(nameOrPath, at, volume, pitch, notify);
        Log.WarnOnce("sfx:" + nameOrPath, $"Sound '{nameOrPath}' not found ({PathOf(nameOrPath)}).");
        if (notify) Played?.Invoke(nameOrPath, false);
        return false;
    }

    /// <summary>Plays the sound from an entity's position.</summary>
    public static bool PlayAt(string nameOrPath, Node3D where, float volume = 1f, float pitch = 1f) =>
        Play(nameOrPath, where.GlobalPosition, volume, pitch);

    /// <summary>Like <see cref="Play"/> but silent (no warning) when the sound is missing.</summary>
    public static bool TryPlay(string nameOrPath, Vector3? at = null, float volume = 1f, float pitch = 1f, bool notify = true)
    {
        var stream = Load(nameOrPath);
        var sfx = Instance;
        if (stream == null || sfx == null) return false;
        var db = Mathf.LinearToDb(Mathf.Max(0.0001f, volume));
        if (at is { } pos)
        {
            var p = sfx.Spatial();
            p.Stream = stream;
            p.GlobalPosition = pos;
            p.VolumeDb = db;
            p.PitchScale = pitch;
            p.Play();
        }
        else
        {
            var p = sfx.Flat();
            p.Stream = stream;
            p.VolumeDb = db;
            p.PitchScale = pitch;
            p.Play();
        }
        if (notify) Played?.Invoke(nameOrPath, true);
        return true;
    }

    /// <summary>Plays the first sound of the list that exists. Returns false when none does.</summary>
    public static bool PlayFirst(string[] names, Vector3? at = null, float volume = 1f, float pitch = 1f)
    {
        foreach (var n in names)
            if (TryPlay(n, at, volume, pitch)) return true;
        return false;
    }

    /// <summary>Records a sound started elsewhere (AudioSource) for the test report.</summary>
    public static void Notify(string name, bool found = true) => Played?.Invoke(name, found);

    /// <summary>Sets the master volume (0..1). Use <c>Hud.Fx("volume", 0.2f, 3f)</c> to fade it.</summary>
    public static void SetMasterVolume(float volume) =>
        AudioServer.SetBusVolumeDb(0, Mathf.LinearToDb(Mathf.Max(0.0001f, volume)));

    AudioStreamPlayer Flat()
    {
        foreach (var p in _flat)
            if (!p.Playing) return p;
        if (_flat.Count >= MaxVoices) return _flat[0];
        var n = new AudioStreamPlayer();
        if (AudioServer.GetBusIndex("SFX") >= 0) n.Bus = "SFX";
        AddChild(n);
        _flat.Add(n);
        return n;
    }

    AudioStreamPlayer3D Spatial()
    {
        foreach (var p in _spatial)
            if (!p.Playing) return p;
        if (_spatial.Count >= MaxVoices) return _spatial[0];
        var n = new AudioStreamPlayer3D
        {
            UnitSize = 3f,
            MaxDistance = 45f,
            AttenuationFilterCutoffHz = 9000f,
        };
        if (AudioServer.GetBusIndex("SFX") >= 0) n.Bus = "SFX";
        AddChild(n);
        _spatial.Add(n);
        return n;
    }
}
