'use strict';

const crypto = require('crypto');
const dns = require('dns').promises;
const { Op } = require('sequelize');
const db = require('../../models');
const emailDelivery = require('./emailDelivery.service');
const emailTemplates = require('./emailTemplates.service');
const emailProvider = require('./emailProvider.service');
const { createEmailBroker } = require('./emailBroker.service');

const LAYOUTS = new Set(['classic', 'banner', 'minimal']);
const BLOCKS = new Set(['heading', 'text', 'image', 'button', 'divider']);
const DEFAULT_DESIGN = Object.freeze({
  header_color: '#0f766e',
  footer_color: '#0f172a',
  background_color: '#f1f5f9',
  content_color: '#ffffff',
  text_color: '#1e293b',
  logo_url: null,
  blocks: [
    { type: 'heading', text: 'Hola {{nombre}}' },
    { type: 'text', text: 'Tenemos novedades que pueden interesarte.' },
    { type: 'button', text: 'Más información', url: 'https://clinicaclick.com' },
  ],
});

function fail(code, status = 400, message = code, details = null) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  if (details) error.details = details;
  throw error;
}

function clean(value) {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

function normalizeDomain(value) {
  const normalized = String(value || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/.test(normalized)
    || normalized.includes('..') || normalized.length > 255) fail('email_domain_invalid', 400, 'El dominio no es válido.');
  return normalized;
}

function normalizeEmail(value) {
  try { return emailDelivery.normalizeEmail(value); }
  catch { fail('email_sender_invalid', 400, 'El email remitente no es válido.'); }
}

function scopeDescriptor(scope) {
  if (scope?.scope === 'group' && Number(scope.groupId) > 0) {
    return { scope_type: 'group', scope_key: `group:${Number(scope.groupId)}`, clinica_id: null, grupo_clinica_id: Number(scope.groupId) };
  }
  if (Array.isArray(scope?.clinicIds) && scope.clinicIds.length === 1 && Number(scope.clinicIds[0]) > 0) {
    return { scope_type: 'clinic', scope_key: `clinic:${Number(scope.clinicIds[0])}`, clinica_id: Number(scope.clinicIds[0]), grupo_clinica_id: null };
  }
  fail('email_scope_requires_single_clinic_or_group', 400, 'Selecciona una clínica o un grupo concreto.');
}

function publicId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function hexColor(value, fallback) {
  const normalized = String(value || '').trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(normalized) ? normalized : fallback;
}

function safeHttpsUrl(value, { required = false } = {}) {
  const normalized = clean(value);
  if (!normalized && !required) return null;
  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error();
    return parsed.toString();
  } catch {
    fail('email_template_url_invalid', 400, 'Las imágenes y botones deben usar una URL HTTPS válida.');
  }
}

function normalizeBlock(raw = {}) {
  const type = String(raw.type || '').trim().toLowerCase();
  if (!BLOCKS.has(type)) fail('email_template_block_invalid', 400, 'La plantilla contiene un bloque no permitido.');
  if (type === 'divider') return { type };
  if (type === 'image') {
    return { type, url: safeHttpsUrl(raw.url, { required: true }), alt: clean(raw.alt)?.slice(0, 160) || '' };
  }
  const text = clean(raw.text)?.slice(0, type === 'text' ? 5000 : 220);
  if (!text) fail('email_template_block_text_required', 400, 'Completa el contenido de todos los bloques.');
  if (type === 'button') return { type, text, url: safeHttpsUrl(raw.url, { required: true }) };
  return { type, text };
}

function normalizeDesign(raw = {}) {
  const blocks = Array.isArray(raw.blocks) ? raw.blocks.slice(0, 20).map(normalizeBlock) : DEFAULT_DESIGN.blocks;
  if (!blocks.length) fail('email_template_blocks_required', 400, 'Añade al menos un bloque a la plantilla.');
  return {
    header_color: hexColor(raw.header_color, DEFAULT_DESIGN.header_color),
    footer_color: hexColor(raw.footer_color, DEFAULT_DESIGN.footer_color),
    background_color: hexColor(raw.background_color, DEFAULT_DESIGN.background_color),
    content_color: hexColor(raw.content_color, DEFAULT_DESIGN.content_color),
    text_color: hexColor(raw.text_color, DEFAULT_DESIGN.text_color),
    logo_url: safeHttpsUrl(raw.logo_url),
    blocks,
  };
}

