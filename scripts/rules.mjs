// Rules calculations, not a reproduction of the rulebook. GURPS 4e Action 2, pp. 31–35.
export const ID = 'gurps-action-chases';
export const BANDS = ['Close', 'Short', 'Medium', 'Long', 'Extreme'];
export const RANGE_PENALTIES = [0, -3, -7, -11, -15];
export const SIDES = ['quarry', 'pursuer'];
export const clone = value => structuredClone(value);
export const uid = () => Array.from(globalThis.crypto.getRandomValues(new Uint8Array(8))).map(x=>x.toString(16).padStart(2,'0')).join('');
export const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function number(value, label, min = -100, max = 10000, integer = false) {
  if (value === '' || value == null || !Number.isFinite(Number(value))) throw new Error(`${label} needs a number.`);
  const n = Number(value);
  if (n < min || n > max || (integer && !Number.isInteger(n))) throw new Error(`${label} must be ${integer ? 'a whole number ' : ''}between ${min} and ${max}.`);
  return n;
}
export function textValue(value, max = 300) { return String(value ?? '').trim().slice(0, max); }
export const MANOEUVRES = {
  move: {name:'Move', sides:SIDES, mod:0, page:33, hint:'Record the declaration, then follow any tasks before Chase Rolls.'},
  attack: {name:'Attack', sides:SIDES, mod:0, static:true, page:32, hint:'Open the attack task and review its preview before recording the shot.'},
  moveAttack: {name:'Move and Attack', sides:SIDES, mod:0, page:33, hint:'For a vehicle, confirm whether the driver also attacks. Resolve the offered attack tasks.'},
  embark: {name:'Disembark / Embark', sides:SIDES, mod:0, static:true, page:32, scenery:true, hint:'Enter or leave a vehicle. Use the new travel mode next round.'},
  emergency: {name:'Emergency Action', sides:SIDES, mod:-5, page:32, hint:'Follow the recovery prompt and check the participant’s due round.'},
  force: {name:'Force', sides:SIDES, mod:-2, close:true, vehicle:true, page:32, hint:'Resolve hit, vehicular dodge, and target control roll before the contest.'},
  hide: {name:'Hide', sides:['quarry'], mod:0, page:32, scenery:true, hint:'Confirm the scene and supply any requested skill. Review the offered outcome after both rolls.'},
  mobilityEscape: {name:'Mobility Escape', sides:['quarry'], mod:0, page:32, scenery:true, hint:'GM decides whether the pursuer can follow. If unable, mark the pursuer as forced static.'},
  mobilityPursuit: {name:'Mobility Pursuit', sides:['pursuer'], mod:5, page:33, scenery:true, hint:'Ask the GM to confirm the route, then use the offered outcome controls.'},
  ram: {name:'Ram', sides:['pursuer'], mod:-2, close:true, vehicle:true, page:33, hint:'Complete the GM contact task, including defence, damage and relevant control results.'},
  reverse: {name:'Reverse', sides:['quarry'], mod:-10, page:33, hint:'If prompted, resolve the original Chase Roll result before selecting the outcome; do not reroll it.'},
  stop: {name:'Stop', sides:SIDES, mod:0, page:33, hint:'End the chase: pursuer lets quarry go; quarry stops for interaction or combat.'},
  stunt: {name:'Stunt', sides:SIDES, mod:0, page:33, hint:'Enter the agreed risk and description. Record every required stunt task, then review the updated target.'},
  stuntEscape: {name:'Stunt Escape', sides:['quarry'], mod:0, page:34, scenery:true, hint:'Confirm the scene with the GM, record the stunt tasks and follow any pursuit or consequence prompts.'}
};
export function speedBonus(move, useActionExample=true) {
  move = number(move, 'Top speed (yards/second)', 0, 1e12);
  if (move === 0) return 0;
  // Honour the explicit Move 6–7 example on Action 2 p. 34. Other in-between values round down.
  if (useActionExample && move >= 6 && move <= 7) return 3;
  // Size-column thresholds, rounding down, including fractional Move.
  const base = [2, 3, 5, 7, 10, 15];
  for (let bonus = 80; bonus >= -80; bonus--) {
    const decade = Math.floor(bonus / 6);
    const index = ((bonus % 6) + 6) % 6;
    if (move >= base[index] * 10 ** decade - 1e-12) return bonus;
  }
  return -80;
}
export function successRoll(target, total) {
  target = number(target, 'Effective skill', -100, 10000);
  total = number(total, '3d6 total', 3, 18, true);
  const criticalSuccess = total <= 4 || (total === 5 && target >= 15) || (total === 6 && target >= 16);
  const criticalFailure = total === 18 || (total === 17 && target <= 15) || total - target >= 10;
  return {target, total, margin:target - total, success:criticalSuccess || (total <= target && total < 17), criticalSuccess, criticalFailure};
}
// B348 compares success/failure before margins. For automatic results whose
// raw margin contradicts their outcome, this module uses success by 0 or
// failure by 1. This edge-case convention is documented in the guide.
export function contestMargin(roll) {
  const r=successRoll(roll.target,roll.total);
  return r.success ? Math.max(0,r.margin) : Math.min(-1,r.margin);
}
export function wipeout({target, total, kind, sr}) {
  const r = successRoll(target, total);
  if (r.success) return {status:'active', ...r};
  if (kind === 'vehicle') {
    sr = number(sr, 'Stability Rating', 0, 100);
    return {...r, status:Math.max(0, -r.margin) > sr ? 'wreck' : 'closeCall'};
  }
  return {...r, status:r.criticalFailure ? 'wreck' : 'closeCall'};
}
export function newParticipant(raw = {}) {
  const kind = raw.kind === 'vehicle' ? 'vehicle' : 'character';
  const out = {id:raw.id || uid(), kind, name:textValue(raw.name || (kind === 'vehicle' ? 'New vehicle' : 'New character'), 100),
    side:raw.side === 'pursuer' ? 'pursuer' : 'quarry', actorUuid:textValue(raw.actorUuid, 200),
    controllers:Array.isArray(raw.controllers) ? [...new Set(raw.controllers.map(x => textValue(x, 100)))].slice(0, 50) : [],
    skillName:textValue(raw.skillName || (kind === 'vehicle' ? 'Driving' : 'Running (DX-based)'), 100),
    skill:number(raw.skill ?? 12, 'DX-based chase skill', 1, 1000), speed:number(raw.speed ?? (kind === 'vehicle' ? 30 : 5), 'Top speed', 0, 1e12),
    handling:number(raw.handling ?? 0, 'Handling', -20, 20),
    transportId:textValue(raw.transportId, 100), role:raw.role === 'operator' ? 'operator' : 'passenger',
    status:['active','closeCall','wreck','out'].includes(raw.status) ? raw.status : 'active',
    dueRound:raw.dueRound == null ? null : number(raw.dueRound, 'Recovery round', 1, 1e6, true),
    notes:textValue(raw.notes, 1500), gunslinger:!!raw.gunslinger, driverRequired:kind==='vehicle'&&!!raw.driverRequired,footMode:!!raw.footMode,footSkillName:textValue(raw.footSkillName||'Running (DX-based)',100)};
  for (const key of ['sr','st','hp','maxHp','dr','ht','sm','stealth','acrobatics','climbing','jumping','footSkill']) out[key] = raw[key] === '' || raw[key] == null ? null : number(raw[key], key, key === 'hp' || key === 'sm' ? -10000 : 0, 1000000);
  return out;
}
export function freshSide(leader = '') { return {leader, declaration:null, roll:null, comp:0, extra:0, baseOverride:null, forcedStatic:false}; }
export function newChase(name = 'Untitled chase') {
  return {schema:1, id:uid(), name:textValue(name,100), revision:0, round:1, epoch:uid(), status:'setup', phase:'quarry', band:2,
    environment:'', combatId:'', blind:false, participants:[], sides:{quarry:freshSide(),pursuer:freshSide()},
    passengerActions:{}, checks:[], log:[], result:null, history:[], processed:[], blindRequests:{},workflowVersion:3,workflow:{approved:{},outcomes:{},legacyResolved:false},pendingCrew:[],pendingLeaders:{},outcomeRequired:'',ruleOptions:{speedRounding:'action',driverShots:'general'}};
}
export const unit = (s, id) => s.participants.find(p => p.id === id);
export const isActive = p => p && !['wreck','out'].includes(p.status);
export const roots = (s, side) => s.participants.filter(p => p.side === side && !p.transportId && isActive(p));
export function operatorOf(s, p) { return p?.kind === 'vehicle' ? s.participants.find(x => x.transportId === p.id && x.role === 'operator' && isActive(x)) : null; }
export const actionSide = (s,p) => unit(s,p?.transportId)?.side ?? p?.side;
export const missingDriver = (s,p) => p?.kind==='vehicle' && isActive(p) && !operatorOf(s,p) &&
  (p.driverRequired || s.participants.some(x=>x.transportId===p.id&&x.role==='operator'));
