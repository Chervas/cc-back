'use strict';

const { createHash } = require('node:crypto');
const { promotionImageUrl } = require('../../services/integrations-broker/src/promotion-image-url');

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

function offerSections(value) {
  const sections = new Map();
  const lines = String(value || '').split(/\r?\n/);
  let key;
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
    if (code || heading || plainTitle) {
      const title = code ? line.slice(code[0].length).replace(/^[\s·:–—*-]+/, '') : heading?.[1] || line;
      key = code ? code[1].toUpperCase() : slug(title).slice(0, 96);
      if (key && !sections.has(key)) sections.set(key, { title: title || key, lines: [] });
    }
    if (key && line) sections.get(key).lines.push(line);
  }
  return sections;
}

function catalog(text) {
  const result = new Map();
  const held = new Set();
  const add = (key, raw, label) => {
    const url = promotionImageUrl(raw);
    if (!key || !url) return;
    const id = assetId(key, url);
    const images = result.get(key) || [];
    if (!images.some((item) => item.id === id))
      images.push({ id, url, label: (label || 'Imagen de ' + key).trim().slice(0, 160) });
    result.set(key, images);
  };
  for (const [key, section] of offerSections(text)) {
    for (const line of section.lines) {
      if (
        /\b(?:en revisi[oó]n|pendiente de aproba(?:ci[oó]n|r)|no aprobada?|retirada|caducada|sin vigencia|under review|not approved)\b/i.test(
          line
        )
      )
        held.add(key);
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
  for (const heldKey of held) result.delete(heldKey);
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
  const images = catalog(publication?.fields?.promotions).get(scope.key) || [];
  return images.find((image) => image.id === scope.id) || null;
}

module.exports = { offerSections, catalog, resolveForTurn };
