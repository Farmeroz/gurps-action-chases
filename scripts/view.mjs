import {SIDES,BANDS,MANOEUVRES,unit,roots,travelStats,operatorOf,canControl,breakdown,contestMargin,rangeChoices,manoeuvreError,missingDriver,escapeHTML as e} from './rules.mjs';
import {actorOwned} from './integration.mjs';
import {tasks,taskAccess,activeGroup,remainingRequired,readiness,upgrade} from './workflow.mjs';
import {submissionStatus,ownCommitment} from './store.mjs';
const option=(value,label,selected)=>`<option value="${e(value)}" ${String(value)===String(selected)?'selected':''}>${e(label)}</option>`;
export const input=(name,label,value='',type='text',extra='')=>`<label class="gac-field"><span>${e(label)}</span><input name="${e(name)}" type="${type}" value="${e(value??'')}" ${extra}></label>`;
export const select=(name,label,choices,value)=>`<label class="gac-field"><span>${e(label)}</span><select name="${e(name)}">${choices.map(x=>option(x.value,x.label,value)).join('')}</select></label>`;
export const checkbox=(name,label,checked=false)=>`<label class="gac-check"><input type="checkbox" name="${e(name)}" ${checked?'checked':''}><span>${e(label)}</span></label>`;
export const textarea=(name,label,value='')=>`<label class="gac-field gac-full"><span>${e(label)}</span><textarea name="${e(name)}" rows="3">${e(value)}</textarea></label>`;
const button=(action,label,attrs='',disabled=false)=>`<button type="button" data-do="${action}" ${attrs} ${disabled?'disabled':''}>${label}</button>`;
const title=side=>side==='quarry'?'Quarry':'Pursuer';
const control=(s,p,u)=>canControl(s,p,u,actorOwned);
const PHASES={quarry:'Quarry declares',pursuer:'Pursuer responds',actions:'Resolve actions',chase:'Chase Rolls',reverseCheck:'Resolve failed Reverse',range:'Choose outcome',ended:'Chase ended'};
const owner=(s,p)=>{
  const names=[...(globalThis.game?.users??[])].filter(u=>!u.isGM&&control(s,p,u)).map(u=>u.name);
  return names.join(', ')||'GM';
};
function taskCard(s,t,user){
  const reason=taskAccess(s,t,user,actorOwned),p=unit(s,t.participantId);
  return `<article class="gac-task ${reason?'waiting':''}" data-task="${e(t.id)}"><div><small>${t.required?'Required':'Optional'} · ${e(t.gm?'GM':owner(s,p))}</small><h3>${e(t.title)}</h3><p>${e(t.hint)}</p>${t.kind==='stunt'&&p?.kind==='vehicle'&&p.sr==null?'<p class="gac-warning">SR is missing. The GM can enter it here; a failed roll will keep its original dice until SR is supplied.</p>':''}${reason?`<small>${e(reason)}</small>`:''}</div><div class="gac-buttons">${button('task',t.gm?'Resolve':'Roll / enter result',`data-task="${e(t.id)}"`,!!reason)}${!t.required?button('passTask','Pass',`data-task="${e(t.id)}"`,!!reason):''}</div></article>`;
}
function nextPanel(s,user){
  const gm=user.isGM;let heading='Next action',body='',buttons='';
  const drivers=tasks(s).filter(t=>t.kind==='driver');
  if(drivers.length&&['running','paused'].includes(s.status))return `<section class="gac-next"><div><span class="gac-kicker">Next action</span><h2>Resolve vehicle control</h2><p>The GM chooses a replacement driver or resolves the wreck before play continues.</p></div></section><div class="gac-tasks">${drivers.map(t=>taskCard(s,t,user)).join('')}</div>`;
  if(s.outcomeRequired)return `<section class="gac-next"><div><span class="gac-kicker">Next action</span><h2>Resolve this round’s outcome</h2><p>${e(s.outcomeRequired)}</p></div>${gm?button('override','GM outcome / end chase','class="gac-primary"'):''}</section>`;
  if(s.status==='setup'){
    const missing=readiness(s);body=missing.length?missing.map(e).join('<br>'):'Both sides are ready. Check player assignments, then start.';
    buttons=gm?(missing.length?button('addCharacter','Add character')+button('addVehicle','Add vehicle'):button('start','Start chase','class="gac-primary"')):'Ask the GM to finish setup and assign your participants.';
  }else if(s.status==='paused'){heading='Chase paused';body='Resolve tactical combat or make your changes. Resume returns to the same chase step.';buttons=gm?button('resume','Resume chase','class="gac-primary"'):'';if(s.checks.some(c=>c.reverse&&c.status==='wreck')){heading='Reverse ended in a wreck';body='Choose a GM outcome to finish this round or end the chase. Any replacement leader will be used next round.';buttons=gm?button('override','GM outcome / end chase','class="gac-primary"'):'';}}
  else if(s.status==='ended'){heading='Chase ended';body='The result and log remain available below.';buttons=gm?button('restart','Return to setup'):'';}
  else if(['quarry','pursuer'].includes(s.phase)){
    const sides=s.blind?SIDES.filter(k=>!s.blindRequests[k]):[s.phase];
    if(!sides.length){body='Both private choices are committed.';buttons=gm?button('reveal','Reveal manoeuvres','class="gac-primary"'):'Waiting for the GM to reveal.';}
    else{body=sides.map(k=>`${e(owner(s,unit(s,s.sides[k].leader)))}: choose ${title(k).toLowerCase()} manoeuvre below.`).join('<br>');if(s.blind)body+='<br>Each side commits privately; the GM reveals both together.';}
  }else if(s.phase==='actions'){
    const all=tasks(s),group=activeGroup(s),required=remainingRequired(s),current=all.filter(t=>!t.done&&t.group===group);
    heading=group==='prepare'?'GM scene decisions':group?`${title(group)} actions`:'Ready for Chase Rolls';
    body=required.length?`${required.length} required ${required.length===1?'task remains':'tasks remain'}. Resolve the highlighted tasks; later tasks are listed underneath.`:'All required tasks are complete. Take any optional actions now, or continue and pass them.';
    const missing=readiness(s);if(missing.length){heading='Resolve the chase outcome';body='A side has no active independent participants. Resolve any consequences below, then use a GM outcome ruling to end or reorganise the chase.';}
    if(!gm&&current.length&&!current.some(t=>!taskAccess(s,t,user,actorOwned)))body='Waiting for '+(group==='prepare'?'the GM’s scene decisions':`${title(group).toLowerCase()} actions`)+'. Your later actions are listed below.';
    buttons=gm?(required.length?(current.length&&current.every(t=>!t.required)?button('passSide',`Pass unused ${group} actions`):''):button('actionsDone',all.some(t=>!t.done)?'Continue · pass unused actions':'Continue to Chase Rolls','class="gac-primary"')):'';
    if(gm&&missing.length)buttons=button('override','GM outcome / end chase','class="gac-primary"');
    const visibleCurrent=gm?current:current.filter(t=>!t.gm&&control(s,unit(s,t.participantId),user)),otherCurrent=current.filter(t=>!visibleCurrent.includes(t));
    return `<section class="gac-next" aria-label="Next action"><div><span class="gac-kicker">${gm?'Next action':'Your next action'}</span><h2>${e(heading)}</h2><p>${body}</p></div><div class="gac-buttons">${buttons}</div></section><div class="gac-tasks">${visibleCurrent.map(t=>taskCard(s,t,user)).join('')}${otherCurrent.length?`<details data-persist="others-current"><summary>Waiting on others · ${otherCurrent.length} current ${otherCurrent.length===1?'task':'tasks'}</summary>${otherCurrent.map(t=>taskCard(s,t,user)).join('')}</details>`:''}${all.some(t=>!t.done&&t.group!==group)?`<details data-persist="upcoming"><summary>Upcoming tasks · ${all.filter(t=>!t.done&&t.group!==group&&t.required).length} required, ${all.filter(t=>!t.done&&t.group!==group&&!t.required).length} optional</summary>${all.filter(t=>!t.done&&t.group!==group).map(t=>taskCard(s,t,user)).join('')}</details>`:''}${all.some(t=>t.done)?`<details data-persist="completed"><summary>Completed this round · ${all.filter(t=>t.done).length}</summary><ul>${all.filter(t=>t.done).map(t=>`<li>${e(t.title)} · ${t.waived?'GM ruling':s.workflow.outcomes[t.id]?.passed?'passed':'recorded'}</li>`).join('')}</ul></details>`:''}</div>`;
  }else if(s.phase==='chase'){body=SIDES.filter(k=>!s.sides[k].roll).map(k=>`${e(owner(s,unit(s,s.sides[k].leader)))}: roll for ${title(k).toLowerCase()} below.`).join('<br>');}
  else if(s.phase==='reverseCheck'){body='The quarry failed Reverse. Resolve the wipeout using the saved Chase Roll; there is no reroll.';buttons=gm?`<span data-id="${e(s.sides.quarry.leader)}">${button('check','Resolve original result','class="gac-primary"')}</span>`:'';}
  else if(s.phase==='range'&&s.result){
    const who=s.result.type==='hideWin'?'quarry':s.result.winner,can=gm||(who&&control(s,unit(s,s.sides[who].leader),user));
    body=`${who?`${title(who)} chooses the outcome`:'GM confirms unchanged range'}. Contest margin ${s.result.margin}.`;
    buttons=rangeChoices(s,s.result).map(c=>button('range',e(c.label),`data-choice="${c.key}"`,!can)).join('');
  }
  return `<section class="gac-next" aria-label="Next action"><div><span class="gac-kicker">${gm?'Next action':'Your next action'}</span><h2>${e(heading)}</h2><p>${body}</p></div><div class="gac-buttons">${buttons}</div></section>`;
}
function teamCard(s,side,user,docId){
  const t=s.sides[side],p=unit(s,t.leader),d=t.declaration,can=control(s,p,user),running=s.status==='running';
  const declares=running&&!d&&!s.blindRequests[side]&&(s.blind?['quarry','pursuer'].includes(s.phase):s.phase===side);
  let b=null,error='';try{if(d)b=breakdown(s,side);}catch(err){error=err.message;}
  const own=s.blindRequests[side]?ownCommitment(docId,s.epoch,side):null;
  return `<section class="gac-team ${side}"><header><span class="gac-kicker">${title(side)}</span>${user.isGM?button('leader','Leader',`data-side="${side}"`):''}</header><h2>${e(p?.name??'Add a participant')}</h2><small>${e(p?owner(s,p):'GM')} controls this side</small><div class="gac-declaration"><strong>${d?e(MANOEUVRES[d.key].name):s.blindRequests[side]?own?`Your commitment: ${e(MANOEUVRES[own]?.name)}`:'Committed · hidden':'Awaiting declaration'}</strong>${d?.notes?`<p>${e(d.notes)}</p>`:''}</div>
  ${s.pendingLeaders?.[side]?`<p class="gac-recorded">Leader next round: ${e(unit(s,s.pendingLeaders[side])?.name??'unavailable')}</p>`:''}
  ${declares&&can&&!missingDriver(s,p)?`<div class="gac-quick"><small>${s.blind?'Commit privately':'Choose a manoeuvre'}</small><div class="gac-buttons">${['move','attack','moveAttack'].filter(k=>!manoeuvreError(s,side,k)).map(k=>button('quickDeclare',e(MANOEUVRES[k].name),`data-side="${side}" data-key="${k}"`)).join('')}${button('declare','More manoeuvres…',`data-side="${side}"`)}</div>${p?.kind==='vehicle'&&!manoeuvreError(s,side,'moveAttack')?`<label class="gac-check"><input type="checkbox" data-operator="${side}">Driver also attacks with Move and Attack</label>`:''}</div>`:''}
  ${d?`<details data-persist="calculation-${side}"><summary>${b?`Chase target ${b.target}${b.isStatic?' · Static':''}${b.pendingStunt?' · Stunt pending':''}`:'Chase target needs a value'} · details</summary><p>${e(MANOEUVRES[d.key].hint)} Action 2, p. ${MANOEUVRES[d.key].page}.</p>${b?.pendingStunt?'<p>Stunt bonus is 0 until the leader’s success is recorded.</p>':''}${b?`<div class="gac-breakdown">${b.parts.map(x=>`<span>${e(x.label)} <b>${x.value>=0?'+':''}${x.value}</b></span>`).join('')}</div>`:''}${user.isGM&&['actions','chase'].includes(s.phase)?button('modifiers','Adjust modifiers',`data-side="${side}"`,!!t.roll):''}</details>`:''}
  ${error?`<p class="gac-warning">${e(error)}${d?.key==='hide'?' Resolve the highlighted Stealth task above.':''}</p>`:''}
  ${running&&s.phase==='chase'&&can&&!t.roll?`<div class="gac-buttons">${button('roll','Roll 3d6',`data-side="${side}" class="gac-primary"`)}${user.isGM?button('manualRoll','Enter existing roll',`data-side="${side}"`):''}</div>`:''}
  ${t.roll?`<div class="gac-roll"><strong>${t.roll.total}</strong><span>vs ${t.roll.target}<br>Contest margin ${contestMargin(t.roll)}${contestMargin(t.roll)!==t.roll.margin?' · automatic-result convention':''}${t.roll.manual?' · entered':''}</span></div>`:''}</section>`;
}
function participantRow(s,p,user){
  const op=operatorOf(s,p),stats=travelStats(s,p),transport=unit(s,p.transportId),can=control(s,p,user);
  return `<article class="gac-person" data-id="${e(p.id)}"><div class="gac-person-title"><div><strong>${e(p.name)}</strong><p>${title(p.side)}${s.sides[p.side].leader===p.id?' · Leader':''} · ${transport?e(p.role==='operator'?'Driver':'Passenger'):p.kind==='vehicle'?'Vehicle':'On foot'} · ${e(owner(s,p))}</p></div><span class="gac-status ${p.status}">${e(p.status==='closeCall'?`Recovery R${p.dueRound}`:p.status)}</span></div><p class="gac-person-stats">${p.kind==='vehicle'?`${e(op?`${op.name}: `:missingDriver(s,p)?'':'Fallback operator: ')}${e(stats.skillName)} ${stats.skill??''} · Move ${p.speed} · Hnd ${p.handling} / SR ${p.sr??'not set'}`:`${e(stats.skillName)} ${stats.skill}${!transport?` · Move ${p.speed}`:''}`}${p.hp!=null?` · HP ${p.hp}`:''}</p>
  ${s.pendingCrew.filter(x=>x.personId===p.id).map(x=>`<p class="gac-recorded">Next round: ${x.vehicleId?`${e(unit(s,x.vehicleId)?.name)} · ${x.role==='operator'?'driver':'passenger'}`:'on foot'}</p>`).join('')}
  ${user.isGM&&p.kind==='vehicle'?`<div class="gac-buttons">${button('crew','Change driver / board',`data-vehicle="${e(p.id)}"`)}${button('addCrew','Add crew')}</div>`:''}
  ${(user.isGM||can)?`<details data-persist="person-${e(p.id)}"><summary>Details & actions</summary>${p.notes?`<p>${e(p.notes)}</p>`:''}<div class="gac-buttons">${user.isGM?button('edit','Edit')+button('duplicate','Duplicate')+button('condition','Condition / HP')+(p.kind==='character'?button('crew',transport?'Change role / disembark':'Board vehicle'):'')+button('remove','Remove'):''}${can?button('skillRoll','Other skill roll')+(p.actorUuid?button('gga','GGA roll'):''):''}${user.isGM&&s.status==='running'&&s.phase==='actions'?button('check','Additional control result'):''}</div></details>`:''}</article>`;
}
function roster(s,user,onlyMine=false){
  const include=p=>!onlyMine||control(s,p,user)||s.participants.some(x=>x.transportId===p.id&&control(s,x,user));
  const top=s.participants.filter(p=>!p.transportId&&include(p));
  // A controlled hostile boarder still appears with their transport in Your participants.
  return top.map(p=>`<div class="gac-unit">${participantRow(s,p,user)}${p.kind==='vehicle'?`<div class="gac-crew">${s.participants.filter(x=>x.transportId===p.id).map(x=>participantRow(s,x,user)).join('')}</div>`:''}</div>`).join('')||'<p class="gac-muted">No participants assigned to you. Ask the GM to assign control, or use an actor you own.</p>';
}
function recoveryView(s,documents,selectedId,user,gmOnline,status){
  const gm=user.isGM,round=s.recovery.kind==='round';
  return `<div class="gac-shell"><div class="gac-toolbar"><label class="gac-picker"><span>Saved chase</span><select data-chase-picker>${option('','Choose a chase',selectedId)}${documents.map(d=>option(d.id,d.name.replace(/^Chase · /,''),selectedId)).join('')}</select></label><div class="gac-buttons">${button('help','Quick guide')}${gm?button('new','New chase'):''}</div></div>
  ${status?`<p class="gac-feedback ${status.kind}" role="status">${e(status.text)}</p>`:''}${!gmOnline?'<p class="gac-warning">No GM connected. Recovery changes need an active GM.</p>':''}
  <h1>${e(s.name)}</h1><section class="gac-next" aria-label="Next action"><div><span class="gac-kicker">Chase paused · recovery required</span><h2>Review the saved chase</h2><p>${e(s.outcomeRequired)}</p><p>The original saved record is retained. No range result has been applied.</p><p class="gac-warning" role="alert">${e(s.recovery.message)}</p></div></section>
  <div class="gac-buttons">${button('exportRecovery','Download original saved data')}${gm&&round?button('override','GM outcome / end chase','class="gac-primary"'):''}${gm&&round?button('undo','Undo','',!s.history.length):''}</div>
  <p>${round?'Review the roster below and any original results in the download. The GM may correct participant details, then apply a reasoned outcome or end the chase. Undo returns to a retained earlier checkpoint when available.':'Restore a known-good world backup, seek help with the downloaded record, or create a new chase. This screen cannot safely reconstruct missing data.'}</p>
  ${!gm?'<p>Waiting for the GM to resolve recovery. Normal actions are unavailable.</p>':''}
  ${round?`<h2>Participants to review</h2>${s.participants.map(p=>`<article class="gac-person" data-id="${e(p.id)}"><strong>${e(p.name)}</strong><span> · ${e(p.side)}</span>${gm?button('edit','Edit'):''}</article>`).join('')}`:''}
  <p>The recovery download preserves the saved record for diagnosis or restoration. It is not a portable Import JSON template.</p></div>`;
}
export function renderTracker({documents=[],selectedId='',state=null,user,gmOnline=true}){
  const s=state?upgrade(state):null,gm=user.isGM,status=submissionStatus(selectedId);
  if(s?.recovery)return recoveryView(s,documents,selectedId,user,gmOnline,status);
  return `<div class="gac-shell"><div class="gac-toolbar"><label class="gac-picker"><span>Saved chase</span><select data-chase-picker aria-label="Saved chase">${option('','Choose a chase',selectedId)}${documents.map(d=>option(d.id,d.name.replace(/^Chase · /,''),selectedId)).join('')}</select></label><details class="gac-menu" data-persist="manage"><summary>${gm?'Manage chase':'Chase menu'}</summary><div class="gac-buttons">${gm?button('new','New chase')+button('import','Import JSON'):''}${s?button('export','Export JSON'):''}${s?.recoveryArchive?button('exportRecovery','Download original saved data'):''}${button('help','Quick guide')}${s&&gm?button('configure','Settings')+button('show','Show to players')+button('undo','Undo','',!s.history.length)+button('override','GM range / end')+button('note','Log ruling'):''}</div></details></div>
  ${status?`<p class="gac-feedback ${status.kind}" role="status" aria-live="polite">${e(status.text)}</p>`:''}${!gmOnline?'<p class="gac-warning">No GM connected. Saved information is available; changes need an active GM.</p>':''}
  ${!s?`<div class="gac-empty"><h1>Keep the chase moving.</h1><p>Add people or vehicles. Actors and tokens are optional.</p>${gm?button('demo','Create example chase','class="gac-primary"')+button('new','New chase'):'<p>Your GM can open a chase for you.</p>'}</div>`:`<div class="gac-title"><div><h1>${e(s.name)}</h1><p>${BANDS[s.band]} range · Round ${s.round} · ${s.status==='running'?PHASES[s.phase]:e(s.status)}${s.combatId?' · Combat linked':''}</p></div>${gm&&s.status==='running'?button('pause','Pause / tactical combat'):''}</div>${s.environment?`<p class="gac-muted">${e(s.environment)}</p>`:''}
  ${(s.crewAlerts??[]).map(message=>`<p class="gac-warning">${e(message)}</p>`).join('')}${nextPanel(s,user)}<div class="gac-teams">${SIDES.map(k=>teamCard(s,k,user,selectedId)).join('')}</div>
  <div class="gac-track" aria-label="Current range: ${BANDS[s.band]}">${BANDS.map((b,i)=>`<div class="${i===s.band?'current':''}"><strong>${b}</strong>${i===s.band?'<small>Current range</small>':''}</div>`).join('')}</div>
  <div class="gac-section-title"><h2>${gm?'Participants & crews':'Your participants'}</h2><div class="gac-buttons">${gm?button('addCharacter','Add character')+button('addVehicle','Add vehicle')+button('actor','From actor'):''}</div></div><div class="gac-roster">${roster(s,user,!gm)}</div>${!gm?`<details data-persist="shared-roster"><summary>All participants & crews · ${s.participants.length}</summary><div class="gac-roster">${roster(s,user)}</div></details>`:''}
  <details class="gac-log" data-persist="log"><summary>Chase log · ${s.log.length} entries</summary><ol>${s.log.slice().reverse().map(x=>`<li><span>R${x.round}</span> ${e(x.text)}</li>`).join('')||'<li>Ready for setup.</li>'}</ol></details><footer>Action 2: Exploits, pp. 31–35. Abstract chase rounds; the GM controls tactical turns, token movement and damage. Shared stats are snapshots.</footer>`}</div>`;
}
export function participantForm(s,p,users){
  const onFoot=p.kind==='character'&&p.footMode&&!p.transportId;
  const basic=[input('name','Name',p.name,'text','required maxlength="100"'),select('side','Side',SIDES.map(x=>({value:x,label:title(x)})),p.side),input(onFoot?'footSkillName':'skillName',p.kind==='vehicle'?'Fallback operator skill':'Chase skill',onFoot?p.footSkillName:p.skillName),input(onFoot?'footSkill':'skill','DX-based skill level',onFoot?p.footSkill:p.skill,'number','required min="1" max="1000"'),input('speed',p.kind==='vehicle'?'Top speed (yards/second)':'Top Move (including Enhanced Move)',p.speed,'number','required min="0" step="any"')];
  if(p.kind==='vehicle')basic.push(input('handling','Handling',p.handling,'number','required min="-20" max="20"'));
  const advanced=[];
  if(p.kind==='vehicle')advanced.push(input('sr','Stability Rating (needed for failed control / stunt)',p.sr,'number','min="0" max="100"'),input('sm','Size Modifier',p.sm,'number'));
  else advanced.push(select('transportId','Vehicle',[{value:'',label:'Independent / on foot'},...s.participants.filter(x=>x.kind==='vehicle').map(x=>({value:x.id,label:x.name}))],p.transportId),select('role','Crew role',[{value:'passenger',label:'Passenger'},{value:'operator',label:'Driver / operator'}],p.role),...['stealth','acrobatics','climbing','jumping'].map(k=>input(k,`${k[0].toUpperCase()+k.slice(1)} (DX-based)`,p[k],'number')),checkbox('gunslinger','Gunslinger',p.gunslinger),input(onFoot?'skillName':'footSkillName',onFoot?'Vehicle / operator skill (retained)':'On-foot chase skill (for transport changes)',onFoot?p.skillName:p.footSkillName||'Running (DX-based)'),input(onFoot?'skill':'footSkill',onFoot?'DX-based vehicle / operator level':'DX-based level on foot (optional)',onFoot?p.skill:p.footSkill,'number','min="1" max="1000"'));
  advanced.push(...[['st','ST'],['hp','Current HP'],['maxHp','Maximum HP'],['dr','DR'],['ht','HT']].map(([k,l])=>input(k,l,p[k],'number')),
    select('actorUuid','Linked actor (optional)',[{value:'',label:'Ad hoc; no actor needed'},...[...(globalThis.game?.actors??[])].map(a=>({value:a.uuid,label:a.name})),...(p.actorUuid&&![...(globalThis.game?.actors??[])].some(a=>a.uuid===p.actorUuid)?[{value:p.actorUuid,label:'Current linked actor / token'}]:[])],p.actorUuid),textarea('notes','Shared notes',p.notes));
  return `<p>Use a DX-based skill level. ${p.kind==='vehicle'?'A separate driver replaces the fallback skill; the vehicle supplies speed and Handling.':'Convert HT-based Running to DX for Chase Rolls.'} Values stay with the chase.</p><div class="gac-form-grid">${basic.join('')}</div><fieldset><legend>Who controls this participant?</legend><p>Linked actor owners can act automatically. Assign any player below, including for ad hoc entries.</p>${users.filter(u=>!u.isGM).map(u=>checkbox(`controller:${u.id}`,u.name,p.controllers.includes(u.id))).join('')||'<p>No player accounts yet. The GM can control everyone.</p>'}</fieldset><details data-advanced ${p.transportId?'open':''}><summary>Optional stats, crew, actor link & notes</summary><div class="gac-form-grid">${advanced.join('')}</div></details>`;
}

