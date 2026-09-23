using System;
using Godot;

namespace Aige;

/// <summary>
/// Voice lines (autoload <c>Voice</c>). <c>Voice.Play("milch_wake_1")</c> loads
/// <c>res://audio/voice/milch_wake_1.json</c> (VoiceLineDoc) and its audio, shows the subtitle and
/// moves the speaking character's jaw from the lip-sync curve. The actor defaults to the entity
/// named like the speaker ('Milch').
/// <code>
/// var seconds = Voice.Play("milch_photo_1");
/// Voice.Play("milch_scream_1", GetNode&lt;Node3D&gt;("../Milch"));
/// </code>
/// </summary>
public partial class Voice : Node
{
    /// <summary>The autoload instance.</summary>
    public static Voice? Instance { get; private set; }

    /// <summary>Raised when a line starts: (id, speaker, text).</summary>
    public static event Action<string, string, string>? Started;

    /// <summary>Raised when a line ends or is stopped: (id).</summary>
    public static event Action<string>? Finished;

    /// <summary>Seconds the subtitle stays up after the audio ends.</summary>
    public static float SubtitleLinger { get; set; } = 0.6f;

    AudioStreamPlayer _player = null!;
    VoiceLineDoc? _line;
    Animator? _mouth;
    float _elapsed;

    /// <summary>True while a line is playing.</summary>
    public static bool IsPlaying => Instance?._line != null;

    /// <summary>Id of the line playing now (null when silent).</summary>
    public static string? Current => Instance?._line?.Id;

    public override void _EnterTree()
    {
        Instance = this;
    }

    public override void _ExitTree()
    {
        if (Instance == this) Instance = null;
    }

    public override void _Ready()
    {
        _player = new AudioStreamPlayer { Name = "VoicePlayer" };
        if (AudioServer.GetBusIndex("Voice") >= 0) _player.Bus = "Voice";
        AddChild(_player);
    }

    /// <summary>
    /// Plays a voice line by id (or 'res://…json' path). <paramref name="actor"/> is the entity whose
    /// jaw moves (default: the entity named like the speaker). Returns the line's duration in seconds
    /// (0 when the line is missing).
    /// </summary>
    public static float Play(string id, Node? actor = null, bool subtitle = true, float volume = 1f) =>
        Instance?.PlayImpl(id, actor, subtitle, volume) ?? 0f;

    /// <summary>Stops the current line (and its subtitle).</summary>
    public static void Stop()
    {
        var v = Instance;
        if (v?._line == null) return;
        v._player.Stop();
        Hud.ClearSubtitles();
        v.End();
    }

    /// <summary>Duration of a line in seconds without playing it (0 when missing).</summary>
    public static float DurationOf(string id) => VoiceLineDoc.Load(id)?.Duration ?? 0f;

    float PlayImpl(string id, Node? actor, bool subtitle, float volume)
    {
        var doc = VoiceLineDoc.Load(id);
        if (doc == null)
        {
            Log.Error($"Voice line '{id}' not found (expected res://audio/voice/{id}.json).");
            return 0f;
        }
        if (_line != null) End();

        _line = doc;
        _elapsed = 0f;
        actor ??= string.IsNullOrEmpty(doc.Speaker) ? null : Entities.FindNode(doc.Speaker);
        _mouth = Animator.Of(actor);

        var stream = ResourceLoader.Exists(doc.Audio) ? ResourceLoader.Load<AudioStream>(doc.Audio) : null;
        if (stream != null)
        {
            _player.Stream = stream;
            _player.VolumeDb = Mathf.LinearToDb(Mathf.Max(0.0001f, volume));
            _player.Play();
        }
        else
        {
            Log.WarnOnce("voice-audio:" + doc.Audio, $"Voice audio '{doc.Audio}' is missing; showing the subtitle only.");
        }

        var audioLength = stream != null ? (float)stream.GetLength() : 0f;
        var length = Mathf.Max(doc.Duration, audioLength);
        if (length <= 0f) length = Mathf.Clamp(1f + doc.Text.Length * 0.06f, 1.5f, 8f);
        _line.Duration = length;
        if (subtitle && !string.IsNullOrEmpty(doc.Text)) Hud.Say(doc.Text, length + SubtitleLinger, doc.Speaker);
        Started?.Invoke(doc.Id, doc.Speaker, doc.Text);
        return length;
    }

    void End()
    {
        var id = _line?.Id;
        _line = null;
        if (_mouth != null && IsInstanceValid(_mouth)) _mouth.Mouth = 0f;
        _mouth = null;
        if (id != null) Finished?.Invoke(id);
    }

    public override void _Process(double delta)
    {
        if (_line == null) return;
        _elapsed += (float)delta;
        if (_mouth != null && IsInstanceValid(_mouth))
        {
            // Audio clock when available (keeps the jaw in sync), else our own clock.
            var t = _player.Playing
                ? (float)(_player.GetPlaybackPosition() + AudioServer.GetTimeSinceLastMix() - AudioServer.GetOutputLatency())
                : _elapsed;
            _mouth.Mouth = _line.MouthAt(t);
        }
        if (_elapsed >= _line.Duration && !_player.Playing) End();
        else if (_elapsed >= _line.Duration + 0.5f) End();
    }
}
