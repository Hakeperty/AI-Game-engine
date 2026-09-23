# The Sidle of Milch

*Story by Harry.* A third-person, atmospheric open-world RPG. This file is the production script for **Chapter 1: The House**. The rest of the game is still being storyboarded.

## Characters
- **Milch**: 18, the protagonist. Slim, messy dark hair, a worn grey hoodie. Wakes up in a house he half recognises. His voice is soft, slightly husky, dry-throated and quiet.
- **Murphy**: Milch's little brother, about 10. Missing. Seen only in photos.
- **The faceless person**: appears between the brothers in every photo, with the head torn out. Milch has forgotten them. *(It's his mother. Never said in Chapter 1.)*

## The house (a run-down log cabin)
Night, storm. Old decayed floorboards with splinters, cobwebs in the corners, dust floating in the air. The air smells old. The only sounds are creaking floorboards and hard wind against the windows.

**Ground floor**
| Room | Contents | Story use |
|---|---|---|
| Milch's bedroom | empty bed, dresser, window (wind), cobwebs | Cutscene 1 (wake up); **Photo 1** on the dresser |
| Hall / living area | doorway reveal of the kitchen + stairs | Cutscene 2 (entering the hall) |
| Kitchen | counters with drawers, sink, an old fridge (still humming), **round table with 3 chairs** | Cutscene 3 (searching for a weapon → **knife**); **Photo 2** on the fridge; thunder; trigger near the table |
| Bathroom | basin with a **mirror cabinet** (openable: **3 toothbrushes**, lore only), tub | Optional lore |
| Storage room | old coats (three hooks), boxes | Exploration |
| Stairs | blocked/locked door at the bottom | Unlocks after the ground floor is explored |

**Upper floor:** darker and dirty (why is there dirt?). There is a hallway, a closed room, and **Murphy's room** with a small bed, toys, and a round **shield with a whirl** on the wall.

## Chapter 1 beats
1. **CS1 · Waking up** (bedroom, night)
   - Dust in a moonbeam, and the wind hammers the window. Milch lies in the empty bed, then sits up with a stuffy nose and a dry throat, and looks around slowly.
   - He remembers Murphy and screams "MURPHY! MURPHY!". Only his own echo answers.
   - *Why isn't he answering?* Milch stands up.
2. **Free roam (bedroom).** The player looks around. Examine **Photo 1**: Milch, Murphy, and a person in the middle with the head ripped out. *Who is that?* Objective: **Look around.**
3. **Bedroom door → CS2 · The hall.** Milch steps through and looks around: a kitchen, and a pair of stairs. Objective: **Search the kitchen.** A soft pointer shows after a while.
4. **Kitchen → CS3 · A weapon**
   - Hard breathing; Milch is scared. He searches the drawers for a knife, *the first weapon*. *Why are my instincts telling me to find a weapon? Familiar, and unfamiliar at the same time.*
   - Cobwebs, and the fridge is still running. He goes to look at it and finds **Photo 2**: the same faceless person again.
   - **Thunder** strikes and scares him (lightning flash, gasp).
   - Free roam; he has the **knife**.
5. **Trigger at the round table:** *"Three chairs... why three? It was only ever the two of us... wasn't it?"*
6. **Explore the ground floor:** the bathroom (optional mirror cabinet → 3 toothbrushes) and the storage room.
   - After both are found, the **stairs unlock**. Objective: **Find Murphy's room.** A pointer to the stairs appears after some time.
7. **Upper floor.** Dark and dirty. Milch's breathing is loud. *Why is there dirt up here?*
8. **Murphy's room → CS4 · Empty**
   - It's empty. "Murphy?" then "MURPHY!". Only the echo.
   - His breathing gets loud; he's lost. The **faint** sequence:
     - dizziness;
     - creaking gets quieter;
     - the smell of the house fades;
     - eyes darken;
     - the heart slows;
     - black.
9. **CS5 · Morning**
   - Birds chirping, warm light. Irritated eyes, an aching back. Milch slowly gets up, coughs, and his throat is still dry.
   - Murphy's room: still empty. A **shield with a whirl** hangs on the wall.
   - *The knife... where is it?* It's stuck point-down in the floor right next to where his head was. *Lucky.*
   - He picks it up and hides it in his belt. Objective: **Leave the cabin.**
10. **Front door → end of Chapter 1.** Fade out.

## Voice lines (Milch)
Voice: *an 18-year-old young man, soft and slightly husky, quiet and tired, dry throat, a little frightened; natural English.*

| id | line | delivery | effect |
|---|---|---|---|
| milch_wake_1 | "Where... where am I?" | groggy, quiet, dry throat, barely awake | room |
| milch_wake_2 | "It smells so old in here." | whispered to himself, uneasy | room |
| milch_remember | "Murphy..." | sudden realization, quiet and worried | room |
| milch_scream_1 | "Murphy! Murphy!" | screaming desperately, voice cracking | big_echo |
| milch_no_answer | "Why isn't he answering?" | worried whisper, shaky | none |
| milch_photo_1 | "That's me... and Murphy. But who is that? Their face... it's torn out." | confused, unsettled, quiet | none |
| milch_photo_1b | "Why can't I remember?" | whispered, frustrated | none |
| milch_kitchen_1 | "Why do I feel like I need a weapon?" | scared whisper, breathing hard | none |
| milch_kitchen_2 | "This place... it feels familiar. And wrong." | hushed, uneasy | none |
| milch_knife_1 | "This will have to do." | shaky, nervous | none |
| milch_photo_2 | "The same person again... no face. Who are you?" | quiet, disturbed | none |
| milch_table | "Three chairs... why three? It was only ever the two of us... wasn't it?" | slow, confused, doubtful | none |
| milch_toothbrushes | "Three toothbrushes." | quiet, unsettled | room |
| milch_stairs_open | "Murphy's room... it's upstairs." | determined whisper | none |
| milch_upstairs | "Why is there dirt up here?" | whispered, breathing heavily | none |
| milch_murphy_1 | "Murphy?" | hopeful, soft | room |
| milch_scream_2 | "Murphy!" | screaming, breaking down | big_echo |
| milch_lost | "Where are you... where are you, Murphy?" | panicked whisper, fast breathing, on the verge of tears | none |
| milch_morning_1 | "My back..." | groggy, hoarse, in pain | none |
| milch_morning_2 | "Was I on the floor all night?" | confused, hoarse | none |
| milch_knife_2 | "The knife... where did it go?" | worried, hoarse | none |
| milch_knife_3 | "That was close." | quiet, shaken relief | none |

Non-speech sounds (breathing, gasps, coughs, heartbeat, thunder, creaks, wind, fridge hum, birds) come from the engine's audio synthesis.
