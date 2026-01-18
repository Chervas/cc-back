'use strict';
const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/dependencias.controller');

router.get('/tratamiento/:id_tratamiento', ctrl.getDependencias);
router.post('/', ctrl.createDependencia);
router.patch('/:id', ctrl.updateDependencia);
router.delete('/:id', ctrl.deleteDependencia);

module.exports = router;
