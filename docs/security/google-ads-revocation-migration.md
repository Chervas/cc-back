# Google Ads: desconexión durable, entrega y auditoría

Preparado el 13/09/2026 sobre backend `2112a26b21d02b34c5e525fb0e1080eb151c08b5`
y frontend `2cd4b8b6b80148176899d792eb53bdeb2f014f39`. OPS aplazado. Código y QA
aislada; ninguna cuenta real migrada, configuración instalada o migración compartida.

## Esquema y orden de publicación

DDL `20260913090000-create-google-ads-broker-revocations.js` crea
GoogleAdsBrokerRevocations. PK SHA256 del tuple tenant_clinic_id/connection_ref/
asset_ref; customer, identidad Google, gestor fijado, ámbito solicitante, listas
canónicas de clínicas/mappings afectados, UUID, actor y fechas originales,
pending/confirmed, lease y reintentos. ASCII/binario, sin FK ni credenciales.
El down solo permite una tabla vacía. No borrar historia para revertir código.

La tabla es obligatoria **antes del código incluso con los gates apagados**:
lecturas Ads, loaders Google, SELECT/UPDATE de credenciales, OAuth legacy y
desconexiones la consultan. Conserva la dependencia 080000 y las anteriores;
el DDL no registra ni activa cuentas. No ejecutar migraciones compartidas sin
aprobar el lote concreto, respaldo y compatibilidad de todos los runtimes.

El writer y reader de auditoría deben admitir v11 antes de habilitar captura.
El broker mantiene su operación Ads de control ya preparada; su principal y
clave son independientes del lector. Push de fuentes no despliega servicios.

## Captura y ámbito

DELETE /oauth/google/disconnect sustituye el rechazo provisional
google_ads_broker_disconnect_pending por captura durable. Dentro de la misma
transacción que desactiva mappings y cambia el assignment:

1. Lee y bloquea registros independientes e historial por conexión/customer.
2. Revisa aliases canónicos y con guiones, mappings de otras conexiones y los
   IDs históricos, incluso si desapareció el mapping original.
3. Comprueba propietarios de grupo, miembros actuales, asignaciones explícitas
   y clínicas preservadas por overrides. La clínica representativa de un mapping
   de grupo no determina su propietario.
4. Rechaza cualquier uso fuera de las clínicas de la baja. Una solicitud de
   clínica no revoca un tuple propiedad de grupo: requiere resolver el ámbito
   de grupo. Ads no tiene columnas de primarios en GrupoClinica; SC/GA/GBP
   conservan las comprobaciones de sus primarios.
5. Crea una intención por tuple y un evento humano v11; bloquea todos sus
   bindings. Un fallo de auditoría o de una baja posterior SC/GA/GBP revierte
   el conjunto antes de confirmar cambios locales.

Los bindings, identidades y referencias deben coincidir. Un mapping marcado
sin binding requiere su propia historia original; no se trata como legacy.
Aliases activos sin registrar no pueden incorporarse automáticamente al corte.
Los ámbitos sin registro/historia ni marcas conservan la baja SQL anterior.

La política es conservadora para cuentas compartidas: se inspeccionan todos
los consumidores del mismo customer. Antes de migrar hay que conciliar la
cohorte completa y los overrides legítimos, sin eliminarlos para pasar QA.
No hay remapeo o alta automática de cuentas.

La consulta usa metadata con SELECT FOR UPDATE, colecciones limitadas a 1.000
y hasta 200 intenciones por baja. Captura las clínicas y mapping IDs ordenados
y únicos, con límite de longitud. Cambios de propietario, pertenencia o usos
compartidos fuera del ámbito fallan. Contención/deadlocks revierten la transacción.
El volumen y latencia de estas consultas no se han medido con cuentas reales.

## Bloqueo, idempotencia y confirmación

La revocación local queda vigente desde el commit. El historial se comprueba
antes de permitir un candidato legacy y en cada validación de lectura/escritura
Ads. Los tokens SQL no se hidratan para determinar ese estado. La nueva tabla
también participa en la exclusión por ID/subject en el mismo SELECT/UPDATE de
credenciales y en los gates OAuth legacy.

