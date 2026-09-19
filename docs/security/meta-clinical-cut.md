# Esquema clínico Meta aplicado — 19/09/2026, 15:40 UTC

Estado del esquema: **nueve migraciones aplicadas y verificadas**. La publicación
posterior de API/UI terminó a las16:14–16:16 UTC:
[acta vigente de consumidores](meta-clinical-publication.md). Este documento
conserva los procesos y resultados del corte de esquema de las15:40.
Contrato canónico: [13](../../src/Documentacion/13-backend.md#esquema-clínico-meta-aplicado-y-operador-verificado-19092026-1540-utc).
El esquema clínico es compartido por staging y gateway; DEV conserva su BD ficticia.

## Resultado del corte

- Candidata backend `48d69879fa529e657e19fd5cddb6e88623561be6`, frontend pendiente
  `27afa85ce45667091654f0c2a21cf5c9395d83b4`. Código desarrollado primero en DEV:
  `fc8bd84d` y `93fef229`; ramas publicadas.
- DDL04–12 entre 15:40:42 y 15:40:46; recuperación completa 15:40:54.
  Diario: nueve inicios/nueve finales y `clinical_schema_compatible`.
- Contrato candidato de 27 tablas y contratos de los dos consumidores públicos
  compatibles. Esquema posterior:
  `9e5be889b2d5b18d9b201c98a4f5a4505c56fbc963dffba0b317e4a3ee06d98d`.
- `MetaConnections`: 1 fila; `ClinicMetaAssets`: 42. Huellas de todas sus columnas
  originales intactas, incluidos los valores legacy, sin exportarlos al informe.
- Huella completa de 520 jobs pendientes/esperando/encolados preservada entre
  cierre de admisión y verificación DDL. No se ejecutaron desde el operador.
  Agregado histórico gateway intacto antes y después del reinicio.
- Siete tablas nuevas vacías, gates Meta OFF. Las siete pausas BullMQ previas
  siguen; las cinco pausas temporales del corte se retiraron por sus recibos.
- API staging PID 1970464 (gestor npm 1970452), gateway 1970539 (gestor 1970527);
  unidades WhatsApp 1970581/1970594, activas y `NRestarts=0`. DEV conserva API
  1955293 y worker 1955313, sin reinicio ni jobs clínicos activados.
- Fuentes públicas conservadas: backend `ac4703a3`, gateway `d8b81de7`, frontend
  `288ca987`. MFA y configuración sin cambios. No se publicó el código candidato.

## Correcciones y evidencia

El segundo intento (15:10) perdió el detalle de su error primario y su recuperación
confundió los PID npm/Node. Los cinco jobs de seguridad 103356–103360 se crearon
a las 15:10:00 y terminaron en un intento a las 15:10:05; esto es compatible con
rechazar jobs pendientes en el guard antiguo, reproducido en MySQL aislado. No
recupera retroactivamente el mensaje primario perdido ni permite afirmarlo con
certeza. Acta histórica: `meta-clinical-admission.md`.

El operador versionado conserva fase, códigos SQL, guard y ubicaciones sin texto
SQL, credenciales o valores clínicos. Un fallo de recuperación no sustituye al
original. Identifica gestor y aplicación con PID, inicio y parentesco. Otro
intento a las 15:37 canceló antes de respaldo/DDL al desaparecer `/proc` durante
una parada systemd; se recuperó automáticamente. Se corrigió y reprodujo con una
unidad real de prueba, sin red. Su plan queda invalidado como acta histórica.

La candidata previa pasa 26 pruebas, incluido el montaje conjunto con MySQL,
Redis, PM2/npm/Node y las nueve DDL reales. El consumidor usa el modelo y el
`claimNextJob` de aplicación: cinco jobs nuevos quedan bloqueados, sobreviven a
la salida del consumidor y se completan una sola vez al reiniciar. El gestor
auxiliar de ese montaje es ficticio; la transición systemd se prueba aparte con
una unidad real. La candidata final pasa además 16 comprobaciones dirigidas,
incluida esa unidad y las regresiones de recuperación/diagnóstico.

Verificación posterior: esquema/huellas intactos, siete tablas vacías y lock
SQL sin propietario a las 15:42:48. Cuatro capturas de login real CRM/DEV,
1440/390 px, HTTP200, auth/me401, sin JS/5xx/overflow ni POST de formulario vacío;
contraste de errores 6,47/5,91. Capturas inspeccionadas. No hubo sesión MFA real
ni autorización OAuth del titular en estas pruebas.

A las 15:48:34, los cinco tipos de jobs de seguridad observados después del corte
sumaban 12 ejecuciones completadas, todas en un intento: expiración de sesiones,
entrega/monitor/conciliación de auditoría y notificaciones. Es una comprobación
de continuidad de esos jobs, no una garantía de todas las automatizaciones.

## Recuperación y siguiente fase

Respaldo AES-GCM **local y puntual de dos tablas**, clave y recibos root0600:
`/var/lib/clinicaclick-schema-recovery/meta-crm-20260919-48d69879/`.
El diario está completo. No volver a aplicar este plan, borrar sus actas ni
restaurar tablas/credenciales automáticamente; las fuentes anteriores ya son
compatibles con la ampliación aditiva. Las copias generales siguen aplazadas.

La publicación selectiva de API/UI se completó posteriormente, preservando
Google, WhatsApp y MFA. Queda configurar el ámbito Meta que elija el titular y
comprobar su recorrido autenticado real. La migración completa sigue activa.

Evidencia privada: `qa-evidence/security-resume-20260917/meta-crm-operator-20260919/`
(tests y capturas), `meta-crm-cut-20260919-93b9d7df/` (aborto recuperado) y
`meta-crm-cut-20260919-48d69879/` (corte válido). Sin nueva infraestructura AWS
ni lectura de Cost Explorer en esta fase; coste incremental facturado desconocido.
