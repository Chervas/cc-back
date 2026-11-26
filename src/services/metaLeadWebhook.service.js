'use strict';

const { enqueueMetaLeadNotifications } = require('./metaLeadReception.service');
const fail = code => { throw Object.assign(Error(code), { code }); };
function createMetaLeadWebhookHandlers({ models, reader, env = process.env, enqueue,
  socialVerify, socialAccept, receive = enqueueMetaLeadNotifications } = {}) {
  const dependencies = () => {
    const factory = require('./metaMarketingLeadWebhookReader.service');
    // Disabled/missing ingress configuration closes public aliases before any
    // model bootstrap or query. Injected offline readers own their test gate.
    if (!reader) factory.receiverConfiguration(env);
    const db = models || require('../../models');
    return { models: db, reader: reader || factory.forWebhookModels(db, { env }) };
  };
  const errorResponse = (res, error) => {
    const status = error?.code === 'invalid_signature' ? 401
      : ['invalid_request', 'social_invalid_event', 'meta_lead_invalid_notification'].includes(error?.code) ? 400 : 503;
    res.set('Cache-Control', 'no-store');
    if (status === 503) res.set('Retry-After', '60');
    return res.status(status).json({ success: false, code: status === 401 ? 'meta_lead_signature_invalid'
      : status === 400 ? 'meta_lead_invalid_notification' : 'meta_lead_receipt_unavailable' });
  };
  return {
    async verify(req, res) {
      try {
        const { reader: source } = dependencies();
        const pair = await source.verificationPair();
        const result = await source.read(pair, 'challenge', { mode: req.query['hub.mode'],
          token: req.query['hub.verify_token'], challenge: req.query['hub.challenge'] });
        res.set('Cache-Control', 'no-store');
        return res.status(200).type('text/plain').send(result.challenge);
      } catch (error) { return errorResponse(res, error); }
    },
    async receive(req, res) {
      try {
        const signature = req.headers?.['x-hub-signature-256'];
        const copies = (req.rawHeaders || []).filter((name, index) => index % 2 === 0 && name.toLowerCase() === 'x-hub-signature-256').length;
        if (copies !== 1 || typeof signature !== 'string' || !/^sha256=[a-f0-9]{64}$/.test(signature)) fail('invalid_signature');
        if (!Buffer.isBuffer(req.rawBody) || !req.rawBody.length) fail('meta_lead_invalid_notification');
        if (req.rawBody.length > 65536) return res.status(413).json({ success: false, code: 'meta_lead_notification_too_large' });
        if (String(req.headers?.['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json'
          || !['', 'identity'].includes(String(req.headers?.['content-encoding'] || '').toLowerCase())) {
          return res.status(415).json({ success: false, code: 'meta_lead_notification_type_invalid' });
        }
        let body;
        try { body = JSON.parse(req.rawBody.toString('utf8')); } catch { fail('meta_lead_invalid_notification'); }
        const hasSocial=body?.object==='instagram'||(body?.object==='page'&&Array.isArray(body.entry)&&body.entry.some(e=>e.messaging!==undefined));
        const hasForms=body?.object==='page'&&Array.isArray(body.entry)&&body.entry.some(e=>e.changes?.length);
        let formFailure;
        if (hasSocial && hasForms) {
          try {const data=dependencies();await receive(body,{...data,env,enqueue,raw:req.rawBody,signature});}
          catch (error) {formFailure=error;}
        }
        if (hasSocial) {
          if (env.META_SOCIAL_INBOX_RECEIVER_ENABLED!=='true') fail('meta_lead_unsupported_notification');
          const {appId,destinations}=await (socialVerify||require('./socialInboxWebhookVerifier.service').verify)(req.rawBody,signature,env);
          const accounts=new Map(destinations.map(d=>[d.accountId,d.clinicId]));
          const entry=body.entry.filter(e=>accounts.has(e?.id));
          if(entry.length){
            const namespace=require('../lib/gatewayJobOwnership').resolveEnqueueRuntimeNamespace('gateway',env.META_LEAD_JOB_RUNTIME_NAMESPACE,env);
            const inbox=socialAccept||require('./socialInboxIntake.service').accept;
            await inbox({...body,entry},{appId,namespace,accounts});
          }
        }
        if (!hasSocial) {
          if (body?.object!=='page'||!Array.isArray(body.entry)||!body.entry.length
            ||body.entry.some(e=>!Array.isArray(e.changes)||!e.changes.length||e.changes.some(c=>c.field!=='leadgen'))) fail('meta_lead_unsupported_notification');
          const data=dependencies();
          await receive(body,{...data,env,enqueue,raw:req.rawBody,signature});
        }
        if (formFailure) throw formFailure;
        res.set('Cache-Control', 'no-store');
        return res.status(200).json({ success: true });
      } catch (error) { return errorResponse(res, error); }
    },
  };
}
module.exports = { createMetaLeadWebhookHandlers };
