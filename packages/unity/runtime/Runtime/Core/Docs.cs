#nullable enable
using System;
using System.Collections.Generic;
using System.Linq;
using UnityEngine;

namespace Aige
{
    /// <summary>A point: a world position (already in Unity coordinates) or an entity reference.</summary>
    public readonly struct PointRef
    {
        public readonly Vector3 Position;
        public readonly string? Entity;

        public PointRef(Vector3 position, string? entity = null)
        {
            Position = position;
            Entity = entity;
        }

        public static PointRef Read(JsonNode n)
        {
            if (n.AsString is string s) return new PointRef(Vector3.zero, s);
            return n.TryVec3(out var v) ? new PointRef(Coords.Position(v)) : new PointRef(Vector3.zero);
        }
    }

    /// <summary>A camera key of a cutscene camera track (CameraKey in documents.ts). Positions are in Unity space.</summary>
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

    /// <summary>A key of a cutscene move track (Unity space).</summary>
    public sealed class MoveKeyDoc
    {
        public float T;
        public Vector3 Position;
        public Quaternion? Rotation;
        public string Ease = "inOut";
    }

    /// <summary>One timed item of a non-camera cutscene track (only the fields of the track's type are set).</summary>
    public sealed class CutsceneItemDoc
    {
        public float T;
        public string? Clip;
        public bool Loop;
        public float Fade = 0.25f;
        public float Speed = 1f;
        public string? Line;
        public string? Actor;
        public bool Subtitle = true;
        public string? Sfx;
        public float Volume = 1f;
        public string? At;
        public float Duration;
        public string? Text;
        public string? Speaker;
        public string? Effect;
        public float To;
        public Color? Color;
        public string? Entity;
        public float Intensity;
        public string? SetFlag;
        public string? ClearFlag;
        public string? Enable;
        public string? Disable;
        public string? Give;
        public string? Take;
        public string? Objective;
        public string? TeleportEntity;
        public Vector3 TeleportPosition;
        public Quaternion? TeleportRotation;
        public string? Emit;
    }

    /// <summary>One track of a cutscene.</summary>
    public sealed class CutsceneTrackDoc
    {
        public string Type = "";
        public string? Actor;
        public List<CameraKeyDoc> CameraKeys = new List<CameraKeyDoc>();
        public List<MoveKeyDoc> MoveKeys = new List<MoveKeyDoc>();
        public List<CutsceneItemDoc> Items = new List<CutsceneItemDoc>();

