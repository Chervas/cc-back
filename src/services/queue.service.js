'use strict';
const { Queue, Worker, QueueEvents } = require('bullmq');

const queuePrefix = String(process.env.QUEUE_PREFIX || '').trim();

const queueOptions = {
    connection: {
        url: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
    },
};

if (queuePrefix) {
    queueOptions.prefix = queuePrefix;
}

const queues = {
    outboundWhatsApp: new Queue('outbound_whatsapp', queueOptions),
    webhookWhatsApp: new Queue('webhook_whatsapp', queueOptions),
    whatsappTemplateCreate: new Queue('whatsapp_template_create', queueOptions),
    whatsappTemplateSync: new Queue('whatsapp_template_sync', queueOptions),
    whatsappPhoneSync: new Queue('whatsapp_phone_sync', queueOptions),
    automationDefaults: new Queue('automation_defaults', queueOptions),
};

function createWorker(name, processor) {
    const worker = new Worker(name, processor, queueOptions);
    const events = new QueueEvents(name, queueOptions);
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
    connection: queueOptions,
};
