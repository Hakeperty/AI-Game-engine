#nullable enable
using System;
using System.IO;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace Aige.Editor
{
    /// <summary>
    /// Automated play-test inside the editor, in batch mode (no player build):
    /// <c>-executeMethod Aige.Editor.AigePlay.Run -aigeScene Assets/Scenes/x.unity -aigeTest &lt;test.json&gt; -aigeReport &lt;report.json&gt;</c>
    /// (without -quit). It enters Play mode; the runtime AigeTest harness plays the test, writes the report and
    /// stops Play mode, then the editor exits.
    /// </summary>
    [InitializeOnLoad]
    public static class AigePlay
    {
        const string ExitVar = "AIGE_PLAYTEST_EXIT";

        static AigePlay()
        {
            if (Environment.GetEnvironmentVariable(ExitVar) != "1") return;
            EditorApplication.playModeStateChanged += state =>
            {
                if (state == PlayModeStateChange.EnteredEditMode) EditorApplication.Exit(0);
            };
        }

        public static void Run()
        {
            var test = AigeImporter.Arg("aigeTest");
            var report = AigeImporter.Arg("aigeReport");
            var scene = AigeImporter.Arg("aigeScene");
            if (string.IsNullOrEmpty(test) || !File.Exists(test))
            {
                Debug.LogError("[aige] AigePlay.Run needs -aigeTest <test.json>.");
                EditorApplication.Exit(2);
                return;
            }
            Environment.SetEnvironmentVariable("AIGE_TEST", Path.GetFullPath(test));
            Environment.SetEnvironmentVariable("AIGE_REPORT", Path.GetFullPath(report ?? Path.ChangeExtension(test, ".report.json")));
            Environment.SetEnvironmentVariable(ExitVar, "1");
            if (!string.IsNullOrEmpty(scene)) EditorSceneManager.OpenScene(scene);
            else if (EditorBuildSettings.scenes.Length > 0) EditorSceneManager.OpenScene(EditorBuildSettings.scenes[0].path);
            EditorApplication.playModeStateChanged += state =>
            {
                if (state == PlayModeStateChange.EnteredEditMode) EditorApplication.Exit(0);
            };
            EditorApplication.isPlaying = true;
        }
    }
}
