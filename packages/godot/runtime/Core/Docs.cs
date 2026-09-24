using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using Godot;

namespace Aige;

/// <summary>A point in space: a world position or an entity reference (id, name or path).</summary>
public readonly struct PointRef
{
    public readonly Vector3 Position;
    public readonly string? Entity;

    public PointRef(Vector3 position, string? entity = null)
    {
        Position = position;
        Entity = entity;
    }

    public static PointRef Read(JsonElement? e)
    {
        if (e == null) return new PointRef(Vector3.Zero);
        if (e.Value.ValueKind == JsonValueKind.String) return new PointRef(Vector3.Zero, e.Value.GetString());
        return e.Value.TryVec3(out var v) ? new PointRef(v) : new PointRef(Vector3.Zero);
    }
}

/// <summary>A camera key of a cutscene camera track (CameraKey in documents.ts).</summary>
public sealed class CameraKeyDoc
{
    public float T;
    public PointRef Position;
    public PointRef LookAt;
    public float Fov = 50f;
    public string Ease = "inOut";
    public bool Cut;
    public float Shake;
    public float Focus;
    public float Aperture = 0.5f;
}

/// <summary>A key of a cutscene move track.</summary>
public sealed class MoveKeyDoc
{
    public float T;
    public Vector3 Position;
    public Vector3? Rotation;
    public string Ease = "inOut";
}

/// <summary>
/// One timed item of any non-camera cutscene track. Only the fields of the track's type are set
/// (defaults follow documents.ts).
/// </summary>
public sealed class CutsceneItemDoc
{
    public float T;
    // animation
    public string? Clip;
    public bool Loop;
    public float Fade = 0.25f;
    public float Speed = 1f;
    // voice
    public string? Line;
    public string? Actor;
    public bool Subtitle = true;
    // sound
    public string? Sfx;
    public float Volume = 1f;
    public string? At;
    // subtitle / fx / light
    public float Duration;
    public string? Text;
    public string? Speaker;
    public string? Effect;
    public float To;
    public Color? Color;
    public string? Entity;
    public float Intensity;
    // event
    public string? SetFlag;
    public string? ClearFlag;
    public string? Enable;
    public string? Disable;
    public string? Give;
    public string? Take;
    public string? Objective;
    public string? TeleportEntity;
    public Vector3 TeleportPosition;
    public Vector3? TeleportRotation;
    public string? Emit;
}

/// <summary>One track of a cutscene.</summary>
public sealed class CutsceneTrackDoc
{
    public string Type = "";
    public string? Actor;
    public List<CameraKeyDoc> CameraKeys = new();
    public List<MoveKeyDoc> MoveKeys = new();
    public List<CutsceneItemDoc> Items = new();

    /// <summary>Last time used by the track (item start + duration where that applies).</summary>
    public float End()
    {
        var end = 0f;
        foreach (var k in CameraKeys) end = Math.Max(end, k.T);
        foreach (var k in MoveKeys) end = Math.Max(end, k.T);
        foreach (var i in Items)
        {
            var d = Type switch
            {
                "subtitle" or "fx" or "light" => i.Duration,
                "voice" => VoiceLineDoc.Load(i.Line ?? "")?.Duration ?? 0f,
                _ => 0f,
            };
            end = Math.Max(end, i.T + d);
        }
        return end;
    }
}

/// <summary>A parsed <c>*.cutscene.json</c> (CutsceneDoc in packages/core/src/schema/documents.ts).</summary>
public sealed class CutsceneDoc
{
    public string Path = "";
    public string Name = "";
    public float? Duration;
    public bool Skippable = true;
    public bool Letterbox = true;
    public bool ReturnControl = true;
    public List<CutsceneTrackDoc> Tracks = new();

    /// <summary>Total length: <see cref="Duration"/> or the end of the last track item.</summary>
    public float Length => Duration ?? Math.Max(0.1f, Tracks.Count == 0 ? 0.1f : Tracks.Max(t => t.End()));

