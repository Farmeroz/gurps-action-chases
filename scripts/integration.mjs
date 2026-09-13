import { ID, number, textValue, escapeHTML, newParticipant, canControl } from './rules.mjs';

export function flattenSkills(tree) {
  const out = [];
  for (const value of Object.values(tree ?? {})) {
    if (!value || typeof value !== 'object') continue;
    if (value.name && value.level != null) out.push(value);
    if (value.contains) out.push(...flattenSkills(value.contains));
    if (value.collapsed) out.push(...flattenSkills(value.collapsed));
  }
  return out;
}
export function dxBasedLevel(actor, skill) {
  const level = Number(skill.level);
  if (!Number.isFinite(level)) throw new Error('The imported skill has no numeric level.');
  const relative = String(skill.relativelevel ?? '').match(
    /^(ST|DX|IQ|HT|WILL|PER)\s*([+-]\s*\d+)?$/i,
  );
  const dx = Number(actor.system?.attributes?.DX?.value);
  if (relative && Number.isFinite(dx)) return dx + Number((relative[2] ?? '0').replaceAll(' ', ''));
  // Imported levels may include bonuses not represented in relativelevel. Always show this as a snapshot for GM review.
  if (/^running$/i.test(skill.name)) {
    const ht = Number(actor.system?.attributes?.HT?.value);
    if (Number.isFinite(dx) && Number.isFinite(ht)) return level + dx - ht;
  }
  return level;
}
export function participantFromActor(actor, skill, side = 'quarry') {
  const sys = actor.system ?? {};
  const skills = flattenSkills(sys.skills);
  const find = (name) => skills.find((x) => x.name.toLowerCase() === name);
  const numeric = (x) => (Number.isFinite(Number(x)) ? Number(x) : null);
  const hasGunslinger = (tree) =>
    Object.values(tree ?? {}).some(
      (x) =>
        x &&
        typeof x === 'object' &&
        (/^gunslinger(?:$|\s*\()/i.test(String(x.name ?? '').trim()) ||
          hasGunslinger(x.contains) ||
          hasGunslinger(x.collapsed)),
    );
  const selected = skill ?? find('running');
  return newParticipant({
    name: actor.name,
    actorUuid: actor.uuid,
    side,
    skillName: selected ? `${selected.name} (DX-based; review)` : 'DX',
    skill: selected ? dxBasedLevel(actor, selected) : (numeric(sys.attributes?.DX?.value) ?? 12),
    gunslinger: hasGunslinger(sys.ads),
    footSkill: find('running')
      ? dxBasedLevel(actor, find('running'))
      : numeric(sys.attributes?.DX?.value),
    footSkillName: find('running') ? 'Running (DX-based)' : 'DX',
    speed: numeric(sys.currentmove) ?? numeric(sys.basicmove?.value) ?? 5,
    st: numeric(sys.attributes?.ST?.value),
    ht: numeric(sys.attributes?.HT?.value),
    hp: numeric(sys.HP?.value),
    maxHp: numeric(sys.HP?.max),
    stealth: find('stealth') ? dxBasedLevel(actor, find('stealth')) : null,
    acrobatics: find('acrobatics') ? dxBasedLevel(actor, find('acrobatics')) : null,
    climbing: find('climbing') ? dxBasedLevel(actor, find('climbing')) : null,
    jumping: find('jumping') ? dxBasedLevel(actor, find('jumping')) : null,
    notes:
      'Actor snapshot: check DX-based skill, top speed (including Enhanced Move), and any situational bonuses. Changes here do not update the actor.',
  });
}
export function actorOwned(uuid, user) {
  if (!uuid) return false;
  try {
    return !!globalThis.fromUuidSync?.(uuid)?.testUserPermission(user, 'OWNER');
  } catch {
    return false;
  }
}
export async function rollGGA(s, p, otf, event = {}) {
  if (!canControl(s, p, game.user, actorOwned))
    throw new Error('You do not control this participant.');
  if (!p.actorUuid)
    throw new Error('This participant has no linked actor. Use the manual skill roll instead.');
  const actor = await fromUuid(p.actorUuid);
  if (!actor?.testUserPermission(game.user, 'OWNER'))
    throw new Error(
      'Native GGA rolls require ownership of the linked actor. Use an ad hoc roll or ask the GM.',
    );
  otf = textValue(otf, 300).replace(/^\[|\]$/g, '');
  if (!otf) throw new Error('Enter a GGA on-the-fly expression.');
  const { parselink } = await import('/systems/gurps/lib/parselink.js');
  const action = parselink(otf)?.action;
  if (
    !action ||
    ![
      'attack',
      'skill-spell',
      'attribute',
      'controlroll',
      'damage',
      'deriveddamage',
      'attackdamage',
    ].includes(action.type)
  )
    throw new Error(
      'Use a single attack, skill, attribute, defence, or damage expression. Chat commands are not accepted here.',
    );
  if (!globalThis.GURPS?.performAction) throw new Error('GGA’s roll API is unavailable.');
  return GURPS.performAction(action, actor, event);
}
export async function standaloneRoll({ name, target, modifier = 0, whisper = false }) {
  const effective = number(target, 'Skill', -100, 1000) + number(modifier, 'Modifier', -100, 100);
  const roll = await new Roll('3d6').evaluate();
  return roll.toMessage(
    {
      speaker: { alias: textValue(name, 100) },
      flavor: `${escapeHTML(name)} · ${roll.total} vs ${effective} · margin ${effective - roll.total} (ad hoc roll; GM resolves consequences)`,
      ...(whisper ? { whisper: ChatMessage.getWhisperRecipients('GM').map((u) => u.id) } : {}),
    },
    { rollMode: whisper ? 'gmroll' : 'publicroll' },
  );
}
