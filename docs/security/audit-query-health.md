# Salud de las consultas de auditoría tras limitar la caché

Revisión del 18/09/2026, continuación del incidente de login. El límite de 128
consultas por conexión protege el servidor, pero no elimina el trabajo SQL
innecesario. Se midió el worker real y se corrigió su comportamiento.

## Hallazgos y cambio

La captura inicial de 121 segundos registró 238 preparaciones, 238 expulsiones
y 238 ejecuciones de UPDATE para el usuario DEV. No hubo errores ni nuevas
esperas por bloqueos de fila. El límite funcionaba, pero la aplicación seguía
preparando dos consultas por segundo y escribiendo estados sin eventos.

La reproducción con el generador SQL de Sequelize 6.37.7 confirmó que el
predicado de fecha de los UPDATE se inserta como literal. El UUID de propietario
ya era un parámetro; la fecha cambiante impedía reutilizar el SQL. Ahora tanto
los campos SET como las condiciones WHERE usan parámetros, manteniendo la
comprobación atómica de propietario y caducidad. El estado JSON, los errores
anteriores y las fechas de confirmación conservan su comportamiento.

DEV entrega y calcula salud cada 10 segundos y concilia cada 30 segundos, con
reloj monótono y espera contada desde la finalización, sin ráfagas para recuperar
intervalos perdidos. El bucle de correo continúa cada segundo; una excepción de
auditoría deja avanzar ese consumidor. Las tareas siguen secuenciales: una llamada
externa lenta aún puede retrasar el siguiente ciclo; no se afirma aislamiento de
latencia entre proveedores. CRM conserva su planificación de auditoría existente.

## Planes y coste actual

EXPLAIN ANALYZE real, de solo lectura:

- Cola pendiente: índice por estado/fecha; aproximadamente 0,012 ms en CRM vacío.
- Conteo y antigüedad pendientes: índices de cobertura; aproximadamente
  0,024 y 0,015 ms respectivamente.
- Diagnóstico de intentos sin completar: conserva un recorrido del histórico
  más búsquedas por índice de correlación. Midió 0,82 ms sobre 283 eventos CRM
  y 0,124 ms sobre 61 eventos DEV. Se ejecuta diez veces menos en DEV.

El diagnóstico histórico no participa en la comprobación de capacidad del login
(`includeUnresolved: false`). Su coste crece con el histórico: esta revisión
acredita el volumen actual, no una capacidad ilimitada. No se añadió DDL ni se
tocaron tablas clínicas. Las métricas globales del servidor incluyen otras
aplicaciones; la comparación atribuible al cambio utiliza el usuario SQL DEV.

## Pruebas y publicación

Once pruebas de worker/entrega y seis de entrega CRM, correctas. Dos MySQL
temporales independientes, sin TCP ni acceso al socket del servidor, comprobaron:
256 ciclos de adquisición/finalización con fechas distintas preparan solamente
tres consultas; precisión de milisegundos; seis consumidores concurrentes con
un único propietario; rechazo del propietario anterior y de caducidad exacta;
recuperación de leases; conservación de errores en ciclos vacíos; envío acotado;
confirmación perdida conciliada sin duplicar; alertas y transacciones conservadas.

Código publicado: hotfix `420a2dce`, DEV `1cf1aae0`, CRM `019dd243`. CRM solo
incorpora la corrección compartida de SQL y su prueba, sin instalar el worker DEV.
DEV activo en
`/opt/clinicaclick-dev/release-420a2dce64a55e3be70afc16936602b136e9556e-query-health`.
La copia exacta del runtime anterior cambia solo el worker y el repositorio de
estado; conserva los cuatro enlaces de dependencias y los hashes de entorno.
No se activó el código Google/IA pendiente de aceptación. Se mantiene la caché 128.

Antes de reiniciar CRM no había jobs en ejecución ni jobs staging vencidos. Los
históricos gateway de 6/12/72 trabajos permanecieron intactos. APIs DEV/CRM
responden 401 a una consulta anónima de sesión, como corresponde. Chromium real
verificó e inspeccionó la pantalla pública CRM a 1440 y 390 px, sin JS/5xx ni
desbordamiento. Esa prueba es anónima y no demuestra un nuevo login autenticado.

Evidencia privada: `/home/ubuntu/qa-evidence/security-resume-20260917/query-health/`.
La revisión del login no completa la aceptación de la migración Google/IA ni
sus pruebas visuales autenticadas.

## Observación posterior en el servidor

Ventana de 181,5 segundos, 19 muestras, normalizada frente a los 121 segundos
anteriores. Para el mismo usuario DEV:

| Medida | Antes | Después |
| --- | ---: | ---: |
| SELECT por segundo | 7,87 | 1,62 |
| UPDATE de estado por segundo | 1,97 | 0,20 |
| Preparaciones por segundo | 1,97 | 0,044 |
| Cierres de consultas por expulsión | 238 | 0 |
| Consultas retenidas en cuatro conexiones | 512 | 8 |

Reducción aproximada del 90% de escrituras, 79% de SELECT y 98% de preparaciones.
Las ocho consultas retenidas son dos por conexión: el límite 128 sigue siendo
una protección, ya no una caché en expulsión continua. Las preparaciones residuales
son compatibles con aperturas/renovaciones de conexiones; no crece el conjunto SQL
por cada fecha. En ambas ventanas hubo cero errores SQL del usuario DEV, cero
nuevas consultas lentas del servidor y cero nuevas esperas por bloqueos de fila.
El diagnóstico sigue mostrando cero pendientes, conciliaciones e intentos sin
resolver en DEV/CRM; CRM completó entregas programadas después del reinicio.

Esta observación acredita la carga actual durante esas ventanas y no constituye
una prueba de capacidad máxima ni una garantía de ausencia de futuros fallos.
