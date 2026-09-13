import {ID, SIDES, clone, uid, escapeHTML, newChase, unit, breakdown, contestMargin} from './rules.mjs';
import {applyCommand, importChase} from './engine.mjs';
import {actorOwned} from './integration.mjs';
import {upgrade,recoveryState} from './workflow.mjs';
import {sha256} from './hash.mjs';

export const readChase = doc => {
  const data=doc?.getFlag(ID,'data');if(data==null||data==='')return null;
  let s;
  try{s=JSON.parse(data);}catch{
    const recovery=recoveryState(data,'The saved chase is not valid JSON. Restore a backup or seek help with the downloaded original record.');
    recovery.name=String(doc?.name??'Saved chase needs recovery').replace(/^Chase · /,'');return recovery;
  }
  return s?.schema===1?upgrade(s):null;
};
export const chaseDocuments = () => [...game.journal].filter(d=>readChase(d)&&d.testUserPermission(game.user,'OBSERVER'));
export const activeGM = () => game.users.activeGM ?? [...game.users].filter(u=>u.active&&u.isGM).sort((a,b)=>a.id.localeCompare(b.id))[0];
export const isAuthority = () => !!game.user.isGM&&activeGM()?.id===game.user.id;
let chain=Promise.resolve();
export function queue(task) {const result=chain.then(task);chain=result.catch(()=>{});return result;}
export async function createChase(name, imported=null, initial=null) {
  if(!game.user.isGM)throw new Error('Only a GM can create a chase.');
  let s=imported?importChase(imported):newChase(name);
  if(initial)s=applyCommand(s,{type:'configure',epoch:s.epoch,revision:s.revision,data:{name:s.name,...initial}},game.user);
  if(imported&&name)s.name=String(name).trim().slice(0,100);
  return JournalEntry.create({name:`Chase · ${s.name}`,ownership:{default:CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER},
    flags:{[ID]:{data:JSON.stringify(s)}},pages:[{name:'About this chase',type:'text',text:{content:'<p>Open this chase using the Action Chases toolbar button, Combat sidebar button, or Ctrl+Shift+C. Chase data is shared with players and survives clearing chat. Export a JSON backup from the Chase window.</p>'}}]});
}
const pending=new Map(),feedback=new Map(),privateChoices=new Map();
let refreshUI=()=>{};
export const submissionStatus=docId=>feedback.get(docId);
export const ownCommitment=(docId,epoch,side)=>privateChoices.get(`${docId}:${epoch}:${side}`);
function status(docId,kind,text){feedback.set(docId,{kind,text});refreshUI();}
export function submit(doc, command) {
  const s=readChase(doc);if(!s)return Promise.reject(new Error('This chase no longer exists.'));
  const gm=activeGM();if(!gm)return Promise.reject(new Error('An active GM is required. Your entries have been kept.'));
  const cmd={...command,epoch:command.epoch??s.epoch,revision:command.revision??s.revision};
  const key=JSON.stringify([game.user.id,doc.id,cmd.epoch,cmd.type,cmd.taskId??cmd.side??cmd.id??cmd.data?.id??'']);
  if(pending.has(key)){const prior=pending.get(key);return prior.command===JSON.stringify(cmd)?prior.promise:Promise.reject(new Error('Another submission for this task is still waiting. Your entries have been kept.'));}
  let resolve,reject;
  const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});
  const entry={promise,command:JSON.stringify(cmd),docId:doc.id,nonce:uid(),authorId:game.user.id};pending.set(key,entry);
  entry.finish=(ok,error,value)=>{
    if(!pending.has(key))return;
    clearTimeout(entry.timer);pending.delete(key);
    if(ok&&s.blind&&cmd.type==='declare')privateChoices.set(`${doc.id}:${s.epoch}:${cmd.side}`,cmd.data.key);
    status(doc.id,ok?'accepted':'rejected',ok?'Accepted. Chase updated.':error);
    if(ok)resolve(value??{accepted:true});else reject(new Error(error));
  };
  status(doc.id,'pending','Sending to the active GM…');
  void (async()=>{
    try {
      if(isAuthority()&&!(s.blind&&cmd.type==='declare'))return entry.finish(true,'',await queue(()=>execute(doc,cmd,game.user)));
      // Receipts are accepted only from the authenticated GM update hook below.
      entry.timer=setTimeout(()=>entry.finish(false,'No acknowledgement yet. Your entries are kept. Check the chase and the request in chat before trying again.'),25000);
      await ChatMessage.create({user:game.user.id,whisper:ChatMessage.getWhisperRecipients('GM').map(u=>u.id),
        content:`<p><strong>Chase request:</strong> ${escapeHTML(s.name)} · ${escapeHTML(cmd.type)}. Awaiting the active GM.</p>`,
        flags:{[ID]:{request:{docId:doc.id,command:cmd,nonce:entry.nonce}}}});
    }catch(err){entry.finish(false,err.message);}
  })();
  return promise;
}
export async function showToPlayers(doc) {
  if(!game.user.isGM)throw new Error('Only a GM can show a chase to players.');
  return ChatMessage.create({user:game.user.id,content:`<p><strong>${escapeHTML(readChase(doc).name)}</strong></p><button type="button" data-gac-open="${escapeHTML(doc.id)}">Open chase tracker</button>`,flags:{[ID]:{invitation:{docId:doc.id}}}});
}
async function commitment(request) {
  const bytes=new TextEncoder().encode(JSON.stringify({data:request.command.data,nonce:request.nonce}));
  if(!globalThis.crypto?.subtle)return sha256(bytes);
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(x=>x.toString(16).padStart(2,'0')).join('');
}
export async function execute(doc, command, user, requestId='') {
  if(!isAuthority())throw new Error('The active GM changed. Submit the action again.');
  const state=readChase(doc);if(!state)throw new Error('Chase data is missing.');
  if(!doc.testUserPermission(user,'OBSERVER'))throw new Error('You cannot access this chase.');
  if(requestId&&state.processed.includes(requestId))return state;
  let roll=null,privateDeclarations=null;
  if(command.type==='reveal') {
    privateDeclarations={};
    for(const side of SIDES) {
      const ref=state.blindRequests[side],message=game.messages.get(typeof ref==='string'?ref:ref?.id),request=message?.getFlag(ID,'request');
      if(!request||request.command.epoch!==state.epoch||request.command.side!==side||!ref.hash||await commitment(request)!==ref.hash)throw new Error('A private commitment is missing or changed. Undo the commitments and submit them again.');
      privateDeclarations[side]=request.command.data;
    }
  }
  // First validate with a harmless placeholder total. Unauthorised requests never roll dice.
  const options={actorOwned,total:10,requestId,privateDeclarations};
  let next=applyCommand(state,command,user,options);
  if(command.type==='roll'||(command.type==='task'&&command.mode==='roll')) {
    roll=await new Roll('3d6').evaluate();
    next=applyCommand(state,command,user,{...options,total:roll.total});
  }
  if(command.type==='declare'&&state.blind) {
    const request=clone(game.messages.get(requestId)?.getFlag(ID,'request'));
    if(!request)throw new Error('Private declaration request not found.');
    if(JSON.stringify(request.command)!==JSON.stringify(command))throw new Error('The declaration was edited before acceptance. Submit it again.');
    next.blindRequests[command.side]={id:requestId,hash:await commitment(request)};
  }
  if(!isAuthority())throw new Error('The active GM changed before saving. Submit again.');
  await doc.update({name:`Chase · ${next.name}`,[`flags.${ID}.data`]:JSON.stringify(next)});
  if(roll) {
    let speaker,flavor;
    if(command.type==='roll') {
      const p=unit(state,state.sides[command.side].leader),b=breakdown(state,command.side);
      speaker=p.name;flavor=`${escapeHTML(next.name)} · ${escapeHTML(command.side)} Chase Roll<br>${roll.total} vs ${b.target} · contest margin ${contestMargin({target:b.target,total:roll.total})}<br>${b.parts.map(x=>`${escapeHTML(x.label)} ${x.value}`).join(' · ')}<br><small>Quick Contest: success beats failure; criticals do not automatically win. Automatic results use minimum success 0 / failure 1 when needed.</small>`;
    } else {
      const o=next.workflow.outcomes[command.taskId],p=unit(state,o.participantId),r=o.result;
      speaker=p.name;flavor=`${escapeHTML(next.name)} · ${escapeHTML(command.taskId.startsWith('stunt:')?'Stunt':o.action)}<br>${r.total} vs ${r.target} · ${r.success?'Success':'Failure'} · margin ${r.margin}<br><small>Result recorded. Required consequences appear in the tracker.</small>`;
    }
    try {await roll.toMessage({speaker:{alias:speaker},flavor:`<strong>${flavor}</strong><br><small>Requested by ${escapeHTML(user.name)}.</small>`},{rollMode:'publicroll'});}catch(err){ui.notifications.warn('Roll saved, but its chat message could not be posted. Read the chase log.');console.warn(ID,err);}
  }
  return next;
}
export function installStoreHooks(refresh,open=()=>{}) {
  refreshUI=refresh;
  Hooks.on('createChatMessage',(message,options,creatorId)=>{
    const invitation=message.getFlag(ID,'invitation');
    if(invitation&&game.users.get(creatorId)?.isGM&&creatorId!==game.user.id){const doc=game.journal.get(invitation.docId);if(doc?.testUserPermission(game.user,'OBSERVER'))open(doc.id);}
    const request=clone(message.getFlag(ID,'request'));
    if(!request||!isAuthority())return;
    const user=game.users.get(creatorId); // Trusted lifecycle identity, never request.userId.
    if(!user)return;
    void queue(async()=>{
      let content,ok=false,error='';
      try {
        const doc=game.journal.get(request.docId);
        if(!doc)throw new Error('Chase not found.');
        await execute(doc,request.command,user,message.id);
        content=`<p><strong>Chase:</strong> ${escapeHTML(request.command.type)} accepted for ${escapeHTML(readChase(doc).name)}.</p>`;ok=true;
      } catch(err) {error=err.message;content=`<p><strong>Chase request rejected:</strong> ${escapeHTML(err.message)}</p>`;}
      // Updating the request preserves a visible receipt for its author and the GM.
      try{await message.update({content,[`flags.${ID}.receipt`]:{ok,by:game.user.id,error,nonce:request.nonce}});}catch(err){console.warn(ID,'Could not update chase receipt',err);}
    });
  });
  for(const hook of ['updateJournalEntry','createJournalEntry','deleteJournalEntry','updateUser'])Hooks.on(hook,()=>refresh());
  Hooks.on('updateChatMessage',(message,change,options,updaterId)=>{
    const receipt=message.getFlag(ID,'receipt');
    if(!receipt||!game.users.get(updaterId)?.isGM||receipt.by!==updaterId)return;
    const request=message.getFlag(ID,'request');
    for(const entry of pending.values())if(entry.nonce===receipt.nonce&&request?.nonce===entry.nonce&&entry.docId===request.docId)entry.finish(receipt.ok,receipt.error||'The GM rejected this action. Your entries have been kept.');
    refresh();
  });
  Hooks.on('renderChatMessageHTML',(message,html)=>{
    const root=html instanceof HTMLElement?html:html?.[0];
    root?.querySelectorAll('[data-gac-open]').forEach(b=>b.addEventListener('click',()=>{
      const doc=game.journal.get(b.dataset.gacOpen);if(doc?.testUserPermission(game.user,'OBSERVER'))open(doc.id);
    }));
  });
}
