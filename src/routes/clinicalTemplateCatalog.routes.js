'use strict';
const router = require('express').Router(), controller = require('../controllers/clinicalTemplateCatalog.controller');
router.use(require('./auth.middleware'));
router.get('/', controller.list); router.get('/presets', controller.presets); router.post('/', controller.create);
router.get('/:id/versions', controller.versions); router.post('/:id/adopt', controller.adopt);
router.get('/:id', controller.get); router.patch('/:id', controller.save);
module.exports = router;
