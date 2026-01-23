'use strict';
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const db = require('../../models');
const { queues } = require('../services/queue.service');

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
    const clinicId = req.query.clinic_id || req.body?.clinic_id;
    await queues.webhookWhatsApp.add('incoming', { body: req.body, clinic_id: clinicId });
    return res.sendStatus(200);
  } catch (err) {
    console.error('Error en webhook WhatsApp', err);
    return res.sendStatus(500);
  }
});

module.exports = router;
