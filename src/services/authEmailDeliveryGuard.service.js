'use strict';
const C = require('./authEmailChallenge.contract');
const sessions = require('./accessSession.service');
async function mayDeliver(message, recipient, context, { models, config = C.settings, sessionService = sessions, now = () => new Date() } = {}) {
  if (message.template_key !== 'auth.email_verification') return true;
  const cfg = config();
  if (cfg.mode !== 'enforce' || message.related_type !== 'auth_email_challenge' || !C.code(context.verification_code)) return false;
  const db = models || require('../../models');
  const row = await db.AuthEmailChallenge.findByPk(message.related_id, { raw: true, logging: false });
  if (!row || row.challenge_id !== context.auth_email_challenge_id || row.state !== 'pending'
    || Number(row.email_message_id) !== Number(message.id) || row.expires_at.getTime() <= now().getTime()
    || row.absolute_expires_at.getTime() <= now().getTime() || row.attempts >= C.LIMITS.maxAttempts
    || row.email_hash !== message.recipient_hash || !C.equalHash(row.code_hash, C.codeHash(cfg.key, row.challenge_id, context.verification_code))) return false;
  const user = await db.Usuario.findByPk(row.user_id, { attributes: ['id_usuario', 'email_usuario', 'password_usuario', 'estado_cuenta', 'es_provisional'], raw: true, logging: false });
  return sessions.activeUser(user) && String(user.email_usuario).trim().toLowerCase() === String(recipient).trim().toLowerCase()
    && C.equalHash(row.credential_binding, sessionService.credentialBinding(user));
}
module.exports = { mayDeliver };
