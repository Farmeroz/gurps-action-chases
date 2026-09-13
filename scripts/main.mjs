import {ID, SIDES, BANDS, MANOEUVRES, clone, uid, newParticipant, newChase, unit, travelStats, operatorOf, canControl, manoeuvreError, attackModifiers, wipeout, actionSide, driverProblems, missingDriver, rollsStarted, FOOT_STUNT_SKILLS, preferredStuntSkill, footSkillOf, roots, escapeHTML as e} from './rules.mjs';
import {exportChase} from './engine.mjs';
import {readChase,chaseDocuments,activeGM,createChase,submit,installStoreHooks,showToPlayers} from './store.mjs';
import {flattenSkills,participantFromActor,actorOwned,rollGGA,standaloneRoll} from './integration.mjs';
import {renderTracker,participantForm,settingsForm,input,select,checkbox,textarea} from './view.mjs';

import {tasks,attackAllowed,suggestedCheck} from './workflow.mjs';

let tracker,Tracker,FormWindow;
const notifyError=err=>{console.warn(ID,err);ui.notifications.error(err.message??String(err));};
const bool=(data,key)=>data[key]==='on';
const choices=arr=>arr.map(x=>({value:x,label:x}));
function download(text,name) {
  const url=URL.createObjectURL(new Blob([text],{type:'application/json'}));
  const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),2000);
}
function form(title,html,onSave,label='Save',onRender=null) {
  return new FormWindow({title,html,onSave,label,onRender}).render({force:true});
}
function classes(Base) {
  FormWindow=class ChaseForm extends Base {
    static DEFAULT_OPTIONS={classes:['gac-app','gac-editor'],position:{width:680,height:'auto'},window:{resizable:true,title:'Chase editor'}};
    constructor({title,html,onSave,label,onRender}){super({window:{title}});Object.assign(this,{html,onSave,label,onRender});}
    async _renderHTML(){return `<form class="gac-edit-form">${this.html}<p class="gac-error" role="alert" tabindex="-1" hidden></p><div class="gac-form-footer"><button type="button" data-cancel>Cancel</button><button type="submit" class="gac-primary">${e(this.label)}</button></div></form>`;}
    _replaceHTML(html,content){
      content.innerHTML=html;
      content.querySelector('[data-cancel]').addEventListener('click',()=>{if(!this.saving)this.close();});
      this.onRender?.(content.querySelector('form'));
      content.querySelector('form').addEventListener('submit',async event=>{
        event.preventDefault();const formRoot=event.target;if(this.saving||!formRoot.reportValidity())return;
        this.saving=true;const button=formRoot.querySelector('[type="submit"]'),cancel=formRoot.querySelector('[data-cancel]');button.disabled=true;cancel.disabled=true;button.textContent='Sending…';formRoot.setAttribute('aria-busy','true');content.querySelector('.gac-error').hidden=true;
        try{await this.onSave(Object.fromEntries(new FormData(formRoot)),formRoot);await this.close();}
        catch(err){const error=content.querySelector('.gac-error');error.hidden=false;error.textContent=err.message;error.focus();}
        finally{this.saving=false;button.disabled=false;cancel.disabled=false;button.textContent=this.label;formRoot.removeAttribute('aria-busy');}
      });
    }
  };
  Tracker=class ActionChaseTracker extends Base {
    static DEFAULT_OPTIONS={id:'gurps-action-chases-window',classes:['gac-app'],position:{width:1040,height:820},window:{resizable:true,title:'GURPS Action Chases'}};
    constructor(){super();this.selectedId=game.settings.get(ID,'lastChase')??'';}
    async _renderHTML(){
      const docs=chaseDocuments();if(!docs.some(d=>d.id===this.selectedId))this.selectedId=docs[0]?.id??'';
      return renderTracker({documents:docs,selectedId:this.selectedId,state:readChase(game.journal.get(this.selectedId)),user:game.user,gmOnline:!!activeGM()});
    }
    _replaceHTML(html,content){
      const scroll=content.scrollTop,open=new Map([...content.querySelectorAll('details[data-persist]')].map(d=>[d.dataset.persist,d.open]));
      content.innerHTML=html;for(const d of content.querySelectorAll('details[data-persist]'))if(open.has(d.dataset.persist))d.open=open.get(d.dataset.persist);content.scrollTop=scroll;
      content.querySelector('[data-chase-picker]')?.addEventListener('change',async event=>{this.selectedId=event.target.value;await game.settings.set(ID,'lastChase',this.selectedId);this.render({force:true});});
      content.addEventListener('click',this.clickHandler??=(event)=>{
        const b=event.target.closest('[data-do]');if(!b||b.disabled)return;event.preventDefault();
        if(this.busy)return;
        this.busy=true;b.disabled=true;
        Promise.resolve(handle(this,b,event)).catch(notifyError).finally(()=>{this.busy=false;if(b.isConnected)b.disabled=false;});
      },{signal:this.listenerController?.signal});
    }
  };
}
// _replaceHTML can reuse its content node; prevent accumulating delegated listeners.
function installReplaceListenerGuard() {
  const original=Tracker.prototype._replaceHTML;
  Tracker.prototype._replaceHTML=function(html,content){this.listenerController?.abort();this.listenerController=new AbortController();return original.call(this,html,content);};
}
async function handle(app,button,event) {
  const action=button.dataset.do,side=button.dataset.side;
  const doc=game.journal.get(app.selectedId),s=readChase(doc),p=unit(s??{participants:[]},button.closest('[data-id]')?.dataset.id);
  const send=(type,data={})=>submit(doc,{type,...data,epoch:s.epoch,revision:s.revision});
  const chooseDoc=async d=>{app.selectedId=d.id;await game.settings.set(ID,'lastChase',d.id);app.render({force:true});};
  if(action==='new')return form('New chase',input('name','Chase name','Getaway','text','required')+select('band','Starting range',BANDS.map((label,value)=>({value,label})),2)+'<details><summary>Scene & declaration options</summary>'+textarea('environment','Shared scene conditions')+checkbox('blind','Private simultaneous commitments')+'<p>Starting range and declaration mode lock when the chase starts.</p></details>',async data=>chooseDoc(await createChase(data.name,null,{...data,blind:bool(data,'blind')})),'Create chase');
  if(action==='import')return form('Import chase',`<p>Import an exported chase into a new setup. Player assignments and actor links are cleared for portability. Injuries and conditions are retained for review.</p>${input('file','Chase JSON','','file','accept=".json,application/json" required')}`,async(_,root)=>{
    const file=root.querySelector('[name="file"]').files[0];if(file.size>2*1024*1024)throw new Error('Choose a JSON file under 2 MiB.');await chooseDoc(await createChase('',await file.text()));
  },'Import');
  if(action==='demo') {
    const demo=newChase('The harbour getaway');demo.environment='Rain-slick streets, evening traffic, and a narrow dockside exit.';
    const van=newParticipant({kind:'vehicle',name:'Getaway van',side:'quarry',speed:30,handling:0,sr:4,st:60,hp:60,maxHp:60,dr:5,ht:11});
    const driver=newParticipant({name:'Alex · driver',side:'quarry',transportId:van.id,role:'operator',skillName:'Driving (Automobile)',skill:15});
    const passenger=newParticipant({name:'Sam · passenger',side:'quarry',transportId:van.id,skillName:'DX',skill:12});
    const bike=newParticipant({kind:'vehicle',name:'Pursuing motorcycle',side:'pursuer',skillName:'Driving (Motorcycle)',skill:14,speed:40,handling:1,sr:2,st:25,hp:25,maxHp:25,dr:4,ht:11});
    demo.participants=[van,driver,passenger,bike];demo.sides.quarry.leader=van.id;demo.sides.pursuer.leader=bike.id;
    return chooseDoc(await createChase(demo.name,exportChase(demo)));
  }
  if(action==='help')return form('Action Chases · quick guide',`<div class="gac-help"><p><a href="modules/gurps-action-chases/docs/User-Guide.pdf" target="_blank" rel="noopener">Open full user guide (PDF)</a></p><p><strong>Set up.</strong> Add a character or vehicle to each side; actors and tokens are optional. Assign player control in the participant editor. Add crew under a vehicle. A driver supplies skill, the vehicle supplies speed and Handling. Review saved Rules choices in Settings before starting.</p><p><strong>Follow Next action.</strong> Quarry declares, then pursuer. Common manoeuvres are one click; More manoeuvres shows special choices and explains unavailable ones. Private commitments are revealed together by the GM.</p><p><strong>Resolve tasks.</strong> The GM makes scene decisions, then pursuer actions precede quarry actions. Required tasks block the contest. Optional attacks and passenger actions can be passed. Roll, enter original dice, or record an external result in one task window. All stunt results must be recorded, including successes. Foot stunts require Acrobatics, Climbing or Jumping; the GM confirms the chosen feat’s minimum penalty. Failed results create a GM consequence task.</p><p><strong>Keep play moving.</strong> Continue passes unused optional actions and unlocks Chase Rolls. Both leaders roll; the eligible winner or GM chooses the result. No generic review checklist is needed on a simple Move round.</p><p><strong>Crew and combat.</strong> Change driver, board or disembark under a vehicle or character. Crew changes are atomic; normal embarkation takes effect next round. Disembarking confirms the foot skill and can retire the empty vehicle automatically. Crew reasons are saved. A missing driver creates a required replacement / wreck task; takeover recovery is due the following round. Late leader selections are queued for next round. Pause / tactical combat holds the current chase step; no token, combat turn or world time advances automatically.</p><p><strong>Players.</strong> Your next action and participants come first. Your form stays open while waiting for acceptance. A rejection keeps your entries and explains the problem. The GM can Show to players from Manage chase. All stats and notes are shared.</p><p><strong>Rolls and damage.</strong> Managed task rolls record the result immediately. Native GGA rolls remain available in the same task; enter their original dice or record the outcome afterwards. Hostile passengers use the host vehicle’s manoeuvre and action step. Apply damage to actors with GGA; tracker HP is separate. Consult Action 2: Exploits, pp. 31–35 for full rulings.</p><p><strong>Save and recover.</strong> Journal entries retain chases when the window closes or chat is cleared. Keep pending private commitment messages until reveal. Manage chase contains Undo, settings, rulings and JSON export. Import creates a fresh setup and clears actor links and assignments.</p></div>`,async()=>{},'Close');
  if(!s)throw new Error('Choose a chase first.');
  if(action==='export')return download(exportChase(s),`${s.name.replace(/[^a-z0-9]+/gi,'-').replace(/^-|-$/g,'')||'chase'}.json`);
  if(action==='exportRecovery'){
    const saved=(s.recovery??s.recoveryArchive)?.original;
    if(saved===undefined)throw new Error('No recovery record is available.');
    return download(typeof saved==='string'?saved:JSON.stringify(saved,null,2),'chase-original-saved-data.json');
  }
  if(['start','pause','resume','undo','reveal'].includes(action))return send(action);
  if(action==='restart') {
    if(await foundry.applications.api.DialogV2.confirm({window:{title:'Return to setup?'},content:'<p>Start the round count again and clear manoeuvres and rolls. Keep the participants and their current injuries and conditions.</p>',rejectClose:false}))return send('restart');return;
  }
  if(action==='show')return showToPlayers(doc);
  if(action==='actionsDone')return send('actionsDone',{confirmed:true});
  if(action==='passSide')return send('passSide');
  if(action==='passTask')return send('task',{taskId:button.dataset.task,mode:'pass'});
  if(action==='task')return taskForm(s,tasks(s).find(t=>t.id===button.dataset.task),send,event);
  if(action==='crew')return crewForm(s,p,send);
  if(action==='quickDeclare')return send('declare',{side,data:{key:button.dataset.key,operatorAttacks:!!button.closest('.gac-team').querySelector('[data-operator]')?.checked}});
  if(action==='roll')return send('roll',{side});
  if(action==='range')return send('range',{choice:button.dataset.choice});
  if(action==='configure')return form('Chase settings',settingsForm(s,game.combats),data=>send('configure',{data:{...data,...(s.status==='setup'?{blind:bool(data,'blind')}:{})}}));
  if(action==='leader') {
    const locked=rollsStarted(s)||Object.keys(s.blindRequests).length>0;
    return form(`Choose ${side} leader`,select('id','Leader',rootsFor(s,side),s.pendingLeaders?.[side]??s.sides[side].leader)+select('when','Takes effect',[...(!locked?[{value:'now',label:'Now'}]:[]),{value:'next',label:'Next chase round'}],locked?'next':'now')+`<p>${locked?'This round’s rolls and private commitments keep their original leader. The selected leader takes over at the next round boundary.':'Choose an independent participant. The current manoeuvre must remain legal for a change now.'}</p>`,data=>send('leader',{side,id:data.id,when:data.when}));
  }
  if(['addCharacter','addVehicle','addCrew','edit','duplicate'].includes(action)) {
    const draft=action==='edit'?clone(p):action==='duplicate'?newParticipant({...p,id:uid(),name:`${p.name} copy`,actorUuid:'',transportId:'',controllers:[]}):newParticipant({kind:action==='addVehicle'?'vehicle':'character',...(action==='addCrew'?{side:p.side,transportId:p.id,role:operatorOf(s,p)?'passenger':'operator'}:{})});
    return editParticipant(s,draft,send);
  }
  if(action==='actor')return actorForm(s,send);
  if(action==='remove') {
    if(await foundry.applications.api.DialogV2.confirm({window:{title:`Remove ${p.name}?`},content:'<p>Remove this chase entry. Occupants of a removed vehicle become independent participants. Actors are unaffected.</p>',rejectClose:false}))return send('remove',{id:p.id,pauseForEdit:s.status==='running'});return;
  }
  if(action==='declare') {
    const entries=Object.entries(MANOEUVRES),allowed=entries.filter(([k])=>!manoeuvreError(s,side,k));
    return form(`${side} · choose manoeuvre`,select('key','Manoeuvre',allowed.map(([k,m])=>({value:k,label:m.name})),allowed[0]?.[0])+'<p data-manoeuvre-hint></p><div data-stunt>'+input('penalty','Stunt risk',-2,'number','min="-100" max="-2" step="2"')+'</div><div data-operator-choice>'+checkbox('operatorAttacks','Vehicle driver also attacks')+'</div>'+textarea('notes','Action / scenery description')+'<p data-requirements></p><details><summary>Unavailable manoeuvres & reasons</summary>'+entries.filter(([k])=>manoeuvreError(s,side,k)).map(([k,m])=>`<p><strong>${e(m.name)}</strong>: ${e(manoeuvreError(s,side,k))}</p>`).join('')+'</details>',data=>send('declare',{side,data:{...data,operatorAttacks:bool(data,'operatorAttacks')}}),s.blind?'Commit privately':'Declare',root=>{
      const update=()=>{const k=root.elements?.key?.value??root.querySelector('[name="key"]').value,m=MANOEUVRES[k],p=unit(s,s.sides[side].leader);toggle(root,'[data-stunt]',['stunt','stuntEscape'].includes(k));toggle(root,'[data-operator-choice]',p.kind==='vehicle'&&k==='moveAttack');root.querySelector('[data-manoeuvre-hint]').textContent=`${m.hint} Action 2, p. ${m.page}.`;root.querySelector('[data-requirements]').textContent=k==='hide'&&p.kind==='character'&&p.stealth==null?'Stealth is not set. A required task will let the GM enter it before Chase Rolls.':['stunt','stuntEscape'].includes(k)?'Each participant needs a stunt result. Missing vehicle SR can be supplied in the task.':'';};root.addEventListener('change',update);update();
    });
  }
  if(action==='modifiers') {
    const t=s.sides[side];return form(`${side} · Chase Roll modifiers`,input('baseOverride','Base skill override (blank = participant skill)',t.baseOverride,'number','min="0"')+input('comp','Complementary skill result modifier',t.comp,'number')+input('extra','Other modifiers (shock, distraction, Higher Purpose, etc.)',t.extra,'number')+checkbox('forcedStatic','Forced static: unable to follow / currently stationary',t.forcedStatic)+'<p>Forced static persists until the GM clears it. It removes the speed bonus and gives a moving opponent the static-manoeuvre range benefit. BAD does not modify Chase Rolls. Use Acrobatics here as a base override for an on-foot Reverse if desired.</p>',data=>send('modifiers',{side,data:{...data,forcedStatic:bool(data,'forcedStatic')}}));
  }
  if(action==='manualRoll')return form(`Enter ${side} Chase Roll`,input('total','3d6 total','','number','required min="3" max="18" step="1"'),data=>send('manualRoll',{side,total:data.total}),'Record roll');
  if(action==='condition')return form(`${p.name} · condition`,select('status','Condition',choices(['active','closeCall','wreck','out']),p.status)+input('dueRound','Emergency Action due round (close call only)',p.dueRound??s.round+1,'number','min="1"')+input('hp','Current HP (blank = keep)',p.hp,'number')+checkbox('recovered','Individual Emergency Action resolved for this round')+'<p>These are chase-local values. Apply actor injury separately through GGA. Crew takeover automatically schedules Emergency Action for the following chase round. An incapacitated driver creates a replacement / wreck task.</p>',data=>send('condition',{id:p.id,...data,recovered:bool(data,'recovered')}));
  if(action==='check') {
    const reverse=s.phase==='reverseCheck'&&s.sides.quarry.leader===p.id,r=reverse?s.sides.quarry.roll:null;
    const d=s.sides[p.side].declaration,stunt=!reverse&&['stunt','stuntEscape'].includes(d?.key);
    const suggested=suggestedCheck(s,p,stunt?'stunt':'control');
    return form(`${p.name} · ${reverse?'failed Reverse':'control result'}`,input('target','Effective skill of the original roll',r?.target??suggested,'number',`required ${reverse?'readonly':''}`)+input('total','Original 3d6 total',r?.total??'','number',`required min="3" max="18" ${reverse?'readonly':''}`)+(reverse?'':select('purpose','Check purpose',choices(['control','stunt']),stunt?'stunt':'control')+(p.kind==='character'?select('stuntSkill','Foot stunt skill (when recording a stunt)',[{value:'',label:'Choose a stunt skill'},...FOOT_STUNT_SKILLS.map(k=>({value:k,label:k[0].toUpperCase()+k.slice(1)}))],preferredStuntSkill(p)):''))+`${p.kind==='vehicle'&&p.sr==null?input('sr','Stability Rating',p.sr,'number','required min="0" max="100"'):''}<p data-check-preview></p><p>${reverse?'These are the saved failed Reverse dice. Resolve the resulting damage before confirming.':'Enter the original result. A failed check adds a GM consequence task.'}</p>${reverse?checkbox('reviewed','Damage and other consequences have been resolved'):''}`,data=>send('check',{id:p.id,...data,reviewed:bool(data,'reviewed')}),reverse?'Confirm Reverse result':'Record result',root=>{
      const update=()=>{const data=Object.fromEntries(new FormData(root));try{const result=wipeout({target:data.target,total:data.total,kind:p.kind,sr:data.sr??p.sr});root.querySelector('[data-check-preview]').textContent=`Result: ${result.status==='closeCall'?'close call; Emergency Action due next round':result.status}.`;}catch{root.querySelector('[data-check-preview]').textContent='Supply the original dice and any missing SR to see the consequence.';}};root.addEventListener('input',update);update();
    });
  }
  if(action==='note')return form('Record a GM ruling',textarea('text','Shared ruling / outcome'),data=>send('note',{text:data.text}),'Add to log');
  if(action==='override')return form('GM range / end chase',select('band','Resulting range',BANDS.map((x,i)=>({value:i,label:x})),s.band)+checkbox('swap','Swap quarry and pursuer')+checkbox('end','End the chase')+textarea('reason','Reason (required)')+'<p>Applies the chosen outcome and starts the next chase round, or ends the chase. Undo restores the previous state. It does not move tokens.</p>',data=>send('override',{...data,end:bool(data,'end'),swap:bool(data,'swap')}),'Apply outcome');
  if(action==='skillRoll')return form(`${p.name} · ad hoc roll`,input('name','Roll label',`${p.name}: ${p.skillName}`)+input('target','Base skill',p.skill,'number','required')+input('modifier','Modifier',0,'number','required')+checkbox('whisper','Private to GM'),data=>standaloneRoll({...data,whisper:bool(data,'whisper')}),'Roll 3d6');
  if(action==='gga')return form(`${p.name} · native GGA roll`,input('otf','GGA on-the-fly expression','', 'text','required placeholder="A:&quot;Pistol&quot; -7"')+'<p>Use a normal GGA expression. Include the chase attack modifiers when relevant; they are not added automatically by this button. The normal modifier bucket, roll mode, attack options, and damage workflow apply. Ownership of the linked actor is required.</p>',data=>rollGGA(s,p,data.otf,event),'Roll with GGA');
  if(action==='attack') {
    if(!attackAllowed(s,p))throw new Error('The current manoeuvre does not permit an attack. Choose an available action from the task list.');
    return taskForm(s,tasks(s).find(t=>t.participantId===p.id&&['attack','passenger'].includes(t.kind)),send,event);
  }
}