/** Keep saved IDs as option values, but identify encounters by useful display information. */
export function combatChoices(combats,selectedId='') {
  const list=[...combats];
  const names=list.map((c,i)=>{
    const name=String(c.name??'').trim();
    return (name&&name!==c.id&&name!==`Combat ${c.id}`?name:'')||c.scene?.name||`Encounter ${i+1}`;
  });
  const seen=new Map();
  const options=list.map((c,i)=>{
    const name=names[i],ordinal=(seen.get(name)??0)+1;seen.set(name,ordinal);
    const duplicate=names.filter(n=>n===name).length>1?` (${ordinal})`:'';
    const round=Number(c.round)>0?`Round ${c.round}`:'Not started';
    return {value:c.id,label:`${name}${duplicate} · ${round}${c.active?' · Active':''}`};
  });
  if(selectedId&&!list.some(c=>c.id===selectedId))options.push({value:selectedId,label:'Previously linked encounter (unavailable)'});
  return [{value:'',label:'Standalone chase'},...options];
}
export function settingsForm(s,combats) {
  const setup=s.status==='setup';
  const ruleOptions=s.ruleOptions??{speedRounding:'action',driverShots:'general'};
  const rules=setup?`<details><summary>Rules choices</summary><p>Choose how this chase handles two ambiguities in the printed rules. These choices are saved with the chase and lock at Start chase.</p>${select('speedRounding','Speed bonus at Move 6',[{value:'action',label:'Action 2 example: +3'},{value:'table',label:'Round down on the Size table: +2'}],ruleOptions.speedRounding)}${select('driverShots','Driver ranged attacks during Force, Ram and Disembark / Embark',[{value:'general',label:'Allow: general Attacks text (p. 35)'},{value:'passengers',label:'Passengers only: individual manoeuvre text'}],ruleOptions.driverShots)}<p>Gunslinger keeps its stated exceptions. These options do not change the manoeuvre’s contact attacks or Chase Roll penalty.</p></details>`:`<details><summary>Rules choices · fixed for this chase</summary><p>Move 6 speed bonus: ${ruleOptions.speedRounding==='table'?'+2 (table rounding)':'+3 (Action 2 example)'}. Driver ranged attacks during Force, Ram and Disembark / Embark: ${ruleOptions.driverShots==='passengers'?'passengers only, with Gunslinger exceptions':'allowed under general Attacks text'}.</p></details>`;
  const name=input('name','Name',s.name,'text','required maxlength="100"');
  const status=setup?`<div class="gac-form-grid">${name}${select('band','Starting range',BANDS.map((label,value)=>({value,label})),s.band)}</div>`:
    `${name}<section class="gac-settings-status" aria-label="Current chase settings"><dl><div><dt>Current range</dt><dd>${e(BANDS[s.band])}</dd></div><div><dt>Declarations</dt><dd>${s.blind?'Private, revealed together':'Quarry first, then pursuer'}</dd></div></dl><p>Declaration mode is fixed after setup. For a range ruling, use Manage chase → GM range / end.</p></section>`;
  return `<div class="gac-settings">${status}${textarea('environment','Shared scene conditions',s.environment)}${select('combatId','Linked combat (optional)',combatChoices(combats,s.combatId),s.combatId)}<p class="gac-settings-help">Keep a reference to an encounter while running the chase. Chase rounds and combat turns advance separately.</p>${setup?checkbox('blind','Private simultaneous commitments',s.blind)+'<p class="gac-settings-help">Starting range and declaration mode lock when the chase starts.</p>':''}${rules}</div>`;
}
