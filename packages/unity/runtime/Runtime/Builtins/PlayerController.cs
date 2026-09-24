#nullable enable
using UnityEngine;

namespace Aige
{
    /// <summary>
    /// Built-in third-person player (AIGE 'builtin:PlayerController') on a CharacterController: realistic
    /// walk (1.5 m/s) and run (4.5 m/s, sprint) relative to the camera, crouch, gravity, steps (stepOffset),
    /// footsteps, and interaction targeting (prompt "E  Examine", interact to use).
    /// </summary>
    [RequireComponent(typeof(CharacterController))]
    [DisallowMultipleComponent]
    public sealed class PlayerController : MonoBehaviour
    {
        public float WalkSpeed = 1.5f;
        public float RunSpeed = 4.5f;
        public float CrouchSpeed = 0.9f;
        public float Acceleration = 7f;
        public float Deceleration = 10f;
        public float TurnSpeed = 9f;
        public bool CanJump = true;
        public float JumpSpeed = 4.2f;
        public float GravityScale = 1f;
        public float StepHeight = 0.35f;
        public float CrouchHeight = 0.62f;
        public string FootstepSound = "footstep_wood";
        public float FootstepVolume = 0.5f;
        public float KillY = -50f;

        public static PlayerController? Instance { get; private set; }

        public bool InputEnabled { get; set; } = true;
        public bool IsCrouching { get; private set; }
        public bool IsRunning { get; private set; }
        public IInteractable? Target { get; private set; }
        /// <summary>Current velocity (m/s, Unity space).</summary>
        public Vector3 Velocity { get; private set; }
        public Vector3 Facing => transform.forward;

        CharacterController _cc = null!;
        float _standHeight = 1.8f, _heightNow = 1.8f, _stride, _airTime, _faceTimer;
        Vector3 _spawn, _faceDir, _baseCenter;
        string _prompt = "";
        AigeAnimator? _animator;

        void Awake()
        {
            Instance = this;
            _cc = GetComponent<CharacterController>();
            _standHeight = _heightNow = _cc.height;
            _baseCenter = _cc.center;
            _cc.stepOffset = Mathf.Min(StepHeight, _cc.height * 0.5f);
            try { gameObject.tag = "Player"; } catch (UnityException) { }
        }

        void Start()
        {
            _spawn = transform.position;
            _animator = AigeAnimator.Of(gameObject);
        }

        void OnDestroy()
        {
            if (Instance == this) Instance = null;
        }

        /// <summary>Moves the player to a Unity position, optionally facing a Unity yaw (degrees).</summary>
        public void Teleport(Vector3 position, float? yawDegrees = null) =>
            Entities.Teleport(gameObject, position, yawDegrees != null ? Quaternion.Euler(0f, yawDegrees.Value, 0f) : (Quaternion?)null);

        /// <summary>Called by Entities.Teleport: stops movement and snaps the camera behind.</summary>
        public void OnTeleported()
        {
            Velocity = Vector3.zero;
            _stride = 0f;
            if (ThirdPersonCamera.Current != null) ThirdPersonCamera.Current.SnapBehind();
        }

        bool Blocked => !InputEnabled || Cutscenes.InputBlocked;

        void Update()
        {
            var dt = Time.deltaTime;
            if (dt <= 0f) return;
            if (Cutscenes.IsPlaying)
            {
                Velocity = Vector3.zero;
                SetTarget(null);
                return;
            }
            var blocked = Blocked;
            var input = blocked ? Vector2.zero : AigeInput.Move;
            var wantsRun = !blocked && AigeInput.Pressed("sprint");
            if (!blocked && AigeInput.JustPressed("crouch")) SetCrouch(!IsCrouching);
            if (IsCrouching && wantsRun) SetCrouch(false);
            UpdateCrouchShape(dt);

            var cam = Entities.ActiveCamera;
            var forward = cam != null ? cam.transform.forward : transform.forward;
            forward.y = 0f;
            forward = forward.sqrMagnitude > 1e-4f ? forward.normalized : Vector3.forward;
            var right = new Vector3(forward.z, 0f, -forward.x);
            var dir = right * input.x + forward * input.y;
            var amount = Mathf.Min(1f, dir.magnitude);
            if (amount > 1e-3f) dir /= dir.magnitude;

            var top = IsCrouching ? CrouchSpeed : wantsRun ? RunSpeed : WalkSpeed;
            var desired = dir * top * amount;
            var horizontal = new Vector3(Velocity.x, 0f, Velocity.z);
            var rate = desired.sqrMagnitude >= horizontal.sqrMagnitude ? Acceleration : Deceleration;
            if (!_cc.isGrounded) rate *= 0.25f;
            horizontal = Vector3.Lerp(horizontal, desired, Easing.Damp(rate, dt));
            IsRunning = wantsRun && horizontal.magnitude > (WalkSpeed + RunSpeed) * 0.5f;

            if (_faceTimer > 0f)
            {
                _faceTimer -= dt;
                if (_faceDir.sqrMagnitude > 1e-4f) TurnTo(_faceDir, dt, TurnSpeed * 0.8f);
            }
            else if (amount > 0.1f)
            {
                var turnRate = TurnSpeed * Mathf.Lerp(1f, 0.55f, Mathf.Clamp01((horizontal.magnitude - WalkSpeed) / (RunSpeed - WalkSpeed)));
                TurnTo(dir, dt, turnRate);
            }

            var vy = Velocity.y;
            if (_cc.isGrounded)
            {
                if (_airTime > 0.35f) Footstep(1.2f);
                _airTime = 0f;
                vy = Mathf.Min(vy, -2f);
                if (CanJump && !blocked && !IsCrouching && AigeInput.JustPressed("jump")) vy = JumpSpeed;
            }
            else
            {
                _airTime += dt;
                vy += Physics.gravity.y * GravityScale * dt;
            }

            var before = transform.position;
            Velocity = new Vector3(horizontal.x, vy, horizontal.z);
            if (_cc.enabled) _cc.Move(Velocity * dt);

            if (_cc.isGrounded)
            {
                var moved = transform.position - before;
                moved.y = 0f;
                var speed = horizontal.magnitude;
                _stride += moved.magnitude;
                var strideLength = Mathf.Lerp(0.72f, 1.35f, Mathf.Clamp01((speed - WalkSpeed) / (RunSpeed - WalkSpeed)));
                if (IsCrouching) strideLength = 0.55f;
                if (speed > 0.25f && _stride >= strideLength)
                {
                    _stride = 0f;
                    Footstep(IsCrouching ? 0.45f : IsRunning ? 1.5f : 1f);
                }
            }
            if (transform.position.y < KillY) Teleport(_spawn);
            if (_animator != null) _animator.Crouching = IsCrouching;
            UpdateInteraction(blocked);
        }

