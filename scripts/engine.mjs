import {SIDES, MANOEUVRES, BANDS, clone, uid, number, textValue, newParticipant, freshSide, newChase, unit, roots, isActive, canControl, validateDeclaration, breakdown, successRoll, contest, contestMargin, rangeChoices, wipeout, attackModifiers, operatorOf, actionSide, driverProblems, missingDriver, rollsStarted, FOOT_STUNT_SKILLS, footSkillOf} from './rules.mjs';
import {upgrade,emptyWorkflow,tasks,taskAccess,activeGroup,remainingRequired,attackAllowed} from './workflow.mjs';

function requireGM(user) { if (!user?.isGM) throw new Error('Only a GM can do that.'); }
function requireControl(s, participant, user, owned) { if (!canControl(s,participant,user,owned)) throw new Error('You do not control this participant.'); }
function log(s, message) { s.log.push({round:s.round, text:message}); s.log=s.log.slice(-200); }
export function validateRoster(s) {
  const ids = new Set();
  for (const p of s.participants) {
    if (ids.has(p.id)) throw new Error('Duplicate participant ID.'); ids.add(p.id);
    if (p.transportId) {
      const vehicle = unit(s,p.transportId);
      if (p.kind !== 'character' || !vehicle || vehicle.kind !== 'vehicle') throw new Error('Only a character can be assigned to an existing vehicle.');
      if (vehicle.side !== p.side && p.role === 'operator') throw new Error('An operator and their vehicle must be on the same side. A hostile boarder can be a passenger until control changes.');
    }
  }
  for (const p of s.participants.filter(p=>p.kind==='vehicle')) {
    if(s.participants.some(x=>x.transportId===p.id&&x.role==='operator'))p.driverRequired=true;
    if (s.participants.filter(x=>x.transportId===p.id&&x.role==='operator'&&isActive(x)).length>1) throw new Error(`${p.name} has more than one active operator. Change the old operator to passenger first.`);
  }
  for (const side of SIDES) if (!roots(s,side).some(p=>p.id===s.sides[side].leader)) s.sides[side].leader=roots(s,side)[0]?.id ?? '';
}
function saveCheckpoint(s) {
  const snap=clone(s); delete snap.history; delete snap.processed;
  s.history=[...(s.history??[]),snap].slice(-8);
}
function resetRound(s) {
  s.crewAlerts=[];
  for(const transfer of s.pendingCrew??[]){try{const trial=clone(s);applyCrew(trial,transfer);s.participants=trial.participants;s.sides=trial.sides;log(s,`${unit(s,transfer.personId).name}: scheduled crew change applied${transfer.note?' · '+transfer.note:''}.`);}catch(err){const message=`Scheduled crew change for ${unit(s,transfer.personId)?.name??'removed character'} cancelled: ${err.message}`;s.crewAlerts.push(message);log(s,message);}}
  for(const id of Object.values(s.pendingLeaders??{})) {
    const p=unit(s,id);
    if(p&&roots(s,p.side).some(x=>x.id===id)){s.sides[p.side].leader=id;log(s,`${p.side} leader for this round: ${p.name}.`);}
    else {const message=`Scheduled leader ${p?.name??'removed participant'} is no longer eligible; check the side’s leader.`;s.crewAlerts.push(message);log(s,message);}
  }
  s.pendingLeaders={};s.outcomeRequired='';validateRoster(s);
  s.pendingCrew=[];s.workflow=emptyWorkflow();
  for (const side of SIDES) { const t=s.sides[side]; s.sides[side]={...freshSide(t.leader),forcedStatic:t.forcedStatic}; }
  s.passengerActions={};s.blindRequests={};s.checks=[];s.result=null;s.phase='quarry';s.epoch=uid();
}
function applyCrew(s,c) {
  const person=unit(s,c.personId),vehicle=c.vehicleId?unit(s,c.vehicleId):null;
  if(!person||person.kind!=='character'||!isActive(person))throw new Error('Choose an active character for the crew change.');
  if(c.vehicleId&&(!vehicle||vehicle.kind!=='vehicle'||!isActive(vehicle)))throw new Error('Choose an active vehicle.');
  const origin=unit(s,person.transportId),originWasLeader=origin&&s.sides[origin.side].leader===origin.id;
  const departingDriver=origin&&person.role==='operator'&&origin.id!==vehicle?.id;
  if(origin&&!vehicle) {
    person.footSkill=number(c.footSkill??footSkillOf(person),'DX-based on-foot chase skill',1,1000);
    person.footSkillName=textValue(c.footSkillName||person.footSkillName||'Running (DX-based)',100);
    person.footMode=true;
  }
  if(departingDriver)origin.driverRequired=true;
  if(vehicle&&c.role==='operator') {
    const mustRecover=missingDriver(s,vehicle)||(c.takeover&&vehicle.side!==person.side);
    for(const old of s.participants)if(old.transportId===vehicle.id&&old.role==='operator')old.role='passenger';
    if(vehicle.side!==person.side&&!c.takeover)throw new Error('Confirm a takeover before changing control of an enemy vehicle.');
    if(c.takeover)vehicle.side=person.side;
    vehicle.driverRequired=true;
    if(c.recovery||(mustRecover&&s.status!=='setup')) {
      const due=s.round+1;
      vehicle.dueRound=vehicle.status==='closeCall'&&vehicle.dueRound!=null?Math.min(vehicle.dueRound,due):due;
      vehicle.status='closeCall';
    }
  }
  person.transportId=vehicle?.id??'';person.role=c.role==='operator'?'operator':'passenger';
  if(origin&&origin.id!==vehicle?.id&&(c.leaveSource??origin.driverRequired)&&!s.participants.some(x=>x.transportId===origin.id&&isActive(x))) {
    origin.status='out';origin.dueRound=null;
    if(originWasLeader&&person.side===origin.side)s.sides[person.side].leader=vehicle?.side===person.side?vehicle.id:person.id;
  }
  validateRoster(s);
}
function swapRoles(s) {
  [s.sides.quarry,s.sides.pursuer]=[s.sides.pursuer,s.sides.quarry];
  for (const p of s.participants) p.side=p.side==='quarry'?'pursuer':'quarry';
}
function validateSide(side) { if (!SIDES.includes(side)) throw new Error('Unknown side.'); }
function installDeclaration(s,side,raw) {
  s.sides[side].declaration=validateDeclaration(s,side,raw);
  if (raw.key==='stop') { s.status='ended';s.phase='ended';log(s,`${side==='quarry'?'Quarry stops for interaction or combat':'Pursuer abandons pursuit'}.`);return; }
  s.phase=side==='quarry'?'pursuer':'actions';
  log(s,`${side}: ${MANOEUVRES[raw.key].name}.`);
}

