#nullable enable
using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Text;
using UnityEngine;

namespace Aige
{
    /// <summary>
    /// A parsed JSON value (object, array, string, number, bool or null). Missing keys and indices
    /// return <see cref="Null"/>, so lookups chain safely: <c>doc["tracks"][0].Str("type")</c>.
    /// </summary>
    public sealed class JsonNode
    {
        public static readonly JsonNode Null = new JsonNode(null);
        static readonly List<JsonNode> NoItems = new List<JsonNode>();

        /// <summary>string, double, bool, List&lt;JsonNode&gt;, Dictionary&lt;string, JsonNode&gt; or null.</summary>
        public readonly object? Value;

        public JsonNode(object? value) { Value = value; }

        public bool IsNull => Value == null;
        public bool IsString => Value is string;
        public bool IsNumber => Value is double;
        public bool IsArray => Value is List<JsonNode>;
        public bool IsObject => Value is Dictionary<string, JsonNode>;

        public JsonNode this[string key] =>
            Value is Dictionary<string, JsonNode> d && d.TryGetValue(key, out var v) ? v : Null;

        public JsonNode this[int index] =>
            Value is List<JsonNode> l && index >= 0 && index < l.Count ? l[index] : Null;

        public bool Has(string key) => Value is Dictionary<string, JsonNode> d && d.ContainsKey(key) && !d[key].IsNull;

        /// <summary>Array items (empty when not an array).</summary>
        public IReadOnlyList<JsonNode> Items => Value as List<JsonNode> ?? NoItems;

        /// <summary>Object fields (empty when not an object).</summary>
        public IEnumerable<KeyValuePair<string, JsonNode>> Fields =>
            Value as Dictionary<string, JsonNode> ?? new Dictionary<string, JsonNode>();

        public string? AsString => Value as string;
        public float AsFloat(float fallback = 0f) => Value is double d ? (float)d : fallback;
        public bool AsBool(bool fallback = false) => Value is bool b ? b : fallback;

        public string? Str(string key) => this[key].Value as string;
        public float Num(string key, float fallback) => this[key].AsFloat(fallback);
        public float? NumOrNull(string key) => this[key].Value is double d ? (float)d : (float?)null;
        public bool Bool(string key, bool fallback) => this[key].AsBool(fallback);
        public IReadOnlyList<JsonNode> Arr(string key) => this[key].Items;

        /// <summary>Reads [x, y, z] as it is (no coordinate conversion).</summary>
        public bool TryVec3(out Vector3 v)
        {
            v = Vector3.zero;
            if (!(Value is List<JsonNode> l) || l.Count < 3) return false;
            v = new Vector3(l[0].AsFloat(), l[1].AsFloat(), l[2].AsFloat());
            return true;
        }

        public bool TryVec3(string key, out Vector3 v) => this[key].TryVec3(out v);

        /// <summary>Reads a '#rrggbb' color (null when missing).</summary>
        public Color? ColorOrNull(string key) => this[key].Value is string s ? AigeJson.ParseColor(s) : (Color?)null;
    }

    /// <summary>Minimal JSON reader/writer (no dependencies) for AIGE documents and test reports.</summary>
    public static class AigeJson
    {
        /// <summary>Parses JSON text; logs an error and returns null when it is invalid.</summary>
        public static JsonNode? Parse(string? text, string what = "json")
        {
            if (text == null) return null;
            try
            {
                var p = new Parser(text);
                var v = p.Value();
                return v;
            }
            catch (Exception e)
            {
                Log.Error($"Invalid JSON in {what}: {e.Message}");
                return null;
            }
        }

        /// <summary>Loads an AIGE JSON document exported under Resources/aige ('cutscenes/cs1.cutscene.json').</summary>
        public static JsonNode? Load(string aigePath) => Parse(AigeAssets.Text(aigePath), aigePath);

        /// <summary>'#rrggbb' or '#rrggbbaa' → Color (sRGB values, as Unity colors are).</summary>
        public static Color ParseColor(string hex)
        {
            var h = hex.TrimStart('#');
            if (h.Length < 6) return Color.white;
            float C(int i) => int.Parse(h.Substring(i, 2), NumberStyles.HexNumber) / 255f;
            return new Color(C(0), C(2), C(4), h.Length >= 8 ? C(6) : 1f);
        }

        /// <summary>Short invariant number formatting for logs.</summary>
        public static string F(float v) => v.ToString("0.###", CultureInfo.InvariantCulture);

        /// <summary>Serializes dictionaries, lists, strings, numbers, bools, Vector3 and null to JSON.</summary>
        public static string Write(object? value)
        {
            var sb = new StringBuilder();
            WriteValue(sb, value);
            return sb.ToString();
        }

