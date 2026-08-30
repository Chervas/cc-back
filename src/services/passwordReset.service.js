'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { Op } = require('sequelize');
const db = require('../../models');
const emailDelivery = require('./emailDelivery.service');

const TOKEN_BYTES = 32;

function cleanString(value) {
  const normalized = String(value || '').trim();
  return normalized || null;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function normalizeEmail(email) {
  return emailDelivery.normalizeEmail(email);
}

function frontendBaseUrl() {
  return (cleanString(process.env.EMAIL_PUBLIC_APP_URL)
    || cleanString(process.env.FRONTEND_PUBLIC_URL)
    || 'http://localhost:4203').replace(/\/+$/, '');
}

function ttlMinutes() {
  const configured = Number(process.env.EMAIL_PASSWORD_RESET_TTL_MINUTES || 30);
  return Number.isFinite(configured) && configured >= 5 ? configured : 30;
}

function resetRequestLimits() {
  return {
    minIntervalSeconds: Math.max(15, Number(process.env.EMAIL_PASSWORD_RESET_MIN_INTERVAL_SECONDS || 60) || 60),
    maxPerUserHour: Math.max(1, Number(process.env.EMAIL_PASSWORD_RESET_MAX_PER_HOUR || 5) || 5),
    maxPerIpHour: Math.max(1, Number(process.env.EMAIL_PASSWORD_RESET_IP_MAX_PER_HOUR || 20) || 20),
  };
}

function hashAuditValue(value) {
  const normalized = cleanString(value);
  if (!normalized) return null;
  const salt = cleanString(process.env.EMAIL_AUDIT_HASH_SALT) || 'clinicaclick-email-audit';
  return sha256(`${salt}:${normalized}`);
}

function issueRawToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString('base64url');
}

function tokenHash(rawToken) {
  return sha256(cleanString(rawToken) || '');
}

function resetUrl(rawToken) {
  return `${frontendBaseUrl()}/reset-password?token=${encodeURIComponent(rawToken)}`;
}

async function requestPasswordReset({ email, requestIp = null, userAgent = null } = {}) {
  const normalizedEmail = normalizeEmail(email);
  const requestIpHash = hashAuditValue(requestIp);
  const userAgentHash = hashAuditValue(userAgent);
  const limits = resetRequestLimits();

  return db.sequelize.transaction(async (transaction) => {
    const user = await db.Usuario.findOne({
      where: { email_usuario: normalizedEmail },
      attributes: ['id_usuario', 'email_usuario', 'estado_cuenta'],
      transaction,
      ...(transaction?.LOCK?.UPDATE ? { lock: transaction.LOCK.UPDATE } : {}),
    });
    if (!user || String(user.estado_cuenta || 'activo') === 'suspendido') {
      return { queued: false, reason: 'user_not_found_or_inactive' };
    }

    const now = new Date();
    const sinceHour = new Date(now.getTime() - 60 * 60 * 1000);
    const minIntervalCutoff = new Date(now.getTime() - limits.minIntervalSeconds * 1000);
    const [recentForUser, recentForIp] = await Promise.all([
      db.PasswordResetToken.count({
        where: { user_id: user.id_usuario, requested_at: { [Op.gte]: sinceHour } },
        transaction,
      }),
      requestIpHash
        ? db.PasswordResetToken.count({
          where: { request_ip_hash: requestIpHash, requested_at: { [Op.gte]: sinceHour } },
          transaction,
        })
        : Promise.resolve(0),
    ]);
    const tooRecent = await db.PasswordResetToken.count({
      where: { user_id: user.id_usuario, requested_at: { [Op.gte]: minIntervalCutoff } },
      transaction,
    });
    if (tooRecent > 0 || recentForUser >= limits.maxPerUserHour || recentForIp >= limits.maxPerIpHour) {
      return { queued: false, reason: 'rate_limited' };
    }

    const rawToken = issueRawToken();
    const hash = tokenHash(rawToken);
    const emailHash = emailDelivery.hashEmail(normalizedEmail);
    const expiresAt = new Date(now.getTime() + ttlMinutes() * 60 * 1000);

    await db.PasswordResetToken.update({
      status: 'revoked',
      updated_at: new Date(),
    }, {
      where: {
        user_id: user.id_usuario,
        status: 'pending',
        expires_at: { [Op.gt]: now },
      },
      transaction,
    });

    const tokenRow = await db.PasswordResetToken.create({
      user_id: user.id_usuario,
      token_hash: hash,
      token_prefix: rawToken.slice(0, 8),
      email_hash: emailHash,
      status: 'pending',
      expires_at: expiresAt,
      request_ip_hash: requestIpHash,
      user_agent_hash: userAgentHash,
    }, { transaction });

    const queued = await emailDelivery.queueEmail({
      stream: 'transactional',
      templateKey: 'auth.password_reset',
      templateVersion: 'v1',
      subjectKey: 'auth.password_reset',
      recipientEmail: normalizedEmail,
      recipientKind: 'user',
      usuarioId: user.id_usuario,
      relatedType: 'password_reset_token',
      relatedId: String(tokenRow.id),
      dedupeKey: `auth.password_reset:${tokenRow.id}`,
      priority: 'high',
      origin: 'auth.forgot_password',
      templateContext: {
        password_reset_token_id: tokenRow.id,
        reset_url: resetUrl(rawToken),
        expires_minutes: ttlMinutes(),
      },
      metadata: {
        contains_clinical_data: false,
        use_case: 'password_reset',
      },
    }, { transaction });

    await tokenRow.update({ email_message_id: queued.emailMessage.id }, { transaction });
    return {
      queued: true,
      tokenId: tokenRow.id,
      emailMessageId: queued.emailMessage.id,
      jobRequestId: queued.job?.id || queued.emailMessage.job_request_id || null,
      expiresAt,
    };
  });
}

