'use strict';

const { randomUUID, createHash } = require('node:crypto');
const { exchangeContext, respondToLead } = require('./leadAssistantConversation.service');
const { display } = require('./leadAssistantCalendar.service');
const { offerSections } = require('./leadAssistantPromotionImages.service');
const { processTurn } = require('./leadAssistantBooking.service');
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
      calendar:null, channel:null, count:0, receipts:new Map(), history:[], booking:null, context:null, contextStartId:1, origin:null, closed:false, busy:false });
    const promotions = [...offerSections(draft.fields.promotions)].map(([key,p])=>({key,title:p.title.split('\n')[0].slice(0,180)}));
    return { id, clinicName:clinic.nombre_clinica, version:draft.version, approved:published?.version === draft.version, promotions };
  }

  async function respond(s, fields, message, promotion, index) {
    const firstTurn = index === 1;
    const entry = {channel:s.channel,type:'dm',text:message,messageId:index,
      ...(firstTurn && promotion ? {ad:{title:promotion}} : {})};
    const { offer, changed, post } = exchangeContext(fields, entry, s.context, s.timezone);
    if (changed) {
      s.history = [];
      s.booking = null;
      s.contextStartId = index;
    }
    s.context = { promotionKey:offer?.key || null, postReference:post };
    let exchange = [];
    const plan = await respondToLead({
      entry, fields, clinicName:s.clinicName, timezone:s.timezone, offer, firstTurn, post,
      previousAnswer:s.history.at(-1)?.at(-1)?.text, analyze, clinicId:s.clinicId, groupId:s.groupId,
      beforeDispatch:async () => { if (s.until <= now()) throw fail(410,'assistant_simulator_expired'); },
      checkWindow:async () => null,
      readHistory:async () => s.history.flat(),
      saveAnswer:async (answer,userText) => {
        exchange = [{role:'user',text:userText}, {role:'assistant',text:answer.reply}];
        return answer;
      },
      book:bookingEntry => booking({
        db, thread:{clinic_id:s.clinicId,channel:s.channel,patient_id:null,
          contact_id:s.channel === 'whatsapp' ? '+447700900123' : null}, entry:bookingEntry,
        scope:{originMessageId:s.contextStartId,messageId:index,version:s.version,promotionKey:offer?.key},
        execution:{created_by:s.actorId}, fields, offer, preview:s,
        blockReason:async () => null, availability:async () => true,
      }),
    });
    s.history = [...s.history,exchange].slice(-6);
    if (plan.kind === 'silent') {
      if (plan.reason === 'opt_out') return { reply:'', event:'opt_out' };
      throw fail(409,'assistant_simulator_unavailable');
    }
    if (plan.kind === 'handoff') {
      const { destination } = await recipients(db, s.clinicId);
      return {reply:plan.prepare({destination,recorded:destination !== 'unassigned'}).text,event:'handoff'};
    }
    if (plan.kind === 'booking') {
      const options = s.booking?.stage === 'offered' ? s.booking.slots.map((slot,i)=>({
        label:display(slot,s.timezone), message:['La primera','La segunda','La tercera'][i],
      })) : [];
      return {reply:plan.text,event:s.booking?.stage==='booked' ? 'booked' : 'reply', ...(options.length ? {slots:options} : {})};
    }
    return {reply:plan.text,event:'reply', ...(plan.image ? {image:{label:plan.image.label,url:plan.image.url}} : {})};
  }

  async function turn(clinicId, actorId, sessionId, input) {
    const { id, message, promotion, calendar = 'clinic', channel = 'instagram' } = input || {};
    if (typeof id !== 'string' || !uuid.test(id) || typeof message !== 'string' || !message.trim() || message.length > 1000 ||
        typeof promotion !== 'string' || promotion.length > 96 || !['demo','clinic'].includes(calendar) ||
        !['instagram','messenger','whatsapp'].includes(channel))
      throw fail(400,'assistant_simulator_invalid');
    const s = sessions.get(sessionId);
    if (!s || s.clinicId !== clinicId || s.actorId !== actorId || s.until <= now()) throw fail(410,'assistant_simulator_expired');
    const fingerprint = createHash('sha256').update(JSON.stringify([message,promotion,calendar,channel])).digest('hex');
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
      if ((s.count && (promotion !== s.origin || calendar !== s.calendar || channel !== s.channel)) || (!s.count && promotion && !offerSections(draft.fields.promotions).has(promotion)))
        throw fail(400,'assistant_simulator_invalid');
      // Commit only completed turns, so a failed model/availability call leaves the conversation retryable.
      const next = {...s,calendar,channel};
      const result = await respond(next, draft.fields, message.trim(), promotion, s.count+1);
      Object.assign(s, {history:next.history,booking:next.booking,context:next.context,contextStartId:next.contextStartId,origin:promotion,calendar,channel,
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
