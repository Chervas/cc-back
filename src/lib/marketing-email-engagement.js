'use strict';

const { createHash } = require('node:crypto');
const { parseDocument, DomUtils } = require('htmlparser2');

const { VERSION, LINK_TAG } = require('./marketing-email-engagement-contract');

function settings(baseSet, env = process.env) {
  const name = String(env.EMAIL_MARKETING_ENGAGEMENT_CONFIGURATION_SET || '').trim();
  if (!name || name === baseSet || !/^[A-Za-z0-9_-]{1,64}$/.test(name)) return null;
  return name;
}

function reportUrl(value) {
  if (typeof value !== 'string' || /[{}\u0000-\u0020\u007f\\]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    const path = decodeURIComponent(url.pathname);
    if (/^\/(?:email|api|oauth|auth|whatsapp|tablet|pacientes)(?:\/|$)/i.test(path)
      || !/^\/[a-zA-Z0-9/_\-.]*$/.test(path) || /\d{8}|[a-z0-9_-]{36,}/i.test(path)) return null;
    const sanitized = url.origin + url.pathname;
    return sanitized.length <= 500 ? sanitized : null;
  } catch (_) {
    return null;
  }
}

function anchors(html) {
  const document = parseDocument(String(html || ''), { decodeEntities: true });
  const nodes = DomUtils.findAll(node => node.name === 'a' && !!node.attribs?.href, document.children);
  return { document, nodes };
}

function staticLinks(html) {
  const result = new Map();
  for (const node of anchors(html).nodes) {
    const raw = node.attribs.href;
    const url = reportUrl(raw);
    if (!url || result.has(raw)) continue;
    if (result.size === 250) break;
    const id = createHash('sha256').update(url).digest('hex').slice(0, 24);
    result.set(raw, { id, url });
  }
  return result;
}

function tagLinks(html, links, systemLinks) {
  const { document, nodes } = anchors(html);
  const excluded = new Set(systemLinks);
  for (const node of nodes) {
    const href = node.attribs.href;
    const tracking = !excluded.has(href) && links.get(href);
    if (tracking) node.attribs['ses:tags'] = `${LINK_TAG}:${tracking.id};`;
    else node.attribs['ses:no-track'] = '';
  }
  return DomUtils.getOuterHTML(document);
}

module.exports = { VERSION, LINK_TAG, settings, staticLinks, tagLinks };
