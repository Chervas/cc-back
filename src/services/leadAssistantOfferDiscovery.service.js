'use strict';

const { normalize } = require('./leadAssistantCalendar.service');
const { areaIn } = require('./leadAssistantConversationPolicy.service');
const { offerSections, isOfferActive } = require('./leadAssistantPromotionImages.service');

const promotion = /\b(?:promos?|promocion\w*|ofertas?|descuentos?)\b/;
const browsing = /\b(?:que (?:tienes|teneis|hay|ofreceis)|cuales (?:hay|teneis)|que opciones|ver (?:las |el )?(?:opciones|catalogo)|ensename (?:las|los)|que me podeis ofrecer)\b/;
const reference = /^(?:(?:pues|pero|si) )?(?:de lo que (?:hemos dicho|hablabamos)|l[oa] de (?:antes|la que hablamos)|la que (?:hemos dicho|te dije)|te pregunto|esa misma|eso mismo)$/;
const tariff = /\b(?:precios?|tarifas?|cuanto (?:vale|cuesta|es|sale)|(?:cuesta|vale) (?:algo|dinero)|tiene (?:un )?coste|es gratis|es gratuita)\b/;
const filler = /\b(?:rellenos?|hialuronico)\b/;
const facial = /\b(?:rostro|facial|cara|labios?|ojos?|ojeras?|periocular|cejas?|nariz|pomulos?)\b/;
const appointmentInvitation = ' ¿Quieres que mire horarios para una valoración?';

function words(value) {
  return normalize(value).replace(/\b(?:promso|pormos|prmos|prmo)\b/g, 'promos');
}

function matchesArea(section, area) {
  if (!area) return true;
  const title = normalize(section.title);
  return area.name === 'rostro' ? facial.test(title) : area.words.test(title);
}

function browsesWholeArea(message, area) {
  const text = words(message);
  return area?.name === 'rostro' && (promotion.test(text) || browsing.test(text)) &&
    !/\b(?:polinucleotid\w*|higiene|relleno|indiba|neuromodulador\w*)\b/.test(text);
}

function activeInArea(sections, area, options) {
  return [...sections].filter(([, section]) => matchesArea(section, area) && isOfferActive(section, options));
}

function areaSelection(sections, entry, options) {
  const text = words(entry.text);
  const area = areaIn(text);
  if (!area || area.name === 'rostro' || /\b(?:reducir|papada|volumen|grasa|alerg\w*|dolor|despues|no quiero|no me interesa)\b/.test(text)) return null;
  if (!(promotion.test(text) || text.split(' ').length <= 4 || /\b(?:algo para|me interesan?|opciones para|sobre todo|(?:info|informacion) (?:de|sobre|para)|para (?:la zona|debajo|el contorno))\b/.test(text))) return null;
  const matches = activeInArea(sections, area, options).filter(([, section]) =>
    !filler.test(text) || filler.test(words(section.title)));
  return matches.length === 1 ? matches[0][0] : null;
}

function currentPrice(lines) {
  const priced = (lines || []).map(line => line.replace(/\*\*/g, '').trim()).find(line =>
    /\d\s*(?:€|euros?|\$|£)/i.test(line) && !line.includes('http') &&
    !/^(?:antes|ahorro|descuento|vigencia|validez)\b/i.test(line));
  if (!priced) return null;
  const current = priced.replace(/\s*\b(?:antes|precio anterior)\s*[:\d].*$/iu, '')
    .replace(/^precio\s*:\s*/iu, '').replace(/[.\s]+$/, '').replace(/ · /g, ', ');
  return current && current.length <= 320 ? current : null;
}