function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function renderBlock(block, design) {
  if (block.type === 'heading') return `<h1 style="margin:0 0 18px;font:700 26px/1.25 Arial,sans-serif;color:${design.text_color}">${escapeHtml(block.text)}</h1>`;
  if (block.type === 'text') return `<p style="margin:0 0 18px;font:15px/1.65 Arial,sans-serif;color:${design.text_color};white-space:pre-line">${escapeHtml(block.text)}</p>`;
  if (block.type === 'image') return `<img src="${escapeHtml(block.url)}" alt="${escapeHtml(block.alt)}" width="600" style="display:block;width:100%;height:auto;margin:0 0 18px;border:0">`;
  if (block.type === 'button') return `<p style="margin:0 0 20px"><a href="${escapeHtml(block.url)}" style="display:inline-block;padding:12px 18px;border-radius:6px;background:${design.header_color};color:#ffffff;text-decoration:none;font:700 14px Arial,sans-serif">${escapeHtml(block.text)}</a></p>`;
  return '<hr style="margin:22px 0;border:0;border-top:1px solid #e2e8f0">';
}

function renderTemplateDocument({ subject, preheader, layoutKey, design }) {
  const logo = design.logo_url
    ? `<img src="${escapeHtml(design.logo_url)}" alt="" width="180" style="display:block;max-width:180px;max-height:72px;width:auto;height:auto;border:0">`
    : '<span style="font:700 18px Arial,sans-serif;color:#ffffff">{{clinica}}</span>';
  const header = layoutKey === 'minimal' ? '' : `<tr><td style="padding:20px 28px;background:${design.header_color}">${logo}</td></tr>`;
  const body = design.blocks.map(block => renderBlock(block, design)).join('');
  return [
    '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${escapeHtml(subject)}</title></head><body style="margin:0;background:${design.background_color}">`,
    `<div style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(preheader || '')}</div>`,
    '<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center" style="padding:28px 12px">',
    `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;background:${design.content_color};border-collapse:collapse">`,
    header,
    `<tr><td style="padding:${layoutKey === 'banner' ? '34px 32px' : '28px'}">${body}</td></tr>`,
    `<tr><td style="padding:16px 24px;background:${design.footer_color};text-align:center;color:#cbd5e1;font:12px/1.5 Arial,sans-serif">{{clinica}}</td></tr>`,
    '</table></td></tr></table></body></html>',
  ].join('');
}

function textFromDesign(design) {
  return design.blocks.filter(block => ['heading', 'text', 'button'].includes(block.type)).map(block => block.text).join('\n\n');
}

function normalizeTemplateContent(body = {}) {
  const name = clean(body.name);
  const subject = clean(body.subject);
  if (!name || name.length > 160) fail('email_template_name_invalid', 400, 'Indica un nombre para la plantilla.');
  emailTemplates.assertSafeSubject(subject);
  const layoutKey = LAYOUTS.has(body.layout_key || body.layoutKey) ? (body.layout_key || body.layoutKey) : 'classic';
  const design = normalizeDesign(body.design || {});
  const preheader = clean(body.preheader);
  return {
    name,
    subject,
    preheader,
    layout_key: layoutKey,
    design,
    rendered_html: renderTemplateDocument({ subject, preheader, layoutKey, design }),
    rendered_text: textFromDesign(design),
  };
}

function templateIdentifier(id) {
  return { [Op.or]: [{ public_id: id }, { id: Number(id) || 0 }] };
}

function serializeDomain(row) {
  const value = row?.get ? row.get({ plain: true }) : row;
  if (!value) return null;
  return {
    id: value.public_id,
    backend_id: value.id,
    domain: value.domain,
    status: value.status,
    verification_status: value.verification_status,
    dkim_status: value.dkim_status,
    spf_status: value.spf_status,
    dmarc_status: value.dmarc_status,
    mail_from_domain: value.mail_from_domain,
    mail_from_status: value.mail_from_status,
    dns_records: Array.isArray(value.dns_records) ? value.dns_records : [],
    checked_at: value.checked_at,
    error: value.last_error_code ? { code: value.last_error_code, message: value.last_error_message } : null,
  };
}

