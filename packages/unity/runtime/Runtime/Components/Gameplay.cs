#nullable enable
using System;
using System.Collections;
using UnityEngine;

namespace Aige
{
    /// <summary>
    /// Something the player can examine or pick up (AIGE Interactable). The PlayerController targets the
    /// nearest enabled one within <see cref="Range"/> in front of the player, shows "E  Prompt" and calls
    /// <see cref="Interact"/>: it plays the cutscene/voice/text, gives the item (and hides the entity) and sets the flag.
    /// </summary>
    [DisallowMultipleComponent]
    public sealed class Interactable : MonoBehaviour, IInteractable
    {
        public string Prompt = "Examine";
        public float Range = 1.8f;
        public bool Once;
        public string RequireFlag = "";
        public string SetFlag = "";
        /// <summary>AIGE path of a cutscene ('cutscenes/photo_1.cutscene.json').</summary>
        public string Cutscene = "";
        /// <summary>Voice line id.</summary>
        public string Voice = "";
        public string Text = "";
        public string Item = "";
        public bool Enabled = true;

        public event Action<GameObject?>? Interacted;
        public static event Action<Interactable, GameObject?>? AnyInteracted;

        Vector3? _local;

        public GameObject Entity => gameObject;
        public string PromptText => Prompt;
        public float InteractRange => Range;
        public bool CanInteract => Enabled && isActiveAndEnabled && !Cutscenes.InputBlocked &&
                                   (string.IsNullOrEmpty(RequireFlag) || Story.HasFlag(RequireFlag));

        public Vector3 InteractPoint
        {
            get
            {
                if (_local == null) _local = transform.InverseTransformPoint(Entities.FocusPoint(gameObject));
                return transform.TransformPoint(_local.Value);
            }
        }

        void OnEnable() => Interaction.Register(this);
        void OnDisable() => Interaction.Unregister(this);

        public void Interact(GameObject? by = null)
        {
            if (!Enabled) return;
            AnyInteracted?.Invoke(this, by);
            Interacted?.Invoke(by);
            if (!string.IsNullOrEmpty(Cutscene)) Cutscenes.Play(Cutscene);
            else if (!string.IsNullOrEmpty(Voice)) Aige.Voice.Play(Voice);
            else if (!string.IsNullOrEmpty(Text)) Hud.Say(Text);
            if (!string.IsNullOrEmpty(Item))
            {
                Story.Give(Item);
                Sfx.TryPlay("pickup", transform.position, 0.6f, 1f, false);
                Entities.SetEnabled(gameObject, false);
            }
            if (!string.IsNullOrEmpty(SetFlag)) Story.SetFlag(SetFlag);
            if (Once) Enabled = false;
        }
    }

    /// <summary>
    /// A hinged door (AIGE Door): swings its entity around local Y to <see cref="OpenAngle"/> (AIGE degrees;
    /// positive opens counter-clockwise seen from above, like AIGE) at <see cref="Speed"/> swings per second.
    /// Locked until <see cref="UnlockFlag"/> is set (then shows <see cref="LockedText"/>).
    /// </summary>
    [DisallowMultipleComponent]
    public sealed class Door : MonoBehaviour, IInteractable
    {
        public float OpenAngle = 100f;
        public float Speed = 1.6f;
        public bool Locked;
        public string UnlockFlag = "";
        public string LockedText = "It won't open.";
        public bool StartOpen;
        public string Prompt = "Open";
        public float Range = 1.8f;

        /// <summary>(door, opened).</summary>
        public static event Action<Door, bool>? AnyToggled;
        public static event Action<Door>? AnyLocked;

        Quaternion _closed;
        float _amount;
        bool _unlocked, _ready;
        Vector3? _local;

        public bool IsOpen { get; private set; }

        public bool IsLocked =>
            !_unlocked && (Locked || !string.IsNullOrEmpty(UnlockFlag)) &&
            !(!string.IsNullOrEmpty(UnlockFlag) && Story.HasFlag(UnlockFlag));

        public GameObject Entity => gameObject;
        public string PromptText => IsOpen ? "Close" : Prompt;
        public float InteractRange => Range;
        public bool CanInteract => isActiveAndEnabled && !Cutscenes.InputBlocked;