// A comparison is usable only when it is an actual question and answer in this offer's guide.
function fillerComparison(offer) {
  const line = offer.guide?.split('\n').find(item => {
    const question = words(item.split('?')[0]);
    return /\b(?:por que|diferencia|compar)\w*\b/.test(question) && filler.test(question);
  });
  const answer = line?.match(/[?]»?\s*(?:\*\*)?\s*[«“"]([^»”"\n]+)[»”"]/u)?.[1];
  return answer && answer.length <= 550 ? answer.split(/(?<=[.!?])\s+/u).slice(0, 2).join(' ') : null;
}

function priceWhenDeferring(offer, message) {
  const text = words(message);
  const parts = String(message).split(/[,;.!?¿¡]/u).map(words).filter(Boolean);
  const requestsPrice = parts.some(part => /^(?:(?:solo |solamente )?(?:quiero|queria|necesito)(?: saber)? (?:el |su )?(?:precio|tarifa)(?: de (?:esa|esta|la) (?:promocion|oferta))?|cuanto (?:cuesta|vale|sale)(?: (?:esa|esta|la) (?:promocion|oferta))?)$/.test(part));
  if (!offer || !requestsPrice || /\b(?:habitual|normal|sin (?:oferta|descuento)|consulta|valoracion|financiacion|anestesia)\b/.test(text)) return '';
  const price = currentPrice(offer.terms);
  return price ? 'El precio de «' + offer.title + '» es ' + price + '.' : '';
}

function consultationFee(fields, userText) {
  const text = words(userText);
  if (!tariff.test(text) || !/\b(?:valoracion|consulta|primera visita)\b/.test(text)) return null;
  const free = (fields.booking || '').split('\n').some(line => {
    const fee = words(line.replace(/^\s*si te preguntan[^,]*,\s*/iu, '').split(/,\s*los tratamientos/iu)[0]);
    return /\b(?:valoracion|consulta)\b/.test(fee) &&
      /\b(?:es gratis|es gratuita|sin coste|no (?:tiene (?:ningun )?coste|tiene costo|lo tiene))\b/.test(fee) &&
      !/\b(?:hasta|excepto|salvo|solo|unicamente|cirujano|segun|siempre que|no es|cuando|depende|si)\b/.test(fee);
  });
  return free ? 'La valoración es gratuita. El tratamiento se paga aparte.' : null;
}

function catalogueReply({ fields, offer, history, userText, timezone }) {
  const text = words(userText);
  const area = areaIn(text);
  const contextArea = area || history.filter(m => m.role === 'user').map(m => areaIn(m.text)).filter(Boolean).at(-1);
  const quotedDeal = /[€$£]|\beuros?\b/i.test(userText) && /\b(?:me lo dejas|me lo dejais|me lo igualas|me cobrais|me valen? (?:tambien|para)|(?:vale|valen|sirve|sirven|se aplica|se aplican) tambien para|tambien (?:vale|valen|sirve|sirven) para|pag[oó] mi|mi amiga pago)\b/.test(text);
  const pricing = tariff.test(text) || quotedDeal;
  if (pricing && /\b(?:valoracion|consulta|primera visita)\b/.test(text)) return null;
  const asksOffer = promotion.test(text);
  const asksFiller = filler.test(text);
  const previous = history.filter(m => m.role === 'assistant').at(-1)?.text || '';
  if ((asksOffer || browsing.test(text) || (asksFiller && pricing)) &&
      (!offer || (asksFiller && !filler.test(words(offer.title)))) && !/\b(?:anuncio|publicacion|reel)\b/.test(text)) {
    const entries = activeInArea(offerSections(fields.promotions), contextArea, { timezone }).map(([, section]) => section);
    if (asksFiller) {
      const fillers = entries.filter(section => filler.test(words(section.title)));
      if (fillers.length === 1) {
        const price = currentPrice(fillers[0].lines);
        return 'En el catálogo figura «' + fillers[0].title + '»' + (price ? ' por ' + price : ', sin precio publicado') + '.';
      }
      if (!fillers.length) {
        const alternative = entries.length === 1 ? entries[0] : null;
        return 'No encuentro un precio promocional de relleno' + (contextArea ? ' para ' + contextArea.label : '') +
          '.' + (alternative ? ' La promoción de esta zona es «' + alternative.title + '».' : '');
      }
      return 'Hay varias promociones de relleno. ¿Cuál te interesa? ' + fillers.map(s => s.title).join(', ') + '.';
    }
    if (!entries.length) return contextArea ? 'No encuentro una promoción vigente para ' + contextArea.label + '.' : 'No veo promociones vigentes en el catálogo de la clínica.';
    const names = entries.slice(0, 5).map(s => s.title.split(' · ')[0]);
    if (names.length > 1 && previous.includes(names[0]) && browsing.test(text))
      return 'Puedes elegir por zona. Tenemos ' + new Intl.ListFormat('es').format(names) + '. ¿Qué parte te interesa?';
    return (contextArea ? 'Para ' + contextArea.label + ' figuran ' : 'Entre las promociones vigentes están ') +
      new Intl.ListFormat('es').format(names) + '. ¿Cuál te gustaría ver?';
  }
  if (!offer) return null;
  const comparing = asksFiller || /\b(?:recomiendas de los dos|diferencia entre (?:los|las) dos)\b/.test(text);
  if (comparing && !filler.test(words(offer.title))) {
    const comparison = fillerComparison(offer);
    if (comparison) {
      if (/recomiend|de los dos|para mi/.test(text)) return comparison + appointmentInvitation;
      if (/me dijeron|creia|no (?:es|eran|son)|me has dicho/.test(text))
        return 'La clínica los distingue. Lo que está en promoción es «' + offer.title + '».';
      return 'La promoción es de ' + offer.title + '. La ficha habla del relleno como otra opción que se valora por separado.';
    }
  }
  const price = currentPrice(offer.terms);
  if (price && /\b(?:que incluye|que entra|en que consiste la (?:oferta|promocion))\b/.test(text) &&
      !/\b(?:valoracion|consulta|anestesia|revision|financiacion)\b/.test(text)) {
    const detail = price.split(/, (?=\d+ (?:sesi[oó]n(?:es)?|citas?|ml)\b)/i);
    if (detail.length > 1 && /[€£$]|euros?/i.test(detail[0]))
      return 'La oferta de «' + offer.title + '» incluye ' + detail.slice(1).join(', ') + ' por ' + detail[0] + '.';
  }
  const selecting = area && (text.split(' ').length <= 4 || /\b(?:algo para|me interesa)\b/.test(text));
  if (!price || !(asksOffer || pricing || selecting || reference.test(text)) ||
      /\b(?:fotos?|imagen\w*|contraindic\w*|duele|embaraz\w*|caduc\w*|otra zona|cuanto dura|financi\w*)\b/.test(text)) return null;
  if (pricing) return 'El precio de «' + offer.title + '» es ' + price + '.';
  if (reference.test(text) && previous.includes(offer.title))
    return 'La de «' + offer.title + '», por ' + price + '.' + appointmentInvitation;
  if (reference.test(text) || (asksOffer && previous.includes(offer.title)))
    return 'Sí, la que está en promoción es «' + offer.title + '». Son ' + price + '.' + appointmentInvitation;
  return 'Para esa zona está la promoción «' + offer.title + '». ' + price + '.' + (asksOffer ? appointmentInvitation : '');
}

module.exports = { areaSelection, browsesWholeArea, catalogueReply, consultationFee, matchesArea, priceWhenDeferring };
