using System.Collections.Generic;
using System.Globalization;
using System.Text.Json;
using Godot;

namespace Aige;

/// <summary>
/// Small helpers for reading AIGE JSON documents (cutscenes, voice lines, test files) with
/// System.Text.Json's DOM. No reflection, so the editor can always reload the assembly.
/// </summary>
public static class AigeJson
{
    static readonly JsonDocumentOptions Options = new()
    {
        AllowTrailingCommas = true,
        CommentHandling = JsonCommentHandling.Skip,
    };

    /// <summary>'cutscenes/a.json' → 'res://cutscenes/a.json'; res:// and user:// paths stay as they are.</summary>
    public static string ResPath(string path)
    {
        if (path.StartsWith("res://") || path.StartsWith("user://")) return path;
        return "res://" + path.TrimStart('.', '/');
    }

    /// <summary>Loads a JSON file from res:// (or a path relative to it). Returns null when missing or invalid.</summary>
    public static JsonElement? Load(string path)
    {
        var p = ResPath(path);
        if (!FileAccess.FileExists(p)) return null;
        return Parse(FileAccess.GetFileAsString(p), p);
    }

    /// <summary>Parses JSON text. Returns null (and logs an error) when it is invalid.</summary>
    public static JsonElement? Parse(string text, string what = "json")
    {
        try
        {
            using var doc = JsonDocument.Parse(text, Options);
            return doc.RootElement.Clone();
        }
        catch (JsonException e)
        {
            Log.Error($"Invalid JSON in {what}: {e.Message}");
            return null;
        }
    }

    public static bool Has(this JsonElement e, string key) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(key, out var v) && v.ValueKind != JsonValueKind.Null;

    public static JsonElement? Get(this JsonElement e, string key) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(key, out var v) && v.ValueKind != JsonValueKind.Null ? v : null;

    public static string? Str(this JsonElement e, string key)
    {
        var v = e.Get(key);
        if (v == null) return null;
        return v.Value.ValueKind == JsonValueKind.String ? v.Value.GetString() : v.Value.GetRawText();
    }

    public static float Num(this JsonElement e, string key, float fallback)
    {
        var v = e.Get(key);
        return v is { ValueKind: JsonValueKind.Number } n ? (float)n.GetDouble() : fallback;
    }

    public static float? NumOrNull(this JsonElement e, string key)
    {
        var v = e.Get(key);
        return v is { ValueKind: JsonValueKind.Number } n ? (float)n.GetDouble() : null;
    }

    public static bool Bool(this JsonElement e, string key, bool fallback)
    {
        var v = e.Get(key);
        if (v == null) return fallback;
        return v.Value.ValueKind switch
        {
            JsonValueKind.True => true,
            JsonValueKind.False => false,
            _ => fallback,
        };
    }

    public static bool? BoolOrNull(this JsonElement e, string key)
    {
        var v = e.Get(key);
        if (v == null) return null;
        return v.Value.ValueKind switch
        {
            JsonValueKind.True => true,
            JsonValueKind.False => false,
            _ => null,
        };
    }

    public static IEnumerable<JsonElement> Arr(this JsonElement e, string key)
    {
        var v = e.Get(key);
        if (v is { ValueKind: JsonValueKind.Array } a)
            foreach (var x in a.EnumerateArray())
                yield return x;
    }

    /// <summary>Reads [x, y, z] (missing components are 0).</summary>
    public static bool TryVec3(this JsonElement e, out Vector3 v)
    {
        v = Vector3.Zero;
        if (e.ValueKind != JsonValueKind.Array) return false;
        var i = 0;
        foreach (var x in e.EnumerateArray())
        {
            if (x.ValueKind != JsonValueKind.Number) return false;
            if (i < 3) v[i] = (float)x.GetDouble();
            i++;
        }
        return i >= 2;
    }

    public static bool TryVec3(this JsonElement e, string key, out Vector3 v)
    {
        v = Vector3.Zero;
        var x = e.Get(key);
        return x != null && x.Value.TryVec3(out v);
    }

    /// <summary>'#rrggbb' → Color.</summary>
    public static Color? ColorOrNull(this JsonElement e, string key)
    {
        var s = e.Str(key);
        if (string.IsNullOrEmpty(s)) return null;
        return Color.FromString(s, Colors.White);
    }

    public static string F(float v) => v.ToString("0.###", CultureInfo.InvariantCulture);
}
