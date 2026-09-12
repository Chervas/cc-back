# Acceso en tiempo real y auditoría: lote preparado

Fecha: 12/09/2026. Código y QA aislada; **sin despliegue, activación, AWS ni
migración de la BD compartida**. No se ejecutan mensajes, publicidad,
conversiones, reanudaciones ni proveedores reales.

## Problema y comportamiento

Antes, `app.js` calculaba permisos al conectar y guardaba una lista en una
clausura. La condición pacientes **o** leads daba acceso a una sala que
transportaba ambas categorías. Algunos productores usaban broadcast cuando
faltaba una sala. La comprobación de sesión cada cinco segundos no reevaluaba
los permisos del recurso para cada envío.

`socket-realtime-guard` concentra las suscripciones y la salida al navegador.
`socket.service` conserva su API y el sobre original del bus Redis para la
coordinación interna existente; su entrega local pasa por el guard. No se
activan procesos ni se cambia el opt-in de reanudaciones. El bus interno no se
convierte en una API pública ni en un registro de auditoría.

Cada paquete obtiene su ámbito de metadata actual en BD, valida la sesión y
los permisos del destinatario, registra intento/resultado si la captura está
activada y repite las comprobaciones antes de enviarlo. Las salas son pistas
de destinatarios; pertenecer a ellas no acredita autorización. Un cambio
confirmado antes de la última evaluación afecta a la conexión abierta.
Las consultas y el envío de red no son una transacción: una revocación
posterior a esa evaluación no retira bytes ya enviados o en vuelo.

## Contrato y límites

`subscribe` admite un array de hasta 100 IDs enteros positivos, numéricos o
cadenas decimales canónicas, sin coerción de booleanos, arrays u objetos.
Consulta membresías aceptadas o null legacy y asignaciones del Director con
perfil activo. `[]` selecciona todas las clínicas únicamente para propietario,
admin o Director; otros perfiles quedan sin salas iniciales de clínica.
Una selección explícita con alguna clínica denegada deja cero salas y nunca
se convierte en «todas». Invitaciones pendientes/canceladas no autorizan.
Más de 100 clínicas exige revisar el límite antes de un corte; no hay recorte
silencioso. No se filtran clínicas archivadas para eludir el ámbito completo.

La sustitución vacía primero la selección anterior. Generaciones y cola
impiden que una consulta tardía reponga esa selección. ACK opcional:
`{status: ready|invalid|denied, clinicIds: number[]}`. Los clientes existentes
pueden ignorarlo; una selección denegada necesita corregirse/reconsultarse y
no implica que el socket vaya a recibir eventos por seguir conectado.

| Familia | Ámbito autoritativo | Permisos exigidos en cada clínica |
|---|---|---|
| `message:*`, `conversation:*` | Conversation por ID, canal/paciente actuales | Internal: `quickchat.read_team`; paciente: `quickchat.read_patients` + `patients.sensitive.view`; resto: `quickchat.read_leads` + `leads.sensitive.view` |
| `lead:*` | LeadIntake, clínica o todas las clínicas del grupo | `quickchat.read_leads` + `leads.sensitive.view` |
| `appointment:*` | CitaPaciente por ID | `appointments.view` + las dos capacidades `*.sensitive.view` |
| `flow_execution:*` | FlowExecutionV2, clínica o grupo completo | `marketing` + las dos capacidades `*.sensitive.view` |
| `notification:*` | Notification por ID y propietario actual | Propietario de notificación; si enlaza QuickChat, permisos de esa conversación; si solo declara clínica, las dos capacidades sensibles |

Las notificaciones sin clínica ni conversación requieren su propietario y
sesión. Este contrato no demuestra que todos sus productores etiqueten bien
el ámbito; su clasificación exhaustiva y el API REST de notificaciones siguen
pendientes. Los modelos se consultan solo para metadata de ámbito, nunca se
usa un campo enviado por el navegador para ampliar permisos.

Los grupos exigen permisos en **todas** sus clínicas actuales, aunque el
destinatario esté suscrito a una sola. Un recurso inexistente, sin ámbito
resoluble o con pista de clínica contradictoria se descarta. Broadcast sin
salas solo puede llegar a suscriptores del ámbito resuelto; no existe
broadcast de plataforma. Un destino `user:id` sigue necesitando permisos del
recurso y no puede eludir una retirada de acceso.

