'use strict';
const crypto=require('node:crypto'),C=require('./clinical-episode-contract');
const clone=value=>JSON.parse(JSON.stringify(value));
const error=(code,message,status=400,details)=>C.error(status,'dental_'+code,message,details);
const fail=(code,message,status=400,details)=>{throw error(code,message,status,details);};
const uuid=()=>crypto.randomUUID();
const VISUAL_TYPES=Object.freeze(['extraccion','ausente','raiz-residual','obturacion','obturacion-mod','reconstruccion','inlay','onlay','endodoncia-uniradicular','endodoncia-biradicular','endodoncia-poliradicular','perno','munon','corona','corona-zirconio','corona-disilicato','corona-metal-ceramica','carilla','implante','implante-corona','puente','puente-pontico','protesis-removible','protesis-completa','bracket','alineador','retenedor','rotacion-derecha','rotacion-izquierda','limpieza','curetaje','sellador','fluor','blanqueamiento','rx-periapical','rx-panoramica','consulta','revision','generico']);
function clinicalConfig(raw){if(typeof raw==='string')raw=JSON.parse(raw);const value=raw||{},result={};if(value.booking_profile)result.booking_profile=require('./booking-profile').normalizeBookingProfile(value.booking_profile,{allowIncomplete:true});if(Array.isArray(value.protocol_tags))result.protocol_tags=value.protocol_tags.filter(t=>typeof t==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(t)).slice(0,100);const visual=value.visual_type??value.tipo_visual;if(VISUAL_TYPES.includes(visual))result.visual_type=visual;return result;}
function id(value){if(typeof value!=='string'||!/^[a-zA-Z0-9_-]{1,80}$/.test(value)||['__proto__','prototype','constructor'].includes(value))fail('identifier_invalid','Identificador dental no válido.');return value;}
function text(value,max=2000){if(value==null||value==='')return null;if(typeof value!=='string'||value.length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value))fail('text_invalid','Revisa el texto indicado.');return value.trim()||null;}
function list(value,max=200){if(!Array.isArray(value)||value.length>max)fail('selection_invalid','Revisa los elementos seleccionados.');return value;}
function version(payload){const n=payload?.expected_version;if(typeof n!=='number'||!Number.isSafeInteger(n)||n<0)fail('version_required','Actualiza el plan antes de guardar.',428);return n;}
function key(payload){const value=C.idempotencyKey(payload?.idempotency_key);if(!value)fail('idempotency_required','La acción necesita una referencia única.',428);return value;}
function target(raw={},previous=null){
 if(!raw||typeof raw!=='object'||Array.isArray(raw)||!['tooth','arch','general'].includes(raw.kind))fail('target_invalid','Selecciona una pieza, arcada o alcance general.');
 const value={id:previous?.id||uuid(),kind:raw.kind,surfaces:[]};
 if(raw.kind==='tooth'){
  const fdi=Number(raw.fdi),quadrant=Math.floor(fdi/10),position=fdi%10;
  if(!Number.isInteger(fdi)||quadrant<1||quadrant>8||position<1||position>(quadrant<=4?8:5))fail('target_invalid','La pieza debe usar numeración FDI permanente o temporal.');value.fdi=fdi;
  const surfaces=raw.surfaces??[];list(surfaces,5);if(new Set(surfaces).size!==surfaces.length||surfaces.some(s=>!['M','D','O','I','V','L','P'].includes(s))||surfaces.includes('O')&&surfaces.includes('I')||surfaces.includes('L')&&surfaces.includes('P'))fail('surface_invalid','Revisa las superficies seleccionadas.');value.surfaces=surfaces.slice().sort();
  if(raw.role!==undefined){if(!['abutment','pontic'].includes(raw.role))fail('target_invalid','Selecciona pilar o póntico.');value.role=raw.role;}
 }else if(raw.kind==='arch'){if(!['upper','lower','both'].includes(raw.arch))fail('target_invalid','Selecciona la arcada.');value.arch=raw.arch;}
 if(raw.kind!=='tooth'&&raw.role!==undefined)fail('target_invalid','Pilar y póntico requieren una pieza dental.');
 if(raw.label)value.label=text(raw.label,120);return value;
}
function act(raw,{previous=null,treatment=null,source=null}={}){
 if(!raw||typeof raw!=='object'||Array.isArray(raw))fail('act_invalid','Revisa el tratamiento del plan.');
 const duration=raw.duration_minutes??previous?.duration_minutes??treatment?.duracion_min??null;
 if(duration!==null&&(!Number.isInteger(duration)||duration<1||duration>720))fail('duration_invalid','Indica una duración entre 1 y 720 minutos.');
 const targets=list(raw.targets??previous?.targets??[{kind:'general'}],64).map(t=>target(t,previous?.targets.find(p=>p.id===t.id)));
 if(!targets.length||new Set(targets.map(t=>JSON.stringify([t.kind,t.fdi,t.arch,t.surfaces,t.role]))).size!==targets.length)fail('target_invalid','Conserva un alcance diferente para cada actuación.');
 const snapshot=previous?.catalog_snapshot||(treatment?{id:Number(treatment.id_tratamiento),title:treatment.nombre,code:treatment.codigo||null,clinical_config:clinicalConfig(treatment.clinical_config)}:null);
 const visual=C.has(raw,'visual_type')?raw.visual_type:previous?.visual_type??snapshot?.clinical_config?.visual_type??null;if(visual!==null&&!VISUAL_TYPES.includes(visual))fail('visual_type_invalid','Selecciona una huella del odontograma disponible.');
 const result={id:previous?.id||uuid(),treatment_id:treatment?Number(treatment.id_tratamiento):previous?.treatment_id||null,
  title:text(raw.title??raw.label??previous?.title??treatment?.nombre,255),duration_minutes:duration,
  professional_id:C.has(raw,'professional_id')?(raw.professional_id==null?null:C.integer(raw.professional_id)):previous?.professional_id||null,targets,status:previous?.status||'pending',notes:C.has(raw,'notes')?text(raw.notes):previous?.notes||null,visual_type:visual,
  source:previous?.source||source||null,commercial_scope:previous?.commercial_scope||(source?'accepted':'not_contracted'),
  catalog_snapshot:snapshot,duration_selection:C.has(raw,'duration_selection')?(raw.duration_selection===null?null:require('./booking-profile-duration').normalizeDurationSelection(raw.duration_selection)):previous?.duration_selection||null};
 if(!result.title)fail('act_invalid','Indica el nombre del tratamiento.');result.label=result.title;
 return result;
}
function dependencies(input,acts){
 const result=list(input,500).map(raw=>{
  const from=id(raw.from_act_id),to=id(raw.to_act_id),wait=raw.min_wait_days??0;
  if(from===to||![from,to].every(i=>acts.some(a=>a.id===i&&a.status!=='cancelled'))||!Number.isInteger(wait)||wait<0||wait>3650||!['warn','override','block'].includes(raw.action||'override'))fail('dependency_invalid','Revisa el orden, la espera y los tratamientos de la dependencia.');
  const extra={};if(raw.wait_min_value!==undefined||raw.wait_min_unit!==undefined){if(!Number.isInteger(raw.wait_min_value)||raw.wait_min_value<0||raw.wait_min_value>3650||!['days','weeks','months'].includes(raw.wait_min_unit))fail('dependency_invalid','Revisa la unidad y la espera clínica.');extra.wait_min_value=raw.wait_min_value;extra.wait_min_unit=raw.wait_min_unit;}
  return{id:raw.id?id(raw.id):uuid(),from_act_id:from,to_act_id:to,min_wait_days:wait,action:raw.action||'override',source:raw.source||'manual',notes:text(raw.notes),...extra};
 });
 const visited=new Set(),active=new Set();function visit(value){if(active.has(value))fail('dependency_cycle','Las dependencias forman un ciclo.');if(visited.has(value))return;active.add(value);for(const dep of result.filter(d=>d.to_act_id===value))visit(dep.from_act_id);active.delete(value);visited.add(value);}for(const a of acts)visit(a.id);
 return result;
}
function orderedActs(state){const result=[],seen=new Set();function add(a){if(seen.has(a.id))return;for(const d of state.dependencies.filter(d=>d.to_act_id===a.id))add(state.acts.find(x=>x.id===d.from_act_id));seen.add(a.id);if(a.status!=='cancelled')result.push(a);}for(const a of state.acts)add(a);return result;}
const session=(act,index)=>({id:uuid(),title:`Sesión ${index+1}`,label:`Sesión ${index+1}`,order:index+1,act_ids:[act.id],status:'pending',parent_ids:[],appointment_ids:[],notes:null,reviewed_by:null});
function mutableSession(state,value){const s=state.sessions.find(s=>s.id===id(value));if(!s||s.status==='absorbed')fail('session_not_found','Sesión no encontrada.',404);if(s.appointment_ids.length||state.execution.some(e=>s.act_ids.includes(e.act_id)))fail('session_locked','La sesión tiene reservas o trabajo registrado. Revisa sus citas antes de cambiar su composición.',409);return s;}
function invalidate(state,ids){for(const s of state.sessions.filter(s=>s.status!=='absorbed'&&s.act_ids.some(id=>ids.includes(id)))){if(s.appointment_ids.length)fail('session_locked','La sesión ya tiene reservas.',409);s.status='pending';s.reviewed_by=null;}}
function changeState(previous,payload,{actorId,now=new Date().toISOString(),localDate=now.slice(0,10),preparedAct=null}={}){
 const state=clone(previous),command=payload.command,reason=text(payload.reason),record={id:uuid(),type:command,actor_id:actorId,created_at:now,reason};
 if(command==='generate'){
  if(state.sessions.some(s=>s.appointment_ids.length)||state.execution.length)fail('plan_started','Conserva la planificación que ya tiene citas o trabajo registrado.',409);
  if(!state.acts.some(a=>a.status!=='cancelled'))fail('acts_required','Añade al menos un tratamiento.');
  state.sessions=orderedActs(state).map(session);state.phase='provisional';
 }else if(command==='review_session'){
  const s=state.sessions.find(s=>s.id===id(payload.session_id)&&s.status!=='absorbed');if(!s)fail('session_not_found','Sesión no encontrada.',404);if(!s.act_ids.length||s.act_ids.some(id=>!state.acts.find(a=>a.id===id&&a.status!=='cancelled'&&a.duration_minutes)))fail('duration_required','Revisa el trabajo y su duración antes de validar la sesión.');s.status=s.appointment_ids.length?'booked':'reviewed';s.reviewed_by=actorId;s.reviewed_at=now;s.notes=text(payload.notes??s.notes);s.protocol_acknowledgements=payload.protocol_acknowledgements||[];s.dependency_overrides=list(payload.dependency_overrides||[],100).map(id);if(s.dependency_overrides.some(id=>!state.dependencies.some(d=>d.id===id&&d.action==='override'&&s.act_ids.includes(d.to_act_id))))fail('dependency_invalid','Sólo se pueden revisar excepciones permitidas de esta sesión.');if(s.dependency_overrides.length&&!reason)fail('change_reason_required','Explica la excepción clínica revisada.');s.dependency_override_reason=reason;
  if(payload.tentative_on!==undefined){const date=payload.tentative_on;if(date!==null&&(!/^\d{4}-\d{2}-\d{2}$/.test(date)||new Date(date+'T12:00:00Z').toISOString().slice(0,10)!==date))fail('session_date_invalid','Indica una fecha orientativa válida.');s.tentative_on=date;}
  if(payload.title!==undefined){s.title=text(payload.title,200)||s.title;s.label=s.title;}
 }else if(command==='move_act'){
  const from=mutableSession(state,payload.session_id),to=mutableSession(state,payload.target_session_id),actId=id(payload.act_id);
  if(from.id===to.id||!from.act_ids.includes(actId))fail('session_invalid','Selecciona un tratamiento de la sesión origen.');from.act_ids=from.act_ids.filter(i=>i!==actId);to.act_ids.push(actId);for(const s of[from,to]){s.status=s.act_ids.length?'pending':'absorbed';s.reviewed_by=null;}record.act_id=actId;record.from=from.id;record.to=to.id;
 }else if(command==='merge_sessions'){
  const ids=list(payload.session_ids,30);if(ids.length<2||new Set(ids).size!==ids.length)fail('session_invalid','Elige al menos dos sesiones diferentes.');const sources=ids.map(i=>mutableSession(state,i));
  const joined={...session({id:'unused'},Math.min(...sources.map(s=>s.order))-1),act_ids:sources.flatMap(s=>s.act_ids),parent_ids:sources.map(s=>s.id)};for(const s of sources){s.status='absorbed';s.absorbed_into=joined.id;}state.sessions.push(joined);record.session_id=joined.id;
 }else if(command==='split_session'){
  const from=mutableSession(state,payload.session_id),ids=list(payload.act_ids,100).map(id);if(!ids.length||ids.length>=from.act_ids.length||new Set(ids).size!==ids.length||ids.some(i=>!from.act_ids.includes(i)))fail('session_invalid','Selecciona parte de los tratamientos de la sesión.');
  const child={...session({id:'unused'},state.sessions.length),act_ids:ids,parent_ids:[from.id]};from.act_ids=from.act_ids.filter(i=>!ids.includes(i));from.status='pending';from.reviewed_by=null;state.sessions.push(child);record.session_id=child.id;
 }else if(command==='preferences')state.preferences=require('./dental-preferences').normalize(payload.preferences);
 else if(command==='dependencies'){
  if(state.reservations.length||state.execution.length)fail('plan_started','Las dependencias de un plan en curso requieren revisar sus reservas.',409);const manual=list(payload.dependencies,500);if(manual.some(d=>d.source&&d.source!=='manual'))fail('dependency_source_preserved','Las reglas heredadas conservan su origen; registra una dependencia manual o revisa una excepción permitida.');state.dependencies=dependencies([...state.dependencies.filter(d=>d.source!=='manual'),...manual.map(d=>({...d,source:'manual'}))],state.acts);for(const s of state.sessions){if(s.status!=='absorbed')s.status='pending';}
 }else if(command==='add_act'){
  if(!preparedAct)fail('act_invalid','Revisa el nuevo tratamiento.');if(state.source_budget&&!reason)fail('change_reason_required','Explica el tratamiento añadido al alcance aceptado.');state.acts.push(preparedAct);if(state.sessions.length)state.sessions.push(session(preparedAct,state.sessions.length));record.after=preparedAct;record.impacts=['clinical_scope','budget_review','consent','dependencies','laboratory','agenda'];
 }else if(command==='update_act'||command==='remove_act'){
  const index=state.acts.findIndex(a=>a.id===id(payload.act_id));if(index<0)fail('act_not_found','Tratamiento no encontrado.',404);const old=state.acts[index];
  if(state.execution.some(e=>e.act_id===old.id)||state.reservations.some(r=>r.act_ids.includes(old.id)))fail('act_started','Este tratamiento ya tiene trabajo o reserva. Registra un anexo explícito sin reemplazarlo.',409);
  if(!reason)fail('change_reason_required','Indica el motivo del cambio.');record.before=old;
  if(command==='remove_act')state.acts[index]={...old,status:'cancelled',cancellation_reason:reason};else{if(!preparedAct)fail('act_invalid','Revisa el tratamiento.');state.acts[index]=preparedAct;}
  invalidate(state,[old.id]);record.after=state.acts[index];record.impacts=['clinical_scope','budget_review','consent','dependencies','laboratory','agenda'];
 }else if(command==='review'){
  const due=payload.due_on??null;if(due!==null&&(!/^\d{4}-\d{2}-\d{2}$/.test(due)||new Date(due+'T12:00:00Z').toISOString().slice(0,10)!==due))fail('review_date_invalid','Indica una fecha de revisión válida.');
  const actIds=payload.act_ids??[];list(actIds,100);if(new Set(actIds).size!==actIds.length||actIds.some(id=>!state.acts.some(a=>a.id===id)))fail('review_scope_invalid','Selecciona trabajo de este plan.');
  state.phase='review';record.notes=text(payload.notes);state.review={id:uuid(),title:text(payload.title,200)||'Revisión del plan',notes:record.notes,due_on:due,act_ids:actIds,actor_id:actorId,created_at:now,status:'pending'};state.reviews??=[];state.reviews.push(state.review);
 }else fail('command_invalid','Acción dental no válida.');
 if(['generate','move_act','merge_sessions','split_session','dependencies'].includes(command)){
  const acts=orderedActs(state),order=new Map(acts.map((a,i)=>[a.id,i])),dates=new Map();
  for(const a of acts){let earliest=localDate;for(const d of state.dependencies.filter(d=>d.to_act_id===a.id)){const date=require('./dental-civil-wait').dateForDependency(dates.get(d.from_act_id)||localDate,d);if(date>earliest)earliest=date;}dates.set(a.id,earliest);}
  for(const s of state.sessions.filter(s=>s.status!=='absorbed')){s.act_ids.sort((a,b)=>order.get(a)-order.get(b));s.earliest_date=s.act_ids.map(id=>dates.get(id)||localDate).sort().at(-1)||localDate;}
 }
 state.changes.push(record);if(state.changes.length>500)fail('plan_too_large','Conserva el historial y abre un plan nuevo.',413);return state;
}
function executionResults(state,payload){
 const results=list(payload.results,200);if(!results.length)fail('execution_empty','Selecciona el trabajo que deseas registrar.');const seen=new Set();
 return results.map(raw=>{const actId=id(raw.act_id),targetId=id(raw.target_id),a=state.acts.find(a=>a.id===actId&&a.status!=='cancelled');if(!a||!a.targets.some(t=>t.id===targetId)||!['partial','performed','not_performed'].includes(raw.status)||seen.has(actId+':'+targetId))fail('execution_invalid','Revisa el trabajo y su pieza o alcance.');seen.add(actId+':'+targetId);return{act_id:actId,target_id:targetId,status:raw.status,notes:text(raw.notes)};});
}
function initialState(title){return{schema_version:1,title:text(title,255)||'Plan de tratamiento dental',phase:'accepted',source_budget:null,acts:[],dependencies:[],sessions:[],reservations:[],preferences:null,execution:[],changes:[],review:null};}
module.exports={clone,error,fail,uuid,id,text,list,version,key,target,act,dependencies,orderedActs,changeState,executionResults,initialState,clinicalConfig,VISUAL_TYPES};