    /// <summary>Loads a cutscene by path ('res://cutscenes/cs1.cutscene.json', 'cutscenes/cs1.cutscene.json') or name ('cs1').</summary>
    public static CutsceneDoc? Load(string pathOrName)
    {
        var path = pathOrName.Contains('/') || pathOrName.EndsWith(".json")
            ? AigeJson.ResPath(pathOrName)
            : $"res://cutscenes/{pathOrName}.cutscene.json";
        var root = AigeJson.Load(path);
        if (root == null)
        {
            Log.Error($"Cutscene '{path}' not found.");
            return null;
        }
        var r = root.Value;
        var doc = new CutsceneDoc
        {
            Path = path,
            Name = r.Str("name") ?? System.IO.Path.GetFileName(path).Replace(".cutscene.json", ""),
            Duration = r.NumOrNull("duration"),
            Skippable = r.Bool("skippable", true),
            Letterbox = r.Bool("letterbox", true),
            ReturnControl = r.Bool("returnControl", true),
        };
        foreach (var t in r.Arr("tracks")) doc.Tracks.Add(ReadTrack(t));
        return doc;
    }

    static CutsceneTrackDoc ReadTrack(JsonElement t)
    {
        var track = new CutsceneTrackDoc { Type = t.Str("type") ?? "", Actor = t.Str("actor") };
        switch (track.Type)
        {
            case "camera":
                foreach (var k in t.Arr("keys"))
                {
                    track.CameraKeys.Add(new CameraKeyDoc
                    {
                        T = k.Num("t", 0),
                        Position = PointRef.Read(k.Get("position")),
                        LookAt = PointRef.Read(k.Get("lookAt")),
                        Fov = k.Num("fov", 50),
                        Ease = k.Str("ease") ?? "inOut",
                        Cut = k.Bool("cut", false),
                        Shake = k.Num("shake", 0),
                        Focus = k.Num("focus", 0),
                        Aperture = k.Num("aperture", 0.5f),
                    });
                }
                track.CameraKeys.Sort((a, b) => a.T.CompareTo(b.T));
                break;
            case "move":
                foreach (var k in t.Arr("keys"))
                {
                    k.TryVec3("position", out var p);
                    track.MoveKeys.Add(new MoveKeyDoc
                    {
                        T = k.Num("t", 0),
                        Position = p,
                        Rotation = k.TryVec3("rotation", out var rot) ? rot : null,
                        Ease = k.Str("ease") ?? "inOut",
                    });
                }
                track.MoveKeys.Sort((a, b) => a.T.CompareTo(b.T));
                break;
            default:
                var key = track.Type is "animation" or "voice" or "sound" ? "clips" : "items";
                foreach (var i in t.Arr(key)) track.Items.Add(ReadItem(track.Type, i));
                track.Items.Sort((a, b) => a.T.CompareTo(b.T));
                break;
        }
        return track;
    }

    static CutsceneItemDoc ReadItem(string type, JsonElement i)
    {
        var item = new CutsceneItemDoc
        {
            T = i.Num("t", 0),
            Clip = i.Str("clip"),
            Loop = i.Bool("loop", false),
            Fade = i.Num("fade", 0.25f),
            Speed = i.Num("speed", 1f),
            Line = i.Str("line"),
            Actor = i.Str("actor"),
            Subtitle = i.Bool("subtitle", true),
            Sfx = i.Str("sfx"),
            Volume = i.Num("volume", 1f),
            At = i.Str("at"),
            Duration = i.Num("duration", type == "fx" ? 0.5f : 0f),
            Text = i.Str("text"),
            Speaker = i.Str("speaker"),
            Effect = i.Str("effect"),
            To = i.Num("to", 0f),
            Color = i.ColorOrNull("color"),
            Entity = i.Str("entity"),
            Intensity = i.Num("intensity", 0f),
            SetFlag = i.Str("setFlag"),
            ClearFlag = i.Str("clearFlag"),
            Enable = i.Str("enable"),
            Disable = i.Str("disable"),
            Give = i.Str("give"),
            Take = i.Str("take"),
            Objective = i.Str("objective"),
            Emit = i.Str("emit"),
        };
        if (i.Get("teleport") is { } tp)
        {
            item.TeleportEntity = tp.Str("entity");
            tp.TryVec3("position", out item.TeleportPosition);
            if (tp.TryVec3("rotation", out var r)) item.TeleportRotation = r;
        }
        return item;
    }
}

