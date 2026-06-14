# MindWare v3.0 — Script → Extension migration plan

Full SillyTavern extension (folder install / GitHub URL), ported from the
TavernHelper script. Floating 🧠 bubble UI kept. To the AI the device is a
**reality-editing console**, not a physical implant (UI keeps techy flavor).
Host integration mirrors SillyTavern-FNV-RPG.

## Files
- `manifest.json`, `style.css` (CSS still injected by JS for now), `index.js`

## Host adapter (top of index.js): script API → ST API
- getVariables/updateVariablesWith → chatMetadata['MindWare'] + saveMetadata
- injectPrompts/uninjectPrompts → buffered, flushed on GENERATE_AFTER_COMBINE_PROMPTS (TEST@ST)
- eventOn(tavern_events.X) → eventSource.on(event_types.X)
- getCharData/getCharAvatarPath/getPersonaAvatarPath → getContext().characters / userAvatar
- generateRaw → getContext().generateQuietPrompt (TEST@ST)
- substitudeMacros → ctx.substituteParams
- hidden tags hidden via managed regex rule

## STATUS
- [x] folder + manifest + style.css placeholder
- [x] adapter layer
- [x] v2.0 core ported (window/document), syntax-clean — LOADABLE SHELL
- [ ] live load-test in ST (verify TEST@ST spots)
- [ ] v3.0 param reworks + new mechanics (below)
- [ ] thoughts under messages; calibration; conjure; Phase-2 systems

## Phase 1 — param changes
- BODY: hair colors(14)/styles(10) reworked; skin −Unnatural; ears −Dragon;
  +Hair Texture/Eye Type/Resting Face/Makeup&Nails; +Wear&Tear slider; outfits appended;
  Scale & Regeneration → BIO (gated behind 🧬)
- MIND: Personality slider (top) + Orientation (top); +Charisma; Shyness→Morality;
  Courage→Self-esteem (High/Unstable/Low); Emotionality→Expressiveness; Talkativeness→Speech;
  +Perception Filter & Role Position (toward user); +User Dependency slider;
  speech +Emotionless/+Only moans/+Baby talk/+Broken, −Robotic/−Archaic; −Strict Teacher preset
- ERO: −Lewd speech; Fertility→breeding; kinks += Corruption, Pet Play, Self-objectification,
  Bondage, Choking, Roleplay, Foot, Smells, Impregnation; +Ahegao reflex; gate horny items
- BIO: receives Scale+Regeneration; body mods += Transparent Womb, Temperature Shift,
  Detachable Limbs; eye-type body mods folded into Eye Type select
- Gender change auto-adjusts breasts/members (F:2/0, M:0/1, Andro:1/0)

## Phase 1 — new mechanics
- Calibration mode (edit true baseline of selected subject; no psyche/no AI command)
- Tap-a-value → type exact number; +/− steppers on sliders
- Preset preview cards; Dark/Light theme
- Thoughts under each AI message (model emits hidden <!--mw-think …-->, shown as panel)
- Persona avatar for the user subject

### Conjure module (Phase 1)
Scene-level reality edit. Behind ERO unlock. Each item one-shot OR persistent;
aims at selected subject w/ "just in scene" option.
- Toys: vibrator, dildo, vibrating egg, cuffs, ropes, collar+leash, gag, blindfold, fucking machine, pump
- Creatures: tentacles, slime monster, ghostly hands, living chains

## FINAL POLISH TODO
- Alphabetical sort of flat option lists **per language, at render time** (sort by localized label in selectRow/chip render, NOT the underlying arrays — that breaks defaults() which uses opts[0]). Apply ONLY to flat lists (hair colors, eye colors, outfits, races, body mods, accessories...). DO NOT sort: tiers, scale, gender, memory_wipe depth, anything order-meaningful or where "None" stays first.

## Phase 2 — big systems (build all per user request)
- [DONE] Desire Progression (kinks → 0–100 sliders w/ addiction tiers)
- Cumulative Corruption meter (auto-count acts → escalate prompt)
- Autonomous stimulation (per-zone involuntary spasms)
- Denial protocol slider; Living clothing
- (REJECTED: Story-trigger tab / trigger words)