/** Pure authorised state transition. Runtime supplies a trusted user and any rolled dice. */
export function applyCommand(original, command, user, {actorOwned=()=>false, total=null, requestId='', privateDeclarations=null}={}) {
  original=upgrade(original);
  let s=clone(original);
  if (requestId && s.processed.includes(requestId)) return s;
  if (command.epoch !== s.epoch) throw new Error('The chase round changed. Refresh and try again.');
  const c=command, side=c.side;
  if(s.recovery){
    requireGM(user);
    if(s.recovery.kind!=='round'||!['override','participant','undo'].includes(c.type))throw new Error(s.outcomeRequired);
  }
  const gmOnly=['configure','participant','remove','leader','start','pause','resume','actionsDone','modifiers','check','condition','override','undo','manualRoll','reveal','restart','note','crew','passSide'];
  if (gmOnly.includes(c.type)) requireGM(user);
  if (['configure','remove','leader'].includes(c.type) && c.revision!==s.revision) throw new Error('The chase changed while this editor was open. Reopen it to avoid overwriting newer information.');
  if(c.type==='participant'&&c.expectedParticipant!==undefined&&JSON.stringify(unit(s,c.data.id)??null)!==c.expectedParticipant)throw new Error('This participant changed while you were editing. Your entry is retained; reopen the participant to review the newer values.');
  if(c.type==='participant'&&c.expectedParticipant===undefined&&c.revision!==s.revision)throw new Error('The chase changed while this editor was open. Reopen it to avoid overwriting newer information.');
  if (!['configure','participant','remove','leader','start','pause','resume','override','undo','condition','restart','note','crew'].includes(c.type) && s.status!=='running' && !(c.type==='task'&&s.status==='paused'&&tasks(s).some(t=>t.id===c.taskId&&t.kind==='driver'))) throw new Error('The chase is not running.');
  if (side!==undefined) validateSide(side);
  if(['declare','reveal','roll','manualRoll','range','actionsDone'].includes(c.type)&&driverProblems(s).length)throw new Error('Resolve the highlighted missing-driver task before continuing.');
  if(s.outcomeRequired&&['resume','range','roll','manualRoll','actionsDone'].includes(c.type))throw new Error(s.outcomeRequired);
  switch(c.type) {
    case 'configure': {
      s.name=textValue(c.data.name,100)||'Untitled chase';s.environment=textValue(c.data.environment,2000);s.combatId=textValue(c.data.combatId,100);
      if (s.status==='setup') {s.band=number(c.data.band,'Starting band',0,4,true);s.blind=!!c.data.blind;}
      else if((c.data.band!==undefined&&Number(c.data.band)!==s.band)||(c.data.blind!==undefined&&!!c.data.blind!==s.blind))throw new Error('Starting range and private commitments are locked after setup. Use GM range / end to change the current range.');
      for(const [key,values] of Object.entries({speedRounding:['action','table'],driverShots:['general','passengers']}))if(c.data[key]!==undefined) {
        if(!values.includes(c.data[key]))throw new Error('Choose a listed rules option.');
        if(s.status!=='setup'&&s.ruleOptions[key]!==c.data[key])throw new Error('Rules choices lock after setup.');
        s.ruleOptions[key]=c.data[key];
      }
      log(s,'Chase details updated.');break;
    }
    case 'participant': {
      if (!['setup','paused'].includes(s.status)&&!(s.status==='running'&&c.pauseForEdit)) throw new Error('Pause the chase before changing participant details.');
      const index=s.participants.findIndex(p=>p.id===c.data.id);
      const p=newParticipant(c.data);
      if (index<0) {if(s.participants.length>=60) throw new Error('A chase supports up to 60 entries.');s.participants.push(p);} else s.participants[index]=p;
      validateRoster(s);log(s,`${p.name}: details saved.`);break;
    }
    case 'remove': {
      if (!['setup','paused'].includes(s.status)&&!(s.status==='running'&&c.pauseForEdit)) throw new Error('Pause the chase before removing a participant.');
      const p=unit(s,c.id);if(!p) throw new Error('Participant not found.');
      s.participants=s.participants.filter(x=>x.id!==c.id);
      for(const x of s.participants) if(x.transportId===c.id) x.transportId='';
      validateRoster(s);log(s,`${p.name} removed; occupants are now independent.`);break;
    }
    case 'leader': {
      if(!roots(s,side).some(p=>p.id===c.id)) throw new Error('Choose an active independent participant.');
      const locked=rollsStarted(s)||Object.keys(s.blindRequests).length>0;
      const when=c.when??(locked?'next':'now');
      if(when==='next') {s.pendingLeaders[side]=c.id;log(s,`${side} leader next round: ${unit(s,c.id).name}.`);break;}
      if(locked)throw new Error('This round’s leader is locked by a roll or private commitment. Choose Next chase round.');
      s.sides[side].leader=c.id;delete s.pendingLeaders[side];
      if(s.sides[side].declaration)validateDeclaration(s,side,s.sides[side].declaration);
      s.result=null;log(s,`${side} leader: ${unit(s,c.id).name}.`);break;
    }
    case 'start': {
      if(s.status!=='setup') throw new Error('This chase has already started.');
      validateRoster(s);if(SIDES.some(k=>!s.sides[k].leader)) throw new Error('Add an active participant to each side.');
      if(driverProblems(s).length)throw new Error('Assign an active driver before starting.');
      s.status='running';resetRound(s);log(s,'Chase started.');break;
    }
    case 'restart': {saveCheckpoint(s);s.pendingCrew=[];s.pendingLeaders={};s.status='setup';s.round=1;resetRound(s);log(s,'Returned to setup. Participant injuries and conditions retained.');break;}
    case 'pause': if(s.status!=='running') throw new Error('Only a running chase can be paused.');s.status='paused';log(s,'Paused for tactical combat or editing.');break;
    case 'resume': {
      if(s.status!=='paused') throw new Error('This chase is not paused.');
      validateRoster(s);s.status='running';log(s,'Resumed. Combat turns and map positions were not advanced.');break;
    }
    case 'declare': {
      requireControl(s,unit(s,s.sides[side].leader),user,actorOwned);
      if(s.blind) {
        if(!['quarry','pursuer'].includes(s.phase)) throw new Error('Declarations are already closed.');
        if(s.blindRequests[side]) throw new Error('This side has already committed a manoeuvre.');
        validateDeclaration(s,side,c.data);
        if(!requestId) throw new Error('Blind choices must be submitted through a private request.');
        s.blindRequests[side]=requestId;log(s,`${side} committed a hidden manoeuvre.`);
      } else {
        if(s.phase!==side || s.sides[side].declaration) throw new Error('It is not this side’s declaration step.');
        installDeclaration(s,side,c.data);
      }
      break;
    }
    case 'reveal': {
      if(!s.blind || s.sides.quarry.declaration || s.sides.pursuer.declaration || !SIDES.every(k=>s.blindRequests[k])) throw new Error('Both sides must commit before reveal.');
      if(!privateDeclarations) throw new Error('The private declaration messages are missing. Undo the commitments and submit again.');
      for(const k of SIDES) validateDeclaration(s,k,privateDeclarations[k]);
      installDeclaration(s,'quarry',privateDeclarations.quarry);
      if(s.status!=='ended') installDeclaration(s,'pursuer',privateDeclarations.pursuer);
      break;
    }
    case 'passenger': {
      if(s.phase!=='actions') throw new Error('Passenger actions belong in the actions step.');
      const p=unit(s,c.id);requireControl(s,p,user,actorOwned);
      const task=tasks(s).find(t=>t.id===`passenger:${c.id}`);if(task){const error=taskAccess(s,task,user,actorOwned);if(error)throw new Error(error);}
      if(!p || !isActive(p) || !p.transportId || p.role==='operator') throw new Error('Choose an active passenger.');
      if(s.passengerActions[p.id]) throw new Error('This passenger has already recorded an action this round.');
      if(!['Attack','Board','Seize Control','Other Task'].includes(c.action)) throw new Error('Unknown passenger action.');
      if(c.action==='Board' && s.band!==0) throw new Error('Boarding requires Close range at the start of the round.');
      if(c.action==='Attack') {
        if(!attackAllowed(s,p)) throw new Error('The vehicle’s manoeuvre does not permit this passenger to attack.');
      }
      s.workflow.outcomes[`passenger:${p.id}`]={action:c.action,participantId:p.id,side:p.side,group:actionSide(s,p),external:true,needsReview:['Attack','Board','Seize Control'].includes(c.action),note:textValue(c.notes,500)};
      s.passengerActions[p.id]={action:c.action,notes:textValue(c.notes,500)};log(s,`${p.name}: ${c.action}${c.notes?` · ${textValue(c.notes,500)}`:''}.`);break;
    }
    case 'modifiers': {
      if(!['actions','chase'].includes(s.phase)) throw new Error('Set modifiers after declaring manoeuvres and before resolving range.');
      if(s.sides[side].roll) throw new Error('This side already rolled. Undo that roll before changing its modifiers.');
      const t=s.sides[side];t.comp=number(c.data.comp,'Complementary modifier',-20,20);t.extra=number(c.data.extra,'Other modifiers',-100,100);
      t.baseOverride=c.data.baseOverride===''||c.data.baseOverride==null?null:number(c.data.baseOverride,'Base skill override',0,1000);
      t.forcedStatic=!!c.data.forcedStatic;log(s,`${side}: Chase Roll modifiers updated.`);break;
    }
    case 'actionsDone': {
      if(s.phase!=='actions') throw new Error('It is not the actions step.');
      if(!s.workflow.legacyResolved) {
        const blockers=remainingRequired(s);
        if(blockers.length)throw new Error(`Finish the highlighted task: ${blockers[0].title}.`);
        for(const t of tasks(s).filter(x=>!x.required&&!x.done)) {
          s.workflow.outcomes[t.id]={passed:true};
          if(t.kind==='passenger')s.passengerActions[t.participantId]={action:'Pass',notes:'GM continued past unused optional action.'};
        }
      }
      validateRoster(s);if(SIDES.some(k=>!s.sides[k].leader)) throw new Error('A side has no active participants. End the chase using GM override.');
      // Recovery for all members follows the group manoeuvre unless the GM records an individual exception.
      for(const k of SIDES) for(const p of roots(s,k)) {
        if(p.status==='closeCall'&&p.dueRound<=s.round) {
          if(s.sides[k].declaration.key==='emergency'||s.checks.some(x=>x.id===p.id&&x.recovered)) {p.status='active';p.dueRound=null;}
          else throw new Error(`${p.name} needs Emergency Action or a GM-recorded individual recovery; otherwise mark a wreck.`);
        }
      }
      if(!c.confirmed) throw new Error('Confirm that subsidiary rolls, attacks, damage, and scenery decisions are resolved.');
      for(const k of SIDES) if(['stunt','stuntEscape'].includes(s.sides[k].declaration.key)) {
        for(const participant of roots(s,k)) if(!s.checks.some(x=>x.id===participant.id&&x.purpose==='stunt')) throw new Error(`Record ${participant.name}’s individual stunt result before the contest.`);
      }
      const q=s.sides.quarry.declaration,p=s.sides.pursuer.declaration;
      if(q.key==='stuntEscape'&&s.checks.findLast(x=>x.id===s.sides.quarry.leader&&x.purpose==='stunt')?.success) {
        const follows=(p.key==='stunt'&&p.penalty<=q.penalty)||p.key==='mobilityPursuit';
        if(!follows)s.sides.pursuer.forcedStatic=true;
      }
      for(const k of SIDES) breakdown(s,k);
      s.phase='chase';log(s,'GM confirmed actions and scene conditions resolved. Chase Rolls unlocked.');break;
    }
    case 'passSide': {
      if(s.phase!=='actions')throw new Error('Optional actions can be passed only during actions.');
      const group=activeGroup(s);if(!['quarry','pursuer'].includes(group))throw new Error('Resolve the preparation tasks first.');
      if(tasks(s).some(t=>t.group===group&&t.required&&!t.done))throw new Error('Required tasks on this side are still unresolved.');
      for(const t of tasks(s).filter(t=>t.group===group&&!t.required&&!t.done)) {
        s.workflow.outcomes[t.id]={passed:true};if(t.kind==='passenger')s.passengerActions[t.participantId]={action:'Pass',notes:'GM passed the unused action.'};
      }
      log(s,`${group}: unused optional actions passed.`);break;
    }
    case 'task': {
      const t=tasks(s).find(x=>x.id===c.taskId);if(!t)throw new Error('That task is no longer available.');
      const access=taskAccess(s,t,user,actorOwned);if(access)throw new Error(access);
      const p=unit(s,t.participantId);
      if(t.kind==='stunt'&&p.kind==='character'&&!FOOT_STUNT_SKILLS.includes(c.stuntSkill))throw new Error('Choose Acrobatics, Climbing or Jumping for this foot stunt.');
      if(c.sr!==undefined&&c.sr!==''){requireGM(user);if(p?.kind!=='vehicle')throw new Error('SR applies to vehicles.');p.sr=number(c.sr,'Stability Rating',0,100);}
      if(c.mode==='waive') {
        requireGM(user);if(!textValue(c.note))throw new Error('Record the GM ruling for resolving this task manually.');
        if(!['scene','contact','embark','finish','stunt'].includes(t.kind))throw new Error('Supply the required value or outcome using this task’s resolution form.');
        if(t.kind==='stunt'){s.checks.push({id:p.id,purpose:'stunt',stuntSkill:c.stuntSkill,success:!!c.success,reviewed:true,adjudicated:true});}
        s.workflow.outcomes[t.id]={waived:true,note:textValue(c.note,500)};log(s,`GM ruling: ${t.title} · ${textValue(c.note,500)}`);break;
      }
      if(c.mode==='pass') {
        if(t.required)throw new Error('Required tasks need resolution or a GM ruling.');
        s.workflow.outcomes[t.id]={passed:true};if(t.kind==='passenger')s.passengerActions[p.id]={action:'Pass',notes:''};log(s,`${p.name}: passed optional action.`);break;
      }
      if(['scene','mobility','static','skill','contact','embark','recover','consequence','finish','driver'].includes(t.kind)) {
        requireGM(user);
        if(t.kind==='driver') {
          if(!c.stop)throw new Error('Choose a replacement in the crew form, or confirm that the wreck and damage are resolved.');
          if(!textValue(c.note))throw new Error('Record the wreck and damage outcome.');
          p.status='wreck';p.dueRound=null;validateRoster(s);
        }
        if(t.kind==='scene'&&['stunt','stuntEscape'].includes(s.sides[t.side].declaration.key)&&roots(s,t.side).some(x=>x.kind==='character')) {
          const minimum=number(c.minimumPenalty,'Minimum penalty for the foot feat',-100,0,true);
          if(s.sides[t.side].declaration.penalty>minimum)throw new Error('The declared stunt risk is too easy for this feat. Choose a suitable feat or correct the declaration.');
        }
        if(t.kind==='mobility'){s.sides.pursuer.forcedStatic=!c.canFollow;s.workflow.approved['static:pursuer']=true;}
        if(t.kind==='static')s.sides[t.side].forcedStatic=!!c.keepStatic;
        if(t.kind==='skill')s.sides[t.side].baseOverride=number(c.target,'DX-based Stealth',0,1000);
        if(t.kind==='recover') {p.status=c.stop?'out':'active';p.dueRound=null;s.checks.push({id:p.id,recovered:!c.stop});validateRoster(s);}
        if(t.kind==='consequence') {
          const check=s.checks[t.checkIndex];
          if(check.pending) {
            p.sr=number(c.sr,'Stability Rating',0,100);Object.assign(check,wipeout({target:check.target,total:check.total,kind:p.kind,sr:p.sr}),{pending:false});
            p.status=check.status;p.dueRound=check.status==='closeCall'?s.round+1:null;
          }
          check.reviewed=true;
          if(c.hp!==undefined&&c.hp!=='')p.hp=number(c.hp,'Chase HP',-10000,1e6);
        }
        if(['contact','finish'].includes(t.kind)&&!textValue(c.note))throw new Error('Record the outcome, including any required control rolls and damage, or why no attack was made.');
        s.workflow.approved[t.id]=true;s.workflow.outcomes[t.id]={note:textValue(c.note,500),...(c.minimumPenalty!=null?{minimumPenalty:Number(c.minimumPenalty)}:{})};log(s,`${t.title}: resolved${c.minimumPenalty!=null?' · minimum foot-feat penalty '+c.minimumPenalty:''}${c.note?' · '+textValue(c.note,500):''}.`);break;
      }
      if(!['roll','manual','external'].includes(c.mode))throw new Error('Choose Roll, Enter result, or Resolved elsewhere.');
      let action=t.kind==='attack'?'Attack':(c.action??'Other Task');
      if(t.kind==='passenger') {
        if(!['Attack','Board','Seize Control','Other Task'].includes(action))throw new Error('Choose an available passenger action.');
        if(action==='Board'&&s.band!==0)throw new Error('Boarding requires Close range.');
        if(action==='Attack'&&!attackAllowed(s,p))throw new Error('This manoeuvre does not permit that attack.');
      }
      let result=null;
      if(c.mode!=='external') {
        let target=number(c.target,'Effective skill',-100,1000);
        let modifiers=null;
        if(action==='Attack'&&t.kind!=='stunt') {
          const shooter=operatorOf(s,p)??p;
          const role=p.transportId?p.role:p.kind==='vehicle'?'operator':'pedestrian';
          modifiers=attackModifiers({band:s.band,manoeuvre:s.sides[actionSide(s,p)].declaration.key,role,bulk:number(c.bulk??-2,'Bulk',-100,0),acc:number(c.acc??0,'Acc',0,100),gunslinger:!!shooter.gunslinger,target:number(c.targetMod??0,'Target modifier',-100,100)});
          target+=modifiers.total+number(c.extra??0,'Other attack modifiers',-100,100);
        }
        result={...successRoll(target,c.mode==='manual'?c.total:total),manual:c.mode==='manual',modifiers};
      } else if(!textValue(c.note))throw new Error('Record the externally resolved outcome.');
      if(t.kind==='stunt') {
        if(!result)throw new Error('Enter the original 3d6 total to record a stunt. A GM can use Resolve manually with a ruling if needed.');
        const pending=!result.success&&p.kind==='vehicle'&&p.sr==null;
        const check={id:p.id,checkId:uid(),purpose:'stunt',stuntSkill:c.stuntSkill,...result,...(pending?{pending:true}:wipeout({target:result.target,total:result.total,kind:p.kind,sr:p.sr}))};
        s.checks.push(check);if(!check.success&&!pending){p.status=check.status;p.dueRound=check.status==='closeCall'?s.round+1:null;}
      }
      s.workflow.outcomes[t.id]={result,note:textValue(c.note,500),external:c.mode==='external',action,needsReview:t.kind!=='stunt'&&((action==='Attack'&&(!result||result.success))||['Board','Seize Control'].includes(action)),participantId:p.id,side:p.side,group:t.group};
      if(t.kind==='passenger')s.passengerActions[p.id]={action,notes:textValue(c.note,500),result};
      log(s,`${p.name}: ${t.kind==='stunt'?'stunt':action}${result?` · ${result.total} vs ${result.target} · margin ${result.margin}`:' · resolved elsewhere'}${c.note?' · '+textValue(c.note,500):''}.`);break;
    }
    case 'crew': {
      if(!['setup','paused','running'].includes(s.status))throw new Error('Return to setup before changing an ended chase.');
      if(c.taskId){const task=tasks(s).find(t=>t.id===c.taskId&&['embark','driver'].includes(t.kind));if(!task)throw new Error('This crew task is no longer available.');const error=taskAccess(s,task,user,actorOwned);if(error)throw new Error(error);if(task.kind==='embark'&&c.when!=='next')throw new Error('Embarkation changes take effect next round.');if(task.kind==='driver'&&(c.when!=='now'||c.vehicleId!==task.participantId||c.role!=='operator'))throw new Error('Replace this vehicle’s driver now, or resolve its wreck.');}
      let personId=c.personId;
      if(c.newPerson){
        if(s.participants.length>=60)throw new Error('A chase supports up to 60 entries.');
        const origin=c.originVehicleId?unit(s,c.originVehicleId):null;
        if(c.originVehicleId&&(!origin||origin.kind!=='vehicle'||!isActive(origin)))throw new Error('Choose an active starting vehicle.');
        const person=newParticipant({...c.newPerson,kind:'character',transportId:origin?.id??'',role:'passenger'});
        if(unit(s,person.id))throw new Error('That crew member already exists. Select them from the list.');
        s.participants.push(person);personId=person.id;
      }
      const data={personId,vehicleId:c.vehicleId??'',role:c.role==='operator'?'operator':'passenger',takeover:!!c.takeover,recovery:!!c.recovery,leaveSource:c.leaveSource===undefined?undefined:!!c.leaveSource,note:textValue(c.note,500),...(c.footSkill!==undefined?{footSkill:c.footSkill,footSkillName:textValue(c.footSkillName,100)}:{})};
      const trial=clone(s);applyCrew(trial,data); // Validate before scheduling, without changing this round's travel mode.
      if(c.when==='next') {
        s.pendingCrew=s.pendingCrew.filter(x=>x.personId!==data.personId);s.pendingCrew.push(data);log(s,`${unit(s,data.personId).name}: crew change scheduled for next round${data.note?' · '+data.note:''}.`);
      } else {
        if(s.status==='running'&&['chase','range','reverseCheck'].includes(s.phase)&&!c.taskId?.startsWith('driver:'))throw new Error('Chase Rolls have begun. Schedule this change for next round.');
        applyCrew(s,data);log(s,`${unit(s,data.personId).name}: crew change applied${data.note?' · '+data.note:''}.`);
      }
      if(c.taskId)s.workflow.outcomes[c.taskId]={note:data.note||'Crew change scheduled / applied.'};
      break;
    }
    case 'roll': case 'manualRoll': {
      if(s.phase!=='chase') throw new Error('Finish the actions step before making Chase Rolls.');
      requireControl(s,unit(s,s.sides[side].leader),user,actorOwned);
      if(s.sides[side].roll) throw new Error('This side already rolled.');
      const b=breakdown(s,side);s.sides[side].roll={...successRoll(b.target,c.type==='manualRoll'?c.total:total),parts:b.parts,manual:c.type==='manualRoll'};
      log(s,`${side}: ${s.sides[side].roll.total} vs ${b.target}; contest margin ${contestMargin(s.sides[side].roll)}${c.type==='manualRoll'?' (manual)':''}.`);
      if(SIDES.every(k=>s.sides[k].roll)) {
        if(s.sides.quarry.declaration.key==='reverse'&&!s.sides.quarry.roll.success&&!s.checks.some(x=>x.reverse)) {
          s.phase='reverseCheck';log(s,'Resolve the failed Reverse as a wipeout before adjusting range.');
        } else {s.result=contest(s);s.phase='range';}
      }
      break;
    }
    case 'check': {
      if(!['actions','reverseCheck'].includes(s.phase)) throw new Error('Resolve checks during actions or after a failed Reverse.');
      const p=unit(s,c.id);if(!p)throw new Error('Participant not found.');
      if(c.purpose==='stunt'&&p.kind==='character'&&!FOOT_STUNT_SKILLS.includes(c.stuntSkill))throw new Error('Choose Acrobatics, Climbing or Jumping for this foot stunt.');
      if(c.sr!==undefined&&c.sr!=='')p.sr=number(c.sr,'Stability Rating',0,100);
      const r=wipeout({target:c.target,total:c.total,kind:p.kind,sr:p.sr});
      if(s.phase==='reverseCheck'&&c.id!==s.sides.quarry.leader) throw new Error('Check the quarry leader’s failed Reverse.');
      if(s.phase==='reverseCheck'&&(Number(c.total)!==s.sides.quarry.roll.total||Number(c.target)!==s.sides.quarry.roll.target)) throw new Error('Use the original failed Reverse Chase Roll and target.');
      if(s.phase==='reverseCheck'&&!c.reviewed)throw new Error('Resolve the original result’s damage and other consequences before confirming Reverse.');
      // A later successful check does not undo a close call from an earlier action.
      if(!r.success) {p.status=r.status;p.dueRound=r.status==='closeCall'?s.round+1:null;}
      s.checks.push({id:p.id,...r,reviewed:!!c.reviewed,purpose:c.purpose==='stunt'?'stunt':'control',reverse:s.phase==='reverseCheck'});log(s,`${p.name}: ${r.total} vs ${r.target} → ${r.status}. Apply any damage separately.`);
      if(s.phase==='reverseCheck') {
        if(r.status==='wreck') {s.status='paused';s.phase='actions';validateRoster(s);log(s,'Reverse wreck: choose any replacement leader or end the chase, then use GM range override.');}
        else {s.result=contest(s);s.phase='range';}
      }
      break;
    }
    case 'condition': {
      const p=unit(s,c.id);if(!p)throw new Error('Participant not found.');
      if(!['active','closeCall','wreck','out'].includes(c.status)) throw new Error('Unknown condition.');
      p.status=c.status;p.dueRound=c.status==='closeCall'?number(c.dueRound??s.round+1,'Recovery due round',s.round,1e6,true):null;
      if(c.recovered)s.checks.push({id:p.id,recovered:true});
      if(c.hp!==undefined&&c.hp!=='')p.hp=number(c.hp,'Current HP',-10000,1e6);
      validateRoster(s);log(s,`${p.name}: ${c.status}${c.recovered?' (individual recovery confirmed)':''}.`);break;
    }
    case 'range': {
      if(s.phase!=='range'||!s.result||SIDES.some(k=>!s.sides[k].roll)) throw new Error('Resolve both rolls first.');
      const owner=s.result.type==='hideWin'?'quarry':s.result.winner;
      if(!user.isGM) {if(!owner)throw new Error('GM confirms an unchanged range.');requireControl(s,unit(s,s.sides[owner].leader),user,actorOwned);}
      const choice=rangeChoices(s,s.result).find(x=>x.key===c.choice);if(!choice)throw new Error('That range change is not allowed by the contest.');
      saveCheckpoint(s);
      if(choice.key==='escape') {s.status='ended';s.phase='ended';log(s,'Quarry escaped.');}
      else {
        s.band=choice.band;if(choice.swap)swapRoles(s);
        log(s,`Range: ${BANDS[s.band]}${choice.swap?' · pursuit roles reversed':''}.`);
        s.round++;resetRound(s);
      }
      break;
    }
    case 'override': {
      if(!textValue(c.reason))throw new Error('Record a reason for the override.');
      saveCheckpoint(s);s.band=number(c.band,'Range band',0,4,true);
      if(s.recovery){
        // Reject invalid stats until the GM reviews the affected entry; do not normalise them silently.
        for(const p of s.participants)newParticipant(p);
        validateRoster(s);
        if(!c.end&&SIDES.some(k=>!s.sides[k].leader))throw new Error('Each side needs an active independent participant, or end the chase.');
        s.recoveryArchive=s.recovery;delete s.recovery;
        // Bad declarations/rolls stay in the archive and Undo checkpoint, not in an ended-round view.
        for(const k of SIDES){s.sides[k].declaration=null;s.sides[k].roll=null;}
        s.result=null;
      }
      if(c.swap)swapRoles(s);
      if(c.end){s.status='ended';s.phase='ended';s.outcomeRequired='';}
      else {s.round++;resetRound(s);s.status='running';}
      log(s,`GM override: ${textValue(c.reason,500)} · ${BANDS[s.band]}${c.end?' · chase ended':''}.`);break;
    }
    case 'undo': {
      const snap=s.history.pop();if(!snap) throw new Error('There is no saved action to undo.');
      const history=s.history,processed=s.processed,revision=s.revision;
      s=upgrade({...snap,history,processed,revision,epoch:uid()});
      // Hidden commitments refer to a previous epoch. Do not retain unusable private references.
      if(s.blind&&['quarry','pursuer'].includes(s.phase))s.blindRequests={};
      log(s,'GM undid the last action. Existing dice chat messages remain as an audit trail.');break;
    }
    case 'note': {log(s,`GM: ${textValue(c.text,1000)}`);break;}
    default: throw new Error('Unknown chase command.');
  }
  // Changes to the roster after dice must not silently reuse an invalid contest.
  if(!['range','override','undo','restart'].includes(c.type)&&rollsStarted(original)&&s.status!=='ended') {
    const changed=SIDES.some(k=>original.sides[k].leader!==s.sides[k].leader);
    const driverChanged=SIDES.some(k=>{const before=unit(original,original.sides[k].leader),after=unit(s,s.sides[k].leader);return before?.kind==='vehicle'&&(operatorOf(original,before)?.id!==operatorOf(s,after)?.id||missingDriver(s,after));});
    if(changed||driverChanged){s.result=null;s.status='paused';s.phase='actions';s.outcomeRequired='A leader or driver changed after Chase Rolls. Resolve the consequences, then choose a GM outcome for this round.';log(s,s.outcomeRequired);}
  }
  if(!['range','override','undo'].includes(c.type)) {
    const snapshot=clone(original);delete snapshot.history;delete snapshot.processed;
    s.history=[...original.history,snapshot].slice(-8);
  }
  s.revision=original.revision+1;
  if(requestId)s.processed=[...s.processed,requestId].slice(-150);
  return s;
}

