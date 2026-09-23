using System;
using System.Collections.Generic;
using Godot;

namespace Aige;

/// <summary>
/// Captures Godot's log output (prints, warnings, errors, C# exceptions) for the test report.
/// Registered with <c>OS.AddLogger</c> by <see cref="AigeTest"/>. Called from any thread.
/// </summary>
public partial class AigeLogger : Logger
{
    readonly object _lock = new();
    readonly List<string> _logs = new();
    readonly List<string> _errors = new();
    volatile bool _crashed;
    string? _crash;

    /// <summary>Stops recording (after the report is written).</summary>
    public bool Enabled { get; set; } = true;

    /// <summary>True after an unhandled C# exception was reported.</summary>
    public bool Crashed => _crashed;

    /// <summary>The first unhandled exception message.</summary>
    public string? Crash
    {
        get
        {
            lock (_lock) return _crash;
        }
    }

    public override void _LogMessage(string message, bool error)
    {
        if (!Enabled) return;
        var text = message.TrimEnd('\n', '\r');
        if (text.Length == 0) return;
        lock (_lock)
        {
            if (error) _errors.Add(text);
            else _logs.Add(text);
        }
    }

    public override void _LogError(string function, string file, int line, string code, string rationale, bool editorNotify, int errorType, Godot.Collections.Array<ScriptBacktrace> scriptBacktraces)
    {
        if (!Enabled) return;
        var what = string.IsNullOrEmpty(rationale) ? code : rationale;
        var where = string.IsNullOrEmpty(file) ? "" : $" ({System.IO.Path.GetFileName(file)}:{line})";
        var kind = (Logger.ErrorType)errorType;
        var text = what + where;
        lock (_lock)
        {
            if (kind == Logger.ErrorType.Warning)
            {
                _logs.Add("WARNING: " + text);
                return;
            }
            _errors.Add(text);
            var all = code + " " + rationale;
            if (all.Contains("Exception") && (all.Contains("System.") || all.Contains("   at ")))
            {
                _crashed = true;
                _crash ??= text;
            }
        }
    }

    /// <summary>Records an error that did not go through Godot's logger.</summary>
    public void AddError(string text, bool crash = false)
    {
        lock (_lock)
        {
            _errors.Add(text);
            if (!crash) return;
            _crashed = true;
            _crash ??= text;
        }
    }

    /// <summary>Copies of the captured logs and errors.</summary>
    public (string[] logs, string[] errors) Snapshot()
    {
        lock (_lock) return (_logs.ToArray(), _errors.ToArray());
    }
}
