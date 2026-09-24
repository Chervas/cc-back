'use strict';

const MAX_SUBJECT_LENGTH = 160;

function cleanString(value) {
  const normalized = String(value || '').trim();
  return normalized || null;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function stripHtml(value) {
  return String(value || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function replaceVars(template, context = {}, { html = false } = {}) {
  return String(template || '').replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_match, path) => {
    const value = String(path).split('.').reduce((acc, key) => (
      acc && Object.prototype.hasOwnProperty.call(acc, key) ? acc[key] : undefined
    ), context);
    if (value === undefined || value === null) return '';
    return html ? escapeHtml(value) : String(value);
  });
}

function templateVariables(...templates) {
  const variables = new Set();
  for (const template of templates) {
    for (const match of String(template || '').matchAll(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g)) {
      variables.add(match[1]);
    }
  }
  return [...variables];
}

function missingTemplateVariables(context = {}, ...templates) {
  return templateVariables(...templates).filter(path => {
    const value = String(path).split('.').reduce((acc, key) => (
      acc && Object.prototype.hasOwnProperty.call(acc, key) ? acc[key] : undefined
    ), context);
    return value === undefined || value === null || String(value).trim() === '';
  });
}

function assertSafeSubject(subject) {
  const normalized = String(subject || '').replace(/\s+/g, ' ').trim();
  if (!normalized) {
    const error = new Error('email_subject_required');
    error.code = 'email_subject_required';
    throw error;
  }
  if (normalized.length > MAX_SUBJECT_LENGTH) {
    const error = new Error('email_subject_too_long');
    error.code = 'email_subject_too_long';
    throw error;
  }
  const forbiddenPatterns = [
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
    /\b(?:\+?\d[\s().-]?){9,}\b/,
    /\b\d{8}[A-Z]\b/i,
    /\b(?:diagn[oó]stico|tratamiento|presupuesto|cirug[ií]a|implante|historia cl[ií]nica)\b/i,
  ];
  if (forbiddenPatterns.some((pattern) => pattern.test(normalized))) {
    const error = new Error('email_subject_contains_sensitive_detail');
    error.code = 'email_subject_contains_sensitive_detail';
    throw error;
  }
  return normalized;
}

function layout({ title, intro, code, detail, ctaLabel, ctaUrl, footer }) {
  const safeTitle = escapeHtml(title);
  const safeIntro = escapeHtml(intro);
  const safeCta = escapeHtml(ctaLabel);
  const safeUrl = escapeHtml(ctaUrl);
  const safeFooter = escapeHtml(footer || 'ClinicaClick');
  return [
    '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>', safeTitle, '</title></head>',
    '<body style="margin:0;background:#f6f7fb;font-family:Arial,Helvetica,sans-serif;color:#172033;">',
    '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f6f7fb;padding:32px 12px;"><tr><td align="center">',
    '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#ffffff;border:1px solid #e6e8ef;border-radius:8px;">',
    '<tr><td style="padding:28px 28px 10px;font-size:20px;font-weight:700;">', safeTitle, '</td></tr>',
    '<tr><td style="padding:0 28px 22px;font-size:15px;line-height:1.55;color:#465064;">', safeIntro, '</td></tr>',
    code ? '<tr><td align="center" style="padding:0 28px 24px;"><div style="background:#eff6ff;border:1px solid #dbeafe;border-radius:8px;padding:20px;font-family:monospace;font-size:34px;font-weight:700;letter-spacing:6px;color:#172554;">' + escapeHtml(code) + '</div></td></tr>' : '',
    detail ? '<tr><td style="padding:0 28px 24px;font-size:14px;line-height:1.55;color:#465064;">' + escapeHtml(detail) + '</td></tr>' : '',
    ctaUrl ? '<tr><td style="padding:0 28px 28px;"><a href="' + safeUrl + '" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;border-radius:6px;padding:12px 18px;font-weight:700;">' + safeCta + '</a></td></tr>' : '',
    '<tr><td style="border-top:1px solid #edf0f5;padding:16px 28px;font-size:12px;line-height:1.5;color:#6b7280;">', safeFooter, '</td></tr>',
    '</table></td></tr></table></body></html>',
  ].join('');
}

function renderPasswordReset(context = {}) {
  const resetUrl = cleanString(context.reset_url);
  if (!resetUrl) {
    const error = new Error('password_reset_url_required');
    error.code = 'password_reset_url_required';
    throw error;
  }
  const subject = assertSafeSubject('Restablece tu contraseña de ClinicaClick');
  const intro = 'Hemos recibido una solicitud para restablecer la contraseña de tu cuenta. El enlace caduca en unos minutos y solo puede usarse una vez.';
  return {
    subject,
    html: layout({
      title: subject,
      intro,
      ctaLabel: 'Restablecer contraseña',
      ctaUrl: resetUrl,
      footer: 'Si no has solicitado este cambio, puedes ignorar este correo.',
    }),
    text: `${intro}\n\n${resetUrl}\n\nSi no has solicitado este cambio, puedes ignorar este correo.`,
  };
}

function renderEmailVerification(context = {}) {
  const code = context.verification_code;
  if (typeof code !== 'string' || !/^[0-9]{6}$/.test(code)) {
    throw Object.assign(Error('email_verification_code_invalid'), { code: 'email_verification_code_invalid' });
  }
  const subject = assertSafeSubject('Tu código de acceso a ClinicaClick');
  const intro = 'Introduce este código para completar el acceso:';
  const detail = 'Caduca en 5 minutos y solo puede usarse una vez.';
  const footer = 'No compartas este código. Si no has intentado acceder, cambia tu contraseña desde ClinicaClick.';
  return { subject, html: layout({ title: subject, intro, code, detail, footer }), text: [intro, code, detail, footer].join('\n\n') };
}

function renderOpsTest(context = {}) {
  const subject = assertSafeSubject(cleanString(context.subject) || 'Prueba técnica de email ClinicaClick');
  const body = cleanString(context.body) || 'Este correo valida la cola durable, el proveedor y la monitorización de email.';
  return {
    subject,
    html: layout({
      title: subject,
      intro: body,
      ctaLabel: null,
      ctaUrl: null,
      footer: 'Correo técnico enviado desde un entorno controlado.',
    }),
    text: body,
  };
}

function renderOpsSystemAlert(context = {}) {
  const severity = cleanString(context.severity) || 'info';
  const title = cleanString(context.title) || 'Alerta operativa';
  const message = cleanString(context.message) || 'Se ha detectado un evento operativo en Clinicaclick.';
  const action = cleanString(context.action) || 'Revisar Monitorización del sistema.';
  const occurredAt = cleanString(context.occurred_at) || '';
  const subject = assertSafeSubject('[Clinicaclick] Alerta operativa');
  const body = [
    `${title}`,
    `Severidad: ${severity}`,
    message,
    occurredAt ? `Hora: ${occurredAt}` : null,
    `Acción: ${action}`,
  ].filter(Boolean).join('\n');
  return {
    subject,
    html: layout({
      title: subject,
      intro: body,
      ctaLabel: null,
      ctaUrl: null,
      footer: 'Notificación técnica para administradores. No incluye datos clínicos sensibles.',
    }),
    text: body,
  };
}

function renderAutomationGeneric(context = {}) {
  const subject = assertSafeSubject(cleanString(context.subject) || 'Mensaje de ClinicaClick');
  const html = cleanString(context.body_html);
  const text = cleanString(context.body_text) || stripHtml(html || '');
  if (!html && !text) {
    const error = new Error('automation_email_body_required');
    error.code = 'automation_email_body_required';
    throw error;
  }
  return {
    subject,
    html: html || `<p>${escapeHtml(text)}</p>`,
    text,
  };
}

function renderMarketingCampaign(context = {}) {
  const subject = assertSafeSubject(cleanString(context.subject) || 'Novedades de tu clínica');
  const bodyHtml = cleanString(context.body_html);
  const bodyText = cleanString(context.body_text) || stripHtml(bodyHtml || '');
  const unsubscribeUrl = cleanString(context.unsubscribe_url);
  const preheader = cleanString(context.preheader);
  const showBranding = context.show_clinicaclick_branding !== false;
  if ((!bodyHtml && !bodyText) || !unsubscribeUrl || !/^https:\/\//i.test(unsubscribeUrl)) {
    const error = new Error('marketing_email_body_or_unsubscribe_invalid');
    error.code = 'marketing_email_body_or_unsubscribe_invalid';
    throw error;
  }
  const branding = showBranding
    ? [
      '<div style="margin-top:10px">',
      '<img src="https://crm.clinicaclick.com/assets/images/logo/isotipo-email.png" alt="Clinicaclick" width="18" height="18" style="display:inline-block;width:18px;height:18px;margin-right:6px;vertical-align:middle;border:0">',
      '<span style="vertical-align:middle">Enviado con Clinicaclick</span></div>',
    ].join('')
    : '';
  const footer = [
    '<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td style="padding:20px 24px;text-align:center;font:12px/1.5 Arial,sans-serif;color:#64748b">',
    '<a href="', escapeHtml(unsubscribeUrl), '" style="color:#475569;text-decoration:underline">Dejar de recibir estas comunicaciones</a>',
    branding,
    '</td></tr></table>',
  ].join('');
  const preheaderHtml = preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${escapeHtml(preheader)}</div>`
    : '';
  const html = bodyHtml
    ? bodyHtml.replace(/<body([^>]*)>/i, `<body$1>${preheaderHtml}`).replace(/<\/body>\s*<\/html>\s*$/i, `${footer}</body></html>`)
    : `<!doctype html><html><body>${preheaderHtml}<p>${escapeHtml(bodyText)}</p>${footer}</body></html>`;
  return {
    subject,
    html: html.includes('Dejar de recibir estas comunicaciones') ? html : `${html}${footer}`,
    text: `${bodyText}\n\nDejar de recibir estas comunicaciones: ${unsubscribeUrl}${showBranding ? '\nEnviado con Clinicaclick' : ''}`,
  };
}

function renderTemplate(templateKey, context = {}) {
  switch (String(templateKey || '').trim()) {
    case 'auth.password_reset':
      return renderPasswordReset(context);
    case 'auth.email_verification':
      return renderEmailVerification(context);
    case 'ops.email_test':
      return renderOpsTest(context);
    case 'ops.system_alert':
      return renderOpsSystemAlert(context);
    case 'automation.generic':
      return renderAutomationGeneric(context);
    case 'marketing.campaign':
      return renderMarketingCampaign(context);
    default: {
      const error = new Error('email_template_not_supported');
      error.code = 'email_template_not_supported';
      throw error;
    }
  }
}

module.exports = {
  renderTemplate,
  assertSafeSubject,
  replaceVars,
  templateVariables,
  missingTemplateVariables,
  stripHtml,
  renderMarketingCampaign,
};