function rootsFor(s,side){return s.participants.filter(p=>p.side===side&&!p.transportId&&!['wreck','out'].includes(p.status)).map(p=>({value:p.id,label:p.name}));}
function editParticipant(s,draft,send) {
  return form(`${draft.kind==='vehicle'?'Vehicle':'Character'} · ${draft.name}`,participantForm(s,draft,[...game.users]),data=>{
    const controllers=Object.keys(data).filter(k=>k.startsWith('controller:')).map(k=>k.slice(11));
    return send('participant',{data:{...draft,...data,controllers,gunslinger:bool(data,'gunslinger')},expectedParticipant:JSON.stringify(unit(s,draft.id)??null),pauseForEdit:s.status==='running'});
  });
}
export function openChases(id) {
  if(!Tracker)return ui.notifications.warn('Action Chases is still initialising.');
  tracker??=new Tracker();if(id)tracker.selectedId=id;tracker.render({force:true});return tracker;
}
Hooks.once('init',()=>{
  classes(foundry.applications.api.ApplicationV2);installReplaceListenerGuard();
  game.settings.register(ID,'lastChase',{scope:'client',config:false,type:String,default:''});
  game.keybindings.register(ID,'open',{name:'Open Action Chases',editable:[{key:'KeyC',modifiers:['Control','Shift']}],onDown:()=>{openChases();return true;},restricted:false});
  const Base=foundry.appv1?.api?.FormApplication??globalThis.FormApplication;
  if(Base) {
    class ChaseMenu extends Base {render(){openChases();return this;}}
    game.settings.registerMenu(ID,'open',{name:'Action Chases',label:'Open Chase Tracker',hint:'Create and manage shared chase scenes.',icon:'fa-solid fa-person-running',type:ChaseMenu,restricted:false});
  }
});
Hooks.once('ready',()=>{
  game.modules.get(ID).api={open:openChases,version:'0.2.5'};
  installStoreHooks(()=>{if(tracker?.rendered)tracker.render({force:true});},openChases);
});
Hooks.on('getSceneControlButtons',controls=>{
  if(controls.tokens?.tools)controls.tokens.tools.actionChases={name:'actionChases',title:'Action Chases',icon:'fa-solid fa-person-running',order:Object.keys(controls.tokens.tools).length,button:true,onChange:()=>openChases()};
});
Hooks.on('renderCombatTracker',(app,html)=>{
  const root=html instanceof HTMLElement?html:html?.[0];if(!root||root.querySelector('.gac-open'))return;
  const b=document.createElement('button');b.type='button';b.className='gac-open';b.innerHTML='<i class="fa-solid fa-person-running"></i> Action Chases';b.addEventListener('click',()=>openChases());
  (root.querySelector('.directory-header')??root).prepend(b);
});

