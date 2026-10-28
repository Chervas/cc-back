'use strict';
const { Queue, Worker, QueueEvents } = require('bullmq');
const Redis = require('ioredis');

const queuePrefix = String(process.env.QUEUE_PREFIX || '').trim();

const queueOptions = {
    // Passing { url } as RedisOptions can silently fall back to port 6379.
    // Give BullMQ an actual client constructed from the configured URL.
    connection: new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
        lazyConnect: true,
        maxRetriesPerRequest: null,
    }),
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

// Keep reserved attribution out of user-supplied queue payloads. Only verified
// server context can produce it; the worker restores it without a user token.
for (const queue of Object.values(queues)) {
    const add = queue.add.bind(queue), addBulk = queue.addBulk.bind(queue);
    queue.add = (name, data, options) => add(name,
        require('../lib/delegationAuditContext').attachJob(data, { kind: 'bull', type: `${queue.name}:${name}` }), options);
    queue.addBulk = jobs => addBulk(jobs.map(job => ({ ...job,
        data: require('../lib/delegationAuditContext').attachJob(job.data, { kind: 'bull', type: `${queue.name}:${job.name}` }),
    })));
}

function createWorker(name, processor) {
    const worker = new Worker(name, job => require('./platformAudit.delegation').runJob(job.data || {}, {
        kind: 'bull', type: `${name}:${job.name}`, jobRef: String(job.id), attempt: Number(job.attemptsMade || 0),
    }, payload => {
        if (payload === job.data) return processor(job);
        const marker = job.data[require('../lib/delegationAuditContext').PAYLOAD_KEY];
        const wrapped = new Proxy(job, { get(target, key) {
            if (key === 'data') return payload;
            if (key === 'updateData') return data => target.updateData({
                ...require('../lib/delegationAuditContext').cleanPayload(data),
                [require('../lib/delegationAuditContext').PAYLOAD_KEY]: marker,
            });
            const value = Reflect.get(target, key);
            return typeof value === 'function' ? value.bind(target) : value;
        } });
        return processor(wrapped);
    }), queueOptions);
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
