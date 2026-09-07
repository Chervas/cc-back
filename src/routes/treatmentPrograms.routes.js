'use strict';
const router = require('express').Router();
const auth = require('./auth.middleware');
const controller = require('../controllers/treatmentPrograms.controller');
router.use(auth);
router.get('/options', controller.options);
router.post('/preview', controller.preview);
router.get('/', controller.list);
router.post('/', controller.create);
router.get('/:id', controller.get);
router.patch('/:id', controller.update);
// No delete, sale, purchase, booking or automation activation endpoints.
router.use((error, req, res, next) => {
  if (!error?.statusCode) return next(error);
  res.set('Cache-Control', 'no-store');
  return res.status(error.statusCode).json({ code: error.code || 'program_error', message: error.message, error: { code: error.code || 'program_error', message: error.message, details: error.details || null } });
});
module.exports = router;
