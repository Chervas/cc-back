# Publicación de consumidores Meta en CRM y gateway — 19/09/2026

**Estado:** API/gateway publicados a las 16:14:36 UTC y frontend a las 16:16:34 UTC.
Gates Meta OFF, siete tablas nuevas vacías y ninguna nueva conexión clínica.
La aceptación de Ajustes con sesión real, MFA y autorización Meta del titular
sigue pendiente. Este corte no termina la migración completa AWS.

Contrato canónico: [13-backend](../../src/Documentacion/13-backend.md#consumidores-meta-publicados-en-crm-y-gateway-19092026-16141616-utc).
Manifiestos: `meta-clinical-publication.json` y `meta-clinical-candidate.json`.
Las nueve DDL ya estaban aplicadas: [acta de esquema](meta-clinical-cut.md).
**No repetir el operador de esquema ni los publicadores de este corte.**

## Fuente publicada

| Runtime | Fuente anterior | Fuente publicada |
| --- | --- | --- |
| Backend staging/CRM | `ac4703a3` | `48d69879fa529e657e19fd5cddb6e88623561be6` |
| Gateway | `d8b81de7` | `fdb2636abc040eea837973ec30a0416d3bb33696` |
| Frontend CRM | `288ca987` | `27afa85ce45667091654f0c2a21cf5c9395d83b4` |

Promoción selectiva del código desarrollado en DEV. Gateway conserva su rama
`security/email-mfa-gateway-20260914` y su base propia; la candidata está en
`security/meta-gateway-candidate-20260919`. No se copió toda la fuente CRM sobre
gateway ni se fusionó toda la rama DEV. Candidatas y ramas públicas guardadas en
GitHub. DEV mantiene backend `d07e9c85` y frontend `ddc84c5a`, sin reinicio.

Se revisaron los conflictos de la candidata gateway en lock del broker, catálogo
de jobs, lector de auditoría y test de esquema. Todos los archivos incorporados
coinciden con la candidata CRM revisada. El test integrado detectó que la base
gateway no contenía `whatsapp-contract.js`, requerido por la política compartida;
se incorporó la implementación existente en DEV y se repitió el recorrido.
Se conserva el límite de respuesta de 1 MiB del cliente broker gateway; no se
promueve aquí la excepción de 32 MiB de media WhatsApp presente en staging.

Dependencias raíz: 527 paquetes requeridos, versiones comprobadas contra el lock
sin cambios de manifest. Cada runtime recibe instalaciones propias de broker
(42 paquetes) y auditoría (29), preparadas con `npm ci --ignore-scripts` desde sus
locks. No se trasladan enlaces `node_modules` de QA ni se instala sobre el runtime
en ejecución. Las dependencias anteriores del broker gateway quedan en el
directorio privado de recuperación.

## Corte y conservación

El ejecutor puntual `publish-consumers.cjs` reutiliza las barreras, identidad de
procesos y recuperación del coordinador ya probado; sus callbacks cambian solo
fuente/dependencias. El diario usa fases de publicación, sin ejecutar migraciones.
El preflight detuvo un intento de lectura al encontrar trabajo debido de staging;
se comprobó que terminó antes de preparar el plan. Las primeras comprobaciones
también detectaron la ausencia de tracking de la candidata CRM y de los objetos
Git nuevos en el clon gateway: referencias explícitas y fetch resolvieron ambas
sin tocar procesos ni código servido.

Durante la publicación se detuvieron las dos unidades WhatsApp y las dos API,
con admisión SQL y BullMQ cerrada y propiedad de cada pausa registrada. Se
comprobaron cero trabajos/correos/flujos activos y cero conexiones clínicas
restantes antes de cambiar código. Las fuentes avanzaron por fast-forward y las
dependencias se intercambiaron con los procesos detenidos.

Conservados antes de reiniciar:

- Digest de esquema `9e5be889b2d5b18d9b201c98a4f5a4505c56fbc963dffba0b317e4a3ee06d98d`.
- Una fila `MetaConnections` y 42 `ClinicMetaAssets`, huellas de filas completas
  calculadas dentro de SQL; ningún token copiado a evidencia.
- Las 520 filas pending/waiting/queued, incluidas sus cargas y marcas; no son
  520 trabajos ejecutados. Cola histórica gateway inalterada.
- Siete tablas nuevas Meta vacías, configuración, namespaces, MFA/session enforce
  y gates Meta OFF. No se ampliaron permisos WhatsApp ni ámbitos clínicos.
- Siete pausas anteriores: tres staging y cuatro gateway. Solo se restauraron
  las cinco pausas temporales de este operador. DEV conservó sus PID.

Nuevos PID de app: staging `1974569`, gateway `1974653`; gestores npm `1974557` y
`1974641`. Unidades WhatsApp `1974696`/`1974709`, activas, sin reinicio automático.
Doce comprobaciones HTTP en ambos puertos y dominios rechazan acceso anónimo con
401. La barrera SQL queda liberada y las tareas de auditoría vuelven a completarse
en un intento; a las 16:17:37 no había eventos pendientes de entrega. El muestreo
incluía un job ordinario de descubrimiento todavía en ejecución, sin declararlo
terminado ni ejecutarlo de nuevo. El seguimiento detectó reintentos de ese job
`103506`: la huella de su error coincide con siete ejecuciones anteriores al
despliegue. El stderr registra timeouts de45.000 ms contra el endpoint OPS de
registro de ejecuciones. Script, runner y scheduler no cambiaron. Se registra
como incidencia preexistente pendiente; no se repite manualmente ni se presenta
como prueba de que todos los jobs funcionan. A las16:28:33 consta fallido tras
tres intentos (fin16:27:14); en paralelo,23 jobs de auditoría/expiración de cuatro
tipos han terminado en un intento y el outbox no tiene entregas pendientes.

## Interfaz y pruebas

Build completo publicado `354410eb1dba3209`: 736 fuentes de mapas coincidentes,
424 assets y 667 archivos con hashes verificados. `index.html` SHA256
`ae2aadafdf18011482448e03394359f7a460acb7d6a8e10e8f7fb3b68f807b5e`.
Se conservan las rutas anteriores y los bundles inmutables; los recursos sin hash
sustituidos tienen copia previa. El índice se cambió al final, sin recargar Nginx.
Los bundles servidos por HTTPS coinciden con la candidata y el índice responde
`no-cache, no-store, must-revalidate`.

QA específica gateway, con procesos terminados correctamente:

- Router HTTP, desconexión por ámbito y catálogo de 39 jobs existentes + 3 Meta.
- Contención dirigida 2/2; se excluye expresamente el inventario completo de
  transportes DEV, que no corresponde a esta composición selectiva.
- Contratos de auditoría 94/94, con guard offline.
- Once grupos MySQL de metadatos, cero SELECT de tokens y pool sin espera.
  100 activos de grupo para 1.000 clínicas: 17 consultas, 114 ms y 26.276 bytes.
- Angular → HTTP → MySQL → broker HTTPS/SQLite: selección, confirmación,
  respuesta perdida recuperada sin repetir activación y retirada tras nueva
  sesión/logout; nueve capturas. Proveedor, Secrets/S3 y entrega MFA ficticios.
  Revisadas visualmente conexión de escritorio y recuperación/retirada móvil.

Después de publicar: login anónimo real de CRM y DEV a 1440/390px, cuatro capturas
revisadas, sin respuestas API simuladas, errores JS/5xx ni desbordamiento. El
formulario vacío no hizo POST de login; contraste de errores 6,47/5,91. No se
afirma una sesión autenticada ni aceptación real del nuevo OAuth.

## Diagnóstico y recuperación

Evidencia local: `/home/ubuntu/qa-evidence/security-resume-20260917/meta-publication-20260919/`.
Plan, diario, comprobación previa al reinicio, recibo final y dependencias
anteriores: `/var/lib/clinicaclick-consumer-recovery/meta-20260919-fdb2636a/`, root0700.
No contiene un nuevo respaldo de la BD; el respaldo acotado de esquema anterior
permanece separado y no debe restaurarse sobre escrituras nuevas.

Ante un fallo posterior, inspeccionar primero fuentes, procesos, diario y estado
de las integraciones. Conservar las referencias Git
`refs/cc-recovery/meta-consumers-20260919/staging`,
`refs/cc-recovery/meta-consumers-20260919/gateway` y
`refs/cc-recovery/meta-ui-20260919`. Preparar cualquier reversión como candidata
revisada, manteniendo esquema aditivo, lectores de auditoría v24 y datos/recibos
nuevos. Parar los escritores afectados antes de intercambiar código/dependencias;
preservar configuración y restaurar solo pausas cuya propiedad esté acreditada.
No hacer `down`, reset de datos, replay ni reintentos de autorización incierta.

Para revertir únicamente la interfaz, los originales sustituidos están en
`frontend-recovery/overwritten/` y `frontend-recovery/index.html`, con inventario
en `publication.json`. Restaurar esos recursos e índice al final; conservar
ambas generaciones de bundles. Esto no revierte API, esquema ni autorizaciones.

## Pendientes y coste

Ámbito de la primera clínica/grupo y titular, configuración de identidades,
app/slots/IAM y recorrido público autenticado siguen pendientes. No abrir flags
ni reutilizar tokens investigados para sustituir esas validaciones. La sesión
SSO del operador expiró al comprobar STS después de publicar; se inició nueva
autenticación, independiente de las identidades de los servicios desplegados.

Sin nuevas instancias, secretos de proveedor ni recogida de Cost Explorer en este
corte. Coste incremental facturado `null`; snapshot etiquetado estimado/Unblended
de 4,6195124129 USD conservado (1–18/09, recogido el 19/09 a las 08:22 UTC).
Las muestras SQL aisladas no acreditan capacidad ni facturación de proveedor.
Rotación de tokens aplazada; copias generales al final del objetivo.
