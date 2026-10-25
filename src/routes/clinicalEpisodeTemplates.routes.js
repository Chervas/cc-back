'use strict';
const router = require('express').Router(), controller = require('../controllers/clinicalEpisodeTemplates.controller');
router.use(require('./auth.middleware'));
router.get('/', controller.list); router.post('/', controller.create);
router.get('/:id/versions', controller.versions); router.post('/:id/archive', controller.archive); router.get('/:id', controller.get); router.patch('/:id', controller.save);
module.exports = router;
