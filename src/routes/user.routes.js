const express = require('express');
const router = express.Router();
const userController = require('../controllers/user.controller');

// Ruta para obtener todos los usuarios
router.get('/', userController.getAllUsers);

// Ruta para crear un nuevo usuario
router.post('/', userController.createUser);

// Ruta para buscar usuarios
router.get('/search', userController.searchUsers);

// Ruta para obtener un usuario por ID
router.get('/:id', userController.getUserById);

// Ruta para actualizar un usuario
router.patch('/:id', userController.updateUser);

// Ruta para eliminar un usuario
router.delete('/:id', userController.deleteUser);

// Ruta para obtener clínicas asociadas a un usuario
router.get('/:id/clinicas', userController.getClinicasByUser);

// Ruta para asignar una clínica a un usuario
router.post('/:id/clinicas', userController.addClinicaToUser);

module.exports = router;
