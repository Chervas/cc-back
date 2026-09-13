# Estado durable para el alta específica de WhatsApp

13/09/2026. Componente interno probado con datos ficticios; no conectado a rutas
públicas ni a Meta. La autorización Meta independiente de Ads/leads/páginas sigue
siendo un requisito de cierre. Este registro no acredita la separación remota.

## Contrato y límites

`src/services/whatsappAuthorizationState.service.js` ofrece `issue`, `claim`,
`assertClaimActive`, `status` y `cancel`. Todos reciben exactamente `requestId`
(UUID4), `userId` (entero), `sessionRef` (UUID4) y `sessionExpiresAt` (epoch segundos
del JWT original). `issue` añade `scope:{type:'clinic'|'group',id:entero}`;
`claim` añade `state` base64url de 43 caracteres y `code` ASCII sin espacios,
máximo 4096 caracteres. Actor y sesión proceden exclusivamente del middleware
verificado al conectar las futuras rutas, nunca del cuerpo del navegador.
La misma sesión con un JWT renovado debe conservar la referencia/expiración
original del intento; no ampliar su plazo ni aceptar campos de actor del cliente.

La sesión debe seguir activa, vinculada a contraseña/correo actuales y con prueba
durable `password_email`. El nuevo parámetro interno `verifyReference(...,
{requireEmail:true})` exige esa prueba incluso si la política inyectada permite
sesiones de contraseña. Sus consumidores anteriores mantienen el comportamiento.

El ámbito exige propietario/agencia con invitación aceptada o nula en **todas**
las clínicas; conserva la política existente de administradores globales por ID.
El registro fija el conjunto completo y el grupo actual de cada clínica. Un alta,
baja, traslado de grupo, pérdida de permiso o `MetaScopeBlocks` impide continuar.
No se libera ningún bloqueo para permitir el alta. Máximo 1000 clínicas por grupo.

Estados persistentes: `awaiting → claimed → cancelled`, también
`awaiting → cancelled`. Caducidad derivada, máximo 10 minutos y limitada por el
JWT original. Cinco intentos activos y diez emitidos por usuario/hora. Transacción
MySQL REPEATABLE READ; orden usuario/sesión, clínicas/permisos/bloqueos y solicitud.
Los límites y la reclamación se serializan por usuario entre procesos.

Solo `issue` devuelve el estado opaco. Es derivable con HMAC y contexto fijado,
por lo que el mismo requestId puede recuperar el mismo estado pendiente después
de reiniciar, sin almacenar su valor en claro. Reutilizar el ID con otro ámbito,
sesión o después de consumo/cancelación falla. Se conservan únicamente hashes de
estado y código, con unicidad global del hash de código entre usuarios/ámbitos
e intentos; otro estado no permite reclamar el mismo código. Rotar la clave
invalida la validación de intentos existentes;
no habilita recuperación por una clave anterior ni reprocesamiento.

Solo la primera reclamación devuelve `mayExchange:true`. `claimed` significa
**reclamado localmente**, no código canjeado ni cuenta conectada. Una respuesta
perdida requiere conciliación con el futuro broker usando un ID estable; nunca
volver a canjear automáticamente. `assertClaimActive` repite sesión, permisos,
ámbito, bloqueo y caducidad para el futuro consumidor. No revierte una llamada
que Meta ya haya aceptado ni resuelve por sí solo el intervalo entre comprobación
y llamada. El futuro broker deberá conservar su propio estado e idempotencia.

`cancel` exige la sesión original todavía válida, pero permite cancelar aunque
se haya perdido la membresía o bloqueado el ámbito. Es idempotente, no borra filas
y no cancela operaciones remotas. No soporta cancelación antes de crear el intento
ni desde otra sesión después de logout. Los intentos abandonados caducan; se
conserva su evidencia. `status` devuelve solo estado, ámbito, IDs de clínicas y
expiración, tras volver a comprobar el acceso; no códigos, hashes o credenciales.

Errores de contrato 400, sesión 401, ámbito 403, conflicto/consumo/cancelación
409, caducidad 410, límite 429 y estado/configuración/auditoría no disponibles 503.
Los errores de infraestructura se sustituyen por códigos fijos, sin SQL ni
respuestas crudas. Estas son funciones internas; no se han creado endpoints.

## Auditoría y despliegue pendiente