/// <summary>A parsed voice line (<c>res://audio/voice/&lt;id&gt;.json</c>, VoiceLineDoc in documents.ts).</summary>
public sealed class VoiceLineDoc
{
    static readonly Dictionary<string, VoiceLineDoc?> Cache = new();

    public string Id = "";
    public string Speaker = "";
    public string Text = "";
    /// <summary>res:// path of the audio file.</summary>
    public string Audio = "";
    public float Duration;
    public float Fps = 30f;
    public float[] Mouth = Array.Empty<float>();

    /// <summary>Mouth opening 0..1 at <paramref name="time"/> seconds (linear between frames).</summary>
    public float MouthAt(float time)
    {
        if (Mouth.Length == 0 || time < 0) return 0f;
        var f = time * Fps;
        var i = (int)f;
        if (i >= Mouth.Length - 1) return i < Mouth.Length ? Mouth[^1] * Mathf.Clamp(1f - (f - i), 0f, 1f) : 0f;
        return Mathf.Lerp(Mouth[i], Mouth[i + 1], f - i);
    }

    /// <summary>Loads a voice line by id ('hero_wake_1') or path. Cached; returns null when missing.</summary>
    public static VoiceLineDoc? Load(string idOrPath)
    {
        if (string.IsNullOrEmpty(idOrPath)) return null;
        if (Cache.TryGetValue(idOrPath, out var cached)) return cached;
        var path = idOrPath.EndsWith(".json") ? AigeJson.ResPath(idOrPath) : $"res://audio/voice/{idOrPath}.json";
        VoiceLineDoc? doc = null;
        if (AigeJson.Load(path) is { } r)
        {
            var id = r.Str("id") ?? System.IO.Path.GetFileNameWithoutExtension(path);
            doc = new VoiceLineDoc
            {
                Id = id,
                Speaker = r.Str("speaker") ?? "",
                Text = r.Str("text") ?? "",
                Audio = AigeJson.ResPath(r.Str("audio") ?? $"audio/voice/{id}.ogg"),
                Duration = r.Num("duration", 0f),
                Fps = Math.Max(1f, r.Num("fps", 30f)),
                Mouth = r.Arr("mouth").Select(m => m.ValueKind == JsonValueKind.Number ? (float)m.GetDouble() : 0f).ToArray(),
            };
            if (doc.Duration <= 0 && doc.Mouth.Length > 0) doc.Duration = doc.Mouth.Length / doc.Fps;
        }
        Cache[idOrPath] = doc;
        return doc;
    }
}

/// <summary>Easing curves used by cutscene keys ('linear', 'in', 'out', 'inOut', 'hold').</summary>
public static class Easing
{
    public static float Apply(string? ease, float t)
    {
        t = Mathf.Clamp(t, 0f, 1f);
        return ease switch
        {
            "linear" => t,
            "in" => t * t * t,
            "out" => 1f - MathF.Pow(1f - t, 3f),
            "hold" => t >= 1f ? 1f : 0f,
            _ => t < 0.5f ? 4f * t * t * t : 1f - MathF.Pow(-2f * t + 2f, 3f) / 2f,
        };
    }

    /// <summary>Hermite smoothstep.</summary>
    public static float Smooth(float t)
    {
        t = Mathf.Clamp(t, 0f, 1f);
        return t * t * (3f - 2f * t);
    }

    /// <summary>Frame-rate independent exponential smoothing factor for a rate (1/s).</summary>
    public static float Damp(float rate, double delta) => 1f - MathF.Exp(-rate * (float)delta);
}
