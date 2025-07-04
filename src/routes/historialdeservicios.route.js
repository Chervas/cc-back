const express = require('express');
const router = express.Router();
const historialDeServiciosController = require('../controllers/historialdeservicios.controller');

router.get('/products', (req, res, next) => {
   console.log('Solicitud GET a /products con parámetros:', req.query);
   next();
}, historialDeServiciosController.getProducts);


router.get('/', (req, res, next) => {
   console.log('Solicitud GET a /');
   next();
}, historialDeServiciosController.getAllHistorialDeServicios);

router.get('/:id', (req, res, next) => {
   console.log(`Solicitud GET a /${req.params.id}`);
   next();
}, historialDeServiciosController.getHistorialDeServiciosById);

//router.post('/', (req, res, next) => {
//   console.log('Solicitud POST a / con body:', req.body);
//   next();
//}, historialDeServiciosController.createHistorialDeServicios);

router.patch('/:id', (req, res, next) => {
   console.log(`Solicitud PATCH a /${req.params.id} con body:`, req.body);
   next();
}, historialDeServiciosController.updateHistorialDeServicios);

router.delete('/:id', (req, res, next) => {
   console.log(`Solicitud DELETE a /${req.params.id}`);
   next();
}, historialDeServiciosController.deleteHistorialDeServicios);

router.post('/products', historialDeServiciosController.createHistorialDeServicios);

module.exports = router;
