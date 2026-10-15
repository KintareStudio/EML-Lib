# Descargas verificadas y cancelación

Estas mejoras generales funcionan con EML AdminTool oficial y sin servicios Kintare. Los métodos anteriores siguen disponibles; las opciones y eventos de cancelación son adiciones.

## Descarga y sustitución de archivos

El descargador escribe cada archivo en un temporal exclusivo junto al destino. Comprueba el tamaño y el SHA-1 declarados por el manifiesto, cierra el temporal y después sustituye el destino. Si la conexión se corta, la verificación falla o se cancela la operación, conserva la copia anterior y elimina el temporal antes de devolver el error. Nunca elimina primero el destino para poder reemplazarlo.

Si el manifiesto no declara tamaño, se usa `Content-Length` cuando representa los bytes recibidos sin compresión HTTP. Si no declara SHA-1, no existe una comprobación criptográfica del contenido: no se inventa un hash de confianza. Un archivo de cero bytes también se descarga y verifica. `skipCheck` omite la revisión previa de los archivos locales, pero mantiene la verificación de lo descargado y la validación de rutas.

La sustitución es individual por archivo. Cancelar una preparación conserva las descargas ya completadas; no revierte todo el modpack. Los permisos existentes se conservan y los ejecutables Java mantienen su permiso de ejecución en Linux y macOS. Un rechazo del sistema al reemplazar el archivo se devuelve conservando el destino anterior.

Los errores transitorios y de integridad se reintentan hasta cinco veces después del primer intento, con esperas crecientes de un segundo. Credenciales rechazadas, límites de solicitudes, configuración inválida y errores conocidos de permisos o disco lleno no se reintentan. El tiempo máximo predeterminado de cada intento de descarga es de quince minutos. Se puede configurar el descargador directamente:

```ts
import { Downloader } from 'eml-lib'

const downloader = new Downloader(gameDirectory, profileToken, {
  adminToolUrl: 'https://admin.example.com',
  retries: 2,
  retryDelayMs: 500,
  timeoutMs: 120_000
})

await downloader.download(files, false, { signal: controller.signal })
```

## Destino de las credenciales

El token de perfil solo acompaña descargas del origen exacto configurado en `adminToolUrl`, bajo su montaje y la ruta oficial `/files/files-updater/`. Se comparan protocolo, host, puerto y ruta; incluir ese texto en el dominio, en otra ruta o en la consulta no concede confianza. Las rutas con separadores o puntos codificados ambiguos no reciben el token. Las peticiones autenticadas rechazan redirecciones.

`Launcher` configura ese origen automáticamente a partir de su `config.url`. La consulta del manifiesto de modpack también restringe el token al AdminTool configurado y su ruta `/api/files-updater/`; un `minecraft.modpackUrl` externo no recibe el token.

Para consumidores directos del módulo interno, `new Downloader(destino, token)` sigue siendo válido, pero ahora hace peticiones sin bearer mientras no se indique `{ adminToolUrl }` como tercer argumento. Este ajuste deliberado evita deducir un destino de credenciales a partir de un manifiesto descargado. Los launchers que usan la API normal y AdminTool oficial no necesitan cambiar su configuración.

## Cancelar la preparación

```ts
import { Launcher, ErrorType } from 'eml-lib'

const controller = new AbortController()
const launcher = new Launcher(config)
launcher.on('launch_cancelled', () => showCancelled())

// El botón de cancelar llama controller.abort().
try {
  await launcher.launch({ signal: controller.signal })
} catch (error) {
  if (error.code !== ErrorType.OPERATION_CANCELLED) throw error
}
```

La señal alcanza la consulta de manifiestos, las descargas y sus esperas de reintento, la lectura y extracción de archivos, la preparación del loader, sus procesos Java y la limpieza. Las operaciones paralelas iniciadas se esperan antes de rechazar la llamada; algunas llamadas al sistema de archivos deben terminar antes de poder salir. La cancelación impide comenzar la siguiente etapa. Dos instancias de Launcher mantienen señales independientes.

Los procesos creados para preparar el loader o comprobar Java se detienen y se espera su cierre. La mezcla del JAR de Forge utiliza un temporal y cierra los lectores antes de sustituirlo, también en Windows. Una preparación de parches interrumpida deja una marca que obliga a repetirla en el siguiente intento, aunque existan archivos de salida parciales.

La cancelación controla la preparación hasta el inicio del proceso del juego. No cierra una partida que ya está ejecutándose. Las extracciones individuales pueden dejar contenido parcial que se volverá a extraer al reintentar; no se promete una transacción de toda la instalación ni limpieza tras terminar el proceso a la fuerza o perder energía.

También se admite `Java.download({ signal })`, `Downloader.download(files, skipCheck, { signal })` y `Downloader.getFilesToDownload(files, { signal })`. Sin estas opciones se mantienen las llamadas anteriores. Los HTTP de preparación conservan su plazo predeterminado de treinta segundos aunque se añada una señal de cancelación.

La promesa rechaza con `EMLLibError` y código `OPERATION_CANCELLED`. `isEmlNetworkError` devuelve `false`: cancelar no significa estar desconectado ni invalida la contraseña. Launcher emite `launch_cancelled`; una descarga cancelada emite `download_cancelled` con el progreso confirmado, sin `download_end` ni `download_error` por esa cancelación. Un tiempo de espera de red sigue siendo un fallo de conectividad.

## Validación

Las pruebas cubren reemplazo tras verificación, tamaño y hash incorrectos, conexiones interrumpidas, fallos al reemplazar, cancelación de streams y reintentos, cierre de procesos reales, aislamiento entre launchers, limpieza, archivos ZIP y peticiones HTTP entre dos servidores locales. La comparación con upstream y el consumidor TypeScript empaquetado comprueban las APIs anteriores y el contrato de AdminTool. Esto no sustituye una partida real ni una prueba contra un AdminTool desplegado.
