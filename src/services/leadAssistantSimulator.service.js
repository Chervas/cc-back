'use strict';

const { randomUUID, createHash } = require('node:crypto');
const dialogue = require('./leadAssistantDialogue.service');
const { commercialOffer } = require('./leadAssistantTurn.service');
const { offerSections } = require('./leadAssistantPromotionImages.service');
const { assistantCommercialText, explicitOptOut } = require('./socialLeadInterestClassification.service');
const { processTurn } = require('./leadAssistantBooking.service');
const { restrictionReply } = require('../lib/lead-assistant-promotion-validity');
const { resolveClinicTimezone } = require('../lib/availability-calendar');

const ttl = 30 * 60 * 1000;
const fail = (status, error) => Object.assign(new Error(error), { status, code:error });
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;

function create({ db, analyze, recipients, booking = processTurn, now = Date.now }) {
  const sessions = new Map();
  function sweep() {
    for (const [id, s] of sessions) if (!s.busy && s.until <= now()) sessions.delete(id);
  }
  const expiryTimer = setInterval(sweep, ttl / 6);
  expiryTimer.unref();

  async function start(clinicId, actorId) {
    const [draft, clinic, published] = await Promise.all([
      db.LeadAssistantDraft.findByPk(clinicId, {attributes:['version','fields'],raw:true}),
      db.Clinica.findByPk(clinicId, {attributes:['id_clinica','nombre_clinica','grupoClinicaId','configuracion'],raw:true}),
      db.LeadAssistantPublication.findOne({where:{clinic_id:clinicId},attributes:['version'],order:[['version','DESC']],raw:true}),
    ]);
    if (!clinic) throw fail(404,'clinic_not_found');
    if (!draft || !['tone','context','guardrails','booking'].every(k=>draft.fields?.[k]?.trim()))
      throw fail(409,'assistant_simulator_incomplete');
    sweep();
    const mine = [...sessions.entries()].filter(([,s])=>s.actorId === actorId);
    if (mine.length >= 6) {
      const idle = mine.find(([,s])=>!s.busy);
      if (!idle) throw fail(429,'assistant_simulator_limit');
      sessions.delete(idle[0]);
    }
    if (sessions.size >= 500) throw fail(429,'assistant_simulator_limit');
    const id = randomUUID();
    sessions.set(id, { clinicId, actorId, version:draft.version, clinicName:clinic.nombre_clinica,
      groupId:clinic.grupoClinicaId, timezone:resolveClinicTimezone(clinic), until:now()+ttl,
      calendar:null, count:0, receipts:new Map(), history:[], booking:null, promotionKey:null, origin:null, closed:false, busy:false });
    const promotions = [...offerSections(draft.fields.promotions)].map(([key,p])=>({key,title:p.title.split('\n')[0].slice(0,180)}));
    return { id, clinicName:clinic.nombre_clinica, version:draft.version, approved:published?.version === draft.version, promotions };
  }

  async function respond(s, fields, message, promotion, index) {
    const firstTurn = index === 1;
    const format = draft => dialogue.formatCommercialReply({ firstTurn, clinicName:s.clinicName,tone:fields.tone,draft });
    if (explicitOptOut(message)) return { reply:format('De acuerdo, dejamos aquí la conversación.'), event:'opt_out' };
    const human = dialogue.requestedHumanHandoff(message);
    async function passToTeam(preface) {
      const { destination } = await recipients(db, s.clinicId);
      const text = destination === 'unassigned' ? 'Esta consulta necesita atención del equipo. Puedes contactar con la recepción de la clínica.'
        : dialogue.formatHandoffReceipt({firstTurn:false, recorded:true, destination, requestedCallback:!!human?.requestedCallback});
      return {reply:format([preface,text].filter(Boolean).join(' ')), event:'handoff'};
    }
    if (human) return passToTeam();
    const entry = {channel:'instagram',type:'dm',text:message,messageId:index,
      ...(firstTurn && promotion ? {ad:{title:promotion}} : {})};
    const offer = commercialOffer(fields, entry, s.promotionKey, { timezone:s.timezone, includeUnavailable:true });
    if (offer && s.promotionKey && s.promotionKey !== offer.key) { s.history = []; s.booking = null; }
    s.promotionKey = offer?.key || null;
    const userText = assistantCommercialText(message);
    if (!offer?.restriction) {
      let appointment;
      try {
        appointment = await booking({db, thread:{clinic_id:s.clinicId,channel:'instagram',patient_id:null},
          entry:!s.booking && dialogue.acceptsOfferedTimes(message,s.history.at(-1)?.text) ? {...entry,text:'Quiero consultar horarios'} : entry, scope:{originMessageId:1,messageId:index,version:s.version}, execution:{created_by:s.actorId},
          fields,offer, preview:s, blockReason:async()=>null, availability:async()=>true});
      } catch (error) {
        if (![400,404,409,422].includes(error.status || error.statusCode) ||
            !/^(?:booking_|treatment_|appointment_)/.test(error.code || '')) throw error;
        appointment = {review:true};
      }
      if (appointment?.reply) {
        const options = s.booking?.stage === 'offered' ? s.booking.slots.map((slot,i)=>({
          label:require('./leadAssistantCalendar.service').display(slot,s.timezone),
          message:['La primera','La segunda','La tercera'][i],
        })) : [];
        return {reply:format(appointment.reply),event:s.booking?.stage==='booked' ? 'booked' : 'reply', ...(options.length ? {slots:options} : {})};
      }
      if (appointment?.review || appointment?.stop) return passToTeam();
    }
    if (!userText) return passToTeam();
    if (offer?.restriction) {
      const result = restrictionReply(offer.restriction, message);
      return result.handoff ? passToTeam(result.text) : {reply:format(result.text),event:'reply'};
    }
    const answer = await dialogue.generateAnswer({fields,clinicName:s.clinicName,timezone:s.timezone,offer,userText,
      readHistory:async()=>s.history, analyze,clinicId:s.clinicId,groupId:s.groupId,
      beforeDispatch:async()=>{
        if (s.until <= now()) throw fail(410,'assistant_simulator_expired');
      }});
    if (!answer) return passToTeam();
    s.history = [...s.history,{role:'user',text:userText},{role:'assistant',text:answer.reply}].slice(-12);
    const image = offer?.images.find(img=>img.id === answer.imageId);
    return {reply:format(answer.reply),event:'reply',...(image ? {image:{label:image.label,url:image.url}} : {})};
  }

  async function turn(clinicId, actorId, sessionId, input) {
    const { id, message, promotion, calendar = 'clinic' } = input || {};
    if (typeof id !== 'string' || !uuid.test(id) || typeof message !== 'string' || !message.trim() || message.length > 1000 ||
        typeof promotion !== 'string' || promotion.length > 96 || !['demo','clinic'].includes(calendar))
      throw fail(400,'assistant_simulator_invalid');
    const s = sessions.get(sessionId);
    if (!s || s.clinicId !== clinicId || s.actorId !== actorId || s.until <= now()) throw fail(410,'assistant_simulator_expired');
    const fingerprint = createHash('sha256').update(JSON.stringify([message,promotion,calendar])).digest('hex');
    const previous = s.receipts.get(id);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw fail(409,'assistant_simulator_invalid');
      return previous.result;
    }
    if (s.closed || s.count >= 30) throw fail(409,'assistant_simulator_limit');
    if (s.busy) throw fail(409,'assistant_simulator_busy');
    s.busy = true;
    try {
      const draft = await db.LeadAssistantDraft.findByPk(clinicId,{attributes:['version','fields'],raw:true});
      if (draft?.version !== s.version) throw fail(409,'assistant_simulator_changed');
      if ((s.count && (promotion !== s.origin || calendar !== s.calendar)) || (!s.count && promotion && !offerSections(draft.fields.promotions).has(promotion)))
        throw fail(400,'assistant_simulator_invalid');
      // Commit only completed turns, so a failed model/availability call leaves the conversation retryable.
      const next = {...s,calendar};
      const result = await respond(next, draft.fields, message.trim(), promotion, s.count+1);
      Object.assign(s, {history:next.history,booking:next.booking,promotionKey:next.promotionKey,origin:promotion,calendar,
        count:s.count+1,closed:result.event!=='reply',until:now()+ttl});
      s.receipts.set(id,{fingerprint,result});
      return result;
    } finally { s.busy = false; }
  }
  return {start,turn};
}

let instance;
function current() {
  return instance ||= create({db:require('../../models'), analyze:require('./aiOrchestrator.service').analyzeStructured,
    recipients:require('./leadAssistantHandoff.service').recipients});
}
module.exports = {create,current};
