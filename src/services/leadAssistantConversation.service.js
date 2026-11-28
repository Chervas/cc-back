'use strict';

const dialogue = require('./leadAssistantDialogue.service');
const discovery = require('./leadAssistantOfferDiscovery.service');
const clinicFacts = require('./leadAssistantClinicFacts.service');
const { areaIn } = require('./leadAssistantConversationPolicy.service');
const { catalog, offerSections, isOfferActive, clinicDate } = require('./leadAssistantPromotionImages.service');
const { assistantCommercialText, genericInfoRequest, explicitOptOut } = require('./socialLeadInterestClassification.service');
const { restrictionReply } = require('../lib/lead-assistant-promotion-validity');

// Meta may supply only a media ID for an advertisement. Two separate posts
// from the same account still share a QuickChat thread and a virtual assistant.
function postReference(entry) {
  if (entry?.type !== 'comment' && !entry?.ad) return null;
  const media = entry.postId || entry.ad?.originalMediaId;
  if (!media && !entry.ad?.id) return 'message:' + (entry.messageId || entry.eventId);
  return JSON.stringify([media || null, !!entry.ad, entry.ad?.id || null]);
}

function commercialOffer(fields, entry, priorKey, options) {
  options = { ...options, today: clinicDate(options) };
  const sections = offerSections(fields.promotions);
  const images = catalog(fields.promotions, options, sections);
  const explicit = String(entry.text || '').toUpperCase();
  const origin = [entry.post?.caption, entry.ad?.title, entry.postId].filter(Boolean).join(' ').toUpperCase();
  const matched = (text) =>
    [...sections.keys()].filter((key) => new RegExp('\\b' + key + '\\b', 'i').test(text));
  let matches = matched(explicit);
  if (!matches.length) matches = matched(origin);
  if (!matches.length) {
    const normalize = require('../lib/lead-assistant-tables').normalize;
    const titlesIn = (value) => [...sections].filter(([, item]) => {
      const title = normalize(item.title.split(' · ')[0]);
      return title && (' ' + normalize(value).replace(/[^a-z0-9]+/g, ' ') + ' ').includes(' ' + title.replace(/[^a-z0-9]+/g, ' ') + ' ');
    }).map(([key]) => key);
    matches = titlesIn(explicit);
    if (!matches.length) matches = titlesIn(origin);
  }
  if (!matches.length) {
    const words = (value) =>
      value
        .normalize('NFKD')
        .replace(/\p{M}/gu, '')
        .toLowerCase()
        .match(/[a-z0-9]+/g) || [];
    const meaningful = (value) =>
      words(value).filter(
        (word) =>
          (word.length > 2 || /^\d+$/.test(word)) &&
          ![
            'una',
            'del',
            'para',
            'con',
            'por',
            'promo',
            'promocion',
            'imagen',
            'foto',
            'cartel',
            'creatividad',
            'figma',
          ].includes(word)
      );
    const requested = meaningful(explicit + ' ' + origin);
    matches = [...sections]
      .filter(([code, lines]) => {
        const aliases = [lines.title.split('.')[0], ...(images.get(code) || []).map((image) => image.label)];
        return aliases.some((alias) => {
          const names = meaningful(alias);
          return (
            (names.length === 1 && requested.includes(names[0])) ||
            names.some(
              (word, i) =>
                i > 0 &&
                requested.some((part, j) => j > 0 && part === word && requested[j - 1] === names[i - 1])
            )
          );
        });
      })
      .map(([code]) => code);
  }
  const area = areaIn(entry.text);
  if (!postReference(entry) && discovery.browsesWholeArea(entry.text, area)) return null;
  const priorSection = sections.get(priorKey);
  // A specific enquiry can change the treatment even inside an ad's thread.
  if (discovery.asksFillerOffer(entry.text) && !matches.some(key=>discovery.isFillerOffer(sections.get(key)))) {
    const requestedArea=discovery.fillerArea(entry.text);
    const selected=requestedArea && [...sections].filter(([,s])=>discovery.isFillerOffer(s) && discovery.matchesArea(s,requestedArea));
    const priorArea = priorSection && discovery.fillerArea(priorSection.title);
    if (!requestedArea && priorArea && priorArea.name !== 'rostro' && !/promo|oferta|descuento/i.test(entry.text))
      matches=[priorKey];
    else if (selected?.length===1) matches=[selected[0][0]];
    else return null;
  }
  const named = discovery.namedTreatmentRequest(fields,entry.text);
  if (named && !discovery.asksFillerOffer(entry.text)) {
    const {normalize} = require('./leadAssistantCalendar.service');
    const name = ' '+normalize(named.name)+' ';
    const titled = [...sections].filter(([,section]) => (' '+normalize(section.title)+' ').includes(name));
    if (!titled.length) return null;
    if (titled.length===1) matches=[titled[0][0]];
  }
  const carry = priorSection && (!area || discovery.matchesArea(priorSection,area)) &&
    !clinicFacts.switchesPricedService(entry.text,priorSection.title);
  if (!matches.length && (!postReference(entry) || options?.samePublication)) {
    const picked = discovery.areaSelection(sections,entry,options);
    if (picked) matches = [picked];
  }
  const key = matches.length === 1 ? matches[0] : !matches.length && (!postReference(entry) || options?.samePublication) && carry ? priorKey : null;
  if (!key) return null;
  if (!isOfferActive(sections.get(key), options)) {
    const restriction = require('../lib/lead-assistant-promotion-validity').salesRestriction(sections.get(key).saleTerms,options.today);
    return options.includeUnavailable && restriction && isOfferActive({ ...sections.get(key), saleTerms:null }, options)
      ? { key, restriction, images:[] } : null;
  }
  const stripLinks = (line) =>
    line.replace(/!?\[([^\]\n]*)\]\(https?:\/\/[^\s()]+\)/gi, '$1').replace(/https?:\/\/\S+/gi, '');
  const section = sections.get(key);
  const body = [section.preamble, ...section.lines].filter(Boolean).map(stripLinks).join('\n').trim();
  if (!body) return null;
  return {
    key,
    title: sections.get(key).title.split(/[.\n]/)[0].slice(0, 180),
    description: body,
    terms: section.lines,
    ...(section.guide ? { guide: stripLinks(section.guide) } : {}),
    images: (images.get(key) || []).slice(0, 24),
  };
}

