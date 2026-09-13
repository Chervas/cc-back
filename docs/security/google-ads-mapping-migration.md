# Google Ads: selección y baja de asignaciones gestionadas

Preparado el 13/09/2026 sobre backend `af8df7c85b957285db7f536e00aa6f2cff3cd24a`
y frontend `655e3299a753e7e1a1e1b1b9d3df0fe57c4c7f90`. Código y QA aislada.
OPS aplazado; ninguna cuenta real migrada, credencial movida o configuración instalada.

## Preparación y límites de la incorporación

La DDL `20260913110000-stage-google-ads-broker-mappings.js` añade `staged` al
ENUM de GoogleAdsBrokerBindings, conservando `active`, `blocked` y el valor
por defecto `blocked`. Comprueba el esquema previo exacto y rechaza down mientras
quede cualquier preparación. No se ha aplicado a la BD compartida.

Una preparación exige un mapping **existente e inactivo**, referencias pareadas
y un binding staged con identidad Google, cuenta, gestor, propietario y tenant
originales. No se convierte un registro ausente en una autorización nueva.
Su incorporación forma parte del lote aprobado: conciliar previamente grants del
broker, cuenta/gestor, identidad externa sin tokens SQL, miembros, assignments y
usos compartidos. Este bloque no crea grants, bindings, identidades OAuth ni
secretos desde entradas HTTP. El alta general de cuentas no preparadas y los
traslados de propiedad entre ámbitos siguen pendientes; no se presentan como
terminados por disponer de este guardado.

Discovery usa un contexto opaco distinto, limitado al resumen tipado de la cuenta.
Los jobs y las lecturas de campañas rechazan una preparación. Un contexto de
preparación nunca se convierte en un contexto ordinario después de activarla.
La renovación OAuth incluye también todos los consumidores preparados y rechaza
preparaciones huérfanas; renovar la credencial no activa mappings ni borra bajas.
Los seis registros existentes continúan cerrando los loaders y callbacks legacy.

## Guardado y sustitución

POST `/oauth/google/ads/map-accounts` detecta el modo gestionado antes de cualquier
carga de credenciales. Requiere sesión gestionada, ámbito explícito y escritura;
`GOOGLE_ADS_MAPPING_ENABLED=true` debe habilitarse en el corte aprobado. Por
defecto está apagado y se comprueba antes de contactar con el broker.

Acepta `mappings` con solamente `clinicaId` y `customerId`, hasta 1.000 pares
únicos, y `replace_existing` booleano opcional. El servidor obtiene los nombres,
moneda, zona horaria y estado del resumen tipado. No acepta referencias privadas,
gestores o supuestos permisos desde el navegador. El formulario de Ajustes envía
ahora solo esos dos identificadores; la ruta legacy ya resolvía su metadata en el
servidor. Un resumen legible de una cuenta suspendida puede guardarse sin afirmar
que permita publicar; las cuentas gestor no se activan como cuentas de anuncios.

Hasta 20 cuentas distintas, cuatro discovery simultáneos y 60 segundos
cooperativos. Conserva la selección original y vuelve a verificarla mediante
SELECT FOR UPDATE, incluso dentro de una transacción REPEATABLE READ anterior.
Comprueba sesión persistente y permisos sobre todas las clínicas afectadas dentro
de la transacción; sus referencias nunca se devuelven como contextos HTTP.

Activa mapping/binding y captura auditoría v12 en una sola transacción. Un fallo
de permiso, auditoría o coherencia revierte todo. La reselección admite el resultado
MySQL de cero filas cambiadas solamente tras comprobar el estado exacto bajo lock.
Varias clínicas seleccionadas para la misma cuenta de grupo conservan un único
propietario; la menor clínica solicitada representa el mapping, sin cambiar su
tenant. Una cuenta heredada de grupo no se modifica desde un ámbito de clínica.

`replace_existing=true` captura la baja durable de los customers retirados y
sus aliases, y desactiva sus mappings dentro de esa misma transacción. No revoca
las cuentas conservadas. Mantiene el historial y la comprobación de consumidores
fuera del ámbito; cualquier conflicto revierte también las activaciones nuevas.
Los registros bloqueados permanecen en el snapshot pero no se ofrecen en el
selector. Un alias activo de un tuple revocado sigue rechazándose.

