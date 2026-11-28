'use strict';

const { normalize } = require('./leadAssistantCalendar.service');
const { catalogPrice, catalogState } = require('../lib/treatment-catalog-contract');
const { saleMode } = require('../lib/treatment-commercial-policy');
const { bookingVisibility } = require('../lib/treatment-booking-visibility');

const week = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const opening = /\b(?:horario(?:s)? (?:de (?:la |vuestra )?(?:clinica|sede|apertura|recepcion|atencion)|de cierre)|horario de atencion al publico|(?:a que hora|cuando|que dias?) (?:abri[rs]|abre[ns]?|cerr[aá]is|cierr[ae]n?|estais abiertos)|(?:estais|esta|teneis) abiert[oa]s?|abr[ií]s (?:los|el|hoy|manana)|horari[oa] (?:de lunes|los sabados))\b/;
const address = /\b(?:direccion|donde (?:esta(?:is|n)?|se encuentra|queda) (?:la |vuestra )?(?:clinica|sede)|donde estais|como (?:llego|llegar) (?:a|hasta) (?:la )?(?:sede|clinica)|ubicacion de (?:la )?(?:sede|clinica))\b/;
const services = /\b(?:que (?:tratamientos|servicios) (?:haceis|teneis|ofreceis|hay|prestais)|(?:lista|listado|catalogo) de (?:servicios|tratamientos))\b/;
const price = /\b(?:precio|tarifa|cuanto (?:vale|cuesta|sale|es)|que (?:vale|cuesta)|coste|cuesta (?:algo|dinero))\b/;
const promotion = /\b(?:promo\w*|ofertas?|descuentos?)\b/;
const regular = /\b(?:habitual|normal|ordinari[oa]|sin (?:la )?(?:promo\w*|oferta|descuento)|fuera de (?:la )?(?:promo\w*|oferta))\b/;
const currency = /(?:[€$£]|\b(?:euros?|gratis|gratuit[oa]|sin coste)\b)/iu;

function intent(text) {
  const q = normalize(text);
  if (/\b(?:horarios?|horas?)\b/.test(q) && /\b(?:para (?:una |la )?(?:cita|valoracion|consulta)|tienes disponible|teneis disponible|puedo ir|me puedes dar)\b/.test(q)) return null;
  if (opening.test(q) || /^(?:(?:hola|buenas) )?(?:que|cual es (?:el|vuestro)) horarios?(?: teneis)?$/.test(q)) return 'hours';
  if (address.test(q)) return 'address';
  if (services.test(q)) return 'services';
  if (price.test(q) && (!promotion.test(q) || regular.test(q))) return 'price';
  return null;
}

// A named tariff starts a new subject. References to the current session, location
// or consultation continue through the ordinary offer and booking rules.
function namedTariff(text) {
  const q = normalize(text);
  const match = q.match(/\b(?:cuanto (?:cuesta|vale|sale)n?|que precio tiene[n]?|(?:precio|tarifa)(?: (?:habitual|normal))? (?:de|del|para)) (.+)$/);
  if (!match) return null;
  const name = match[1].replace(/^(?:para |de |del )?(?:la |el |las |los |un |una )?/, '')
    .replace(/ (?:sin (?:la )?(?:promo\w*|oferta)|normalmente|por favor|en total).*$/, '').trim();
  if (!name || /^(?:y|o|cuanto|como|cuando)\b/.test(name) || /^(?:esto|eso|esta|este|esa|ese|cada|ambos|todo|en |por |para |aproximadamente|normalmente|total|gratis|dinero)\b/.test(name) ||
      /^(?:(?:primera|otra|misma) )?(?:valoracion|consulta|visita|cita|sesion(?:es)?|promo(?:cion)?|tratamiento|oferta|zona|relleno)(?: (?:de |para )?(?:ojeras|ojos))?$/.test(name)) return null;
  return name;
}

function switchesPricedService(question, previousTitle) {
  const requested = namedTariff(question);
  if (!requested) return false;
  const significant = requested.split(' ').filter(word=>word.length>2 && !['del','los','las','una','para','por'].includes(word));
  return significant.length > 0 && !significant.some(word=>mentions(previousTitle,word));
}

