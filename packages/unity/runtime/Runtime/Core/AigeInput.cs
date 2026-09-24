#nullable enable
using System.Collections.Generic;
using UnityEngine;
#if ENABLE_INPUT_SYSTEM
using UnityEngine.InputSystem;
#endif

namespace Aige
{
    /// <summary>
    /// AIGE input actions, the same names as the Godot runtime: move_forward (W/Up), move_back (S/Down),
    /// move_left (A/Left), move_right (D/Right), sprint (Shift), jump (Space), crouch (C/Ctrl), interact
    /// (E, gamepad X/Square), attack (left mouse), skip (Space/Enter/Esc, hold to skip cutscenes), pause (Esc).
    /// Works with the Input System package or the old Input Manager. The test harness can press actions.
    /// </summary>
    /// <example><code>if (AigeInput.JustPressed("interact")) Hud.Say("Hello");</code></example>
    public static class AigeInput
    {
#if ENABLE_INPUT_SYSTEM
        static readonly Dictionary<string, Key[]> Keys = new Dictionary<string, Key[]>
        {
            ["move_forward"] = new[] { Key.W, Key.UpArrow },
            ["move_back"] = new[] { Key.S, Key.DownArrow },
            ["move_left"] = new[] { Key.A, Key.LeftArrow },
            ["move_right"] = new[] { Key.D, Key.RightArrow },
            ["sprint"] = new[] { Key.LeftShift, Key.RightShift },
            ["jump"] = new[] { Key.Space },
            ["crouch"] = new[] { Key.C, Key.LeftCtrl },
            ["interact"] = new[] { Key.E },
            ["skip"] = new[] { Key.Space, Key.Enter, Key.Escape },
            ["pause"] = new[] { Key.Escape },
        };
#else
        static readonly Dictionary<string, KeyCode[]> Keys = new Dictionary<string, KeyCode[]>
        {
            ["move_forward"] = new[] { KeyCode.W, KeyCode.UpArrow },
            ["move_back"] = new[] { KeyCode.S, KeyCode.DownArrow },
            ["move_left"] = new[] { KeyCode.A, KeyCode.LeftArrow },
            ["move_right"] = new[] { KeyCode.D, KeyCode.RightArrow },
            ["sprint"] = new[] { KeyCode.LeftShift, KeyCode.RightShift },
            ["jump"] = new[] { KeyCode.Space },
            ["crouch"] = new[] { KeyCode.C, KeyCode.LeftControl },
            ["interact"] = new[] { KeyCode.E, KeyCode.JoystickButton2 },
            ["attack"] = new[] { KeyCode.Mouse0 },
            ["skip"] = new[] { KeyCode.Space, KeyCode.Return, KeyCode.Escape },
            ["pause"] = new[] { KeyCode.Escape },
        };
#endif

        static readonly Dictionary<string, int> ForcedDown = new Dictionary<string, int>();
        static readonly Dictionary<string, int> ForcedUp = new Dictionary<string, int>();
        static Vector2 _forcedLook;
        static int _lookFrame = -1;
        static Vector2 _lookThisFrame;

        /// <summary>False ignores the real devices (automated tests).</summary>
        public static bool DevicesEnabled { get; set; } = true;

        /// <summary>True while the action is held.</summary>
        public static bool Pressed(string action) => ForcedDown.ContainsKey(action) || (DevicesEnabled && Device(action, 0));

        /// <summary>True on the frame the action was pressed.</summary>
        public static bool JustPressed(string action) =>
            (ForcedDown.TryGetValue(action, out var f) && f == Time.frameCount) || (DevicesEnabled && Device(action, 1));

        /// <summary>True on the frame the action was released.</summary>
        public static bool JustReleased(string action) =>
            (ForcedUp.TryGetValue(action, out var f) && f == Time.frameCount) || (DevicesEnabled && Device(action, 2));