export const driverProblems = s => s.participants.filter(p=>missingDriver(s,p));
export const rollsStarted = s => SIDES.some(k=>s.sides[k].roll) || ['range','reverseCheck'].includes(s.phase);
export const FOOT_STUNT_SKILLS = ['acrobatics','climbing','jumping'];
export const preferredStuntSkill = p => FOOT_STUNT_SKILLS.find(k=>p[k]!=null) ?? '';
export const footSkillOf = p => p?.footSkill ?? (/^(running\b|dx\b)/i.test(p?.skillName??'')?p.skill:null);
export function travelStats(s, p) {
  if (!p) throw new Error('Choose a leader for each side.');
  if (missingDriver(s,p)) return {...p,skill:null,skillName:'No active driver',actorUuid:''};
  if(p.kind==='character'&&!p.transportId&&p.footMode&&p.footSkill!=null)return {...p,skill:p.footSkill,skillName:p.footSkillName};
  const operator = operatorOf(s, p);
  return {...p, skill:operator?.skill ?? p.skill, skillName:operator?.skillName ?? p.skillName, actorUuid:operator?.actorUuid || p.actorUuid};
}
export function canControl(s, p, user, actorOwned = () => false) {
  if (user?.isGM) return true;
  if (!p || !user) return false;
  const op = operatorOf(s, p);
  return p.controllers.includes(user.id) || actorOwned(p.actorUuid, user) || !!(op && (op.controllers.includes(user.id) || actorOwned(op.actorUuid, user)));
}
export function manoeuvreError(s, side, key) {
  const m = MANOEUVRES[key], p = unit(s, s.sides[side]?.leader);
  if (!m || !m.sides.includes(side)) return 'That manoeuvre is unavailable to this side.';
  if (!isActive(p) || p.transportId) return 'Choose an active, independent leader.';
  if (missingDriver(s,p)) return 'Resolve the missing-driver task before declaring.';
  if (m.close && s.band !== 0) return 'This manoeuvre requires Close range at the start of the round.';
  if (m.vehicle && p.kind !== 'vehicle') return 'This manoeuvre requires a vehicle.';
  if (key === 'hide' && s.band < 2) return 'Hide requires Medium range or farther.';
  const due = p.status === 'closeCall' && p.dueRound <= s.round;
  if (due && !['emergency','stop'].includes(key)) return 'The leader must take Emergency Action or Stop after the close call.';
  if (key === 'emergency' && !due) return 'Emergency Action requires a close call or a GM-recorded takeover requiring recovery.';
  return '';
}
export function validateDeclaration(s, side, raw) {
  const err = manoeuvreError(s, side, raw.key); if (err) throw new Error(err);
  const stunt = ['stunt','stuntEscape'].includes(raw.key);
  const penalty = stunt ? number(raw.penalty, 'Stunt penalty', -100, -2, true) : 0;
  if (penalty % 2) throw new Error('Choose an even stunt penalty (−2, −4, and so on).');
  return {key:raw.key, penalty, operatorAttacks:!!raw.operatorAttacks, notes:textValue(raw.notes, 500)};
}
export function breakdown(s, side) {
  if(missingDriver(s,unit(s,s.sides[side].leader)))throw new Error('Choose a replacement driver or resolve the vehicle’s wreck.');
  const team = s.sides[side], p = travelStats(s, unit(s, team.leader)), d = team.declaration;
  if (!d) throw new Error('Declare both manoeuvres first.');
  const key = d.key;
  const isStatic = !!MANOEUVRES[key].static || team.forcedStatic;
  let base = p.skill;
  if (p.kind === 'character' && key === 'hide') base = p.stealth;
  if (team.baseOverride != null) base = team.baseOverride;
  if (base == null) throw new Error('Enter a DX-based Stealth level or a base-skill override for Hide.');
  let mod = MANOEUVRES[key].mod, pendingStunt=false;
  if (key === 'hide') mod = [-10,-5,0][s.band - 2];
  if (key === 'moveAttack') mod = p.kind === 'character' || d.operatorAttacks ? -2 : 0;
  if (['stunt','stuntEscape'].includes(key)) {
    const check = s.checks.findLast(x => x.id === team.leader && x.purpose === 'stunt');
    pendingStunt=!check;
    mod = check?.success ? -d.penalty / 2 : 0;
  }
  const parts = [{label:team.baseOverride != null ? 'Base skill override' : (key === 'hide' && p.kind === 'character' ? 'Stealth' : p.skillName), value:base},
    {label:'Speed',value:isStatic ? 0 : speedBonus(p.speed,s.ruleOptions?.speedRounding!=='table')}, {label:'Handling',value:p.kind === 'vehicle' ? p.handling : 0},
    {label:MANOEUVRES[key].name,value:mod}, {label:'Complementary skill',value:team.comp}, {label:'Other modifiers',value:team.extra}];
  return {parts,target:parts.reduce((n,x) => n + x.value,0), isStatic, pendingStunt};
}
export function contest(s) {
  const q = s.sides.quarry, p = s.sides.pursuer;
  if (!q.roll || !p.roll) throw new Error('Both Chase Rolls are required.');
  const diff = contestMargin(q.roll) - contestMargin(p.roll);
  const winner = diff > 0 ? 'quarry' : diff < 0 ? 'pursuer' : null;
  const margin = Math.abs(diff), steps = margin >= 10 ? 2 : margin >= 5 ? 1 : 0;
  // Criticals do not automatically win a Quick Contest: Basic Set p. B348.
  if (q.declaration.key === 'hide') return {type:winner === 'quarry' ? 'hideWin' : 'fixed', winner, margin, steps:0, band:winner === 'quarry' ? null : 0};
  if (q.declaration.key === 'reverse') {
    const leader = unit(s,q.leader);
    const wiped = leader?.status === 'closeCall' || leader?.status === 'wreck';
    return {type:'reverse', winner, margin, steps:0, band:0, swap:winner === 'quarry' && q.roll.success && !wiped};
  }
  const qs = breakdown(s,'quarry').isStatic, ps = breakdown(s,'pursuer').isStatic;
  if (qs && ps) return {type:'shift',winner:null,margin,steps:0};
  if (qs !== ps) {
    const mover = qs ? 'pursuer' : 'quarry';
    return {type:'shift',winner:mover,margin,steps:1 + (winner === mover ? steps : 0), staticBonus:true};
  }
  return {type:'shift',winner,margin,steps};
}
export function rangeChoices(s, result) {
  if (result.type === 'hideWin') return [{key:'escape',label:'Escape'},...[0,1,2].map(band => ({key:`hide-${band}`,label:`Become pursuer at ${BANDS[band]}`,band,swap:true}))];
  if (result.type === 'fixed' || result.type === 'reverse') return [{key:'fixed', label:`${BANDS[result.band]}${result.swap ? ' · swap roles' : ''}`, band:result.band, swap:result.swap}];
  const choices = [{key:'hold',label:`Hold at ${BANDS[s.band]}`,band:s.band}];
  if (!result.steps || !result.winner) return choices;
  const mustClose = result.winner === 'pursuer' && s.sides.pursuer.declaration.key === 'mobilityPursuit';
  for (let n=1;n<=result.steps;n++) {
    if (s.band-n>=0) choices.push({key:`close-${n}`,label:`Close ${n} → ${BANDS[s.band-n]}`,band:s.band-n});
    if (!mustClose && s.band+n<=4) choices.push({key:`open-${n}`,label:`Open ${n} → ${BANDS[s.band+n]}`,band:s.band+n});
    if (!mustClose && result.winner === 'quarry' && s.band+n>4 && !choices.some(x=>x.key==='escape')) choices.push({key:'escape',label:'Escape beyond Extreme'});
  }
  return choices;
}
export function attackModifiers({band, manoeuvre, role = 'passenger', bulk = 0, acc = 0, gunslinger = false, target = 0}) {
  if (!MANOEUVRES[manoeuvre]) throw new Error('Choose a manoeuvre.');
  const ordinary = ['attack','embark','force','moveAttack','ram'].includes(manoeuvre);
  if ((!ordinary && !gunslinger) || manoeuvre === 'hide') throw new Error('This manoeuvre does not allow this ranged attack.');
  const moving = ['embark','force','moveAttack','ram'].includes(manoeuvre);
  const movement = gunslinger || !moving ? 0 : role === 'passenger' ? -1 : Math.min(-2,bulk);
  const accuracy = manoeuvre === 'attack' ? acc+(gunslinger?1:0) : gunslinger && moving ? acc : 0;
  return {range:RANGE_PENALTIES[band],movement,accuracy,target,total:RANGE_PENALTIES[band]+movement+accuracy+target};
}