        /// <summary>Last time used by the track (item start + duration where that applies).</summary>
        public float End()
        {
            var end = 0f;
            foreach (var k in CameraKeys) end = Mathf.Max(end, k.T);
            foreach (var k in MoveKeys) end = Mathf.Max(end, k.T);
            foreach (var i in Items)
            {
                var d = Type == "subtitle" || Type == "fx" || Type == "light" ? i.Duration
                    : Type == "voice" ? VoiceLineDoc.Load(i.Line ?? "")?.Duration ?? 0f : 0f;
                end = Mathf.Max(end, i.T + d);
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
        public List<CutsceneTrackDoc> Tracks = new List<CutsceneTrackDoc>();

        /// <summary>Total length: <see cref="Duration"/> or the end of the last track item.</summary>
        public float Length => Duration ?? Mathf.Max(0.1f, Tracks.Count == 0 ? 0.1f : Tracks.Max(t => t.End()));

        /// <summary>Loads by path ('cutscenes/cs1.cutscene.json', 'res://cutscenes/cs1.cutscene.json') or name ('cs1').</summary>
        public static CutsceneDoc? Load(string pathOrName)
        {
            var path = pathOrName.Contains("/") || pathOrName.EndsWith(".json")
                ? AigeAssets.Clean(pathOrName)
                : $"cutscenes/{pathOrName}.cutscene.json";
            var root = AigeJson.Load(path);
            if (root == null)
            {
                Log.Error($"Cutscene '{path}' not found (expected Assets/Resources/aige/{path}; run unity_export).");
                return null;
            }
            var doc = new CutsceneDoc
            {
                Path = path,
                Name = root.Str("name") ?? System.IO.Path.GetFileName(path).Replace(".cutscene.json", ""),
                Duration = root.NumOrNull("duration"),
                Skippable = root.Bool("skippable", true),
                Letterbox = root.Bool("letterbox", true),
                ReturnControl = root.Bool("returnControl", true),
            };
            foreach (var t in root.Arr("tracks")) doc.Tracks.Add(ReadTrack(t));
            return doc;
        }

        static CutsceneTrackDoc ReadTrack(JsonNode t)
        {
            var track = new CutsceneTrackDoc { Type = t.Str("type") ?? "", Actor = t.Str("actor") };
            switch (track.Type)
            {
                case "camera":
                    foreach (var k in t.Arr("keys"))
                        track.CameraKeys.Add(new CameraKeyDoc
                        {
                            T = k.Num("t", 0),
                            Position = PointRef.Read(k["position"]),
                            LookAt = PointRef.Read(k["lookAt"]),
                            Fov = k.Num("fov", 50),
                            Ease = k.Str("ease") ?? "inOut",
                            Cut = k.Bool("cut", false),
                            Shake = k.Num("shake", 0),
                            Focus = k.Num("focus", 0),
                            Aperture = k.Num("aperture", 0.5f),
                        });
                    track.CameraKeys.Sort((a, b) => a.T.CompareTo(b.T));
                    break;
                case "move":
                    foreach (var k in t.Arr("keys"))
                    {
                        k.TryVec3("position", out var p);
                        track.MoveKeys.Add(new MoveKeyDoc
                        {
                            T = k.Num("t", 0),
                            Position = Coords.Position(p),
                            Rotation = k.TryVec3("rotation", out var rot) ? Coords.Rotation(rot) : (Quaternion?)null,
                            Ease = k.Str("ease") ?? "inOut",
                        });
                    }
                    track.MoveKeys.Sort((a, b) => a.T.CompareTo(b.T));
                    break;
                default:
                    var key = track.Type == "animation" || track.Type == "voice" || track.Type == "sound" ? "clips" : "items";
                    foreach (var i in t.Arr(key)) track.Items.Add(ReadItem(track.Type, i));
                    track.Items.Sort((a, b) => a.T.CompareTo(b.T));
                    break;
            }
            return track;
        }

        static CutsceneItemDoc ReadItem(string type, JsonNode i)
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
            var tp = i["teleport"];
            if (tp.IsObject)
            {
                item.TeleportEntity = tp.Str("entity");
                tp.TryVec3("position", out var p);
                item.TeleportPosition = Coords.Position(p);
                if (tp.TryVec3("rotation", out var r)) item.TeleportRotation = Coords.Rotation(r);
            }
            return item;
        }
    }

    /// <summary>A parsed voice line (<c>audio/voice/&lt;id&gt;.json</c>, VoiceLineDoc in documents.ts).</summary>
    public sealed class VoiceLineDoc
    {
        static readonly Dictionary<string, VoiceLineDoc?> Cache = new Dictionary<string, VoiceLineDoc?>();

        public string Id = "";
        public string Speaker = "";
        public string Text = "";
        /// <summary>AIGE path of the audio file ('audio/voice/x.ogg').</summary>
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
            if (i >= Mouth.Length - 1) return i < Mouth.Length ? Mouth[Mouth.Length - 1] * Mathf.Clamp01(1f - (f - i)) : 0f;
            return Mathf.Lerp(Mouth[i], Mouth[i + 1], f - i);
        }

        /// <summary>Loads a voice line by id ('milch_wake_1') or path. Cached; null when missing.</summary>
        public static VoiceLineDoc? Load(string idOrPath)
        {
            if (string.IsNullOrEmpty(idOrPath)) return null;
            if (Cache.TryGetValue(idOrPath, out var cached)) return cached;
            var path = idOrPath.EndsWith(".json") ? AigeAssets.Clean(idOrPath) : $"audio/voice/{idOrPath}.json";
            VoiceLineDoc? doc = null;
            var text = AigeAssets.Text(path);
            var r = text != null ? AigeJson.Parse(text, path) : null;
            if (r != null)
            {
                var id = r.Str("id") ?? System.IO.Path.GetFileNameWithoutExtension(path);
                doc = new VoiceLineDoc
                {
                    Id = id,
                    Speaker = r.Str("speaker") ?? "",
                    Text = r.Str("text") ?? "",
                    Audio = AigeAssets.Clean(r.Str("audio") ?? $"audio/voice/{id}.ogg"),
                    Duration = r.Num("duration", 0f),
                    Fps = Mathf.Max(1f, r.Num("fps", 30f)),
                    Mouth = r.Arr("mouth").Select(m => m.AsFloat()).ToArray(),
                };
                if (doc.Duration <= 0 && doc.Mouth.Length > 0) doc.Duration = doc.Mouth.Length / doc.Fps;
            }
            Cache[idOrPath] = doc;
            return doc;
        }
    }
}
