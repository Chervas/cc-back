'use strict';
const { packetFor } = require('./socket-payload');
const instances = new WeakMap();
function installRealtimeAccess(io, { policy = require('../services/socketAccess.service'), audit = require('../services/platformAudit.realtime'),
  verify = require('./socket-session-guard').verifySocketSession, timeoutMs = 5000, concurrency = 8, maxPending = 128, maxPerSocket = 32 } = {}) {
  const states = new WeakMap(); const queue = []; let active = 0; let pending = 0;
  const valid = state => state.socket.connected && !state.closed;
  function pump() {
    while (active < concurrency && queue.length) {
      const index = queue.findIndex(item => !item.state.running);
      if (index < 0) return;
      const [item] = queue.splice(index, 1); const { state, run } = item;
      if (!valid(state) || Date.now() >= item.deadline) { state.pending--; pending--; state.socket.disconnect(true); continue; }
      active++; state.running = true; let expired = false;
      const timer = setTimeout(() => { expired = true; state.socket.disconnect(true); }, Math.max(0, item.deadline - Date.now())); timer.unref?.();
      // A timed-out SQL task retains its slot until it settles: no unbounded orphan queries.
      const alive = () => !expired && valid(state) && Date.now() < item.deadline;
      Promise.resolve().then(() => run(alive)).catch(() => state.socket.disconnect(true)).finally(() => {
        clearTimeout(timer); active--; pending--; state.pending--; state.running = false; pump();
      });
    }
  }
  function enqueue(state, run) {
    if (!valid(state)) return;
    if (pending >= maxPending || state.pending >= maxPerSocket) { state.socket.disconnect(true); return; }
    state.pending++; pending++;
    queue.push({ state, run, deadline: Date.now() + timeoutMs }); pump();
  }
  function schedule(state, work) {
    enqueue(state, work);
  }
  function interested(state, rooms, descriptor) {
    if (!descriptor) return false;
    const selected = descriptor.clinicIds.some(id => state.clinics.has(id));
    if (!rooms.length) return selected; // No platform-wide browser broadcast.
    return rooms.some(room => room === `user:${state.actorId}`
      || /^clinic:[1-9]\d*$/.test(room) && state.clinics.has(Number(room.slice(7))) && descriptor.clinicIds.includes(Number(room.slice(7))));
  }
  function subscribe(state, requested, ack) {
    const generation = ++state.generation;
    // Clear synchronously, before any asynchronous authorization of a replacement subscription.
    state.clinics.clear();
    for (const room of state.socket.rooms) if (room.startsWith('clinic:')) state.socket.leave(room);
    schedule(state, async alive => {
      const actor = await verify(state.socket); if (!alive()) return;
      const result = await audit.run(actor, { action: 'realtime.subscribe', scope: { type: 'platform', id: null },
        resource: { type: 'subscription', id: null }, socketEvent: null }, () => policy.subscription(actor.userId, requested));
      if (!alive() || generation !== state.generation) return;
      // Audit persistence may have waited behind a permission change: resolve again before joining.
      await verify(state.socket);
      const final = result.allowed ? await policy.subscription(actor.userId, requested) : result;
      if (!alive() || generation !== state.generation) return;
      const ready = final.allowed && JSON.stringify(final.clinicIds) === JSON.stringify(result.clinicIds);
      if (ready) {
        state.clinics = new Set(final.clinicIds);
        for (const clinicId of final.clinicIds) {
          if (!alive() || generation !== state.generation) return;
          await state.socket.join(`clinic:${clinicId}`);
        }
      }
      if (!alive() || generation !== state.generation) return;
      if (typeof ack === 'function') ack({ status: ready ? 'ready' : final.invalid ? 'invalid' : 'denied', clinicIds: [...state.clinics] });
    });
  }
  io.on('connection', socket => {
    if (!socket.connected) return;
    const state = { socket, actorId: Number(socket.userData?.userId), clinics: new Set(), pending: 0, generation: 0, closed: false, running: false };
    states.set(socket, state);
    socket.once('disconnect', () => { state.closed = true; state.clinics.clear(); });
    socket.on('subscribe', (requested = [], ack) => subscribe(state, requested, ack));
    // User rooms are destination hints only; every packet still requires current session and scope checks.
    socket.join(`user:${state.actorId}`);
    subscribe(state, []);
  });
  function deliver(event, payload, rooms = []) {
    let packet;
    try { packet = packetFor(event, payload); } catch { return; }
    if (!packet) return;
    const roomList = Array.isArray(rooms) ? rooms : [rooms];
    for (const socket of io.sockets.sockets.values()) {
      const state = states.get(socket); if (!state || !valid(state)) continue;
      if (roomList.length && !roomList.some(room => room === `user:${state.actorId}` || state.clinics.has(Number(/^clinic:([1-9]\d*)$/.exec(room)?.[1])))) continue;
      const generation = state.generation;
      // Snapshot only the closed projection, never retain the original producer envelope.
      const localPacket = structuredClone(packet);
      schedule(state, async alive => {
        if (generation !== state.generation) return;
        const actor = await verify(socket); if (!alive()) return;
        const result = await audit.run(actor, { action: 'realtime.read', resource: localPacket.resource,
          socketEvent: event, scope: { type: 'platform', id: null } }, async () => {
          const descriptor = await policy.resolve(localPacket);
          const allowed = interested(state, roomList, descriptor) && await policy.authorize(actor.userId, descriptor);
          return { allowed, clinicIds: allowed ? descriptor.clinicIds : [], scope: descriptor?.scope, descriptor };
        });
        if (!result.allowed || !alive() || generation !== state.generation) return;
        await verify(socket);
        const latest = await policy.resolve(localPacket);
        if (!interested(state, roomList, latest) || JSON.stringify(latest) !== JSON.stringify(result.descriptor)
          || !await policy.authorize(actor.userId, latest) || !alive() || generation !== state.generation) return;
        socket.emit(event, localPacket.body);
      });
    }
  }
  const value = { deliver, pending: () => pending }; instances.set(io, value); return value;
}
function deliverRealtime(io, ...args) { instances.get(io)?.deliver(...args); }
module.exports = { installRealtimeAccess, deliverRealtime };
