# AIGE runtime for Godot: C# API

Namespace `Aige` (add `using Aige;`). Everything below ships in `res://addons/aige/` and is overwritten on every export, so do not edit it. Game scripts live in `scripts/*.cs`. All autoload APIs are **static**: call them from anywhere.

## Story (flags, inventory, objectives, events)
```csharp
Story.SetFlag("saw_photo_1");            Story.ClearFlag("x");     Story.HasFlag("x");   Story.HasFlags("a", "b");
Story.Give("knife");                     Story.Take("knife");      Story.Has("knife");
Story.SetObjective("Look around");                                             // text only
Story.SetObjective("Search the kitchen", kitchenTable, pointerDelay: 30);      // waypoint after 30 s of free play
Story.SetObjective("Find Sam's room", "StairsDoor", pointerDelay: 45);      // target by entity id/path/name
Story.ClearObjective();  Story.RevealPointer();
Story.Emit("thunder");                                                         // named game event
Story.On("thunder", () => LightFlicker.Lightning(), this);                     // handler, removed when `this` leaves the tree
Story.On("flag:knife_found", () => Hud.Say("Lucky."), this);                   // 'flag:<flag>' and 'item:<item>' also work
Story.Emit("env:res://godot/environments/house-morning.tres");                 // built-in: cross-fade the Environment
```
Events: `FlagSet`, `FlagCleared`, `ItemGiven`, `ItemTaken`, `ObjectiveChanged(text, target)`, `PointerRevealed(target)`, `Emitted(name)`. Read-only state: `Flags`, `Items`, `Objective`, `ObjectiveTarget`, `PointerVisible`.

## Hud (subtitles, prompt, fades, screen FX)
```csharp
Hud.Say("It smells so old in here.", 3f, "Hero");   // seconds <= 0 picks a reading time; queue: true to wait
Hud.ClearSubtitles();
Hud.FadeOut(2f);  Hud.FadeIn(1.5f);  Hud.Fade(1f, 2f, new Color(1, 1, 1));
Hud.Letterbox(true);
Hud.Flash();                          // lightning-style double flash
Hud.Shake(0.4f, 1f);
Hud.Heartbeat(0.7f, bpm: 110);        // throbbing vignette/blur; Hud.Heartbeat(0) stops
Hud.Fx("vignette", 0.8f, 3f);         // tween any effect (see below)
Hud.ResetFx(1f);
```
`Hud.Fx` effects: `fade`, `vignette`, `blur`, `darken`, `desaturate`, `grain` (0..1), `flash` and `shake` (hit, then decay over the duration), `letterbox`, `heartbeat` (0..1), `heartRate` (bpm), `temperature` and `tint` (-1..1), grade multipliers `exposure`, `fog`, `bloom`, `contrast`, `saturation` (1 = unchanged), and `volume` (master volume, 1 = full). Values layer over the scene's Environment look, so 0 returns to it. The interaction prompt is driven by `PlayerController`; `Hud.ShowPrompt(text)` and `Hud.HidePrompt()` exist for custom systems. `Hud.Beat` fires on each heartbeat.

A fainting sequence:
```csharp
Hud.Heartbeat(0.8f, 110, 1f);
Hud.Fx("blur", 0.6f, 6f);  Hud.Fx("darken", 0.5f, 6f);  Hud.Fx("volume", 0.15f, 6f);
Hud.Fx("heartRate", 40f, 8f);
Hud.FadeOut(8f);
```

## Voice and Sfx
```csharp
float seconds = Voice.Play("hero_wake_1");          // res://audio/voice/hero_wake_1.json + its audio; subtitle + lip-sync
Voice.Play("hero_scream_1", hero, subtitle: false); // explicit actor (default: the entity named like the speaker)
Voice.Stop();  Voice.IsPlaying;  Voice.DurationOf("hero_table");
Sfx.Play("thunder");                                  // res://godot/audio/sfx/thunder.ogg
Sfx.Play("creak", door.GlobalPosition, volume: 0.6f, pitch: 0.95f);   // 3D
Sfx.Play("res://audio/sfx/drawer.ogg");
Sfx.TryPlay("heartbeat");                             // silent if the sound does not exist
```
Events: `Voice.Started(id, speaker, text)`, `Voice.Finished(id)`, `Sfx.Played(name, found)`.

## Cutscenes
```csharp
Cutscenes.Play("res://cutscenes/cs1_wake.cutscene.json");
Cutscenes.Play("cs3_weapon", () => Story.SetObjective("Explore the house"));   // name or path, optional callback
if (Cutscenes.IsPlaying) return;
Cutscenes.Skip();  Cutscenes.ReturnControl();          // ReturnControl after a cutscene with returnControl: false
```
`Cutscenes.InputBlocked` is true while a cutscene plays or holds control. Events: `Started(name, path)` and `Finished(name, skipped)`. A cutscene started while another plays is queued. Holding `skip` for 1 s skips a skippable cutscene. Skipping still applies the remaining story events, final moves, fx and lights, but not speech or sounds. Cutscene `emit` events go through `Story.Emit`.

