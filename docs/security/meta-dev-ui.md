# Interfaz Meta en DEV aislado — 19/09/2026

Estado: **publicada solo en DEV a las 13:45 UTC; gates Meta OFF**.
No hay aceptación clínica real, OAuth nuevo ni sesión pública MFA de prueba.
Contrato canónico en [13](../../src/Documentacion/13-backend.md#interfaz-meta-publicada-en-dev-aislado-19092026-1345-utc).

## Fuente y publicación

- Fuente `ddc84c5a8dc93d98a87ba11c71560c96463ce413`, rama
  `security/meta-dev-ui-20260919`, worktree del mismo nombre. Trece archivos de
  producto sobre `35ab61cf`, la fuente real del preview previo. Sus 791 fuentes
  embebidas en mapas coinciden con ese commit; el nombre antiguo del directorio
  `front-dev-release-2fa090e7-ses` no identificaba ya todo el código servido.
- Componentes desarrollados en DEV; proyecciones de actividad compatibles con
  auditoría v24. No se promueven las pantallas de Google pendientes. Autenticación,
  permisos, WhatsApp, Google y correcciones de carga/cabeceras previas conservados.
- Revisión visual: el aviso de pausa resultaba engañoso después de retirar acceso.
  DEV `034f0d99` corrige ES/CAT/EN para remitir al estado de autorización/selección.
- Build completo `b75ea265`, hash `25fc544988678fac`. El commit final solo añade
  el recurso estático inglés que faltaba; se copia al build y se contrastan los
  tres JSON de idioma con su fuente. JavaScript y plantillas no cambian respecto
  al build. Composición y hashes en `meta-dev-ui.json`; detalle de 677 archivos
  generados en el acta privada de publicación. Dependencias de QA enlazadas solo
  después de comparar manifest/lock; el runtime sirve archivos estáticos propios.
- Publicación única 13:45:25–13:45:28 UTC, sustitución atómica del enlace
  `/home/ubuntu/www/front-dev-preview` hacia
  `/home/ubuntu/www/front-dev-release-ddc84c5a8dc93d98a87ba11c71560c96463ce413-meta`.
  Conserva el directorio previo y sus assets para pestañas abiertas. Índice y
  bundles leídos por HTTP; `Cache-Control: no-cache`, main `30a99d73561fa2bf`.
  No se reinicia preview, API, worker, CRM ni gateway; backend DEV sigue `d07e9c85`.

## Pruebas y alcance real

35 regresiones de autenticación y auditoría pasan. Chromium con los componentes
de la candidata: nueve capturas Meta, SQL/HTTPS/SQLite propios, una sola activación
tras confirmación, pérdida de respuesta recuperada por estado y retirada tras
logout con nueva sesión. Todos los MySQL temporales terminan en 0. Graph,
Secrets/S3 y entrega MFA ficticios; worker invocado directamente. Esto no prueba
el proveedor real ni la planificación desplegada bajo carga.

El visor de actividad pasa 16 capturas con datos sintéticos: estados, paginación,
permisos, recuperación y cabeceras sin overflow, escritorio/móvil. El primer
ensayo falló porque esperaba la etiqueta antigua exclusiva de Google para una
acción ya compartida con Meta. Se actualiza esa expectativa y el script permite
seleccionar explícitamente la fuente candidata; no se cambia el producto para
adaptarlo al test. El script vive en DEV, los componentes/estilos en la candidata.

La app completa se prueba contra la API DEV publicada, sin simular respuestas:
login y redirección de Ajustes sin sesión, 1440/390 px, cero POST/JS/5xx/overflow.
Fuentes y SDK externos bloqueados expresamente en esa prueba previa. Tras publicar,
login anónimo DEV/CRM pasa en cuatro capturas con API real, contraste mínimo 5,90.
Capturas inspeccionadas: conexión en escritorio, retirada móvil antes/después del
aviso corregido, login, cabeceras de auditoría y denegación móvil. No se fabrica
una sesión pública ni se declara validado el MFA/OAuth real o el panel autenticado.

## Invariantes, recuperación y pendientes

Antes/después se conservan PIDs/arranque, configuración protegida, MFA enforce,
cron/jobs clínicos OFF y todos los gates Meta OFF. Sin DDL, AWS, claves, slots,
grants, conexiones ni mensajes reales cambiados. CRM mantiene su código/build.
Para volver atrás, comprobar primero que siguen cerradas las altas y que no hay
una publicación posterior; apuntar atómicamente al directorio anterior conservado.
No revertir SQL, recibos, credenciales o servicios AWS para deshacer esta UI.

El primer intento de copiar el aviso inglés detectó que faltaba su ruta JSON en
la candidata: los otros dos idiomas sí se habían copiado. La compilación terminó;
se añadió el recurso inglés al commit final y al empaquetado estático, se verificó
la única diferencia y se repitió la prueba visual final. Se conservan ambos
informes; no repetir `publish.py`, cuyo diario de inicio es exclusivo.

Pendientes: ámbito Meta concreto elegido por el titular, configuración de
identidades/transporte/app/slots/IAM y autorización real; MFA, panel y carga de
proveedor reales. Se preguntó por clínica/grupo y titular, sin inferir la respuesta.
CRM aún necesita su esquema, API y UI coordinados. El objetivo completo sigue
abierto; rotación aplazada y proyecto general de copias al final.

Coste incremental facturado **null**: sin nuevos recursos ni consulta AWS/CE.
Se conserva el snapshot etiquetado estimado/Unblended **4,6195124129 USD**,
1–18/09, recogido 19/09 a las 08:22 UTC; no es una medición de esta publicación.
Evidencia privada: `qa-evidence/security-resume-20260917/meta-dev-ui-20260919/`:
`composition-final.json`, `live-frontend-map-baseline.json`, `build-final.log`,
`selection-final-report.json`, `audit-visual-final/result.json`,
`visual-prepared-final.json`, `visual-reviewed.json`, `deployment.json`,
`before.json`, `after.json`, `login-smoke.json` y capturas.
