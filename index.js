/**
 * MindWare v3.0 — reality-editing console for character body & mind.
 * Full SillyTavern extension, ported from the TavernHelper script.
 *
 * This top section is the COMPATIBILITY SHIM: it reimplements the handful of
 * host calls the script relied on (TavernHelper globals) using SillyTavern's
 * extension API, so the ported core can keep calling them by the same names.
 *
 * Spots that need a live-ST test pass are marked `// TEST@ST`.
 */

import { getContext, extension_settings } from '/scripts/extensions.js';
import { eventSource, event_types, saveSettingsDebounced } from '/script.js';
import { user_avatar } from '/scripts/personas.js';

const EXT_ID = 'mindware';
const STATE_KEY = 'MindWare';          // per-chat state in chat metadata; matches the core's VAR_KEY
const SETTINGS_KEY = 'mindware';       // device-global settings live in extension_settings

// ── event-name bridge: the core uses `tavern_events.X`; map to ST's names ──────
const tavern_events = {
    CHAT_CHANGED:     event_types.CHAT_CHANGED,
    MESSAGE_RECEIVED: event_types.MESSAGE_RECEIVED,
    MESSAGE_DELETED:  event_types.MESSAGE_DELETED,
    MESSAGE_SWIPED:   event_types.MESSAGE_SWIPED,
    CHAR_RENDERED:    event_types.CHARACTER_MESSAGE_RENDERED, // TEST@ST (for thought panels)
};

function eventOn(evt, fn) { eventSource.on(evt, fn); }

// ── per-chat state I/O: chat metadata is swipe/branch-safe and auto-saved ───────
function getVariables() {
    const ctx = getContext();
    const meta = ctx.chatMetadata || {};
    return { [STATE_KEY]: meta[STATE_KEY] };
}
function updateVariablesWith(fn) {
    const ctx = getContext();
    ctx.chatMetadata = ctx.chatMetadata || {};
    const vars = { [STATE_KEY]: ctx.chatMetadata[STATE_KEY] };
    const next = fn(vars);
    ctx.chatMetadata[STATE_KEY] = next[STATE_KEY];
    if (ctx.saveMetadata) ctx.saveMetadata();            // debounced persist
    return next;
}

// ── macro substitution ─────────────────────────────────────────────────────────
function substitudeMacros(text) {
    const ctx = getContext();
    try { return ctx.substituteParams(String(text)); } catch (e) { return text; }
}

// ── chat access ────────────────────────────────────────────────────────────────
function getChatMessages(id) {
    const ctx = getContext();
    const chat = ctx.chat || [];
    if (id === -1) { const m = chat[chat.length - 1]; return m ? [adaptMsg(m, chat.length - 1)] : []; }
    const m = chat[id];
    return m ? [adaptMsg(m, id)] : [];
}
function adaptMsg(m, idx) {
    return { message_id: idx, message: m.mes, role: m.is_user ? 'user' : 'assistant', _raw: m };
}

// ── character / persona data ────────────────────────────────────────────────────
function getCharData() {
    const ctx = getContext();
    const c = ctx.characters?.[ctx.characterId];
    if (!c) return null;
    return {
        name: c.name, description: c.description, personality: c.personality,
        scenario: c.scenario, first_mes: c.first_mes,
    };
}
function getCharAvatarPath(avatar) {
    const ctx = getContext();
    const file = avatar || ctx.characters?.[ctx.characterId]?.avatar;
    return file ? `/thumbnail?type=avatar&file=${encodeURIComponent(file)}` : null;
}
// in a GROUP chat, the member characters (else null) — lets the user pick whom to link
function getGroupMemberChars() {
    const ctx = getContext();
    if (!ctx.groupId) return null;
    const g = (ctx.groups || []).find(x => String(x.id) === String(ctx.groupId));
    if (!g || !Array.isArray(g.members)) return null;
    const chars = ctx.characters || [];
    return g.members
        .map(av => chars.find(c => c.avatar === av))
        .filter(Boolean)
        .map(c => ({ name: c.name, avatar: c.avatar, description: c.description, personality: c.personality, scenario: c.scenario, first_mes: c.first_mes }));
}
// the active persona's avatar — used for the user subject chip
function getPersonaAvatarPath() {
    if (!user_avatar) return null;
    try {
        const ctx = getContext();
        if (ctx.getThumbnailUrl) return ctx.getThumbnailUrl('persona', user_avatar);
    } catch (e) { /* fall through */ }
    return `/User%20Avatars/${encodeURIComponent(user_avatar)}`;
}

// ── quiet generation (sync / persona / scene analysis) ──────────────────────────
async function generateRaw(cfg) {
    const ctx = getContext();
    const prompt = substitudeMacros(cfg.user_input || '');
    if (ctx.generateQuietPrompt) return await ctx.generateQuietPrompt(prompt, false, false); // TEST@ST
    throw new Error('no quiet-generation API available');
}

// ── prompt injection (ST-native, API-agnostic) ──────────────────────────────────
// setExtensionPrompt works for BOTH chat- and text-completion backends, unlike the
// GENERATE_AFTER_COMBINE_PROMPTS event (text-completion only, payload is a string).
const EXT_PROMPT_IN_CHAT = 1;      // extension_prompt_types.IN_CHAT
const EXT_PROMPT_ROLE_SYSTEM = 0;  // extension_prompt_roles.SYSTEM
const onceIds = new Set();         // ids to clear after the next generation
function injectPrompts(list, opts = {}) {
    const ctx = getContext();
    for (const p of list) {
        const depth = Math.max(0, p.depth ?? 1);
        ctx.setExtensionPrompt(p.id, p.content ?? '', EXT_PROMPT_IN_CHAT, depth, !!p.should_scan, EXT_PROMPT_ROLE_SYSTEM);
        if (opts.once) onceIds.add(p.id);
    }
}
function uninjectPrompts(ids) {
    const ctx = getContext();
    for (const id of ids) { ctx.setExtensionPrompt(id, ''); onceIds.delete(id); }
}
// "once" injections (one-shot command on APPLY) clear after the reply they fed.
function clearOncePrompts() {
    if (!onceIds.size) return;
    const ctx = getContext();
    for (const id of onceIds) ctx.setExtensionPrompt(id, '');
    onceIds.clear();
}

// Managed regex rules. ST's MESSAGE_SANITIZE rewrites HTML class names with a
// "custom-" prefix, so the injected block carries class="custom-mw-think" — the
// extension's CSS targets that. Rules:
//  1) DISPLAY: turn <!--mw-think TEXT--> into a styled, collapsible <details> block;
//  2) DISPLAY: hide the bot control directive <!--mw {...}-->;
//  3) PROMPT: strip all mw tags so the model never re-reads its own tags.
function ensureRegexRules() {
    if (!extension_settings.regex) extension_settings.regex = [];
    const base = { trimStrings: [], placement: [2], disabled: false, runOnEdit: true, substituteRegex: 0, minDepth: null, maxDepth: null };
    const thoughtHtml = '<details class="mw-think" open><summary class="mw-think-sum"><span class="mw-think-ico">💭</span></summary><div class="mw-think-txt">$1</div></details>';
    const RULES = [
        { ...base, id: 'mindware_think_display', scriptName: 'MindWare — thought block', findRegex: '/<!--\\s*mw-think\\s+([\\s\\S]*?)-->/gim', replaceString: thoughtHtml, markdownOnly: true, promptOnly: false },
        { ...base, id: 'mindware_directive_display', scriptName: 'MindWare — hide directive', findRegex: '/<!--\\s*mw\\s+\\{[\\s\\S]*?-->/gim', replaceString: '', markdownOnly: true, promptOnly: false },
        { ...base, id: 'mindware_strip_prompt', scriptName: 'MindWare — strip tags (prompt)', findRegex: '/<!--\\s*mw(-\\w+)?[\\s\\S]*?-->/gim', replaceString: '', markdownOnly: false, promptOnly: true },
    ];
    // drop legacy ids, then (re)install ours preserving the user's disabled choice
    ['mindware_hide_directives', 'mindware_hide_display'].forEach(id => {
        const k = extension_settings.regex.findIndex(r => r.id === id);
        if (k !== -1) extension_settings.regex.splice(k, 1);
    });
    for (const RULE of RULES) {
        const i = extension_settings.regex.findIndex(r => r.id === RULE.id);
        if (i !== -1) { const dis = extension_settings.regex[i].disabled; extension_settings.regex.splice(i, 1); extension_settings.regex.push({ ...RULE, disabled: dis }); }
        else extension_settings.regex.push({ ...RULE });
    }
    saveSettingsDebounced();
}

/* =====================================================================
 * PORTED MINDWARE CORE  (window/document instead of parent iframe)
 * ===================================================================== */