function serializeSender(row) {
  const value = row?.get ? row.get({ plain: true }) : row;
  if (!value) return null;
  return {
    id: value.public_id,
    backend_id: value.id,
    domain_id: value.domain?.public_id || value.domain_id,
    email: value.email,
    display_name: value.display_name,
    reply_to: value.reply_to,
    status: value.status,
    verification_status: value.verification_status,
    is_default: value.is_default === true,
    domain_verification_status: value.domain?.verification_status || null,
    dkim_status: value.domain?.dkim_status || null,
    spf_status: value.domain?.spf_status || null,
    dmarc_status: value.domain?.dmarc_status || null,
    mail_from_domain: value.domain?.mail_from_domain || null,
    mail_from_status: value.domain?.mail_from_status || null,
    ready: value.status === 'active'
      && value.verification_status === 'verified'
      && value.domain?.verification_status === 'verified'
      && value.domain?.dkim_status === 'verified'
      && value.domain?.spf_status === 'verified'
      && value.domain?.mail_from_status === 'success',
  };
}

function serializeTemplate(row, { includeRendered = false } = {}) {
  const value = row?.get ? row.get({ plain: true }) : row;
  if (!value) return null;
  return {
    id: value.public_id,
    backend_id: value.id,
    name: value.name,
    status: value.status,
    subject: value.subject,
    preheader: value.preheader,
    layout_key: value.layout_key,
    design: value.design,
    version: value.version,
    origin: value.origin || 'custom',
    is_system: value.origin === 'system',
    editable: value.origin !== 'system',
    catalog_template_id: value.catalog_template_id || null,
    catalog_version: value.catalog_version || null,
    is_active: value.is_active !== false,
    propagation_state: value.propagation_state || null,
    last_propagated_at: value.last_propagated_at || null,
    updated_at: value.updated_at,
    ...(includeRendered ? { rendered_html: value.rendered_html, rendered_text: value.rendered_text } : {}),
  };
}

function dnsRecords(domain, identity) {
  const tokens = Array.isArray(identity?.dkimTokens) ? identity.dkimTokens : [];
  const mailFromDomain = identity?.mailFromDomain || `bounce.${domain}`;
  return [
    ...tokens.map(token => ({ type: 'CNAME', name: `${token}._domainkey.${domain}`, value: `${token}.dkim.amazonses.com`, purpose: 'DKIM' })),
    { type: 'MX', name: mailFromDomain, value: '10 feedback-smtp.eu-west-3.amazonses.com', purpose: 'MAIL FROM' },
    { type: 'TXT', name: mailFromDomain, value: 'v=spf1 include:amazonses.com ~all', purpose: 'SPF' },
    { type: 'TXT', name: `_dmarc.${domain}`, value: `v=DMARC1; p=none; rua=mailto:dmarc@${domain}`, purpose: 'DMARC' },
  ];
}

async function txtIncludes(name, expected) {
  try {
    const rows = await dns.resolveTxt(name);
    return rows.map(parts => parts.join('')).some(value => value.toLowerCase().includes(expected.toLowerCase()));
  } catch { return false; }
}

async function dnsStatus(domain, mailFromDomain = `bounce.${domain}`) {
  const [spf, dmarc, mailFromMx] = await Promise.all([
    txtIncludes(mailFromDomain, 'include:amazonses.com'),
    txtIncludes(`_dmarc.${domain}`, 'v=dmarc1'),
    dns.resolveMx(mailFromDomain).then(rows => rows.some(row => row.priority === 10
      && String(row.exchange || '').replace(/\.$/, '').toLowerCase() === 'feedback-smtp.eu-west-3.amazonses.com')).catch(() => false),
  ]);
  return { spf_status: spf && mailFromMx ? 'verified' : 'pending', dmarc_status: dmarc ? 'verified' : 'pending' };
}

