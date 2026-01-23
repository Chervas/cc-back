'use strict';
const { Queue, Worker, QueueEvents } = require('bullmq');

const connection = {
    connection: {
        url: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
    },
};

const queues = {
    outboundWhatsApp: new Queue('outbound_whatsapp', connection),
    webhookWhatsApp: new Queue('webhook_whatsapp', connection),
};

function createWorker(name, processor) {
    const worker = new Worker(name, processor, connection);
    const events = new QueueEvents(name, connection);
    events.on('failed', ({ jobId, failedReason }) => {
        console.error(`[Queue ${name}] Job ${jobId} failed: ${failedReason}`);
    });
    events.on('completed', ({ jobId }) => {
        console.log(`[Queue ${name}] Job ${jobId} completed`);
    });
    return { worker, events };
}

module.exports = {
    queues,
    createWorker,
    connection,
};
