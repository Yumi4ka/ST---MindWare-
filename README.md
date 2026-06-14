# 🧠 MindWare

**A "reality console" companion for SillyTavern — reshape a character's body and mind on the fly, right inside your roleplay.**

MindWare lives as a small floating bubble in your chat. Tap it to open a sleek phone‑style panel that lets you edit who a character *is* — their appearance, physique, personality, mood, relationships, and more — and have those changes flow straight into the story. To the AI, the device isn't an in‑world gadget: it quietly **edits reality itself**, so every change is treated as an established fact of the scene and is reflected in every reply.

> ⚠️ **Mature content.** MindWare is built for adult roleplay. The everyday controls are perfectly tame, but additional **18+ modules are tucked behind an optional unlock** and stay completely hidden until you choose to enable them. Use responsibly and only where permitted.

---

## ✨ Features

### Multiple subjects
Edit not just the character, but **yourself (your persona)** and **any NPC present in the scene**. Each subject keeps its own independent profile, mind‑state and history. MindWare can analyze a character card or persona automatically to infer a sensible starting point.

### 🧍 BODY
- **Physique:** height, weight, apparent age, build, strength, flexibility, voice, pain threshold, perception…
- **Appearance:** eye colour & type, hair colour / style / texture, skin tone, facial expression, make‑up, body‑hair level, wear & tear, and more.
- **Features:** ears, tail, wings, horns and other traits.
- **Wardrobe:** a wide outfit list, accessories, and an "outfit lock."
- **Tattoos & piercings** by zone.
- **Body presets** (feminine and masculine archetypes) you can load and tweak.

### 🧠 MIND
- **Personality matrix** grouped by Intellect, Emotions, Social, Will and Attitude toward you.
- **Personality slider** — gradually dial a character down from fully themselves to a blank, doll‑like state.
- **Control modules**, **sense locks**, **one‑shot emotion pulses**, **speech manner**, **orientation**, and a **memory block** (wipe by depth, or implant a custom memory by text).
- **Perception filter** and **role dynamic** that colour how the character sees and relates to you.
- **Personality presets** (Catgirl, Yandere, Tsundere, Mafia Boss, and many more), plus "Total Inversion" and a random roll.
- **Hypnosis modes** — choose whether the subject is fully aware of the changes, only senses them, or simply experiences a seamlessly rewritten reality.

### 🔞 Mature modules *(optional unlock)*
Additional intimate parameters and dynamics, a **desire‑progression** system (preferences grow from unfamiliar to all‑consuming), atmosphere toggles, a **scene materialization** tool, and a few escalation mechanics — all gated, all opt‑in.

### 🧬 BIO‑LAB *(optional unlock)*
Deeper, body‑level changes: limb configuration, **races** (with signature traits auto‑applied), body modifications, cybernetic implants, body scale (doll / normal / giant), and regeneration.

### ⚙️ Mechanics
- **Psyche Integrity** — changes strain a subject's mind; push too far and the personality can break. Includes recovery and an optional pure‑sandbox mode with no consequences.
- **Calibration mode** 🔧 — fix what the auto‑analysis got wrong by editing a subject's *true* baseline, with no story impact and nothing reported to the AI.
- **Version history & rollback**, tied to chat messages (changes undo themselves when you delete or reroll a reply).
- **Chaos Engine** — let the device spontaneously mutate things on its own.
- **Bot Access** — optionally let the AI operate the console from within the story (including aiming it at *you*), scoped to whichever modules you've unlocked.

### 💭 Inner thoughts
Optionally have the character's honest inner monologue appear as a tidy, collapsible block right inside each reply — generated **together with the response**, so it costs no extra requests or tokens.

### 🎨 Quality of life
- **Bilingual UI** — English & Russian (auto‑detected, switchable).
- **Light / dark theme** and an **interface size** slider.
- **Draggable, resizable panel** that never slips off‑screen — tuned for both desktop and mobile.
- **Tap any value to type it exactly**, plus fine `+`/`−` steppers on every slider.
- **Preset previews** on hover / long‑press.
- Alphabetically sorted option lists in whichever language you're using.

---

## 📦 Installation

1. In SillyTavern, open **Extensions → Install extension**.
2. Paste this repository's URL and confirm.
3. Open any character chat — a floating 🧠 bubble appears. Tap it and hit **Synchronize**.

*Manual install:* copy this folder into `SillyTavern/public/scripts/extensions/third-party/` and restart SillyTavern.

---

## 🚀 Usage

1. **Sync** a target (the character, yourself, or an NPC) so MindWare reads its baseline.
2. **Adjust** any controls — your changes are staged as a draft.
3. Press **APPLY** to push them into the story; the AI picks them up on its next reply.
4. Use **🔧 Calibration** if the auto‑analysis was simply wrong about the original, and **↺** to discard pending changes.
5. Unlock the optional modules from the **SYS** tab whenever you want them.

State is saved **per chat**, so every conversation keeps its own configuration.

---

## 📝 Notes

- Designed for and tested with SillyTavern; works with both chat‑ and text‑completion backends.
- Some behaviours rely on the language model following instructions (e.g. inner thoughts and act‑aware features) — results vary by model.
- All edits are local to your chats; nothing is sent anywhere except your own configured AI backend.

---

## 🙏 Credits

Created by **Yumi4ka**. Built collaboratively with care. Contributions and feedback welcome.

*MindWare is a roleplay tool for consenting adult fiction. Please use it lawfully and respectfully.*
