'use strict';
const Redis = require('ioredis');

let ioInstance = null;
let publisher = null;
let subscriber = null;
let subscriberInitialized = false;
let confirmedPublisher = null;
let backgroundPublishingEnabled = false;
const busListeners = new Set();

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const SOCKET_BUS_CHANNEL =
    process.env.SOCKET_BUS_CHANNEL ||
    `clinicaclick:socket:events:${process.env.DB_NAME || 'default'}`;
const SOCKET_BUS_SOURCE = `${process.pid}:${process.cwd()}`;

function normalizeRooms(rooms) {
    if (!rooms) {
        return [];
    }

    const list = Array.isArray(rooms) ? rooms : [rooms];
    return Array.from(
        new Set(
            list
                .map((room) => (room == null ? null : String(room).trim()))
                .filter((room) => !!room)
        )
    );
}

function emitLocal(event, payload, rooms = []) {
    if (!ioInstance) {
        return;
    }

    const roomList = normalizeRooms(rooms);
    if (!roomList.length) {
        ioInstance.emit(event, payload);
        return;
    }

    roomList.forEach((room) => {
        ioInstance.to(room).emit(event, payload);
    });
}

function getPublisher() {
    if (!publisher) {
        publisher = new Redis(REDIS_URL, {
            maxRetriesPerRequest: null,
            enableReadyCheck: false,
        });
        publisher.on('error', (error) => {
            console.warn('[socket-bus] publisher error:', error?.message || error);
        });
    }
    return publisher;
}

function ensureSubscriber() {
    if (subscriberInitialized) {
        return;
    }

    subscriber = new Redis(REDIS_URL, {
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
    });
    subscriber.on('error', (error) => {
        console.warn('[socket-bus] subscriber error:', error?.message || error);
    });
    subscriber.on('message', (channel, rawPayload) => {
        if (channel !== SOCKET_BUS_CHANNEL) {
            return;
        }
        try {
            const envelope = JSON.parse(rawPayload);
            if (!envelope || envelope.source === SOCKET_BUS_SOURCE) {
                return;
            }
            emitLocal(envelope.event, envelope.payload, envelope.rooms);
            busListeners.forEach((listener) => {
                try {
                    listener(envelope);
                } catch (error) {
                    console.warn('[socket-bus] listener error:', error?.message || error);
                }
            });
        } catch (error) {
            console.warn('[socket-bus] invalid payload:', error?.message || error);
        }
    });
    subscriber.subscribe(SOCKET_BUS_CHANNEL).catch((error) => {
        console.warn('[socket-bus] subscribe failed:', error?.message || error);
    });
    subscriberInitialized = true;
}

function publish(event, payload, rooms = []) {
    const roomList = normalizeRooms(rooms);
    getPublisher()
        .publish(
            SOCKET_BUS_CHANNEL,
            JSON.stringify({
                source: SOCKET_BUS_SOURCE,
                event,
                payload,
                rooms: roomList,
            })
        )
        .catch((error) => {
            console.warn('[socket-bus] publish failed:', error?.message || error);
        });
}

function emitThroughBus(event, payload, rooms = []) {
    emitLocal(event, payload, rooms);
    publish(event, payload, rooms);
}

const ioProxy = {
    emit(event, payload) {
        emitThroughBus(event, payload);
        return ioProxy;
    },
    to(room) {
        const roomList = normalizeRooms(room);
        return {
            emit(event, payload) {
                emitThroughBus(event, payload, roomList);
                return ioProxy;
            },
        };
    },
};

module.exports = {
    async publishConfirmed(event, payload, rooms) {
        // Background importers have no Socket.IO instance. Publish a closed
        // browser packet and acknowledge Redis before marking their outbox.
        const body = require('../lib/socket-view-invalidation').invalidation(event, payload);
        const roomList = normalizeRooms(rooms);
        if (!roomList.length || roomList.some(room => !/^clinic:[1-9]\d*$/.test(room))) {
            throw Error('realtime_packet_invalid');
        }
        if (!confirmedPublisher) {
            confirmedPublisher = new Redis(REDIS_URL, {
                lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 1,
                connectTimeout: 3000, commandTimeout: 3000,
            });
            confirmedPublisher.on('error', () => {});
        }
        if (confirmedPublisher.status === 'wait') await confirmedPublisher.connect();
        if (confirmedPublisher.status !== 'ready') throw Error('realtime_bus_unavailable');
        const subscribers = await confirmedPublisher.publish(SOCKET_BUS_CHANNEL, JSON.stringify({
            source: SOCKET_BUS_SOURCE, event: 'message:refresh', payload: body, rooms: roomList,
        }));
        if (!Number.isInteger(subscribers) || subscribers < 1) throw Error('realtime_bus_unavailable');
        emitLocal('message:refresh', body, roomList);
        return subscribers;
    },
    setIO(io) {
        ioInstance = io;
        ensureSubscriber();
    },
    getIO() {
        return ioInstance || backgroundPublishingEnabled ? ioProxy : null;
    },
    enableBackgroundPublishing() {
        // Opt-in for the authorized staging dispatcher; existing read-only
        // scripts and other isolated processes keep their previous behavior.
        backgroundPublishingEnabled = true;
    },
    emit(event, payload, rooms = []) {
        emitThroughBus(event, payload, rooms);
    },
    onBusEvent(listener) {
        if (typeof listener !== 'function') {
            return () => {};
        }
        busListeners.add(listener);
        return () => {
            busListeners.delete(listener);
        };
    },
};
