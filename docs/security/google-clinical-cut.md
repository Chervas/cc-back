# Esquema clínico Google aplicado — 19/09/2026, 18:04 UTC

> **Tipo:** runbook de diagnóstico y recuperación del corte SQL.
> **Fuente de verdad:** alcance aplicado y evidencia; no certifica migración de credenciales ni aceptación del proveedor.
> **Última revisión:** 2026-09-19.
> **Relacionado con:** [contrato backend](../../src/Documentacion/13-backend.md#esquema-clínico-google-corte-limitado-y-conservación-de-identidad-compartida), [estado central](https://github.com/Chervas/cc-front/blob/dev/src/Documentacion/19-estado-actual.md#seguridad-de-acceso-e-integraciones).

## Resultado

Fuente del operador `21775536189a90afe501860f1aa6670d2d02fa04`, desarrollada y
pusheada primero en DEV. Se ejecutó **una aplicación** de las 19 DDL Google, entre
18:04:31 y 18:04:38 UTC, sin activar proveedores ni publicar código nuevo.
La operación terminó a las 18:04:47. El esquema clínico compartido por staging y
gateway es compatible tanto con el contrato preparado de 49 tablas como con los
contratos de 27 de ambas releases ejecutadas.

Se comprobaron completas las columnas originales y huellas de **434 filas**:

| Tabla | Filas conservadas durante el corte |
| --- | ---: |
| GoogleConnections | 1 |
| ClinicBusinessLocations | 14 |
| ClinicWebAssets | 6 |
| ClinicAnalyticsProperties | 5 |
| ClinicGoogleAdsAccounts | 6 |
| GoogleConnectionAssignments | 17 |
| GroupAssetClinicAssignments | 21 |
| GoogleAdsConversionUploadAttempts | 364 |

Las asignaciones de otros proveedores en la tabla compartida también se conservan.
Todas las claves foráneas anteriores permanecen. Dieciséis registros/diarios nuevos
vacíos; no se rellenan referencias broker ni se marca una identidad como migrada.
Los **520 jobs pendientes** se preservaron íntegros bajo la barrera, junto al
historial gateway. Se restauraron únicamente cinco pausas adquiridas por este
corte y se mantuvieron las siete anteriores. Los jobs ordinarios pueden continuar
después de la recuperación; no se fija este recuento como saldo permanente.

CRM conserva `48d69879`, gateway `fdb2636a` y frontend público `27afa85c`. Arrancan
los mismos cuatro participantes con configuración/fuentes intactas: API, gateway,
receptor fresco WhatsApp e importador pasivo. MFA/session enforce, grants y
ámbitos existentes conservados. DEV sigue en `aeb87ce4`/`95f55fe7`, sin reinicio
ni cambios de BD, Redis, permisos o jobs clínicos apagados. Frontends inalterados.

## Pruebas antes de aplicar

- Metadata SQL real de las ocho tablas, sin filas clínicas ni credenciales en
  el fixture. MySQL propio con 22 filas ficticias: identidad compartida/duplicada,
  clínicas/grupo, mappings inactivos, asignación Meta, seis estados de conversión,
  NULL, JSON y Unicode. Las 19 DDL pasan los 22 contratos Google y conservan todo.
- Exportación real `mysqldump` → stream AES-GCM → restauración real en otra BD
  del MySQL privado: igualdad de ocho estructuras, relaciones y todas sus filas.
  No se crea un dump en claro ni se restaura la BD clínica para probarlo.
- Plan de otro proveedor, revisión/hash/lista cambiados, migración histórica
  ausente, filas modificadas, escritor vivo o respaldo inválido rechazan antes
  de DDL. Fallo provocado después del primer ALTER/CREATE: queda diario parcial,
  sin avance de SequelizeMeta ni reintento. La preparación posterior lo rechaza;
  el error SQL original se conserva aunque también falle liberar el lock.
- Regresiones del coordinador, PM2/npm/Node, unidad systemd propia sin red y
  barreras SQL/Redis: 19 casos correctos en total, más dos casos de la política
  Google. Seis ensayos de integración correctos, todos con cierre limpio.
  La integración completa de admisión usa nueve DDL Meta y cinco jobs nuevos
  ficticios que se ejecutan una vez al reanudar; la secuencia Google de 19 DDL
  se prueba por separado. No se confunden ambos alcances.

Una primera ejecución omitió el opt-in del ensayo systemd: fue rechazada antes
de crear unidad y se ejecutó después con el opt-in correcto. El primer archivo
Google incluía dos MySQL aislados en un mismo proceso; el guard del fixture
rechazó el segundo. Se separaron en procesos de prueba distintos, conservando
el guard de modelos/red. No fueron fallos de producción ni razones para relajarlo.

## Plan, copia y diario

El operador específico añade Google sin abrir una herramienta genérica de DDL
pública. Comparte el coordinador probado de procesos/colas; Meta conserva su
política de nueve migraciones. El aplicador Google verifica las dos unidades
WhatsApp detenidas, ausencia de Node públicos y cero conexiones ajenas a esa BD.

Directorio root **consumido**, modo 0700:
`/var/lib/clinicaclick-schema-recovery/google-crm-20260919-21775536/`.
Contiene plan, copia `legacy.sql.enc`, clave de recuperación y recibo, diario DDL
y diario de coordinación, todos root0600. La copia acotada de ocho tablas ocupa
1.768.942 bytes cifrados; GCM y digest verificados antes de DDL. Clave y copia
están en el mismo host: no sustituyen copias externas ni la cobertura general
aplazada al final del objetivo. No imprimir, mover a Git ni enviar la clave/dump.

No volver a ejecutar `plan`, `backup`, `apply` o `cut` contra este directorio.
Tampoco aplicar las nueve DDL Meta o los planes DEV anteriores.

## Diagnóstico y recuperación

1. Consultar `control-journal.jsonl`, `journal.jsonl` y el acta antes de actuar.
   Este corte terminó con `clinical_schema_compatible` y `cut_complete`; no
   quedó ninguna parada o pausa temporal pendiente de recuperar.
2. Conservar el esquema aditivo y el código/configuración actuales. Ya se probó
   su compatibilidad; no ejecutar `down` ni restaurar tokens/filas antiguas sobre
   actividad posterior. No borrar recibos ni reproducir conversiones históricas.
3. Un corte futuro requiere fuente limpia y plan nuevo, con todos los hashes y
   procesos observados de nuevo. No reutilizar PID del acta. Si falla antes de
   DDL, recuperar solo paradas solicitadas y pausas propias; con DDL parcial,
   inspeccionar estado y preparar una reparación explícita, sin autoretry.
4. Tras una recuperación, verificar ambas API sin sesión = 401, estados/entorno
   de los cuatro participantes, pausas previas, DEV, esquema y frontends. La
   recuperación no debe ampliar scopes ni activar una integración.

Evidencia privada:
`/home/ubuntu/qa-evidence/security-resume-20260917/google-clinical-operator-20260919/`.
El acceso anónimo real CRM/DEV se comprobó después en 1440/390 px: cuatro capturas,
sin mocks de API, cero errores JS/5xx/desbordamiento y formulario vacío sin POST.
Se inspeccionaron CRM escritorio y DEV móvil. Falta sesión MFA autenticada y
aceptación del proveedor: [acta estructurada](google-clinical-cut.json).

## Lo que sigue pendiente

Componer/publicar consumidores Google en staging y gateway; configurar identidad,
claves, transporte, grants y migrar la identidad compartida completa al vault.
Después, pruebas Google reales y recorrido autenticado de interfaz. El esquema
preparado no activa campañas, leads, conversiones ni trabajo clínico DEV.
Se mantiene el objetivo completo de WhatsApp, Meta, IA, correo, auditoría y
certificados. Sin nuevas instancias ni consulta Cost Explorer; coste incremental
facturado no atribuido (`null`). Rotación aplazada y copias generales al final.
