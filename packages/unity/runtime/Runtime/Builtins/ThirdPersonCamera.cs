#nullable enable
using UnityEngine;
using UnityEngine.Rendering.Universal;

namespace Aige
{
    /// <summary>
    /// Built-in over-the-shoulder camera (AIGE 'builtin:ThirdPersonCamera'), like modern third-person games:
    /// orbit with the mouse or right stick, collision pull-in, lazy recenter behind a moving player, and it
    /// yields to cutscene cameras. Pitch uses AIGE's sign (negative looks down).
    /// </summary>
    [DisallowMultipleComponent]
    [DefaultExecutionOrder(500)]
    public sealed class ThirdPersonCamera : MonoBehaviour
    {
        /// <summary>Entity to follow (name, id or path; default: the player).</summary>
        public string Target = "";
        public float Distance = 3.1f;
        public float Height = 1.55f;
        public float Shoulder = 0.45f;
        public float Fov = 60f;
        public float MouseSensitivity = 0.12f;
        public float MinPitch = -60f;
        public float MaxPitch = 35f;
        public float StickSpeed = 150f;
        public bool InvertY;
        public float RecenterDelay = 1.6f;
        public float FollowSmoothing = 10f;

        public static ThirdPersonCamera? Current { get; private set; }
        public Camera Camera { get; private set; } = null!;

        Transform _pitchPivot = null!;
        GameObject? _target;
        float _yaw, _pitch = -12f, _yawGoal, _pitchGoal = -12f, _idle, _armLength, _fovNow;
        Vector3 _pivot, _lastTargetPos;
        bool _placed;

        void Awake()
        {
            Current = this;
            _pitchPivot = new GameObject("Pitch").transform;
            _pitchPivot.SetParent(transform, false);
            var existing = GetComponentInChildren<Camera>(true);
            if (existing != null) Camera = existing;
            else
            {
                Camera = new GameObject("Camera").AddComponent<Camera>();
                Camera.gameObject.AddComponent<UniversalAdditionalCameraData>().renderPostProcessing = true;
                Camera.gameObject.AddComponent<AudioListener>();
            }
            Camera.transform.SetParent(_pitchPivot, false);
            Camera.transform.localRotation = Quaternion.identity;
            Camera.nearClipPlane = 0.05f;
            Camera.fieldOfView = _fovNow = Fov;
            Camera.enabled = true;
            _armLength = Distance;
        }

        void Start()
        {
            Cutscenes.Finished += OnCutsceneFinished;
            AigeInput.CaptureMouse(true);
            ResolveTarget();
            SnapBehind();
        }

        void OnDestroy()
        {
            if (Current == this) Current = null;
            Cutscenes.Finished -= OnCutsceneFinished;
        }

        void ResolveTarget() => _target = string.IsNullOrEmpty(Target) ? Entities.Player : Entities.Find(Target) ?? Entities.Player;

        /// <summary>Puts the camera straight behind the target.</summary>
        public void SnapBehind()
        {
            if (_target == null) ResolveTarget();
            if (_target == null) return;
            _yaw = _yawGoal = _target.transform.eulerAngles.y;
            _pitch = _pitchGoal = Mathf.Clamp(-12f, MinPitch, MaxPitch);
            _pivot = _target.transform.position + Vector3.up * Height;
            _placed = true;
            ApplyRig(0f);
        }

        /// <summary>Adds look input in degrees (positive yaw turns right, positive pitch looks down).</summary>
        public void AddLook(float yawDegrees, float pitchDegrees)
        {
            _yawGoal += yawDegrees;
            _pitchGoal = Mathf.Clamp(_pitchGoal - pitchDegrees * (InvertY ? -1f : 1f), MinPitch, MaxPitch);
            _idle = 0f;
        }

        void OnCutsceneFinished(string name, bool skipped)
        {
            if (Cutscenes.InputBlocked || _target == null) return;
            if (Vector3.Distance(_pivot, _target.transform.position + Vector3.up * Height) > 1.5f) SnapBehind();
        }

