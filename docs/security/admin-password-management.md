# Cambio administrativo de contraseña

Contrato funcional: `front-dev/src/Documentacion/04-autenticacion-jwt.md`, sección
Administración de contraseñas desde Usuarios. Implementación:
`src/services/adminPasswordChange.service.js`, `POST /api/users/:id/password`.

- Administrador canónico, sesión vigente con MFA y contraseña del propio administrador.
- DTO cerrado: `password`, `administratorPassword`; no cambia email ni permisos.
- Mínimo 12 caracteres, máximo 72 bytes; bcrypt coste 12. Nunca registrar el DTO.
- Cinco pruebas administrativas fallidas en 15 minutos bloquean la acción; contadores SQL.
- Usuario y administrador bloqueados por ID ascendente. Comprobar sesión dentro de la transacción.
- Hash, revocación de sesiones/dispositivos/desafíos/enlaces y auditoría juntos; rollback ante fallo.
- Evento v13 existente `auth.password_reset` para el destinatario. `SyncLogs` guarda actor,
  destinatario y correlación sin credenciales. El registro operativo no tiene garantía WORM.
- Cambiar la contraseña propia exige nuevo login. El usuario conserva MFA en el siguiente acceso.
- El editor genérico sigue rechazando mutaciones de credenciales; frontend las excluye del perfil.

QA aislada, sin secretos ni mensajes reales:

```
CAMPAIGN_OPTIMIZATION_MYSQL_TEST=1 node src/scripts/tests/admin_password_change_mysql.test.js
node --test src/scripts/tests/auth_email_contract.test.js src/scripts/tests/admin_credential_session.test.js
```

No requiere DDL, cambio de configuración, claves de proveedor ni despliegue del broker.
El consumidor HTTP afectado es la API (DEV y CRM). Gateway no recibe esta ruta desde
la interfaz ni necesita promoción para esta funcionalidad.