Evento cerrado v15 `integration.whatsapp.authorization_state`, razones
`state_issued`, `state_claimed`, `state_cancelled`, actor/scope/sessionRef/requestRef
y una correlación distinta por transición. Inserción y mutación de estado en la
misma transacción. Auditoría caída, 10000 pendientes o uno de al menos una hora
impiden confirmar la transición. Repeticiones idempotentes no duplican eventos.
Writer/reader validan v15; el filtro de acciones del visor lo admite. Las
denegaciones HTTP y el resultado del canje remoto quedan para la integración
de rutas/broker; esta versión solo captura transiciones locales exitosas.

Nueva DDL **20260913150000-create-whatsapp-authorization-states**, ensayada solo
en MySQL propio. `WhatsappAuthorizationStates` no tiene FK ni borrado en cascada.
`down` solo permite tabla vacía; con historial se niega a borrarla. Antes de
instalar el nuevo modelo se debe aprobar/aplicar esa migración exacta y acreditar
dependencias AuthSessions/MFA, MetaScopeBlocks y PlatformAuditEvents/result_part.
No ejecutar todas las migraciones pendientes. No se ha aplicado DDL compartida.

El servicio exige `WHATSAPP_ONBOARDING_ENABLED=true`, runtime/namespace/prefijo
`gateway`, workers y cron `false`, AUTH_SESSION_MODE y AUTH_EMAIL_MFA_MODE
`enforce`, auditoría auth durable y auditoría de alta con
`PLATFORM_AUDIT_WHATSAPP_ONBOARDING_ENABLED=true`,
`PLATFORM_AUDIT_WHATSAPP_ONBOARDING_POLICY=whatsapp-onboarding-v1`.
`WHATSAPP_ONBOARDING_STATE_KEY_FILE`: ruta absoluta sin enlaces, fichero privado
de 32 bytes; sus buffers se borran tras cada operación. Ninguna variable/clave
se ha instalado. La activación no debe eliminar la cuarentena Meta actual.

El lote futuro requiere writer/reader v15 antes de captura, DDL respaldada,
identidades/SQL/Redis/claves separados de DEV, rutas con MFA y protección CSRF,
correlación documentada con Embedded Signup, App/config/redirect fijos, canje
dentro del broker y contraste remoto de WABA/número/permisos. Evaluar configuración
de acceso frente a app dedicada: no asumir que mismo App ID con otro botón
elimina permisos previamente concedidos. El token de alta y los roles operativos
de envío/gestión deben ser compatibles con la separación real exigida al motor.
Ads/leads permanecen fuera de ese grant y no se habilitan por conectar WhatsApp.

Interrupción actual: ninguna, componente desconectado y sin despliegue. Para
rollback futuro cerrar nuevas altas, conservar estados/auditoría, conciliar
operaciones en vuelo y mantener versiones que rechacen su reuso; no borrar la
tabla ni restaurar el alta general vulnerable. No hay permiso de reconexión.

## QA de este corte

- 27 pruebas backend, incluidas 3 nuevas de contrato/configuración: entrada estricta, gateway/MFA/auditoría,
  clave privada, errores saneados y buffers borrados.
- 55 pruebas de auditoría, incluidas 2 nuevas de v15, recibos/versiones y rechazo
  de campos secretos. Transporte externo ficticio.
- 12 grupos de comprobaciones en MySQL 8.0.42 propio: migración/reinicio,
  concurrencia, prueba MFA, permisos/grupos, bloqueo/cancelación, logout y cambios
  de credenciales, rollback ante auditoría caída, caducidad/límites, supervivencia
  a borrado del usuario/sesión, ausencia de secretos y entrega de eventos.
  Resultado correcto y cierre del mysqld propio con código 0.
- Regresión de sesiones y login por correo: 10 y 14 grupos de comprobaciones
  respectivamente, en otros dos MySQL propios, ambos correctos y cierre 0.
  Total del corte: 82 pruebas Node y 36 grupos de comprobaciones MySQL en tres
  instancias ficticias. No se repiten ni se contabilizan los tests anteriores
  del broker de envío, que no cambia en este corte.

Evidencia privada: `qa-evidence/security-migration-20260912/whatsapp-state-*.log`.
No se han utilizado correo, OAuth, AWS, pacientes ni credenciales reales. No se
ha cambiado UI, broker de envío, consumidores, PM2, pausas o configuración.
