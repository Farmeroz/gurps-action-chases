import {SIDES, MANOEUVRES, clone, unit, roots, isActive, travelStats, canControl, attackModifiers, actionSide, driverProblems, missingDriver, preferredStuntSkill, contest, breakdown, newChase} from './rules.mjs';

export const emptyWorkflow=()=>({approved:{},outcomes:{},legacyResolved:false});
/** Additive migration; old rolls, participants, identities and checkpoints survive. */
const record=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
/** Keep recognised records discoverable without sending damaged data through normal views. */
export function recoveryState(raw,error,roundState=null) {
  const s=roundState??newChase(typeof raw?.name==='string'?raw.name:'Saved chase needs recovery');
  if(!roundState){
    s.id=typeof raw?.id==='string'?raw.id:'recovery';
    s.epoch=typeof raw?.epoch==='string'?raw.epoch:'recovery';
    s.revision=Number.isSafeInteger(raw?.revision)?raw.revision:0;
  }
  s.recovery={kind:roundState?'round':'data',message:String(error?.message??error),original:clone(raw)};
  s.result=null;s.status='paused';s.phase='actions';
  s.outcomeRequired=roundState?'This saved round could not be recalculated. Review the saved data, then choose a GM outcome.':'This saved chase needs data recovery. Download the original record before restoring a backup or creating a new chase.';
  return s;
}
export function upgrade(raw) {
  if(!record(raw)||raw.schema!==1)return raw;
  try{return migrate(raw);}catch(error){return recoveryState(raw,error);}
}
function migrate(raw) {
  const s=clone(raw);
  // Never default malformed structural data into a usable-looking chase.
  if(!Array.isArray(s.participants)||!s.participants.every(p=>record(p)&&typeof p.id==='string'&&SIDES.includes(p.side)&&['character','vehicle'].includes(p.kind)&&Array.isArray(p.controllers)))throw new Error('The saved participant list is incomplete or invalid.');
  if(!record(s.sides)||!SIDES.every(k=>record(s.sides[k])))throw new Error('The saved side records are incomplete.');
  for(const key of ['checks','log','history','processed'])if(!Array.isArray(s[key]))throw new Error(`The saved ${key} list is invalid.`);
  for(const key of ['checks','log'])if(!s[key].every(record))throw new Error(`A saved ${key} entry is invalid.`);
  for(const key of ['passengerActions','blindRequests'])if(!record(s[key]))throw new Error(`The saved ${key} record is invalid.`);
  if(s.workflow&&(!record(s.workflow)||!record(s.workflow.approved)||!record(s.workflow.outcomes)))throw new Error('The saved task records are invalid.');
  if(s.pendingCrew!=null&&(!Array.isArray(s.pendingCrew)||!s.pendingCrew.every(record)))throw new Error('The saved crew transfers are invalid.');
  if(s.pendingLeaders!=null&&!record(s.pendingLeaders))throw new Error('The saved leader changes are invalid.');
  if(!Number.isInteger(s.band)||s.band<0||s.band>4||!Number.isSafeInteger(s.round)||s.round<1)throw new Error('The saved range or round is invalid.');
  if(s.recovery){
    if(!record(s.recovery)||!['round','data'].includes(s.recovery.kind)||!Object.hasOwn(s.recovery,'original'))throw new Error('The saved recovery record is incomplete.');
    // Previously issued recovery screens are already quarantined; preserve their original snapshot.
    return s;
  }
  if(!s.workflow){s.workflow=emptyWorkflow();s.workflow.legacyResolved=['chase','range','reverseCheck'].includes(s.phase);}
  s.workflowVersion=3;s.pendingCrew??=[];s.pendingLeaders??={};s.outcomeRequired??='';
  s.ruleOptions={speedRounding:s.ruleOptions?.speedRounding==='table'?'table':'action',driverShots:s.ruleOptions?.driverShots==='passengers'?'passengers':'general'};
  for(const p of s.participants)if(p.kind==='vehicle'&&s.participants.some(x=>x.transportId===p.id&&x.role==='operator'))p.driverRequired=true;
  for(const side of SIDES){
    const d=s.sides[side].declaration;
    if((d&&!MANOEUVRES[d.key])||(s.phase==='range'&&!d))return recoveryState(raw,new Error(`${side}: the saved declaration is missing or unknown.`),s);
  }
  // Old releases could clear a leader's roll while retaining a usable outcome.
  if(s.status!=='ended'&&s.phase==='range'&&(!s.sides.quarry.roll||!s.sides.pursuer.roll)) {
    s.result=null;s.status='paused';s.phase='actions';s.outcomeRequired='This saved round has an incomplete contest. Choose a GM outcome to continue.';
  }
  if(s.status!=='ended'&&s.phase==='range'&&s.sides.quarry.roll&&s.sides.pursuer.roll&&!driverProblems(s).length){
    try{
      for(const side of SIDES){
        if(!roots(s,side).some(p=>p.id===s.sides[side].leader))throw new Error(`${side}: the saved leader is no longer available.`);
        if(!Number.isFinite(breakdown(s,side).target))throw new Error(`${side}: the saved target calculation is invalid.`);
      }
      s.result=contest(s);
    }catch(error){return recoveryState(raw,error,s);}
  }
  return s;
}
export function attackAllowed(s,p) {
  if(!p||!isActive(p)||s.status!=='running'||s.phase!=='actions')return false;
  const d=s.sides[actionSide(s,p)]?.declaration;if(!d)return false;
  if(missingDriver(s,p)||(p.transportId&&!isActive(unit(s,p.transportId))))return false;
  const operator=p.kind==='vehicle'?s.participants.find(x=>x.transportId===p.id&&x.role==='operator'&&isActive(x)):null;
  const shooter=operator??p;
  if(p.kind==='vehicle'&&s.ruleOptions?.driverShots==='passengers'&&['force','ram','embark'].includes(d.key)&&!shooter.gunslinger)return false;
  if(p.kind==='vehicle'&&d.key==='moveAttack'&&!d.operatorAttacks)return false;
  try{attackModifiers({band:s.band,manoeuvre:d.key,gunslinger:shooter.gunslinger});return true;}catch{return false;}
}
export function suggestedCheck(s,p,purpose='stunt') {
  const stats=travelStats(s,p),d=s.sides[p.side].declaration;
  const base=p.kind==='vehicle'?stats.skill:p[preferredStuntSkill(p)];
  return purpose==='stunt'?(base==null?null:base+(d?.penalty??0)):stats.skill;
}
export function tasks(s) {
  if(!s.workflow)s=upgrade(s);
  const list=[],approved=s.workflow.approved,outcomes=s.workflow.outcomes;
  const add=t=>list.push({...t,done:t.kind==='driver'?false:!!(t.done||outcomes[t.id]),waived:!!outcomes[t.id]?.waived});
  for(const p of driverProblems(s))add({id:`driver:${p.id}`,participantId:p.id,side:p.side,group:'prepare',kind:'driver',required:true,gm:true,title:`${p.name}: replace driver or resolve wreck`,hint:'No active driver is at the controls. Choose a replacement now, or resolve the wreck. Takeover recovery is due next round.'});
  for(const side of SIDES) {
    const team=s.sides[side],d=team.declaration,leader=unit(s,team.leader);
    if(!d)continue;
    if(MANOEUVRES[d.key].scenery||d.key==='stunt')add({id:`scene:${side}`,side,group:'prepare',kind:'scene',required:true,gm:true,title:`Confirm ${MANOEUVRES[d.key].name}: ${leader?.name??side}`,hint:'Confirm the scenery, stunt description, or Lucky Break is suitable. For foot stunts, enter the minimum penalty of the chosen feat. Action 2, pp. 18–20, 32–34.',done:approved[`scene:${side}`]});
    if(d.key==='mobilityEscape')add({id:`mobility:${side}`,side,group:'prepare',kind:'mobility',required:true,gm:true,title:'Can the pursuer follow this escape?',hint:'Record the mobility decision here. The pursuer’s static status will follow it.',done:approved[`mobility:${side}`]});
    if(team.forcedStatic&&d.key!=='mobilityEscape')add({id:`static:${side}`,side,group:'prepare',kind:'static',required:true,gm:true,title:`${leader?.name??side}: still unable to follow?`,hint:'This restriction carries across rounds. Confirm it still applies, or clear it.',done:approved[`static:${side}`]});
    if(d.key==='hide'&&leader?.kind==='character'&&leader.stealth==null&&team.baseOverride==null)add({id:`skill:${side}`,side,group:'prepare',kind:'skill',required:true,gm:true,title:`Enter ${leader.name}’s Stealth for Hide`,hint:'Supply the DX-based level here; no need to pause and find the actor editor.'});
  }
  for(const side of ['pursuer','quarry']) {
    const d=s.sides[side].declaration;if(!d)continue;
    for(const p of roots(s,side)) {
      if(p.status==='closeCall'&&p.dueRound<=s.round&&d.key!=='emergency')add({id:`recover:${p.id}`,participantId:p.id,side,group:side,kind:'recover',required:true,gm:true,title:`${p.name}: Emergency Action or stop`,hint:'This participant is due to recover. Record individual recovery or take them out of the chase.',done:s.checks.some(x=>x.id===p.id&&x.recovered)});
      if(['stunt','stuntEscape'].includes(d.key))add({id:`stunt:${p.id}`,participantId:p.id,side,group:side,kind:'stunt',required:true,title:`${p.name}: resolve stunt`,hint:`Risk ${d.penalty}. Roll or enter the existing result here. Every participating unit needs its own result.`,target:suggestedCheck(s,p),done:s.checks.some(x=>x.id===p.id&&x.purpose==='stunt')});
      if(['force','ram'].includes(d.key))add({id:`contact:${p.id}`,participantId:p.id,side,group:side,kind:'contact',required:true,gm:true,title:`${p.name}: resolve ${MANOEUVRES[d.key].name}`,hint:'Resolve hit, defence, damage, and the required control rolls, or record that no attack was made. Action 2, pp. 32–35.'});
      if(d.key==='embark')add({id:`embark:${p.id}`,participantId:p.id,side,group:side,kind:'embark',required:true,gm:true,title:`${p.name}: enter or leave transport`,hint:'Schedule crew changes for next round, or record a failed start / no change. Action 2, p. 32.'});
      if(attackAllowed(s,p))add({id:`attack:${p.id}`,participantId:p.id,side,group:side,kind:'attack',required:false,title:`${p.name}: attack or pass`,hint:'An attack is optional. Roll here or record an externally resolved attack.'});
    }
    for(const p of s.participants.filter(x=>actionSide(s,x)===side&&x.transportId&&x.role==='passenger'&&isActive(x)&&isActive(unit(s,x.transportId))))add({id:`passenger:${p.id}`,participantId:p.id,side:p.side,group:side,kind:'passenger',required:false,title:`${p.name}: passenger action or pass`,hint:`Aboard ${unit(s,p.transportId).name}; uses this vehicle’s manoeuvre and action step. Choose an available action or pass. One passenger action per round.`,done:!!s.passengerActions[p.id]});
  }
  for(const [i,c]of s.checks.entries())if(c.pending||(!c.success&&!c.recovered&&c.total!=null)) {
    const p=unit(s,c.id);add({id:`consequence:${c.checkId??i}`,participantId:c.id,side:p?.side??'quarry',group:c.group??actionSide(s,p)??'quarry',kind:'consequence',required:true,gm:true,checkIndex:i,title:`${p?.name??'Participant'}: ${c.pending?'supply SR to resolve result':'review '+(c.status==='wreck'?'wreck':'close call')}`,hint:c.pending?'The original dice are saved. Enter Stability Rating without rerolling.':'Confirm damage and other consequences have been handled. Recovery will be tracked for the next round.',done:c.reviewed});
  }
  for(const [id,outcome]of Object.entries(outcomes))if(outcome.needsReview)add({id:`finish:${id}`,participantId:outcome.participantId,side:outcome.side,group:outcome.group??outcome.side,kind:'finish',required:true,gm:true,title:`${unit(s,outcome.participantId)?.name??'Participant'}: finish ${outcome.action.toLowerCase()}`,hint:outcome.action==='Attack'?'Resolve defence and any damage; then confirm the action is complete.':'Resolve the opposed result and any boarding or control change. Crew changes can be made directly below.'});
  return list;
}
export function activeGroup(s) {
  const all=tasks(s);
  for(const group of ['prepare','pursuer','quarry'])if(all.some(t=>t.group===group&&!t.done))return group;
  return null;
}
export function taskAccess(s,t,user,owned=()=>false) {
  if(t.kind==='driver'?!['running','paused'].includes(s.status):s.status!=='running'||s.phase!=='actions')return 'This task belongs to the actions step.';
  if(t.done)return 'Already recorded.';
  if(t.gm&&!user?.isGM)return 'The GM resolves this task.';
  if(!t.gm&&!canControl(s,unit(s,t.participantId),user,owned))return 'Waiting for this participant’s controller.';
  if(t.kind==='driver')return '';
  if(driverProblems(s).length)return 'Waiting for the GM to resolve the missing driver.';
  const group=activeGroup(s);
  if(t.group!==group)return `Waiting for ${group==='prepare'?'the GM’s scene decisions':`${group} actions`}.`;
  return '';
}
export const remainingRequired=s=>tasks(s).filter(t=>t.required&&!t.done);
export function readiness(s) {
  const blockers=[];
  for(const side of SIDES)if(!roots(s,side).length)blockers.push(`Add an independent character or vehicle to the ${side}.`);
  for(const p of driverProblems(s))blockers.push(`${p.name} needs a driver.`);
  return blockers;
}
