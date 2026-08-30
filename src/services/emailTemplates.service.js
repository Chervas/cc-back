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

function replaceVars(template, context = {}) {
  return String(template || '').replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_match, path) => {
    const value = String(path).split('.').reduce((acc, key) => (
      acc && Object.prototype.hasOwnProperty.call(acc, key) ? acc[key] : undefined
    ), context);
    return value === undefined || value === null ? '' : String(value);
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

function layout({ title, intro, ctaLabel, ctaUrl, footer }) {
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

function renderTemplate(templateKey, context = {}) {
  switch (String(templateKey || '').trim()) {
    case 'auth.password_reset':
      return renderPasswordReset(context);
    case 'ops.email_test':
      return renderOpsTest(context);
    case 'ops.system_alert':
      return renderOpsSystemAlert(context);
    case 'automation.generic':
      return renderAutomationGeneric(context);
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
  stripHtml,
};