        static void WriteValue(StringBuilder sb, object? v)
        {
            switch (v)
            {
                case null: sb.Append("null"); break;
                case string s: WriteString(sb, s); break;
                case bool b: sb.Append(b ? "true" : "false"); break;
                case float f: sb.Append(float.IsFinite(f) ? f.ToString("R", CultureInfo.InvariantCulture) : "0"); break;
                case double d: sb.Append(double.IsFinite(d) ? d.ToString("R", CultureInfo.InvariantCulture) : "0"); break;
                case int or long or short or byte: sb.Append(Convert.ToString(v, CultureInfo.InvariantCulture)); break;
                case Vector3 vec:
                    sb.Append('[').Append(Round(vec.x)).Append(',').Append(Round(vec.y)).Append(',').Append(Round(vec.z)).Append(']');
                    break;
                case JsonNode n: WriteValue(sb, n.Value is List<JsonNode> || n.Value is Dictionary<string, JsonNode> ? Plain(n) : n.Value); break;
                case IDictionary dict:
                    sb.Append('{');
                    var first = true;
                    foreach (DictionaryEntry kv in dict)
                    {
                        if (!first) sb.Append(',');
                        first = false;
                        WriteString(sb, Convert.ToString(kv.Key, CultureInfo.InvariantCulture) ?? "");
                        sb.Append(':');
                        WriteValue(sb, kv.Value);
                    }
                    sb.Append('}');
                    break;
                case IEnumerable list:
                    sb.Append('[');
                    var firstItem = true;
                    foreach (var item in list)
                    {
                        if (!firstItem) sb.Append(',');
                        firstItem = false;
                        WriteValue(sb, item);
                    }
                    sb.Append(']');
                    break;
                default: WriteString(sb, v.ToString() ?? ""); break;
            }
        }

        static object? Plain(JsonNode n)
        {
            if (n.Value is List<JsonNode> l)
            {
                var o = new List<object?>();
                foreach (var i in l) o.Add(Plain(i));
                return o;
            }
            if (n.Value is Dictionary<string, JsonNode> d)
            {
                var o = new Dictionary<string, object?>();
                foreach (var kv in d) o[kv.Key] = Plain(kv.Value);
                return o;
            }
            return n.Value;
        }

        static string Round(float f) => (Mathf.Round(f * 1000f) / 1000f).ToString("R", CultureInfo.InvariantCulture);

        static void WriteString(StringBuilder sb, string s)
        {
            sb.Append('"');
            foreach (var c in s)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < ' ') sb.Append("\\u").Append(((int)c).ToString("x4"));
                        else sb.Append(c);
                        break;
                }
            }
            sb.Append('"');
        }

        sealed class Parser
        {
            readonly string _s;
            int _i;

            public Parser(string s) { _s = s; }

            public JsonNode Value()
            {
                Ws();
                if (_i >= _s.Length) throw new FormatException("unexpected end");
                var c = _s[_i];
                switch (c)
                {
                    case '{': return Obj();
                    case '[': return Arr();
                    case '"': return new JsonNode(Str());
                    case 't': Expect("true"); return new JsonNode(true);
                    case 'f': Expect("false"); return new JsonNode(false);
                    case 'n': Expect("null"); return JsonNode.Null;
                    default: return new JsonNode(Number());
                }
            }

            JsonNode Obj()
            {
                var d = new Dictionary<string, JsonNode>();
                _i++;
                Ws();
                if (Peek() == '}') { _i++; return new JsonNode(d); }
                while (true)
                {
                    Ws();
                    var key = Str();
                    Ws();
                    if (Next() != ':') throw new FormatException($"':' expected at {_i}");
                    d[key] = Value();
                    Ws();
                    var c = Next();
                    if (c == '}') return new JsonNode(d);
                    if (c != ',') throw new FormatException($"',' or '}}' expected at {_i}");
                }
            }

            JsonNode Arr()
            {
                var l = new List<JsonNode>();
                _i++;
                Ws();
                if (Peek() == ']') { _i++; return new JsonNode(l); }
                while (true)
                {
                    l.Add(Value());
                    Ws();
                    var c = Next();
                    if (c == ']') return new JsonNode(l);
                    if (c != ',') throw new FormatException($"',' or ']' expected at {_i}");
                }
            }

            string Str()
            {
                if (Next() != '"') throw new FormatException($"string expected at {_i}");
                var sb = new StringBuilder();
                while (true)
                {
                    var c = Next();
                    if (c == '"') return sb.ToString();
                    if (c != '\\') { sb.Append(c); continue; }
                    var e = Next();
                    switch (e)
                    {
                        case 'n': sb.Append('\n'); break;
                        case 't': sb.Append('\t'); break;
                        case 'r': sb.Append('\r'); break;
                        case 'b': sb.Append('\b'); break;
                        case 'f': sb.Append('\f'); break;
                        case 'u':
                            sb.Append((char)int.Parse(_s.Substring(_i, 4), NumberStyles.HexNumber));
                            _i += 4;
                            break;
                        default: sb.Append(e); break;
                    }
                }
            }

            double Number()
            {
                var start = _i;
                while (_i < _s.Length && "+-0123456789.eE".IndexOf(_s[_i]) >= 0) _i++;
                if (start == _i) throw new FormatException($"unexpected '{_s[_i]}' at {_i}");
                return double.Parse(_s.Substring(start, _i - start), NumberStyles.Float, CultureInfo.InvariantCulture);
            }

            void Expect(string word)
            {
                if (string.CompareOrdinal(_s, _i, word, 0, word.Length) != 0) throw new FormatException($"'{word}' expected at {_i}");
                _i += word.Length;
            }

            char Peek() => _i < _s.Length ? _s[_i] : '\0';

            char Next()
            {
                if (_i >= _s.Length) throw new FormatException("unexpected end");
                return _s[_i++];
            }

            void Ws()
            {
                while (_i < _s.Length && char.IsWhiteSpace(_s[_i])) _i++;
            }
        }
    }
}
