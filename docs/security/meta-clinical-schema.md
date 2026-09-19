# Preparación del corte Meta clínico — 19/09/2026

Este documento conserva el intento de las 14:30 UTC. **El esquema clínico se
aplicó después, a las 15:40 UTC**; estado vigente y recuperación en
[meta-clinical-cut.md](meta-clinical-cut.md). No reutilizar el plan histórico.

**Estado: corte cancelado antes de respaldo/DDL.** CRM y gateway ejecutan sus
fuentes anteriores, con MFA enforce y gates Meta OFF. El esquema y las43 filas
originales coinciden con las huellas previas. Las nueve migraciones siguen
pendientes en la BD clínica; ya estaban aplicadas en DEV.

Contrato en [13](../../src/Documentacion/13-backend.md#corte-explícito-del-esquema-meta-clínico-19092026).
Composición de API/UI en [la candidata](meta-clinical-candidate.md). Evidencia
privada en `qa-evidence/security-resume-20260917/meta-crm-preflight-20260919/`.
El resumen estructurado acompaña este archivo como `meta-clinical-schema.json`.

## Operador y recuperación

`src/scripts/meta-clinical-schema-release.js` admite `plan`, `backup` y `apply`,
con `--source` absoluto y `--dir` directo bajo
`/var/lib/clinicaclick-schema-recovery/`. Exige root y archivos privados sin
enlaces simbólicos. La herramienta genérica `security-schema-release.js` sigue
limitando sus escrituras a DEV: no se ha abierto una migración pública general.

El plan fija revisión limpia, contrato, nueve archivos DDL04–12, esquema completo,
columnas originales y huellas de cada fila. El destino procede de la configuración
observada de staging/gateway; la conexión DBA local vuelve a comprobar DATABASE().
Rechaza otro destino, fuente/datos cambiados, estado parcial o replay, y requiere
ausencia de procesos Node públicos antes de respaldar y antes de cada DDL.
El coordinador además debe identificar unidades fuera de esos directorios y
comprobar conexiones SQL ajenas; el barrido de directorios no prueba por sí solo
la ausencia universal de escritores.

El respaldo puntual exporta solo `MetaConnections` y `ClinicMetaAssets` mediante
stream AES-256-GCM, sin archivo SQL en claro. Clave, dump y recibo quedan bajo root,
con digest del plan y de filas, hash del contenido cifrado/en claro, IV y tag.
La clave se sincroniza a disco antes del dump; plan/recibo y entradas de directorio
también, antes de DDL. El diario usa creación exclusiva y fsync en cada paso.
Clave y copia comparten host: esto no es un backup externo ni protege frente a
root comprometido. Las copias generales siguen aplazadas al final del objetivo.

MySQL hace commits implícitos en DDL: no hay rollback transaccional ni reintento
automático. Ante un fallo parcial conservar diario, copia y procesos detenidos,
inspeccionar el esquema y decidir una reparación explícita. No ejecutar `down`,
restaurar tokens antiguos sobre escrituras nuevas ni repetir activaciones.

## Datos y procesos comprobados

- Una fila `MetaConnections`, con credencial legacy;42 filas `ClinicMetaAssets`:
  una página, un Instagram, cinco cuentas Ads,17 WABA y18 números WhatsApp.
  Es una relación compartida: no sustituir/eliminar esa conexión al preparar Meta
  no WhatsApp. Los conteos no equivalen a conexiones migradas al vault.
- API staging y gateway comparten BD. También intervienen
  `clinicaclick-whatsapp-fresh-inbound.service` y
  `clinicaclick-whatsapp-inbox-consumer.service`. El importador lee activos y
  escribe conversaciones, mensajes y recibos, además de sus tablas de deduplicación.
  Una parada debe conservar recibos/cursores y reanudar solo trabajo fresco.
- Se retiraron cuatro scripts antiguos de comprobación: PID472310/478416/949711/
  949801, identidad, inicio y hash exactos. Sus24 conexiones Redis llevaban más de
  doce días inactivas, último comando HMSET de metadata, sin suscripciones,
  transacciones, buffers ni otros sockets. Eran scripts finitos que cerraban SQL;
  no se repitieron sus comandos. API, gateway, DEV y WhatsApp conservaron entonces
  sus PID. Evidencia `orphan-cleanup.json`; no generalizar a otros procesos antiguos.

## Intento de las 14:30 UTC e incidencia de recuperación

1. A las14:29:58 el preflight observó cero jobs, correos, flujos y trabajo staging
   vencido; colas BullMQ sin activos y huellas originales intactas.
2. Se detuvieron de forma normal las dos unidades WhatsApp. A las14:30:00 el cron
   público creó/inició el job103273 `business_profile_reviews_recent`. La segunda
   comprobación rechazó el corte **antes de parar las API, respaldar o ejecutar DDL**.
3. El coordinador privado tenía una recuperación demasiado amplia: reinició API
   y gateway aunque no había llegado a detenerlos. Fue un error del procedimiento.
   La recuperación normal del scheduler permitió un segundo intento del job, que
   terminó `completed` a las14:30:21 con `attempts=2`. No afirmar ausencia de
   reintentos, llamadas a Google o efectos locales de ese refresco.
4. A las14:30:08 API/gateway y ambas unidades ya estaban activos, con las mismas
   fuentes, configuración protegida y MFA. DEV conservó sus procesos. Comprobación
   posterior: esquema y43 filas originales intactos, historial pendiente gateway
   intacto, contratos públicos de18 tablas compatibles, ambos servicios WhatsApp
   activos con NRestarts0 y sin jobs en ejecución en la muestra de14:35:30.

La corrección desarrollada primero en DEV añade
`metaClinicalCutRecovery.recoverStoppedParticipants`: vuelve a observar cada
proceso, preserva los que siguen activos con su PID original y solo inicia los
que constan parados después de una petición explícita de parada. Rechaza PID
ajeno, estado fallido/intermedio o parada no solicitada. Está incorporada al
coordinador privado; **no se ha repetido el corte tras corregirla**.

Los planes `meta-crm-20260919-d48a8dc9` y `meta-crm-20260919-096bc70a` son evidencia
histórica: cada directorio contiene solo `plan.json`, sin clave, dump ni diario.
La fuente candidata y los PID cambiaron después. No reutilizarlos ni borrar las
actas de cancelación para forzar otro intento.

## Pruebas y límites

- Operador/contrato:7 pruebas. Recuperación selectiva:4 pruebas tanto en DEV como
  en candidata; reproducen el job que aparece entre la parada WhatsApp y la API,
  una parada parcial, sustitución externa y fallo de arranque sin reintento.
- MySQL propio, sin acceso a BD del host: rechazo previo a DDL por destino,
  revisión, esquema, filas, escritores y respaldo; nueve DDL reales conservan
  filas legacy/WhatsApp, pausas, NULL, JSON, Unicode y FKs. Rechaza replay.
- Dump real → AES-GCM → restauración SQL real en otra BD del mismo MySQL aislado:
  igualdad de ambas estructuras y todas sus filas. Verificado en DEV y candidata,
  ambos procesos temporales cerrados en0. No se restauraron datos clínicos.
- Candidata frontend `27afa85c`: build `354410eb1dba3209`; selección y retirada en
  nueve capturas Angular con MySQL/HTTPS reales y Graph/Secrets/S3/MFA ficticios.
  Incluye los cierres de consumidores y el aviso de pausa corregido.
- Tras la incidencia: login anónimo real CRM/DEV,1440/390 px, cuatro capturas,
  HTTP200, auth/me401, formulario vacío sin POST, sin errores JS/5xx ni overflow.
  Revisadas CRM escritorio y DEV móvil. No acredita una sesión MFA autenticada.
- Un intento previo de `job_executor.test.js` sin fixture falló en authenticate
  con usuario SQL vacío antes de encolar; no es una prueba aprobada ni aislada.
  Pudo inicializar metadata de clientes Redis por imports. No repetirlo así.
  La regresión de planificación se ejecutó después con su fixture que bloquea
  red y sustituye modelos/colas (`scheduler-isolated.log`), con salida0.

## Siguiente corte

La recuperación corregida no elimina la carrera entre comprobar cero jobs y
parar su ejecutor. Revisar la admisión/parada coordinada y la ventana del cron
antes de otro intento; no quitar el guard para dejar pasar trabajo activo.
Crear un plan nuevo con fuente/PID/configuración actuales, asegurar pausa de
todos los escritores relevantes, respaldar/verificar y aplicar una sola vez.
Comprobar contrato antiguo y nuevo, filas/FKs, pausas, recibos y cola histórica;
después recuperar solo participantes realmente parados y repetir QA visual.
No restaurar cambios de negocio para igualar una huella que haya cambiado.

Después quedan la publicación selectiva API/UI, configuración exacta de firma,
slots/IAM y el ámbito de clínica/grupo que el titular debe elegir para OAuth.
No usar permisos WhatsApp como autorización de Facebook/Instagram/Ads. Gates
cerrados, sin reconexión, rotación, campañas o reproducción de históricos.

Sin nuevas consultas AWS/Cost Explorer ni instancias. Coste incremental facturado
`null`; se conserva el snapshot etiquetado estimado/Unblended4,6195124129 USD del
1–18/09, recogido19/09 a las08:22 UTC. El reintento de reseñas no tiene una medición
de coste incremental atribuible en esta evidencia.
