'use strict';
const express = require('express');
const { getCatalog } = require('../legal/catalog');
const { getService, requireActor } = require('../services/legalAcceptance.service');
const { isGlobalAdmin } = require('../lib/role-helpers');
const auth = require('./auth.middleware');
function handler(work) {
    return async (req, res) => {
        res.set('Cache-Control', 'no-store');
        try { await work(req, res); }
        catch (error) { res.status(error.status || 503).json({ error: error.status ? error.code : 'legal_service_unavailable' }); }
    };
}
function review(req, res, next) {
    try {
        if (!isGlobalAdmin(requireActor(req))) return res.status(403).json({ error: 'legal_review_forbidden' });
        return next();
    } catch (error) { return res.status(error.status || 403).json({ error: error.code || 'legal_review_forbidden' }); }
}
function createRouter({ catalog = getCatalog, service = getService, authenticate = auth } = {}) {
    const router = express.Router();
    router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
    router.get('/documents', handler(async (_req, res) => res.json(catalog().list())));
    router.get('/documents/:slug', handler(async (req, res) => res.json(catalog().get(req.params.slug, req.query.version))));
    router.get('/review/documents', authenticate, review, handler(async (_req, res) => res.json(catalog().list({ review: true }))));
    router.get('/review/documents/:slug', authenticate, review, handler(async (req, res) => res.json(catalog().get(req.params.slug, req.query.version, { review: true }))));
    router.get('/acceptances', authenticate, handler(async (req, res) => res.json(await service().status(req))));
    router.post('/acceptances', authenticate, handler(async (req, res) => {
        const result = await service().accept(req);
        return res.status(result.replayed ? 200 : 201).json(result);
    }));
    return router;
}
module.exports = createRouter();
module.exports.createRouter = createRouter;