        void TurnTo(Vector3 dir, float dt, float rate)
        {
            dir.y = 0f;
            if (dir.sqrMagnitude < 1e-6f) return;
            transform.rotation = Quaternion.Slerp(transform.rotation, Quaternion.LookRotation(dir, Vector3.up), Easing.Damp(rate, dt));
        }

        void SetCrouch(bool crouch)
        {
            if (!crouch && IsCrouching)
            {
                var headroom = _standHeight - _heightNow + 0.05f;
                var top = transform.position + Vector3.up * (_heightNow - _cc.radius);
                if (Physics.SphereCast(top, _cc.radius * 0.9f, Vector3.up, out _, headroom, ~0, QueryTriggerInteraction.Ignore)) return;
            }
            IsCrouching = crouch;
        }

        void UpdateCrouchShape(float dt)
        {
            var target = IsCrouching ? _standHeight * CrouchHeight : _standHeight;
            if (Mathf.Approximately(_heightNow, target)) return;
            _heightNow = Mathf.MoveTowards(_heightNow, target, dt * 3f);
            _cc.height = Mathf.Max(_heightNow, _cc.radius * 2f);
            _cc.center = new Vector3(_baseCenter.x, _baseCenter.y * (_heightNow / _standHeight), _baseCenter.z);
        }

        void Footstep(float loudness)
        {
            if (string.IsNullOrEmpty(FootstepSound)) return;
            var pitch = Random.Range(0.9f, 1.1f) * (IsRunning ? 1.04f : 1f);
            Sfx.TryPlay(FootstepSound, transform.position + Vector3.up * 0.05f, Mathf.Clamp01(FootstepVolume * loudness), pitch, false);
        }

        void UpdateInteraction(bool blocked)
        {
            var target = blocked ? null : FindTarget();
            SetTarget(target);
            if (target != null && AigeInput.JustPressed("interact"))
            {
                var to = target.InteractPoint - transform.position;
                to.y = 0f;
                _faceDir = to.sqrMagnitude > 1e-4f ? to.normalized : Vector3.zero;
                _faceTimer = 0.45f;
                target.Interact(gameObject);
                _prompt = "";
            }
        }

        void SetTarget(IInteractable? target)
        {
            var text = target?.PromptText ?? "";
            if (target == Target && text == _prompt) return;
            Target = target;
            _prompt = text;
            if (target == null) Hud.HidePrompt();
            else Hud.ShowPrompt(text);
        }

        /// <summary>The interactable the player would use now (nearest in front, in reach and in sight).</summary>
        public IInteractable? FindTarget()
        {
            var pos = transform.position;
            var eye = pos + Vector3.up * Mathf.Min(1.5f, _heightNow * 0.8f);
            var chest = pos + Vector3.up * (_heightNow * 0.55f);
            var cam = Entities.ActiveCamera;
            var camForward = cam != null ? cam.transform.forward : Facing;
            IInteractable? best = null;
            var bestScore = float.MaxValue;
            foreach (var it in Interaction.All)
            {
                if (!it.CanInteract) continue;
                var p = it.InteractPoint;
                var flat = p - pos;
                flat.y = 0f;
                var height = p.y - pos.y;
                if (height < -0.6f || height > _heightNow + 0.7f) continue;
                var distance = Mathf.Max(flat.magnitude, (p - chest).magnitude * 0.85f);
                if (distance > it.InteractRange) continue;
                var dirFlat = flat.sqrMagnitude > 1e-4f ? flat.normalized : Facing;
                var facing = Vector3.Dot(dirFlat, Facing);
                var viewDir = (p - (cam != null ? cam.transform.position : eye)).normalized;
                var looking = Vector3.Dot(viewDir, camForward);
                var front = Mathf.Max(facing, looking * 1.1f - 0.1f);
                if (front < 0.25f && distance > 0.7f) continue;
                var score = distance * (1.6f - front);
                if (score >= bestScore || !LineOfSight(eye, p, it.Entity)) continue;
                best = it;
                bestScore = score;
            }
            return best;
        }

        bool LineOfSight(Vector3 from, Vector3 to, GameObject entity)
        {
            if (!Physics.Linecast(from, to, out var hit, ~0, QueryTriggerInteraction.Ignore)) return true;
            if (Entities.IsInside(hit.transform, entity.transform) || Entities.IsInside(entity.transform, hit.transform)) return true;
            if (Entities.IsInside(hit.transform, transform)) return true;
            return Vector3.Distance(hit.point, to) < 0.25f;
        }
    }
}
