'use strict';

const { Op } = require('sequelize');
const { AsyncLocalStorage } = require('node:async_hooks');
const { isDeepStrictEqual } = require('node:util');
const { addDays, domainError } = require('../lib/patientFollowUps.contract');
const KIND = 'patient_follow_up_reminder';
const ROLES = Object.freeze([
  { id: 1, code: 'propietario', name: 'Propietarios' }, { id: 2, code: 'doctor', name: 'Doctores' },
  { id: 3, code: 'assistant', name: 'Auxiliares y enfermería' }, { id: 4, code: 'reception', name: 'Recepción / Comercial' },
  { id: 5, code: 'admin_staff', name: 'Administrativos' }, { id: 6, code: 'patient_director', name: 'Dirección de pacientes' },
  { id: 7, code: 'agencia', name: 'Agencia' }, { id: 8, code: 'accountant', name: 'Gestoría' },
]);
const active = row => ['pending','contacted'].includes(row.status);
const plain = row => row?.toJSON ? row.toJSON() : row;
const name = user => [user?.nombre,user?.apellidos].filter(Boolean).join(' ');
function localDay(now, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  return ['year','month','day'].map(key => parts.find(p => p.type === key).value).join('-');
}

function createPatientFollowUpNoticeService({ db, canAccess = args => require('../lib/access-policy').canUserAccessFeature(args),
  opening = require('./clinicOpeningHours.service'), now = () => new Date(),
  emit = row => require('./notificationsRealtime.service').emitNotificationUpdated(row) } = {}) {
  const { PatientFollowUp: FollowUp, PatientFollowUpNotice: Notice, Notification, Usuario, UsuarioClinica } = db;
  let running = null;
  let scanAfter = 0;
  const operation = new AsyncLocalStorage();
  const cached=(key,fn)=>{const store=operation.getStore();if(!store)return fn();if(!store.has(key))store.set(key,Promise.resolve().then(fn));return store.get(key);};
  const scoped=fn=>(...args)=>operation.run(new Map(),()=>fn(...args));
  const supported = !!(Notice && Notification && Usuario && UsuarioClinica);
  async function permitted(userId, clinicId) {
    return cached(`permission:${userId}:${clinicId}`,async()=>{
    const user = await Usuario.findByPk(userId, { attributes: ['id_usuario','nombre','apellidos','estado_cuenta'] });
    if (!user || user.estado_cuenta !== 'activo') return false;
    const checks = await Promise.all(['appointments.view','patients.view','patients.sensitive.view'].map(featureKey => canAccess({ actorId: Number(userId), clinicId: Number(clinicId), featureKey })));
    return checks.every(Boolean);});
  }
  async function clinic(clinicId) { return db.Clinica.findOne({ where: { id_clinica: clinicId }, attributes: ['id_clinica','configuracion'] }); }
  async function timezone(clinicId) { return cached(`timezone:${clinicId}`,async()=>opening.resolveClinicTimeZone(await clinic(clinicId))); }
  async function dueAt(row) { return row.contact_due_date ? opening.localDateTimeToUtc(String(row.contact_due_date), '09:00', await timezone(row.clinic_id)) : null; }
  async function members(clinicId) {
    return cached(`members:${clinicId}`,async()=>{
    const rows = await UsuarioClinica.findAll({ where: { id_clinica: clinicId, [Op.or]: [{ estado_invitacion: 'aceptada' },{ estado_invitacion: null }] }, raw: true });
    const out = [];
    for (const row of rows) if (await permitted(row.id_usuario,clinicId)) out.push(row);
    if(db.PatientDirectionSetting && db.PatientDirectionProfile){
      const setting=await db.PatientDirectionSetting.findOne({where:{clinic_id:clinicId,is_enabled:true},raw:true});
      if(setting?.director_user_id){const profile=await db.PatientDirectionProfile.findOne({where:{user_id:setting.director_user_id,is_active:true},raw:true});
        if(profile && await permitted(profile.user_id,clinicId))out.push({id_usuario:Number(profile.user_id),id_clinica:clinicId,_role_id:6});}
    }
    return out;});
  }
  function roleId(row) {
    return row._role_id || ROLES.find(role => role.code === require('../lib/access-policy').roleCodeFromMembership(row))?.id || null;
  }
  async function recipients(row) {
    return cached(`recipients:${row.id}:${row.clinic_id}:${row.created_by}:${row.recipient_mode}:${JSON.stringify(row.recipient_role_ids)}`,async()=>{
    if ((row.recipient_mode || 'creator') === 'creator') return row.created_by && await permitted(row.created_by,row.clinic_id) ? [Number(row.created_by)] : [];
    const rows = await members(row.clinic_id);
    return [...new Set(rows.filter(member => row.recipient_mode === 'team' || (row.recipient_role_ids || []).includes(roleId(member))).map(m => Number(m.id_usuario)))];});
  }
  async function eventPreference(userId,clinicId){
    if(!db.NotificationPreference)return true;
    return cached(`event-preference:${userId}:${clinicId}`,async()=>{
      const membership=await UsuarioClinica.findOne({where:{id_usuario:userId,id_clinica:clinicId,[Op.or]:[{estado_invitacion:'aceptada'},{estado_invitacion:null}]},raw:true});
      const admin=require('../lib/role-helpers').isGlobalAdmin(userId);
      const pref=await db.NotificationPreference.findOne({where:{event:'clinical.follow_up_due',role:admin?'admin':membership?.rol_clinica||'personaldeclinica',subrole:admin?'':membership?.subrol_clinica||''},raw:true});
      return !pref || !!pref.enabled;
    });
  }
  async function patientVisible(row) {
    const patient = await db.Paciente.findOne({ where: { id_paciente: row.patient_id }, attributes: ['id_paciente','clinica_id','nombre','apellidos','public_id'] });
    if (!patient) return null;
    return Number(patient.clinica_id) === Number(row.clinic_id) || await db.PacienteClinica.findOne({ where: { paciente_id: row.patient_id, clinica_id: row.clinic_id }, attributes: ['id'] }) ? patient : null;
  }
  async function recipientOptions(clinicId,actorId) {
    const rows = await members(clinicId);
    const user = await Usuario.findByPk(actorId, { attributes: ['id_usuario','nombre','apellidos'] });
    return { roles: ROLES.filter(role => rows.some(row => roleId(row) === role.id)).map(({id,name}) => ({id,name})),
      creator: { id: actorId, name: name(user) }, current_user: { id: actorId, name: name(user) },
      team: { label: 'Equipo de la sede', eligible_count: new Set(rows.map(row=>Number(row.id_usuario))).size }, default_mode: 'creator', timezone: await timezone(clinicId) };
  }
  async function validateRecipients(values,clinicId) {
    if (values.recipient_mode !== 'roles') return;
    const ids = (await recipientOptions(clinicId,0)).roles.map(role => role.id);
    if (!values.recipient_role_ids?.length || values.recipient_role_ids.some(id => !ids.includes(id))) throw domainError(400,'follow_up_recipient_role_unavailable','Algún rol no tiene destinatarios activos con permisos en esta sede.');
  }
  async function canReadNotification(notification,userId) {
    const data = notification?.data;
    if (data?.kind !== KIND) return true;
    if (Number(notification.userId ?? notification.user_id) !== Number(userId)) return false;
    const row = await FollowUp.findOne({ where: { public_id: data.follow_up_id, clinic_id: data.clinic_id } });
    return !!row && Number(row.patient_id) === Number(data.patient_id) && await permitted(userId,row.clinic_id)
      && !!await patientVisible(row) && (await recipients(row)).includes(Number(userId));
  }
  async function notificationVisibilityWhere(userId) {
    // Derive policy from the authenticated user's own notification scopes, never
    // from an arbitrary requested clinic. Apply it in SQL before count/paging.
    const scopes=await Notification.findAll({where:{userId},attributes:['clinicaId'],group:['clinicaId'],raw:true});
    const clauses=[];
    for(const value of scopes){const id=Number(value.clinicaId);if(!Number.isSafeInteger(id)||id<1||!await permitted(userId,id))continue;
      const own=(await members(id)).filter(member=>Number(member.id_usuario)===Number(userId));
      const ids=[...new Set(own.map(roleId).filter(Boolean))];
      const recipient=`(COALESCE(f.recipient_mode,'creator')='creator' AND f.created_by=${Number(userId)})${own.length?` OR f.recipient_mode='team'${ids.length?` OR (f.recipient_mode='roles' AND (${ids.map(role=>`JSON_CONTAINS(f.recipient_role_ids,'${role}')`).join(' OR ')}))`:''}`:''}`;
      clauses.push(`(f.clinic_id=${id} AND (${recipient}))`);
    }
    const ordinary="COALESCE(JSON_UNQUOTE(JSON_EXTRACT(data,'$.kind')),'')<>'patient_follow_up_reminder'";
    if(!clauses.length)return db.sequelize.literal(ordinary);
    return db.sequelize.literal(`(${ordinary} OR EXISTS(SELECT 1 FROM PatientFollowUps f JOIN Pacientes p ON p.id_paciente=f.patient_id WHERE f.public_id=JSON_UNQUOTE(JSON_EXTRACT(data,'$.follow_up_id')) AND f.clinic_id=Notification.clinica_id AND f.clinic_id=CAST(JSON_UNQUOTE(JSON_EXTRACT(data,'$.clinic_id')) AS UNSIGNED) AND f.patient_id=CAST(JSON_UNQUOTE(JSON_EXTRACT(data,'$.patient_id')) AS UNSIGNED) AND (p.clinica_id=f.clinic_id OR EXISTS(SELECT 1 FROM PacienteClinicas pc WHERE pc.paciente_id=p.id_paciente AND pc.clinica_id=f.clinic_id)) AND (${clauses.join(' OR ')})))`);
  }
  async function emitSafe(notification) {
    const userId = notification.userId ?? notification.user_id;
    const latest=await Notification.findByPk(notification.id).catch(()=>null);
    let allowed=false;
    try{allowed=!!latest && Number(latest.userId)===Number(userId) && await operation.run(new Map(),()=>canReadNotification(latest,userId));}catch{/* Uncertain access never projects clinical content. */}
    try{emit(allowed?latest:{id:notification.id,userId,isRead:true,title:'',message:'',data:{accessRevoked:true}});}
    catch(error){console.warn('[follow-up notices] realtime deferred',error.code||error.name);}
  }
  async function state(row,userId,transaction) {
    if (!supported || !userId) return null;
    const recipient = (await recipients(row)).includes(Number(userId));
    if (!recipient) return null;
    const notice = await Notice.findOne({ where: { follow_up_id: row.id, user_id: userId }, transaction });
    const deliveryEnabled=await eventPreference(userId,row.clinic_id);
    const due = deliveryEnabled && row.notice_enabled && active(row) && notice?.enabled !== false && notice?.enabled !== 0 ? await dueAt(row) : null;
    const snoozed = notice?.snoozed_until ? new Date(notice.snoozed_until) : null;
    return { enabled: !!row.notice_enabled && (notice ? !!notice.enabled : true), delivery_enabled:deliveryEnabled,snoozed_until: snoozed?.toISOString() || null,
      next_notice_at: due ? new Date(Math.max(due.getTime(),snoozed?.getTime() || 0)).toISOString() : null,
      notification_id: notice?.notification_id ? String(notice.notification_id) : null };
  }
  async function decorate(rows,items,actorId) {
    if (!supported) return items;
    const creators = [...new Set(rows.map(row=>row.created_by).filter(Boolean))];
    const users = creators.length ? await Usuario.findAll({ where: { id_usuario: { [Op.in]: creators } }, attributes: ['id_usuario','nombre','apellidos'] }) : [];
    const names = new Map(users.map(user=>[Number(user.id_usuario),name(user)]));
    return Promise.all(items.map(async(item,index)=>({ ...item,
      creator_name: names.get(Number(rows[index].created_by)) || null,
      recipient_summary: item.recipient_mode === 'team' ? 'Equipo de la sede' : item.recipient_mode === 'roles'
        ? (item.recipient_role_ids || []).map(id=>ROLES.find(role=>role.id===id)?.name).filter(Boolean).join(', ') : names.get(Number(rows[index].created_by)) || 'Creador',
      my_notice_state: await state(rows[index],actorId) })));
  }
  async function settleNotifications(row,transaction) {
    if (!supported) return;
    const notices = await Notice.findAll({ where: { follow_up_id: row.id }, transaction });
    for (const notice of notices) if (notice.notification_id) {
      const notification = await Notification.findByPk(notice.notification_id,{ transaction });
      if (notification && (!notification.isRead || notification.data?.reminder_active!==false)) {
        await notification.update({ isRead: true, readAt: now(), data: { ...notification.data, reminder_resolved: true,reminder_active:false } },{ transaction });
        transaction.afterCommit?.(()=>emitSafe(notification));
      }
    }
  }
  async function reconcileOne(id) {
    if (!supported) return;
    const issued = [];
    await db.sequelize.transaction(async transaction => {
      const row = await FollowUp.findByPk(id,{ transaction,lock: transaction.LOCK.UPDATE });
      if (!row) return;
      if(!row.notice_enabled){await settleNotifications(row,transaction);return;}
      // A cancelled/missed linked booking remains a real historical link; reopen
      // management without inventing a fresh clinical/contact date.
      if (row.status === 'scheduled' && row.linked_appointment_id) {
        const appt = await db.CitaPaciente.findOne({ where: { id_cita: row.linked_appointment_id,clinica_id: row.clinic_id,paciente_id: row.patient_id },transaction });
        if (!appt || ['cancelada','no_asistio'].includes(appt.estado)) {
          await row.update({ status: 'pending',linked_appointment_id: null,notice_cycle: (row.notice_cycle || 1)+1,version_number: row.version_number+1 },{transaction});
          await db.PatientFollowUpRevision.create({follow_up_id:row.id,version_number:row.version_number,actor_id:null,change_type:'booking_needs_review',snapshot:plain(row),created_at:now()},{transaction});
        }
      }
      const allowed = await recipients(row);
      const patient = await patientVisible(row);
      const due = patient && active(row) ? await dueAt(row) : null;
      const existing = await Notice.findAll({ where: { follow_up_id: row.id },transaction });
      for (const userId of allowed) if (!existing.some(n=>Number(n.user_id)===userId)) existing.push(await Notice.create({ follow_up_id:row.id,user_id:userId,cycle:row.notice_cycle||1,enabled:true },{transaction}));
      for (const notice of existing) {
        let notification = notice.notification_id ? await Notification.findByPk(notice.notification_id,{transaction}) : null;
        const deliveryEnabled=await eventPreference(notice.user_id,row.clinic_id);
        const next = deliveryEnabled && patient && due && active(row) && allowed.includes(Number(notice.user_id)) && !!notice.enabled
          ? new Date(Math.max(due.getTime(),notice.snoozed_until ? new Date(notice.snoozed_until).getTime() : 0)) : null;
        if((notice.next_notice_at ? new Date(notice.next_notice_at).getTime() : null)!==(next?.getTime()??null)) await notice.update({next_notice_at:next},{transaction});
        const eligible = deliveryEnabled && patient && due && due <= now() && active(row) && allowed.includes(Number(notice.user_id)) && !!notice.enabled
          && (!notice.snoozed_until || new Date(notice.snoozed_until)<=now());
        if (!eligible) {
          if (notification && (!notification.isRead || notification.data?.reminder_active!==false)) { await notification.update({isRead:true,readAt:now(),data:{...notification.data,reminder_active:false}},{transaction});issued.push(notification); }
          continue;
        }
        const cycle = Number(row.notice_cycle || 1);
        const data = {kind:KIND,follow_up_id:row.public_id,clinic_id:Number(row.clinic_id),patient_id:Number(row.patient_id),
          displayMode:'persistent_alert',requiresAcknowledgement:true,reminder_active:true,contentFormat:'text',
          link:`/recordatorios?clinica_id=${row.clinic_id}&reminder=${row.public_id}`,useRouter:true};
        const values={ userId:notice.user_id,clinicaId:row.clinic_id,event:'clinical.follow_up_due',category:'clinical',title:'Recordatorio de próxima cita',
          message:`${name(patient)} · ${row.operational_reason}`,icon:'heroicons_outline:calendar-days',level:'info',data,isRead:false,readAt:null };
        if (!notification || Number(notice.cycle)!==cycle) {
          if (notification && (!notification.isRead || notification.data?.reminder_active!==false)) {await notification.update({isRead:true,readAt:now(),data:{...notification.data,reminder_active:false}},{transaction});issued.push(notification);}
          const key=`patient-follow-up:${row.id}:user:${notice.user_id}:cycle:${cycle}`;
          notification = await Notification.findOne({where:{dedupeKey:key},transaction}) || await Notification.create({...values,dedupeKey:key},{transaction});
          await notice.update({notification_id:notification.id,cycle,last_issued_at:now()},{transaction});issued.push(notification);
        } else if (!isDeepStrictEqual(notification.data,data) || notification.message!==values.message) {
          await notification.update(values,{transaction});await notice.update({last_issued_at:now()},{transaction});issued.push(notification);
        }
      }
      transaction.afterCommit?.(async()=>{for(const n of issued)await emitSafe(n);});
    });
  }
  async function action({id,clinicId,actorId,action}) {
    if (!['snooze_tomorrow','disable','enable'].includes(action)) throw domainError(400,'follow_up_notice_invalid_action','Acción de aviso no válida.');
    let current;
    await db.sequelize.transaction(async transaction=>{
      const row=await FollowUp.findOne({where:{public_id:id,clinic_id:clinicId},transaction,lock:transaction.LOCK.UPDATE});
      if(!row||!await patientVisible(row)||!(await recipients(row)).includes(Number(actorId)))throw domainError(403,'follow_up_notice_forbidden','Este aviso no está dirigido a ti o ya no tienes acceso.');
      const notice=await Notice.findOne({where:{follow_up_id:row.id,user_id:actorId},transaction})||await Notice.create({follow_up_id:row.id,user_id:actorId,enabled:true,cycle:row.notice_cycle||1},{transaction});
      if(action==='enable'&&!row.notice_enabled){await row.update({notice_enabled:true,version_number:row.version_number+1},{transaction});await db.PatientFollowUpRevision.create({follow_up_id:row.id,version_number:row.version_number,actor_id:actorId,change_type:'notices_enabled',snapshot:plain(row),created_at:now()},{transaction});}
      const patch=action==='disable'?{enabled:false}:action==='enable'?{enabled:true,snoozed_until:null}
        :{snoozed_until:opening.localDateTimeToUtc(addDays(localDay(now(),await timezone(clinicId)),1),'09:00',await timezone(clinicId))};
      await notice.update(patch,{transaction});
      current={rowId:row.id,notificationId:notice.notification_id};
    });
    await reconcileOne(current.rowId);
    const row=await FollowUp.findByPk(current.rowId);
    const notice=await Notice.findOne({where:{follow_up_id:row.id,user_id:actorId}});
    return {notice_state:await state(row,actorId),notification:notice?.notification_id?await Notification.findByPk(notice.notification_id):null};
  }
  async function tick() {
    if(!supported)return {checked:0};
    if(running)return running;
    running=(async()=>{
      // Keyset batches bound memory and avoid starving later due records on restart.
      let checked=0;const deadline=Date.now()+5000;
      const scan=()=>FollowUp.findAll({where:{id:{[Op.gt]:scanAfter},notice_enabled:true,status:{[Op.in]:['pending','contacted','scheduled']}},attributes:['id'],order:[['id','ASC']],limit:100});
      let rows=await scan();
      if(!rows.length && scanAfter){scanAfter=0;rows=await scan();}
      for(const row of rows){await reconcileOne(row.id);checked++;scanAfter=Number(row.id);if(Date.now()>=deadline)break;}
      return {checked};
    })().finally(()=>{running=null;});return running;
  }
  return {supported,permitted:scoped(permitted),recipients:scoped(recipients),recipientOptions:scoped(recipientOptions),validateRecipients:scoped(validateRecipients),canReadNotification:scoped(canReadNotification),notificationVisibilityWhere:scoped(notificationVisibilityWhere),state:scoped(state),decorate:scoped(decorate),settleNotifications,reconcileOne:scoped(reconcileOne),action:scoped(action),tick:scoped(tick),dueAt,emitSafe};
}
let service;
const current=()=>service ||= createPatientFollowUpNoticeService({db:require('../../models')});
module.exports={createPatientFollowUpNoticeService,current,KIND,ROLES,localDay};