Excepción concreta: una cita borrada ya no permite lookup. El evento
`appointment:deleted` usa la clínica del productor interno y se reduce a
`appointment_id`/`clinic_id`; no entrega paciente, tratamiento, horario ni
estado. Redis y productores permanecen dentro de la frontera de confianza.
No se afirma resistencia frente a un productor comprometido con acceso al bus
y a BD, ni se firma cada sobre Redis en este bloque.

## Proyección y compatibilidad

[Inventario estático](realtime-event-inventory.json): 21 nombres, 85 apariciones
literales en 17 archivos. No es cobertura de ejecución ni prueba de ausencia
de nombres construidos dinámicamente. `unread:updated` tiene consumidor front
pero no productor localizado; no se añade un permiso genérico para eventos
desconocidos. La lista cerrada incluye `flow_execution:cancelled` aunque el
cliente legacy no se suscriba a ese nombre.

`socket-payload` copia exclusivamente los campos declarados y valores escalares
acotados. No muta el sobre interno. El navegador no recibe metadata abierta de
proveedores, `resume_text`, errores libres, `audit_snapshot`, contactos de
leads ni URLs externas de notificaciones. Contenido de chat autorizado sí
forma parte del paquete; no se registra en auditoría. Mensajes marcados
`qa_cleanup`/`hide_from_quickchat` se excluyen. De metadata de mensajes solo
permanecen IDs numéricos de teléfono para conservar la ventana de servicio.

QuickChat reconcilia el chat activo por su REST existente al recibir
`realtime_refresh`; un debounce evita una petición por cada evento de una
ráfaga. Cambiar chat/clínica o destruir el servicio cancela temporizador y
petición. Una denegación REST vacía el chat activo. La respuesta REST conserva
sus propios permisos y filtros: este lote no certifica ni amplía su cobertura
de auditoría. La revisión completa de REST sigue siendo otra cohorte.
Detalles de errores, adjuntos y snapshots se consultan por sus recorridos REST
autorizados; no hay fallback a paquetes sin verificar.

Límite de proyección: 49.152 bytes por paquete y 32.768 por campo de texto;
no se trunca silenciosamente. No se registra el contenido rechazado.

## Auditoría y presión de trabajo

`PLATFORM_AUDIT_REALTIME_ENABLED` ausente/false: sin escritura de auditoría;
las comprobaciones de acceso siguen aplicándose. `true`: intento y resultado
durables v5 para `realtime.subscribe` y `realtime.read`. Otro valor falla
cerrado. Sin AWS en el proceso API: utiliza el outbox y entregador existentes.

El esquema guarda actor verificado, referencia de sesión gestionada o null
legacy, correlación, fecha UTC, acción, etapa, resultado, motivo cerrado,
recurso/ID, ámbito y clínicas preparadas. Política `realtime-scope-v1`, captura
`realtime-durable-v1`; esa versión identifica las reglas del código, no un
snapshot transaccional de cada fila de permisos. Prefijo `app/platform/v5/`.
No incluye JWT, email, IP, contenido, contactos, metadata de proveedor ni
errores SQL. Versiones anteriores conservan sus bytes y lectores.

La QA detectó además pérdida de milisegundos al pasar Date sin tipo como
replacements SQL en Sequelize/MySQL. El visor conserva ahora UTC DATETIME(3)
en snapshot y cursor. La regresión reúne 52 registros dentro del mismo segundo
y exige páginas 25/25/2, sin saltos ni duplicados ni entregas posteriores al
snapshot. No requiere cambiar columnas ni migrar datos.

`packet_prepared`/`subscription_prepared` confirma autorización y preparación
durable, **no recepción en el navegador**. La comprobación posterior puede
descartar el envío. Error al persistir resultado impide entrega y desconecta;
un intento sin resultado permanece visible en la monitorización existente.
Backpressure del outbox: 10.000 pendientes o antigüedad de una hora.

Cola local: ocho tareas simultáneas, una por socket, FIFO por socket, máximo
128 tareas totales/32 por socket y plazo de cinco segundos desde encolado.
Desbordamiento o error desconecta; los clientes existentes tienen polling de
respaldo por REST. Un SQL que supera el plazo conserva su plaza hasta resolver,
sin liberar capacidad para crear consultas huérfanas ilimitadas. Una cola sin
capacidad puede afectar a sockets sanos: debe medirse carga antes de desplegar.
Estos límites no equivalen a un rate limit distribuido entre runtimes.

