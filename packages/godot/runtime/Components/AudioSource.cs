using Godot;

namespace Aige;

/// <summary>
/// AIGE <c>AudioSource</c>. Attached to the entity's <c>Audio</c> node, which is an
/// AudioStreamPlayer3D (spatial) or an AudioStreamPlayer; the exporter sets its built-in
/// <c>stream</c>. This script applies <see cref="Volume"/> and <see cref="Loop"/> and plays on start.
/// <code>
/// var rain = GetNode&lt;AudioSource&gt;("Window/Audio");
/// rain.FadeTo(0.2f, 3f);
/// </code>
/// </summary>
public partial class AudioSource : Node
{
    /// <summary>Volume 0..1.</summary>
    [Export] public float Volume { get; set; } = 0.8f;

    /// <summary>Loop the clip.</summary>
    [Export] public bool Loop { get; set; }

    /// <summary>Start playing when the scene starts.</summary>
    [Export] public bool PlayOnStart { get; set; }

    /// <summary>Spatial sources: distance (m) at which the sound fades out.</summary>
    [Export] public float Range { get; set; } = 12f;

    Tween? _fade;

    /// <summary>The clip (the player's built-in <c>stream</c>).</summary>
    public AudioStream? Clip
    {
        get => Get("stream").As<AudioStream>();
        set => Set("stream", value == null ? new Variant() : Variant.From(value));
    }

    /// <summary>True while playing.</summary>
    public bool IsPlaying => Get("playing").AsBool();

    public override void _Ready()
    {
        ApplyLoop(Clip, Loop);
        Set("volume_db", Mathf.LinearToDb(Mathf.Max(0.0001f, Volume)));
        if (PlayOnStart) Play();
    }

    /// <summary>Sets looping on a stream (Ogg Vorbis, WAV, MP3).</summary>
    public static void ApplyLoop(AudioStream? stream, bool loop)
    {
        switch (stream)
        {
            case AudioStreamOggVorbis ogg:
                ogg.Loop = loop;
                break;
            case AudioStreamMP3 mp3:
                mp3.Loop = loop;
                break;
            case AudioStreamWav wav:
                wav.LoopMode = loop ? AudioStreamWav.LoopModeEnum.Forward : AudioStreamWav.LoopModeEnum.Disabled;
                if (loop && wav.LoopEnd <= 0) wav.LoopEnd = (int)(wav.GetLength() * wav.MixRate);
                break;
        }
    }

    /// <summary>Starts playing from the beginning.</summary>
    public void Play()
    {
        _fade?.Kill();
        Set("volume_db", Mathf.LinearToDb(Mathf.Max(0.0001f, Volume)));
        Call("play", 0.0);
        var clip = Clip;
        Sfx.Notify(clip != null && !string.IsNullOrEmpty(clip.ResourcePath) ? System.IO.Path.GetFileNameWithoutExtension(clip.ResourcePath) : Name, clip != null);
    }

    /// <summary>Stops playing.</summary>
    public void Stop()
    {
        _fade?.Kill();
        Call("stop");
    }

    /// <summary>Fades the volume to <paramref name="volume"/> (0..1) over <paramref name="seconds"/>.</summary>
    public void FadeTo(float volume, float seconds)
    {
        _fade?.Kill();
        Volume = volume;
        _fade = CreateTween();
        _fade.TweenProperty(this, "volume_db", Mathf.LinearToDb(Mathf.Max(0.0001f, volume)), seconds);
    }

    /// <summary>Fades out and stops.</summary>
    public void FadeOut(float seconds = 1.5f)
    {
        _fade?.Kill();
        _fade = CreateTween();
        _fade.TweenProperty(this, "volume_db", -60.0, seconds);
        _fade.TweenCallback(Callable.From(() => Call("stop")));
    }
}
