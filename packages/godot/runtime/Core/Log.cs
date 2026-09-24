using System;
using System.Collections.Generic;
using Godot;

namespace Aige;

/// <summary>
/// Runtime logging. Messages go to Godot's output; the test harness copies them into the report.
/// </summary>
public static class Log
{
    static readonly HashSet<string> Once = new();

    /// <summary>Raised for every <see cref="Info"/> message (the test harness records it as a 'log' event).</summary>
    public static event Action<string>? Message;

    /// <summary>Prints a message and records it as a 'log' event in test reports.</summary>
    /// <example><code>Log.Info("Hero found the knife");</code></example>
    public static void Info(string message)
    {
        GD.Print("[aige] " + message);
        Message?.Invoke(message);
    }

    /// <summary>Prints a warning (does not fail a test run).</summary>
    public static void Warn(string message) => GD.PushWarning("[aige] " + message);

    /// <summary>Prints an error (fails a test run).</summary>
    public static void Error(string message) => GD.PushError("[aige] " + message);

    /// <summary>Prints a warning only the first time <paramref name="key"/> is seen.</summary>
    public static void WarnOnce(string key, string message)
    {
        if (Once.Add(key)) Warn(message);
    }
}
