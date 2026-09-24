# AIGE runtime for Unity: C# API

Namespace `Aige` (add `using Aige;`). Everything below ships in `Assets/Aige/` and is overwritten on every export, so do not edit it. Game scripts are MonoBehaviours in `Assets/Scripts/*.cs`. The services are **static**: call them from anywhere. They are created before the first scene loads (a persistent `AIGE` object), like Godot autoloads.

The API mirrors the Godot runtime (`packages/godot/runtime/API.md`) so game code ports with few changes. Differences: entities are `GameObject`s, components live on the entity itself (`GetComponent<Door>()`), and three classes are prefixed to avoid clashing with Unity: `AigeAnimator`, `AigeAudio`, `AigeParticles`.

**Coordinates.** Scenes are converted to Unity's left-handed space by mirroring X (like glTFast). Data that comes from AIGE documents (cutscene keys, teleports in tests) is converted for you. When you type AIGE coordinates in code, use `Coords.Position(new Vector3(x, y, z))` and `Coords.Rotation(eulerDeg)`, or `Entities.TeleportAige(...)`.

## Story (flags, inventory, objectives, events)
```csharp
Story.SetFlag("saw_photo_1");            Story.ClearFlag("x");     Story.HasFlag("x");   Story.HasFlags("a", "b");
Story.Give("knife");                     Story.Take("knife");      Story.Has("knife");
Story.SetObjective("Look around");
Story.SetObjective("Search the kitchen", "Table", pointerDelay: 30);    // waypoint after 30 s of free play
Story.ClearObjective();  Story.RevealPointer();
Story.Emit("thunder");
Story.On("thunder", () => LightFlicker.Lightning(), this);             // removed when this GameObject is destroyed
Story.On("flag:knife_found", () => Hud.Say("Lucky."), this);           // 'flag:<flag>' and 'item:<item>' work too
Story.Emit("env:Environment_Morning");                                 // built-in: cross-fade to another Environment
```
Events: `FlagSet`, `FlagCleared`, `ItemGiven`, `ItemTaken`, `ObjectiveChanged(text, target)`, `PointerRevealed(target)`, `Emitted(name)`. State: `Flags`, `Items`, `Objective`, `ObjectiveTarget`, `PointerVisible`.

## Hud (subtitles, prompt, fades, screen FX)
```csharp
Hud.Say("It smells so old in here.", 3f, "Hero");   // seconds <= 0 picks a reading time; queue: true to wait
Hud.FadeOut(2f);  Hud.FadeIn(1.5f);  Hud.Fade(1f, 2f, Color.white);  Hud.Letterbox(true);
Hud.Flash();  Hud.Shake(0.4f, 1f);  Hud.Heartbeat(0.7f, bpm: 110);  Hud.Fx("vignette", 0.8f, 3f);  Hud.ResetFx(1f);
```
`Hud.Fx` effects: `fade`, `vignette`, `blur`, `darken`, `desaturate`, `grain` (0..1), `flash`, `shake`, `letterbox`, `heartbeat` (0..1), `heartRate` (bpm), `temperature`, `tint` (-1..1), multipliers `exposure`, `fog`, `bloom`, `contrast`, `saturation` (1 = unchanged), `volume` (master). Screen effects drive a URP Volume layered over the Environment's look; overlays (fade, darken, flash, letterbox) are uGUI.

## Voice and Sfx
```csharp
float seconds = Voice.Play("hero_wake_1");          // Resources/aige/audio/voice/hero_wake_1 (JSON + audio); subtitle + lip-sync
Voice.Play("hero_scream", hero, subtitle: false);
Voice.Stop();  Voice.IsPlaying;  Voice.DurationOf("hero_table");
Sfx.Play("thunder");                                 // Resources/aige/sfx/thunder (baked story sound)
Sfx.Play("creak", door.transform.position, volume: 0.6f, pitch: 0.95f);
Sfx.TryPlay("heartbeat");
```

## Cutscenes
```csharp
Cutscenes.Play("cutscenes/cs1_wake.cutscene.json");  // or a name: Cutscenes.Play("cs1_wake", () => ...)
if (Cutscenes.IsPlaying) return;
Cutscenes.Skip();  Cutscenes.ReturnControl();
```
All CutsceneDoc tracks work: camera (keys, ease, cut, fov, shake, depth of field), animation, move, voice, sound, subtitle, fx, light and event (setFlag, clearFlag, enable, disable, give, take, objective, teleport, emit). `Cutscenes.InputBlocked` is true while one plays or holds control. Hold `skip` for 1 s to skip.