        /// <summary>Center of the closed door leaf, so it stays reachable while it swings.</summary>
        public Vector3 InteractPoint
        {
            get
            {
                Init();
                var closedToWorld = transform.parent != null
                    ? Matrix4x4.TRS(transform.parent.TransformPoint(transform.localPosition), transform.parent.rotation * _closed, transform.lossyScale)
                    : Matrix4x4.TRS(transform.localPosition, _closed, transform.lossyScale);
                if (_local == null)
                {
                    var p = Entities.FocusPoint(gameObject);
                    _local = transform.InverseTransformPoint(p);
                }
                return closedToWorld.MultiplyPoint3x4(_local.Value);
            }
        }

        void OnEnable() => Interaction.Register(this);
        void OnDisable() => Interaction.Unregister(this);

        void Init()
        {
            if (_ready) return;
            _ready = true;
            _closed = transform.localRotation;
        }

        void Start()
        {
            Init();
            if (StartOpen)
            {
                IsOpen = true;
                _amount = 1f;
                Apply();
            }
        }

        public void Interact(GameObject? by = null)
        {
            if (IsLocked)
            {
                AnyLocked?.Invoke(this);
                Hud.Say(LockedText, 2.8f);
                Sfx.PlayFirst(new[] { "door_locked", "door_rattle", "locked" }, transform.position, 0.8f);
                return;
            }
            if (IsOpen) Close();
            else Open();
        }

        public void Open()
        {
            if (IsOpen) return;
            IsOpen = true;
            Sfx.PlayFirst(new[] { "door_open", "creak" }, transform.position, 0.85f, UnityEngine.Random.Range(0.95f, 1.05f));
            AnyToggled?.Invoke(this, true);
        }

        public void Close()
        {
            if (!IsOpen) return;
            IsOpen = false;
            Sfx.PlayFirst(new[] { "door_close", "door_open", "creak" }, transform.position, 0.75f, UnityEngine.Random.Range(0.95f, 1.05f));
            AnyToggled?.Invoke(this, false);
        }

        public void Unlock()
        {
            _unlocked = true;
            Locked = false;
        }

        void FixedUpdate()
        {
            var target = IsOpen ? 1f : 0f;
            if (Mathf.Approximately(_amount, target)) return;
            _amount = Mathf.MoveTowards(_amount, target, Time.fixedDeltaTime * Speed);
            Apply();
        }

        // AIGE angles are counter-clockwise (right-handed); Unity's Y rotation is clockwise, hence the minus.
        void Apply() => transform.localRotation = _closed * Quaternion.AngleAxis(-OpenAngle * Easing.Smooth(_amount), Vector3.up);
    }

    /// <summary>
    /// A trigger zone (AIGE Trigger): when a body tagged <see cref="Tag"/> enters the entity's trigger colliders
    /// (on its 'Area' child), waits <see cref="Delay"/> and plays the cutscene/voice/sound/text, sets the objective and flag.
    /// </summary>
    [DisallowMultipleComponent]
    public sealed class Trigger : MonoBehaviour
    {
        public bool Once = true;
        public string Tag = "Player";
        public string RequireFlag = "";
        public string SetFlag = "";
        public string Cutscene = "";
        public string Voice = "";
        public string Sound = "";
        public string Text = "";
        public string Objective = "";
        public float Delay;
        public bool Enabled = true;

        public event Action<GameObject>? Fired;
        public static event Action<Trigger, GameObject>? AnyFired;

        bool _done;

        /// <summary>Called by the trigger colliders (TriggerArea) when something enters.</summary>
        public void OnEnter(Collider other)
        {
            if (!Enabled || (_done && Once) || !isActiveAndEnabled) return;
            var body = other.attachedRigidbody != null ? other.attachedRigidbody.gameObject : other.gameObject;
            var ent = body.GetComponentInParent<AigeEntity>();
            var tagged = string.IsNullOrEmpty(Tag) || (ent != null && ent.HasTag(Tag)) || (Tag == "Player" && body.CompareTag("Player"));
            if (!tagged) return;
            if (!string.IsNullOrEmpty(RequireFlag) && !Story.HasFlag(RequireFlag)) return;
            var who = ent != null ? ent.gameObject : body;
            _done = true;
            AnyFired?.Invoke(this, who);
            Fired?.Invoke(who);
            StartCoroutine(RunEffects());
        }

