const express = require('express');
const router = express.Router();
const gruposController = require('../controllers/gruposclinicas.controller');

router.get('/', gruposController.getAllGroups);
router.post('/', gruposController.createGroup);
router.patch('/:id', gruposController.updateGroup);
router.delete('/:id', gruposController.deleteGroup);

module.exports = router;
