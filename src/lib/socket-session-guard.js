'use strict';
// Every app runtime must deploy this guard before AUTH_SESSION_MODE=enforce.
function installSocketSessionGuard(io, sessions = require('../services/accessSession.service'), { intervalMs = 5000, timeoutMs = 1500 } = {}) {
  const pending = new WeakMap();
  async function verify(token) {
    let timer;
    try { return await Promise.race([sessions.verify(token), new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error('auth_unavailable')), timeoutMs);
    })]); } finally { clearTimeout(timer); }
  }
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token || sessions.bearer(socket.handshake.headers?.authorization);
      const v = await verify(token);
      socket.userData = { userId: v.userId, email: v.email };
      pending.set(socket, { token, exp: v.exp }); next();
    } catch { next(Error('auth_invalid')); }
  });
  io.on('connection', socket => {
    const initial = pending.get(socket); pending.delete(socket);
    if (!initial) { socket.disconnect(true); return; }
    let checking;
    const check = () => checking ||= verify(initial.token).then(() => {
      if (!socket.connected) throw Error('auth_disconnected');
    }).catch(() => { socket.disconnect(true); throw Error('auth_invalid'); }).finally(() => { checking = null; });
    // Incoming packet checks alone would leave outbound room traffic alive after logout.
    const poll = setInterval(() => { check().catch(() => {}); }, intervalMs); poll.unref?.();
    const expiry = setTimeout(() => socket.disconnect(true), Math.max(0, Math.min(2147483647, initial.exp * 1000 - Date.now()))); expiry.unref?.();
    socket.use((_packet, next) => { check().then(() => next(), () => next(Error('auth_invalid'))); });
    socket.once('disconnect', () => { clearInterval(poll); clearTimeout(expiry); });
  });
}
module.exports = { installSocketSessionGuard };
