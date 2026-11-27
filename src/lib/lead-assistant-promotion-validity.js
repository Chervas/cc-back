'use strict';

const { normalize } = require('./lead-assistant-tables');
const { addDays } = require('./personal-schedule-recurring');

const months = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
const datePattern = /\b(?:(\d{4})-(\d{2})-(\d{2})|(\d{1,2})[/-](\d{1,2})[/-](\d{4})|(\d{1,2}) de ([a-z]+)(?: de (\d{4}))?)\b/;

function dateIn(text, reference) {
  const match = normalize(text).match(datePattern);
  if (!match) return null;
  const year = match[1] || match[6] || match[9] || reference?.slice(0,4);
  const month = Number(match[2] || match[5] || months.indexOf(match[8]) + 1);
  const day = Number(match[3] || match[4] || match[7]);
  if (!year || !month || day < 1) return null;
  const date = [year,String(month).padStart(2,'0'),String(day).padStart(2,'0')].join('-');
  const stamp = Date.parse(date+'T12:00:00Z');
  return Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0,10) === date ? date : null;
}

function scopeWords(value) {
  return normalize(value).match(/[a-z0-9]+/g)?.filter(word => word.length > 2 && !['del','las','los','para','con','por'].includes(word)) || [];
}

// A Markdown validity section may define different terms for each range of
// treatments. Associate a rule with its own table or named offer, then apply
// purchase and redemption deadlines independently.
function saleTerms(preamble, group, title, description) {
  const referenceLine = preamble.split('\n').find(line => /(?:revisad[ao]|actualizad[ao])\s+(?:el|a)\s/i.test(line));
  const reference = referenceLine && dateIn(referenceLine);
  const terms = {};
  const words = new Set(scopeWords(group + ' ' + title));
  const row = normalize(description);
  for (const line of preamble.split('\n')) {
    const scoped = line.match(/^\s*[-*]\s+\*\*([^*]+?)\*\*\s*(.+)$/);
    if (!scoped) continue;
    const names = scopeWords(scoped[1]);
    if (!names.length) continue;
    const body = normalize(scoped[2]);
    const sameGroup = names.every(name => words.has(name));
    // A row can explicitly refer its initial consultation to the promotion's
    // validity. A diagnostic in the same mixed table does not inherit that rule.
    const conditionalVisit = names.some(name=>words.has(name)) && /valoracion/.test(row) &&
      /(?:segun|sujet[ao] a) (?:la )?vigencia/.test(row) && /valoracion/.test(body);
    if (!sameGroup && !conditionalVisit) continue;
    const sale = body.match(/\b(?:compra|venta|adquisicion)\b[^.!?]{0,95}\b(?:termina|finaliza|vence|hasta)\s+(?:el\s+)?([^.!?]+)/);
    if (sale && sameGroup) terms.saleEnd = dateIn(sale[1],reference);
    if (sale && terms.saleEnd) {
      const sentence = scoped[2].split(/(?<=[.!?])\s+/).find(part => /\bcanjear\w*\s+hasta\b/.test(normalize(part)));
      if (sentence) {
        const end = dateIn(normalize(sentence).split(/\bcanjear\w*\s+hasta\b/)[1],reference);
        if (end) { terms.redemptionEnd = end; terms.redemptionText = sentence.replace(/\*\*|__|`/g,'').trim(); }
      }
    }
    if (sameGroup && reference && /\botro mes\b.{0,55}\bconfirma\w*\b.{0,30}\b(?:tarifa|precio)/.test(body)) {
      terms.priceMonth = reference.slice(0,7);
    }
    const before = body.match(/\b(?:solicitudes|reservas|citas) anteriores? (?:al|a) (.+?)(?:[.!?]|$)/);
    if (before && /\b(?:sin coste|gratuidad|gratuit[ao])\b/.test(body)) {
      const firstUnconfirmed = dateIn(before[1],reference);
      if (firstUnconfirmed) terms.valuationEnd = addDays(firstUnconfirmed,-1);
    }
  }
  return terms;
}

function salesRestriction(terms, today) {
  if (!terms) return null;
  if (terms.saleEnd && today > terms.saleEnd) return {reason:'sale_ended', ...terms, today};
  if (terms.priceMonth && today.slice(0,7) !== terms.priceMonth) return {reason:'verify_price'};
  if (terms.valuationEnd && today > terms.valuationEnd) return {reason:'verify_valuation'};
  return null;
}

function restrictionReply(restriction, text) {
  if (restriction.reason === 'sale_ended') {
    const format = value => new Intl.DateTimeFormat('es-ES',{timeZone:'UTC',day:'numeric',month:'long',year:'numeric'}).format(new Date(value+'T12:00:00Z'));
    const question = normalize(text);
    const purchase = /\b(?:comprar\w*|compro|comprase|adquirir\w*|adquiero|contratar\w*|no (?:lo )?(?:he )?comprad?o)\b/.test(question);
    const redeem = /\b(?:canje\w*|ya (?:lo )?(?:compre|tengo)|bono (?:ya )?(?:comprado|adquirido))\b/.test(question);
    if (!purchase && redeem && restriction.redemptionEnd) {
      if (restriction.today <= restriction.redemptionEnd) return {text:restriction.redemptionText, handoff:false};
      return {text:'El plazo de canje de este bono terminó el '+format(restriction.redemptionEnd)+'.',handoff:true};
    }
    return {text:'El plazo de compra al precio promocional terminó el '+format(restriction.saleEnd)+'. El equipo puede confirmarte las condiciones actuales.',handoff:true};
  }
  return {text:restriction.reason === 'verify_valuation' ? 'La clínica tiene que confirmar si tu valoración sigue siendo gratuita.' :
    'Para darte el precio de esta promoción, la clínica tiene que confirmar la tarifa vigente.',handoff:true};
}
module.exports = {saleTerms, salesRestriction, restrictionReply};