La fila persiste al borrar bindings, mappings o GoogleConnections. Un ID o
subject recreado no elimina la exclusión. Repetir una baja conserva el UUID,
usuario, fecha y conjunto original; no añade otro intento humano ni borra una
confirmación previa. Una respuesta de lectura en vuelo se descarta si su
contexto ha sido revocado. Los snapshots previos conservan el contrato de cache.

Nuevo job de código `googleAdsRevocations`, tipo google_ads_broker_revocations,
cadencia propuesta cada minuto, gated y sin activar. El catálogo pasa a 48.
Claim SQL con SKIP LOCKED y lease de 120 segundos; UUID estable en reintentos.
Un ciclo procesa hasta 20 comandos dentro de 30 segundos; timeout por petición
hasta 10 segundos y backoff acotado a una hora. Una lease caducada o sustituida
no confirma. El worker guarda errores cerrados y no datos del proveedor.

Solo envía google.ads.asset.revoke.v1 con el tuple y payload vacío. No invoca
Google, revoca OAuth del proveedor ni modifica campañas. Requiere ACK del mismo
UUID y `{revoked:true}` exacto. La confirmación y su evento de auditoría se
guardan juntos. Un ACK perdido se reintenta con el mismo UUID, incluso desde
otro worker. La revocación local permanece mientras la entrega esté pendiente.

## API, auditoría y configuración

GET /oauth/google/disconnection-status agrega Ads a SC/GA/GBP sin cambiar el
formato. Solo cuenta un tuple Ads si todas sus clínicas capturadas están dentro
del ámbito autorizado. La ruta vuelve a verificar sesión y permisos después
de las consultas; datos obsoletos no se devuelven tras perder acceso.
DELETE sin scope cuenta también el historial Ads por ID/subject y mantiene
connection_in_use. Conflictos compartidos: 409/scope_disconnect_shared_asset_conflict.
Captura no disponible: 503/google_ads_revocation_unavailable, sin detalles SQL.

Evento cerrado v11 integration.asset.disconnect bajo app/platform/v11:
attempted atribuido al usuario y completed al job, misma correlación, sujeto
original, scope de clínica/grupo, referencias, cantidad y SHA256 del conjunto
de clínicas. Sin tokens, nombres de cuentas, subject Google o filas de anuncios.
Codec, protocolo de lectura por versión S3 y visor de auditoría admiten v11;
la consulta sigue reservada al administrador técnico. Versiones previas intactas.

Variables preparadas, sin instalar: GOOGLE_ADS_REVOCATION_ENABLED para captura;
GOOGLE_ADS_REVOCATION_WORKER_ENABLED para entrega;
GOOGLE_ADS_BROKER_CONTROL_KEY_ID y GOOGLE_ADS_BROKER_CONTROL_KEY_FILE para el
principal de control. Reutiliza ORIGIN/AUDIENCE/CA_FILE del cliente Ads.
Archivos privados canónicos, sin symlinks, <=64 KiB y sin permisos de grupo/otros.
Gate apagado no elimina el historial ni permite leer credenciales antiguas.

La fase añade consultas SQL y dos eventos de plataforma por tuple confirmado;
su entrega S3 y reintentos usan el sistema de auditoría existente. No aprovisiona
recursos, modifica IAM/retención/Budget ni verifica gasto real. Cost Explorer,
tags, conciliación Budget/CloudFormation y datos reales de costes siguen pendientes.

## Validación y pendientes

Evidencia privada bajo /home/ubuntu/qa-evidence/security-migration-20260912,
prefijo ads-revocation. Pruebas con datos ficticios, modelos inyectados y MySQL
propios con networking deshabilitado; no se arranca la aplicación clínica.
352 tests backend y 47 del servicio de auditoría correctos; 116 comprobaciones
en nueve MySQL propios, todos con cierre 0 y sin conexiones rechazadas. Archivos
full-node/full-mysql y acta de publicación conservan los resultados por suite. La suite del servicio de auditoría
incluye codec v11, lector firmado, versión S3 concreta y regresión de v1..v10.
La UI conserva su contrato de metadata; esta fase no modifica componentes.

OAuth Ads, alta/remapeo, consumidores restantes, escrituras/conversiones,
auditoría completa, costes verificados y cifrado/restauración/corte BD siguen
pendientes. No activar la cohorte Ads hasta completar su ciclo de vida y
aprobar el corte real. OPS continúa aplazado por el usuario.