async function listSettings(scope) {
  const descriptor = scopeDescriptor(scope);
  const [domains, senders] = await Promise.all([
    db.EmailSendingDomain.findAll({ where: { scope_key: descriptor.scope_key }, order: [['created_at', 'ASC']] }),
    db.EmailSenderIdentity.findAll({ where: { scope_key: descriptor.scope_key }, include: [{ model: db.EmailSendingDomain, as: 'domain' }], order: [['is_default', 'DESC'], ['created_at', 'ASC']] }),
  ]);
  return {
    scope: descriptor,
    domains: domains.map(serializeDomain),
    senders: senders.map(serializeSender),
    ready: senders.some(sender => serializeSender(sender)?.ready === true),
    provider: emailProvider.publicConfig(),
  };
}

async function defaultDesignForScope(scope) {
  const descriptor = scopeDescriptor(scope);
  let logoUrl = null;
  if (descriptor.clinica_id && db.Clinica) {
    const clinic = await db.Clinica.findByPk(descriptor.clinica_id, { attributes: ['url_avatar'], raw: true });
    const candidate = clean(clinic?.url_avatar);
    if (candidate) {
      try { logoUrl = safeHttpsUrl(candidate); } catch (_) { logoUrl = null; }
    }
  }
  return { ...DEFAULT_DESIGN, logo_url: logoUrl, blocks: DEFAULT_DESIGN.blocks.map(block => ({ ...block })) };
}

async function addDomain(scope, body, userId) {
  const descriptor = scopeDescriptor(scope);
  const domain = normalizeDomain(body.domain);
  const existing = await db.EmailSendingDomain.findOne({ where: { domain } });
  if (existing && existing.scope_key !== descriptor.scope_key) {
    fail('email_domain_owned_by_another_scope', 409, 'Este dominio ya pertenece a otra clínica o grupo.');
  }
  let identity;
  try { identity = await createEmailBroker().ensureIdentity(domain); }
  catch (error) { fail('email_identity_provider_unavailable', 503, 'No se pudo registrar el dominio en el proveedor. Inténtalo de nuevo.', { provider_code: error.code }); }
  const records = dnsRecords(domain, identity);
  const [row] = await db.EmailSendingDomain.findOrCreate({
    where: { domain },
    defaults: {
      public_id: publicId('ed'),
      ...descriptor,
      domain,
      identity_name: domain,
      status: identity.verifiedForSending ? 'active' : 'pending',
      verification_status: identity.verifiedForSending ? 'verified' : identity.verificationStatus,
      dkim_status: identity.dkimStatus === 'success' ? 'verified' : identity.dkimStatus,
      dns_records: records,
      provider_snapshot: identity,
      checked_at: new Date(),
      created_by: userId || null,
    },
  });
  if (row.scope_key !== descriptor.scope_key) {
    fail('email_domain_owned_by_another_scope', 409, 'Este dominio ya pertenece a otra clínica o grupo.');
  }
  if (!row.dns_records?.length) await row.update({ dns_records: records, provider_snapshot: identity, checked_at: new Date() });
  return serializeDomain(row);
}

async function refreshDomain(scope, id) {
  const descriptor = scopeDescriptor(scope);
  const row = await db.EmailSendingDomain.findOne({ where: { [Op.or]: [{ public_id: id }, { id: Number(id) || 0 }], scope_key: descriptor.scope_key } });
  if (!row) fail('email_domain_not_found', 404, 'No se ha encontrado el dominio.');
  let identity;
  try { identity = await createEmailBroker().getIdentity(row.identity_name); }
  catch (error) {
    await row.update({ last_error_code: error.code || 'provider_unavailable', last_error_message: 'No se pudo consultar SES.', checked_at: new Date() });
    fail('email_identity_provider_unavailable', 503, 'No se pudo comprobar el dominio en este momento.');
  }
  const mailFromDomain = identity.mailFromDomain || `bounce.${row.domain}`;
  const dnsChecks = await dnsStatus(row.domain, mailFromDomain);
  const verified = identity.verifiedForSending === true
    && identity.dkimStatus === 'success'
    && identity.mailFromStatus === 'success'
    && dnsChecks.spf_status === 'verified';
  await db.sequelize.transaction(async transaction => {
    await row.update({
      status: verified ? 'active' : 'pending',
      verification_status: verified ? 'verified' : identity.verificationStatus,
      dkim_status: identity.dkimStatus === 'success' ? 'verified' : identity.dkimStatus,
      ...dnsChecks,
      mail_from_domain: mailFromDomain,
      mail_from_status: identity.mailFromStatus,
      dns_records: dnsRecords(row.domain, identity),
      provider_snapshot: identity,
      last_error_code: null,
      last_error_message: null,
      checked_at: new Date(),
    }, { transaction });
    await db.EmailSenderIdentity.update({ verification_status: verified ? 'verified' : 'pending' }, {
      where: { domain_id: row.id }, transaction,
    });
  });
  return serializeDomain(await row.reload());
}