function toggle(root,selector,show){
  const group=root.querySelector(selector);if(!group)return;
  group.hidden=!show;for(const el of group.querySelectorAll('input,select,textarea,button'))el.disabled=!show;
}
function setValue(root,name,value){
  const el=root.querySelector(`[name="${name}"]`);if(!el)return;
  if(el.tagName==='SELECT'){for(const o of el.options)o.selected=String(o.value)===String(value);}
  else if(el.type==='checkbox')el.checked=!!value;else el.value=value??'';
}
function actorForm(s,send){
  const actors=[...game.actors].filter(a=>a.testUserPermission(game.user,'OWNER'));
  if(!actors.length)throw new Error('No owned actors are available. Use Add character for an ad hoc participant.');
  let actor=actors[0],skills=flattenSkills(actor.system?.skills),draft=participantFromActor(actor,null);
  const skillChoices=()=>[{value:'',label:'DX (no skill)'},...skills.map((x,i)=>({value:i,label:`${x.name} ${x.level} (${x.relativelevel??'review basis'})`}))];
  const selected=skills.findIndex(x=>/^running$/i.test(x.name));
  return form('Add actor · select, review & save',select('actorId','Source actor',actors.map(a=>({value:a.id,label:a.name})),actor.id)+select('sourceSkill','Chase skill to import',skillChoices(),selected<0?'':selected)+`<div data-actor-review>${participantForm(s,draft,[...game.users])}</div>`,data=>{
    const controllers=Object.keys(data).filter(k=>k.startsWith('controller:')).map(k=>k.slice(11));
    return send('participant',{data:{...draft,...data,controllers,gunslinger:bool(data,'gunslinger')},expectedParticipant:'null',pauseForEdit:s.status==='running'});
  },'Add to chase',root=>{
    root.addEventListener('change',ev=>{
      if(!['actorId','sourceSkill'].includes(ev.target.name))return;
      const current=Object.fromEntries(new FormData(root));
      if(ev.target.name==='actorId'){
        actor=game.actors.get(current.actorId);skills=flattenSkills(actor.system?.skills);
        root.querySelector('[name="sourceSkill"]').closest('label').outerHTML=select('sourceSkill','Chase skill to import',skillChoices(),'');
      }
      const selected=root.querySelector('[name="sourceSkill"]').value;
      draft=participantFromActor(actor,selected===''?null:skills[Number(selected)],current.side);
      if(selected===''){draft.skill=Number(actor.system?.attributes?.DX?.value)||12;draft.skillName='DX';}
      if(ev.target.name==='actorId')root.querySelector('[data-actor-review]').innerHTML=participantForm(s,draft,[...game.users]);
      else {setValue(root,'skillName',draft.skillName);setValue(root,'skill',draft.skill);}
    });
  });
}
function crewForm(s,p,send,task=null){
  const driverTask=task?.kind==='driver',embarkTask=task?.kind==='embark';
  const chars=s.participants.filter(x=>x.kind==='character'&&!['wreck','out'].includes(x.status));
  const vehicle=p?.kind==='vehicle'?p:unit(s,p?.transportId),person=p?.kind==='character'?p:chars.find(x=>x.transportId===vehicle?.id&&x.role==='passenger')??(driverTask?null:chars[0]),newId=uid(),newChoice=`new:${newId}`;
  const charChoices=[...chars.map(x=>({value:x.id,label:`${x.name} (${x.side})`})),{value:newChoice,label:'Add an ad hoc crew member…'}];
  const destinations=driverTask?[{value:vehicle.id,label:vehicle.name}]:[{value:'',label:'On foot / disembark'},...s.participants.filter(x=>x.kind==='vehicle'&&!['wreck','out'].includes(x.status)).map(x=>({value:x.id,label:`${x.name} (${x.side})`}))];
  const timings=driverTask?[{value:'now',label:'Now · replace the missing driver'}]:embarkTask?[{value:'next',label:'Next chase round (Embark / Disembark)'}]:s.status==='running'?[{value:'next',label:'Next chase round'},...(!['chase','range','reverseCheck'].includes(s.phase)?[{value:'now',label:'Now (GM ruling / change of control)'}]:[])]:[{value:'now',label:'Now'},{value:'next',label:'Next chase round'}];
  const transfer=select('personId','Character',charChoices,person?.id??newChoice)+`<div data-new-crew><div class="gac-form-grid">${input('newName','Name','New crew member','text','required')}${select('newSide','Side',choices(SIDES),vehicle?.side??'quarry')}${input('newSkillName','DX-based chase skill','Driving')}${input('newSkill','Skill level',12,'number','required min="1"')}${input('newSpeed','Top Move on foot',5,'number','required min="0"')}${select('originVehicleId','Starts aboard',[{value:'',label:'On foot'},...s.participants.filter(x=>x.kind==='vehicle').map(x=>({value:x.id,label:x.name}))],vehicle?.id??'')}</div><fieldset><legend>Player control</legend>${[...game.users].filter(u=>!u.isGM).map(u=>checkbox(`controller:${u.id}`,u.name)).join('')}</fieldset></div>`+
    select('vehicleId','Destination',destinations,vehicle?.id??'')+
    select('role','Role',[...(!driverTask?[{value:'passenger',label:'Passenger'}]:[]),{value:'operator',label:'Driver / operator (replaces current driver)'}],p?.kind==='vehicle'?'operator':person?.role??'passenger')+
    select('when','Takes effect',timings,driverTask?'now':s.status==='running'?'next':'now')+
    checkbox('takeover','Take over an enemy vehicle; change its side')+
    `<div data-recovery>${checkbox('recovery','Emergency Action next round after this driver takes over',driverTask)}<p>Replacing a missing driver or taking over an enemy vehicle automatically needs recovery next round. Earlier recovery already due is retained.</p></div>`+
    `<div data-leave-source>${checkbox('leaveSource','Leave the old vehicle behind when its last active crew member leaves',true)}<p>The empty vehicle leaves the chase. Its side’s leader follows the departing crew automatically. Clear this to keep the vehicle in the chase; any missing driver will still need replacement.</p></div>`;
  const footFields=`<div data-foot>${input('footSkillName','On-foot chase skill',person?.footSkillName||'Running (DX-based)')}${input('footSkill','DX-based level on foot',footSkillOf(person),'number','required min="1" max="1000"')}<p>Used from the round you disembark. The character’s driving skill is retained for future vehicle use.</p></div>`;
  const outcome=driverTask?select('resolution','Outcome',[{value:'transfer',label:'Replace the driver now'},{value:'wreck',label:'No replacement · resolve wreck and damage'}],'transfer'):embarkTask?select('resolution','Outcome',[{value:'transfer',label:'Apply a crew change next round'},{value:'noChange',label:'No change / failed attempt'}],'transfer'):'';
  return form(task?task.title:'Change driver / board / disembark',`<p>The old driver becomes a passenger automatically. Boarding a hostile vehicle keeps the character’s side until an explicit takeover. Resolve any opposed action before applying the change.</p>${outcome}<div data-transfer>${transfer}${footFields}</div><p data-wreck>Resolve the vehicle’s wreck and occupant injury before confirming. Apply actor damage separately.</p>${textarea('note','Outcome / reason (saved to the chase log)')}`,data=>{
    if(driverTask&&data.resolution==='wreck')return send('task',{taskId:task.id,mode:'approve',stop:true,note:data.note});
    if(embarkTask&&data.resolution==='noChange'){if(!data.note?.trim())throw new Error('Record why no crew change occurred.');return send('task',{taskId:task.id,mode:'approve',note:data.note});}
    const newPerson=data.personId===newChoice?{id:newId,name:data.newName,side:data.newSide,skillName:data.newSkillName,skill:data.newSkill,speed:data.newSpeed,controllers:Object.keys(data).filter(k=>k.startsWith('controller:')).map(k=>k.slice(11))}:undefined;
    return send('crew',{...data,newPerson,takeover:bool(data,'takeover'),recovery:bool(data,'recovery'),leaveSource:bool(data,'leaveSource'),taskId:task?.id});
  },driverTask?'Resolve vehicle control':'Apply crew change',root=>{
    const update=()=>{
      const transfer=!task||root.querySelector('[name="resolution"]').value==='transfer';
      toggle(root,'[data-transfer]',transfer);toggle(root,'[data-new-crew]',transfer&&root.querySelector('[name="personId"]').value===newChoice);
      const originId=root.querySelector('[name="personId"]').value===newChoice?root.querySelector('[name="originVehicleId"]').value:unit(s,root.querySelector('[name="personId"]').value)?.transportId;
      const destination=root.querySelector('[name="vehicleId"]').value;
      toggle(root,'[data-leave-source]',transfer&&!!originId&&originId!==destination);
      toggle(root,'[data-foot]',transfer&&!!originId&&!destination);
      toggle(root,'[data-recovery]',transfer&&root.querySelector('[name="role"]').value==='operator'&&!!destination);
      toggle(root,'[data-wreck]',driverTask&&!transfer);
      root.querySelector('[name="note"]').required=!!task&&!transfer;
    };root.addEventListener('change',ev=>{
      if(ev.target.name==='personId') {const chosen=unit(s,ev.target.value);setValue(root,'footSkill',footSkillOf(chosen)??'');setValue(root,'footSkillName',chosen?.footSkillName||'Running (DX-based)');}
      update();
    });update();
  });
}
function taskForm(s,t,send,event){
  if(!t)throw new Error('This task is no longer available. Check the current task list.');
  const p=unit(s,t.participantId),shooter=p?(operatorOf(s,p)??p):null;
  if(['embark','driver'].includes(t.kind))return crewForm(s,p,send,t);
  if(t.gm){
    let fields='';
    if(t.kind==='scene'&&['stunt','stuntEscape'].includes(s.sides[t.side].declaration.key)&&roots(s,t.side).some(x=>x.kind==='character'))fields=input('minimumPenalty','Minimum penalty for the chosen foot feat','','number','required min="-100" max="0" step="1"')+'<p>Consult Climbing / Parkour (Action 2, pp. 18–20). The declared risk must be at least this hard; for different feats, use the hardest minimum.</p>';
    if(t.kind==='mobility')fields=select('follow','Can the pursuer follow?',[{value:'yes',label:'Yes · normal moving contest'},{value:'no',label:'No · pursuer is forced static'}],'yes');
    if(t.kind==='static')fields=select('static','Still unable to follow?',[{value:'yes',label:'Yes · remain static'},{value:'no',label:'No · clear restriction'}],'yes');
    if(t.kind==='skill')fields=input('target','DX-based Stealth level','','number','required min="0" max="1000"');
    if(t.kind==='recover')fields=select('recovery','Outcome',[{value:'recover',label:'Individual Emergency Action resolved'},{value:'stop',label:'Stop / leave the chase'}],'recover');
    if(t.kind==='consequence'){
      const c=s.checks[t.checkIndex];fields=`<p><strong>Original roll: ${c.total} vs ${c.target}.</strong> ${c.pending?'Enter SR to calculate the result without rerolling.':`Result: ${c.status==='wreck'?'wreck':'close call; recovery due next round'}.`}</p>${c.pending?input('sr','Vehicle Stability Rating','','number','required min="0" max="100"'):''}<p data-consequence-preview></p>${input('hp','Chase HP after damage (optional)',p.hp,'number')}<p>Resolve damage in GGA where applicable. Saving confirms that the consequences have been handled.</p>`;
    }
    return form(t.title,`<p>${e(t.hint)}</p>${fields}${textarea('note',['contact','finish'].includes(t.kind)?'Resolved outcome (required)':'Outcome / ruling (optional)')}`,data=>send('task',{taskId:t.id,mode:'approve',...data,canFollow:data.follow==='yes',keepStatic:data.static==='yes',stop:data.recovery==='stop'}),'Confirm resolution',root=>{
      if(t.kind==='consequence'&&s.checks[t.checkIndex].pending){const update=()=>{const el=root.querySelector('[data-consequence-preview]');try{const c=s.checks[t.checkIndex],r=wipeout({target:c.target,total:c.total,kind:p.kind,sr:root.querySelector('[name="sr"]').value});el.textContent=r.status==='wreck'?'Result: wreck. Resolve the wreck and any damage before confirming.':'Result: close call. Emergency Action will be due next round. Resolve any damage before confirming.';}catch{el.textContent='Supply SR to see the consequence.';}};root.addEventListener('input',update);update();}
    });
  }
  const stunt=t.kind==='stunt';
  const modes=[{value:'roll',label:'Roll now & record'},{value:'manual',label:'Enter original 3d6 result'},...(!stunt?[{value:'external',label:'Resolved elsewhere (record outcome)'}]:[]),...(game.user.isGM&&stunt?[{value:'waive',label:'GM ruling (no dice available)'}]:[])];
  const actions=[{value:'Other Task',label:'Other task'},...(attackAllowed(s,p)?[{value:'Attack',label:'Attack'}]:[]),...(s.band===0?[{value:'Board',label:'Board another vehicle'}]:[]),{value:'Seize Control',label:'Seize controls'}];
  const stuntSkills=stunt&&p.kind==='character'?[{value:'',label:'Choose the foot stunt skill'},...FOOT_STUNT_SKILLS.map(k=>({value:k,label:`${k[0].toUpperCase()+k.slice(1)}${p[k]!=null?' '+p[k]:' · enter effective skill'}`}))]:[];
  const html=`<p>${e(t.hint)}</p>${t.kind==='passenger'?select('action','Passenger action',actions,'Other Task')+`<p class="gac-hint">${!attackAllowed(s,p)?'Attack unavailable with the current manoeuvre. ':''}${s.band!==0?'Boarding requires Close range.':''}</p>`:''}${select('mode','How will you resolve it?',modes,'roll')}${stuntSkills.length?select('stuntSkill','Stunt skill',stuntSkills,preferredStuntSkill(p)):''}<div data-dice>${input('target',stunt?`Effective stunt skill (including ${s.sides[p.side].declaration.penalty} risk)`:'Skill level',stunt?t.target:'','number','required min="-100" max="1000"')}<div data-attack-fields><details open><summary>Chase attack modifiers</summary><div class="gac-form-grid"><div data-bulk>${input('bulk','Weapon Bulk',-2,'number','required max="0"')}</div>${input('acc','Weapon Acc',0,'number','required min="0"')}${select('targetType','Target',[{value:'0',label:'Pedestrian / exposed rider (0)'},{value:'-3',label:'Crew / vital area (−3)'},{value:'vehicle',label:'Whole vehicle (SM)'}],'0')}<div data-sm>${input('sm','Target vehicle SM',0,'number')}</div>${input('extra','Other attack modifiers',0,'number','required')}</div><p data-attack-rule></p><p data-attack-preview></p><p>Uses the current manoeuvre and range. Gunslinger: ${shooter?.gunslinger?'yes':'no'}. One attack roll represents this round’s opportunity; resolve melee externally.</p></details></div><div data-manual>${input('total','Original 3d6 total','','number','required min="3" max="18" step="1"')}</div></div>${stunt&&p.kind==='vehicle'&&p.sr==null&&game.user.isGM?input('sr','Stability Rating (optional now; required if the roll fails)','','number','min="0" max="100"'):''}<div data-waive>${checkbox('success','GM rules that this stunt succeeded')}</div>${textarea('note','Outcome / notes (required for external results or a GM ruling)')}${shooter?.actorUuid?`<details><summary>Use a native GGA roll</summary><p>Include the chase modifiers in the expression. After rolling, enter its original dice above${stunt?'':' or record the external outcome'}. This task stays open.</p>${input('otf','GGA expression','','text','placeholder="S:Driving"')}<button type="button" data-native-roll>Roll with GGA</button><p data-native-status role="status"></p></details>`:''}`;
  return form(t.title,html,data=>send('task',{taskId:t.id,...data,success:bool(data,'success'),targetMod:data.targetType==='vehicle'?data.sm:data.targetType??0}),'Resolve task',root=>{
    const update=()=>{
      const mode=root.querySelector('[name="mode"]').value,action=root.querySelector('[name="action"]')?.value??(stunt?'Stunt':'Attack'),attack=action==='Attack';
      toggle(root,'[data-dice]',['roll','manual'].includes(mode));toggle(root,'[data-manual]',mode==='manual');toggle(root,'[data-waive]',mode==='waive');toggle(root,'[data-attack-fields]',attack&&['roll','manual'].includes(mode));toggle(root,'[data-sm]',attack&&['roll','manual'].includes(mode)&&root.querySelector('[name="targetType"]').value==='vehicle');
      const manoeuvre=s.sides[actionSide(s,p)].declaration.key,role=p.transportId?p.role:p.kind==='vehicle'?'operator':'pedestrian';
      const moving=['embark','force','moveAttack','ram'].includes(manoeuvre),bulkApplies=moving&&role!=='passenger'&&!shooter?.gunslinger;
      toggle(root,'[data-bulk]',attack&&['roll','manual'].includes(mode)&&bulkApplies);
      root.querySelector('[data-attack-rule]').textContent=(shooter?.gunslinger?'Gunslinger ignores movement and Bulk penalties.':role==='passenger'&&moving?'Passenger movement is a flat −1; Weapon Bulk does not apply.':!moving?'Weapon Bulk does not apply to this attack.':'Movement uses the worse of −2 or Weapon Bulk.')+(manoeuvre==='embark'?' Embark is static for the Chase Roll, but shooting uses movement penalties; ordinary shooters do not add Acc.':'')+' Range-band penalties come from Action 2, p. 35.';
      const data=Object.fromEntries(new FormData(root));
      root.querySelector('[name="target"]').closest('label').querySelector('span').textContent=stunt?`Effective stunt skill (including ${s.sides[p.side].declaration.penalty} risk)`:attack?'Base attack skill':'Effective task skill';
      root.querySelector('[name="note"]').required=['external','waive'].includes(mode);
      if(attack){try{const role=p.transportId?p.role:p.kind==='vehicle'?'operator':'pedestrian',m=attackModifiers({band:s.band,manoeuvre:s.sides[actionSide(s,p)].declaration.key,role,bulk:Number(data.bulk??-2),acc:Number(data.acc??0),gunslinger:!!shooter.gunslinger,target:data.targetType==='vehicle'?Number(data.sm):Number(data.targetType??0)});root.querySelector('[data-attack-preview]').textContent=`Chase modifier ${m.total>=0?'+':''}${m.total}: range ${m.range}, movement ${m.movement}, Acc +${m.accuracy}, target ${m.target}. Effective target ${Number(data.target??0)+m.total+Number(data.extra??0)}.`;}catch(err){root.querySelector('[data-attack-preview]').textContent=err.message;}}
    };
    root.addEventListener('change',ev=>{if(ev.target.name==='stuntSkill')setValue(root,'target',p[ev.target.value]!=null?p[ev.target.value]+s.sides[p.side].declaration.penalty:'');update();});root.addEventListener('input',update);update();
    root.querySelector('[data-native-roll]')?.addEventListener('click',async ev=>{
      ev.preventDefault();const button=ev.currentTarget,info=root.querySelector('[data-native-status]');button.disabled=true;
      try{await rollGGA(s,shooter,root.querySelector('[name="otf"]').value,event);setValue(root,'mode',stunt?'manual':'external');update();info.textContent='Native roll requested. Review it in chat, then complete this task above.';}catch(err){info.textContent=err.message;}finally{button.disabled=false;}
    });
  });
}
