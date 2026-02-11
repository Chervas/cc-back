const express = require('express');
const router = express.Router();
const userController = require('../controllers/user.controller');
const authMiddleware = require('./auth.middleware');

// Mantener consistente con userclinicas.routes.js
const ADMIN_USER_IDS = [1];

const isAdmin = (userId) => ADMIN_USER_IDS.includes(Number(userId));

const requireAdmin = (req, res, next) => {
  const actorId = Number(req.userData?.userId);
  if (Number.isFinite(actorId) && isAdmin(actorId)) return next();
  return res.status(403).json({ message: 'Forbidden' });
};

const allowSelfOrAdmin = (req, res, next) => {
  const actorId = Number(req.userData?.userId);
  const targetId = Number(req.params.id);
  if (!Number.isFinite(actorId) || !Number.isFinite(targetId)) {
    return res.status(400).json({ message: 'Invalid id' });
  }
  if (isAdmin(actorId) || actorId === targetId) return next();
  return res.status(403).json({ message: 'Forbidden' });
};

// Todas las rutas requieren JWT (evita exponer Usuarios publicamente)
router.use(authMiddleware);

// Ruta para obtener todos los usuarios (solo admin)
router.get('/', requireAdmin, userController.getAllUsers);

// Ruta para crear un nuevo usuario (solo admin)
router.post('/', requireAdmin, userController.createUser);

// Ruta para buscar usuarios (solo admin)
router.get('/search', requireAdmin, userController.searchUsers);

// Ruta para obtener un usuario por ID (admin o self)
router.get('/:id', allowSelfOrAdmin, userController.getUserById);

// Ruta para actualizar un usuario (admin o self)
router.patch('/:id', allowSelfOrAdmin, userController.updateUser);

// Ruta para eliminar un usuario (solo admin)
router.delete('/:id', requireAdmin, userController.deleteUser);

// Ruta para obtener clínicas asociadas a un usuario (admin o self)
router.get('/:id/clinicas', allowSelfOrAdmin, userController.getClinicasByUser);

// Ruta para asignar una clínica a un usuario (solo admin)
router.post('/:id/clinicas', requireAdmin, userController.addClinicaToUser);

module.exports = router;