async function addSender(scope, body, userId) {
  const descriptor = scopeDescriptor(scope);
  const email = normalizeEmail(body.email);
  const domainName = email.split('@')[1];
  const domain = await db.EmailSendingDomain.findOne({ where: { scope_key: descriptor.scope_key, domain: domainName } });
  if (!domain) fail('email_sender_domain_missing', 409, 'Añade y valida primero el dominio del remitente.');
  const displayName = clean(body.display_name || body.displayName);
  if (!displayName || displayName.length > 160) fail('email_sender_name_invalid', 400, 'Indica el nombre que verá el destinatario.');
  const replyTo = clean(body.reply_to || body.replyTo) ? normalizeEmail(body.reply_to || body.replyTo) : null;
  const wantsDefault = body.is_default === true || body.isDefault === true;
  return db.sequelize.transaction(async transaction => {
    if (wantsDefault) await db.EmailSenderIdentity.update({ is_default: false }, { where: { scope_key: descriptor.scope_key }, transaction });
    const [sender, created] = await db.EmailSenderIdentity.findOrCreate({
      where: { scope_key: descriptor.scope_key, email },
      defaults: {
        public_id: publicId('es'), ...descriptor, domain_id: domain.id, email, display_name: displayName,
        reply_to: replyTo, verification_status: domain.verification_status === 'verified' ? 'verified' : 'pending',
        is_default: wantsDefault, created_by: userId || null,
      },
      transaction,
    });
    if (!created) await sender.update({ display_name: displayName, reply_to: replyTo, is_default: wantsDefault || sender.is_default }, { transaction });
    if (!wantsDefault) {
      const existingDefault = await db.EmailSenderIdentity.count({ where: { scope_key: descriptor.scope_key, is_default: true }, transaction });
      if (!existingDefault) await sender.update({ is_default: true }, { transaction });
    }
    sender.domain = domain;
    return serializeSender(sender);
  });
}

async function setDefaultSender(scope, id) {
  const descriptor = scopeDescriptor(scope);
  return db.sequelize.transaction(async transaction => {
    const sender = await db.EmailSenderIdentity.findOne({
      where: { [Op.or]: [{ public_id: id }, { id: Number(id) || 0 }], scope_key: descriptor.scope_key },
      include: [{ model: db.EmailSendingDomain, as: 'domain' }],
      transaction,
    });
    if (!sender) fail('email_sender_not_found', 404, 'No se ha encontrado el remitente.');
    if (sender.verification_status !== 'verified' || sender.status !== 'active'
      || sender.domain?.verification_status !== 'verified' || sender.domain?.dkim_status !== 'verified') {
      fail('email_sender_not_verified', 409, 'Valida el dominio y DKIM antes de usar este remitente.');
    }
    await db.EmailSenderIdentity.update({ is_default: false }, { where: { scope_key: descriptor.scope_key }, transaction });
    await sender.update({ is_default: true }, { transaction });
    return serializeSender(sender);
  });
}

async function listTemplates(scope) {
  const descriptor = scopeDescriptor(scope);
  const rows = await db.MarketingEmailTemplate.findAll({ where: { scope_key: descriptor.scope_key, status: { [Op.ne]: 'archived' } }, order: [['updated_at', 'DESC']] });
  return rows.map(row => serializeTemplate(row));
}