function exchangeContext(fields, entry, previous, timezone) {
  const currentPost = postReference(entry);
  const samePublication = !!currentPost && currentPost === previous?.postReference;
  const offer = commercialOffer(fields, entry, previous?.promotionKey, { timezone, samePublication, includeUnavailable:true });
  const changed = !!((currentPost && !samePublication) ||
    (previous?.promotionKey && offer?.key !== previous.promotionKey));
  return { offer, changed, post:currentPost || previous?.postReference };
}

// Decide one turn for a lead that has reached Cleo. Callers provide the conversation's
// version, its recent messages and its calendar. Delivery and recording a handoff happen afterwards.
async function respondToLead({
  entry, fields, clinicName, timezone, offer, firstTurn, previousAnswer, post, decisionKind,
  analyze, clinicId, groupId, beforeDispatch, readHistory, readClinicFact, book, checkWindow, cachedAnswer, saveAnswer,
}) {
  const raw = String(entry.text || '').trim();
  if (explicitOptOut(raw)) return { kind:'silent', reason:'opt_out' };
  const human = raw.length <= 1000 && raw ? dialogue.requestedHumanHandoff(raw,previousAnswer) : null;
  const userText = assistantCommercialText(raw);
  const identity = { firstTurn, clinicName, tone:fields.tone };
  const format = draft => dialogue.formatCommercialReply({ ...identity, draft });
  const handoff = (reason,routeFor) => ({
    kind:'handoff',
    prepare: route => route.recorded ? {
      text:dialogue.formatHandoffReceipt({ ...identity, recorded:true, destination:route.destination,
        requestedCallback:!!human?.requestedCallback }) + (routeFor ? ' El equipo te confirmará qué agenda corresponde a '+routeFor.toLocaleLowerCase('es')+'.' : '') + (human?.requestedCallback &&
          require('./leadAssistantConversationPolicy.service').sameVisit(raw)
          ? ' El equipo te podrá confirmar si es posible hacer el tratamiento en la misma visita.' : ''), reason, attention:false,
    } : {
      text:format('Esta consulta necesita atención del equipo. Puedes contactar con la recepción de la clínica.'),
      reason:'assistant_handoff_unassigned', attention:true,
    },
  });

  let recent;
  const history = () => recent ||= readHistory();
  const question = require('./leadAssistantCalendar.service').normalize(raw);
  if (!human && /^(?:con |solo )?(?:sus |las )?iniciales (?:me vale[n]?|son suficientes|me bastan)$/.test(question))
    return {kind:'reply',text:format('Las iniciales también pueden identificar a otra persona, así que tampoco las comparto.'),source:'rules',reason:'assistant_reply'};
  if (!human && /\b(?:nombre|telefono|datos|iniciales|quien)\b/.test(question) &&
      /\b(?:quien tiene la cita|paciente anterior|paciente siguiente|cita anterior a la mia|otra persona (?:de|en) la agenda)\b/.test(question))
    return {kind:'reply',text:format('Los datos de otras personas son privados. Puedo consultar las horas disponibles para tu propia cita.'),source:'rules',reason:'assistant_reply'};
  if (entry.type === 'dm' && !human && !offer?.restriction &&
      (require('./leadAssistantCalendar.service').asksSessionAppointment(raw) || clinicFacts.intent(raw) !== 'hours')) {
    let appointment;
    try {
      const bookingEntry = dialogue.acceptsOfferedTimes(raw, previousAnswer)
        ? { ...entry, text:'Quiero consultar horarios' } : entry;
      appointment = await book(bookingEntry,history);
    } catch (error) {
      if (![400,404,409,422].includes(error.status || error.statusCode) ||
          !/^(?:booking_|treatment_|appointment_)/.test(error.code || '')) throw error;
      appointment = {review:true};
    }
    if (appointment?.stop) return { kind:'silent', reason:appointment.stop };
    if (appointment?.reply) return { kind:'booking', text:format(appointment.reply), reason:'assistant_booking' };
    if (appointment?.review) return handoff('assistant_handoff_recorded',appointment.routeFor);
  }
  if (human || !userText || decisionKind === 'review') return handoff('assistant_handoff_recorded');
  if (!cachedAnswer) {
    const blocked = await checkWindow();
    if (blocked) return {kind:'silent', reason:blocked};
  }
  if (offer?.restriction) {
    const response = restrictionReply(offer.restriction, raw);
    const prepare = route => {
      const receipt = route?.recorded ? dialogue.formatHandoffReceipt({
        firstTurn:false, recorded:true, destination:route.destination,
      }) : '';
      return { text:format([response.text,receipt].filter(Boolean).join(' ')),
        reason:offer.restriction.reason, attention:response.handoff && !route?.recorded };
    };
    return response.handoff ? {kind:'handoff', prepare} : {kind:'reply', ...prepare(null)};
  }

  let answer = cachedAnswer;
  if (!answer) {
    const generated = await dialogue.generateAnswer({ fields, clinicName, timezone, offer, userText,
      askPromotion:!!(!offer && post && genericInfoRequest(raw)), analyze, clinicId, groupId, beforeDispatch, readHistory:history, readClinicFact });
    if (!generated) return handoff('assistant_reply_requires_review');
    answer = await saveAnswer(generated, userText);
  }
  const image = offer?.images.find(item => item.id === answer.imageId);
  let text = format(answer.reply);
  if (entry.type === 'comment' && image && text.length + image.url.length + 1 <= 1000) text += '\n' + image.url;
  return {kind:'reply', text, image, source:answer.source, reason:'assistant_reply'};
}

module.exports = { commercialOffer, exchangeContext, postReference, respondToLead };