No se garantiza auditoría de handshakes rechazados, nombres desconocidos,
paquetes mal formados descartados antes de resolver actor/recurso, ni tareas
expiradas antes de empezar. Tampoco de toda la plataforma o de los consumidores
internos del bus. Cada pestaña/socket destinatario puede generar dos eventos
de auditoría por paquete, además de suscripciones; no hay muestreo. Estimar con
volumen medido `2 × paquetes × sockets destinatarios + 2 × suscripciones`,
más denegaciones, SQL, S3 PUT/Get, KMS y almacenamiento. El Budget de AWS no es
un límite duro. No se modifica el Budget ni se crea infraestructura por este
bloque; la capacidad/coste requiere el corte aprobado.

## QA y corte pendiente

Pruebas aisladas: contrato/cola/sanitización y bus Redis con doble; MySQL 8.0.42
propio sin TCP con modelos/migraciones reales de outbox, overrides y sesiones,
metadata clínica ficticia y Socket.IO real en servidor loopback propio;
reader S3 v5 con SDK simulado; regresión de sesiones, hotfix y auditoría;
Angular, componente real del visor en Chromium y reconciliación QuickChat.
Evidencias privadas bajo `qa-evidence/security-migration-20260912/realtime-*`.
Los contadores, hashes y resultados definitivos están en el manifiesto de QA.

Resultado final: 66 pruebas unitarias/contrato, 25 comprobaciones MySQL
(7 realtime, 8 visor y 10 sesiones), 8 capturas Chromium y build Angular
`748cdf121106e53b`. Manifiesto privado:
`/home/ubuntu/qa-evidence/security-migration-20260912/realtime-offline-qa.json`.
Todos los mysqld propios finalizaron con código 0; ninguna conexión rechazada
a otro destino, ningún AWS real ni bootstrap de la aplicación.

Reproducción de la cohorte desde backend, solo en entorno de QA aislada:

```bash
node --require ./src/scripts/tests/fixtures/security_offline_runtime.cjs --test src/scripts/tests/socket_realtime_security.test.js
CAMPAIGN_OPTIMIZATION_MYSQL_TEST=1 node src/scripts/tests/socket_realtime_mysql.integration.js
CAMPAIGN_OPTIMIZATION_MYSQL_TEST=1 node src/scripts/tests/platform_audit_view_mysql.integration.js
CAMPAIGN_OPTIMIZATION_MYSQL_TEST=1 node src/scripts/tests/access_sessions_mysql.integration.js
```

Paquete `services/platform-audit`: Node 24, preload `test/offline-guard.cjs` y
`--test test/*.test.js`. Front: `scripts/tests/quickchat_realtime_reconcile.test.js`,
contratos de visor/editor y `platform_audit_view_chromium_qa.js`; este último
admite `AUDIT_VIEW_QA_BUILD`/`AUDIT_VIEW_QA_OUTPUT` privados y bloquea API externa.
La compilación usa configuración development, sin source maps y salida
privada; no arrancar previews compartidos ni PM2 para reproducirla.

No hay migración nueva. Requiere las migraciones previas de outbox y
AuthSessions y el índice del visor en su lote aprobado. Antes de cualquier
activación: writer/reader v5 en sus identidades aisladas aprobadas, todos los
runtimes con el guard y `AUTH_SESSION_MODE=enforce` del lote de sesiones,
permisos/retención/capacidad medidos y captura/entrega monitorizadas. Validar
canario autorizado de roles, grupos, invitaciones, reconexiones, adjuntos,
ventanas de servicio y carga de SQL antes de habilitar la captura.

Modo legacy conserva la compatibilidad de JWT acordada en la migración de
sesiones; no acredita revocación persistente de tokens legacy. Un push a DEV
no migra BD, despliega ni reinicia PM2. Rollback: desactivar solo la captura
si el lote lo exige; conservar guard/proyección segura, sesiones/revocaciones,
outbox/versiones y evidencias. No volver al broadcast o salas con autorización
antigua. El borrado/retención de registros requiere la política aprobada.

Continúan pendientes SSO/AWS real, cohortes de integraciones, auditoría del
resto de lecturas/acciones y escritores de membresías, clasificación completa
de notificaciones, retención DPD y cifrado/restauración/corte de BD real.