## Entities
```csharp
Node3D? fridge = Entities.Find("Kitchen/Fridge");     // aige_id, then path from the scene root, then node name
var door = Entities.Find<AnimatableBody3D>("StairsDoor");
Entities.SetEnabled(knife, false);                     // hide + stop processing + collisions
Entities.Teleport(hero, new Vector3(1, 0, 2), new Vector3(0, 180, 0));
Entities.Player;  Entities.Tagged("Lightning");  Entities.Component<Interactable>(photo);
```

## Components (child nodes named after the component)
- **Interactable** (`Photo1/Interactable`): `Prompt`, `Range`, `Once`, `RequireFlag`, `SetFlag`, `Cutscene`, `Voice`, `Text`, `Item`, `Enabled`. `Interact()`, instance event `Interacted(by)`, static `AnyInteracted`.
- **Door** (`StairsDoor/Door`): `OpenAngle`, `Speed`, `Locked`, `UnlockFlag`, `LockedText`, `StartOpen`, `Prompt`. `Open()`, `Close()`, `Unlock()`, `IsOpen`, `IsLocked`; static `AnyToggled`, `AnyLocked`.
- **Trigger** (`Zone/Trigger`, uses the sibling `Area`): `Once`, `Tag`, `RequireFlag`, `SetFlag`, `Cutscene`, `Voice`, `Sound`, `Text`, `Objective`, `Delay`, `Enabled`. Instance event `Fired(body)`, `Reset()`.
- **Animator** (`Hero/Animator`): `Animator.Of(hero)?.Play("look_around", fade: 0.3f, loop: false, speed: 1f)`, `Release()`, `HasClip`, `Mouth` (0..1), `Crouching`, `ClipFinished`. Locomotion blends idle/walk/run from movement. A one-shot clip holds its last pose while a cutscene has control. AIGE clip aliases work (`sit_up` → `sit_up_in_bed`).
- **ParticleSystem**: `Preset` (dust, rain, snow, embers, fireflies, smoke, sparks, leaves), `Count`, `Area`, `Color`, `Size`, `Speed`, `Opacity`, `Emitting`, `Build()`.
- **AudioSource** (on the `Audio` player node): `Volume`, `Loop`, `PlayOnStart`, `Range`; `Play()`, `Stop()`, `FadeTo(v, s)`, `FadeOut(s)`.
- **LightFlicker** (`Lamp/Light/Flicker`): `Amount`, `Rate`, `BaseEnergy`, `BaseColor`; `Flash(intensity, duration)`. Static helpers: `LightFlicker.Lightning(intensity: 8, thunder: "thunder", thunderDelay: 1.2f)` flashes every light tagged `Lightning`, flashes the screen and plays thunder. `LightFlicker.FlashLight(anyLight)` flashes any single light.
- **EnvironmentFx** (root `Environment`): `EnvironmentFx.Switch("res://godot/environments/house-morning.tres", 4f)` cross-fades the look (night to morning).

## Built-ins
- **PlayerController** (`CharacterBody3D`): `WalkSpeed` 1.5, `RunSpeed` 4.5 (sprint), `CrouchSpeed`, `Acceleration`, `Deceleration`, `TurnSpeed`, `CanJump`, `JumpSpeed`, `StepHeight`, `FootstepSound` ('footstep_wood'), `FootstepVolume`. API: `PlayerController.Instance`, `InputEnabled`, `Teleport(pos, yawDegrees)`, `Target`, `IsRunning`, `IsCrouching`.
- **ThirdPersonCamera**: `Target`, `Distance`, `Height`, `Shoulder`, `Fov`, `MouseSensitivity`, `MinPitch`, `MaxPitch`, `InvertY`, `RecenterDelay`. API: `ThirdPersonCamera.Current`, `.Camera`, `SnapBehind()`, `AddLook(yaw, pitch)`.
- **Rotator**: `Speed` (Vector3 degrees/s, or a number for Y), `Space` ('self' | 'world').

## Example game script
```csharp
using Aige;
using Godot;

public partial class KitchenBeats : Node
{
    public override void _Ready()
    {
        Story.On("flag:has_knife", OnKnife, this);
        Entities.Find("Fridge")?.GetNode<Interactable>("Interactable").Interacted += _ => Voice.Play("hero_photo_2");
    }

    void OnKnife()
    {
        LightFlicker.Lightning();
        Story.SetObjective("Explore the ground floor");
        if (Story.HasFlags("saw_bathroom", "saw_storage")) Story.SetFlag("upstairs_unlocked");
    }
}
```

## Logging and tests
`Log.Info("...")` prints and records a `log` event in test reports. `Log.Warn` does not fail a test; `Log.Error` does. `AigeTest.Active` is true during automated play-tests: skip menus and mouse capture then.
