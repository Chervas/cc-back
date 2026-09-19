# Consumidores Meta en DEV aislado — 19/09/2026

Estado: backend y worker publicados a las 13:13 UTC, **todos los gates Meta OFF**.
No hay conexiones reales ni slots configurados. Frontend Meta aún sin publicar.
Contrato canónico en [13](../../src/Documentacion/13-backend.md#consumidores-meta-publicados-en-dev-aislado-19092026-1313-utc).
Fuentes y huellas en `meta-dev-consumers.json`.

## Composición y publicación

Desarrollo DEV `9c54f261`; candidata `d07e9c8579bafc446a0f86a283ec52a8fc733c90`
en `/home/ubuntu/wt/security-meta-dev-consumers-20260919`, rama
`security/meta-dev-consumers-20260919`. Parte de `68808b82` más las cuatro diferencias
exactas del runtime ya instalado, conservadas en `86d0a57e`. Añade 129 archivos
nuevos/modificados de Meta, contratos y QA. Los módulos del broker incluidos como
dependencias de contratos/pruebas no se ejecutan como servicios en esta release.

Las 25 rutas Google permanecen idénticas mediante comparación de sus nodos AST;
también se conservan configuración SQL aislada, MFA, sesiones/dispositivo confiable,
correo, desconexión Google, transporte, monitor/certificados, app y JobRequests.
Catálogo previo de 48 jobs intacto más tres Meta cerrados. Los conflictos de
composición se resolvieron incorporando solo esas tres definiciones, descripciones,
cadencias y delegaciones, sin retirar los jobs existentes. Se eliminó un import
de sesión duplicado al ensamblar el router; sintaxis y montaje HTTP completos pasan.

Esquema compuesto de 43 tablas: contrato previo34 más nueve Meta, sin importar
las seis tablas adicionales de la fuente DEV49. Las nueve DDL ya se habían aplicado
a las 12:46 UTC; este corte no ejecuta DDL. El preflight de la release final pasa
antes y después. Dependencias enlazadas exclusivamente a releases inmutables bajo
`/opt/clinicaclick-dev`, tras comparar los cuatro locks; no enlaza node_modules de
los worktrees. Fuente archivada desde un commit limpio, archivos root y lectura.

Activo: `/opt/clinicaclick-dev/release-d07e9c8579bafc446a0f86a283ec52a8fc733c90-meta-consumers`.
Anterior: `release-731084e580953916dcda37d325d4da6efacd38f4-meta-certificate-monitor`.
Se detuvieron solo API/worker DEV y se conservan los hashes de ambos runtime.env.
MFA/sesiones enforce, namespaces dev y cron/jobs clínicos false. API PID1955293,
worker flock1955312/node1955313 en la comprobación13:15 UTC, activos sin reinicios
automáticos. CRM/gateway conservan PID y tiempo de arranque. Sin AWS, firewall,
claves, slots, grants, frontend o pausas clínicas modificados.

Una preparación inicial falló por una API de pathlib no disponible en Python3.8;
el directorio incompleto se conserva con sufijo `-prepare-python38`, nunca se
activó. Se corrigió el script y la preparación siguiente terminó correctamente.
El primer sondeo de logs rechazó el formato ISO de fecha: se normalizó a UTC y se
completó la lectura. Ninguno de esos fallos reejecutó publicación o migraciones.

## Ejecutor Meta de seguridad

Tres bucles independientes en `dev-security-worker.js`: retirada, OAuth y selección.
Cada uno consulta su flag antes de importar el servicio o acceder a SQL/transporte;
cualquier valor distinto de `true` cierra el trabajo. Espera 60 segundos desde el
fin del lote, sin solapamiento ni catch-up. No activa el scheduler clínico/BullMQ
ni reclama JobRequests clínicos. El flock instalado de la unidad mantiene su dueño.

La señal de cierre impide reclamar otra fila; espera la operación ya reclamada
para guardar resultado/incertidumbre. Los tres servicios aceptan ese predicado de
cierre de forma opcional: sus consumidores CRM conservan la llamada habitual.
Los lotes con fallos de fila también emiten el nombre fijo de la tarea, sin datos
SQL o del proveedor. No borrar claims, marcas de entrega ni revocaciones para
reintentar. El límite systemd de parada sigue siendo 45 s: validar también ese
límite con latencia real antes de abrir gates; una terminación forzada exige
recuperar por estado/recibo, nunca volver a enviar una activación incierta.

## Evidencia y límites

- Ocho tests del worker DEV. Candidata:14 unitarios/HTTP/esquema, catálogo51 y
  desconexión legacy.126 JS/CJS pasan sintaxis en Node18.
- MySQL aislado en fuente y candidata: correo MFA cifrado/outbox/sesión avanzan
  mientras Meta, escritor y lector de auditoría esperan. La sesión se verifica;
  envíos SES ficticios, sin comunicación externa. MFA de la candidata:1.023 ms
  en esa muestra; no es una garantía de latencia del proveedor real.
- Bucles DEV con SQL/HTTPS/SQLite reales y Graph/Secrets/S3 ficticios: una
  preparación, una activación después de confirmación, parada con operación
  pendiente y recreación de bucles; retirada y cancelación OAuth tras logout/gate
  cerrado. Se conservan tres claims y dos jobs clínicos ficticios DEV/staging.
  Se recrearon los bucles de aplicación: no equivale a reiniciar systemd con
  trabajo Meta real pendiente.
- Nueve capturas Angular del frontend candidato `a8331d0d`: selección, respuesta
  perdida recuperada por estado sin repetir activación, conexión y retirada con
  sesión nueva. Revisadas escritorio conectado y móvil retirado. Sin errores JS,
  overflow ni salida de navegador a proveedores externos. Este escenario invoca
  directamente el worker; se complementa con el ensayo de los bucles anterior.
- Tras publicar, login anónimo real CRM/DEV a1440/390 px, API sin mocks; HTTP200,
  auth/me401, formulario vacío sin POST y cero errores JS/5xx/overflow. Revisada
  captura DEV móvil. Las tres rutas Meta protegidas responden401 sin sesión.
- Comprobación de procesos y ficheros exactos; cero conexiones/solicitudes Meta,
  ocho jobs completados y62 eventos DEV entregados. Logs iniciales sin los
  marcadores de error inspeccionados. No acredita carga real ni aceptación MFA.

Evidencia privada en `qa-evidence/security-resume-20260917/meta-dev-consumers-20260919/`:
`prepared.json`, `deployment.json`, `runtime-final.json`, `schema-after-publication.json`,
`candidate-preservation.json`, logs de pruebas, `selection-visual/` y `login-smoke.json`.
No repetir `publish.py`: el acta de inicio usa creación exclusiva y el enlace
activo ya cambió. Los procesos de pruebas han terminado y sus MySQL propios cerraron.

Observación posterior de 60,5 s: 98 SELECT DEV (~1,62/s), cero errores, ocho
sentencias preparadas en cuatro conexiones y delta cero de lectura/escritura en
las cinco tablas Meta observadas. Cero nuevas consultas lentas o esperas de fila
globales; no atribuye el resto de la actividad MySQL a DEV ni acredita carga real.
Informes `live-observation.json` y `observation-summary.json` en la misma carpeta.

## Recuperación y siguiente paso

Con los gates cerrados y cero datos Meta, la release anterior permanece disponible
para revertir código conservando el esquema aditivo43. Antes de una reversión,
volver a comprobar estado, datos y compatibilidad. No restaurar bases, secretos,
recibos ni bajar los lectores AWS v24. Si aparecen altas/claims nuevos, la retirada
o reparación debe preservar sus controles; no volver a rutas legacy por defecto.

Pendientes: UI compatible, configuración de transporte/identidades por usuario
API/worker, app/slots/IAM y ámbito elegido por el titular; después pruebas OAuth,
MFA e interfaz autenticadas reales. Mantener DEV sin cron/jobs clínicos. La
candidata CRM07e37fc7 todavía no incluye los ajustes de parada de 9c54f261: al
preparar su publicación, trasladarlos y validar su propia composición junto a
DDL/datos y API/UI. No sustituir CRM por esta release DEV ni promover toda DEV.

Coste incremental facturado null; sin nueva consulta CE. Se mantiene el snapshot
etiquetado estimado/Unblended 4,6195124129 USD (1–18/09, recogido 19/09 08:22 UTC).
Sin instancias nuevas. El proyecto de copias y la rotación siguen aplazados.