async function saveTemplate(scope, body, userId, id = null) {
  const descriptor = scopeDescriptor(scope);
  const content = normalizeTemplateContent(body);
  if (id) {
    const row = await db.MarketingEmailTemplate.findOne({ where: { ...templateIdentifier(id), scope_key: descriptor.scope_key } });
    if (!row) fail('email_template_not_found', 404, 'No se ha encontrado la plantilla.');
    if (row.origin === 'system' || row.catalog_template_id) {
      fail('email_system_template_read_only', 409, 'Las plantillas de sistema no se editan. Duplica la plantilla para personalizarla.');
    }
    await row.update({ ...content, status: 'ready', version: row.version + 1, updated_by: userId || null });
    return serializeTemplate(row, { includeRendered: true });
  }
  const row = await db.MarketingEmailTemplate.create({
    public_id: publicId('et'), ...descriptor, ...content, status: 'ready', origin: 'custom',
    created_by: userId || null, updated_by: userId || null,
  });
  return serializeTemplate(row, { includeRendered: true });
}

async function duplicateTemplate(scope, id, body, userId) {
  const descriptor = scopeDescriptor(scope);
  const source = await db.MarketingEmailTemplate.findOne({
    where: { ...templateIdentifier(id), scope_key: descriptor.scope_key, status: { [Op.ne]: 'archived' } },
  });
  if (!source) fail('email_template_not_found', 404, 'No se ha encontrado la plantilla.');
  const row = await db.MarketingEmailTemplate.create({
    public_id: publicId('et'),
    ...descriptor,
    name: clean(body?.name) || `Copia de ${source.name}`,
    status: 'ready',
    subject: source.subject,
    preheader: source.preheader,
    layout_key: source.layout_key,
    design: source.design,
    rendered_html: source.rendered_html,
    rendered_text: source.rendered_text,
    version: 1,
    origin: 'custom',
    catalog_template_id: null,
    catalog_version: null,
    created_by: userId || null,
    updated_by: userId || null,
  });
  return serializeTemplate(row, { includeRendered: true });
}

async function getTemplate(scope, id) {
  const descriptor = scopeDescriptor(scope);
  const row = await db.MarketingEmailTemplate.findOne({ where: { ...templateIdentifier(id), scope_key: descriptor.scope_key } });
  if (!row) fail('email_template_not_found', 404, 'No se ha encontrado la plantilla.');
  return serializeTemplate(row, { includeRendered: true });
}

async function listCatalogTemplates() {
  const rows = await db.MarketingEmailTemplateCatalog.findAll({ order: [['updated_at', 'DESC']] });
  return rows.map(row => serializeTemplate(row, { includeRendered: true }));
}

async function getCatalogTemplate(id) {
  const row = await db.MarketingEmailTemplateCatalog.findOne({ where: templateIdentifier(id) });
  if (!row) fail('email_template_catalog_not_found', 404, 'No se ha encontrado la plantilla del catálogo.');
  return row;
}

async function saveCatalogTemplate(body, userId, id = null) {
  const content = normalizeTemplateContent(body);
  if (id) {
    const row = await getCatalogTemplate(id);
    await row.update({
      ...content,
      status: 'ready',
      version: Number(row.version || 1) + 1,
      propagation_state: null,
      updated_by: userId || null,
    });
    return serializeTemplate(row, { includeRendered: true });
  }
  const row = await db.MarketingEmailTemplateCatalog.create({
    public_id: publicId('etc'),
    catalog_key: `email_${crypto.randomUUID()}`,
    ...content,
    status: 'ready',
    version: 1,
    is_active: body.is_active !== false,
    created_by: userId || null,
    updated_by: userId || null,
  });
  return serializeTemplate(row, { includeRendered: true });
}

async function duplicateCatalogTemplate(id, userId) {
  const source = await getCatalogTemplate(id);
  const row = await db.MarketingEmailTemplateCatalog.create({
    public_id: publicId('etc'),
    catalog_key: `email_${crypto.randomUUID()}`,
    name: `Copia de ${source.name}`,
    status: 'ready',
    subject: source.subject,
    preheader: source.preheader,
    layout_key: source.layout_key,
    design: source.design,
    rendered_html: source.rendered_html,
    rendered_text: source.rendered_text,
    version: 1,
    is_active: false,
    created_by: userId || null,
    updated_by: userId || null,
  });
  return serializeTemplate(row, { includeRendered: true });
}

async function setCatalogTemplateActive(id, isActive, userId) {
  const row = await getCatalogTemplate(id);
  await row.update({ is_active: !!isActive, propagation_state: null, updated_by: userId || null });
  if (!isActive) {
    await db.MarketingEmailTemplate.update(
      { status: 'archived', updated_by: userId || null },
      { where: { catalog_template_id: row.id, origin: 'system' } }
    );
  }
  return serializeTemplate(row, { includeRendered: true });
}

