'use strict';
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const db = require('../../models');

const { Conversation, Message } = db;
const APP_SECRET = process.env.FACEBOOK_APP_SECRET || process.env.APP_SECRET;

function verifySignature(req, res, buf) {
  if (!APP_SECRET) return true;
  const signature = req.headers['x-hub-signature-256'];
  if (!signature) return false;
  const elements = signature.split('=');
  const signatureHash = elements[1];
  const expectedHash = crypto
    .createHmac('sha256', APP_SECRET)
    .update(buf)
    .digest('hex');
  return signatureHash === expectedHash;
}

router.get('/whatsapp/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

router.post('/whatsapp/webhook', async (req, res) => {
  try {
    if (!verifySignature(req, res, req.rawBody || Buffer.from(JSON.stringify(req.body || {})))) {
      return res.sendStatus(401);
    }
    const entry = req.body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const messages = value?.messages || [];
    const statuses = value?.statuses || [];

    // Mensajes entrantes
    for (const msg of messages) {
      const phoneId = value?.metadata?.phone_number_id;
      const from = msg.from;
      const wamid = msg.id;
      const content = msg.text?.body || msg.button?.text || msg.interactive?.text || '';
      const clinicId = req.query.clinic_id || req.body.clinic_id;
      if (!clinicId) {
        console.warn('Webhook WhatsApp sin clinic_id, se ignora mensaje entrante');
        continue;
      }
      const [conv] = await Conversation.findOrCreate({
        where: { contact_id: `+${from}`.replace('++', '+'), channel: 'whatsapp', clinic_id: clinicId },
        defaults: {
          clinic_id: clinicId,
          channel: 'whatsapp',
          contact_id: `+${from}`.replace('++', '+'),
          last_message_at: new Date(),
          last_inbound_at: new Date(),
        },
      });
      await Message.create({
        conversation_id: conv.id,
        sender_id: null,
        direction: 'inbound',
        content,
        message_type: msg.type || 'text',
        status: 'sent',
        metadata: { wamid, phoneId },
        sent_at: new Date(),
      });
      conv.last_message_at = new Date();
      conv.last_inbound_at = new Date();
      await conv.save();
    }

    // Estados
    // (opcional) aquí podríamos actualizar estados si almacenamos wamid en metadata

    return res.sendStatus(200);
  } catch (err) {
    console.error('Error en webhook WhatsApp', err);
    return res.sendStatus(500);
  }
});

module.exports = router;
