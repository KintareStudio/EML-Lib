# Auditoría de migración Launcher → EML-Lib

Este documento registra la auditoría del árbol local anterior a la publicación del soft fork. Sus recuentos corresponden a ese árbol. La comparación con upstream y los valores predeterminados definitivos de la publicación se describen en [upstream-comparison.es.md](upstream-comparison.es.md).

Revisión del 15 de octubre de 2026. Resultado: no quedan extracciones necesarias identificadas en el alcance revisado; sí quedan integraciones y decisiones propias de esta aplicación, detalladas abajo.

## Alcance y método

Se recorrieron con el parser de TypeScript los **44 archivos de electron/, src/ y shared/** del launcher (9552 líneas, incluidos tipos, comentarios y traducciones). Se inventariaron imports, funciones, llamadas de red, consumidores de EML y URLs literales y de plantillas. Se contrastaron las responsabilidades con el árbol actual de EML: 71 archivos de lib/, types/ e index.ts. El inventario no implica una auditoría de seguridad completa de todas las implementaciones de EML.

También se revisaron index.html, vite.config.mts, la dependencia local empaquetada y los scripts de sincronización y verificación. node_modules, vendor, dist, release, backups y recursos visuales no son código propio pendiente de trasladar. Los tests son infraestructura de comprobación y no funcionalidad que deba publicarse con la librería.

## Hallazgos de este barrido y resolución

1. **Avatares:** cinco construcciones de URL de renderizado en state/home/login. Ahora KintareClient.avatarUrl usa el endpoint descubierto o configurado; las vistas reciben la URL por IPC. Una respuesta anterior no reemplaza una imagen reutilizada para otro perfil.
2. **Actualizador:** la protección de check/download/install concurrentes estaba en bootstraps.ts. Ahora Bootstrap comparte sus operaciones y la inicialización del actualizador. El host conserva su límite de espera y sus eventos de interfaz.
3. **Mantenimiento:** el bypass y la comparación de la fecha de inicio estaban en maintenance.ts del launcher. Ahora Maintenance.getActiveMaintenance aplica esa misma política; la consulta sin cuenta está correctamente tipada. No cambia la interpretación histórica de endTime.
4. **Permisos de perfiles:** dos predicados de la interfaz repetían la regla administrativa. Ahora consumen canManageProfiles del subpath puro de EML. Se retiraron wrappers sin uso que habían quedado en auth.ts.

## Por qué estas partes permanecen locales

- ARG usa un protocolo del panel y una sesión de Electron específica para compartir cookies con su WebContentsView. Su URL y activación son integración de esta aplicación. Extraerlo a un SDK ARG sería otro producto, no un requisito del núcleo de EML.
- La política de certificados, la CSP y la excepción CORS son decisiones del host. EML recibe el transporte autorizado. Para usar otro origen de imágenes, el consumidor también debe adaptar su política de contenido.
- La selección activa, el historial, accounts.dat, safeStorage y settings.json son persistencia y estado de la aplicación. Las comprobaciones después de una espera evitan escribir sobre una selección o credencial posterior.
- Borradores de archivos, selectores nativos, consentimiento, ventanas, traducciones, animaciones, categorías editoriales y presencia Discord pertenecen a la experiencia de este launcher.

Tras los cambios, las llamadas HTTP directas detectadas en código propio son la comprobación y el handshake ARG, y el adaptador net.fetch de Electron. La autenticación Kintare, guardarropas, renderizado y consultas AdminTool se consumen a través de EML. Las cuatro URLs literales restantes en TypeScript son tres valores de composición del despliegue y el filtro CORS de texturas de Electron. Las URLs adicionales en HTML forman parte de CSP y recursos de presentación.

## Inventario por archivo

| Archivo del launcher | Responsabilidad final |
| --- | --- |
| electron/const.ts | Host: despliegue elegido, carpeta del juego e identificadores de la aplicación. |
| electron/handlers/arg.ts | Host: disponibilidad e intercambio del panel ARG; requiere su partición de cookies y vista de Electron. |
| electron/handlers/auth-agent.ts | Adaptador: ruta local y progreso; resolución de GitHub, descarga y caché en AuthAgent de EML. |
| electron/handlers/auth.ts | Adaptador y host: EML gestiona OIDC, cuentas y perfiles; el host persiste, decide la cuenta activa, emite IPC y programa sus temporizadores. |
| electron/handlers/background.ts | Adaptador: delega la consulta a Background de EML. |
| electron/handlers/bootstraps.ts | Adaptador: EML comparte las operaciones del actualizador; el host limita la espera y reenvía los eventos. |
| electron/handlers/discord-rpc.ts | Host: presencia de esta aplicación, textos traducidos, recursos y ciclo de vida del cliente Discord. |
| electron/handlers/instance-access.ts | Adaptador de exportaciones: reutiliza los tipos y errores de ProfileAccess de EML. |
| electron/handlers/instances.ts | Adaptador y host: Profile y ProfileAccess de EML resuelven consultas y acceso; selección, historial, archivos y sondeo de la selección son locales. |
| electron/handlers/kintare-client.ts | Composición: configura KintareClient con el despliegue, transporte y repositorio Loki elegidos. |
| electron/handlers/launcher.ts | Composición: configura Launcher, sesión de juego, agente y argumentos de EML; ventanas, consentimiento, eventos y preferencias son locales. |
| electron/handlers/maintenance.ts | Adaptador: consulta getActiveMaintenance de EML para el usuario actual. |
| electron/handlers/news.ts | Adaptador: consulta News de EML y transmite los errores. |
| electron/handlers/server.ts | Adaptador: ServerStatus y dirección objetivo de EML; descarta resultados de una selección local anterior. |
| electron/handlers/settings.ts | Host: preferencias, información del equipo y selector nativo de Java. |
| electron/handlers/telemetry.ts | Composición: Stats de EML; la preferencia y el ciclo de vida pertenecen a la aplicación. |
| electron/handlers/wardrobe.ts | Adaptador y host: KintareWardrobes y validación en EML; selector nativo, borradores y comprobación de su contexto permanecen locales. |
| electron/main.ts | Host: ventanas, arranque y cierre, CSP/CORS y conexiones con Electron. |
| electron/preload.ts | Host: puente IPC con la interfaz. |
| electron/security/certificate-pinning.ts | Host: política de certificados de esta distribución y transporte net.fetch inyectado en EML. |
| src/app.ts | Host: inicialización de vistas. |
| src/avatar.ts | Host: aplica la URL resuelta por EML a una imagen y descarta respuestas antiguas. |
| src/i18n.ts | Host: traducción y actualización del DOM. |
| src/init.ts | Host: secuencia de pantallas, estados de conexión, progreso y mensajes; operaciones remotas delegadas por IPC. |
| src/instance-themes.ts | Host: paletas y animaciones específicas de las instancias de esta aplicación. |
| src/ipc.ts | Host: tipos y adaptadores del puente IPC. |
| src/locales/en.ts | Host: catálogo de textos traducidos. |
| src/locales/es.ts | Host: catálogo de textos traducidos. |
| src/locales/pt.ts | Host: catálogo de textos traducidos. |
| src/particles.ts | Host: animaciones de la interfaz. |
| src/state.ts | Host: estado visual de cuenta y navegación; permisos y URLs de avatares delegados a EML. |
| src/theme.ts | Host: aplicación de paletas al DOM y al motor de partículas. |
| src/views/crash-consent.ts | Host: consentimiento explícito para cada reporte de error. |
| src/views/dialog.ts | Host: diálogos y entradas de usuario. |
| src/views/first-run.ts | Host: configuración inicial y preferencias. |
| src/views/home.ts | Host: selección, diálogos y progreso; operaciones de perfiles, instancias y lanzamiento a través de IPC. |
| src/views/login.ts | Host: pantallas de device-code y selección; protocolo y URLs de avatares en EML. |
| src/views/news.ts | Host: reglas editoriales EN/ES/PT, categorías Admins/Launcher/Arcana, pestañas y presentación de Markdown. |
| src/views/server-status.ts | Host: sondeo y presentación del estado; consulta y dirección objetivo en EML. |
| src/views/settings.ts | Host: controles, persistencia y preferencias; utilidades de memoria importadas de EML. |
| src/views/sidebar.ts | Host: navegación lateral. |
| src/views/wardrobe.ts | Host: editor, visor 3D, previsualizaciones y contexto de la vista; operaciones remotas delegadas por IPC. |
| shared/server-status.ts | Adaptador: tipos y utilidades de dirección objetivo exportados por EML. |
| shared/wardrobe.ts | Adaptador: datos de EML y tipos propios de los mensajes IPC y archivos temporales. |

## Comprobación

59 pruebas de EML y 63 pruebas del launcher, compilación de ambos proyectos, comprobación de tipos desde el paquete instalado y prueba nativa del renderer. Las pruebas del actualizador usan un adaptador simulado y no ejecutan un instalador. Esta revisión no incluye arrancar una partida real de Minecraft.