async function propagateCatalogTemplate(id, userId) {
  const catalog = await getCatalogTemplate(id);
  if (!catalog.is_active) fail('email_template_catalog_inactive', 409, 'Activa la plantilla antes de propagarla.');
  await catalog.update({ propagation_state: 'pending', updated_by: userId || null });
  const [clinics, groups] = await Promise.all([
    db.Clinica.findAll({ attributes: ['id_clinica'], raw: true }),
    db.GrupoClinica.findAll({ attributes: ['id_grupo'], raw: true }),
  ]);
  const scopes = [
    ...clinics.map(row => ({ scope_type: 'clinic', scope_key: `clinic:${row.id_clinica}`, clinica_id: row.id_clinica, grupo_clinica_id: null })),
    ...groups.map(row => ({ scope_type: 'group', scope_key: `group:${row.id_grupo}`, clinica_id: null, grupo_clinica_id: row.id_grupo })),
  ];
  let created = 0;
  let updated = 0;
  await db.sequelize.transaction(async transaction => {
    for (const descriptor of scopes) {
      const existing = await db.MarketingEmailTemplate.findOne({
        where: { scope_key: descriptor.scope_key, catalog_template_id: catalog.id },
        transaction,
      });
      const values = {
        ...descriptor,
        name: catalog.name,
        status: 'ready',
        subject: catalog.subject,
        preheader: catalog.preheader,
        layout_key: catalog.layout_key,
        design: catalog.design,
        rendered_html: catalog.rendered_html,
        rendered_text: catalog.rendered_text,
        version: catalog.version,
        catalog_version: catalog.version,
        origin: 'system',
        updated_by: userId || null,
      };
      if (existing) {
        await existing.update(values, { transaction });
        updated += 1;
      } else {
        await db.MarketingEmailTemplate.create({
          public_id: publicId('et'),
          ...values,
          catalog_template_id: catalog.id,
          created_by: userId || null,
        }, { transaction });
        created += 1;
      }
    }
    await catalog.update({ propagation_state: 'complete', last_propagated_at: new Date() }, { transaction });
  });
  return {
    template: serializeTemplate(catalog, { includeRendered: true }),
    scopes: scopes.length,
    created,
    updated,
  };
}

function unsubscribeBaseUrl() {
  return String(process.env.EMAIL_PUBLIC_APP_URL || process.env.FRONTEND_PUBLIC_URL || 'https://crm.clinicaclick.com').replace(/\/+$/, '');
}

async function issueUnsubscribe({ scopeKey, clinicaId, groupId, listId, itemId, recipientEmail }, options = {}) {
  const key = clean(process.env.MARKETING_EMAIL_UNSUBSCRIBE_KEY || process.env.EMAIL_DATA_ENCRYPTION_KEY);
  if (!key || key.length < 16) fail('marketing_email_unsubscribe_key_missing', 503, 'La baja segura de email no está configurada.');
  const emailHash = emailDelivery.hashEmail(recipientEmail);
  const raw = crypto.createHmac('sha256', key)
    .update(`marketing-unsubscribe-v1\n${scopeKey}\n${listId || ''}\n${itemId || ''}\n${emailHash}`)
    .digest('base64url');
  const tokenHash = emailDelivery.sha256(raw);
  await db.MarketingEmailUnsubscribe.findOrCreate({
    where: { token_hash: tokenHash },
    defaults: {
      email_hash: emailHash,
      scope_key: scopeKey,
      clinica_id: clinicaId || null,
      grupo_clinica_id: groupId || null,
      list_id: listId || null,
      item_id: itemId || null,
    },
    ...options,
  });
  return `${unsubscribeBaseUrl()}/email/baja?token=${encodeURIComponent(raw)}`;
}