        void OnTriggerEnter(Collider other) => OnEnter(other);

        IEnumerator RunEffects()
        {
            if (Delay > 0f) yield return new WaitForSeconds(Delay);
            if (!string.IsNullOrEmpty(Cutscene)) Cutscenes.Play(Cutscene);
            if (!string.IsNullOrEmpty(Voice)) Aige.Voice.Play(Voice);
            else if (!string.IsNullOrEmpty(Text)) Hud.Say(Text);
            if (!string.IsNullOrEmpty(Sound)) Sfx.Play(Sound, transform.position);
            if (!string.IsNullOrEmpty(Objective)) Story.SetObjective(Objective);
            if (!string.IsNullOrEmpty(SetFlag)) Story.SetFlag(SetFlag);
        }

        public void ResetTrigger() => _done = false;
    }

    /// <summary>Forwards trigger events from an entity's 'Area' child (its trigger colliders) to its Trigger.</summary>
    [DisallowMultipleComponent]
    public sealed class TriggerArea : MonoBehaviour
    {
        void OnTriggerEnter(Collider other)
        {
            foreach (var t in GetComponentsInParent<Trigger>()) t.OnEnter(other);
        }
    }

    /// <summary>
    /// An AIGE AudioSource on the entity's 'Audio' child: wraps Unity's AudioSource with <see cref="Volume"/>,
    /// <see cref="Loop"/>, <see cref="PlayOnStart"/>, <see cref="Range"/> and fades. Inactive entities stay silent until enabled.
    /// </summary>
    [RequireComponent(typeof(AudioSource))]
    public sealed class AigeAudio : MonoBehaviour
    {
        public float Volume = 0.8f;
        public bool Loop;
        public bool PlayOnStart;
        public float Range = 12f;

        AudioSource _src = null!;
        Coroutine? _fade;

        public AudioSource Source => _src != null ? _src : _src = GetComponent<AudioSource>();
        public bool IsPlaying => Source.isPlaying;

        void Awake()
        {
            _src = GetComponent<AudioSource>();
            _src.playOnAwake = false;
            _src.loop = Loop;
            _src.volume = Volume;
        }

        void OnEnable()
        {
            if (PlayOnStart && !Source.isPlaying) Play();
        }

        public void Play()
        {
            if (_fade != null) StopCoroutine(_fade);
            Source.volume = Volume;
            Source.loop = Loop;
            Source.Play();
            Sfx.Notify(Source.clip != null ? Source.clip.name : name, Source.clip != null);
        }

        public void Stop()
        {
            if (_fade != null) StopCoroutine(_fade);
            Source.Stop();
        }

        public void FadeTo(float volume, float seconds)
        {
            Volume = volume;
            if (_fade != null) StopCoroutine(_fade);
            _fade = StartCoroutine(FadeRoutine(volume, seconds, false));
        }

        public void FadeOut(float seconds = 1.5f)
        {
            if (_fade != null) StopCoroutine(_fade);
            _fade = StartCoroutine(FadeRoutine(0f, seconds, true));
        }

        IEnumerator FadeRoutine(float to, float seconds, bool stop)
        {
            var from = Source.volume;
            for (var t = 0f; t < seconds; t += Time.deltaTime)
            {
                Source.volume = Mathf.Lerp(from, to, t / seconds);
                yield return null;
            }
            Source.volume = to;
            if (stop) Source.Stop();
        }
    }

    /// <summary>Spins an entity (built-in Rotator). <see cref="Speed"/> is AIGE degrees per second per axis.</summary>
    public sealed class Rotator : MonoBehaviour
    {
        public Vector3 Speed = new Vector3(0, 45, 0);
        /// <summary>'self' or 'world'.</summary>
        public string Space = "self";

        void Update()
        {
            // AIGE rotations are right-handed: mirror to Unity by negating Y and Z.
            var s = new Vector3(Speed.x, -Speed.y, -Speed.z) * Time.deltaTime;
            transform.Rotate(s, Space == "world" ? UnityEngine.Space.World : UnityEngine.Space.Self);
        }
    }
}
