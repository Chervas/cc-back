# Campaign workspace: implementacion en curso

Estado: EN CURSO. El mock aprobado NO se considera implementado por publicar el
contrato de lectura. No sustituir la ruta productiva hasta completar los comandos,
las pruebas de permisos y el QA autenticado. Referencia UX canonica en front:
`src/Documentacion/20.17-marketing-arquitectura-experiencia-objetivos.md`, apartado 19.

## Contrato de lectura

`GET /api/marketing/campaign-workspace?scope=1|group:28|1,70|all&days=7|30`

- Requiere sesion y lectura en TODAS las clinicas solicitadas. `all` se intersecta
  con las clinicas autorizadas antes de consultar informacion de negocio.
- No cambia activos, conversiones, anuncios, permisos, cobros ni asignaciones.
- Consulta snapshots persistentes por los jobs existentes. No hace llamadas a
  Google/Meta en cada navegacion y no almacena informacion clinica en el navegador.
- Ventanas de dias completos, calendario Europe/Madrid y comparativa anterior de
  igual duracion. No compara un dia parcial con un dia completo.
- Identidad: proveedor + cuenta + campana. La asignacion revisada prevalece.
  Una cuenta compartida no atribuye toda su inversion a cada sede.
- La lectura de inventario no requiere crear y emparejar otra campana local.
  El consentimiento de incorporacion futura y su persistencia estan pendientes de
  integrar en el flujo de configuracion; no se deducen del permiso OAuth.
- Leads: `LeadIntake.id` unico atribuido. No son personas deduplicadas por email,
  ni conversiones declaradas por Google/Meta. Identidad Google completa prevalece
  sobre UTM; fallback por UTM solo si es inequivoco dentro de la clinica.
- Citas: `CitaPaciente.lead_intake_id`, misma clinica, fecha de creacion de la cita;
  excluye canceladas, reprogramadas y reservas provisionales. No se prorratean
  citas del canal ni se interpreta `status_lead=citado` como una cita real.
- Presupuestos aceptados: `null` hasta disponer de una relacion canonica y
  verificable presupuesto -> paciente -> interesado -> campana. `EconomicBudget`
  tiene importe aceptado real, pero no la atribucion publicitaria. No usar precios
  del catalogo, facturas, cobros ni repartos estimados.
- Leads/citas por anuncio: `null` mientras no exista identidad CRM a nivel de
  anuncio. No etiquetar conversiones de plataforma como leads ni inventar ganador.
- Importes agregados: no sumar monedas distintas ni presentar moneda desconocida
  como EUR. Se conserva la inversion individual de cada campana.

## Salud

Seis bloques estables, sin navegacion interior: ausencia de leads, coste por lead,
entrega de anuncios, conexiones/recepcion, privacidad y senales CRM. Cada uno
expone cobertura, ventana y evidencias. Incidencias y campanas afectadas son
contadores distintos. Fallos compartidos del mismo activo se deduplican.

La comprobacion de consentimiento se ha extraido SIN cambiar comportamiento desde
`campaignOnboarding.controller.js` a `campaignMeasurementReadiness.service.js`.
Onboarding y workspace reutilizan la misma verificacion firmada, scope, hash,
caducidad y seleccion efectiva de la web de grupo. Instalar el snippet no acredita
haber recibido un formulario. Autorizar senales tampoco acredita su entrega.

## Pendientes Antes De Sustituir La Ruta

- Contenedor y navegacion productivos con la UI aprobada. Mantener los interiores
  existentes de Objetivos y Captar nuevos pacientes; adaptar solo su navegacion.
- Conexion OAuth, cuentas, politica de incorporacion futura y excepciones de
  cuentas compartidas. Separar lectura de activacion y evitar nuevas asignaciones
  retroactivas sin autorizacion del usuario.
- Preparacion web reutilizable, prueba real de recepcion, permisos de formularios
  nativos y estados de entrega de senales por proveedor.
- Activacion de medicion: el onboarding anterior exige consentimiento web incluso
  para casos nativos; no reutilizarlo ciegamente ni relajar gates de conversiones.
- Optimiza: auditar y conectar capacidades efectivas de ambos proveedores. El
  onboarding actual solo admite Google para guided_improvement. Nunca anunciar
  ajustes Meta como activos si el ejecutor no los soporta.
- Solicitud gestionada y aprobaciones con servicios existentes; sin cobros ni
  publicacion de prueba en cuentas reales.
- Completar frescura/cobertura del inventario de anuncios sin insights, registros
  de recepcion, tipos de destino desconocido y divisa de cuentas Meta antiguas.
- QA responsive y navegacion real en Chromium, estados inicial/configurado,
  comparativa temporal, cambio de clinica/grupo, permisos y errores recuperables.

## Verificacion Inicial 2026-09-10

- Bateria existente `npm run test:marketing-campaigns`: 141 pruebas OK despues
  de extraer la validacion de consentimiento (antes de los ultimos tests nuevos).
- Tests nuevos de alcance, metrica y Salud; sin mutaciones a proveedores.
- Lectura local Arriaga: clinicas 1 y 70, grupo 28. Cuenta Google compartida tambien
  con otro mapping de clinica; no hay ExternalCampaignAssignments para esa cuenta.
  Meta persiste inventario en SocialAdsEntities, no en ExternalCampaignInventories.
  Estas excepciones no se han corregido cambiando datos de negocio durante el QA.