async function unsubscribe(rawToken) {
  const token = clean(rawToken);
  if (!token || !/^[A-Za-z0-9_-]{40,80}$/.test(token)) fail('unsubscribe_token_invalid', 400, 'El enlace de baja no es válido.');
  const row = await db.MarketingEmailUnsubscribe.findOne({ where: { token_hash: emailDelivery.sha256(token) } });
  if (!row) fail('unsubscribe_token_invalid', 404, 'El enlace de baja no es válido.');
  if (row.status === 'unsubscribed') return { success: true, already_unsubscribed: true };
  await db.sequelize.transaction(async transaction => {
    await row.update({ status: 'unsubscribed', unsubscribed_at: new Date() }, { transaction });
    const suppressionScope = row.grupo_clinica_id
      ? `group:${row.grupo_clinica_id}`
      : (row.clinica_id ? `clinic:${row.clinica_id}` : 'global');
    await db.EmailSuppression.findOrCreate({
      where: { email_hash: row.email_hash, stream: 'marketing', scope: suppressionScope, status: 'active' },
      defaults: { reason: 'unsubscribe', source: 'marketing_unsubscribe', clinica_id: row.clinica_id || null, suppressed_at: new Date() },
      transaction,
    });
    if (row.item_id) await db.MarketingPatientListItem.update({ opt_out_at: new Date() }, { where: { id: row.item_id }, transaction });
  });
  return { success: true, already_unsubscribed: false };
}

function providerCostEstimate(recipientCount) {
  const parsedCount = Number(recipientCount || 0);
  const parsedUnitCost = Number(process.env.EMAIL_SES_ESTIMATED_USD_PER_1000 || 0.16);
  const count = Number.isFinite(parsedCount) ? Math.max(0, parsedCount) : 0;
  const usdPerThousand = Number.isFinite(parsedUnitCost) && parsedUnitCost >= 0 ? parsedUnitCost : 0.16;
  return {
    provider: 'aws_ses',
    currency: 'USD',
    recipients: count,
    unit: '1000_emails',
    unit_cost: usdPerThousand,
    estimated_cost: Number(((count / 1000) * usdPerThousand).toFixed(4)),
    informational: true,
    excludes_data_and_optional_features: true,
    pricing_basis: 'Amazon SES Essentials, primer tramo',
    pricing_url: 'https://aws.amazon.com/ses/pricing/',
  };
}

function whatsappProviderCostEstimate(recipientCount, rawCategory = 'marketing') {
  const parsedCount = Number(recipientCount || 0);
  const count = Number.isFinite(parsedCount) ? Math.max(0, parsedCount) : 0;
  const normalized = String(rawCategory || '').trim().toLowerCase();
  const category = normalized === 'authentication' ? 'authentication'
    : (normalized === 'utility' ? 'utility' : 'marketing');
  const defaults = { marketing: 0.0509, utility: 0.0166, authentication: 0.0166 };
  const envKeys = {
    marketing: 'WHATSAPP_META_MARKETING_EUR_PER_MESSAGE_ES',
    utility: 'WHATSAPP_META_UTILITY_EUR_PER_MESSAGE_ES',
    authentication: 'WHATSAPP_META_AUTHENTICATION_EUR_PER_MESSAGE_ES',
  };
  const configured = Number(process.env[envKeys[category]]);
  const unitCost = Number.isFinite(configured) && configured >= 0 ? configured : defaults[category];
  return {
    provider: 'meta_whatsapp',
    currency: 'EUR',
    recipients: count,
    category,
    market: 'ES',
    unit: 'delivered_message',
    unit_cost: unitCost,
    estimated_cost: Number((count * unitCost).toFixed(4)),
    informational: true,
    billed_on_delivery: true,
    pricing_basis: 'Tarifa de Meta para destinatarios de España',
    pricing_url: 'https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing',
  };
}

module.exports = {
  DEFAULT_DESIGN,
  defaultDesignForScope,
  scopeDescriptor,
  listSettings,
  addDomain,
  refreshDomain,
  addSender,
  setDefaultSender,
  listTemplates,
  saveTemplate,
  duplicateTemplate,
  getTemplate,
  listCatalogTemplates,
  saveCatalogTemplate,
  duplicateCatalogTemplate,
  setCatalogTemplateActive,
  propagateCatalogTemplate,
  issueUnsubscribe,
  unsubscribe,
  providerCostEstimate,
  whatsappProviderCostEstimate,
  renderTemplateDocument,
  dnsRecords,
  dnsStatus,
  serializeSender,
  serializeTemplate,
};
