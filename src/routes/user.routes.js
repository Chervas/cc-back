const express = require('express');
const { Op } = require('sequelize');
const router = express.Router();
const userController = require('../controllers/user.controller');
const authMiddleware = require('./auth.middleware');
const { PatientDirectionProfile, PatientDirectionSetting, UsuarioClinica } = require('../../models');
const { getAccessibleClinicIdsForFeature } = require('../lib/access-policy');
const { isGlobalAdmin } = require('../lib/role-helpers');

const requireAdmin = (req, res, next) => {
  const actorId = Number(req.userData?.userId);
  if (Number.isFinite(actorId) && isGlobalAdmin(actorId)) return next();
  return res.status(403).json({ message: 'Forbidden' });
};

const resolveDirectoryAccess = async (req, res, next) => {
  try {
    const actorId = Number(req.userData?.userId);
    if (!Number.isInteger(actorId) || actorId <= 0) {
      return res.status(401).json({ message: 'Unauthorized' });
    }
    if (isGlobalAdmin(actorId)) {
      req.userDirectoryAccess = { mode: 'admin', clinicIds: null };
      return next();
    }

    const assignableClinicIds = await getAccessibleClinicIdsForFeature({
      actorId,
      featureKey: 'patient_direction.assign_role',
    });
    if (assignableClinicIds.length) {
      req.userDirectoryAccess = { mode: 'agency', clinicIds: assignableClinicIds };
      return next();
    }

    const profile = await PatientDirectionProfile.findOne({
      where: { user_id: actorId, is_active: true },
      attributes: ['user_id'],
      raw: true,
    });
    if (profile) {
      const settings = await PatientDirectionSetting.findAll({
        where: { director_user_id: actorId },
        attributes: ['clinic_id'],
        raw: true,
      });
      const visibleClinicIds = settings.map((setting) => Number(setting.clinic_id)).filter(Boolean);
      if (visibleClinicIds.length) {
        req.userDirectoryAccess = { mode: 'patient_director', clinicIds: visibleClinicIds };
        return next();
      }
    }
    return res.status(403).json({ message: 'Forbidden' });
  } catch (error) {
    return res.status(500).json({ message: 'Error resolving user directory access', error: error.message });
  }
};

const allowDirectoryTarget = async (req, res, next) => {
  try {
    const actorId = Number(req.userData?.userId);
    const targetId = Number(req.params.id);
    if (!Number.isFinite(actorId) || !Number.isFinite(targetId)) {
      return res.status(400).json({ message: 'Invalid id' });
    }
    if (req.userDirectoryAccess?.mode === 'admin' || actorId === targetId) return next();
    if (req.userDirectoryAccess?.mode === 'agency') {
      const profile = await PatientDirectionProfile.findOne({
        where: { user_id: targetId, is_active: true },
        attributes: ['user_id'],
        raw: true,
      });
      return profile ? next() : res.status(403).json({ message: 'Forbidden' });
    }
    if (req.userDirectoryAccess?.mode === 'patient_director') {
      const membership = await UsuarioClinica.findOne({
        where: {
          id_usuario: targetId,
          id_clinica: { [Op.in]: req.userDirectoryAccess.clinicIds },
        },
        attributes: ['id_usuario'],
        raw: true,
      });
      return membership ? next() : res.status(403).json({ message: 'Forbidden' });
    }
    return res.status(403).json({ message: 'Forbidden' });
  } catch (error) {
    return res.status(500).json({ message: 'Error resolving user directory target', error: error.message });
  }
};

// Todas las rutas requieren JWT (evita exponer Usuarios publicamente)
router.use(authMiddleware);

// Admin: directorio completo. Agencia: directores existentes. Director: equipo de sus clínicas.
router.get('/', resolveDirectoryAccess, userController.getAllUsers);

// Ruta para crear un nuevo usuario (solo admin)
router.post('/', requireAdmin, userController.createUser);

router.get('/search', resolveDirectoryAccess, userController.searchUsers);

router.get('/:id', resolveDirectoryAccess, allowDirectoryTarget, userController.getUserById);

router.patch('/:id', resolveDirectoryAccess, allowDirectoryTarget, userController.updateUser);

// Ruta para eliminar un usuario (solo admin)
router.delete('/:id', requireAdmin, userController.deleteUser);

router.get('/:id/clinicas', resolveDirectoryAccess, allowDirectoryTarget, userController.getClinicasByUser);

// Ruta para asignar una clínica a un usuario (solo admin)
router.post('/:id/clinicas', requireAdmin, userController.addClinicaToUser);

module.exports = router;
