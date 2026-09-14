'use strict';
const { mode } = require('./authEmailChallenge.contract');

// The generic profile editors cannot transfer the mailbox used for login or
// replace the password. Password reset must prove access to the existing mailbox.
async function guardCredentialMutation(user, body, res) {
  try {
    if (mode() !== 'enforce') return false;
    const changesEmail = Object.hasOwn(body, 'email_usuario') && body.email_usuario !== user.email_usuario;
    if (!changesEmail && !body.password_usuario) return false;
    await require('./authEmailChallenge.service').rejectedCredentialMutation(user.id_usuario);
    res.status(409).json({ error: 'auth_credentials_recovery_required',
      message: 'El correo de acceso se cambia mediante recuperación asistida. Para la contraseña, utiliza Recuperar contraseña.' });
  } catch {
    res.status(503).json({ error: 'auth_email_unavailable' });
  }
  return true;
}
module.exports = { guardCredentialMutation };
