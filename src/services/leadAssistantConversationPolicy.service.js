'use strict';

const { normalize } = require('./leadAssistantCalendar.service');
const { offerSections, isOfferActive } = require('./leadAssistantPromotionImages.service');

// These labels retain the subject of an administrative or commercial enquiry.
// They are never diagnoses or authorisation to recommend a treatment.
const areas = [
  {name:'ojos',words:/\b(?:ojeras?|ojos?|periocular(?:es)?|parpados?)\b/,label:'el contorno de ojos'},
  {name:'cuello', words:/\b(?:cuello|papada|submenton\w*|doble menton|(?:bajo |debajo (?:de |del )?)(?:(?:el|la) )?(?:menton|barbilla))\b/, label:'el cuello'},
  {name:'abdomen',words:/\b(?:abdomen|barriga|abdominal)\b/,label:'el abdomen'},
  {name:'brazos',words:/\bbrazos?\b/,label:'los brazos'},
  {name:'muslos',words:/\bmuslos?\b/,label:'los muslos'},
  {name:'pecho',words:/\b(?:pecho|mamas?)\b/,label:'el pecho'},
  {name:'labios',words:/\blabios?\b/,label:'los labios'},
  {name:'cabello',words:/\b(?:capilar|cabello|pelo)\b/,label:'el cabello'},
  {name:'rostro',words:/\b(?:rostro|cara|facial)\b/,label:'el rostro'},
];

function areaIn(text) {
  const words = normalize(text);
  return areas.find(area => area.words.test(words));
}

const volume = /\b(?:volumen|grasa|papada|doble menton)\b/;
const alternative = /\b(?:otra cosa|algo (?:distinto|diferente)|que mas (?:haceis|ofreceis|teneis|pod[eé]is ofrecerme)|que posibilidades|otra(?:s)? (?:opcion|alternativa|promo|tecnica|oferta)|otras?|alternativas?|que (?:me )?(?:recomiend\w*|aconsej\w*)|recomendar\w*|recomend\w* tu|cual (?:va|es|viene|funciona) mejor|menos invasiv\w*|lo que (?:ya )?te he dicho|lo que te dije|para que sirve cada una)\b/;
const promoPrice = /\b(?:promos?|promocion\w*|ofertas?|cuanto (?:vale|cuesta)|precios?|descuentos?)\b/;
const unsupported = /\b(?:no (?:esta |se )?(?:indic\w*|recomiend\w*|aplic\w*|reduce)|sin indicacion|exclusivamente corporal)\b/;

function goal(history, current) {
  const utterances = [...history.filter(m => m.role === 'user').map(m => m.text),current];
  let area, reducing = false;
  for (const message of utterances) {
    const mentioned = areaIn(message);
    if (mentioned && mentioned !== area) { area = mentioned; reducing = false; }
    if (volume.test(normalize(message))) reducing = true;
  }
  return {area,reducing};
}

function unresolvedAd(userText) {
  const words = normalize(userText);
  if (/\b(?:anuncio|reel|publicacion|video|historia|instagram|facebook)\b/.test(words) &&
      /\b(?:no (?:me acuerdo|recuerdo|se cual)|(?:esa|la|el) que (?:me salio|vi|he visto)|(?:solo|solamente) vi (?:un|el|la))\b/.test(words)) return true;
  return /^(?:(?:si |pues )?(?:la|el|lo|esa|ese|eso) (?:de |del |de la |que (?:vi|he visto) (?:en )?))?(?:(?:el|la) )?(?:anuncio|publicacion|redes|instagram|facebook|historia|reel|video)(?: que (?:vi|me (?:salio|aparecio)))?$/.test(words);
}

function declines(userText) {
  return /\b(?:no mejor no|mejor no|no me interesa|dej(?:alo|emoslo)|prefiero dejarlo|no quiero seguir|me (?:acabas de )?(?:aterrar|asusta\w*|da miedo))\b/.test(normalize(userText));
}

function sameVisit(text) {
  const words = normalize(text);
  return /\b(?:cuando (?:vaya|venga|venga a la clinica)|(?:el |ese |ese mismo |el mismo )dia|(?:la |esa )misma visita|en esa visita)\b/.test(words) &&
    /\b(?:hacerme|empezar|hacer el|hacerme el|realizarme)\b.{0,36}\b(?:tratamiento|tratmiento|sesion)\b/.test(words);
}

