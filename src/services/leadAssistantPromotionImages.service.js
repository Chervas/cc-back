'use strict';

const { createHash } = require('node:crypto');
const { promotionImageUrl } = require('../../services/integrations-broker/src/promotion-image-url');

const { saleTerms, salesRestriction } = require('../lib/lead-assistant-promotion-validity');
const promoCode = /^\s*(?:#{1,6}\s+|[-*]\s+)?(?:\*\*)?([a-z]{1,8}\d{1,5}-\d{1,5})\b/i;
const namedHeading = /^\s*(?:#{1,6}\s+|(?:promoción|promocion|promoció|promo|promotion)\s*:\s*)(.+?)\s*$/i;
const assetId = (key, url) =>
  createHash('sha256')
    .update(key + '\n' + url)
    .digest('hex')
    .slice(0, 24);
const slug = (name) =>
  name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

// Tables supply the price and approved media. A separate Markdown section can
// describe the same treatment. Only attach it when its heading identifies one offer.
function attachOfferGuides(markdown, sections) {
  const tokens = title => slug(title.split(' · ')[0]).split('-').filter(w => w.length > 2 &&
    !['para','con','del','los','las','una','por','bajo','hasta','entre','black','friday','bono'].includes(w));
  const names = [...sections.values()].map(section=>({section, words:tokens(section.title)}));
  const blocks = [...markdown.matchAll(/^#{1,6}\s+(.+)$/gm)];
  for (let i = 0; i < blocks.length; i++) {
    const title = tokens(blocks[i][1]);
    if (!title.length) continue;
    const matches = names.filter(({words})=>words.length && (words.every(w=>title.includes(w)) ||
      (title.length >= 2 && title.every(w=>words.includes(w)))));
    if (matches.length !== 1) continue;
    const from = blocks[i].index + blocks[i][0].length;
    const content = markdown.slice(from,blocks[i+1]?.index ?? markdown.length).trim();
    if (content && !content.startsWith('|')) {
      const section = matches[0].section;
      section.guide = [section.guide,content].filter(Boolean).join('\n');
    }
  }
}

function tableOffers(value) {
  const rows = require('../lib/lead-assistant-tables').tableRows(value, [
    /tratamiento|promocion|oferta/, /precio|importe/, /imagen|archivo visual|creatividad|foto/,
  ], { includeHeading: true });
  const sections = new Map();
  const validity = value.match(/^#{1,6}\s+(?:vigencia|validez)[^\n]*\n([\s\S]*?)(?=^#{1,6}\s|$(?![\s\S]))/im);
  for (const { heading, values: [title, description, media] } of rows) {
    const key = slug(title).slice(0, 96);
    if (!key || !description) continue;
    const section = sections.get(key) || { title, preamble: validity?.[1]?.trim() || '', lines: [] };
    section.saleTerms = saleTerms(section.preamble, heading, title, description);
    section.lines.push(title, description);
    for (const link of media.matchAll(/\[([^\]\n]*)\]\((https:\/\/[^\s<>()]+)\)/g)) {
      if (promotionImageUrl(link[2])) section.lines.push('![' + link[1] + '](' + link[2] + ')');
    }
    sections.set(key, section);
  }
  attachOfferGuides(value, sections);
  return sections;
}

function offerSections(value) {
  const table = tableOffers(String(value || ''));
  if (table.size) return table;
  const sections = new Map();
  const lines = String(value || '').split(/\r?\n/);
  let key;
  const preamble = [];
  let headingLevel = 0;
  let introduction;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    const code = line.match(promoCode);
    const heading = line.match(namedHeading);
    const plainTitle =
      line.length > 0 &&
      line.length <= 160 &&
      !line.includes('://') &&
      (!index || !lines[index - 1].trim()) &&
      /^\s*(?:imagen|image|imatge|foto|photo|creatividad|cartel)\s*:/i.test(lines[index + 1] || '');
    if (!key && /^#{1,6}\s+(?:promociones(?: activas)?|promotions|promocions(?: actives)?)\s*$/i.test(line)) continue;
    const level = line.match(/^\s*(#{1,6})\s/)?.[1].length || 0;
    const sectionHeading = heading && (!level || !key || level <= headingLevel);
    if (code || sectionHeading || plainTitle) {
      headingLevel = level || 1;
      const title = code ? line.slice(code[0].length).replace(/^[\s·:–—*-]+/, '') : heading?.[1] || line;
      key = code ? code[1].toUpperCase() : slug(title).slice(0, 96);
      if (key && !sections.has(key)) {
        introduction ??= preamble.join('\n');
        sections.set(key, { title: title || key, preamble: introduction, lines: [] });
      }
    }
    if (key && line) sections.get(key).lines.push(line);
    else if (!key && line) preamble.push(line);
  }
  return sections;
}

function clinicDate({ now = new Date(), timezone = 'Europe/Madrid' } = {}) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: timezone, year:'numeric', month:'2-digit', day:'2-digit' }).format(now);
}

function isOfferActive(section, options) {
  const today = options?.today || clinicDate(options);
  if (salesRestriction(section.saleTerms,today)) return false;
  const text = [section.preamble || '', ...section.lines].join('\n');
  if (
    /\b(?:en revisi[oó]n|pendiente de aproba(?:ci[oó]n|r)|no aprobad[ao]|retirad[ao]|caducad[ao]|sin vigencia|under review|not approved)\b/i.test(
      text
    )
  )
    return false;
  if (!/^\s*(?:vigencia|vigència|validity)\s*:/im.test(text)) return true;
  for (const line of text.split('\n')) {
    const validity = line.match(/^\s*(?:vigencia|vigència|validity)\s*:\s*(.+)$/i);
    if (!validity) continue;
    const period = validity[1].match(
      /^(\d{4}-\d{2}-\d{2})\s+(?:a|al|hasta|to|–|—|-)\s+(\d{4}-\d{2}-\d{2})\s*\.?$/i
    );
    if (
      !period ||
      !period.slice(1).every((date) => {
        const ms = Date.parse(date + 'T12:00:00Z');
        return Number.isFinite(ms) && new Date(ms).toISOString().startsWith(date);
      }) ||
      today < period[1] ||
      today > period[2]
    )
      return false;
  }
  return true;
}

function catalog(text, options, sections = offerSections(text)) {
  options = { ...options, today:options?.today || clinicDate(options) };
  const result = new Map();
  const add = (key, raw, label) => {
    const url = promotionImageUrl(raw);
    if (!key || !url) return;
    const id = assetId(key, url);
    const images = result.get(key) || [];
    if (!images.some((item) => item.id === id))
      images.push({ id, url, label: (label || 'Imagen de ' + key).trim().slice(0, 160) });
    result.set(key, images);
  };
  for (const [key, section] of sections) {
    if (!isOfferActive(section, options)) continue;
    for (const line of section.lines) {
      const markdown = /(!?)\[([^\]\n]*)\]\((https:\/\/[^\s<>()]+)\)/gi;
      let match;
      while ((match = markdown.exec(line))) {
        if (match[1] || /\b(imagen|image|imatge|foto|photo|creatividad|cartel)\b/i.test(match[2]))
          add(key, match[3], match[2]);
      }
      const plain = line.replace(markdown, '');
      for (const link of plain.matchAll(/https:\/\/[^\s<>()[\]]+/gi)) {
        const url = link[0].replace(/[.,;!]+$/, '');
        const marked = /(?:imagen|image|imatge|foto|photo|creatividad|cartel)\s*:\s*$/i.test(
          plain.slice(0, link.index)
        );
        if (marked || (plain.trim() === link[0] && /\.(?:png|jpe?g|webp)(?:\?|$)/i.test(url))) add(key, url);
      }
    }
  }
  return result;
}

// Only the stored publication can supply a URL. The model selects an opaque id
// from the matched promotion, and receives neither the URL nor other offers' images.
async function resolveForTurn(db, thread, scope, transaction) {
  if (
    !scope ||
    !Number.isSafeInteger(scope.messageId) ||
    !Number.isSafeInteger(scope.executionId) ||
    typeof scope.key !== 'string' ||
    !/^[a-f0-9]{24}$/.test(scope.id || '')
  )
    return null;
  const session = await db.LeadAssistantSession.findOne({
    where: {
      conversation_id: thread.id,
      clinic_id: thread.clinic_id,
      template_id: scope.templateId,
      publication_version: scope.version,
      state: 'active',
    },
    attributes: ['publication_version'],
    transaction,
    raw: true,
  });
  if (!session) return null;
  const message = await db.Message.findOne({
    where: {
      id: scope.messageId,
      conversation_id: thread.id,
      direction: 'inbound',
    },
    attributes: ['metadata'],
    transaction,
    raw: true,
  });
  const turn = message?.metadata?.leadAssistantTurn;
  if (
    turn?.promotionKey !== scope.key ||
    turn.publicationVersion !== session.publication_version ||
    turn.templateId !== scope.templateId ||
    turn.executionId !== scope.executionId
  )
    return null;
  const publication = await db.LeadAssistantPublication.findOne({
    where: { clinic_id: thread.clinic_id, version: session.publication_version },
    attributes: ['fields'],
    transaction,
    raw: true,
  });
  const images = catalog(publication?.fields?.promotions, { timezone: turn.timezone }).get(scope.key) || [];
  return images.find((image) => image.id === scope.id) || null;
}

module.exports = { offerSections, catalog, isOfferActive, resolveForTurn, clinicDate };