Después del commit se intenta la cola existente `google_ads_recent` con el ámbito
completo. No hay jobs nuevos ni cambios de pausas, cadencias o flags reales. La
cola no confirma ejecución, y un fallo de encolado no deshace una transacción ya
confirmada. No se realizan escrituras de publicidad desde este recorrido.

## Consulta y eliminación individual

GET `/oauth/google/ads/mappings` usa metadata autorizada, sesión gestionada y
ámbito explícito/read. Conserva la estructura `mappings[].ads[]`, permite mostrar
asignaciones heredadas y revalida contexto y permisos antes de responder. No llama
a Google, carga tokens ni usa un gestor global como fallback. La metadata de
invitación/MCC se devuelve nula cuando no está verificada por este contrato.

DELETE `/oauth/google/ads/mappings/:mappingId` usa ámbito explícito/write,
sesión persistente y captura de revocación existente. No necesita que funcionen
las lecturas del broker ni llama al proveedor. Desactiva todos los aliases de la
cuenta afectada y conserva mappings, bindings, asignaciones compartidas e historial;
no ejecuta el antiguo borrado físico para cuentas gestionadas. Repetirlo conserva
la intención original sin duplicar auditoría. Mantiene el gate independiente
`GOOGLE_ADS_REVOCATION_ENABLED` y requiere resolver el grupo si es su propietario.

Las tres rutas devuelven errores cerrados y no-store. Validación/selección inválida:
400; sesión gestionada inválida: 401; ámbito/permisos: 403; incoherencia, revocación
o conflicto compartido: 409; gates, auditoría, registro o servicio no disponible:
503. Las respuestas no acreditan capacidad de publicación, gasto o ejecución de jobs.

## Auditoría y orden del corte

v12 `integration.asset.map` conserva usuario, sesión, correlación, cuenta,
referencias, mapping, estado/ámbito anteriores, clínica representativa anterior y
posterior, cantidad y SHA256 del conjunto de clínicas afectadas. Sin nombres de
cuentas, contenido de anuncios, credenciales ni subject Google. Cada mapping usa
su ID en `result_part`, permitiendo varios eventos en una correlación sin violar
el índice único existente. No necesita otra DDL de auditoría.

Writer, lector por versión S3 y visor restringido admiten v12 antes de habilitar
captura. La baja individual/sustitución reutiliza v11. Ajustes muestra la activación,
propiedad anterior y clínicas afectadas. Las versiones anteriores se conservan.

Aplicar la expansión del ENUM y todas sus dependencias en el lote de BD aprobado,
preparar la cohorte completa, instalar soporte v12 y verificar sesión/grants antes
de habilitar el guardado. Push no despliega ni ejecuta migraciones. El rollback
mantiene bloqueos, intenciones y auditoría; no borra staged para forzar el down ni
restaura tokens SQL. Los cambios de propietario/grants requieren su propio lote.

## Evidencia y pendientes

QA privada: `/home/ubuntu/qa-evidence/security-migration-20260912`, prefijo
`ads-mapping`. MySQL 8.0.42 propio, socket privado, sin networking; pruebas de
activación, dos eventos correlacionados, rollback, reselección, sustitución,
consulta heredada, baja individual y conservación de historia. Las pruebas HTTP
usan la ruta y servicios reales con modelos/proveedores ficticios. Auditoría
comprueba firma y versión S3 exacta; Chromium usa el componente real y datos
ficticios en escritorio/móvil. El acta QA conserva comandos, recuentos y cierres.

Este recorrido añade lecturas SQL, resúmenes tipados al guardar y eventos externos
por mapping. GET de asignaciones y DELETE no añaden peticiones Google. No modifica
infraestructura ni verifica gasto real: costes en Ajustes, etiquetas, Cost Explorer,
IAM, retención y conciliación Budget/CloudFormation mantienen sus pendientes.

Continúan pendientes alta general y cambios de propietario/grants, otros
consumidores Ads y de las demás integraciones, auditoría completa, cifrado y corte
BD y validación real. OPS sigue aplazado. Ningún recurso AWS se ha verificado o
modificado en este bloque y no se ha reactivado Meta.