function groundedFollowup({userText,history,offer,fields,timezone}) {
  const words = normalize(userText);
  if (/^(?:no (?:quiero|necesito) (?:reservar|una cita)(?: (?:ahora|aun|todavia))?(?: solo (?:estoy mirando|queria informacion))?|solo (?:estoy mirando|queria informacion))$/.test(words))
    return 'De acuerdo, seguimos por aquí si quieres información.';
  if (sameVisit(userText)) return 'Podemos organizar la valoración. El equipo tendría que confirmar si es posible hacerte el tratamiento en esa misma visita.';
  if (declines(userText)) return 'Entiendo. Lo dejamos aquí. Gracias por decírmelo.';
  if (!offer && unresolvedAd(userText))
    return '¿Recuerdas qué tratamiento o qué zona aparecía en el anuncio? Con ese detalle puedo identificar la promoción.';
  const mentionedScar = history.some(m=>m.role==='assistant' && /\bcicatriz\b/i.test(m.text));
  if (mentionedScar && /\b(?:cicatriz|a (?:cual|que) te referias|lo dijiste tu)\b/.test(words)) {
    if (offer && /\bcicatriz\b/i.test([offer.description,offer.guide].join(' ')))
      return 'Me refería a la cicatriz que menciona la ficha de '+offer.title+'. Cómo sería en tu caso es algo que tendría que explicarte el equipo.';
    return 'Mencioné una cicatriz sin tener información suficiente sobre tu caso. No debería haber dado eso por supuesto.';
  }
  if (!offer && /\bcicatriz\b/.test(words) && !history.some(m=>m.role==='user' && /cirug|operaci[oó]n|lifting/i.test(m.text)))
    return 'Con lo que me has contado aún no sé qué tratamiento viste. ¿Qué aparecía en el anuncio?';
  if (/^(?:hola|buenas|buenos dias|buenas tardes|buenas noches|hey|holi)$/.test(words))
    return '¿En qué puedo ayudarte?';
  if (!offer && /\b(?:a (?:cual|que) te referias|lo dijiste tu|lo has dicho tu|a que te refieres tu)\b/.test(words) &&
      history.some(m=>m.role==='user' && /anuncio|publicaci[oó]n/i.test(m.text)))
    return 'Aún no he identificado el anuncio que viste. Si me dices una palabra del texto o qué aparecía en la imagen, puedo intentar localizarlo.';
  if (/\b(?:consulta|valoracion|visita)\b/.test(words) && /\b(?:por telefono|telefonica|online|videollamada|presencial)\b/.test(words)) {
    const modalities = [fields.context,fields.booking,offer?.guide].filter(Boolean).flatMap(v=>v.split(/\n|(?<=[.!?])\s+/))
      .filter(line=>/\b(?:consulta|valoracion|visita)\b/.test(normalize(line)) &&
        /\b(?:presencial|telefonica|telefonico|videollamada|online|por telefono)\b/.test(normalize(line)));
    if (!modalities.length) return 'No tengo confirmado si esa valoración puede hacerse por teléfono o a distancia. ¿Quieres que pida al equipo que te llame para aclararlo?';
  }
  const closing = /^(?:(?:vale|gracias|de acuerdo) )?(?:nos vemos|hasta luego|hasta pronto|adios)(?: gracias)?$/.test(words);
  if (closing) return 'Gracias por escribirnos. Hasta pronto.';
  if (!offer && /^(?:(?:hola|buenas) )?(?:info|informacion|quiero (?:mas )?info(?:rmacion)?|me interesa (?:mas )?info(?:rmacion)?)$/.test(words))
    return '¿Qué promoción has visto?';

  const {area,reducing} = goal(history,userText);
  if (!area || !reducing) return null;
  const seekingAdvice = alternative.test(words) || volume.test(words) || promoPrice.test(words);
  if (!seekingAdvice) return null;
  // General body promotions may have prices in the same document. They cannot
  // substantiate either a use or a price for a different area. Require local evidence.
  const evidence = [fields.context,offer?.description,offer?.guide].filter(Boolean)
    .flatMap(text=>text.split(/\n|(?<=[.!?])\s+/))
    .filter(line=>area.words.test(normalize(line)) && volume.test(normalize(line)) && !unsupported.test(normalize(line)));
  const target = area.name === 'cuello' && /papada|ment[oó]n|barbilla/i.test(history.filter(m=>m.role==='user').map(m=>m.text).join(' ')+' '+userText)
    ? 'la papada' : 'el volumen '+area.label.replace(/^el /,'del ').replace(/^los /,'de los ');
  const alreadyOffered = history.slice(-4).some(m=>m.role==='assistant' && /horarios|primera valoraci[oó]n|confirmado la cita/i.test(m.text));
  const propose = alreadyOffered ? '' : ' ¿Quieres que mire horarios para una valoración?';
  if (alternative.test(words) || promoPrice.test(words)) {
    // Consider other active promotions by their own stated indication. Neither a
    // general price table nor another area's price is evidence for this request.
    const matches = [];
    for (const [key,section] of offerSections(fields.promotions)) {
      if (!isOfferActive(section,{timezone})) continue;
      const lines = [section.title,...section.lines,section.guide].filter(Boolean);
      const indicated = lines.flatMap(line=>line.split(/\n|(?<=[.!?])\s+/)).some(line=>{
        const text = normalize(line);
        return area.words.test(text) && volume.test(text) &&
          /\b(?:reduc\w*|disminu\w*|tratamiento (?:de|para)|indicado para|mejorar)\b/.test(text) &&
          !/\b(?:no|sin evidencia|excepto|contraindica\w*|no apto)\b/.test(text);
      });
      if (indicated && (key !== offer?.key || promoPrice.test(words))) matches.push(section);
    }
    if (matches.length) {
      const names = matches.slice(0,3).map(m=>m.title.split('\n')[0].slice(0,130));
      if (promoPrice.test(words) && matches.length === 1) {
        const priceLine = matches[0].lines.find(l=>/[€$£]/.test(l) && !/https?:|antes|desde|hasta|ahorro|descuento/i.test(l) &&
          (l.match(/[€$£]/g)||[]).length === 1);
        const price=priceLine?.match(/(?:\d[\d.,]*\s*[€$£]|[€$£]\s*\d[\d.,]*)/u)?.[0];
        if (price) return 'La promoción «'+names[0]+'» tiene un precio publicado de '+price+'.';
      }
      return matches.length === 1
        ? 'La clínica sí describe «'+names[0]+'» para ese objetivo. La valoración permite comprobar si encaja contigo.'
        : 'Las opciones que la clínica indica para esa zona son '+new Intl.ListFormat('es').format(names)+'. ¿Sobre cuál te gustaría saber más?';
    }
  }
  if (promoPrice.test(words) && !evidence.some(line=>/[€$£]|\b(?:euros?|precio)\b/i.test(line)))
    return 'No tengo un precio promocional confirmado para '+target+'.'+propose;
  if (offer && !alternative.test(words) && !promoPrice.test(words)) return null;
  if (evidence.length) return null;
  if (/\b(?:esperaba|no lo se|no se que elegir)\b/.test(words))
    return 'No necesitas elegir tú la técnica. Puedes ir a la valoración con el objetivo que me has contado: reducir '+target+'. El equipo podrá explicarte qué opciones encajan contigo.';
  if (/\b(?:lo que (?:ya )?te he dicho|lo que te dije)\b/.test(words))
    return 'Sí, te referías a reducir '+target+'. No tengo otra opción documentada para esa zona que pueda detallarte por aquí.';
  if (/\b(?:menos invasiv|cual (?:va|funciona|es) mejor|mas eficaz)/.test(words))
    return 'No tengo una comparativa que permita decirte cuál sería menos invasiva o más adecuada para '+target+'. Esa preferencia puedes plantearla en la valoración.';
  if (/\b(?:para que sirve cada|que hace cada|como funciona cada)\b/.test(words))
    return 'Todavía no hemos identificado una técnica concreta para '+target+'. La información disponible no me permite presentarte varias como si todas sirvieran para ese objetivo.';
  if (alternative.test(words))
    return 'Para '+target+' no tengo una alternativa confirmada que pueda recomendarte por chat.'+propose;
  return 'Para reducir '+target+' no tengo una técnica indicada expresamente en la información de la clínica.'+propose;
}

module.exports = { areaIn, goal, groundedFollowup, unresolvedAd, declines, sameVisit };