        /// <summary>Movement input: x = right, y = forward (length ≤ 1). Keys and the left stick.</summary>
        public static Vector2 Move
        {
            get
            {
                var v = new Vector2(
                    (Pressed("move_right") ? 1f : 0f) - (Pressed("move_left") ? 1f : 0f),
                    (Pressed("move_forward") ? 1f : 0f) - (Pressed("move_back") ? 1f : 0f));
#if ENABLE_INPUT_SYSTEM
                if (DevicesEnabled && Gamepad.current != null)
                {
                    var s = Gamepad.current.leftStick.ReadValue();
                    if (s.sqrMagnitude > 0.04f) v += s;
                }
#endif
                return Vector2.ClampMagnitude(v, 1f);
            }
        }

        /// <summary>Camera look delta this frame in pixels (mouse, plus scripted look from tests).</summary>
        public static Vector2 LookDelta
        {
            get
            {
                if (_lookFrame == Time.frameCount) return _lookThisFrame;
                _lookFrame = Time.frameCount;
                var d = _forcedLook;
                _forcedLook = Vector2.zero;
                if (DevicesEnabled)
                {
#if ENABLE_INPUT_SYSTEM
                    if (Mouse.current != null) d += Mouse.current.delta.ReadValue();
#else
                    d += new Vector2(Input.GetAxisRaw("Mouse X"), -Input.GetAxisRaw("Mouse Y")) * 10f;
#endif
                }
                _lookThisFrame = d;
                return d;
            }
        }

        /// <summary>Right-stick look input (-1..1), zero without a gamepad.</summary>
        public static Vector2 LookStick
        {
            get
            {
#if ENABLE_INPUT_SYSTEM
                if (DevicesEnabled && Gamepad.current != null)
                {
                    var s = Gamepad.current.rightStick.ReadValue();
                    return new Vector2(s.x, -s.y);
                }
#endif
                return Vector2.zero;
            }
        }

        /// <summary>Presses or releases an action from code (the test harness uses this).</summary>
        public static void SetForced(string action, bool down)
        {
            if (down)
            {
                if (!ForcedDown.ContainsKey(action)) ForcedDown[action] = Time.frameCount;
            }
            else if (ForcedDown.Remove(action)) ForcedUp[action] = Time.frameCount;
        }

        /// <summary>Adds a scripted mouse-look delta in pixels.</summary>
        public static void AddLook(Vector2 pixels) => _forcedLook += pixels;

        /// <summary>Display name of the first key of an action ('E').</summary>
        public static string KeyName(string action, string fallback)
        {
            if (!Keys.TryGetValue(action, out var keys) || keys.Length == 0) return fallback;
            var s = keys[0].ToString();
            return s.Length > 6 ? fallback : s.ToUpperInvariant();
        }

        // mode 0 = held, 1 = pressed this frame, 2 = released this frame
        static bool Device(string action, int mode)
        {
#if ENABLE_INPUT_SYSTEM
            var kb = Keyboard.current;
            if (kb != null && Keys.TryGetValue(action, out var keys))
                foreach (var k in keys)
                {
                    var c = kb[k];
                    if (mode == 0 ? c.isPressed : mode == 1 ? c.wasPressedThisFrame : c.wasReleasedThisFrame) return true;
                }
            UnityEngine.InputSystem.Controls.ButtonControl? b = null;
            var pad = Gamepad.current;
            if (action == "attack") b = Mouse.current?.leftButton;
            else if (pad != null)
                b = action switch
                {
                    "interact" => pad.buttonWest,
                    "jump" => pad.buttonSouth,
                    "sprint" => pad.leftStickButton,
                    "crouch" => pad.rightStickButton,
                    "skip" => pad.buttonSouth,
                    "pause" => pad.startButton,
                    _ => null,
                };
            if (b != null && (mode == 0 ? b.isPressed : mode == 1 ? b.wasPressedThisFrame : b.wasReleasedThisFrame)) return true;
            return false;
#else
            if (!Keys.TryGetValue(action, out var keys)) return false;
            foreach (var k in keys)
                if (mode == 0 ? Input.GetKey(k) : mode == 1 ? Input.GetKeyDown(k) : Input.GetKeyUp(k)) return true;
            return false;
#endif
        }

        /// <summary>Locks and hides the cursor for mouse look (not during automated tests).</summary>
        public static void CaptureMouse(bool capture)
        {
            if (AigeTest.Active) return;
            Cursor.lockState = capture ? CursorLockMode.Locked : CursorLockMode.None;
            Cursor.visible = !capture;
        }
    }
}