const mentions = (text, term) => (' ' + normalize(text).replace(/:/g,' ') + ' ').includes(' ' + normalize(term).replace(/:/g,' ') + ' ');
const label = {
  hours: /^(?:horarios?(?: de (?:la )?(?:clinica|sede|recepcion|apertura|atencion))?|apertura)$/,
  address: /^(?:direccion(?: de (?:la )?(?:sede|clinica))?|ubicacion)$/,
  services: /^(?:servicios|tratamientos)(?: disponibles| de la clinica)?$/,
};

function writtenAnswer(kind, fields, offer) {
  for (const section of [fields.booking, offer?.description, fields.context]) {
    for (const raw of (section || '').split('\n')) {
      const line = raw.replace(/\*\*/g, '').replace(/^\s*(?:[-*]|#{1,6})\s+/, '').trim();
      const match = line.match(/^([^:]{3,65}):\s*(.{2,350})$/u);
      if (match && label[kind]?.test(normalize(match[1])) &&
          !/https?:|\b(?:pendiente|configura|pregunta al equipo|por definir|sin definir)\b/i.test(match[2])) {
        if (kind === 'hours') return 'El horario indicado por la clínica es '+match[2];
        if (kind === 'address') return 'La sede está en '+match[2];
        return match[2];
      }
    }
  }
  return null;
}

function relevantManual(kind, fields, offer, question, serviceName) {
  const content = [fields.booking, offer?.description, fields.context].filter(Boolean).join('\n').split('\n');
  const target = serviceName && normalize(serviceName);
  question = normalize(question);
  const topic = {hours:/\b(?:horario|abrimos|recepcion abre|apertura|cerramos)\b/,address:/\b(?:direccion|ubicacion|estamos en|nos encontramos en)\b/,
    services:/\b(?:servicios que ofrecemos|tratamientos disponibles|ofrecemos (?:los|estos) tratamientos)\b/};
  return content.some(line => {
    const normalized = normalize(line);
    if (kind !== 'price') return topic[kind].test(normalized) &&
      (kind !== 'hours' || /\d|cerrad|apertura variable/.test(normalized));
    if (!currency.test(line)) return false;
    if (target && mentions(normalized,target)) return true;
    return /\b(?:consulta|valoracion|primera visita)\b/.test(question) &&
      /\b(?:consulta|valoracion|primera visita)\b/.test(normalized);
  });
}

function regularPriceLines(fields, offer, question, history) {
  const subjects = [normalize(question)];
  if (offer?.title) subjects.push(normalize(offer.title));
  if (/^(?:(?:y|pero) )?(?:el |su )?(?:precio|tarifa) (?:normal|habitual)$/.test(subjects[0])) {
    const last = history.filter(m=>m.role === 'user').at(-1);
    if (last) subjects.push(normalize(last.text));
  }
  const target = namedTariff(question);
  const stop = /^(?:para|tiene|cual|cuesta|cuanto|precio|cuestan|tarifa|habitual|normal|oferta|promocion|fuera|clinica|sede|tratamiento)$/;
  const relevantWords = subjects.flatMap(text=>text.split(' ').filter(w=>w.length >= 4 && !stop.test(w)));
  const sections = [offer?.description, fields.booking, fields.context].filter(Boolean);
  for (const section of sections) {
    const lines = section.split('\n').filter(line=>{
      const text = normalize(line);
      if (!currency.test(line) || !regular.test(text) || /\b(?:antes|ahorro)\b/.test(text)) return false;
      if (section === offer?.description && (!target || !switchesPricedService(question,offer.title))) return true;
      return target ? mentions(text,target) : relevantWords.some(word=>mentions(text,word));
    });
    if (lines.length) return lines;
  }
  return [];
}

function labelledRegularPrice(lines,question) {
  if (lines.length !== 1) return null;
  const match = lines[0].replace(/\*\*/g,'').trim().match(/^(?:[-*]\s*)?(?:precio|tarifa) (?:habitual|normal|ordinari[oa]) (?:de |del )(.{2,100}?):\s*((?:desde\s+)?\d+(?:[.,]\d{1,2})?\s*(?:€|euros?)(?: (?:por (?:sesi[oó]n|zona|unidad)|en total))?)\.?$/iu);
  return match && mentions(question,match[1]) ? 'El precio habitual de «'+match[1]+'» es '+match[2]+'.' : null;
}

function formatHours(hours, question) {
  const days = [1,2,3,4,5,6,0];
  const day = days.find(i => mentions(question,week[i]) || mentions(question,week[i]+'s'));
  const requested = day === undefined ? days : [day];
  const entries = requested.flatMap(i => {
    const times = hours.filter(h=>h.weekday === i).map(h=>h.opens+'–'+h.closes);
    return times.length ? [week[i]+' '+times.join(' y ')] : [];
  });
  if (!entries.length) return day === undefined ? 'No tengo un horario de apertura confirmado para esta sede.' :
    'No figura horario de apertura para el '+week[day]+'.';
  return 'El horario de apertura que figura en la sede es '+entries.join(', ')+'.';
}

async function clinicServices(db, clinicId) {
  const rows = await db.Tratamiento.findAll({
    where: {clinica_id:clinicId, origen:'clinica', activo:true},
    attributes:['nombre','activo','codigo','clinical_config','eliminado_por_clinica','precio_base'],
    order:[['nombre','ASC']],raw:true,
  });
  return rows.filter(row=>row.nombre && !/\b(?:demo|prueba|uso interno)\b/.test(normalize(row.nombre)) && !(Array.isArray(row.eliminado_por_clinica) && row.eliminado_por_clinica.map(Number).includes(Number(clinicId))) &&
    catalogState(row).status === 'active' && !bookingVisibility(row) && saleMode(row) === 'standalone');
}

async function read(db, clinicId, kind, question, history, fields, offer) {
  const q = normalize(question);
  if (kind !== 'hours' && fields.useClinicData !== true) return null;
  if (kind === 'hours') {
    const clinic = await db.Clinica.findByPk(clinicId,{attributes:['id_clinica','grupoClinicaId'],raw:true});
    if (!clinic) return null;
    const {hours} = await require('./leadAssistantHours.service').readOpeningHours(db,clinic);
    return formatHours(hours,q);
  }
  if (kind === 'address') {
    const clinic = await db.Clinica.findByPk(clinicId,{attributes:['direccion','codigo_postal','ciudad'],raw:true});
    return clinic?.direccion ? 'La sede está en '+[clinic.direccion,clinic.codigo_postal,clinic.ciudad].filter(Boolean).join(', ')+'.' : null;
  }
  const rows = await clinicServices(db,clinicId);
  if (kind === 'services') {
    const names = [...new Set(rows.map(row=>row.nombre))];
    if (!names.length) return null;
    return 'Entre los servicios que figuran en esta sede están '+new Intl.ListFormat('es').format(names.slice(0,5))+'. ¿Sobre cuál quieres información?';
  }
  const generic = /^(?:(?:y|pero|entonces) )?(?:(?:el |su )?precio(?: habitual| normal)?|cuanto (?:cuesta|vale|sale)(?: normalmente)?|que precio tiene)$/.test(q);
  const subjects = generic ? [q,offer?.title,...history.filter(m=>m.role==='user').map(m=>m.text).reverse()] : [q];
  for (const subject of subjects.filter(Boolean)) {
    const exact = rows.filter(row=>mentions(subject,row.nombre));
    const matches = exact.length ? exact : rows.filter(row=>{
      const aliases = row.nombre.split(/\s+·\s+/u);
      return aliases.length > 1 && mentions(subject,aliases.at(-1));
    });
    if (!matches.length) continue;
    if (matches.length !== 1) return null;
    const name = matches[0].nombre;
    const last = name.split(/\s+·\s+/u).at(-1);
    // A promotional amount in the selected offer is not the regular tariff.
    const priceContext = regular.test(q) && offer && !regular.test(normalize(offer.description)) ? null : offer;
    if (relevantManual('price',fields,priceContext,q,name) || (last !== name && relevantManual('price',fields,priceContext,q,last))) return null;
    const tariff = catalogPrice(matches[0]);
    if (tariff.review_required || !Number.isFinite(tariff.amount) || tariff.amount <= 0) return null;
    const formatted = new Intl.NumberFormat('es-ES',{style:'currency',currency:'EUR',minimumFractionDigits:0,maximumFractionDigits:2}).format(tariff.amount);
    return 'El precio habitual de «'+matches[0].nombre+'» en esta sede es '+formatted+'.';
  }
  return null;
}

module.exports = {intent, regular, namedTariff, switchesPricedService, regularPriceLines, labelledRegularPrice, writtenAnswer, relevantManual, read};