        void LateUpdate()
        {
            if (_target == null)
            {
                ResolveTarget();
                if (_target == null) return;
            }
            if (!_placed) SnapBehind();
            var dt = Time.deltaTime;
            var targetPos = _target.transform.position;
            var velocity = dt > 0f ? (targetPos - _lastTargetPos) / dt : Vector3.zero;
            _lastTargetPos = targetPos;
            if (Cutscenes.IsPlaying) return;

            if (!Cutscenes.InputBlocked)
            {
                if (AigeInput.JustPressed("pause")) AigeInput.CaptureMouse(false);
                if (Cursor.lockState != CursorLockMode.Locked && AigeInput.JustPressed("attack")) AigeInput.CaptureMouse(true);
                var look = AigeInput.LookDelta;
                if (Cursor.lockState == CursorLockMode.Locked || AigeTest.Active) AddLook(look.x * MouseSensitivity, look.y * MouseSensitivity);
                var stick = AigeInput.LookStick;
                if (stick.sqrMagnitude > 0.001f) AddLook(stick.x * StickSpeed * dt, stick.y * StickSpeed * dt * 0.7f);
            }

            _idle += dt;
            velocity.y = 0f;
            var speed = velocity.magnitude;
            if (speed > 15f) speed = 0f;
            if (_idle > RecenterDelay && speed > 0.6f)
            {
                var behind = Mathf.Atan2(velocity.x, velocity.z) * Mathf.Rad2Deg;
                var diff = Mathf.DeltaAngle(_yawGoal, behind);
                if (Mathf.Abs(diff) < 135f) _yawGoal += diff * Easing.Damp(0.35f + speed * 0.12f, dt);
                _pitchGoal = Mathf.Lerp(_pitchGoal, Mathf.Clamp(-10f, MinPitch, MaxPitch), Easing.Damp(0.4f, dt));
            }
            ApplyRig(dt);
        }

        void ApplyRig(float dt)
        {
            if (_target == null) return;
            var goal = _target.transform.position + Vector3.up * Height;
            if (dt <= 0f || Vector3.Distance(_pivot, goal) > 4f) _pivot = goal;
            else
            {
                var k = Easing.Damp(FollowSmoothing, dt);
                var kY = Easing.Damp(FollowSmoothing * 0.6f, dt);
                _pivot = new Vector3(Mathf.Lerp(_pivot.x, goal.x, k), Mathf.Lerp(_pivot.y, goal.y, kY), Mathf.Lerp(_pivot.z, goal.z, k));
            }
            var r = dt <= 0f ? 1f : Easing.Damp(22f, dt);
            _yaw = Mathf.LerpAngle(_yaw, _yawGoal, r);
            _pitch = Mathf.Lerp(_pitch, _pitchGoal, r);
            transform.SetPositionAndRotation(_pivot, Quaternion.Euler(0f, _yaw, 0f));
            _pitchPivot.localRotation = Quaternion.Euler(-_pitch, 0f, 0f);

            // Collision: pull the camera in front of walls (sphere cast from the shoulder pivot backwards).
            var shoulderFull = new Vector3(Shoulder, 0f, 0f);
            var origin = _pitchPivot.TransformPoint(shoulderFull * 0.5f);
            var back = -_pitchPivot.forward;
            var hitLength = Distance;
            foreach (var hit in Physics.SphereCastAll(origin, 0.18f, back, Distance, ~0, QueryTriggerInteraction.Ignore))
            {
                if (Entities.IsInside(hit.transform, _target.transform)) continue;
                if (hit.distance < hitLength) hitLength = Mathf.Max(0.15f, hit.distance - 0.08f);
            }
            _armLength = hitLength < _armLength || dt <= 0f ? hitLength : Mathf.Lerp(_armLength, hitLength, Easing.Damp(4f, dt));
            var shoulder = Shoulder * Mathf.Clamp(_armLength / Mathf.Max(0.1f, Distance), 0.35f, 1f);
            Camera.transform.localPosition = new Vector3(shoulder, 0f, -Mathf.Max(0.15f, _armLength));
            Camera.transform.localRotation = Quaternion.identity;

            var sprint = PlayerController.Instance != null && PlayerController.Instance.IsRunning ? 4f : 0f;
            _fovNow = dt <= 0f ? Fov + sprint : Mathf.Lerp(_fovNow, Fov + sprint, Easing.Damp(3f, dt));
            Camera.fieldOfView = _fovNow;
        }
    }
}