export function exportChase(s) {
  const copy=clone(s);copy.history=[];copy.processed=[];copy.blindRequests={};
  if(copy.blind&&['quarry','pursuer'].includes(copy.phase))copy.phase='quarry';
  return JSON.stringify({format:'gurps-action-chases',version:1,chase:copy},null,2);
}
export function importChase(text) {
  if(text.length>2*1024*1024)throw new Error('Chase files must be under 2 MiB.');
  const raw=JSON.parse(text);
  if(raw.format!=='gurps-action-chases'||raw.version!==1||!raw.chase||raw.chase.schema!==1)throw new Error('This is not a supported chase export.');
  if(raw.chase.recovery)throw new Error('This chase needs recovery. Use the original saved record or a known-good backup rather than importing a recovery screen.');
  const r=raw.chase,s=newChase(`${textValue(r.name,90)} (imported)`);
  if(!Array.isArray(r.participants)||r.participants.length>60)throw new Error('Invalid participant list.');
  s.participants=r.participants.map(p=>newParticipant({...p,controllers:[],actorUuid:''}));
  s.environment=textValue(r.environment,2000);s.band=number(r.band,'Range',0,4,true);s.blind=!!r.blind;
  s.ruleOptions={speedRounding:r.ruleOptions?.speedRounding==='table'?'table':'action',driverShots:r.ruleOptions?.driverShots==='passengers'?'passengers':'general'};
  for(const side of SIDES)s.sides[side].leader=textValue(r.sides?.[side]?.leader,100);
  validateRoster(s);log(s,'Imported into setup. Reassign players and actor links; review injury and recovery conditions.');
  // New chase starts at round one; bring pending recovery forward.
  for(const p of s.participants)if(p.status==='closeCall')p.dueRound=1;
  return s;
}
