'use strict';
const router=require('express').Router(),controller=require('../controllers/clinicalTemplateDefaults.controller');
router.use(require('./auth.middleware'));
router.get('/',controller.list);
router.get('/treatments',controller.treatments);
router.put('/treatments/:id',controller.save);
router.post('/patients/:patientId/resolve',controller.resolve);
module.exports=router;