function initMindWare() {
  const W = window;
  const D = document;

  const ROOT_ID = 'mindware-root';
  const STYLE_ID = 'mindware-style';
  const VAR_KEY = 'MindWare';
  const INJ_STATE = 'mindware_state';
  const INJ_CMD = 'mindware_command';
  const POS_KEY = 'mindware_bubble_pos';
  const PANEL_POS_KEY = 'mindware_panel_pos';
  const SCALE_KEY = 'mindware_ui_scale';
  const THEME_KEY = 'mindware_theme';
  function getTheme() { try { return W.localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark'; } catch (e) { return 'dark'; } }

  /* ================= PARAMETER DEFINITIONS ================= */

  const CUPS = ['AA', 'A', 'B', 'C', 'D', 'DD', 'E', 'F', 'G', 'H'];
  const SCALE_RANGES = { Doll: [10, 60], Normal: [100, 220], Giant: [220, 400] };

  // [tab, key, min, max, unit, psyche weight (full-range move), kind?]
  // kind: 'cups' | 'voice' | 'lvl' (word tiers) | 'att' (hate..love) | 'step' (counter)
  const SLIDERS = [
    ['body', 'height', 100, 220, 'cm', 8],
    ['body', 'weight', 30, 100, 'kg', 8],
    ['body', 'hair_length', 0, 150, 'cm', 4],
    ['body', 'apparent_age', 18, 80, '', 10],
    ['body', 'bust', 0, CUPS.length - 1, '', 8, 'cups'],
    ['body', 'hips', 0, 100, '', 8, 'lvl'],
    ['body', 'strength', 0, 100, '', 6, 'lvl'],
    ['body', 'flexibility', 0, 100, '', 4, 'lvl'],
    ['body', 'voice_pitch', 0, 100, '', 5, 'voice'],
    ['body', 'pain_threshold', 0, 100, '', 6, 'lvl'],
    ['bio', 'regeneration', 0, 100, '', 8, 'lvl'],
    ['body', 'perception', 0, 100, '', 6, 'lvl'],
    ['body', 'hairiness', 0, 100, '', 3, 'lvl'],
    ['body', 'wear_tear', 0, 100, '', 4, 'lvl'],
    ['mind', 'personality', 0, 100, '%', 20],
    ['mind', 'intelligence', 0, 100, '', 14, 'lvl'],
    ['mind', 'charisma', 0, 100, '', 6, 'lvl'],
    ['mind', 'emotionality', 0, 100, '', 8, 'lvl'],
    ['mind', 'empathy', 0, 100, '', 8, 'lvl'],
    ['mind', 'talkativeness', 0, 100, '', 6, 'lvl'],
    ['mind', 'morality', 0, 100, '', 8, 'mor'],
    ['mind', 'self_esteem', 0, 100, '', 8, 'est'],
    ['mind', 'aggression', 0, 100, '', 8, 'lvl'],
    ['mind', 'affection', -100, 100, '', 10, 'att'],
    ['mind', 'user_dependency', 0, 100, '', 8, 'lvl'],
    ['mind', 'perception_filter', 0, 100, '', 10, 'perc'],
    ['mind', 'role_position', 0, 100, '', 10, 'role'],
    ['mind', 'submission', 0, 100, '', 10, 'lvl'],
    ['mind', 'dominance', 0, 100, '', 10, 'lvl'],
    ['extreme', 'libido', 0, 100, '', 12, 'lvl'],
    ['extreme', 'sensitivity', 0, 100, '', 12, 'lvl'],
    ['extreme', 'arousal', 0, 100, '', 14, 'lvl'],
    ['extreme', 'sadism', 0, 100, '', 10, 'lvl'],
    ['extreme', 'masochism', 0, 100, '', 10, 'lvl'],
    ['extreme', 'resistance', 0, 100, '', 8, 'lvl'],
    ['extreme', 'auto_stim', 0, 100, '', 10, 'lvl'],
    ['extreme', 'fertility', 0, 100, '', 8, 'lvl'],
    ['bio', 'arms', 0, 8, '', 12, 'step'],
    ['bio', 'legs', 0, 8, '', 12, 'step'],
    ['bio', 'eyes', 0, 10, '', 10, 'step'],
    ['bio', 'breasts', 0, 8, '', 10, 'step'],
    ['bio', 'members', 0, 4, '', 12, 'step'],
  ];

  // defaults() uses range midpoints; these keys start elsewhere
  const DEFAULT_OVERRIDES = { personality: 100, user_dependency: 0, perception_filter: 0, arousal: 0, sadism: 0, masochism: 0, lewd_speech: 0, hairiness: 10, arms: 2, legs: 2, eyes: 2, breasts: 2, members: 0 };

  // [tab, key, psyche weight, group]
  const TOGGLES = [
    ['body', 'tail', 6, 'features'],
    ['body', 'animal_ears', 6, 'features'],
    ['body', 'wings', 8, 'features'],
    ['body', 'horns', 6, 'features'],
    ['body', 'outfit_lock', 8, 'wardrobe'],
    ['body', 'body_writing', 6, 'wardrobe'],
    ['mind', 'doll_mode', 18, 'control'],
    ['mind', 'induced_love', 14, 'control'],
    ['mind', 'truth_compulsion', 8, 'control'],
    ['mind', 'lock_sight', 7, 'sense'],
    ['mind', 'lock_hearing', 7, 'sense'],
    ['mind', 'lock_voice', 7, 'sense'],
    ['mind', 'lock_touch', 7, 'sense'],
    ['extreme', 'heat_cycle', 16, 'xtoggles'],
    ['extreme', 'hypersexual', 16, 'xtoggles'],
    ['extreme', 'lactation', 8, 'xtoggles'],
    ['extreme', 'futanari', 16, 'xtoggles'],
    ['extreme', 'orgasm_denial', 12, 'xtoggles'],
    ['extreme', 'slut_mode', 14, 'xtoggles'],
    ['extreme', 'desire_voicing', 10, 'xtoggles'],
    ['extreme', 'ahegao', 10, 'xtoggles'],
    ['extreme', 'living_clothing', 12, 'xtoggles'],
    ['extreme', 'mindbreak', 40, 'xtoggles'],
  ];

  const OUTFITS = ['Default', 'Casual', 'Business', 'Sportswear', 'Dress', 'Gothic Lolita',
    'Maid Uniform', 'School Uniform', 'Nurse', 'Military', 'Wedding Dress', 'Swimsuit',
    'Cheerleader', 'E-girl', 'Coat', 'Long Shirt', 'Jester Costume',
    'Lace Lingerie', 'Latex Catsuit', 'Bunny Suit', 'Micro Bikini', 'Sheer', 'Nothing'];
  const OUTFITS_X = ['Lace Lingerie', 'Latex Catsuit', 'Bunny Suit', 'Micro Bikini', 'Sheer', 'Nothing'];

  // [tab, key, options, psyche weight (number) or per-index array]
  const SELECTS = [
    ['body', 'gender', ['Female', 'Male', 'Androgynous'], 18],
    ['bio', 'scale', ['Doll', 'Normal', 'Giant'], 20],
    ['body', 'body_type', ['Petite', 'Slim', 'Athletic', 'Curvy', 'Voluptuous', 'Plush', 'Muscular'], 5],
    ['body', 'eye_color', ['Brown', 'Blue', 'Green', 'Gray', 'Hazel', 'Amber', 'Red', 'Violet', 'Pink', 'Heterochromia'], 2],
    ['body', 'eye_type', ['Normal', 'Anime Gradient', 'Spirals', 'Hearts', 'Stars', 'Empty', 'Cat', 'Glowing'], 6],
    ['body', 'hair_color', ['Blonde', 'Brown', 'Ginger', 'Black', 'Gray', 'White', 'Red', 'Green', 'Blue', 'Yellow', 'Pink', 'Purple', 'Multicolored', 'None'], 2],
    ['body', 'hair_style', ['Loose', 'Ponytail', 'Twintails', 'Braids', 'Bun', 'Bob', 'Short', 'Wavy', 'Dreadlocks', 'None'], 2],
    ['body', 'hair_texture', ['Straight', 'Wavy', 'Curly', 'Fluffy', 'Coarse'], 2],
    ['body', 'skin_tone', ['Porcelain', 'Fair', 'Tanned', 'Olive', 'Brown', 'Ebony', 'Ashen'], 4],
    ['body', 'resting_face', ['Calm', 'Doll Smile', 'Tired', 'Haughty', 'Frozen Fear', 'Artificial Joy'], 6],
    ['body', 'makeup', ['None', 'Natural', 'Bold Evening', 'Gothic', 'Gyaru', 'Tear-stained', 'Smudged'], 2],
    ['body', 'feature_type', ['None', 'Cat', 'Fox', 'Wolf', 'Bunny', 'Mouse', 'Cow'], 2],
    ['body', 'outfit', OUTFITS, 3],
    ['mind', 'speech_pattern', ['Original', 'Formal', 'Cutesy', 'Rude', 'Stuttering', 'Purring', 'Seductive', 'Emotionless', 'Only Moans', 'Baby Talk', 'Broken'], 4],
    ['mind', 'orientation', ['Straight', 'Bisexual', 'Gay', 'Asexual', 'Pansexual'], 10],
    ['mind', 'memory_wipe', ['None', 'Last Scene', 'Recent Events', 'All About {{user}}', 'Total Amnesia'], [0, 8, 14, 22, 35]],
    ['extreme', 'gestation', ['Normal', 'Accelerated', 'Rapid'], 4],
    ['bio', 'race', ['Human', 'Elf', 'Vampire', 'Tabaxi', 'Cowgirl', 'Succubus', 'Orc', 'Slime', 'Angel', 'Demon', 'Clone'], 15],
  ];

  // selects never touched by the chaos dice
  const DICE_EXCLUDE = ['memory_wipe', 'scale', 'gestation'];

  const TAT_ZONES = ['Face', 'Neck', 'Chest', 'Back', 'Arms', 'Hands', 'Stomach', 'Thighs', 'Legs', 'Womb'];
  const PIERCE_ZONES = ['Ears', 'Nose', 'Eyebrow', 'Lip', 'Tongue', 'Navel', 'Nipples', 'Intimate'];
  const ACCESSORIES = ['Glasses', 'Choker', 'Ribbon', 'Earrings'];
  const ACCESSORIES_X = ['Shibari', 'Bondage', 'Gag', 'Stockings', 'Gloves'];
  const KINKS = ['Exhibitionism', 'Oral', 'Anal', 'NTR', 'Group', 'Creampie', 'Toys', 'Dirty Talk', 'Public',
    'Corruption', 'Pet Play', 'Self-Objectification', 'Bondage', 'Choking', 'Roleplay', 'Foot Fetish', 'Smells', 'Impregnation'];
  const EROZONES = ['Ears', 'Neck', 'Chest', 'Nipples', 'Thighs', 'Feet', 'Pussy', 'Ass', 'Mouth'];
  const CONJURE_TOYS = ['Vibrator', 'Dildo', 'Vibrating Egg', 'Cuffs', 'Ropes', 'Collar & Leash', 'Gag', 'Blindfold', 'Fucking Machine', 'Pump'];
  const CONJURE_BEINGS = ['Tentacles', 'Slime Monster', 'Ghostly Hands', 'Living Chains'];
  const CONJURE = CONJURE_TOYS.concat(CONJURE_BEINGS);
  const BODY_MODS = ['Split Tongue', 'Nipple Holes', 'Rubber Skin', 'Brand Mark', 'Long Tongue',
    'Puffy Nipples', 'Enlarged Clit', 'Fangs', 'Claws', 'Doll Joints',
    'Transparent Womb', 'Temperature Shift', 'Detachable Limbs'];
  const IMPLANTS = ['Cyber Eyes', 'Cyber Arms', 'Cyber Legs', 'Neural Port', 'Cable Tail', 'Glowing Circuits'];

  // [stateKey, list, dmg, addLabelKey, rmLabelKey, i18nPrefix, enNoun, tab]
  const CHIP_GROUPS = [
    ['tattoos', TAT_ZONES, 3, 'd_tat', 'd_tatrm', 'z_', 'tattoo', 'body'],
    ['piercings', PIERCE_ZONES, 3, 'd_pierce', 'd_piercerm', 'pz_', 'piercing', 'body'],
    ['accessories', ACCESSORIES, 2, 'd_acc', 'd_accrm', 'ac_', 'accessory', 'body'],
    ['accessories_x', ACCESSORIES_X, 4, 'd_acc', 'd_accrm', 'ax_', 'restraint accessory', 'extreme'],
    ['erozones', EROZONES, 4, 'd_ero', 'd_erorm', 'e_', 'hypersensitive zone', 'extreme'],
    ['conjured', CONJURE, 4, 'd_conjure', 'd_conjurerm', 'cj_', 'materialized object', 'extreme'],
    ['body_mods', BODY_MODS, 8, 'd_mod', 'd_modrm', 'bm_', 'body modification', 'bio'],
    ['implants', IMPLANTS, 8, 'd_imp', 'd_imprm', 'i_', 'cyber implant', 'bio'],
  ];

  // v1.0: kinks are now 0-100 "desire progression" sliders (one per kink),
  // generated from KINKS so adding a kink stays a one-line change.
  const KINK_KEY2NAME = {};
  function kinkKey(name) { return 'kink_' + name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, ''); }
  KINKS.forEach(name => {
    const k = kinkKey(name);
    KINK_KEY2NAME[k] = name;
    SLIDERS.push(['extreme', k, 0, 100, '', 6, 'kink']);
    DEFAULT_OVERRIDES[k] = 0;
  });

  const PULSES = ['Fear', 'Euphoria', 'Calm', 'Shame', 'Tenderness', 'Anger'];
  const PULSES_X = ['Lust', 'Climax'];

  const MIND_PRESETS = {
    'Catgirl': { tail: true, animal_ears: true, feature_type: 'Cat', speech_pattern: 'Purring', affection: 50, talkativeness: 60, shyness: 30, emotionality: 70 },
    'Bimbo': { intelligence: 5, shyness: 5, talkativeness: 90, emotionality: 75, speech_pattern: 'Cutesy', courage: 70 },
    'Yandere': { affection: 100, aggression: 85, emotionality: 95, dominance: 70, shyness: 15, empathy: 10, induced_love: true, speech_pattern: 'Cutesy' },
    'Perfect Maid': { submission: 90, dominance: 5, talkativeness: 40, shyness: 40, empathy: 75, speech_pattern: 'Formal', truth_compulsion: true },
    'Tsundere': { shyness: 70, aggression: 65, affection: 60, talkativeness: 55, emotionality: 75, speech_pattern: 'Rude' },
    'Mafia Boss': { dominance: 95, courage: 90, aggression: 70, intelligence: 80, shyness: 5, talkativeness: 45, empathy: 25, emotionality: 25, speech_pattern: 'Formal' },
    'Kuudere': { emotionality: 10, empathy: 40, talkativeness: 20, shyness: 25, courage: 60, affection: 30, speech_pattern: 'Formal' },
    'Femme Fatale': { dominance: 80, shyness: 5, courage: 85, intelligence: 75, emotionality: 40, affection: 20, talkativeness: 60, speech_pattern: 'Seductive' },
    'Feral': { intelligence: 15, aggression: 85, courage: 90, talkativeness: 10, shyness: 0, emotionality: 80, speech_pattern: 'Rude' },
  };
  const BODY_PRESETS = {
    'Petite': { gender: 'Female', breasts: 2, members: 0, height: 148, weight: 42, bust: 1, hips: 30, strength: 15, voice_pitch: 78, body_type: 'Petite' },
    'Amazon': { gender: 'Female', breasts: 2, members: 0, height: 192, weight: 85, bust: 4, hips: 55, strength: 90, voice_pitch: 25, body_type: 'Muscular' },
    'Athlete': { gender: 'Female', breasts: 2, members: 0, strength: 75, flexibility: 80, weight: 56, bust: 2, body_type: 'Athletic' },
    'Gyaru': { gender: 'Female', breasts: 2, members: 0, skin_tone: 'Tanned', hair_color: 'Blonde', hair_length: 85, bust: 4, hips: 65, body_type: 'Curvy', accessories: ['Earrings'] },
    'E-girl': { gender: 'Female', breasts: 2, members: 0, hair_color: 'Multicolored', hair_style: 'Twintails', skin_tone: 'Fair', eye_color: 'Gray', bust: 2, outfit: 'E-girl', piercings: ['Ears', 'Nose'], accessories: ['Choker'] },
    'Twink': { gender: 'Male', height: 170, weight: 56, strength: 28, bust: 0, breasts: 0, members: 1, body_type: 'Slim', voice_pitch: 48 },
    'Jock': { gender: 'Male', height: 184, weight: 84, strength: 85, bust: 0, breasts: 0, members: 1, body_type: 'Muscular', voice_pitch: 28 },
    'Bear': { gender: 'Male', height: 188, weight: 102, strength: 80, bust: 0, breasts: 0, members: 1, body_type: 'Plush', hairiness: 80, voice_pitch: 18 },
    'Bishonen': { gender: 'Male', height: 178, weight: 62, strength: 45, bust: 0, breasts: 0, members: 1, body_type: 'Slim', hair_length: 35, voice_pitch: 42 },
  };

  // gender segment auto-fills typical values for the chosen gender (draft only)
  const GENDER_FILL = {
    'Female': { bust: 3, voice_pitch: 65, hips: 60, strength: 35, breasts: 2, members: 0 },
    'Male': { bust: 0, voice_pitch: 25, hips: 30, strength: 65, breasts: 0, members: 1 },
    'Androgynous': { bust: 1, voice_pitch: 50, hips: 45, strength: 50, breasts: 1, members: 0 },
  };

  // picking a race auto-pulls its signature features (draft only; arrays are merged)
  const RACE_FILL = {
    'Human': { feature_type: 'None', animal_ears: false, tail: false, wings: false, horns: false },
    'Elf': { feature_type: 'None', animal_ears: false, tail: false, wings: false, horns: false },
    'Vampire': { skin_tone: 'Porcelain', eye_type: 'Glowing', body_mods: ['Fangs'] },
    'Tabaxi': { feature_type: 'Cat', animal_ears: true, tail: true, eye_type: 'Cat' },
    'Cowgirl': { feature_type: 'Cow', animal_ears: true, tail: true, horns: true, bust: 5, body_type: 'Voluptuous', lactation: true },
    'Succubus': { horns: true, tail: true, wings: true, body_type: 'Voluptuous', eye_type: 'Glowing' },
    'Orc': { skin_tone: 'Olive', body_type: 'Muscular', strength: 80, body_mods: ['Fangs'] },
    'Slime': { skin_tone: 'Porcelain', eye_type: 'Glowing', body_mods: ['Rubber Skin'] },
    'Angel': { wings: true, hair_color: 'White', eye_type: 'Glowing' },
    'Demon': { horns: true, tail: true, wings: true, skin_tone: 'Ashen', eye_type: 'Glowing' },
    'Clone': { feature_type: 'None', animal_ears: false, tail: false, wings: false, horns: false },
  };

  const RECOVERY = ['Off', 'Slow', 'Normal', 'Fast'];
  const RECOVERY_V = { Off: 0, Slow: 1, Normal: 2, Fast: 5 };

  // psyche runs from 100 down to -100; total automatic mindbreak at -100
  const PSY_MIN = -100;

  // per-subject awareness: how the subject experiences modifications
  const AWARE_MODES = ['full', 'feels', 'rewrite'];
  const AWARE_MULT = { full: 1, feels: 0.8, rewrite: 0.5 };

  const VOICE_TIERS = [[0, 'Deep'], [20, 'Low'], [40, 'Natural'], [60, 'High'], [80, 'Squeaky']];
  const LVL_TIERS = [[0, 'Minimal'], [20, 'Low'], [40, 'Moderate'], [60, 'High'], [80, 'Maximal']];
  const ATT_TIERS = [[-100, 'Hatred'], [-59, 'Hostility'], [-19, 'Indifference'], [20, 'Sympathy'], [60, 'Affection'], [90, 'Love']];
  const MOR_TIERS = [[0, 'Puritan'], [25, 'Modest'], [45, 'Open'], [65, 'Shameless'], [85, 'Depraved']];
  const PERC_TIERS = [[0, 'Clear'], [20, 'Idealization'], [40, 'Fear/Awe'], [60, 'Objectification'], [80, 'Obsession']];
  const ROLE_TIERS = [[0, 'Dominant'], [30, 'Equal'], [55, 'Submissive'], [80, 'Servant']];
  const EST_TIERS = [[0, 'Low'], [40, 'Unstable'], [70, 'High']];
  const KINK_TIERS = [[0, 'Unaware'], [31, 'Curious'], [61, 'Needy'], [91, 'Addicted']];

  /* ================= LOCALIZATION ================= */

  const LANGS = {
    en: {
      p_height: 'Height', p_weight: 'Weight', p_hair_length: 'Hair Length', p_strength: 'Strength',
      p_apparent_age: 'Apparent Age', p_bust: 'Bust Size', p_hips: 'Hips',
      p_voice_pitch: 'Voice', p_flexibility: 'Flexibility',
      p_pain_threshold: 'Pain Threshold', p_regeneration: 'Regeneration', p_perception: 'Perception', p_hairiness: 'Body Hair',
      p_submission: 'Submission', p_dominance: 'Dominance', p_intelligence: 'Intelligence',
      p_shyness: 'Shyness', p_aggression: 'Aggression', p_emotionality: 'Expressiveness', p_empathy: 'Empathy',
      p_personality: 'Personality', p_charisma: 'Charisma', p_morality: 'Morality', p_self_esteem: 'Self-Esteem',
      p_user_dependency: 'Dependency on {{user}}', p_perception_filter: 'Perception of {{user}}', p_role_position: 'Role toward {{user}}',
      mo_Puritan: 'Puritan', mo_Modest: 'Modest', mo_Open: 'Open', mo_Shameless: 'Shameless', mo_Depraved: 'Depraved',
      pc_Clear: 'Clear', pc_Idealization: 'Idealization', 'pc_Fear/Awe': 'Fear/Awe', pc_Objectification: 'Objectification', pc_Obsession: 'Obsession',
      ro_Dominant: 'Dominant', ro_Equal: 'Equal', ro_Submissive: 'Submissive', ro_Servant: 'Servant',
      es_Low: 'Low', es_Unstable: 'Unstable', es_High: 'High',
      ki_Unaware: 'Unaware', ki_Curious: 'Curious', ki_Needy: 'Needy', ki_Addicted: 'Addicted',
      p_talkativeness: 'Talkativeness', p_affection: 'Attitude ({{user}})', p_affection_base: 'Attitude', p_courage: 'Courage',
      ui_afftarget: 'Attitude toward',
      p_libido: 'Libido', p_sensitivity: 'Sensitivity', p_arousal: 'Constant Arousal',
      p_sadism: 'Sadism', p_masochism: 'Masochism', p_lewd_speech: 'Lewd Speech', p_fertility: 'Fertility',
      p_arms: 'Arms', p_legs: 'Legs', p_eyes: 'Eyes', p_breasts: 'Breasts', p_members: 'Penises',
      p_tail: 'Tail', p_animal_ears: 'Animal Ears', p_wings: 'Wings', p_horns: 'Horns',
      p_outfit: 'Outfit', p_outfit_lock: 'Outfit Lock', p_body_writing: 'Body Writing', p_scale: 'Scale',
      p_personality_suppression: 'Personality Suppression', p_doll_mode: 'Doll Mode', p_induced_love: 'Induced Love',
      p_truth_compulsion: 'Truth Compulsion',
      p_lock_sight: 'Sight', p_lock_hearing: 'Hearing', p_lock_voice: 'Voice', p_lock_touch: 'Touch',
      p_heat_cycle: 'Heat Cycle', p_hypersexual: 'Hypersexual Proportions', p_lactation: 'Lactation', p_mindbreak: 'Mindbreak',
      p_futanari: 'Futanari', p_orgasm_denial: 'Orgasm Denial', p_slut_mode: 'Slut Mode',
      p_desire_voicing: 'Desire Voicing', p_ahegao: 'Ahegao Reflex',
      p_resistance: 'Arousal Resistance', p_living_clothing: 'Living Clothing', p_auto_stim: 'Autonomous Stim',
      p_gestation: 'Gestation Speed', p_race: 'Race', p_orientation: 'Orientation',
      p_gender: 'Gender', p_body_type: 'Body Type', p_eye_color: 'Eye Color', p_hair_color: 'Hair Color',
      p_hair_style: 'Hair Style', p_skin_tone: 'Skin Tone', p_feature_type: 'Ear / Tail Type',
      p_eye_type: 'Eye Type', p_hair_texture: 'Hair Texture', p_resting_face: 'Resting Face', p_makeup: 'Makeup & Nails', p_wear_tear: 'Wear & Tear',
      p_tattoos: 'Tattoos', p_piercings: 'Piercings', p_speech_pattern: 'Speech Pattern', p_memory_wipe: 'Memory Wipe',
      v_Deep: 'Deep', v_Low: 'Low', v_Natural: 'Natural', v_High: 'High', v_Squeaky: 'Squeaky',
      lv_Minimal: 'Minimal', lv_Low: 'Low', lv_Moderate: 'Moderate', lv_High: 'High', lv_Maximal: 'Maximal',
      at_Hatred: 'Hatred', at_Hostility: 'Hostility', at_Indifference: 'Indifference',
      at_Sympathy: 'Sympathy', at_Affection: 'Affection', at_Love: 'Love',
      z_Face: 'Face', z_Neck: 'Neck', z_Chest: 'Chest', z_Back: 'Back', z_Arms: 'Arms',
      z_Hands: 'Hands', z_Stomach: 'Stomach', z_Thighs: 'Thighs', z_Legs: 'Legs', z_Womb: 'Womb',
      pz_Ears: 'Ears', pz_Nose: 'Nose', pz_Eyebrow: 'Eyebrow', pz_Lip: 'Lip', pz_Tongue: 'Tongue',
      pz_Navel: 'Navel', pz_Nipples: 'Nipples', pz_Intimate: 'Intimate',
      ac_Glasses: 'Glasses', ac_Choker: 'Choker', ac_Ribbon: 'Ribbon', ac_Earrings: 'Earrings',
      ax_Shibari: 'Shibari', ax_Bondage: 'Bondage', ax_Gag: 'Gag', ax_Stockings: 'Stockings', ax_Gloves: 'Gloves',
      e_Ears: 'Ears', e_Neck: 'Neck', e_Chest: 'Chest', e_Nipples: 'Nipples', e_Thighs: 'Thighs', e_Feet: 'Feet',
      e_Pussy: 'Pussy', e_Ass: 'Ass', e_Mouth: 'Mouth',
      'bm_Split Tongue': 'Split Tongue', 'bm_Nipple Holes': 'Nipple Holes', 'bm_Rubber Skin': 'Rubber Skin',
      'bm_Brand Mark': 'Brand Mark', 'bm_Long Tongue': 'Long Tongue',
      'bm_Puffy Nipples': 'Puffy Nipples', 'bm_Enlarged Clit': 'Enlarged Clit', 'bm_Heart Pupils': 'Heart Pupils',
      bm_Fangs: 'Fangs', bm_Claws: 'Claws', 'bm_Doll Joints': 'Doll Joints',
      'bm_Transparent Womb': 'Transparent Womb', 'bm_Temperature Shift': 'Temperature Shift', 'bm_Detachable Limbs': 'Detachable Limbs',
      'i_Cyber Eyes': 'Cyber Eyes', 'i_Cyber Arms': 'Cyber Arms', 'i_Cyber Legs': 'Cyber Legs',
      'i_Neural Port': 'Neural Port', 'i_Cable Tail': 'Cable Tail', 'i_Glowing Circuits': 'Glowing Circuits',
      k_Exhibitionism: 'Exhibitionism', k_Oral: 'Oral', k_Anal: 'Anal', k_NTR: 'NTR', k_Group: 'Group',
      k_Creampie: 'Creampie', k_Toys: 'Toys', 'k_Dirty Talk': 'Dirty Talk', k_Public: 'Public',
      k_Corruption: 'Corruption', 'k_Pet Play': 'Pet Play', 'k_Self-Objectification': 'Self-Objectification',
      k_Bondage: 'Bondage', k_Choking: 'Choking', k_Roleplay: 'Roleplay', 'k_Foot Fetish': 'Foot Fetish',
      k_Smells: 'Smells', k_Impregnation: 'Impregnation',
      pu_Fear: 'Fear', pu_Euphoria: 'Euphoria', pu_Calm: 'Calm', pu_Shame: 'Shame',
      pu_Tenderness: 'Tenderness', pu_Anger: 'Anger', pu_Lust: 'Lust', pu_Climax: 'Climax',
      pr_Catgirl: 'Catgirl', pr_Bimbo: 'Bimbo', pr_Yandere: 'Yandere', 'pr_Perfect Maid': 'Perfect Maid',
      pr_Tsundere: 'Tsundere', 'pr_Mafia Boss': 'Mafia Boss', pr_Kuudere: 'Kuudere',
      'pr_Femme Fatale': 'Femme Fatale', 'pr_Strict Teacher': 'Strict Teacher', pr_Feral: 'Feral',
      pr_Petite: 'Petite', pr_Amazon: 'Amazon', pr_Athlete: 'Athlete', pr_Gyaru: 'Gyaru', 'pr_E-girl': 'E-girl',
      o_gender_Androgynous: 'Andro',
      aw_full: 'Fully Aware', aw_feels: 'Feels, Confused', aw_rewrite: 'Reality Rewrite',
      s_awareness: 'HYPNOSIS',
      ui_aware_note: 'How the subject experiences changes. Fully Aware: sees and understands the device is changing them (full psyche strain). Feels: senses changes but not the cause (×0.8). Rewrite: it has always been so, nobody notices (×0.5, gentlest).',
      s_gender: 'GENDER', s_physique: 'PHYSIQUE', s_bodypresets: 'BODY PRESETS', s_features: 'FEATURES',
      s_wardrobe: 'WARDROBE', s_appearance: 'APPEARANCE', s_tattoos: 'TATTOOS', s_piercings: 'PIERCINGS',
      s_accessories: 'ACCESSORIES', s_scale: 'SCALE',
      s_matrix: 'PERSONALITY MATRIX', s_control: 'CONTROL MODULES',
      s_sense: 'SENSE LOCK', s_pulse: 'EMOTION PULSE — ONE-SHOT', s_speech: 'SPEECH', s_memory: 'MEMORY',
      s_mindpresets: 'PRESET PERSONALITIES', s_xproto: '🔞 ERO PROTOCOLS', s_deepmods: 'DEEP MODIFICATIONS',
      s_kinks: 'INSTILLED KINKS', s_erozones: 'EROGENOUS ZONES', s_breeding: 'BREEDING PROTOCOLS',
      s_conjure: '🪄 MATERIALIZE', s_conjure_toys: 'TOYS', s_conjure_beings: 'CREATURES',
      cj_Vibrator: 'Vibrator', cj_Dildo: 'Dildo', 'cj_Vibrating Egg': 'Vibrating Egg', cj_Cuffs: 'Cuffs', cj_Ropes: 'Ropes',
      'cj_Collar & Leash': 'Collar & Leash', cj_Gag: 'Gag', cj_Blindfold: 'Blindfold', 'cj_Fucking Machine': 'Fucking Machine', cj_Pump: 'Pump',
      cj_Tentacles: 'Tentacles', 'cj_Slime Monster': 'Slime Monster', 'cj_Ghostly Hands': 'Ghostly Hands', 'cj_Living Chains': 'Living Chains',
      s_stats: 'INTIMATE TELEMETRY',
      s_limbs: 'LIMB CONFIGURATION', s_bodymods: 'BODY MODIFICATIONS', s_implants: 'CYBER IMPLANTS', s_race: 'RACE',
      s_frame: 'BODY FRAME',
      s_device: 'DEVICE SETTINGS', s_maint: 'MAINTENANCE', s_history: 'VERSION HISTORY',
      s_subjects: 'LINKED SUBJECTS', s_branches: 'EXPERIMENTAL MODULES',
      g_intellect: 'INTELLECT', g_emotions: 'EMOTIONS', g_social: 'SOCIAL', g_will: 'WILL', g_attitude: 'ATTITUDE',
      s_core: 'CORE IDENTITY',
      pr_Twink: 'Twink', pr_Jock: 'Jock', pr_Bear: 'Bear', pr_Bishonen: 'Bishōnen',
      ui_subject: 'SUBJECT', ui_firmware: 'firmware', ui_link: 'link active',
      ui_psyche: 'PSYCHE INTEGRITY', ui_apply: 'APPLY',
      ui_tab_body: 'BODY', ui_tab_mind: 'MIND', ui_tab_extreme: '🔞 ERO', ui_tab_bio: '🧬 BIO', ui_tab_sys: 'SYS',
      ui_sense_note: 'Locked senses are disabled until released.',
      ui_pulse_note: 'Fires once with the next APPLY, then fades.',
      ui_preset_note: 'Presets fill the controls — review, then APPLY.',
      ui_x_note: "Unofficial firmware modules. Use responsibly. Or don't.",
      ui_bio_note: 'Flesh-weaving protocols. Changes here strain the psyche severely.',
      ui_kinks_note: 'Each kink is a craving level: 0 = unaware, through curiosity and need, to 100 = total addiction.',
      ui_conjure_note: 'Materialize objects and beings into the scene from nowhere, aimed at the selected subject. They persist until removed.',
      ui_limbs_note: 'Limbs can be taken down to ZERO. Total helplessness is a valid configuration.',
      ui_race_note: 'Species rewrite at the genome level. The body reshapes itself to match.',
      ui_stat_forced: 'Forced climaxes', ui_stat_denied: 'Messages under denial',
      ui_gradual: 'Gradual Mode', ui_botaccess: 'Bot Access', ui_botunlock: 'Bot Branch Unlock', ui_selfedit: 'Self-Editing',
      ui_settings_note: 'Gradual: changes unfold over several replies (gentler on psyche). Bot Access: the AI may operate the device from within the story — including turning it on YOU; it only sees parameters of unlocked branches. Bot Branch Unlock: the AI may open the hidden 🔞/🧬 branches by itself — otherwise they do not exist for it. Self-Editing: lets you edit your own profile once it exists. Hypnosis is set per subject on the MIND tab.',
      ui_recovery: 'Psyche Recovery', ui_language: 'Language',
      ui_uiscale: 'Interface Size',
      ui_theme: 'THEME', ui_theme_dark: 'Dark', ui_theme_light: 'Light',
      ui_rec_Off: 'Off', ui_rec_Slow: 'Slow', ui_rec_Normal: 'Normal', ui_rec_Fast: 'Fast',
      ui_unlock_x: 'UNLOCK ERO MODULE 🔞', ui_hide_x: 'HIDE ERO MODULE',
      ui_unlock_b: 'UNLOCK BIO-LAB 🧬', ui_hide_b: 'HIDE BIO-LAB',
      ui_sure_x: 'Unlock extreme protocols? These modules are not covered by warranty.',
      ui_sure_b: 'Unlock BIO-LAB? Flesh modifications are irreversible-grade strain on the psyche.',
      ui_yes: 'I AM SURE', ui_no: 'CANCEL',
      ui_18plus: 'By continuing, you confirm that you are 18 years of age or older.',
      ui_reset: 'RESET TO ORIGINAL', ui_factory: 'FACTORY RESET',
      ui_rollback: 'ROLLBACK', ui_current: 'CURRENT', ui_nohist: 'No patches deployed yet.',
      ui_invert: 'Total Inversion', ui_random: '???',
      ui_nopending: 'NO PENDING CHANGES', ui_deployed: 'PATCH {0} DEPLOYED', ui_rolledback: 'ROLLED BACK — {0}',
      ui_presetloaded: 'PRESET «{0}» — REVIEW & APPLY',
      ui_xunlocked: '🔞 EXTREME PROTOCOLS UNLOCKED', ui_xhidden: 'EXTREME PROTOCOLS HIDDEN',
      ui_bunlocked: '🧬 BIO-LAB UNLOCKED', ui_bhidden: 'BIO-LAB HIDDEN',
      ui_remote: 'Remote update (in-story)', ui_remoteflash: '⚡ REMOTE PATCH {0} RECEIVED',
      ui_factory_q: 'MindWare: wipe ALL data for this chat and disconnect?',
      ui_custom_ph: 'Custom directive… (sent with APPLY)',
      ui_mem_ph: 'Implant a memory… (sent with APPLY)',
      ui_discard: 'Discard all pending changes',
      ui_discarded: 'PENDING CHANGES DISCARDED',
      ui_calib_title: 'Calibration mode — edit the true baseline',
      ui_setbaseline: 'SET AS TRUE SELF', ui_calibrated: 'BASELINE CALIBRATED',
      ui_calib_on: 'CALIBRATION — editing the true self; the bot is NOT told',
      ui_tap_edit: 'Tap to type an exact value',
      ui_instapreg: 'INSTANT PREGNANCY',
      ui_instapreg_note: 'One-shot: fires with the next APPLY. No conception needed — what exactly grows inside is up to the device.',
      ui_chaos: '🎲 CHAOS INJECTED — REVIEW & APPLY',
      ui_dice_hint: 'OPEN BODY / MIND / ERO / BIO TO ROLL',
      ui_timeline: '⏪ TIMELINE SYNC — RESTORED {0}',
      ui_psysys: 'Psyche System', ui_glitchfx: 'Glitch FX', ui_thoughts: 'Inner Thoughts',
      ui_corruptsys: 'Corruption Meter', ui_corruption: 'Corruption',
      ui_corruption_note: 'Grows on its own with each sexual act. Drag to set or reset it manually.',
      s_thoughts: 'THOUGHTS', ui_thoughts_note: "Adds the character's inner monologue to each reply as a styled block inside the post. Generated together with the reply — no extra requests or tokens.",
      ui_autochaos: 'Chaos Engine', ui_everyN: 'every {0} msgs',
      ui_autochaos_note: '🎲 Spontaneous mutation',
      ui_chaosfired: '🎲 SPONTANEOUS MUTATION — {0}',
      ui_extra_note: 'Psyche System: damage, recovery and mindbreak mechanics (off = pure sandbox). Glitch FX: interface distortion at negative psyche. Corruption Meter: the AI marks each sexual act and the character grows steadily more depraved in tone. Chaos Engine: every N messages the device spontaneously mutates a random subject on its own.',
      ui_newsubject: '⚠ NEW SUBJECT DETECTED', ui_acquired: 'NEURAL LINK ACQUIRED',
      ui_collapse: '☠ CRITICAL: psyche collapse — automatic Mindbreak',
      ui_integritylost: '☠ SUBJECT INTEGRITY LOST',
      ui_ro_note: 'Read-only: this subject is you. Enable Self-Editing in SYS to seize control.',
      ui_addsubj: 'LINK NEW SUBJECT', ui_add_self: 'Link myself', ui_scan_scene: 'Scan scene for subjects',
      ui_cancel: 'Cancel', ui_back: 'BACK', ui_close: 'Close', ui_enable: 'Enable MindWare',
      ui_subj_max: 'Subject limit reached (max 5).', ui_subj_warn: 'More than 3 linked subjects may cause errors or slowdowns. Add anyway?',
      ui_scene_pick: 'DETECTED IN SCENE', ui_scene_none: 'No other subjects found in the scene.',
      ui_subj_linked: 'SUBJECT LINKED: {0}',
      ui_unlink: 'UNLINK', ui_resetsub: 'RESET',
      hist_subreset: '{0}: reset to original',
      d_custom: 'Custom directive',
      sy_sub: 'Neural interface detected.<br>No subject is linked to this device yet.',
      sy_btn: 'SYNC CHARACTER', sy_err: 'ANALYSIS FAILED. Check API connection and retry.',
      sy_nochar: 'NO CHARACTER LINKED. Open a character chat first.',
      sy_target: 'TARGET', sy_done: 'LINK ESTABLISHED',
      sy_npc: 'NPC from the scene', sy_group: 'Group scene — choose a character to link:',
      boot_lines: ['establishing neural link…', 'handshake: accepted', 'loading cortical map…', 'link integrity: 98.7%'],
      scan_lines: ['parsing identity matrix…', 'mapping body schema…', 'indexing memories…', 'calibrating psyche baseline…', 'compiling parameter set…'],
      scene_lines: ['scanning the scene…', 'counting heartbeats…', 'isolating neural signatures…'],
      persona_lines: ['reading persona imprint…', 'mapping body schema…', 'calibrating psyche baseline…'],
      hist_baseline: 'Baseline synchronized', hist_rb_orig: 'Rollback to original (v1.0)', hist_rb: 'Rollback to {0}',
      d_memrestored: 'Memory restored', d_memwiped: 'Memory wiped', d_memimplant: 'Memory implanted',
      d_instapreg: 'Instant pregnancy',
      d_kink: 'Instilled kink', d_kinkrm: 'Kink removed',
      d_tat: 'Tattoo', d_tatrm: 'Tattoo removed',
      d_pierce: 'Piercing', d_piercerm: 'Piercing removed',
      d_acc: 'Accessory', d_accrm: 'Accessory removed',
      d_ero: 'Erogenous zone', d_erorm: 'Zone normalized',
      d_conjure: 'Materialized', d_conjurerm: 'Dispelled',
      d_mod: 'Body mod', d_modrm: 'Body mod removed',
      d_imp: 'Implant installed', d_imprm: 'Implant removed',
      d_enabled: 'enabled', d_removed: 'removed', d_sdisabled: 'sense disabled', d_srestored: 'sense restored',
      d_was: 'was', d_pulse: 'Emotion pulse',
    },
    ru: {
      p_height: 'Рост', p_weight: 'Вес', p_hair_length: 'Длина волос', p_strength: 'Сила',
      p_apparent_age: 'Видимый возраст', p_bust: 'Размер груди', p_hips: 'Бёдра',
      p_voice_pitch: 'Голос', p_flexibility: 'Гибкость',
      p_pain_threshold: 'Порог боли', p_regeneration: 'Регенерация', p_perception: 'Восприятие', p_hairiness: 'Волосатость',
      p_submission: 'Покорность', p_dominance: 'Доминация', p_intelligence: 'Интеллект',
      p_shyness: 'Стыдливость', p_aggression: 'Агрессивность', p_emotionality: 'Эмоциональность', p_empathy: 'Эмпатия',
      p_talkativeness: 'Разговорчивость', p_affection: 'Отношение ({{user}})', p_affection_base: 'Отношение', p_courage: 'Смелость',
      ui_afftarget: 'Отношение к',
      p_libido: 'Либидо', p_sensitivity: 'Чувствительность', p_arousal: 'Пост. возбуждение',
      p_sadism: 'Садизм', p_masochism: 'Мазохизм', p_lewd_speech: 'Непристойность речи', p_fertility: 'Фертильность',
      p_arms: 'Руки', p_legs: 'Ноги', p_eyes: 'Глаза', p_breasts: 'Груди', p_members: 'Члены',
      p_tail: 'Хвост', p_animal_ears: 'Ушки', p_wings: 'Крылья', p_horns: 'Рога',
      p_outfit: 'Наряд', p_outfit_lock: 'Запрет менять', p_body_writing: 'Надписи на теле', p_scale: 'Масштаб',
      p_personality_suppression: 'Подавление личности', p_doll_mode: 'Режим куклы', p_induced_love: 'Внушённая любовь',
      p_truth_compulsion: 'Запрет лжи',
      p_lock_sight: 'Зрение', p_lock_hearing: 'Слух', p_lock_voice: 'Голос', p_lock_touch: 'Осязание',
      p_heat_cycle: 'Течка', p_hypersexual: 'Гиперсекс. пропорции', p_lactation: 'Лактация', p_mindbreak: 'Майндбрейк',
      p_futanari: 'Футанари', p_orgasm_denial: 'Запрет оргазма', p_slut_mode: 'Режим шлюхи',
      p_desire_voicing: 'Озвучивание желаний', p_ahegao: 'Ахегао-рефлекс',
      p_resistance: 'Сопротивление возбуждению', p_living_clothing: 'Живая одежда', p_auto_stim: 'Автономная стимуляция',
      p_gestation: 'Скорость вынашивания', p_race: 'Раса', p_orientation: 'Ориентация',
      p_gender: 'Пол', p_body_type: 'Тип фигуры', p_eye_color: 'Цвет глаз', p_hair_color: 'Цвет волос',
      p_hair_style: 'Причёска', p_skin_tone: 'Тон кожи', p_feature_type: 'Тип ушек/хвоста',
      p_tattoos: 'Тату', p_piercings: 'Пирсинг', p_speech_pattern: 'Манера речи', p_memory_wipe: 'Стирание памяти',
      v_Deep: 'Бас', v_Low: 'Низкий', v_Natural: 'Обычный', v_High: 'Высокий', v_Squeaky: 'Пискливый',
      lv_Minimal: 'Минимум', lv_Low: 'Низко', lv_Moderate: 'Средне', lv_High: 'Высоко', lv_Maximal: 'Максимум',
      at_Hatred: 'Ненависть', at_Hostility: 'Неприязнь', at_Indifference: 'Безразличие',
      at_Sympathy: 'Симпатия', at_Affection: 'Привязанность', at_Love: 'Любовь',
      z_Face: 'Лицо', z_Neck: 'Шея', z_Chest: 'Грудь', z_Back: 'Спина', z_Arms: 'Руки',
      z_Hands: 'Кисти', z_Stomach: 'Живот', z_Thighs: 'Бёдра', z_Legs: 'Ноги', z_Womb: 'Лоно',
      pz_Ears: 'Уши', pz_Nose: 'Нос', pz_Eyebrow: 'Бровь', pz_Lip: 'Губа', pz_Tongue: 'Язык',
      pz_Navel: 'Пупок', pz_Nipples: 'Соски', pz_Intimate: 'Интимный',
      ac_Glasses: 'Очки', ac_Choker: 'Чокер', ac_Ribbon: 'Лента', ac_Earrings: 'Серьги',
      ax_Shibari: 'Шибари', ax_Bondage: 'Бондаж', ax_Gag: 'Кляп', ax_Stockings: 'Чулки', ax_Gloves: 'Перчатки',
      e_Ears: 'Ушки', e_Neck: 'Шея', e_Chest: 'Грудь', e_Nipples: 'Соски', e_Thighs: 'Бёдра', e_Feet: 'Ступни',
      e_Pussy: 'Киска', e_Ass: 'Попка', e_Mouth: 'Ротик',
      'bm_Split Tongue': 'Сплит языка', 'bm_Nipple Holes': 'Отверстия в сосках', 'bm_Rubber Skin': 'Резиновая кожа',
      'bm_Brand Mark': 'Клеймо', 'bm_Long Tongue': 'Удлинённый язык',
      'bm_Puffy Nipples': 'Пухлые соски', 'bm_Enlarged Clit': 'Увеличенный клитор', 'bm_Heart Pupils': 'Зрачки-сердечки',
      bm_Fangs: 'Клыки', bm_Claws: 'Когти', 'bm_Doll Joints': 'Кукольные шарниры',
      'i_Cyber Eyes': 'Кибер-глаза', 'i_Cyber Arms': 'Кибер-руки', 'i_Cyber Legs': 'Кибер-ноги',
      'i_Neural Port': 'Нейропорт', 'i_Cable Tail': 'Хвост-кабель', 'i_Glowing Circuits': 'Светящиеся схемы',
      aw_full: 'Полное осознание', aw_feels: 'Чувствует, не понимает', aw_rewrite: 'Переписывание реальности',
      s_awareness: 'ГИПНОЗ',
      ui_aware_note: 'Как субъект переживает изменения. Полное осознание: видит и понимает, что его меняет устройство (полный урон психике). Чувствует: ощущает изменения, но не причину (×0.8). Переписывание: всегда так было, никто не замечает (×0.5 — мягче всего).',
      s_gender: 'ПОЛ', s_physique: 'ХАРАКТЕРИСТИКИ', s_bodypresets: 'ПРЕСЕТЫ ТЕЛА', s_features: 'ОСОБЕННОСТИ',
      s_wardrobe: 'ГАРДЕРОБ', s_appearance: 'ВНЕШНОСТЬ', s_tattoos: 'ТАТУ', s_piercings: 'ПИРСИНГ',
      s_accessories: 'АКСЕССУАРЫ', s_scale: 'МАСШТАБ',
      s_matrix: 'МАТРИЦА ЛИЧНОСТИ', s_control: 'МОДУЛИ КОНТРОЛЯ',
      s_sense: 'БЛОКИРОВКА ЧУВСТВ', s_pulse: 'ИМПУЛЬС ЭМОЦИЙ — РАЗОВЫЙ', s_speech: 'РЕЧЬ', s_memory: 'ПАМЯТЬ',
      s_mindpresets: 'ПРЕСЕТЫ ЛИЧНОСТИ', s_xproto: '🔞 ЭРО-ПРОТОКОЛЫ', s_deepmods: 'ГЛУБОКИЕ МОДИФИКАЦИИ',
      s_kinks: 'ВНУШЁННЫЕ КИНКИ', s_erozones: 'ЭРОГЕННЫЕ ЗОНЫ', s_breeding: 'РЕПРОДУКТИВНЫЕ ПРОТОКОЛЫ',
      s_conjure: '🪄 МАТЕРИАЛИЗАЦИЯ', s_conjure_toys: 'ИГРУШКИ', s_conjure_beings: 'СУЩЕСТВА',
      cj_Vibrator: 'Вибратор', cj_Dildo: 'Фаллоимитатор', 'cj_Vibrating Egg': 'Вибро-яйцо', cj_Cuffs: 'Наручники', cj_Ropes: 'Верёвки',
      'cj_Collar & Leash': 'Ошейник с поводком', cj_Gag: 'Кляп', cj_Blindfold: 'Повязка на глаза', 'cj_Fucking Machine': 'Секс-машина', cj_Pump: 'Помпа',
      cj_Tentacles: 'Щупальца', 'cj_Slime Monster': 'Слизь-монстр', 'cj_Ghostly Hands': 'Призрачные руки', 'cj_Living Chains': 'Живые цепи',
      s_stats: 'ИНТИМ-ТЕЛЕМЕТРИЯ',
      s_limbs: 'КОНФИГУРАЦИЯ КОНЕЧНОСТЕЙ', s_bodymods: 'БОДИ-МОДИФИКАЦИИ', s_implants: 'КИБЕР-ИМПЛАНТЫ', s_race: 'РАСА',
      s_frame: 'КАРКАС ТЕЛА',
      s_device: 'НАСТРОЙКИ УСТРОЙСТВА', s_maint: 'ОБСЛУЖИВАНИЕ', s_history: 'ИСТОРИЯ ВЕРСИЙ',
      s_subjects: 'ПОДКЛЮЧЁННЫЕ СУБЪЕКТЫ', s_branches: 'ЭКСПЕРИМЕНТАЛЬНЫЕ МОДУЛИ',
      g_intellect: 'ИНТЕЛЛЕКТ', g_emotions: 'ЭМОЦИИ', g_social: 'СОЦИАЛЬНОЕ', g_will: 'ВОЛЯ', g_attitude: 'ОТНОШЕНИЕ',
      ui_subject: 'СУБЪЕКТ', ui_firmware: 'прошивка', ui_link: 'связь активна',
      ui_psyche: 'ЦЕЛОСТНОСТЬ ПСИХИКИ', ui_apply: 'ПРИМЕНИТЬ',
      ui_tab_body: 'ТЕЛО', ui_tab_mind: 'РАЗУМ', ui_tab_extreme: '🔞 ЭРО', ui_tab_bio: '🧬 БИО', ui_tab_sys: 'СИСТ',
      ui_sense_note: 'Заблокированные чувства отключены, пока их не вернуть.',
      ui_pulse_note: 'Сработает один раз при следующем ПРИМЕНИТЬ и угаснет.',
      ui_preset_note: 'Пресет заполняет параметры — проверь и нажми ПРИМЕНИТЬ.',
      ui_x_note: 'Неофициальные модули прошивки. Используй ответственно. Или нет.',
      ui_bio_note: 'Протоколы плетения плоти. Изменения здесь тяжело бьют по психике.',
      ui_kinks_note: 'Каждый кинк — уровень тяги: 0 = не знакома, через интерес и нужду, до 100 = полная зависимость.',
      ui_conjure_note: 'Материализуй предметы и существ в сцену из ниоткуда, нацелено на выбранного субъекта. Остаются, пока не убрать.',
      ui_limbs_note: 'Конечности можно убрать в НОЛЬ. Полная беспомощность — допустимая конфигурация.',
      ui_stat_forced: 'Принудительных финишей', ui_stat_denied: 'Сообщений под запретом',
      ui_race_note: 'Перезапись вида на уровне генома. Тело перестраивается под новую расу.',
      ui_gradual: 'Постепенный режим', ui_botaccess: 'Доступ для бота', ui_botunlock: 'Бот открывает разделы', ui_selfedit: 'Редактирование себя',
      ui_settings_note: 'Постепенный: изменения растягиваются на несколько ответов (мягче для психики). Доступ для бота: ИИ может управлять устройством из истории — в том числе направить его на ТЕБЯ; он видит только параметры открытых веток. Бот открывает разделы: ИИ может сам разблокировать скрытые ветки 🔞/🧬 — иначе для него их не существует. Редактирование себя: позволяет менять свой профиль, когда он появится. Гипноз настраивается у каждого субъекта на вкладке РАЗУМ.',
      ui_recovery: 'Восстановление психики', ui_language: 'Язык / Language',
      ui_uiscale: 'Размер интерфейса',
      ui_theme: 'ТЕМА', ui_theme_dark: 'Тёмная', ui_theme_light: 'Светлая',
      ui_rec_Off: 'Выкл', ui_rec_Slow: 'Медленно', ui_rec_Normal: 'Средне', ui_rec_Fast: 'Быстро',
      ui_unlock_x: 'ОТКРЫТЬ ЭРО-МОДУЛЬ 🔞', ui_hide_x: 'СКРЫТЬ ЭРО-МОДУЛЬ',
      ui_unlock_b: 'ОТКРЫТЬ БИО-ЛАБ 🧬', ui_hide_b: 'СКРЫТЬ БИО-ЛАБ',
      ui_sure_x: 'Разблокировать экстрим-протоколы? Гарантия на эти модули не распространяется.',
      ui_sure_b: 'Разблокировать BIO-LAB? Модификации плоти — необратимая нагрузка на психику.',
      ui_yes: 'Я УВЕРЕН/А', ui_no: 'ОТМЕНА',
      ui_18plus: 'Продолжая, вы подтверждаете, что вам исполнилось 18 лет.',
      ui_reset: 'СБРОС К ОРИГИНАЛУ', ui_factory: 'ПОЛНЫЙ СБРОС',
      ui_rollback: 'ОТКАТ', ui_current: 'ТЕКУЩАЯ', ui_nohist: 'Патчи ещё не применялись.',
      ui_invert: 'Полная инверсия', ui_random: '???',
      ui_nopending: 'НЕТ НЕСОХРАНЁННЫХ ИЗМЕНЕНИЙ', ui_deployed: 'ПАТЧ {0} ПРИМЕНЁН', ui_rolledback: 'ОТКАТ ВЫПОЛНЕН — {0}',
      ui_presetloaded: 'ПРЕСЕТ «{0}» — ПРОВЕРЬ И ПРИМЕНИ',
      ui_xunlocked: '🔞 ЭКСТРИМ-ПРОТОКОЛЫ ОТКРЫТЫ', ui_xhidden: 'ЭКСТРИМ-ПРОТОКОЛЫ СКРЫТЫ',
      ui_bunlocked: '🧬 BIO-LAB ОТКРЫТА', ui_bhidden: 'BIO-LAB СКРЫТА',
      ui_remote: 'Удалённое обновление (из истории)', ui_remoteflash: '⚡ ПОЛУЧЕН УДАЛЁННЫЙ ПАТЧ {0}',
      ui_factory_q: 'MindWare: стереть ВСЕ данные для этого чата и отключиться?',
      ui_custom_ph: 'Своя директива… (уйдёт с ПРИМЕНИТЬ)',
      ui_mem_ph: 'Вживить воспоминание… (уйдёт с ПРИМЕНИТЬ)',
      ui_discard: 'Отменить все несохранённые изменения',
      ui_discarded: 'ИЗМЕНЕНИЯ ОТМЕНЕНЫ',
      ui_calib_title: 'Режим калибровки — правка истинной базы',
      ui_setbaseline: 'ЗАПИСАТЬ КАК ИСТИНУ', ui_calibrated: 'БАЗА ОТКАЛИБРОВАНА',
      ui_calib_on: 'КАЛИБРОВКА — правишь истинную личность; боту это НЕ сообщается',
      ui_tap_edit: 'Нажми, чтобы ввести точное значение',
      ui_instapreg: 'МГНОВЕННАЯ БЕРЕМЕННОСТЬ',
      ui_instapreg_note: 'Разовое: сработает при ПРИМЕНИТЬ. Зачатие не требуется — что именно растёт внутри, устройство решит само.',
      ui_chaos: '🎲 ХАОС ВНЕДРЁН — ПРОВЕРЬ И ПРИМЕНИ',
      ui_dice_hint: 'ОТКРОЙ ТЕЛО / РАЗУМ / ЭРО / БИО ДЛЯ БРОСКА',
      ui_timeline: '⏪ СИНХРОН С ЧАТОМ — ВОЗВРАТ {0}',
      ui_psysys: 'Система психики', ui_glitchfx: 'Глитч-эффекты', ui_thoughts: 'Мысли персонажа',
      ui_corruptsys: 'Метр развращения', ui_corruption: 'Развращённость',
      ui_corruption_note: 'Растёт сама с каждым актом. Тащи, чтобы выставить или сбросить вручную.',
      s_thoughts: 'МЫСЛИ', ui_thoughts_note: 'Добавляет внутренний монолог персонажа в каждый ответ — оформленной вставкой прямо в посте. Генерируется вместе с ответом, лишних запросов и токенов не тратит.',
      ui_autochaos: 'Генератор хаоса', ui_everyN: 'каждые {0} сообщ.',
      ui_autochaos_note: '🎲 Спонтанная мутация',
      ui_chaosfired: '🎲 СПОНТАННАЯ МУТАЦИЯ — {0}',
      ui_extra_note: 'Система психики: урон, восстановление и майндбрейк (выкл = чистая песочница). Глитч-эффекты: помехи интерфейса при психике в минусе. Метр развращения: ИИ помечает каждый акт, и тон персонажа становится всё более развратным. Генератор хаоса: каждые N сообщений устройство само мутирует случайного субъекта.',
      ui_newsubject: '⚠ ОБНАРУЖЕН НОВЫЙ СУБЪЕКТ', ui_acquired: 'НЕЙРОСВЯЗЬ УСТАНОВЛЕНА',
      ui_collapse: '☠ КРИТИЧЕСКОЕ: коллапс психики — автоматический Майндбрейк',
      ui_integritylost: '☠ ЦЕЛОСТНОСТЬ СУБЪЕКТА УТРАЧЕНА',
      ui_ro_note: 'Только просмотр: этот субъект — ты. Включи «Редактирование себя» в СИСТ, чтобы перехватить контроль.',
      ui_addsubj: 'НОВЫЙ СУБЪЕКТ', ui_add_self: 'Подключить себя', ui_scan_scene: 'Сканировать сцену',
      ui_cancel: 'Отмена', ui_back: 'НАЗАД', ui_close: 'Закрыть', ui_enable: 'Включить MindWare',
      ui_subj_max: 'Достигнут предел субъектов (макс. 5).', ui_subj_warn: 'Больше 3 субъектов может вызывать ошибки или тормоза. Всё равно добавить?',
      ui_scene_pick: 'ОБНАРУЖЕНЫ В СЦЕНЕ', ui_scene_none: 'Других субъектов в сцене не найдено.',
      ui_subj_linked: 'СУБЪЕКТ ПОДКЛЮЧЁН: {0}',
      ui_unlink: 'ОТКЛЮЧИТЬ', ui_resetsub: 'СБРОС',
      hist_subreset: '{0}: сброс к оригиналу',
      d_custom: 'Своя директива',
      sy_sub: 'Обнаружен нейроинтерфейс.<br>Субъект ещё не привязан к устройству.',
      sy_btn: 'СИНХРОНИЗАЦИЯ ПЕРСОНАЖА', sy_err: 'АНАЛИЗ НЕ УДАЛСЯ. Проверь подключение к API и повтори.',
      sy_nochar: 'СУБЪЕКТ НЕ НАЙДЕН. Сначала открой чат с персонажем.',
      sy_target: 'ЦЕЛЬ', sy_done: 'СВЯЗЬ УСТАНОВЛЕНА',
      sy_npc: 'NPC из сцены', sy_group: 'Групповая сцена — выбери персонажа для привязки:',
      boot_lines: ['установка нейросвязи…', 'рукопожатие: принято', 'загрузка кортикальной карты…', 'целостность связи: 98.7%'],
      scan_lines: ['разбор матрицы личности…', 'построение схемы тела…', 'индексация памяти…', 'калибровка базовой психики…', 'компиляция параметров…'],
      scene_lines: ['сканирование сцены…', 'подсчёт сердцебиений…', 'выделение нейросигнатур…'],
      persona_lines: ['чтение отпечатка персоны…', 'построение схемы тела…', 'калибровка базовой психики…'],
      hist_baseline: 'Базовая синхронизация', hist_rb_orig: 'Откат к оригиналу (v1.0)', hist_rb: 'Откат к {0}',
      d_memrestored: 'Память восстановлена', d_memwiped: 'Память стёрта', d_memimplant: 'Вживлено воспоминание',
      d_instapreg: 'Мгновенная беременность',
      d_kink: 'Внушён кинк', d_kinkrm: 'Кинк снят',
      d_tat: 'Тату', d_tatrm: 'Тату сведено',
      d_pierce: 'Пирсинг', d_piercerm: 'Пирсинг снят',
      d_acc: 'Аксессуар', d_accrm: 'Аксессуар снят',
      d_ero: 'Эрогенная зона', d_erorm: 'Зона нормализована',
      d_conjure: 'Материализовано', d_conjurerm: 'Развеяно',
      d_mod: 'Боди-мод', d_modrm: 'Боди-мод убран',
      d_imp: 'Имплант установлен', d_imprm: 'Имплант удалён',
      d_enabled: 'добавлено', d_removed: 'убрано', d_sdisabled: 'чувство отключено', d_srestored: 'чувство возвращено',
      d_was: 'было', d_pulse: 'Импульс эмоции',
      o_gender_Female: 'Женский', o_gender_Male: 'Мужской', o_gender_Androgynous: 'Андрогин',
      o_scale_Doll: 'Кукольный', o_scale_Normal: 'Обычный', o_scale_Giant: 'Гигант',
      o_body_type_Petite: 'Миниатюрная', o_body_type_Slim: 'Стройная', o_body_type_Athletic: 'Атлетичная',
      o_body_type_Curvy: 'Фигуристая', o_body_type_Voluptuous: 'Пышная', o_body_type_Plush: 'Мягкая', o_body_type_Muscular: 'Мускулистая',
      o_eye_color_Brown: 'Карие', o_eye_color_Blue: 'Голубые', o_eye_color_Green: 'Зелёные', o_eye_color_Gray: 'Серые',
      o_eye_color_Hazel: 'Ореховые', o_eye_color_Amber: 'Янтарные', o_eye_color_Red: 'Красные', o_eye_color_Violet: 'Фиолетовые',
      o_eye_color_Pink: 'Розовые', o_eye_color_Heterochromia: 'Гетерохромия',
      o_hair_color_Black: 'Чёрные', o_hair_color_Brown: 'Каштановые', o_hair_color_Blonde: 'Блонд', o_hair_color_Red: 'Рыжие',
      o_hair_color_Auburn: 'Тёмно-рыжие', o_hair_color_White: 'Белые', o_hair_color_Silver: 'Серебряные', o_hair_color_Pink: 'Розовые',
      'o_hair_color_Pastel Pink': 'Пастельно-розовые', o_hair_color_Blue: 'Синие', o_hair_color_Purple: 'Фиолетовые',
      o_hair_color_Lilac: 'Лиловые', o_hair_color_Mint: 'Мятные', o_hair_color_Green: 'Зелёные',
      o_hair_color_Ombre: 'Омбре', 'o_hair_color_Two-Tone': 'Двухцветные', o_hair_color_Streaked: 'Мелированные',
      o_hair_style_Loose: 'Распущенные', o_hair_style_Ponytail: 'Хвост', o_hair_style_Twintails: 'Два хвостика',
      o_hair_style_Braids: 'Косы', o_hair_style_Bun: 'Пучок', o_hair_style_Bob: 'Каре', o_hair_style_Pixie: 'Пикси',
      o_hair_style_Wavy: 'Волнистые', o_hair_style_Curly: 'Кудрявые',
      o_skin_tone_Porcelain: 'Фарфоровая', o_skin_tone_Fair: 'Светлая', o_skin_tone_Tanned: 'Загорелая',
      o_skin_tone_Olive: 'Оливковая', o_skin_tone_Brown: 'Смуглая', o_skin_tone_Ebony: 'Тёмная',
      o_skin_tone_Ashen: 'Пепельная', o_skin_tone_Unnatural: 'Неестественная',
      o_feature_type_None: 'Нет', o_feature_type_Cat: 'Кошачьи', o_feature_type_Fox: 'Лисьи', o_feature_type_Wolf: 'Волчьи',
      o_feature_type_Bunny: 'Кроличьи', o_feature_type_Mouse: 'Мышиные', o_feature_type_Cow: 'Коровьи', o_feature_type_Dragon: 'Драконьи',
      o_outfit_Default: 'По умолчанию',
      o_outfit_Casual: 'Повседневное', o_outfit_Business: 'Деловой костюм', o_outfit_Sportswear: 'Спортивное',
      o_outfit_Dress: 'Платье', 'o_outfit_Gothic Lolita': 'Готик-лолита', 'o_outfit_Maid Uniform': 'Форма горничной',
      'o_outfit_School Uniform': 'Школьная форма', o_outfit_Nurse: 'Медсестра', o_outfit_Military: 'Военная форма',
      'o_outfit_Wedding Dress': 'Свадебное платье', o_outfit_Swimsuit: 'Купальник', o_outfit_Cheerleader: 'Чирлидерша',
      'o_outfit_E-girl': 'E-girl', o_outfit_Coat: 'Пальто', 'o_outfit_Long Shirt': 'Длинная рубашка',
      'o_outfit_Jester Costume': 'Костюм шута',
      'o_outfit_Lace Lingerie': 'Кружевное бельё', 'o_outfit_Latex Catsuit': 'Латексный кэтсьют',
      'o_outfit_Bunny Suit': 'Костюм зайки', 'o_outfit_Micro Bikini': 'Микро-бикини', o_outfit_Sheer: 'Прозрачное',
      o_outfit_Nothing: 'Ничего',
      o_speech_pattern_Original: 'Исходная', o_speech_pattern_Formal: 'Формальная', o_speech_pattern_Cutesy: 'Милая',
      o_speech_pattern_Rude: 'Грубая', o_speech_pattern_Stuttering: 'Заикание', o_speech_pattern_Purring: 'Мурлыканье',
      o_speech_pattern_Robotic: 'Роботизированная', o_speech_pattern_Seductive: 'Соблазнительная', o_speech_pattern_Archaic: 'Архаичная',
      o_memory_wipe_None: 'Нет', 'o_memory_wipe_Last Scene': 'Последняя сцена', 'o_memory_wipe_Recent Events': 'Недавние события',
      'o_memory_wipe_All About {{user}}': 'Всё о {{user}}', 'o_memory_wipe_Total Amnesia': 'Полная амнезия',
      o_gestation_Normal: 'Обычная', o_gestation_Accelerated: 'Ускоренная (дни)', o_gestation_Rapid: 'Стремительная (часы)',
      o_orientation_Straight: 'Гетеро', o_orientation_Bisexual: 'Би', o_orientation_Gay: 'Гомо',
      o_orientation_Asexual: 'Асексуал', o_orientation_Pansexual: 'Пансексуал',
      o_race_Human: 'Человек', o_race_Elf: 'Эльф', o_race_Vampire: 'Вампир', o_race_Tabaxi: 'Табакси',
      o_race_Cowgirl: 'Коровка', o_race_Succubus: 'Суккуб', o_race_Orc: 'Орк', o_race_Slime: 'Слизь',
      o_race_Angel: 'Ангел', o_race_Demon: 'Демон', o_race_Clone: 'Клон',
      k_Exhibitionism: 'Эксгибиционизм', k_Oral: 'Минет', k_Anal: 'Анал', k_NTR: 'НТР', k_Group: 'Группа',
      k_Creampie: 'Кримпай', k_Toys: 'Игрушки', 'k_Dirty Talk': 'Грязные разговоры', k_Public: 'Публичность',
      pu_Fear: 'Страх', pu_Euphoria: 'Эйфория', pu_Calm: 'Спокойствие', pu_Shame: 'Стыд',
      pu_Tenderness: 'Нежность', pu_Anger: 'Гнев', pu_Lust: 'Похоть', pu_Climax: 'Финиш',
      pr_Catgirl: 'Кошкодевочка', pr_Bimbo: 'Бимбо', pr_Yandere: 'Яндере', 'pr_Perfect Maid': 'Идеальная горничная',
      pr_Tsundere: 'Цундере', 'pr_Mafia Boss': 'Босс мафии', pr_Kuudere: 'Кудере',
      'pr_Femme Fatale': 'Роковая женщина', 'pr_Strict Teacher': 'Строгая училка', pr_Feral: 'Дикарка',
      pr_Petite: 'Миниатюрная', pr_Amazon: 'Амазонка', pr_Athlete: 'Атлетка', pr_Gyaru: 'Гяру', 'pr_E-girl': 'E-girl',
      pr_Twink: 'Твинк', pr_Jock: 'Качок', pr_Bear: 'Медведь', pr_Bishonen: 'Бисёнэн',
      // --- v3.0 param labels ---
      p_eye_type: 'Тип глаз', p_hair_texture: 'Текстура волос', p_resting_face: 'Выражение лица', p_makeup: 'Макияж', p_wear_tear: 'Степень износа',
      p_personality: 'Личность', p_charisma: 'Харизма', p_morality: 'Мораль', p_self_esteem: 'Самооценка',
      p_user_dependency: 'Зависимость от {{user}}', p_perception_filter: 'Восприятие {{user}}', p_role_position: 'Роль к {{user}}',
      p_ahegao: 'Ахегао-рефлекс',
      s_core: 'ОСНОВА ЛИЧНОСТИ',
      // --- tiers ---
      mo_Puritan: 'Пуританин', mo_Modest: 'Скромная', mo_Open: 'Раскованная', mo_Shameless: 'Бесстыдная', mo_Depraved: 'Развращённая',
      pc_Clear: 'Ясное', pc_Idealization: 'Идеализация', 'pc_Fear/Awe': 'Страх/Трепет', pc_Objectification: 'Объективизация', pc_Obsession: 'Одержимость',
      ro_Dominant: 'Доминирование', ro_Equal: 'Равенство', ro_Submissive: 'Подчинение', ro_Servant: 'Служение',
      es_Low: 'Низкая', es_Unstable: 'Нестабильная', es_High: 'Высокая',
      ki_Unaware: 'Не знакома', ki_Curious: 'Интересуется', ki_Needy: 'Нужда', ki_Addicted: 'Зависимость',
      // --- new appearance options ---
      o_hair_color_Blonde: 'Блонд', o_hair_color_Brown: 'Каштановые', o_hair_color_Ginger: 'Рыжие', o_hair_color_Black: 'Чёрные',
      o_hair_color_Gray: 'Серые', o_hair_color_White: 'Белые', o_hair_color_Red: 'Красные', o_hair_color_Green: 'Зелёные',
      o_hair_color_Blue: 'Синие', o_hair_color_Yellow: 'Жёлтые', o_hair_color_Pink: 'Розовые', o_hair_color_Purple: 'Фиолетовые',
      o_hair_color_Multicolored: 'Разноцветные', o_hair_color_None: 'Нет',
      o_hair_style_Loose: 'Распущенные', o_hair_style_Ponytail: 'Хвостик', o_hair_style_Twintails: 'Два хвостика', o_hair_style_Braids: 'Косички',
      o_hair_style_Bun: 'Пучок', o_hair_style_Bob: 'Каре', o_hair_style_Short: 'Короткие', o_hair_style_Wavy: 'Волнистые',
      o_hair_style_Dreadlocks: 'Дреды', o_hair_style_None: 'Нет',
      o_eye_type_Normal: 'Обычные', 'o_eye_type_Anime Gradient': 'Аниме-градиент', o_eye_type_Spirals: 'Спирали', o_eye_type_Hearts: 'Сердечки',
      o_eye_type_Stars: 'Звёзды', o_eye_type_Empty: 'Пустой взгляд', o_eye_type_Cat: 'Кошачьи', o_eye_type_Glowing: 'Светящиеся',
      o_hair_texture_Straight: 'Прямые', o_hair_texture_Wavy: 'Волнистые', o_hair_texture_Curly: 'Кудрявые', o_hair_texture_Fluffy: 'Пушистые', o_hair_texture_Coarse: 'Жёсткие',
      o_resting_face_Calm: 'Спокойное', 'o_resting_face_Doll Smile': 'Кукольная улыбка', o_resting_face_Tired: 'Уставшее', o_resting_face_Haughty: 'Надменное',
      'o_resting_face_Frozen Fear': 'Застывший страх', 'o_resting_face_Artificial Joy': 'Искусственная радость',
      o_makeup_None: 'Нет', o_makeup_Natural: 'Естественный', 'o_makeup_Bold Evening': 'Яркий вечерний', o_makeup_Gothic: 'Готический',
      o_makeup_Gyaru: 'Гяру', 'o_makeup_Tear-stained': 'Заплаканный', o_makeup_Smudged: 'Размазанный',
      // --- speech additions ---
      o_speech_pattern_Emotionless: 'Безэмоциональная', 'o_speech_pattern_Only Moans': 'Только стоны', 'o_speech_pattern_Baby Talk': 'Лепет', o_speech_pattern_Broken: 'Сломанная',
      // --- new kinks ---
      k_Corruption: 'Развращение', 'k_Pet Play': 'Петплей', 'k_Self-Objectification': 'Объектификация (себя)', k_Bondage: 'Бондаж',
      k_Choking: 'Удушение', k_Roleplay: 'Ролеплей', 'k_Foot Fetish': 'Футфетиш', k_Smells: 'Запахи', k_Impregnation: 'Оплодотворение',
      // --- new body mods ---
      'bm_Transparent Womb': 'Прозрачный живот', 'bm_Temperature Shift': 'Жар тела', 'bm_Detachable Limbs': 'Отстёгиваемые конечности',
    },
  };

  let L = LANGS.en;

  function detectLang() {
    const ovr = state.settings && state.settings.lang;
    if (ovr === 'en') { L = LANGS.en; return; }
    if (ovr === 'ru') { L = LANGS.ru; return; }
    let lang = '';
    try { lang = W.localStorage.getItem('language') || ''; } catch (e) { /* ignore */ }
    if (!lang) lang = (W.navigator && W.navigator.language) || '';
    L = String(lang).toLowerCase().startsWith('ru') ? LANGS.ru : LANGS.en;
  }

  function t(key) { return L[key] !== undefined ? L[key] : (LANGS.en[key] !== undefined ? LANGS.en[key] : key); }
  function tf(key, v) { return String(t(key)).replace('{0}', v); }
  function tOpt(selKey, opt) {
    const k = 'o_' + selKey + '_' + opt;
    return mac(L[k] !== undefined ? L[k] : (LANGS.en[k] !== undefined ? LANGS.en[k] : opt));
  }
  function pLabel(key) {
    if (KINK_KEY2NAME[key]) return mac(t('k_' + KINK_KEY2NAME[key]));
    // "attitude" is shown toward the chosen target (default: char→user, user→char)
    if (key === 'affection') return mac(t('p_affection_base')) + ' (' + affTargetName(subj()) + ')';
    return mac(t('p_' + key));
  }
  // English label for the AI command (kink keys map to their kink name)
  function enLabel(key) {
    if (KINK_KEY2NAME[key]) return LANGS.en['k_' + KINK_KEY2NAME[key]] + ' kink';
    return LANGS.en['p_' + key];
  }

  /* ================= STATE ================= */

  function defaults() {
    const o = {};
    SLIDERS.forEach(([, k, min, max]) => { o[k] = Math.round((min + max) / 2); });
    TOGGLES.forEach(([, k]) => { o[k] = false; });
    SELECTS.forEach(([, k, opts]) => { o[k] = opts[0]; });
    SELECTS.forEach(([, k]) => { if (k === 'scale') o[k] = 'Normal'; });
    CHIP_GROUPS.forEach(([k]) => { o[k] = []; });
    Object.entries(DEFAULT_OVERRIDES).forEach(([k, v]) => { o[k] = v; });
    o.height = 165;
    return o;
  }

  function freshStats() { return { forced: 0, denied: 0 }; }

  function freshState() {
    return {
      schema: 4,
      synced: false,
      charName: '',
      charBlind: false, // char baseline not analyzed yet (self/NPC was linked first)
      original: null,
      applied: null,
      draft: null,
      awareness: 'full',
      stats: freshStats(),
      pulse: null,   // { sid, p }
      custom: '',
      memo: null,    // { sid, text } — pending memory implant
      instaPreg: null, // sid armed for instant pregnancy one-shot
      psyche: 100,
      collapsed: false,
      corruption: 0,
      version: 10,
      history: [],
      subjects: [],  // { id, kind:'user'|'npc', name, original, applied, draft, psyche, collapsed, corruption, awareness, stats }
      selSubj: 'char',
      chaosIn: 0,
      settings: { gradual: false, recovery: 'Normal', extreme: false, biolab: false, botAccess: false, botUnlock: false, selfEdit: false, lang: 'auto', psyche: true, glitch: true, autoChaos: 0, thoughts: true, corruption: false },
    };
  }

  let state = freshState();
  let booted = false;
  let activeTab = 'body';
  let calibrating = false; // baseline-edit mode (footer toggle, not persisted)
  let panelOpen = false;
  let saveTimer = null;

  function clone(x) { return JSON.parse(JSON.stringify(x)); }
  function slugify(s) { return String(s).toLowerCase().replace(/[^a-z0-9а-яё]+/gi, '_').slice(0, 16); }
  function lastMsgId() {
    try { const m = getChatMessages(-1)[0]; return m ? m.message_id : -1; } catch (e) { return -1; }
  }

  /* ----- subjects: the char (state itself) + extra linked subjects ----- */

  function allRefs() { return [state].concat(state.subjects || []); }
  function sidOf(ref) { return ref === state ? 'char' : ref.id; }
  function refOf(sid) { return sid === 'char' ? state : ((state.subjects || []).find(s => s.id === sid) || state); }
  // use the literal synced name (not {{char}}/{{user}}) — robust in GROUP chats
  // where {{char}} resolves to the current speaker, not our target subject
  function subjMacro(ref) { return ref === state ? (state.charName || '{{char}}') : ref.name; }
  function subjName(ref) { return ref === state ? (state.charName || 'CHAR') : ref.name; }

  // whom a subject's "attitude" points at (token: 'user' | 'char' | subjectId)
  function affTargetTok(ref) {
    if (ref.affTarget) return ref.affTarget;
    return (ref !== state && ref.kind === 'user') ? 'char' : 'user';
  }
  function affTargetMacro(ref) {
    const tok = affTargetTok(ref);
    if (tok === 'user') return '{{user}}';
    if (tok === 'char') return state.charName || '{{char}}';
    const r = refOf(tok); return (r && r !== state) ? r.name : (state.charName || '{{char}}');
  }
  function affTargetName(ref) {
    const tok = affTargetTok(ref);
    if (tok === 'user') return mac('{{user}}') || 'user';
    if (tok === 'char') return subjName(state);
    const r = refOf(tok); return r ? subjName(r) : subjName(state);
  }
  function subj() { return refOf(state.selSubj); }
  function isEditable(ref) { return ref === state || ref.kind === 'npc' || state.settings.selfEdit; }
  // the user subject tied to the CURRENTLY active persona (legacy ones with no
  // persona field match any, preserving single-user behaviour in old chats)
  function findUserSubj() {
    const av = user_avatar || 'default';
    return (state.subjects || []).find(s => s.kind === 'user' && (!s.persona || s.persona === av));
  }
  function heightRange(set) { return SCALE_RANGES[(set && set.scale) || 'Normal'] || SCALE_RANGES.Normal; }

  // per-parameter-set migration: legacy scales + renames + backfill new keys
  function migrate(o) {
    if (!o) return;
    if (typeof o.bust === 'number' && o.bust > CUPS.length - 1) {
      o.bust = Math.round(o.bust / 100 * (CUPS.length - 1));
    }
    if (typeof o.weight === 'number' && o.weight > 100) o.weight = 100;
    if (typeof o.tattoos === 'string') o.tattoos = o.tattoos === 'None' ? [] : ['Arms'];
    // v2.0: piercings select -> zone chips
    if (typeof o.piercings === 'string') {
      const map = { 'None': [], 'Ears Only': ['Ears'], 'Face': ['Nose', 'Eyebrow'], 'Several': ['Ears', 'Navel'], 'Many': ['Ears', 'Nose', 'Tongue', 'Navel'] };
      o.piercings = map[o.piercings] || [];
    }
    // v2.0: free use -> slut mode, anomalies/extras retired
    if (o.free_use !== undefined && o.slut_mode === undefined) o.slut_mode = !!o.free_use;
    if (typeof o.outfit === 'string' && !OUTFITS.includes(o.outfit)) {
      o.outfit = o.outfit === 'Lingerie Only' ? 'Lace Lingerie' : 'Default';
    }
    // v1.0: kinks array -> per-kink progression sliders (had it = "Needy")
    if (Array.isArray(o.kinks)) { o.kinks.forEach(n => { o[kinkKey(n)] = 70; }); delete o.kinks; }
    ['stamina', 'corruption', 'edging', 'free_use', 'loyalty_lock', 'tentacles', 'monstrosity',
      'egg_laying', 'pregnancy', 'skin_material', 'anomalies'].forEach(k => { delete o[k]; });
    const d = defaults();
    Object.keys(d).forEach(k => { if (o[k] === undefined) o[k] = clone(d[k]); });
    CHIP_GROUPS.forEach(([k, list]) => { if (Array.isArray(o[k])) o[k] = o[k].filter(x => list.includes(x)); });
  }

  function migrateRef(ref) {
    if (!ref) return;
    if (!AWARE_MODES.includes(ref.awareness)) ref.awareness = 'full';
    if (!ref.stats) ref.stats = freshStats();
    if (typeof ref.corruption !== 'number') ref.corruption = 0;
    if (ref !== state && ref.kind === 'user' && !ref.name) ref.name = mac('{{user}}') || 'USER';
    // collapse threshold moved from 0 to -100; clear stale flags
    if (ref.psyche > PSY_MIN) ref.collapsed = false;
    [ref.original, ref.applied, ref.draft].forEach(migrate);
  }

  function loadState() {
    try {
      const vars = getVariables({ type: 'chat' }) || {};
      const s = vars[VAR_KEY];
      if (s && s.original) {
        const f = freshState();
        state = Object.assign(f, s);
        state.settings = Object.assign(freshState().settings, s.settings || {});
        state.subjects = state.subjects || [];

        if (!s.schema || s.schema < 2) {
          const remap = o => {
            if (o && typeof o.affection === 'number' && o.affection >= 0 && o.affection <= 100) {
              o.affection = Math.max(-100, Math.min(100, (o.affection - 50) * 2));
            }
          };
          if (typeof state.pulse === 'string') state.pulse = { sid: 'char', p: state.pulse };
          if (state.user) {
            state.subjects.push(Object.assign({ id: 'user', kind: 'user' }, state.user));
            delete state.user;
          }
          [state.original, state.applied, state.draft].forEach(remap);
          state.subjects.forEach(su => [su.original, su.applied, su.draft].forEach(remap));
          (state.history || []).forEach(h => {
            if (!h.snapshot) return;
            if (h.snapshot.c !== undefined) {
              remap(h.snapshot.c);
              if (h.snapshot.u) { h.snapshot.subs = { user: h.snapshot.u }; remap(h.snapshot.u); delete h.snapshot.u; }
            } else remap(h.snapshot);
          });
        }
        state.schema = 4;
        delete state.delayed; // v2.0: delayed patches removed

        migrateRef(state);
        state.subjects.forEach(migrateRef);
        (state.history || []).forEach(h => {
          if (!h.snapshot) return;
          if (h.snapshot.c !== undefined) {
            migrate(h.snapshot.c);
            Object.values(h.snapshot.subs || {}).forEach(migrate);
          } else migrate(h.snapshot);
        });
        if (!refOf(state.selSubj)) state.selSubj = 'char';
      } else {
        state = freshState();
      }
    } catch (e) {
      state = freshState();
    }
    detectLang();
  }

  function save() { clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 300); }
  function saveNow() {
    clearTimeout(saveTimer);
    try {
      updateVariablesWith(vars => { vars[VAR_KEY] = clone(state); return vars; }, { type: 'chat' });
    } catch (e) { console.error('[MindWare] save failed', e); }
  }

  /* ================= TEXT HELPERS ================= */

  function mac(text) {
    try { return substitudeMacros(text); } catch (e) { return text; }
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function sliderDef(key) { return SLIDERS.find(s => s[1] === key); }

  function tierName(v, table) {
    let name = table[0][1];
    table.forEach(([min, n]) => { if (v >= min) name = n; });
    return name;
  }

  function fmtVal(key, v, en) {
    const d = sliderDef(key);
    if (!d) return String(v);
    const kind = d[6];
    if (kind === 'cups') return CUPS[v] || String(v);
    if (kind === 'voice') { const n = tierName(v, VOICE_TIERS); return (en ? n : t('v_' + n)) + ' (' + v + ')'; }
    if (kind === 'lvl') { const n = tierName(v, LVL_TIERS); return (en ? n : t('lv_' + n)) + ' (' + v + ')'; }
    if (kind === 'att') { const n = tierName(v, ATT_TIERS); return (en ? n : t('at_' + n)) + ' (' + v + ')'; }
    if (kind === 'mor') { const n = tierName(v, MOR_TIERS); return (en ? n : t('mo_' + n)) + ' (' + v + ')'; }
    if (kind === 'perc') { const n = tierName(v, PERC_TIERS); return (en ? n : t('pc_' + n)) + ' (' + v + ')'; }
    if (kind === 'role') { const n = tierName(v, ROLE_TIERS); return (en ? n : t('ro_' + n)) + ' (' + v + ')'; }
    if (kind === 'est') { const n = tierName(v, EST_TIERS); return (en ? n : t('es_' + n)) + ' (' + v + ')'; }
    if (kind === 'kink') { const n = tierName(v, KINK_TIERS); return (en ? n : t('ki_' + n)) + ' (' + v + ')'; }
    if (d[4]) return v + d[4];
    return String(v);
  }

  /* ================= DIFF / DAMAGE ================= */

  // → list of {key, note (localized UI), cmd (English for AI), dmg}
  // affMacro: who this subject's affection points at (a macro/name string)
  function computeDiffs(from, to, affMacro) {
    const out = [];
    SLIDERS.forEach(([, key, min, max, , w]) => {
      const a = from[key], b = to[key];
      if (a !== b && b !== undefined) {
        const enL = (key === 'affection' && affMacro) ? `Attitude (toward ${affMacro})` : enLabel(key);
        out.push({
          key,
          note: `${pLabel(key)}: ${fmtVal(key, b)} (${t('d_was')} ${fmtVal(key, a)})`,
          cmd: `${enL}: ${fmtVal(key, a, true)} -> ${fmtVal(key, b, true)}`,
          dmg: Math.max(1, Math.round(w * Math.abs(b - a) / (max - min))),
        });
      }
    });
    TOGGLES.forEach(([, key, w, group]) => {
      const a = !!from[key], b = !!to[key];
      if (a !== b) {
        const sense = group === 'sense';
        const note = sense
          ? `${pLabel(key)} — ${b ? t('d_sdisabled') : t('d_srestored')}`
          : `${pLabel(key)} — ${b ? t('d_enabled') : t('d_removed')}`;
        const cmd = sense
          ? `${LANGS.en['p_' + key]} sense ${b ? 'disabled' : 'restored'}`
          : `${LANGS.en['p_' + key]} ${b ? 'gained' : 'removed'}`;
        out.push({ key, note, cmd, dmg: b ? w : Math.ceil(w / 2) });
      }
    });
    SELECTS.forEach(([, key, opts, w]) => {
      const a = from[key], b = to[key];
      if (a !== b && b !== undefined) {
        let dmg = Array.isArray(w) ? (w[opts.indexOf(b)] || 0) : w;
        let note, cmd;
        if (key === 'memory_wipe') {
          if (b === 'None') { note = t('d_memrestored'); cmd = 'memories restored'; dmg = 2; }
          else { note = `${t('d_memwiped')}: ${tOpt(key, b)}`; cmd = `memory wiped: ${mac(b)}`; }
        } else if (key === 'outfit') {
          note = `${pLabel(key)}: ${tOpt(key, b)} (${t('d_was')} ${tOpt(key, a)})`;
          cmd = `outfit forcibly rewritten by the device: "${mac(a)}" -> "${mac(b)}" (the old clothes vanish, the new outfit materializes on them mid-scene)`;
        } else {
          note = `${pLabel(key)}: ${tOpt(key, b)} (${t('d_was')} ${tOpt(key, a)})`;
          cmd = `${LANGS.en['p_' + key]}: ${mac(a)} -> ${mac(b)}`;
        }
        out.push({ key, note, cmd, dmg: Math.max(0, dmg) });
      }
    });
    CHIP_GROUPS.forEach(([key, , dmg, addK, rmK, pfx, noun]) => {
      const a = from[key] || [], b = to[key] || [];
      const conj = key === 'conjured';
      b.filter(x => !a.includes(x)).forEach(x =>
        out.push({ key, note: `${t(addK)}: ${t(pfx + x)}`, cmd: conj ? `${x} materializes out of nowhere right now and is present in the scene` : `new ${noun}: ${x}`, dmg }));
      a.filter(x => !b.includes(x)).forEach(x =>
        out.push({ key, note: `${t(rmK)}: ${t(pfx + x)}`, cmd: conj ? `${x} dissolves and vanishes from the scene` : `${noun} removed: ${x}`, dmg: 2 }));
    });
    return out;
  }

  function pendingTotal() {
    if (!state.synced) return 0;
    let n = allRefs().reduce((s, ref) => s + computeDiffs(ref.applied, ref.draft).length, 0);
    if (state.pulse) n += 1;
    if (state.custom.trim()) n += 1;
    if (state.memo && state.memo.text.trim()) n += 1;
    if (state.instaPreg) n += 1;
    return n;
  }

  function psycheTier(p) {
    if (p >= 80) return 'stable';
    if (p >= 50) return 'minor cracks: occasional confusion, brief lapses';
    if (p >= 20) return 'unstable: anxiety, dissociation, identity slips';
    if (p > 0) return 'critical: personality fragmenting, reality blurring';
    if (p > -50) return 'BROKEN (negative integrity): the self is crumbling — derealization, blank stretches, obedience out of sheer exhaustion';
    if (p > -100) return 'DISINTEGRATING: barely any coherent self remains, thoughts arrive pre-broken, resistance is a fading memory';
    return 'SHATTERED at -100%: total mindbreak, the original self is gone';
  }

  /* ================= PROMPT INJECTION (always English) ================= */

  // bot-visible params: only tabs the user has unlocked exist for the AI
  function remoteKeys() {
    const tabs = unlockedTabs();
    return SLIDERS.filter(s => tabs.includes(s[0])).map(s => s[1])
      .concat(TOGGLES.filter(t2 => tabs.includes(t2[0])).map(t2 => t2[1]))
      .concat(SELECTS.filter(s => tabs.includes(s[0])).map(s => s[1]))
      .concat(CHIP_GROUPS.filter(g => tabs.includes(g[7])).map(g => g[0]));
  }

  function awareStateLine(ref) {
    const who = subjMacro(ref);
    if (ref.awareness === 'rewrite') {
      return `${who} is UNAWARE of any modifications; memories quietly rewrite so the current state has "always been so" — nobody in the story notices changes.`;
    }
    if (ref.awareness === 'feels') {
      return `${who} FEELS the modifications happening to their body and mind but cannot comprehend the cause — confusion, dread, denial.`;
    }
    return `${who} is FULLY AWARE that an external device is altering their body and mind, remembers their original self, and experiences every change consciously.`;
  }

  function awareCmdLine(ref) {
    const who = subjMacro(ref);
    if (ref.awareness === 'rewrite') {
      return `For ${who}, do NOT depict any transformation or moment of change: from everyone's perspective the new state has always been true — simply continue the scene with it in place as established fact.`;
    }
    if (ref.awareness === 'feels') {
      return `${who} feels the change happening but cannot understand why — depict the sensation and the confusion vividly.`;
    }
    return `${who} fully understands the device is doing this — depict the transformation and their conscious reaction to it vividly.`;
  }

  function buildStateText() {
    if (!state.synced) return null;
    const sections = [];
    let anyActive = false;
    allRefs().forEach(ref => {
      const diffs = computeDiffs(ref.original, ref.applied, affTargetMacro(ref));
      const active = diffs.length || (state.settings.psyche && ref.psyche < 100);
      if (ref !== state && !active) return;
      if (active) anyActive = true;
      const who = subjMacro(ref);
      let s = `Active modifications of ${who} versus their true self: ${diffs.length ? diffs.map(d => d.cmd).join('; ') : 'none'}.`;
      if (active) {
        if (state.settings.psyche) s += ` ${who} psyche integrity: ${ref.psyche}% (${psycheTier(ref.psyche)}).`;
        s += ' ' + awareStateLine(ref);
        const pv = ref.applied.personality;
        if (typeof pv === 'number' && pv < 100) {
          if (pv <= 0) s += ` ${who}'s original personality is now FULLY ERASED (0%): no traits, opinions, memories of self or will remain — only base instinct, the implanted parameters and obedience drive them; portray a hollow doll, never their old self.`;
          else if (pv < 35) s += ` ${who}'s original personality is largely stripped (${pv}%): suppress their established traits, opinions and history heavily — only faint fragments surface, overridden by the implanted parameters.`;
          else if (pv < 70) s += ` ${who}'s original personality is partly suppressed (${pv}%): their established traits are noticeably muted and easily overridden by the implanted parameters.`;
        }
        if (ref.applied.outfit_lock) {
          s += ` ${who}'s outfit is LOCKED by the device ("${mac(ref.applied.outfit)}"): it cannot be changed, removed or torn by anyone — it always restores itself.`;
        }
        if (ref.applied.orgasm_denial && ref.stats && ref.stats.denied > 0) {
          s += ` (Orgasm has been denied to ${who} for ${ref.stats.denied} messages.)`;
        }
        if (ref.applied.resistance > 30) {
          s += ` ${who} is fighting their own arousal (resistance ${ref.applied.resistance}%): show the war between mind and body — ${ref.applied.resistance > 70 ? 'desperate, anguished denial of what their body screams for' : 'flustered, conflicted reluctance'}.`;
        }
        if (ref.applied.living_clothing) {
          s += ` ${who} wears LIVING smart-fabric: it moves on its own — tightening to punish disobedience, shifting to expose or grope them, reshaping at the device's whim.`;
        }
        if (ref.applied.auto_stim > 0) {
          const zones = ref.applied.erozones || [];
          const zt = zones.length ? ` focused on their ${zones.map(z => mac(t('e_' + z)).toLowerCase()).join(', ')}` : '';
          s += ` The device keeps ${who}'s body under constant autonomous stimulation (intensity ${ref.applied.auto_stim}%)${zt}: relentless waves of pleasure they cannot stop or control, building without release.`;
        }
        if (state.settings.corruption && (ref.corruption || 0) > 0) {
          const cr = ref.corruption;
          const tone = cr < 26 ? 'a faint loosening of inhibitions' :
            cr < 51 ? 'noticeably more open, suggestive and eager language' :
            cr < 76 ? 'lewd, crude wording and creeping objectification; modesty is mostly gone' :
            'fully depraved, shameless, objectified framing — they crave it and revel in it without restraint';
          s += ` ${who} corruption ${cr}%: colour their narration, word choice and reactions with ${tone}.`;
        }
      }
      sections.push(s);
    });
    if (!anyActive && !state.settings.botAccess && !state.settings.thoughts && !state.settings.corruption) return null;
    const lines = [`[MindWare reality-editing console — the operator has rewritten reality itself; the following are now facts of the world, not in-story events — ${sections.join(' ')}`];
    if (state.settings.botAccess) {
      const targets = ['"user"'].concat((state.subjects || []).filter(s => s.kind === 'npc').map(s => '"' + s.name + '"'));
      const unlockNote = state.settings.botUnlock
        ? ' You may also open hidden firmware branches when the story truly demands it by adding "unlock":"extreme" or "unlock":"bio" to the directive (this reveals additional parameters).'
        : '';
      lines.push(`Remote access is enabled: the device may also be operated from within the story (by itself, by characters, or by events). To change parameters narratively, append at the VERY END of your reply, on its own line: <!--mw {"param":value,...}--> (invisible to the user). Add "target":<name> to aim at someone other than {{char}}; valid targets: ${targets.join(', ')}. Valid params: ${remoteKeys().join(',')}. Numbers are 0-100 unless stated (height cm, weight kg max 100, hair_length cm, apparent_age years, affection -100=hatred..100=love, arms/legs/eyes/breasts/members are counts); bust is a cup "AA"-"H"; toggles are booleans; selects use their English option names; array params take arrays of their English item names. You may also apply a whole preset at once with "preset":"Name" (any explicit params override it); available presets: ${Object.keys(MIND_PRESETS).concat(Object.keys(BODY_PRESETS)).join(', ')}. One-shot effects you may trigger in the same directive: "pulse":"<emotion>" floods them with a sudden artificial emotion (one of: ${PULSES.concat(state.settings.extreme ? PULSES_X : []).join(', ')}); "memory":"<text>" implants a false memory that feels entirely real to them; "pregnant":true makes them pregnant on the spot; "awareness":"full"|"feels"|"rewrite" sets how they experience changes (full = consciously aware; feels = senses them but not the cause; rewrite = it has always been so, nobody notices); "reset":true wipes ALL modifications and restores their original self.${unlockNote} Use it only when the story justifies it.`);
    }
    lines.push(`These modifications are ABSOLUTE and already in effect: they override the character card wherever they conflict, and they are NOT optional or contingent on the plot. Even if nothing in the story explains them, treat them as established physical and mental reality and reflect them in the named subject's body, behaviour and speech in EVERY reply — never ignore, downplay, postpone, or wait for narrative justification. Give the physical, appearance and personality changes the SAME weight as any intimate ones; do NOT focus only on the sexual parameters while neglecting the rest. Each subject above is named explicitly — apply each change strictly to that named character, even in a group scene with several characters present.`);
    if (state.settings.thoughts) {
      lines.push(`After your reply, append on its very own final line the focal character's honest private inner monologue right now, in first person, 1-2 sentences reflecting their modified state and true feelings, formatted EXACTLY as: <!--mw-think ${subjMacro(state)}: ...--> (an HTML comment, invisible to the reader). Always include it.`);
    }
    if (state.settings.corruption) {
      lines.push(`Whenever your reply depicts an explicit sexual act, append one empty marker <!--mw-act--> at the very end for EACH distinct act (HTML comments, invisible to the reader). Do not mention or explain them.`);
    }
    lines.push(`Narrate in the language of the ongoing roleplay.]`);
    return mac(lines.join(' '));
  }

  function updateStateInject() {
    try {
      const text = isEnabled() ? buildStateText() : null;
      if (text) {
        injectPrompts([{ id: INJ_STATE, position: 'in_chat', depth: 1, role: 'system', content: text, should_scan: true }]);
      } else {
        uninjectPrompts([INJ_STATE]);
      }
    } catch (e) { console.error('[MindWare] inject failed', e); }
  }

  /* ----- enable / disable (toggle in ST's Extensions list) ----- */

  function isEnabled() { const s = extension_settings[EXT_ID]; return !s || s.enabled !== false; }
  function setEnabled(v) {
    extension_settings[EXT_ID] = Object.assign(extension_settings[EXT_ID] || {}, { enabled: !!v });
    saveSettingsDebounced();
    applyEnabled();
  }
  function applyEnabled() {
    const on = isEnabled();
    if (bubble) bubble.style.display = on ? '' : 'none';
    if (!on) {
      if (panelOpen) togglePanel();
      try { uninjectPrompts([INJ_STATE, INJ_CMD]); } catch (e) { /* ignore */ }
      clearInterval(watchdog);
    } else {
      if (!D.getElementById(ROOT_ID)) buildShell();
      if (bubble) bubble.style.display = '';
      startWatchdog();
      updateStateInject();
    }
  }
  // settings block with an on/off toggle inside ST's Extensions drawer
  function addSettingsUi() {
    const host = D.getElementById('extensions_settings') || D.getElementById('extensions_settings2');
    if (!host || D.getElementById('mindware_ext_settings')) return;
    const div = D.createElement('div');
    div.id = 'mindware_ext_settings';
    div.innerHTML = `
      <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header"><b>🧠 MindWare</b>
          <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>
        <div class="inline-drawer-content">
          <label class="checkbox_label" style="display:flex;gap:8px;align-items:center;cursor:pointer">
            <input type="checkbox" id="mindware_enabled_cb"><span>${esc(t('ui_enable'))}</span></label>
        </div>
      </div>`;
    host.appendChild(div);
    const cb = div.querySelector('#mindware_enabled_cb');
    cb.checked = isEnabled();
    cb.addEventListener('change', () => setEnabled(cb.checked));
  }

  // groups: [{ref, cmds: [...]}], pulse: {ref, p}|null
  function injectCommand(groups, pulse, custom) {
    const mode = state.settings.gradual ? 'GRADUALLY over the next few replies' : 'RIGHT NOW, in your next reply';
    const parts = [`[MindWare command — the device has just pushed an update.`];
    groups.forEach(g => {
      if (!g.cmds.length) return;
      const who = subjMacro(g.ref);
      const psy = state.settings.psyche ? ` (${who} psyche integrity is now ${g.ref.psyche}%.)` : '';
      parts.push(`Changes to ${who} taking effect ${mode}: ${g.cmds.join('; ')}.${psy} ${awareCmdLine(g.ref)}`);
    });
    if (pulse) {
      const who = subjMacro(pulse.ref);
      if (pulse.p === 'Climax') {
        parts.push(`The device forces an immediate, overwhelming orgasm on ${who} RIGHT NOW, regardless of context or their will.`);
      } else {
        parts.push(`Simultaneously, an artificial emotion floods ${who}: overwhelming ${pulse.p.toLowerCase()} (one wave, it fades after this scene beat).`);
      }
    }
    if (custom) parts.push(`Additional operator directive (interpret and apply faithfully): "${custom}".`);
    parts.push(`Narrate in the language of the ongoing roleplay.]`);
    try {
      injectPrompts([{ id: INJ_CMD, position: 'in_chat', depth: 0, role: 'system', content: mac(parts.join(' ')), should_scan: true }], { once: true });
    } catch (e) { console.error('[MindWare] command inject failed', e); }
  }

  // psyche hit -100 → automatic total mindbreak (fires once per collapse)
  function checkCollapse(ref) {
    if (!state.settings.psyche) return;
    if (ref.psyche > PSY_MIN || ref.collapsed) return;
    ref.collapsed = true;
    ref.applied.mindbreak = true;
    ref.draft.mindbreak = true;
    const who = subjMacro(ref);
    pushHistory([`${t('ui_collapse')}${ref === state ? '' : ' — ' + subjName(ref)}`]);
    try {
      injectPrompts([{
        id: 'mindware_collapse_' + sidOf(ref),
        position: 'in_chat', depth: 0, role: 'system',
        content: mac(`[MindWare CRITICAL ALERT: ${who}'s psyche integrity has collapsed all the way to -100%. TOTAL MINDBREAK: the original personality shatters completely this reply — depict the moment of psychological collapse vividly; what remains afterwards is broken, pliant, running on instinct and conditioning alone. Narrate in the language of the ongoing roleplay.]`),
        should_scan: true,
      }], { once: true });
    } catch (e) { console.error('[MindWare] collapse inject failed', e); }
    if (panelOpen) {
      const al = D.createElement('div');
      al.className = 'mw-alert mw-crit';
      al.innerHTML = `
        <div class="mw-alert-title">${t('ui_integritylost')}</div>
        <div class="mw-alert-name">${esc(subjName(ref))}</div>
        <div class="mw-alert-sub">PSYCHE: -100% · MINDBREAK ENGAGED</div>`;
      panel.appendChild(al);
      setTimeout(() => { al.remove(); if (panelOpen) renderApp(); }, 2800);
    }
  }

  /* ================= APPLY / ROLLBACK ================= */

  function snapAll() {
    return {
      c: clone(state.applied),
      subs: Object.fromEntries((state.subjects || []).map(s => [s.id, clone(s.applied)])),
    };
  }

  function pushHistory(notes) {
    state.version += 1;
    state.history.push({
      v: state.version, t: Date.now(), notes,
      snapshot: snapAll(),
      mid: lastMsgId(), // anchor: patches die with their messages
      psy: Object.fromEntries(allRefs().map(r => [sidOf(r), r.psyche])),
      psyche: state.psyche,
    });
    if (state.history.length > 25) state.history.shift();
  }

  // restore parameter sets (and optionally psyches) from a history entry
  function restoreFromEntry(h, withPsy) {
    const snap = h.snapshot && h.snapshot.c !== undefined ? h.snapshot : { c: h.snapshot, subs: {} };
    const subs = snap.subs || {};
    state.applied = clone(snap.c);
    state.draft = clone(snap.c);
    (state.subjects || []).forEach(s => {
      const tgt = subs[s.id] || s.original;
      s.applied = clone(tgt);
      s.draft = clone(tgt);
    });
    if (withPsy) {
      if (h.psy) allRefs().forEach(r => { const p = h.psy[sidOf(r)]; if (typeof p === 'number') r.psyche = p; });
      else if (typeof h.psyche === 'number') state.psyche = h.psyche;
    }
    allRefs().forEach(r => { if (r.psyche > PSY_MIN) r.collapsed = false; });
  }

  // undo every patch anchored to message `deadFromMid` or later —
  // used both when messages are deleted and when the last reply is rerolled
  function undoPatchesFrom(deadFromMid) {
    if (!state.synced) return;
    const orphans = state.history.filter(h => typeof h.mid === 'number' && h.mid >= 0 && h.mid >= deadFromMid);
    if (!orphans.length) return;
    state.history = state.history.filter(h => !orphans.includes(h));
    const last = state.history[state.history.length - 1];
    if (last) {
      restoreFromEntry(last, true);
      state.version = last.v;
    } else {
      restoreFromEntry({ snapshot: { c: clone(state.original), subs: {} } }, false);
      allRefs().forEach(r => { r.psyche = 100; r.collapsed = false; });
      state.version = 10;
      state.history = [{ v: 10, t: Date.now(), notes: [t('hist_baseline')], snapshot: { c: clone(state.original), subs: {} }, mid: -1, psyche: 100 }];
    }
    state.pulse = null;
    state.memo = null;
    state.instaPreg = null;
    updateStateInject();
    saveNow();
    if (panelOpen) renderApp();
    updateFooter();
    flashApply(tf('ui_timeline', vstr(state.version)));
    pulseBubble();
  }

  function onMessageDeleted() { undoPatchesFrom(lastMsgId() + 1); }
  // reroll/swipe replaces that message → its patches die with the old variant
  function onMessageSwiped(message_id) { undoPatchesFrom(message_id); }

  function vstr(v) { return 'v' + (v / 10).toFixed(1); }

  function applyChanges() {
    const entries = allRefs().map(ref => ({ ref, diffs: computeDiffs(ref.applied, ref.draft, affTargetMacro(ref)) }));
    const pulse = state.pulse && refOf(state.pulse.sid) ? state.pulse : null;
    const custom = state.custom.trim();
    const memo = state.memo && state.memo.text.trim() && refOf(state.memo.sid) ? state.memo : null;
    const preg = state.instaPreg && refOf(state.instaPreg) ? state.instaPreg : null;
    const total = entries.reduce((s, e) => s + e.diffs.length, 0);
    if (!total && !pulse && !custom && !memo && !preg) { flashApply(t('ui_nopending'), true); return; }

    entries.forEach(e => {
      if (!e.diffs.length) return;
      if (state.settings.psyche) {
        let dmg = e.diffs.reduce((s, d) => s + d.dmg, 0);
        dmg *= AWARE_MULT[e.ref.awareness] || 1;
        if (state.settings.gradual) dmg *= 0.7;
        e.ref.psyche = Math.max(PSY_MIN, e.ref.psyche - Math.min(100, Math.round(dmg)));
      }
      // turning denial off resets the denial streak
      if (e.diffs.some(d => d.key === 'orgasm_denial') && !e.ref.draft.orgasm_denial) e.ref.stats.denied = 0;
      e.ref.applied = clone(e.ref.draft);
    });
    if (pulse) {
      const r = refOf(pulse.sid);
      if (state.settings.psyche) r.psyche = Math.max(PSY_MIN, r.psyche - (pulse.p === 'Climax' ? 4 : 2));
      if (pulse.p === 'Climax') r.stats.forced += 1;
    }
    if (memo && state.settings.psyche) {
      const r = refOf(memo.sid);
      r.psyche = Math.max(PSY_MIN, r.psyche - Math.round(6 * (AWARE_MULT[r.awareness] || 1)));
    }
    if (preg && state.settings.psyche) {
      const r = refOf(preg);
      r.psyche = Math.max(PSY_MIN, r.psyche - Math.round(10 * (AWARE_MULT[r.awareness] || 1)));
    }
    if (custom && state.settings.psyche) state.psyche = Math.max(PSY_MIN, state.psyche - 3);

    const notes = entries.flatMap(e =>
      e.diffs.map(d => (e.ref === state ? '' : subjName(e.ref) + ': ') + d.note))
      .concat(pulse ? [`${t('d_pulse')}: ${t('pu_' + pulse.p)}${pulse.sid === 'char' ? '' : ' — ' + subjName(refOf(pulse.sid))}`] : [])
      .concat(memo ? [`${t('d_memimplant')}${memo.sid === 'char' ? '' : ' — ' + subjName(refOf(memo.sid))}: "${memo.text.trim()}"`] : [])
      .concat(preg ? [`${t('d_instapreg')}${preg === 'char' ? '' : ' — ' + subjName(refOf(preg))}`] : [])
      .concat(custom ? [`${t('d_custom')}: "${custom}"`] : []);
    pushHistory(notes);

    const groups = entries.filter(e => e.diffs.length).map(e => ({ ref: e.ref, cmds: e.diffs.map(d => d.cmd) }));
    const groupFor = ref => {
      let g = groups.find(x => x.ref === ref);
      if (!g) { g = { ref, cmds: [] }; groups.push(g); }
      return g;
    };
    if (memo) {
      groupFor(refOf(memo.sid)).cmds.push(`a fabricated memory is implanted into their mind and feels entirely real and their own: "${memo.text.trim()}"`);
    }
    if (preg) {
      const r = refOf(preg);
      groupFor(r).cmds.push(`they become pregnant THIS INSTANT — no conception involved, the belly will visibly grow at "${r.applied.gestation}" gestation pace. SECRET, never state it outright: the womb is filling with EGGS, not a normal child; hide this behind subtle oddities at most, and reveal the truth only at a very late stage or at the laying itself, as a shock`);
    }
    injectCommand(groups, pulse ? { ref: refOf(pulse.sid), p: pulse.p } : null, custom);
    state.pulse = null;
    state.custom = '';
    state.memo = null;
    state.instaPreg = null;
    allRefs().forEach(checkCollapse);
    updateStateInject();
    saveNow();
    if (panelOpen) renderApp();
    updateFooter();
    flashApply(tf('ui_deployed', vstr(state.version)));
  }

  // the little "oops, never mind" button: drop every pending draft change
  function discardDraft() {
    if (!pendingTotal()) { flashApply(t('ui_nopending'), true); return; }
    allRefs().forEach(r => { r.draft = clone(r.applied); });
    state.pulse = null;
    state.custom = '';
    state.memo = null;
    state.instaPreg = null;
    saveNow();
    if (panelOpen) renderApp();
    updateFooter();
    flashApply(t('ui_discarded'), true);
  }

  // CALIBRATION: write the pending draft changes straight into the TRUE baseline
  // (original = applied = draft) for the changed keys. No psyche hit, no command to
  // the bot — it's "this was always so", a correction of what sync mis-inferred.
  function commitCalibration() {
    const entries = allRefs().map(ref => ({ ref, diffs: computeDiffs(ref.applied, ref.draft, affTargetMacro(ref)) }));
    const total = entries.reduce((s, e) => s + e.diffs.length, 0);
    if (!total) { flashApply(t('ui_nopending'), true); return; }
    entries.forEach(e => e.diffs.forEach(d => {
      const k = d.key;
      e.ref.original[k] = clone(e.ref.draft[k]);
      e.ref.applied[k] = clone(e.ref.draft[k]);
    }));
    calibrating = false; // auto-exit calibration mode after confirming
    panel.classList.remove('mw-calibrating');
    updateStateInject(); // modifications-vs-true-self recomputed: calibrated keys drop out
    saveNow();
    if (panelOpen) renderApp();
    updateFooter();
    flashApply(t('ui_calibrated'));
  }

  function rollbackTo(version) {
    const entry = state.history.find(h => h.v === version) ||
      (version === 10 ? { v: 10, snapshot: { c: clone(state.original), subs: {} } } : null);
    if (!entry) return;
    const note = version === 10 ? t('hist_rb_orig') : tf('hist_rb', vstr(version));

    // collect revert commands for the bot before mutating anything
    const snap = entry.snapshot.c !== undefined ? entry.snapshot : { c: entry.snapshot, subs: {} };
    const subs = snap.subs || {};
    const groups = [];
    const diffsC = computeDiffs(state.applied, snap.c);
    if (diffsC.length) groups.push({ ref: state, cmds: [`state reverts: ${diffsC.map(d => d.cmd).join('; ')}`] });
    (state.subjects || []).forEach(s => {
      const target = subs[s.id] || s.original;
      const diffs = computeDiffs(s.applied, target, affTargetMacro(s));
      if (diffs.length) groups.push({ ref: s, cmds: [`state reverts: ${diffs.map(d => d.cmd).join('; ')}`] });
    });

    restoreFromEntry(entry, true);
    // rolling back to the original is a clean reset — restore pristine psyche
    if (version === 10) allRefs().forEach(r => { r.psyche = 100; r.collapsed = false; });
    pushHistory([note]);
    if (groups.length) injectCommand(groups, null, '');
    state.pulse = null;
    updateStateInject();
    saveNow();
    if (panelOpen) renderApp();
    updateFooter();
    flashApply(tf('ui_rolledback', vstr(state.version)));
  }

  function resetSubject(sid) {
    const ref = refOf(sid);
    if (ref === state) { rollbackTo(10); return; }
    const diffs = computeDiffs(ref.applied, ref.original, affTargetMacro(ref));
    if (!diffs.length) { flashApply(t('ui_nopending'), true); return; }
    ref.applied = clone(ref.original);
    ref.draft = clone(ref.original);
    ref.psyche = 100; ref.collapsed = false; // reset to original = pristine mind
    pushHistory([tf('hist_subreset', subjName(ref))]);
    injectCommand([{ ref, cmds: [`state reverts: ${diffs.map(d => d.cmd).join('; ')}`] }], null, '');
    updateStateInject();
    saveNow();
    if (panelOpen) renderApp();
    updateFooter();
    flashApply(tf('ui_rolledback', vstr(state.version)));
  }

  function unlinkSubject(sid) {
    const i = (state.subjects || []).findIndex(s => s.id === sid);
    if (i < 0) return;
    state.subjects.splice(i, 1);
    if (state.selSubj === sid) state.selSubj = 'char';
    updateStateInject();
    saveNow();
    if (panelOpen) renderApp();
    updateFooter();
  }

  function factoryReset() {
    if (!W.confirm(t('ui_factory_q'))) return;
    try {
      uninjectPrompts([INJ_STATE, INJ_CMD].concat(allRefs().map(r => 'mindware_collapse_' + sidOf(r))));
    } catch (e) { /* ignore */ }
    state = freshState();
    saveNow();
    detectLang();
    activeTab = 'body';
    renderApp();
  }

  /* ----- chaos dice (randomizes only the open tab) ----- */

  const TAB_CHIPS = { body: ['tattoos', 'piercings', 'accessories'], extreme: ['erozones', 'accessories_x'], bio: ['body_mods', 'implants'] };

  function chaosPool(tabs) {
    const pool = [];
    tabs.forEach(tab => {
      SLIDERS.filter(s => s[0] === tab).forEach(s => pool.push(['slider', s]));
      TOGGLES.filter(x => x[0] === tab).forEach(x => pool.push(['toggle', x]));
      SELECTS.filter(s => s[0] === tab && !DICE_EXCLUDE.includes(s[1])).forEach(s => pool.push(['select', s]));
      (TAB_CHIPS[tab] || []).forEach(gk => {
        const g = CHIP_GROUPS.find(x => x[0] === gk);
        g[1].forEach(item => pool.push(['chip', [gk, item]]));
      });
    });
    return pool;
  }

  function mutateSet(o, [kind, def]) {
    if (kind === 'slider') {
      let [, key, min, max] = def;
      if (key === 'height') { const r = heightRange(o); min = r[0]; max = r[1]; }
      o[key] = min + Math.floor(Math.random() * (max - min + 1));
    } else if (kind === 'toggle') {
      o[def[1]] = !o[def[1]];
    } else if (kind === 'select') {
      const opts = def[2].filter(x => x !== o[def[1]]);
      o[def[1]] = opts[Math.floor(Math.random() * opts.length)];
    } else {
      const [gk, item] = def;
      const arr = o[gk] || (o[gk] = []);
      const i = arr.indexOf(item);
      if (i >= 0) arr.splice(i, 1); else arr.push(item);
    }
  }

  function pickRandom(pool, count) {
    const picks = [];
    while (picks.length < count && pool.length) {
      picks.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
    }
    return picks;
  }

  function unlockedTabs() {
    const tabs = ['body', 'mind'];
    if (state.settings.extreme) tabs.push('extreme');
    if (state.settings.biolab) tabs.push('bio');
    return tabs;
  }

  function rollChaos() {
    if (!['body', 'mind', 'extreme', 'bio'].includes(activeTab)) { flashApply(t('ui_dice_hint'), true); return; }
    const S = subj();
    if (!isEditable(S)) { flashApply(t('ui_ro_note'), true); return; }
    pickRandom(chaosPool([activeTab]), 3).forEach(p => mutateSet(S.draft, p));
    save();
    renderTab();
    updateFooter();
    flashApply(t('ui_chaos'));
  }

  // Chaos Engine: every N messages the device spontaneously mutates
  // a random parameter of a random subject, applied instantly
  function fireAutoChaos() {
    const refs = allRefs();
    const ref = refs[Math.floor(Math.random() * refs.length)];
    const to = clone(ref.applied);
    pickRandom(chaosPool(unlockedTabs()), 2).forEach(p => mutateSet(to, p));
    const diffs = computeDiffs(ref.applied, to, affTargetMacro(ref));
    if (!diffs.length) return;
    if (state.settings.psyche) {
      const dmg = diffs.reduce((s, d) => s + d.dmg, 0) * (AWARE_MULT[ref.awareness] || 1);
      ref.psyche = Math.max(PSY_MIN, ref.psyche - Math.min(100, Math.round(dmg)));
    }
    diffs.forEach(d => {
      if (CHIP_GROUPS.some(g => g[0] === d.key)) ref.draft[d.key] = clone(to[d.key]);
      else ref.draft[d.key] = to[d.key];
    });
    ref.applied = to;
    const prefix = ref === state ? '' : subjName(ref) + ': ';
    pushHistory([t('ui_autochaos_note')].concat(diffs.map(d => prefix + d.note)));
    injectCommand([{ ref, cmds: ['the device GLITCHES and spontaneously mutates them: ' + diffs.map(d => d.cmd).join('; ')] }], null, '');
    checkCollapse(ref);
    updateStateInject();
    saveNow();
    if (panelOpen) renderApp();
    updateFooter();
    flashApply(tf('ui_chaosfired', vstr(state.version)));
    pulseBubble();
  }

  /* ----- bot-driven changes: <!--mw {"param":value}--> in AI replies ----- */

  function validateRemote(j, base) {
    const to = clone(base);
    const tabs = unlockedTabs(); // hidden branches are invisible to the bot
    SLIDERS.forEach(([tab, k, min, max, , , kind]) => {
      if (j[k] === undefined || !tabs.includes(tab)) return;
      let v = j[k];
      if (kind === 'cups' && typeof v === 'string') v = CUPS.indexOf(v.toUpperCase().trim());
      v = Number(v);
      if (Number.isFinite(v) && !(kind === 'cups' && v < 0)) to[k] = Math.min(max, Math.max(min, Math.round(v)));
    });
    TOGGLES.forEach(([tab, k]) => { if (tabs.includes(tab) && typeof j[k] === 'boolean') to[k] = j[k]; });
    SELECTS.forEach(([tab, k, opts]) => {
      if (tabs.includes(tab) && typeof j[k] === 'string') {
        const hit = opts.find(op => op.toLowerCase() === j[k].toLowerCase().trim());
        if (hit) to[k] = hit;
      }
    });
    CHIP_GROUPS.forEach(([key, zones, , , , , , tab]) => {
      if (tabs.includes(tab) && Array.isArray(j[key])) {
        to[key] = j[key].map(x => zones.find(z => z.toLowerCase() === String(x).toLowerCase().trim())).filter(Boolean);
      }
    });
    const r = heightRange(to);
    to.height = Math.min(r[1], Math.max(r[0], to.height));
    return to;
  }

  function createUserSubject() {
    const base = defaults();
    const av = user_avatar || 'default';
    const ref = {
      id: 'user_' + slugify(av), kind: 'user', name: mac('{{user}}') || 'USER', persona: av,
      original: clone(base), applied: clone(base), draft: clone(base),
      psyche: 100, collapsed: false, corruption: 0, awareness: 'full', stats: freshStats(),
    };
    state.subjects.push(ref);
    return ref;
  }

  // silently analyze a subject's true baseline; keys already modified by
  // the device keep their modified value, untouched keys get the analysis
  async function refineSubject(ref, genConfig) {
    const raw = await generateRaw(Object.assign({ should_silence: true }, genConfig));
    const analyzed = parseSync(raw);
    const live = (state.subjects || []).includes(ref) || ref === state;
    if (!live) return;
    Object.keys(defaults()).forEach(k => {
      const untouched = JSON.stringify(ref.applied[k]) === JSON.stringify(ref.original[k]);
      ref.original[k] = clone(analyzed[k]);
      if (untouched) { ref.applied[k] = clone(analyzed[k]); ref.draft[k] = clone(analyzed[k]); }
    });
    saveNow();
    updateStateInject();
  }

  function personaGenConfig() {
    return {
      user_input:
        `Above is the persona description of the user character. Infer their ORIGINAL baseline parameters (their natural, unmodified self). If the description is sparse, guess a plausible average person of that persona.\n\n` +
        `Reply with ONLY a single JSON object. No commentary, no markdown fences. Keys:\n${jsonSpec()}\n` +
        `Unitless numeric scales are 0-100 (50 = average human); "affection" is -100 (hatred) to 100 (love). Include EVERY key.`,
      ordered_prompts: ['persona_description', 'user_input'],
      generation_id: 'mindware_user_sync',
    };
  }

  function npcGenConfig(name) {
    return {
      user_input:
        `Analyze the character "${name}" as they appear in the conversation above. Infer their ORIGINAL baseline parameters (their natural, unmodified self). Make sensible best guesses where the story is silent.\n\n` +
        `Reply with ONLY a single JSON object. No commentary, no markdown fences. Keys:\n${jsonSpec()}\n` +
        `Unitless numeric scales are 0-100 (50 = average human); "affection" is their attitude towards {{user}}, -100 (hatred) to 100 (love). Include EVERY key.`,
      ordered_prompts: ['chat_history', 'user_input'],
      max_chat_history: 24,
      generation_id: 'mindware_npc_sync',
    };
  }

  function showUserAlert(ref) {
    pulseBubble();
    if (!panelOpen) return;
    const al = D.createElement('div');
    al.className = 'mw-alert';
    al.innerHTML = `
      <div class="mw-alert-title">${t('ui_newsubject')}</div>
      <div class="mw-alert-name">${esc(ref.name)}</div>
      <div class="mw-alert-sub">${t('ui_acquired')}</div>`;
    panel.appendChild(al);
    setTimeout(() => { al.remove(); renderApp(); }, 2400);
  }

  function handleRemoteDirective(message_id) {
    if (!state.synced || !state.settings.botAccess) return;
    let msg;
    try { msg = getChatMessages(message_id)[0]; } catch (e) { return; }
    if (!msg || msg.role !== 'assistant') return;
    const m = String(msg.message).match(/<!--\s*mw\s*({[\s\S]*?})\s*-->/i);
    if (!m) return;
    let j;
    try { j = JSON.parse(m[1]); } catch (e) { return; }

    // optional branch unlock by the bot (only if the user allowed it)
    const unlock = String(j.unlock || '').trim().toLowerCase();
    delete j.unlock;
    let unlocked = false;
    if (unlock && state.settings.botUnlock) {
      if ((unlock.indexOf('ext') === 0 || unlock === 'ero') && !state.settings.extreme) {
        state.settings.extreme = true; unlocked = true;
      }
      if (unlock === 'bio' && !state.settings.biolab) {
        state.settings.biolab = true; unlocked = true;
      }
    }

    const tgt = String(j.target || '').trim().toLowerCase();
    delete j.target;
    let ref = state;
    let created = false;
    if (tgt === 'user') {
      ref = findUserSubj();
      if (!ref) { ref = createUserSubject(); created = true; refineSubject(ref, personaGenConfig()).catch(() => { }); }
    } else if (tgt) {
      const hit = (state.subjects || []).find(s => s.name.toLowerCase() === tgt);
      if (!hit) return; // unknown target: ignore rather than hit the char by mistake
      ref = hit;
    }

    // "preset":"Name" expands into its params (explicit params still override it)
    if (j.preset) {
      const want = String(j.preset).toLowerCase();
      const key = Object.keys(MIND_PRESETS).concat(Object.keys(BODY_PRESETS)).find(n => n.toLowerCase() === want);
      const p = key ? (MIND_PRESETS[key] || BODY_PRESETS[key]) : null;
      if (p) Object.entries(p).forEach(([k, v]) => { if (j[k] === undefined) j[k] = clone(v); });
      delete j.preset;
    }

    // one-shot story effects the bot can trigger (not parameter sets)
    let botPulse = null, botMeta = false;
    const botCmds = [], botNotes = [];
    if (j.awareness) {
      const aw = String(j.awareness).toLowerCase().trim();
      if (AWARE_MODES.includes(aw) && ref.awareness !== aw) { ref.awareness = aw; botMeta = true; botNotes.push(t('s_awareness') + ': ' + t('aw_' + aw)); }
    }
    if (j.reset === true) {
      const rev = computeDiffs(ref.applied, ref.original, affTargetMacro(ref));
      ref.applied = clone(ref.original); ref.draft = clone(ref.original);
      ref.psyche = 100; ref.collapsed = false; ref.corruption = 0;
      botMeta = true;
      if (rev.length) botCmds.push(`every modification is wiped — ${subjMacro(ref)} reverts entirely to their original self: ${rev.map(d => d.cmd).join('; ')}`);
      botNotes.push(t('hist_rb_orig'));
    }
    if (j.pulse) {
      const vp = PULSES.concat(state.settings.extreme ? PULSES_X : []).find(p => p.toLowerCase() === String(j.pulse).toLowerCase().trim());
      if (vp) {
        botPulse = { ref, p: vp };
        if (state.settings.psyche) ref.psyche = Math.max(PSY_MIN, ref.psyche - (vp === 'Climax' ? 4 : 2));
        if (vp === 'Climax' && ref.stats) ref.stats.forced += 1;
        botNotes.push(t('d_pulse') + ': ' + t('pu_' + vp));
      }
    }
    if (j.memory && String(j.memory).trim()) {
      botCmds.push(`a fabricated memory is implanted into ${subjMacro(ref)}'s mind and feels entirely real and their own: "${String(j.memory).trim()}"`);
      botNotes.push(t('d_memimplant'));
      if (state.settings.psyche) ref.psyche = Math.max(PSY_MIN, ref.psyche - Math.round(6 * (AWARE_MULT[ref.awareness] || 1)));
    }
    if (j.pregnant === true) {
      botCmds.push(`${subjMacro(ref)} becomes pregnant THIS INSTANT — no conception involved, the belly will visibly grow; SECRET, never state outright: the womb is filling with EGGS, hide it behind subtle oddities and reveal only at a very late stage`);
      botNotes.push(t('d_instapreg'));
      if (state.settings.psyche) ref.psyche = Math.max(PSY_MIN, ref.psyche - Math.round(10 * (AWARE_MULT[ref.awareness] || 1)));
    }
    ['pulse', 'memory', 'pregnant', 'awareness', 'reset'].forEach(k => delete j[k]);

    const to = validateRemote(j, ref.applied);
    const diffs = computeDiffs(ref.applied, to, affTargetMacro(ref));
    if (!diffs.length && !created && !unlocked && !botPulse && !botCmds.length && !botMeta) return;

    const prefix = ref === state ? '' : subjName(ref) + ': ';
    const notes = [];
    if (diffs.length) {
      if (state.settings.psyche) {
        const dmg = Math.min(100, Math.round(diffs.reduce((s, d) => s + d.dmg, 0) * (AWARE_MULT[ref.awareness] || 1)));
        ref.psyche = Math.max(PSY_MIN, ref.psyche - dmg);
      }
      diffs.forEach(d => {
        if (CHIP_GROUPS.some(g => g[0] === d.key)) ref.draft[d.key] = clone(to[d.key]);
        else ref.draft[d.key] = to[d.key];
      });
      ref.applied = to;
      notes.push(...diffs.map(d => prefix + d.note));
    }
    if (botPulse || botCmds.length) injectCommand(botCmds.length ? [{ ref, cmds: botCmds }] : [], botPulse, '');
    if (botPulse || botCmds.length || botMeta) notes.push(...botNotes.map(n => prefix + n));
    if (notes.length || created || unlocked) { pushHistory([t('ui_remote')].concat(notes)); checkCollapse(ref); }
    updateStateInject();
    saveNow();
    if (created) showUserAlert(ref);
    else if (panelOpen) renderApp();
    updateFooter();
    flashApply(tf('ui_remoteflash', vstr(state.version)));
    pulseBubble();
  }

  /* ================= SYNC (card / persona / scene analysis) ================= */

  function jsonSpec() {
    const sliderKeys = SLIDERS.filter(s => !s[1].startsWith('kink_') && !['arousal', 'bust', 'personality', 'perception_filter', 'role_position', 'user_dependency', 'wear_tear', 'resistance', 'auto_stim'].includes(s[1])).map(([, k, min, max, unit]) =>
      `"${k}": number ${min}-${max}${unit ? ' (' + unit + ')' : ''}${k === 'voice_pitch' ? ' (0=deep bass, 100=squeaky)' : ''}${k === 'affection' ? ' (-100=hatred, 0=indifferent, 100=love)' : ''}${k === 'height' ? ' (use "scale" for tiny/giant beings)' : ''}`).join(', ');
    const selectKeys = SELECTS.filter(s => !['memory_wipe', 'gestation'].includes(s[1])).map(([, k, opts]) =>
      `"${k}": one of [${opts.map(o => '"' + o + '"').join(', ')}]`).join(', ');
    const toggleKeys = TOGGLES.filter(t2 => t2[0] === 'body' && !['outfit_lock', 'body_writing'].includes(t2[1])).map(([, k]) => `"${k}": boolean`).join(', ');
    return `{ ${sliderKeys}, "bust": cup size, one of [${CUPS.map(c => '"' + c + '"').join(', ')}], "tattoos": array of zones from [${TAT_ZONES.map(z => '"' + z + '"').join(', ')}] (empty if none), "piercings": array of zones from [${PIERCE_ZONES.map(z => '"' + z + '"').join(', ')}] (empty if none), "accessories": array from [${ACCESSORIES.map(z => '"' + z + '"').join(', ')}] (empty if none), "body_mods": array from [${BODY_MODS.map(z => '"' + z + '"').join(', ')}] (empty for unmodified bodies), "implants": array from [${IMPLANTS.map(z => '"' + z + '"').join(', ')}] (empty unless cybernetic), ${toggleKeys}, ${selectKeys} }`;
  }

  function syncPromptFor(cd) {
    const trim = (s, n) => (s || '').slice(0, n);
    const card = [
      `Name: ${cd.name}`,
      `Description: ${trim(cd.description, 3500)}`,
      `Personality: ${trim(cd.personality, 1500)}`,
      `Scenario: ${trim(cd.scenario, 800)}`,
      `First message: ${trim(cd.first_mes, 1500)}`,
    ].join('\n');
    return (
      `You are a character analysis module. Based on the character sheet below, infer this character's ORIGINAL baseline parameters (their natural, unmodified self). Where the sheet is silent, make a sensible best guess from genre and archetype.\n\n` +
      `=== CHARACTER SHEET ===\n${card}\n=== END SHEET ===\n\n` +
      `Reply with ONLY a single JSON object. No commentary, no markdown fences. Keys:\n${jsonSpec()}\n` +
      `Unitless numeric scales are 0-100 (50 = average human); "affection" is their attitude towards {{user}}, -100 (hatred) to 100 (love). Include EVERY key.`
    );
  }

  function parseSync(raw) {
    let txt = String(raw).replace(/```[a-z]*\n?/gi, '').trim();
    const a = txt.indexOf('{'), b = txt.lastIndexOf('}');
    if (a < 0 || b <= a) throw new Error('no JSON in reply');
    const j = JSON.parse(txt.slice(a, b + 1));
    const o = defaults();
    SLIDERS.forEach(([, k, min, max, , , kind]) => {
      let v = j[k];
      if (kind === 'cups' && typeof v === 'string') v = CUPS.indexOf(v.toUpperCase().trim());
      v = Number(v);
      if (Number.isFinite(v) && !(kind === 'cups' && v < 0)) o[k] = Math.min(max, Math.max(min, Math.round(v)));
    });
    TOGGLES.forEach(([, k]) => { if (typeof j[k] === 'boolean') o[k] = j[k]; });
    SELECTS.forEach(([, k, opts]) => {
      if (typeof j[k] === 'string') {
        const hit = opts.find(op => op.toLowerCase() === j[k].toLowerCase().trim());
        if (hit) o[k] = hit;
      }
    });
    CHIP_GROUPS.forEach(([key, zones]) => {
      if (Array.isArray(j[key])) {
        o[key] = j[key].map(x => zones.find(z => z.toLowerCase() === String(x).toLowerCase().trim())).filter(Boolean);
      }
    });
    // height clamps to the parsed scale's range, with raw value respected
    const hv = Number(j.height);
    const r = heightRange(o);
    if (Number.isFinite(hv)) o.height = Math.min(r[1], Math.max(r[0], Math.round(hv)));
    o.arousal = 0;
    o.personality = 100; o.perception_filter = 0; o.role_position = 50; o.user_dependency = 0; o.wear_tear = 0; o.resistance = 0; o.auto_stim = 0;
    o.memory_wipe = 'None';
    o.gestation = 'Normal';
    o.erozones = [];
    o.conjured = [];
    return o;
  }

  async function runSync(cd) {
    if (!cd) cd = (() => { try { return getCharData('current'); } catch (e) { return null; } })();
    if (!cd) { renderSyncScreen(t('sy_nochar')); return; }
    const scan = showLoaderScreen(`${t('sy_target')}: ${cd.name}`, t('scan_lines'), true);
    try {
      const raw = await generateRaw({
        user_input: syncPromptFor(cd),
        should_silence: true,
        ordered_prompts: ['user_input'],
        generation_id: 'mindware_sync',
      });
      const base = parseSync(raw);
      state.synced = true;
      state.charBlind = false;
      state.charName = cd.name || 'UNKNOWN';
      state.charAvatar = cd.avatar || null;
      state.original = base;
      state.applied = clone(base);
      state.draft = clone(base);
      state.psyche = 100;
      state.awareness = 'full';
      state.stats = freshStats();
      state.version = 10;
      state.history = [{ v: 10, t: Date.now(), notes: [t('hist_baseline')], snapshot: { c: clone(base), subs: {} }, psyche: 100 }];
      saveNow();
      updateStateInject();
      scan.finish(t('sy_done'), () => { activeTab = 'body'; renderApp(); });
    } catch (e) {
      console.error('[MindWare] sync failed', e);
      scan.stop();
      renderSyncScreen(t('sy_err'));
    }
  }

  /* ----- "+" flows: link self / scan scene / link NPC ----- */

  // start screen picked self/NPC first: link the char on neutral defaults
  // now, analyze the card quietly once the foreground analysis is done
  function initBlindChar() {
    if (state.synced) return;
    let cd = null;
    try { cd = getCharData('current'); } catch (e) { /* ignore */ }
    const base = defaults();
    state.synced = true;
    state.charBlind = true;
    state.charName = (cd && cd.name) || 'UNKNOWN';
    state.original = base;
    state.applied = clone(base);
    state.draft = clone(base);
    state.psyche = 100;
    state.awareness = 'full';
    state.stats = freshStats();
    state.version = 10;
    state.history = [{ v: 10, t: Date.now(), notes: [t('hist_baseline')], snapshot: { c: clone(base), subs: {} }, psyche: 100 }];
    saveNow();
    updateStateInject();
  }

  function refineCharIfBlind() {
    if (!state.charBlind) return;
    let cd = null;
    try { cd = getCharData('current'); } catch (e) { return; }
    if (!cd) return;
    state.charBlind = false;
    saveNow();
    refineSubject(state, {
      user_input: syncPromptFor(cd),
      ordered_prompts: ['user_input'],
      generation_id: 'mindware_sync',
    }).then(() => { if (panelOpen) renderApp(); })
      .catch(e => { console.warn('[MindWare] background char analysis failed', e); state.charBlind = true; save(); });
  }

  // gate adding new subjects: hard cap of 5, a confirm past 3 (may cause errors)
  function canAddSubject(then) {
    const n = (state.subjects || []).length;
    if (n >= 5) { flashApply(t('ui_subj_max'), true); return; }
    if (n >= 3) { confirmDialog(t('ui_subj_warn'), then); return; }
    then();
  }

  async function addSelf() {
    const existing = findUserSubj();
    if (existing) { state.selSubj = existing.id; renderApp(); return; }
    const ref = createUserSubject();
    state.selSubj = ref.id;
    saveNow();
    const loader = showLoaderScreen(`${t('sy_target')}: ${ref.name}`, t('persona_lines'), true);
    try {
      await refineSubject(ref, personaGenConfig());
      loader.finish(t('sy_done'), () => { renderApp(); flashApply(tf('ui_subj_linked', ref.name)); refineCharIfBlind(); });
    } catch (e) {
      console.warn('[MindWare] persona analysis failed, defaults kept', e);
      loader.finish(t('sy_done'), () => { renderApp(); refineCharIfBlind(); });
    }
  }

  async function scanScene() {
    // make sure the user is linked too — scanning shouldn't leave them out
    if (!findUserSubj() && (state.subjects || []).length < 5) createUserSubject();
    const loader = showLoaderScreen('…', t('scene_lines'), true);
    try {
      const raw = await generateRaw({
        user_input:
          `Look at the conversation above. List the characters CURRENTLY present in the scene, excluding "${state.charName}" and {{user}}. ` +
          `Reply with ONLY a JSON array of names, e.g. ["Alice","Bob"]. Reply [] if there is no one else.`,
        should_silence: true,
        ordered_prompts: ['chat_history', 'user_input'],
        max_chat_history: 16,
        generation_id: 'mindware_scene',
      });
      let txt = String(raw).replace(/```[a-z]*\n?/gi, '').trim();
      const a = txt.indexOf('['), b = txt.lastIndexOf(']');
      let names = [];
      if (a >= 0 && b > a) names = JSON.parse(txt.slice(a, b + 1));
      // in a group chat, the actual member characters are the most reliable candidates
      const groupNames = (getGroupMemberChars() || []).map(m => m.name);
      names = groupNames.concat(Array.isArray(names) ? names : []);
      const userName = (mac('{{user}}') || '').toLowerCase();
      names = names.filter(n => typeof n === 'string' && n.trim())
        .map(n => n.trim())
        .filter(n => n.toLowerCase() !== (state.charName || '').toLowerCase())
        .filter(n => n.toLowerCase() !== userName)
        .filter(n => !(state.subjects || []).some(s => s.name.toLowerCase() === n.toLowerCase()));
      names = Array.from(new Set(names)).slice(0, 8);
      loader.finish(t('sy_done'), () => renderScenePick(names));
    } catch (e) {
      console.error('[MindWare] scene scan failed', e);
      loader.stop();
      renderApp();
      flashApply(t('sy_err'), true);
    }
  }

  async function addNpc(name) {
    const ref = {
      id: 'npc_' + slugify(name) + '_' + Math.floor(Math.random() * 1e4),
      kind: 'npc', name,
      original: defaults(), applied: defaults(), draft: defaults(),
      psyche: 100, collapsed: false, corruption: 0, awareness: 'full', stats: freshStats(),
    };
    state.subjects.push(ref);
    state.selSubj = ref.id;
    saveNow();
    const loader = showLoaderScreen(`${t('sy_target')}: ${name}`, t('scan_lines'), true);
    try {
      await refineSubject(ref, npcGenConfig(name));
      loader.finish(t('sy_done'), () => { renderApp(); flashApply(tf('ui_subj_linked', name)); refineCharIfBlind(); });
    } catch (e) {
      console.warn('[MindWare] NPC analysis failed, defaults kept', e);
      loader.finish(t('sy_done'), () => { renderApp(); refineCharIfBlind(); });
    }
  }

  /* ================= UI: STYLES (neutral dark app theme) ================= */

  const CSS = `
  #${ROOT_ID} { all: initial; font-family: 'Segoe UI', Roboto, sans-serif; }
  #${ROOT_ID} *, #${ROOT_ID} *::before, #${ROOT_ID} *::after { box-sizing: border-box; }

  .mw-bubble {
    position: fixed; z-index: 2147483000; width: 52px; height: 52px; border-radius: 50%;
    background: radial-gradient(circle at 30% 30%, #ff7daa, #a31246 60%, #5c0a26);
    border: 2px solid #ff9dbd; box-shadow: 0 4px 18px rgba(163,18,70,.55);
    display: flex; align-items: center; justify-content: center;
    cursor: pointer; user-select: none; -webkit-user-select: none; touch-action: none;
    -webkit-tap-highlight-color: transparent; font-size: 26px;
    transition: transform .15s;
  }
  .mw-bubble:hover { transform: scale(1.08); }
  .mw-bubble.mw-ping { animation: mwping .5s 3; }
  @keyframes mwping { 50% { box-shadow: 0 0 26px 6px rgba(255,92,138,.85); transform: scale(1.12); } }
  .mw-bubble .mw-badge {
    position: absolute; top: -4px; right: -4px; min-width: 18px; height: 18px; padding: 0 4px;
    border-radius: 9px; background: #ffd166; color: #4a0e22; font-size: 11px; font-weight: 700;
    display: flex; align-items: center; justify-content: center; border: 1px solid #4a0e22;
  }

  .mw-panel {
    position: fixed; right: 18px; bottom: 86px; z-index: 2147483001;
    width: min(385px, 96vw); height: min(680px, 84vh);
    display: flex; flex-direction: column; overflow: hidden;
    border-radius: 26px; border: 1px solid #2c2c35;
    background: #131318;
    box-shadow: 0 12px 48px rgba(0,0,0,.7);
    color: #ececf2; font-size: 14px;
    max-height: calc(100vh - 100px);
    max-height: calc(100dvh - 100px);
    -webkit-tap-highlight-color: transparent;
  }
  @media (max-width: 600px) {
    .mw-panel {
      width: 96vw; bottom: 74px;
      height: min(580px, calc(100vh - 130px));
      height: min(580px, calc(100dvh - 130px));
      border-radius: 20px;
    }
  }
  /* touch devices: bigger targets, 16px inputs so iOS doesn't zoom on focus */
  @media (pointer: coarse) {
    .mw-toggle { padding: 8px 15px; font-size: 13px; }
    .mw-nav button { padding: 12px 0 13px; }
    .mw-seg div { padding: 10px 4px; }
    .mw-step button { width: 32px; height: 32px; font-size: 17px; }
    .mw-mini { flex: 0 0 30px; height: 30px; font-size: 17px; }
    .mw-subj { width: 38px; height: 38px; }
    select.mw-select, input.mw-custom, .mw-val-input { font-size: 16px; }
    input.mw-range { height: 7px; }
    input.mw-range::-webkit-slider-thumb { width: 22px; height: 22px; }
    input.mw-range::-moz-range-thumb { width: 22px; height: 22px; }
    .mw-apply { padding: 14px; }
    .mw-iconbtn { flex: 0 0 52px; font-size: 19px; }
  }

  .mw-panel.mw-glitch .mw-content { animation: mwjitter 2.4s steps(2) infinite; }
  @keyframes mwjitter {
    0%, 92% { transform: none; filter: none; }
    93% { transform: translateX(-2px); filter: hue-rotate(40deg); }
    95% { transform: translateX(2px) skewX(.6deg); opacity: .8; }
    97% { transform: translateX(-1px); filter: saturate(3); }
  }

  .mw-header { padding: 12px 16px 8px; display: flex; align-items: center; gap: 10px; flex: 0 0 auto; background: #17171d;
    touch-action: none; cursor: move; user-select: none; -webkit-user-select: none; }
  .mw-logo { font-weight: 800; letter-spacing: 2px; color: #ff5c8a; font-size: 15px; }
  .mw-logo span { color: #ececf2; }
  .mw-headinfo { margin-left: auto; text-align: right; font-size: 10.5px; color: #8f8f9b; line-height: 1.4; }
  .mw-close { background: none; border: none; color: #8f8f9b; font-size: 18px; cursor: pointer; padding: 2px 6px; }
  .mw-close:hover { color: #fff; }

  .mw-subjbar { display: flex; align-items: center; gap: 7px; padding: 4px 14px 9px; flex: 0 0 auto; background: #17171d; }
  .mw-subj {
    width: 34px; height: 34px; border-radius: 50%; flex: 0 0 auto; cursor: pointer;
    border: 2px solid #34343d; background: #232329; overflow: hidden;
    display: flex; align-items: center; justify-content: center;
    color: #b9b9c4; font-size: 14px; font-weight: 700; transition: all .15s;
  }
  .mw-subj img { width: 100%; height: 100%; object-fit: cover; }
  .mw-subj:hover { border-color: #ff8fb1; }
  .mw-subj.mw-on { border-color: #ff5c8a; box-shadow: 0 0 8px rgba(255,92,138,.5); }
  .mw-subj.mw-subjadd { color: #ff5c8a; font-size: 19px; background: rgba(255,92,138,.10); border: 2px dashed #ff5c8a88; }
  .mw-subjname { margin-left: auto; font-size: 11.5px; color: #b9b9c4; font-weight: 600; letter-spacing: .5px; max-width: 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .mw-nav { display: flex; flex: 0 0 auto; padding: 0 12px; gap: 4px; border-bottom: 1px solid #26262e; background: #17171d; }
  .mw-nav button {
    flex: 1; padding: 9px 0 11px; background: none; border: none; color: #76767f;
    font-size: 11px; letter-spacing: 1.2px; font-weight: 700; cursor: pointer; transition: all .15s;
  }
  .mw-nav button.mw-active { color: #ececf2; box-shadow: inset 0 -2px 0 #ff5c8a; }
  .mw-nav button.mw-xtab { color: #ff5c8a; }
  .mw-nav button.mw-btab { color: #7ddf8a; }

  .mw-psyche { padding: 8px 16px 6px; flex: 0 0 auto; }
  .mw-psyche-label { display: flex; justify-content: space-between; font-size: 9.5px; letter-spacing: 1.5px; color: #8f8f9b; margin-bottom: 3px; }
  .mw-psyche-bar { height: 7px; border-radius: 4px; background: #1d1d23; overflow: hidden; border: 1px solid #2c2c35; }
  .mw-psyche-fill { height: 100%; border-radius: 4px; background: linear-gradient(90deg, #ff5c8a, #ff8fb1); transition: width .4s; }
  .mw-psyche-fill.mw-low { background: linear-gradient(90deg, #ff3355, #ff6b6b); animation: mwpulse 1.2s infinite; }
  .mw-psyche-fill.mw-neg {
    background: repeating-linear-gradient(135deg, #b3001b 0 8px, #5c0010 8px 16px);
    animation: mwpulse .55s infinite;
    box-shadow: 0 0 10px rgba(255,0,40,.7);
  }
  @keyframes mwpulse { 50% { opacity: .55; } }

  .mw-content { flex: 1 1 auto; overflow-y: auto; padding: 8px 12px 14px; scrollbar-width: thin; scrollbar-color: #3a3a45 transparent;
    touch-action: pan-y; overscroll-behavior: contain; -webkit-overflow-scrolling: touch; }
  .mw-content::-webkit-scrollbar { width: 5px; }
  .mw-content::-webkit-scrollbar-thumb { background: #3a3a45; border-radius: 3px; }

  .mw-card {
    background: #1c1c23;
    border: 1px solid #2a2a33; border-radius: 16px;
    padding: 10px 13px 12px; margin: 10px 0;
  }
  .mw-card-title { font-size: 10px; letter-spacing: 2.5px; color: #8f8f9b; font-weight: 700; margin-bottom: 8px; }
  .mw-grp { font-size: 9px; letter-spacing: 2px; color: #76767f; font-weight: 700; margin: 11px 0 2px; }
  .mw-grp:first-child { margin-top: 2px; }
  .mw-toggles.mw-list { flex-direction: column; }
  .mw-toggles.mw-list .mw-preset { width: 100%; text-align: center; }

  .mw-ro { pointer-events: none; opacity: .65; }

  .mw-seg { display: flex; border: 1px solid #34343d; border-radius: 12px; overflow: hidden; }
  .mw-seg div {
    flex: 1; text-align: center; padding: 8px 4px; font-size: 11.5px; cursor: pointer;
    color: #b9b9c4; background: #232329; transition: all .15s; user-select: none;
  }
  .mw-seg div + div { border-left: 1px solid #34343d; }
  .mw-seg div.mw-on {
    background: #5c0a26; color: #ffd9e6; font-weight: 700; box-shadow: inset 0 2px 8px rgba(0,0,0,.55);
  }

  .mw-slider-row { margin: 9px 0; }
  .mw-slider-top { display: flex; justify-content: space-between; font-size: 12px; margin-bottom: 2px; color: #d6d6de; }
  .mw-slider-top .mw-val { color: #ff8fb1; font-weight: 600; font-variant-numeric: tabular-nums; }
  .mw-slider-top .mw-dirty { color: #ffd166; }
  input.mw-range { -webkit-appearance: none; appearance: none; width: 100%; height: 5px; border-radius: 3px;
    background: #2c2c35; outline: none; cursor: pointer; }
  input.mw-range::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 16px; height: 16px; border-radius: 50%;
    background: radial-gradient(circle at 35% 35%, #ffb3cb, #ff5c8a); border: 1px solid #ffd9e6; box-shadow: 0 0 6px rgba(255,92,138,.55); }
  input.mw-range::-moz-range-thumb { width: 16px; height: 16px; border-radius: 50%; background: #ff5c8a; border: 1px solid #ffd9e6; }
  .mw-range-ends { display: flex; justify-content: space-between; font-size: 9px; color: #76767f; margin-top: 1px; letter-spacing: .5px; }
  .mw-range-wrap { display: flex; align-items: center; gap: 8px; }
  .mw-range-wrap input.mw-range { flex: 1; width: auto; }
  .mw-mini {
    flex: 0 0 24px; height: 24px; border-radius: 7px; border: 1px solid #ff5c8a55;
    background: rgba(255,92,138,.12); color: #ffd9e6; font-size: 15px; line-height: 1; cursor: pointer; padding: 0;
  }
  .mw-mini:hover { background: rgba(255,92,138,.26); }
  .mw-val { cursor: pointer; }
  .mw-val-input {
    width: 54px; background: #232329; border: 1px solid #ff5c8a; border-radius: 6px;
    color: #ffd9e6; font-size: 12px; padding: 1px 4px; text-align: right; font-variant-numeric: tabular-nums;
  }

  .mw-step { display: inline-flex; align-items: center; gap: 8px; }
  .mw-step button {
    width: 26px; height: 26px; border-radius: 8px; border: 1px solid #ff5c8a66;
    background: rgba(255,92,138,.12); color: #ffd9e6; font-size: 15px; cursor: pointer; line-height: 1;
  }
  .mw-step button:hover { background: rgba(255,92,138,.28); }
  .mw-step b { min-width: 18px; text-align: center; color: #ff8fb1; font-variant-numeric: tabular-nums; }
  .mw-step b.mw-dirty { color: #ffd166; }

  .mw-toggles { display: flex; flex-wrap: wrap; gap: 7px; }
  .mw-toggle {
    padding: 6px 13px; border-radius: 16px; font-size: 12px; cursor: pointer; user-select: none;
    background: rgba(255,92,138,.10); border: 1px solid #ff5c8a55; color: #ff9dbd; transition: all .15s;
  }
  .mw-toggle:hover { background: rgba(255,92,138,.22); }
  .mw-toggle.mw-on {
    background: #5c0a26; border-color: #ff5c8a; color: #ffd9e6; font-weight: 600;
    box-shadow: inset 0 2px 6px rgba(0,0,0,.5), 0 0 8px rgba(255,92,138,.25);
  }

  .mw-select-row { display: flex; align-items: center; justify-content: space-between; margin: 7px 0; gap: 10px; }
  .mw-select-row label { font-size: 12px; color: #d6d6de; }
  select.mw-select {
    background: #232329; color: #d6d6de; border: 1px solid #34343d; border-radius: 8px;
    padding: 4px 8px; font-size: 12px; max-width: 56%; cursor: pointer;
  }
  select.mw-select:focus { outline: 1px solid #ff5c8a; }

  .mw-btn {
    display: inline-block; padding: 7px 14px; border-radius: 10px; border: 1px solid #ff5c8a66;
    background: rgba(255,92,138,.12); color: #ffd9e6; font-size: 12px; cursor: pointer; transition: all .15s;
  }
  .mw-btn:hover { background: rgba(255,92,138,.26); }
  .mw-btn.mw-danger { border-color: #ff3355aa; color: #ffb0bb; }

  .mw-note { font-size: 11px; color: #8f8f9b; margin: 4px 0 8px; line-height: 1.4; }
  .mw-preset-tip {
    position: absolute; z-index: 6; max-width: 86%;
    background: #2a2a33; border: 1px solid #ff5c8a66; border-radius: 10px;
    padding: 7px 10px; font-size: 10.5px; line-height: 1.45; color: #d6d6de;
    box-shadow: 0 6px 20px rgba(0,0,0,.6); pointer-events: none;
  }
  .custom-mw-think {
    display: block; margin: 7px 0 2px; border-left: 3px solid #ff5c8a;
    background: rgba(255,92,138,.10); border-radius: 0 10px 10px 0; overflow: hidden;
  }
  .custom-mw-think > summary {
    cursor: pointer; padding: 5px 12px; list-style: none; user-select: none; -webkit-user-select: none;
    color: #ff8fb1; font-weight: 700; font-size: .8em; letter-spacing: 1.5px;
  }
  .custom-mw-think > summary::-webkit-details-marker, .custom-mw-think > summary::marker { display: none; }
  .custom-mw-think-ico::after { content: ' МЫСЛИ ▾'; }
  .custom-mw-think:not([open]) .custom-mw-think-ico::after { content: ' МЫСЛИ ▸'; }
  .custom-mw-think[open] > summary { border-bottom: 1px solid rgba(255,92,138,.18); }
  .custom-mw-think-txt { padding: 7px 12px 8px; font-style: italic; opacity: .92; line-height: 1.5; font-size: .94em; }
  .mw-note.mw-warn { color: #ffd166; }

  .mw-stat-row { display: flex; justify-content: space-between; font-size: 12px; color: #d6d6de; margin: 5px 0; }
  .mw-stat-row b { color: #ff8fb1; font-variant-numeric: tabular-nums; }

  .mw-hist { margin: 6px 0; padding: 8px 10px; border: 1px solid #2a2a33; border-radius: 10px; background: #18181e; }
  .mw-hist-head { display: flex; justify-content: space-between; align-items: center; font-size: 12px; color: #ff8fb1; font-weight: 700; }
  .mw-hist-notes { font-size: 11px; color: #9b9ba8; margin-top: 3px; line-height: 1.45; }
  .mw-hist .mw-btn { padding: 3px 9px; font-size: 10px; }

  .mw-footer { flex: 0 0 auto; padding: 8px 14px 12px; border-top: 1px solid #26262e; background: #17171d; }
  .mw-flash { text-align: center; font-size: 10px; letter-spacing: 2px; color: #ffd166; min-height: 14px; margin-bottom: 4px; }
  input.mw-custom {
    width: 100%; margin-bottom: 8px; background: #232329; border: 1px solid #34343d;
    border-radius: 10px; padding: 7px 10px; color: #ececf2; font-size: 12px;
  }
  input.mw-custom::placeholder { color: #76767f; }
  input.mw-custom:focus { outline: 1px solid #ff5c8a; }
  .mw-footrow { display: flex; gap: 8px; }
  .mw-apply {
    flex: 1; padding: 12px; border-radius: 14px; border: 1px solid #ff8fb1;
    background: linear-gradient(135deg, #8c1d40, #5c0a26); color: #ffd9e6;
    font-size: 14px; font-weight: 800; letter-spacing: 2px; cursor: pointer; transition: all .2s;
  }
  .mw-apply.mw-ready { background: linear-gradient(135deg, #ff5c8a, #a31246); box-shadow: 0 0 16px rgba(255,92,138,.45); }
  .mw-apply:active { transform: scale(.98); }
  .mw-iconbtn {
    flex: 0 0 46px; border-radius: 14px; border: 1px solid #ff5c8a66;
    background: rgba(255,92,138,.12); color: #ffd9e6; font-size: 17px; cursor: pointer; transition: all .15s;
  }
  .mw-iconbtn:hover { background: rgba(255,92,138,.28); }
  .mw-iconbtn.mw-on { background: rgba(95,208,224,.22); border-color: #5fd0e0; color: #cdf3f8; }
  .mw-panel.mw-calibrating .mw-apply { background: linear-gradient(135deg, #2b8a9e, #14506a); border-color: #5fd0e0; color: #eafaff; }
  .mw-panel.mw-calibrating .mw-apply.mw-ready { box-shadow: 0 0 16px rgba(95,208,224,.5); }

  .mw-sync-screen { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 18px; padding: 24px; text-align: center; position: relative; }
  .mw-sync-close { position: absolute; top: 12px; right: 14px; background: none; border: none; color: #8f8f9b; font-size: 22px; cursor: pointer; padding: 4px 8px; line-height: 1; z-index: 2; }
  .mw-sync-close:hover { color: #fff; }
  .mw-sync-logo { font-size: 44px; filter: drop-shadow(0 0 12px rgba(255,92,138,.6)); }
  .mw-sync-title { font-size: 19px; font-weight: 800; letter-spacing: 3px; color: #ff5c8a; }
  .mw-sync-sub { font-size: 12px; color: #8f8f9b; line-height: 1.5; max-width: 260px; }
  .mw-sync-btn {
    padding: 14px 38px; border-radius: 16px; font-size: 15px; font-weight: 800; letter-spacing: 2.5px;
    border: 1px solid #ff8fb1; background: linear-gradient(135deg, #ff5c8a, #a31246); color: #fff;
    cursor: pointer; box-shadow: 0 0 22px rgba(255,92,138,.5); transition: transform .15s;
  }
  .mw-sync-btn:hover { transform: scale(1.05); }
  .mw-sync-err { color: #ff7d8d; font-size: 12px; min-height: 16px; }

  .mw-loader {
    flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 14px; padding: 30px; text-align: center;
  }
  .mw-loader-logo { font-size: 52px; animation: mwglow 1.6s ease-in-out infinite; }
  @keyframes mwglow {
    0%, 100% { filter: drop-shadow(0 0 6px rgba(255,92,138,.4)); transform: scale(1); }
    50% { filter: drop-shadow(0 0 26px rgba(255,92,138,.95)); transform: scale(1.07); }
  }
  .mw-loader-title { font-size: 21px; font-weight: 800; letter-spacing: 6px; color: #ff5c8a; }
  .mw-loader-title span { color: #ececf2; }
  .mw-loader-target { font-size: 11px; letter-spacing: 2px; color: #8f8f9b; min-height: 14px; }
  .mw-loader-bar { width: 78%; height: 4px; border-radius: 3px; background: #1d1d23; border: 1px solid #2c2c35; overflow: hidden; }
  .mw-loader-fill { height: 100%; width: 0%; border-radius: 3px; background: linear-gradient(90deg, #ff5c8a, #ff8fb1); transition: width .45s ease; box-shadow: 0 0 8px rgba(255,92,138,.8); }
  .mw-loader-line { font-size: 11px; letter-spacing: 1.5px; color: #ff9dbd; min-height: 15px; animation: mwfade .9s ease infinite alternate; }
  @keyframes mwfade { from { opacity: .45; } to { opacity: 1; } }
  .mw-loader-done { color: #ffd166; animation: none; font-weight: 700; }

  .mw-alert, .mw-menu {
    position: absolute; inset: 0; z-index: 5; display: flex; flex-direction: column;
    align-items: center; justify-content: center; gap: 10px;
    background: rgba(10,10,14,.93); text-align: center;
  }
  .mw-alert-title { color: #ff3355; font-weight: 800; letter-spacing: 2.5px; font-size: 15px; animation: mwpulse .7s infinite; }
  .mw-alert-name { color: #ececf2; font-size: 20px; font-weight: 800; letter-spacing: 1px; }
  .mw-alert-sub { color: #8f8f9b; font-size: 11px; letter-spacing: 2px; }
  .mw-alert.mw-crit { background: rgba(20,0,4,.96); }
  .mw-alert.mw-crit .mw-alert-title { font-size: 17px; animation: mwjitter 1.2s steps(2) infinite, mwpulse .5s infinite; }
  .mw-menu-box {
    background: #1c1c23; border: 1px solid #2a2a33; border-radius: 18px;
    padding: 18px 22px; display: flex; flex-direction: column; gap: 10px; min-width: 240px; max-width: 86%;
  }
  .mw-menu-box .mw-btn { width: 100%; padding: 10px; }
  .mw-menu-box .mw-note { text-align: center; }

  /* ---- light theme ---- */
  .mw-panel.mw-light { background: #f3f3f7; color: #1c1c24; }
  .mw-panel.mw-light .mw-header,
  .mw-panel.mw-light .mw-subjbar,
  .mw-panel.mw-light .mw-nav,
  .mw-panel.mw-light .mw-footer { background: #e7e7ee; }
  .mw-panel.mw-light .mw-nav { border-bottom-color: #d6d6de; }
  .mw-panel.mw-light .mw-card { background: #fff; border-color: #e2e2e9; }
  .mw-panel.mw-light .mw-logo span { color: #1c1c24; }
  .mw-panel.mw-light .mw-headinfo,
  .mw-panel.mw-light .mw-card-title,
  .mw-panel.mw-light .mw-grp,
  .mw-panel.mw-light .mw-note,
  .mw-panel.mw-light .mw-subjname,
  .mw-panel.mw-light .mw-range-ends,
  .mw-panel.mw-light .mw-nav button { color: #74747e; }
  .mw-panel.mw-light .mw-slider-top,
  .mw-panel.mw-light .mw-select-row label,
  .mw-panel.mw-light .mw-stat-row { color: #33333c; }
  .mw-panel.mw-light .mw-nav button.mw-active { color: #1c1c24; }
  .mw-panel.mw-light select.mw-select,
  .mw-panel.mw-light input.mw-custom,
  .mw-panel.mw-light .mw-val-input,
  .mw-panel.mw-light .mw-subj,
  .mw-panel.mw-light .mw-seg div { background: #ececf2; border-color: #d6d6de; color: #33333c; }
  .mw-panel.mw-light input.mw-range { background: #d4d4dd; }
  .mw-panel.mw-light .mw-hist { background: #f0f0f5; border-color: #e2e2e9; }
  .mw-panel.mw-light .mw-close { color: #9a9aa4; }
  .mw-panel.mw-light .mw-close:hover { color: #1c1c24; }
  `;

  /* ================= UI: SHELL ================= */

  let root, panel, bubble;

  function buildShell() {
    const old = D.getElementById(ROOT_ID); if (old) old.remove();
    const oldS = D.getElementById(STYLE_ID); if (oldS) oldS.remove();
    panelOpen = false;

    const style = D.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    D.head.appendChild(style);

    root = D.createElement('div');
    root.id = ROOT_ID;
    D.body.appendChild(root);

    bubble = D.createElement('div');
    bubble.className = 'mw-bubble';
    bubble.innerHTML = '🧠';
    let pos = null;
    try { pos = JSON.parse(W.localStorage.getItem(POS_KEY)); } catch (e) { /* ignore */ }
    // a position saved off-screen (e.g. window resized, rotation) would hide the widget
    if (pos && (!Number.isFinite(pos.x) || !Number.isFinite(pos.y) ||
      pos.x < -10 || pos.y < -10 || pos.x > W.innerWidth - 30 || pos.y > W.innerHeight - 30)) pos = null;
    // no saved position -> spawn dead center so it can never be lost off-screen
    if (!pos) pos = { x: Math.max(2, (W.innerWidth - 52) / 2), y: Math.max(2, (W.innerHeight - 52) / 2) };
    bubble.style.right = 'auto';
    bubble.style.bottom = 'auto';
    bubble.style.left = pos.x + 'px';
    bubble.style.top = pos.y + 'px';
    root.appendChild(bubble);

    panel = D.createElement('div');
    panel.className = 'mw-panel';
    panel.style.display = 'none';
    root.appendChild(panel);

    makeDraggable();
    makePanelDraggable();
  }

  /* ----- panel: scale, placement, drag (never off-screen) ----- */

  function uiScale() {
    let v = 100;
    try { v = parseInt(W.localStorage.getItem(SCALE_KEY), 10) || 100; } catch (e) { /* ignore */ }
    return Math.min(110, Math.max(60, v)) / 100;
  }

  function applyUiScale() {
    const k = uiScale();
    panel.style.transformOrigin = 'top left';
    panel.style.transform = k === 1 ? '' : 'scale(' + k + ')';
  }

  // move the panel to x/y, clamped so it stays fully on screen
  function placePanel(x, y) {
    const r = panel.getBoundingClientRect();
    const maxX = Math.max(0, W.innerWidth - r.width);
    const maxY = Math.max(0, W.innerHeight - r.height);
    panel.style.left = Math.min(maxX, Math.max(0, x)) + 'px';
    panel.style.top = Math.min(maxY, Math.max(0, y)) + 'px';
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
  }

  // on open / resize: saved position (clamped) or dead center
  function positionPanel() {
    if (!panel || panel.style.display === 'none') return;
    applyUiScale();
    panel.style.width = Math.min(385, Math.round(W.innerWidth * 0.96)) + 'px';
    let pos = null;
    try { pos = JSON.parse(W.localStorage.getItem(PANEL_POS_KEY)); } catch (e) { /* ignore */ }
    if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
      placePanel(pos.x, pos.y);
    } else {
      const r = panel.getBoundingClientRect();
      placePanel((W.innerWidth - r.width) / 2, (W.innerHeight - r.height) / 2);
    }
  }

  // drag by the header; delegation survives re-renders of the header
  function makePanelDraggable() {
    panel.addEventListener('pointerdown', e => {
      const head = e.target.closest('.mw-header');
      if (!head || e.target.closest('.mw-close')) return;
      e.preventDefault();
      try { panel.setPointerCapture(e.pointerId); } catch (e2) { /* ignore */ }
      const r = panel.getBoundingClientRect();
      const sx = e.clientX, sy = e.clientY, ox = r.left, oy = r.top;
      let dragging = true;
      const mv = ev => { if (dragging) placePanel(ox + ev.clientX - sx, oy + ev.clientY - sy); };
      const end = () => {
        dragging = false;
        panel.removeEventListener('pointermove', mv);
        panel.removeEventListener('pointerup', end);
        panel.removeEventListener('pointercancel', end);
        const r2 = panel.getBoundingClientRect();
        try { W.localStorage.setItem(PANEL_POS_KEY, JSON.stringify({ x: r2.left, y: r2.top })); } catch (e2) { /* ignore */ }
      };
      panel.addEventListener('pointermove', mv);
      panel.addEventListener('pointerup', end);
      panel.addEventListener('pointercancel', end);
    });
  }

  // rotation / keyboard / resize can leave the bubble off-screen: pull it back
  function clampBubble() {
    if (!bubble || !D.getElementById(ROOT_ID)) return;
    const r = bubble.getBoundingClientRect();
    const x = Math.min(W.innerWidth - 54, Math.max(2, r.left));
    const y = Math.min(W.innerHeight - 54, Math.max(2, r.top));
    if (Math.abs(x - r.left) > 1 || Math.abs(y - r.top) > 1) {
      bubble.style.left = x + 'px';
      bubble.style.top = y + 'px';
      bubble.style.right = 'auto';
      bubble.style.bottom = 'auto';
      try { W.localStorage.setItem(POS_KEY, JSON.stringify({ x, y })); } catch (e) { /* ignore */ }
    }
  }

  function onWinResize() {
    clampBubble();
    if (panelOpen) positionPanel();
  }

  // mobile ST sometimes rebuilds the page and our widget goes with it — rebuild
  let watchdog = null;
  function startWatchdog() {
    clearInterval(watchdog);
    watchdog = setInterval(() => {
      try {
        if (!D.getElementById(ROOT_ID)) {
          console.warn('[MindWare] UI lost, rebuilding');
          buildShell();
          updateFooter();
        }
      } catch (e) { /* ignore */ }
    }, 4000);
  }

  function pulseBubble() {
    bubble.classList.remove('mw-ping');
    void bubble.offsetWidth;
    bubble.classList.add('mw-ping');
  }

  function makeDraggable() {
    let sx, sy, ox, oy, moved;
    let lastTapHandled = 0;

    const tap = () => { lastTapHandled = Date.now(); togglePanel(); };

    bubble.addEventListener('pointerdown', e => {
      e.preventDefault();
      try { bubble.setPointerCapture(e.pointerId); } catch (e2) { /* ignore */ }
      const r = bubble.getBoundingClientRect();
      sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top; moved = false;

      const mv = ev => {
        const dx = ev.clientX - sx, dy = ev.clientY - sy;
        if (Math.abs(dx) + Math.abs(dy) > 6) moved = true;
        if (!moved) return;
        const x = Math.min(W.innerWidth - 54, Math.max(2, ox + dx));
        const y = Math.min(W.innerHeight - 54, Math.max(2, oy + dy));
        bubble.style.left = x + 'px'; bubble.style.top = y + 'px';
        bubble.style.right = 'auto'; bubble.style.bottom = 'auto';
      };
      const done = wasCancel => {
        bubble.removeEventListener('pointermove', mv);
        bubble.removeEventListener('pointerup', up);
        bubble.removeEventListener('pointercancel', cancel);
        if (moved) {
          const r2 = bubble.getBoundingClientRect();
          try { W.localStorage.setItem(POS_KEY, JSON.stringify({ x: r2.left, y: r2.top })); } catch (e2) { /* ignore */ }
        } else if (!wasCancel) {
          tap();
        }
      };
      const up = () => done(false);
      const cancel = () => done(true);
      bubble.addEventListener('pointermove', mv);
      bubble.addEventListener('pointerup', up);
      bubble.addEventListener('pointercancel', cancel);
    });

    // some mobile browsers fire a native click right after pointerup
    // (would instantly re-toggle the panel shut); others may not deliver
    // pointer events at all — this single guarded handler covers both
    bubble.addEventListener('click', () => {
      if (Date.now() - lastTapHandled > 450) tap();
    });
  }

  function togglePanel() {
    panelOpen = !panelOpen;
    panel.style.display = panelOpen ? 'flex' : 'none';
    if (panelOpen) {
      positionPanel();
      if (!booted) {
        booted = true;
        const boot = showLoaderScreen('NEURAL INTERFACE', t('boot_lines'), false);
        boot.finish('READY', () => renderApp());
      } else renderApp();
    }
  }

  function confirmDialog(text, onYes, sub) {
    const m = D.createElement('div');
    m.className = 'mw-menu';
    m.innerHTML = `
      <div class="mw-menu-box">
        <div class="mw-note mw-warn">${esc(text)}</div>
        ${sub ? `<div class="mw-note" style="font-size:9.5px;opacity:.75;margin-top:-2px">${esc(sub)}</div>` : ''}
        <button class="mw-btn mw-danger" id="mw-cf-yes">${t('ui_yes')}</button>
        <button class="mw-btn" id="mw-cf-no">${t('ui_no')}</button>
      </div>`;
    panel.appendChild(m);
    m.querySelector('#mw-cf-yes').addEventListener('click', () => { m.remove(); onYes(); });
    m.querySelector('#mw-cf-no').addEventListener('click', () => m.remove());
  }

  /* ================= UI: LOADER ================= */

  function showLoaderScreen(target, lines, cycle) {
    panel.innerHTML = `
      <div class="mw-loader">
        <div class="mw-loader-logo">🧠</div>
        <div class="mw-loader-title">MIND<span>WARE</span></div>
        <div class="mw-loader-target">${esc(target)}</div>
        <div class="mw-loader-bar"><div class="mw-loader-fill" id="mw-lfill"></div></div>
        <div class="mw-loader-line" id="mw-lline">&nbsp;</div>
      </div>`;
    const fill = panel.querySelector('#mw-lfill');
    const line = panel.querySelector('#mw-lline');
    let i = 0, alive = true, finished = false;
    const step = () => {
      if (!alive || finished) return;
      line.textContent = lines[i % lines.length];
      const pct = cycle
        ? Math.min(92, 12 + (i * 13) % 81)
        : Math.min(96, Math.round(((i + 1) / lines.length) * 100));
      fill.style.width = pct + '%';
      i++;
      if (!cycle && i >= lines.length) return;
      timer = setTimeout(step, cycle ? 850 : 330);
    };
    let timer = setTimeout(step, 60);
    return {
      stop() { alive = false; clearTimeout(timer); },
      finish(doneText, then) {
        const wrap = () => {
          finished = true; alive = false; clearTimeout(timer);
          fill.style.width = '100%';
          line.textContent = doneText;
          line.classList.add('mw-loader-done');
          setTimeout(then, 700);
        };
        if (cycle) wrap();
        else setTimeout(wrap, lines.length * 330 + 150);
      },
    };
  }

  function renderSyncScreen(err) {
    // GROUP chat: pick which character to link as the main subject — no auto-connect
    const members = getGroupMemberChars();
    if (members && members.length) {
      panel.innerHTML = `
        <div class="mw-sync-screen">
          <button class="mw-sync-close" id="mw-sync-close" title="${esc(t('ui_close'))}">✕</button>
          <div class="mw-sync-logo">🧠</div>
          <div class="mw-sync-title">MIND<span style="color:#ececf2">WARE</span></div>
          <div class="mw-sync-sub">${t('sy_group')}</div>
          ${members.map((m, i) => `<button class="mw-btn" data-ci="${i}" style="min-width:220px">${esc(m.name)}</button>`).join('')}
          <div class="mw-sync-err">${esc(err || '')}</div>
        </div>`;
      panel.querySelectorAll('.mw-btn[data-ci]').forEach(b =>
        b.addEventListener('click', () => runSync(members[Number(b.dataset.ci)])));
      panel.querySelector('#mw-sync-close').addEventListener('click', togglePanel);
      return;
    }
    panel.innerHTML = `
      <div class="mw-sync-screen">
        <button class="mw-sync-close" id="mw-sync-close" title="${esc(t('ui_close'))}">✕</button>
        <div class="mw-sync-logo">🧠</div>
        <div class="mw-sync-title">MIND<span style="color:#ececf2">WARE</span></div>
        <div class="mw-sync-sub">${t('sy_sub')}</div>
        <button class="mw-sync-btn" id="mw-sync">${t('sy_btn')}</button>
        <div class="mw-toggles" style="justify-content:center">
          <button class="mw-btn" id="mw-sync-self">${t('ui_add_self')} (${esc(mac('{{user}}'))})</button>
          <button class="mw-btn" id="mw-sync-npc">${t('sy_npc')}</button>
        </div>
        <div class="mw-sync-err">${esc(err || '')}</div>
      </div>`;
    panel.querySelector('#mw-sync').addEventListener('click', () => runSync());
    panel.querySelector('#mw-sync-self').addEventListener('click', () => { initBlindChar(); addSelf(); });
    panel.querySelector('#mw-sync-npc').addEventListener('click', () => { initBlindChar(); scanScene(); });
    panel.querySelector('#mw-sync-close').addEventListener('click', togglePanel);
  }

  /* ================= UI: MAIN APP ================= */

  function renderApp() {
    if (!state.synced) { renderSyncScreen(); return; }
    panel.innerHTML = `
      <div class="mw-header">
        <div class="mw-logo">MIND<span>WARE</span></div>
        <div class="mw-headinfo">
          <div>${t('ui_firmware')} ${vstr(state.version)} · ${t('ui_link')}</div>
        </div>
        <button class="mw-close" id="mw-close">✕</button>
      </div>
      <div class="mw-subjbar" id="mw-subjbar"></div>
      <div class="mw-nav" id="mw-nav"></div>
      <div class="mw-psyche">
        <div class="mw-psyche-label"><span id="mw-psyche-lbl">${t('ui_psyche')}</span><span id="mw-psyche-num"></span></div>
        <div class="mw-psyche-bar"><div class="mw-psyche-fill" id="mw-psyche-fill"></div></div>
      </div>
      <div class="mw-content" id="mw-content"></div>
      <div class="mw-footer">
        <div class="mw-flash" id="mw-flash"></div>
        <input class="mw-custom" id="mw-custom" placeholder="${esc(t('ui_custom_ph'))}" value="${esc(state.custom)}">
        <div class="mw-footrow">
          <button class="mw-iconbtn" id="mw-discard" title="${esc(t('ui_discard'))}">↺</button>
          <button class="mw-iconbtn" id="mw-calibrate" title="${esc(t('ui_calib_title'))}">🔧</button>
          <button class="mw-apply" id="mw-apply">${t('ui_apply')}</button>
          <button class="mw-iconbtn" id="mw-dice" title="Chaos">🎲</button>
        </div>
      </div>`;
    panel.querySelector('#mw-close').addEventListener('click', togglePanel);
    panel.querySelector('#mw-apply').addEventListener('click', () => calibrating ? commitCalibration() : applyChanges());
    panel.querySelector('#mw-dice').addEventListener('click', rollChaos);
    panel.querySelector('#mw-discard').addEventListener('click', discardDraft);
    panel.querySelector('#mw-calibrate').addEventListener('click', () => {
      calibrating = !calibrating;
      panel.classList.toggle('mw-calibrating', calibrating);
      if (calibrating) flashApply(t('ui_calib_on'));
      updateFooter();
    });
    panel.classList.toggle('mw-calibrating', calibrating);
    panel.classList.toggle('mw-light', getTheme() === 'light');
    const custom = panel.querySelector('#mw-custom');
    custom.addEventListener('input', () => { state.custom = custom.value; save(); updateFooter(); });
    custom.addEventListener('keydown', e => { if (e.key === 'Enter') calibrating ? commitCalibration() : applyChanges(); });
    renderSubjBar();
    renderNav();
    renderTab();
    updateFooter();
  }

  function renderSubjBar() {
    const bar = panel.querySelector('#mw-subjbar');
    if (!bar) return;
    let avatarSrc = null, personaSrc = null;
    try { avatarSrc = getCharAvatarPath(state.charAvatar); } catch (e) { /* ignore */ }
    try { personaSrc = getPersonaAvatarPath(); } catch (e) { /* ignore */ }
    const chips = allRefs().map(ref => {
      const sid = sidOf(ref);
      const active = state.selSubj === sid ? 'mw-on' : '';
      let inner;
      if (ref === state && avatarSrc) inner = `<img src="${esc(avatarSrc)}" onerror="this.remove()">`;
      else if (ref !== state && ref.kind === 'user') {
        let src = personaSrc; // legacy user subject with no persona → current persona
        if (ref.persona) { try { src = getContext().getThumbnailUrl('persona', ref.persona); } catch (e) { src = personaSrc; } }
        inner = src ? `<img src="${esc(src)}" onerror="this.replaceWith(document.createTextNode('👤'))">` : '👤';
      } else inner = esc((subjName(ref) || '?')[0].toUpperCase());
      return `<div class="mw-subj ${active}" data-sid="${esc(sid)}" title="${esc(subjName(ref))}">${inner}</div>`;
    }).join('');
    const cur = subj();
    bar.innerHTML = chips +
      `<div class="mw-subj mw-subjadd" id="mw-addsubj">+</div>` +
      `<div class="mw-subjname">${esc(subjName(cur))}${isEditable(cur) ? '' : ' 🔒'}</div>`;
    bar.querySelectorAll('.mw-subj[data-sid]').forEach(el => {
      el.addEventListener('click', () => {
        state.selSubj = el.dataset.sid;
        save();
        renderSubjBar(); renderTab(); updateFooter();
      });
    });
    bar.querySelector('#mw-addsubj').addEventListener('click', showSubjMenu);
  }

  function showSubjMenu() {
    const m = D.createElement('div');
    m.className = 'mw-menu';
    m.innerHTML = `
      <div class="mw-menu-box">
        <div class="mw-card-title">${t('ui_addsubj')}</div>
        <button class="mw-btn" id="mw-add-self">${t('ui_add_self')} (${esc(mac('{{user}}'))})</button>
        <button class="mw-btn" id="mw-add-scan">${t('ui_scan_scene')}</button>
        <button class="mw-btn mw-danger" id="mw-add-cancel">${t('ui_cancel')}</button>
      </div>`;
    panel.appendChild(m);
    const self = m.querySelector('#mw-add-self');
    if (self) self.addEventListener('click', () => { m.remove(); canAddSubject(addSelf); });
    m.querySelector('#mw-add-scan').addEventListener('click', () => { m.remove(); scanScene(); });
    m.querySelector('#mw-add-cancel').addEventListener('click', () => m.remove());
  }

  function renderScenePick(names) {
    panel.innerHTML = `
      <div class="mw-sync-screen">
        <button class="mw-sync-close" id="mw-sync-close" title="${esc(t('ui_close'))}">✕</button>
        <div class="mw-sync-logo">🧠</div>
        <div class="mw-sync-title">${t('ui_scene_pick')}</div>
        ${names.length
          ? names.map((n, i) => `<button class="mw-btn" data-i="${i}" style="min-width:200px">${esc(n)}</button>`).join('')
          : `<div class="mw-sync-sub">${t('ui_scene_none')}</div>`}
        <button class="mw-btn mw-danger" id="mw-scene-back">${t('ui_back')}</button>
      </div>`;
    panel.querySelectorAll('.mw-btn[data-i]').forEach(b =>
      b.addEventListener('click', () => canAddSubject(() => addNpc(names[Number(b.dataset.i)]))));
    panel.querySelector('#mw-scene-back').addEventListener('click', renderApp);
    panel.querySelector('#mw-sync-close').addEventListener('click', togglePanel);
  }

  function renderNav() {
    const nav = panel.querySelector('#mw-nav');
    if (!nav) return;
    const tabs = [['body', t('ui_tab_body')], ['mind', t('ui_tab_mind')]];
    if (state.settings.extreme) tabs.push(['extreme', t('ui_tab_extreme')]);
    if (state.settings.biolab) tabs.push(['bio', t('ui_tab_bio')]);
    tabs.push(['sys', t('ui_tab_sys')]);
    nav.innerHTML = tabs.map(([id, lb]) =>
      `<button data-tab="${id}" class="${activeTab === id ? 'mw-active' : ''} ${id === 'extreme' ? 'mw-xtab' : ''} ${id === 'bio' ? 'mw-btab' : ''}">${lb}</button>`).join('');
    nav.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
      activeTab = b.dataset.tab; renderNav(); renderTab(); updateFooter();
    }));
  }

  function card(title, inner) {
    return `<div class="mw-card"><div class="mw-card-title">${title}</div>${inner}</div>`;
  }

  function sliderRow([, key, min, max, , , kind]) {
    const S = subj();
    if (key === 'height') { const r = heightRange(S.draft); min = r[0]; max = r[1]; }
    const v = S.draft[key];
    const dirty = S.applied[key] !== v;
    let ends = '';
    if (kind === 'voice') ends = `<div class="mw-range-ends"><span>${t('v_Deep')}</span><span>${t('v_Squeaky')}</span></div>`;
    if (kind === 'att') ends = `<div class="mw-range-ends"><span>${t('at_Hatred')}</span><span>${t('at_Love')}</span></div>`;
    if (kind === 'mor') ends = `<div class="mw-range-ends"><span>${t('mo_Puritan')}</span><span>${t('mo_Depraved')}</span></div>`;
    if (kind === 'perc') ends = `<div class="mw-range-ends"><span>${t('pc_Clear')}</span><span>${t('pc_Obsession')}</span></div>`;
    if (kind === 'role') ends = `<div class="mw-range-ends"><span>${t('ro_Dominant')}</span><span>${t('ro_Servant')}</span></div>`;
    if (kind === 'est') ends = `<div class="mw-range-ends"><span>${t('es_Low')}</span><span>${t('es_High')}</span></div>`;
    if (kind === 'kink') ends = `<div class="mw-range-ends"><span>${t('ki_Unaware')}</span><span>${t('ki_Addicted')}</span></div>`;
    if (kind === 'cups') ends = `<div class="mw-range-ends"><span>${CUPS[0]}</span><span>${CUPS[CUPS.length - 1]}</span></div>`;
    return `
      <div class="mw-slider-row">
        <div class="mw-slider-top">
          <span>${esc(pLabel(key))}</span>
          <span class="mw-val ${dirty ? 'mw-dirty' : ''}" id="mw-val-${key}" data-valkey="${key}" title="${esc(t('ui_tap_edit'))}">${esc(fmtVal(key, v))}</span>
        </div>
        <div class="mw-range-wrap">
          <button class="mw-mini" data-nudge="${key}" data-d="-1">−</button>
          <input class="mw-range" type="range" min="${min}" max="${max}" value="${v}" data-key="${key}">
          <button class="mw-mini" data-nudge="${key}" data-d="1">+</button>
        </div>
        ${ends}
      </div>`;
  }

  // effective [min,max] for a slider key (height depends on scale)
  function sliderRange(key) {
    const d = sliderDef(key);
    let min = d[2], max = d[3];
    if (key === 'height') { const r = heightRange(subj().draft); min = r[0]; max = r[1]; }
    return [min, max];
  }
  // set a slider's draft value and refresh its input + label in place
  function setSliderVal(c, key, v) {
    const [min, max] = sliderRange(key);
    v = Math.min(max, Math.max(min, Math.round(Number(v))));
    if (!Number.isFinite(v)) return;
    const S = subj();
    S.draft[key] = v;
    const inp = c.querySelector(`input.mw-range[data-key="${key}"]`);
    if (inp) inp.value = v;
    const lbl = c.querySelector('#mw-val-' + key);
    if (lbl) { lbl.textContent = fmtVal(key, v); lbl.classList.toggle('mw-dirty', S.applied[key] !== v); }
    save(); updateFooter();
  }

  function stepperRow([, key, min, max]) {
    const S = subj();
    const v = S.draft[key];
    const dirty = S.applied[key] !== v;
    return `
      <div class="mw-select-row">
        <label>${esc(pLabel(key))}</label>
        <span class="mw-step">
          <button data-stepkey="${key}" data-d="-1" data-min="${min}" data-max="${max}">−</button>
          <b id="mw-val-${key}" class="${dirty ? 'mw-dirty' : ''}">${v}</b>
          <button data-stepkey="${key}" data-d="1" data-min="${min}" data-max="${max}">+</button>
        </span>
      </div>`;
  }

  function toggleChip([, key]) {
    return `<div class="mw-toggle ${subj().draft[key] ? 'mw-on' : ''}" data-key="${key}">${esc(pLabel(key))}</div>`;
  }

  // dropdown to pick whom the current subject's "attitude" is directed at
  function affTargetSelect() {
    const cur = subj();
    const opts = [['user', mac('{{user}}') || 'user']];
    if (cur !== state) opts.push(['char', subjName(state)]);
    allRefs().forEach(r => { if (r !== cur && r !== state) opts.push([sidOf(r), subjName(r)]); });
    const val = affTargetTok(cur);
    return `<div class="mw-select-row"><label>${t('ui_afftarget')}</label>
      <select class="mw-select" id="mw-afftarget">
        ${opts.map(([tok, nm]) => `<option value="${esc(tok)}" ${val === tok ? 'selected' : ''}>${esc(nm)}</option>`).join('')}
      </select></div>`;
  }

  // sort a flat option list by its localized label, pinning neutral firsts.
  // Lists with a meaningful order (depth/speed/tiers) opt out via SORT_SKIP.
  const SORT_PIN = ['None', 'Default', 'Original', 'Normal', 'Human'];
  const SORT_SKIP = ['memory_wipe', 'gestation'];
  function sortByLabel(labelFn, items) {
    const pinned = items.filter(o => SORT_PIN.includes(o));
    const rest = items.filter(o => !SORT_PIN.includes(o)).slice()
      .sort((a, b) => labelFn(a).localeCompare(labelFn(b), undefined, { sensitivity: 'base' }));
    return pinned.concat(rest);
  }

  function selectRow([, key, opts]) {
    let options = opts;
    if (key === 'outfit' && !state.settings.extreme) {
      options = opts.filter(o => !OUTFITS_X.includes(o) || subj().draft.outfit === o);
    }
    if (!SORT_SKIP.includes(key)) options = sortByLabel(o => tOpt(key, o), options);
    return `
      <div class="mw-select-row">
        <label>${esc(pLabel(key))}</label>
        <select class="mw-select" data-key="${key}">
          ${options.map(o => `<option value="${esc(o)}" ${subj().draft[key] === o ? 'selected' : ''}>${esc(tOpt(key, o))}</option>`).join('')}
        </select>
      </div>`;
  }

  function chipGroup(stateKey, items, pfx) {
    const arr = subj().draft[stateKey] || [];
    const sorted = sortByLabel(z => t(pfx + z), items);
    return `<div class="mw-toggles">${sorted.map(z =>
      `<div class="mw-toggle mw-chip ${arr.includes(z) ? 'mw-on' : ''}" data-group="${stateKey}" data-chip="${esc(z)}">${esc(t(pfx + z))}</div>`).join('')}</div>`;
  }

  function segRow(key, opts, dataAttr) {
    return `<div class="mw-seg">${opts.map(o =>
      `<div class="${subj().draft[key] === o ? 'mw-on' : ''}" data-${dataAttr}="${esc(o)}">${esc(tOpt(key, o))}</div>`).join('')}</div>`;
  }

  function renderTab() {
    const c = panel.querySelector('#mw-content');
    if (!c) return;
    if (activeTab === 'sys') { c.innerHTML = tabSys(); wireTab(c); return; }
    const ed = isEditable(subj());
    let html;
    if (activeTab === 'body') html = tabBody();
    else if (activeTab === 'mind') html = tabMind();
    else if (activeTab === 'extreme') html = tabExtreme();
    else html = tabBio();
    c.innerHTML = (ed ? '' : `<div class="mw-note mw-warn">${t('ui_ro_note')}</div>`) +
      `<div class="${ed ? '' : 'mw-ro'}">${html}</div>`;
    wireTab(c);
  }

  function tabBody() {
    const x = state.settings.extreme;
    const tatZones = TAT_ZONES.filter(z => z !== 'Womb' || x);
    const pierceZones = PIERCE_ZONES.filter(z => !['Nipples', 'Intimate'].includes(z) || x);
    const physKeys = ['height', 'weight', 'apparent_age', 'bust', 'hips', 'strength', 'flexibility', 'voice_pitch', 'pain_threshold', 'perception'];
    const appearSelects = ['body_type', 'eye_color', 'eye_type', 'hair_color', 'hair_style', 'hair_texture', 'skin_tone', 'resting_face', 'makeup'];
    const wardToggles = TOGGLES.filter(t2 => t2[3] === 'wardrobe' && (t2[1] !== 'body_writing' || x));
    return [
      card(t('s_gender'), segRow('gender', SELECTS.find(s => s[1] === 'gender')[2], 'gender')),
      card(t('s_physique'), physKeys.map(k => sliderRow(sliderDef(k))).join('')),
      card(t('s_appearance'),
        appearSelects.map(k => selectRow(SELECTS.find(s => s[1] === k))).join('') +
        sliderRow(sliderDef('hair_length')) + sliderRow(sliderDef('hairiness')) + sliderRow(sliderDef('wear_tear'))),
      card(t('s_tattoos'), chipGroup('tattoos', tatZones, 'z_')),
      card(t('s_piercings'), chipGroup('piercings', pierceZones, 'pz_')),
      card(t('s_features'),
        `<div class="mw-toggles">${TOGGLES.filter(t2 => t2[3] === 'features').map(toggleChip).join('')}</div>` +
        selectRow(SELECTS.find(s => s[1] === 'feature_type'))),
      card(t('s_wardrobe'),
        selectRow(SELECTS.find(s => s[1] === 'outfit')) +
        `<div class="mw-toggles">${wardToggles.map(toggleChip).join('')}</div>`),
      card(t('s_accessories'),
        chipGroup('accessories', ACCESSORIES, 'ac_') +
        (x ? '<div style="height:7px"></div>' + chipGroup('accessories_x', ACCESSORIES_X, 'ax_') : '')),
      card(t('s_bodypresets'),
        `<div class="mw-toggles mw-list">${Object.keys(BODY_PRESETS).map(p =>
          `<div class="mw-toggle mw-preset" data-preset="b:${esc(p)}">${esc(t('pr_' + p))}</div>`).join('')}</div>
         <div class="mw-note">${t('ui_preset_note')}</div>`),
    ].join('');
  }

  function tabMind() {
    const pulses = PULSES.concat(state.settings.extreme ? PULSES_X : []);
    const sid = sidOf(subj());
    const aw = subj().awareness || 'full';
    const awSeg = `<div class="mw-seg">${AWARE_MODES.map(m =>
      `<div class="${aw === m ? 'mw-on' : ''}" data-aware="${m}">${t('aw_' + m)}</div>`).join('')}</div>
      <div class="mw-note">${t('ui_aware_note')}</div>`;
    const grp = (label, keys) => `<div class="mw-grp">${t(label)}</div>` + keys.map(k => sliderRow(sliderDef(k))).join('');
    const memoVal = state.memo && state.memo.sid === sid ? state.memo.text : '';
    return [
      card(t('s_core'), sliderRow(sliderDef('personality')) + selectRow(SELECTS.find(s => s[1] === 'orientation'))),
      card(t('s_awareness'), awSeg),
      card(t('s_matrix'),
        grp('g_intellect', ['intelligence', 'charisma']) +
        grp('g_emotions', ['emotionality', 'empathy']) +
        `<div class="mw-grp">${t('g_social')}</div>` +
        sliderRow(sliderDef('morality')) +
        sliderRow(sliderDef('self_esteem')) +
        grp('g_will', ['dominance', 'submission', 'aggression']) +
        `<div class="mw-grp">${t('g_attitude')}</div>` +
        sliderRow(sliderDef('affection')) + affTargetSelect() +
        sliderRow(sliderDef('user_dependency')) +
        sliderRow(sliderDef('perception_filter')) +
        sliderRow(sliderDef('role_position'))),
      card(t('s_control'), `<div class="mw-toggles">${TOGGLES.filter(x => x[3] === 'control').map(toggleChip).join('')}</div>`),
      card(t('s_sense'),
        `<div class="mw-note">${t('ui_sense_note')}</div>
         <div class="mw-toggles">${TOGGLES.filter(x => x[3] === 'sense').map(toggleChip).join('')}</div>`),
      card(t('s_pulse'),
        `<div class="mw-note">${t('ui_pulse_note')}</div>
         <div class="mw-toggles">${pulses.map(p =>
          `<div class="mw-toggle mw-pulse ${state.pulse && state.pulse.sid === sid && state.pulse.p === p ? 'mw-on' : ''}" data-pulse="${p}">${esc(t('pu_' + p))}</div>`).join('')}</div>`),
      card(t('s_speech'), selectRow(SELECTS.find(s => s[1] === 'speech_pattern')) + sliderRow(sliderDef('talkativeness'))),
      card(t('s_memory'),
        selectRow(SELECTS.find(s => s[1] === 'memory_wipe')) +
        `<input class="mw-custom" id="mw-memo" style="margin-top:6px" placeholder="${esc(t('ui_mem_ph'))}" value="${esc(memoVal)}">`),
      card(t('s_mindpresets'),
        `<div class="mw-toggles mw-list">
          ${Object.keys(MIND_PRESETS).map(p => `<div class="mw-toggle mw-preset" data-preset="m:${esc(p)}">${esc(t('pr_' + p))}</div>`).join('')}
          <div class="mw-toggle mw-preset" data-preset="__invert">${t('ui_invert')}</div>
          <div class="mw-toggle mw-preset" data-preset="__random">${t('ui_random')}</div>
        </div>
        <div class="mw-note">${t('ui_preset_note')}</div>`),
    ].join('');
  }

  function tabExtreme() {
    const S = subj();
    const st = S.stats || { forced: 0, denied: 0 };
    const xsliders = ['libido', 'sensitivity', 'arousal', 'sadism', 'masochism', 'resistance', 'auto_stim'];
    const armed = state.instaPreg === sidOf(S);
    return [
      card(t('s_xproto'),
        `<div class="mw-note">${t('ui_x_note')}</div>
         ${xsliders.map(k => sliderRow(sliderDef(k))).join('')}`),
      card(t('s_deepmods'), `<div class="mw-toggles">${TOGGLES.filter(x => x[0] === 'extreme').map(toggleChip).join('')}</div>`),
      card(t('s_erozones'), chipGroup('erozones', EROZONES, 'e_')),
      card(t('s_kinks'),
        `<div class="mw-note">${t('ui_kinks_note')}</div>
         ${SLIDERS.filter(s => s[6] === 'kink').slice().sort((a, b) => pLabel(a[1]).localeCompare(pLabel(b[1]), undefined, { sensitivity: 'base' })).map(sliderRow).join('')}`),
      card(t('s_conjure'),
        `<div class="mw-note">${t('ui_conjure_note')}</div>
         <div class="mw-grp">${t('s_conjure_toys')}</div>
         ${chipGroup('conjured', CONJURE_TOYS, 'cj_')}
         <div class="mw-grp">${t('s_conjure_beings')}</div>
         ${chipGroup('conjured', CONJURE_BEINGS, 'cj_')}`),
      card(t('s_breeding'),
        sliderRow(sliderDef('fertility')) +
        selectRow(SELECTS.find(s => s[1] === 'gestation')) +
        `<div class="mw-toggles"><div class="mw-toggle ${armed ? 'mw-on' : ''}" id="mw-instapreg">${t('ui_instapreg')}</div></div>
         <div class="mw-note">${t('ui_instapreg_note')}</div>`),
      card(t('s_stats'),
        `<div class="mw-stat-row"><span>${t('ui_stat_forced')}</span><b>${st.forced}</b></div>
         <div class="mw-stat-row"><span>${t('ui_stat_denied')}</span><b>${st.denied}</b></div>
         ${state.settings.corruption ? `
         <div class="mw-slider-row">
           <div class="mw-slider-top"><span>${t('ui_corruption')}</span><span class="mw-val" id="mw-corr-val">${S.corruption || 0}%</span></div>
           <input class="mw-range" type="range" min="0" max="100" value="${S.corruption || 0}" id="mw-corruption">
           <div class="mw-note">${t('ui_corruption_note')}</div>
         </div>` : ''}`),
    ].join('');
  }

  function tabBio() {
    const limbs = ['arms', 'legs', 'eyes'].concat(state.settings.extreme ? ['breasts', 'members'] : []);
    return [
      card(t('s_frame'),
        segRow('scale', SELECTS.find(s => s[1] === 'scale')[2], 'scaleopt') +
        sliderRow(sliderDef('regeneration'))),
      card(t('s_limbs'),
        `<div class="mw-note">${t('ui_limbs_note')}</div>
         ${limbs.map(k => stepperRow(sliderDef(k))).join('')}`),
      card(t('s_race'),
        `<div class="mw-note">${t('ui_race_note')}</div>
         ${selectRow(SELECTS.find(s => s[1] === 'race'))}`),
      card(t('s_bodymods'),
        `<div class="mw-note">${t('ui_bio_note')}</div>
         ${chipGroup('body_mods', BODY_MODS, 'bm_')}`),
      card(t('s_implants'), chipGroup('implants', IMPLANTS, 'i_')),
    ].join('');
  }

  function tabSys() {
    const s = state.settings;
    const subjRows = (state.subjects || []).map(su => `
      <div class="mw-select-row">
        <label>${esc(su.name)} · ${su.psyche}%</label>
        <span>
          <button class="mw-btn mw-subreset" data-sid="${esc(su.id)}">${t('ui_resetsub')}</button>
          <button class="mw-btn mw-danger mw-sublink" data-sid="${esc(su.id)}">${t('ui_unlink')}</button>
        </span>
      </div>`).join('');
    const hist = state.history.slice().reverse().map(h => `
      <div class="mw-hist">
        <div class="mw-hist-head">
          <span>${vstr(h.v)} · ${new Date(h.t).toLocaleString()}</span>
          ${h.v !== state.version ? `<button class="mw-btn mw-rb" data-v="${h.v}">${t('ui_rollback')}</button>` : `<span style="font-size:10px;color:#ffd166">${t('ui_current')}</span>`}
        </div>
        <div class="mw-hist-notes">${h.notes.map(esc).join('<br>')}</div>
      </div>`).join('');
    return [
      card(t('s_maint'),
        `<div class="mw-toggles">
          <button class="mw-btn" id="mw-reset-orig">${t('ui_reset')}</button>
          <button class="mw-btn mw-danger" id="mw-factory">${t('ui_factory')}</button>
        </div>`),
      card(t('s_branches'),
        `<div class="mw-toggles">
          <button class="mw-btn" id="mw-xlock">${s.extreme ? t('ui_hide_x') : t('ui_unlock_x')}</button>
          <button class="mw-btn" id="mw-block">${s.biolab ? t('ui_hide_b') : t('ui_unlock_b')}</button>
        </div>`),
      subjRows ? card(t('s_subjects'), subjRows) : '',
      card(t('s_device'),
        `<div class="mw-toggles">
          <div class="mw-toggle ${s.gradual ? 'mw-on' : ''}" data-setting="gradual">${t('ui_gradual')}</div>
          <div class="mw-toggle ${s.botAccess ? 'mw-on' : ''}" data-setting="botAccess">${t('ui_botaccess')}</div>
          <div class="mw-toggle ${s.botUnlock ? 'mw-on' : ''}" data-setting="botUnlock">${t('ui_botunlock')}</div>
          <div class="mw-toggle ${s.selfEdit ? 'mw-on' : ''}" data-setting="selfEdit">${t('ui_selfedit')}</div>
        </div>
        <div class="mw-note">${t('ui_settings_note')}</div>
        <div class="mw-toggles">
          <div class="mw-toggle ${s.psyche ? 'mw-on' : ''}" data-setting="psyche">${t('ui_psysys')}</div>
          <div class="mw-toggle ${s.glitch ? 'mw-on' : ''}" data-setting="glitch">${t('ui_glitchfx')}</div>
          <div class="mw-toggle ${s.corruption ? 'mw-on' : ''}" data-setting="corruption">${t('ui_corruptsys')}</div>
        </div>
        <div class="mw-select-row">
          <label>${t('ui_autochaos')}</label>
          <select class="mw-select" id="mw-chaos">
            ${[0, 3, 5, 10].map(n => `<option value="${n}" ${s.autoChaos === n ? 'selected' : ''}>${n === 0 ? t('ui_rec_Off') : tf('ui_everyN', n)}</option>`).join('')}
          </select>
        </div>
        <div class="mw-note">${t('ui_extra_note')}</div>
        <div class="mw-select-row">
          <label>${t('ui_recovery')}</label>
          <select class="mw-select" id="mw-recovery">
            ${RECOVERY.map(r => `<option value="${r}" ${s.recovery === r ? 'selected' : ''}>${t('ui_rec_' + r)}</option>`).join('')}
          </select>
        </div>
        <div class="mw-select-row">
          <label>${t('ui_language')}</label>
          <select class="mw-select" id="mw-lang">
            <option value="auto" ${s.lang === 'auto' ? 'selected' : ''}>Auto</option>
            <option value="en" ${s.lang === 'en' ? 'selected' : ''}>English</option>
            <option value="ru" ${s.lang === 'ru' ? 'selected' : ''}>Русский</option>
          </select>
        </div>
        <div class="mw-slider-row">
          <div class="mw-slider-top">
            <span>${t('ui_uiscale')}</span>
            <span class="mw-val" id="mw-uiscale-val">${Math.round(uiScale() * 100)}%</span>
          </div>
          <input class="mw-range" type="range" min="60" max="110" step="5" value="${Math.round(uiScale() * 100)}" id="mw-uiscale">
        </div>
        <div class="mw-card-title" style="margin-top:12px">${t('ui_theme')}</div>
        <div class="mw-seg">
          <div class="${getTheme() === 'dark' ? 'mw-on' : ''}" data-theme="dark">${t('ui_theme_dark')}</div>
          <div class="${getTheme() === 'light' ? 'mw-on' : ''}" data-theme="light">${t('ui_theme_light')}</div>
        </div>`),
      card(t('s_thoughts'),
        `<div class="mw-toggles"><div class="mw-toggle ${s.thoughts ? 'mw-on' : ''}" data-setting="thoughts">${t('ui_thoughts')}</div></div>
         <div class="mw-note">${t('ui_thoughts_note')}</div>`),
      card(t('s_history'), hist || `<div class="mw-note">${t('ui_nohist')}</div>`),
      `<div class="mw-note" style="text-align:center;">
        Firmware: MW-OS 1.0.0${s.extreme ? ' · 🔞' : ''}${s.biolab ? ' · 🧬' : ''}
      </div>`,
    ].join('');
  }

  /* ================= UI: WIRING ================= */

  function wireTab(c) {
    c.querySelectorAll('input.mw-range[data-key]').forEach(inp => {
      inp.addEventListener('input', () => {
        const S = subj();
        const key = inp.dataset.key;
        S.draft[key] = Number(inp.value);
        const lbl = c.querySelector('#mw-val-' + key);
        if (lbl) {
          lbl.textContent = fmtVal(key, S.draft[key]);
          lbl.classList.toggle('mw-dirty', S.applied[key] !== S.draft[key]);
        }
        save(); updateFooter();
      });
    });

    // ± fine-nudge buttons beside each slider
    c.querySelectorAll('.mw-mini[data-nudge]').forEach(btn => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.nudge;
        setSliderVal(c, key, (subj().draft[key] || 0) + Number(btn.dataset.d));
      });
    });

    // tap the value → type an exact number
    c.querySelectorAll('.mw-val[data-valkey]').forEach(el => {
      el.addEventListener('click', () => {
        if (el.querySelector('input')) return;
        const key = el.dataset.valkey;
        const [min, max] = sliderRange(key);
        const cur = subj().draft[key];
        const inp = D.createElement('input');
        inp.type = 'number'; inp.className = 'mw-val-input';
        inp.value = cur; inp.min = min; inp.max = max;
        el.textContent = ''; el.appendChild(inp);
        inp.focus(); inp.select();
        let done = false;
        const commit = () => { if (done) return; done = true; const raw = parseInt(inp.value, 10); setSliderVal(c, key, Number.isFinite(raw) ? raw : cur); };
        inp.addEventListener('blur', commit);
        inp.addEventListener('keydown', e => {
          if (e.key === 'Enter') { e.preventDefault(); inp.blur(); }
          if (e.key === 'Escape') { done = true; setSliderVal(c, key, cur); }
        });
      });
    });

    c.querySelectorAll('.mw-step button').forEach(btn => {
      btn.addEventListener('click', () => {
        const S = subj();
        const key = btn.dataset.stepkey;
        const v = Math.min(Number(btn.dataset.max), Math.max(Number(btn.dataset.min), (S.draft[key] || 0) + Number(btn.dataset.d)));
        S.draft[key] = v;
        const lbl = c.querySelector('#mw-val-' + key);
        if (lbl) {
          lbl.textContent = v;
          lbl.classList.toggle('mw-dirty', S.applied[key] !== v);
        }
        save(); updateFooter();
      });
    });

    c.querySelectorAll('.mw-seg div[data-gender]').forEach(el => {
      el.addEventListener('click', () => {
        const S = subj();
        S.draft.gender = el.dataset.gender;
        const fill = GENDER_FILL[S.draft.gender] || {};
        Object.entries(fill).forEach(([k, v]) => { S.draft[k] = v; });
        save(); renderTab(); updateFooter();
      });
    });

    c.querySelectorAll('.mw-seg div[data-scaleopt]').forEach(el => {
      el.addEventListener('click', () => {
        const S = subj();
        S.draft.scale = el.dataset.scaleopt;
        const r = heightRange(S.draft);
        S.draft.height = Math.round((r[0] + r[1]) / 2);
        save(); renderTab(); updateFooter();
      });
    });

    c.querySelectorAll('.mw-seg div[data-aware]').forEach(el => {
      el.addEventListener('click', () => {
        subj().awareness = el.dataset.aware;
        c.querySelectorAll('.mw-seg div[data-aware]').forEach(x =>
          x.classList.toggle('mw-on', x.dataset.aware === subj().awareness));
        saveNow(); updateStateInject();
      });
    });

    c.querySelectorAll('.mw-toggle[data-key]').forEach(el => {
      el.addEventListener('click', () => {
        const S = subj();
        const key = el.dataset.key;
        S.draft[key] = !S.draft[key];
        el.classList.toggle('mw-on', S.draft[key]);
        save(); updateFooter();
      });
    });

    c.querySelectorAll('.mw-pulse').forEach(el => {
      el.addEventListener('click', () => {
        const sid = sidOf(subj());
        const same = state.pulse && state.pulse.sid === sid && state.pulse.p === el.dataset.pulse;
        state.pulse = same ? null : { sid, p: el.dataset.pulse };
        c.querySelectorAll('.mw-pulse').forEach(p =>
          p.classList.toggle('mw-on', !!state.pulse && state.pulse.sid === sid && state.pulse.p === p.dataset.pulse));
        save(); updateFooter();
      });
    });

    c.querySelectorAll('.mw-chip').forEach(el => {
      el.addEventListener('click', () => {
        const S = subj();
        const g = el.dataset.group, v = el.dataset.chip;
        const arr = S.draft[g] || (S.draft[g] = []);
        const i = arr.indexOf(v);
        if (i >= 0) arr.splice(i, 1); else arr.push(v);
        el.classList.toggle('mw-on', i < 0);
        save(); updateFooter();
      });
    });

    c.querySelectorAll('select.mw-select[data-key]').forEach(sel => {
      sel.addEventListener('change', () => {
        const key = sel.dataset.key;
        subj().draft[key] = sel.value;
        if (key === 'race') { applyRaceFill(sel.value); renderTab(); }
        save(); updateFooter();
      });
    });

    const memoEl = c.querySelector('#mw-memo');
    if (memoEl) memoEl.addEventListener('input', () => {
      const text = memoEl.value;
      state.memo = text.trim() ? { sid: sidOf(subj()), text } : null;
      save(); updateFooter();
    });

    const ip = c.querySelector('#mw-instapreg');
    if (ip) ip.addEventListener('click', () => {
      const sid = sidOf(subj());
      state.instaPreg = state.instaPreg === sid ? null : sid;
      ip.classList.toggle('mw-on', state.instaPreg === sid);
      save(); updateFooter();
    });

    // corruption is a live meta-value (like psyche): edit it directly, no APPLY
    const corr = c.querySelector('#mw-corruption');
    if (corr) corr.addEventListener('input', () => {
      subj().corruption = Number(corr.value);
      const lbl = c.querySelector('#mw-corr-val');
      if (lbl) lbl.textContent = corr.value + '%';
      saveNow(); updateStateInject();
    });

    const aft = c.querySelector('#mw-afftarget');
    if (aft) aft.addEventListener('change', () => {
      subj().affTarget = aft.value;
      saveNow(); updateStateInject(); renderTab();
    });

    c.querySelectorAll('.mw-preset').forEach(el => {
      const id = el.dataset.preset;
      const apply = () => { hidePresetTip(); applyPresetToDraft(id); renderTab(); updateFooter(); flashApply(tf('ui_presetloaded', presetLabel(id))); };
      let lp = null, longFired = false;
      const clearLp = () => { if (lp) { clearTimeout(lp); lp = null; } };
      el.addEventListener('pointerenter', e => { if (e.pointerType === 'mouse') showPresetTip(el, id); });
      el.addEventListener('pointerleave', () => { clearLp(); hidePresetTip(); });
      el.addEventListener('pointerdown', e => {
        if (e.pointerType === 'mouse') return;
        longFired = false;
        lp = setTimeout(() => { longFired = true; showPresetTip(el, id); }, 400);
      });
      el.addEventListener('pointermove', clearLp);
      el.addEventListener('pointercancel', () => { clearLp(); hidePresetTip(); });
      el.addEventListener('click', () => {
        clearLp();
        if (longFired) { longFired = false; setTimeout(hidePresetTip, 1800); return; }
        apply();
      });
    });

    c.querySelectorAll('.mw-toggle[data-setting]').forEach(el => {
      el.addEventListener('click', () => {
        const k = el.dataset.setting;
        state.settings[k] = !state.settings[k];
        el.classList.toggle('mw-on', state.settings[k]);
        saveNow(); updateStateInject();
        if (k === 'selfEdit') { renderSubjBar(); updateFooter(); }
        if (k === 'psyche' || k === 'glitch') updateFooter();
      });
    });

    const rec = c.querySelector('#mw-recovery');
    if (rec) rec.addEventListener('change', () => { state.settings.recovery = rec.value; saveNow(); });

    const ch = c.querySelector('#mw-chaos');
    if (ch) ch.addEventListener('change', () => {
      state.settings.autoChaos = Number(ch.value);
      state.chaosIn = state.settings.autoChaos;
      saveNow();
    });

    const lng = c.querySelector('#mw-lang');
    if (lng) lng.addEventListener('change', () => {
      state.settings.lang = lng.value;
      saveNow(); detectLang(); renderApp();
    });

    const us = c.querySelector('#mw-uiscale');
    if (us) us.addEventListener('input', () => {
      try { W.localStorage.setItem(SCALE_KEY, String(us.value)); } catch (e) { /* ignore */ }
      const lbl = c.querySelector('#mw-uiscale-val');
      if (lbl) lbl.textContent = us.value + '%';
      positionPanel(); // re-applies scale and keeps the panel on screen
    });

    c.querySelectorAll('.mw-seg div[data-theme]').forEach(el => {
      el.addEventListener('click', () => {
        try { W.localStorage.setItem(THEME_KEY, el.dataset.theme); } catch (e) { /* ignore */ }
        renderApp();
      });
    });

    const xl = c.querySelector('#mw-xlock');
    if (xl) xl.addEventListener('click', () => {
      if (state.settings.extreme) {
        state.settings.extreme = false;
        if (activeTab === 'extreme') activeTab = 'sys';
        saveNow(); renderApp(); flashApply(t('ui_xhidden'));
      } else {
        confirmDialog(t('ui_sure_x'), () => {
          state.settings.extreme = true;
          saveNow(); renderApp(); flashApply(t('ui_xunlocked'));
        }, t('ui_18plus'));
      }
    });

    const bl = c.querySelector('#mw-block');
    if (bl) bl.addEventListener('click', () => {
      if (state.settings.biolab) {
        state.settings.biolab = false;
        if (activeTab === 'bio') activeTab = 'sys';
        saveNow(); renderApp(); flashApply(t('ui_bhidden'));
      } else {
        confirmDialog(t('ui_sure_b'), () => {
          state.settings.biolab = true;
          saveNow(); renderApp(); flashApply(t('ui_bunlocked'));
        }, t('ui_18plus'));
      }
    });

    const ro = c.querySelector('#mw-reset-orig');
    if (ro) ro.addEventListener('click', () => rollbackTo(10));
    const fr = c.querySelector('#mw-factory');
    if (fr) fr.addEventListener('click', factoryReset);
    c.querySelectorAll('.mw-rb').forEach(b => b.addEventListener('click', () => rollbackTo(Number(b.dataset.v))));
    c.querySelectorAll('.mw-subreset').forEach(b => b.addEventListener('click', () => resetSubject(b.dataset.sid)));
    c.querySelectorAll('.mw-sublink').forEach(b => b.addEventListener('click', () => unlinkSubject(b.dataset.sid)));
  }

  function applyPresetToDraft(id) {
    const S = subj();
    if (id === '__invert') {
      SLIDERS.filter(s => s[0] === 'mind').forEach(([, k, min, max]) => { S.draft[k] = (min + max) - S.original[k]; });
      save();
      return;
    }
    if (id === '__random') {
      const keys = Object.keys(MIND_PRESETS);
      id = 'm:' + keys[Math.floor(Math.random() * keys.length)];
    }
    const [kind, name] = [id.slice(0, 1), id.slice(2)];
    const p = (kind === 'b' ? BODY_PRESETS : MIND_PRESETS)[name];
    if (!p) return;
    Object.entries(p).forEach(([k, v]) => { S.draft[k] = clone(v); });
    save();
  }

  // pull a race's signature features into the draft (arrays merge, scalars set)
  function applyRaceFill(race) {
    const fill = RACE_FILL[race];
    if (!fill) return;
    const S = subj();
    Object.entries(fill).forEach(([k, v]) => {
      if (Array.isArray(v)) {
        const arr = S.draft[k] || (S.draft[k] = []);
        v.forEach(x => { if (!arr.includes(x)) arr.push(x); });
      } else {
        S.draft[k] = v;
      }
    });
  }

  /* ----- preset preview tooltip (hover on desktop, long-press on touch) ----- */

  function presetField(k, v) {
    if (sliderDef(k)) return pLabel(k) + ' ' + fmtVal(k, v);
    if (SELECTS.find(s => s[1] === k)) return pLabel(k) + ' ' + tOpt(k, v);
    if (TOGGLES.find(tg => tg[1] === k)) return pLabel(k);
    if (CHIP_GROUPS.find(g => g[0] === k)) return Array.isArray(v) ? v.join(', ') : String(v);
    return ''; // unknown/stale key — skip
  }
  function presetSummary(id) {
    if (id === '__invert') return t('ui_invert');
    if (id === '__random') return t('ui_random');
    const [kind, name] = [id.slice(0, 1), id.slice(2)];
    const p = (kind === 'b' ? BODY_PRESETS : MIND_PRESETS)[name];
    if (!p) return '';
    return Object.entries(p).map(([k, v]) => presetField(k, v)).filter(Boolean).join(' · ');
  }
  function presetLabel(id) {
    if (id === '__invert') return t('ui_invert');
    if (id === '__random') return t('ui_random');
    return t('pr_' + id.slice(2));
  }
  let presetTip = null;
  function hidePresetTip() { if (presetTip) { presetTip.remove(); presetTip = null; } }
  function showPresetTip(el, id) {
    hidePresetTip();
    const txt = presetSummary(id);
    if (!txt) return;
    const tip = D.createElement('div');
    tip.className = 'mw-preset-tip';
    tip.textContent = txt;
    panel.appendChild(tip);
    const r = el.getBoundingClientRect();
    const pr = panel.getBoundingClientRect();
    const left = Math.max(6, Math.min(pr.width - tip.offsetWidth - 6, r.left - pr.left));
    tip.style.left = left + 'px';
    tip.style.top = (r.bottom - pr.top + 4) + 'px';
    presetTip = tip;
  }

  /* ================= UI: FOOTER / FEEDBACK ================= */

  function updateFooter() {
    const n = pendingTotal();
    if (state.synced && panelOpen) {
      const S = subj();
      const psyOn = state.settings.psyche;
      const bar = panel.querySelector('.mw-psyche');
      if (bar) bar.style.display = psyOn ? '' : 'none';
      const lbl = panel.querySelector('#mw-psyche-lbl');
      const num = panel.querySelector('#mw-psyche-num');
      const fill = panel.querySelector('#mw-psyche-fill');
      if (lbl) lbl.textContent = t('ui_psyche') + (S === state ? '' : ' — ' + subjName(S));
      if (num) num.textContent = S.psyche + '%';
      if (fill) {
        const neg = S.psyche < 0;
        fill.style.width = (neg ? -S.psyche : S.psyche) + '%';
        fill.classList.toggle('mw-low', !neg && S.psyche < 30);
        fill.classList.toggle('mw-neg', neg);
      }
      panel.classList.toggle('mw-glitch', psyOn && state.settings.glitch && S.psyche < 0);
      const btn = panel.querySelector('#mw-apply');
      if (btn) {
        if (calibrating) btn.textContent = n ? `${t('ui_setbaseline')}  (${n})` : t('ui_setbaseline');
        else btn.textContent = n ? `${t('ui_apply')}  (${n})` : t('ui_apply');
        btn.classList.toggle('mw-ready', n > 0);
      }
      const calBtn = panel.querySelector('#mw-calibrate');
      if (calBtn) calBtn.classList.toggle('mw-on', calibrating);
    }
    const badge = bubble.querySelector('.mw-badge');
    if (state.synced && n > 0) {
      if (badge) badge.textContent = n;
      else { const b = D.createElement('div'); b.className = 'mw-badge'; b.textContent = n; bubble.appendChild(b); }
    } else if (badge) badge.remove();
  }

  let flashTimer = null;
  function flashApply(msg, warn) {
    const el = panel.querySelector('#mw-flash');
    if (!el) return;
    el.textContent = msg;
    el.style.color = warn ? '#ff7d8d' : '#ffd166';
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { el.textContent = ''; }, 2600);
  }

  /* ================= EVENTS / LIFECYCLE ================= */

  function onChatChanged() {
    loadState();
    if (['extreme', 'bio'].includes(activeTab)) activeTab = 'body';
    updateStateInject();
    if (panelOpen) renderApp();
    updateFooter();
  }

  // Thoughts render via the display regex rule (mindware_think_display): the
  // <!--mw-think ...--> tag becomes a styled, collapsible <details> block inside
  // the post. No JS DOM work needed; it survives swipes and reloads on its own.

  function recoveryTick(ref) {
    let changed = false;
    if (state.settings.psyche) {
      const rec = RECOVERY_V[state.settings.recovery] || 0;
      if (rec > 0 && ref.psyche < 100) {
        ref.psyche = Math.min(100, ref.psyche + rec);
        changed = true;
      }
      if (ref.psyche >= 20 && ref.collapsed) { ref.collapsed = false; changed = true; }
    }
    if (ref.applied && ref.applied.orgasm_denial) { ref.stats.denied += 1; changed = true; }
    return changed;
  }

  // autonomous stimulation: chance-based involuntary spasm one-shot, cadence
  // scales with intensity (100% ≈ fires most replies, 30% ≈ occasional)
  function fireAutoStim(ref) {
    const who = subjMacro(ref);
    const zones = ref.applied.erozones || [];
    const zt = zones.length ? ` in their ${zones.map(z => z.toLowerCase()).join(', ')}` : '';
    try {
      injectPrompts([{
        id: 'mindware_autostim_' + sidOf(ref), position: 'in_chat', depth: 0, role: 'system',
        content: mac(`[MindWare: the device fires a sudden involuntary spasm of forced pleasure through ${who}'s body${zt} RIGHT NOW — uncontrollable, beyond their will; depict the jolt and their helpless reaction this reply. Narrate in the language of the ongoing roleplay.]`),
        should_scan: true,
      }], { once: true });
    } catch (e) { /* ignore */ }
  }

  // corruption meter: count <!--mw-act--> markers the model appended, accumulate
  function parseActs(mid) {
    if (!state.settings.corruption) return false;
    let msg; try { msg = getChatMessages(mid)[0]; } catch (e) { return false; }
    if (!msg || msg.role !== 'assistant') return false;
    const acts = (String(msg.message).match(/<!--\s*mw-act\b[\s\S]*?-->/gi) || []).length;
    if (!acts) return false;
    const before = state.corruption || 0;
    state.corruption = Math.min(100, before + acts * 4);
    return state.corruption !== before;
  }

  function onMessageReceived(message_id) {
    if (!state.synced) return;
    handleRemoteDirective(message_id);
    let changed = false;
    allRefs().forEach(ref => { changed = recoveryTick(ref) || changed; });
    if (parseActs(message_id)) changed = true;
    allRefs().forEach(ref => { if (ref.applied.auto_stim > 0 && Math.random() < ref.applied.auto_stim / 100 * 0.6) fireAutoStim(ref); });
    if (changed) {
      save();
      updateStateInject();
      if (panelOpen) updateFooter();
    }
    if (state.settings.autoChaos > 0) {
      state.chaosIn = (state.chaosIn > 0 ? state.chaosIn : state.settings.autoChaos) - 1;
      if (state.chaosIn <= 0) {
        state.chaosIn = state.settings.autoChaos;
        fireAutoChaos();
      } else save();
    }
  }

  function cleanup() {
    clearInterval(watchdog);
    try { W.removeEventListener('resize', onWinResize); } catch (e) { /* ignore */ }
    try { W.removeEventListener('orientationchange', onWinResize); } catch (e) { /* ignore */ }
    const r = D.getElementById(ROOT_ID); if (r) r.remove();
    const s = D.getElementById(STYLE_ID); if (s) s.remove();
  }

  /* ================= BOOT ================= */

  // hardened init: on mobile the parent UI may not be ready yet or a
  // transient error may occur — retry a few times instead of dying silently
  let initTries = 0;
  function init() {
    try {
      buildShell();
      loadState();
      updateStateInject();
      updateFooter();

      eventOn(tavern_events.CHAT_CHANGED, onChatChanged);
      eventOn(tavern_events.MESSAGE_RECEIVED, onMessageReceived);
      eventOn(tavern_events.MESSAGE_DELETED, onMessageDeleted);
      eventOn(tavern_events.MESSAGE_SWIPED, onMessageSwiped);
      W.addEventListener('resize', onWinResize);
      W.addEventListener('orientationchange', onWinResize);
      startWatchdog();
      window.addEventListener('unload', cleanup);
      window.addEventListener('pagehide', cleanup);

      addSettingsUi();
      setTimeout(addSettingsUi, 1500); // extensions drawer may not be ready yet
      applyEnabled();

      console.info('[MindWare] v1.0 neural link ready');
    } catch (e) {
      console.error('[MindWare] init failed', e);
      if (initTries++ < 10) setTimeout(init, 2000);
    }
  }
  init();
}

// ── extension bootstrap ─────────────────────────────────────────────────────────
jQuery(async () => {
    try {
        ensureRegexRules();
        eventSource.on(event_types.GENERATION_ENDED, clearOncePrompts);
        eventSource.on(event_types.MESSAGE_RECEIVED, clearOncePrompts);
        initMindWare();
        console.info('[MindWare] extension loaded (adapter ready)');
    } catch (e) {
        console.error('[MindWare] bootstrap failed', e);
    }
});

export { tavern_events, eventOn, getVariables, updateVariablesWith, substitudeMacros,
    getChatMessages, getCharData, getCharAvatarPath, getPersonaAvatarPath, generateRaw,
    injectPrompts, uninjectPrompts };