async function consumePasswordResetToken({ token, password } = {}) {
  const rawToken = cleanString(token);
  if (!rawToken) {
    const error = new Error('password_reset_token_required');
    error.code = 'password_reset_token_required';
    error.status = 400;
    throw error;
  }
  const nextPassword = String(password || '');
  if (nextPassword.length < 8) {
    const error = new Error('password_min_length');
    error.code = 'password_min_length';
    error.status = 400;
    throw error;
  }

  return db.sequelize.transaction(async (transaction) => {
    const tokenRow = await db.PasswordResetToken.findOne({
      where: { token_hash: tokenHash(rawToken) },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!tokenRow || tokenRow.status !== 'pending') {
      const error = new Error('password_reset_token_invalid');
      error.code = 'password_reset_token_invalid';
      error.status = 400;
      throw error;
    }
    if (new Date(tokenRow.expires_at).getTime() <= Date.now()) {
      await tokenRow.update({ status: 'expired' }, { transaction });
      const error = new Error('password_reset_token_expired');
      error.code = 'password_reset_token_expired';
      error.status = 400;
      throw error;
    }

    const user = await db.Usuario.findByPk(tokenRow.user_id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!user) {
      const error = new Error('password_reset_user_not_found');
      error.code = 'password_reset_user_not_found';
      error.status = 400;
      throw error;
    }

    const hashedPassword = await bcrypt.hash(nextPassword, 8);
    user.setDataValue('password_usuario', hashedPassword);
    await user.save({ fields: ['password_usuario'], transaction });
    await tokenRow.update({ status: 'used', used_at: new Date() }, { transaction });
    await db.PasswordResetToken.update({
      status: 'revoked',
      updated_at: new Date(),
    }, {
      where: {
        user_id: user.id_usuario,
        status: 'pending',
        id: { [Op.ne]: tokenRow.id },
      },
      transaction,
    });

    return { userId: user.id_usuario };
  });
}

module.exports = {
  requestPasswordReset,
  consumePasswordResetToken,
  tokenHash,
  resetUrl,
  resetRequestLimits,
};