## Entities
```csharp
GameObject? fridge = Entities.Find("Kitchen/Fridge");   // id, then path, then name (inactive entities too)
var door = Entities.Find<Door>("Door_Stairs");
Entities.SetEnabled(knife, false);
Entities.Teleport(hero, position, rotation);             // Unity space
Entities.TeleportAige(hero, new Vector3(1, 0, 2), new Vector3(0, 180, 0));   // AIGE space
Entities.Player;  Entities.Tagged("Lightning");  Entities.Component<Interactable>(photo);  Entities.ActiveCamera;
```

## Components (on the entity GameObject)
- **Interactable**: `Prompt`, `Range`, `Once`, `RequireFlag`, `SetFlag`, `Cutscene`, `Voice`, `Text`, `Item`, `Enabled`; `Interact()`, `Interacted`, static `AnyInteracted`.
- **Door**: `OpenAngle` (AIGE degrees), `Speed`, `Locked`, `UnlockFlag`, `LockedText`, `StartOpen`, `Prompt`; `Open()`, `Close()`, `Unlock()`, `IsOpen`, `IsLocked`; static `AnyToggled`, `AnyLocked`.
- **Trigger** (trigger colliders on the child `Area`): `Once`, `Tag`, `RequireFlag`, `SetFlag`, `Cutscene`, `Voice`, `Sound`, `Text`, `Objective`, `Delay`, `Enabled`; `Fired`, `ResetTrigger()`.
- **AigeAnimator**: `AigeAnimator.Of(hero)?.Play("look_around", fade: 0.3f, loop: false, speed: 1f)`, `Release()`, `HasClip`, `Mouth` (0..1, jaw bone), `Crouching`, `ClipFinished`. Clips are the model's glTF animations (Playables with cross-fades); locomotion switches idle/walk/run from movement.
- **AigeParticles**: `Preset` (dust, rain, snow, embers, fireflies, smoke, sparks, leaves), `Count`, `Area`, `Color`, `Size`, `Speed`, `Opacity`, `SetEmitting(on)`, `Build()`.
- **AigeAudio** (on the `Audio` child): `Volume`, `Loop`, `PlayOnStart`, `Range`; `Play()`, `Stop()`, `FadeTo(v, s)`, `FadeOut(s)`.
- **LightFlicker** (on the `Light` child): `Amount`, `Rate`, `BaseEnergy`, `BaseColor`, `Flash()`; static `LightFlicker.Lightning()`, `LightFlicker.FlashLight(light)`.
- **EnvironmentFx** (root `Environment`): `EnvironmentFx.Switch("Environment_Morning", 4f)`; **AigeEnvironment** holds each Environment's profile, sky, fog and ambient values.

## Built-ins
- **PlayerController** (CharacterController): `WalkSpeed` 1.5, `RunSpeed` 4.5, `CrouchSpeed`, `Acceleration`, `Deceleration`, `TurnSpeed`, `CanJump`, `JumpSpeed`, `StepHeight`, `FootstepSound`, `FootstepVolume`. API: `PlayerController.Instance`, `InputEnabled`, `Teleport(pos, yaw)`, `Target`, `IsRunning`, `IsCrouching`, `Velocity`.
- **ThirdPersonCamera**: `Target`, `Distance`, `Height`, `Shoulder`, `Fov`, `MouseSensitivity`, `MinPitch`, `MaxPitch`, `InvertY`, `RecenterDelay`. API: `ThirdPersonCamera.Current`, `.Camera`, `SnapBehind()`, `AddLook(yaw, pitch)`.
- **Rotator**: `Speed` (AIGE degrees/s per axis), `Space` ('self' | 'world').

## Input
`AigeInput.Pressed("interact")`, `JustPressed`, `JustReleased`, `Move` (x right, y forward), `LookDelta`. Actions: `move_forward/back/left/right`, `sprint`, `jump`, `crouch`, `interact`, `attack`, `skip`, `pause`. Works with the Input System package or the old Input Manager.

## Example game script
```csharp
using Aige;
using UnityEngine;

public class KitchenBeats : MonoBehaviour
{
    public float PointerDelay = 30f;

    void Start()
    {
        Story.On("flag:has_knife", OnKnife, this);
        var fridge = Entities.Find<Interactable>("Fridge");
        if (fridge != null) fridge.Interacted += _ => Voice.Play("hero_fridge");
    }

    void OnKnife()
    {
        LightFlicker.Lightning();
        Story.SetObjective("Explore the ground floor", "Door_Stairs", pointerDelay: PointerDelay);
    }
}
```

## Logging and tests
`Log.Info` prints and records a `log` event in test reports; `Log.Warn` does not fail a test, `Log.Error` does. `AigeTest.Active` is true during automated play-tests (`-aige-test=<test.json> -aige-report=<report.json>` on a player build, same test format as the Godot harness).
