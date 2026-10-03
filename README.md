# audio-stream

Servidor HTTP + WebSocket escrito en TypeScript con [Bun](https://bun.sh) que captura el audio de salida del sistema y lo envía en PCM crudo a los clientes conectados al navegador (u otros WS).

El núcleo del proyecto es la interfaz `AudioSystemReader`: un contrato pluggable con implementaciones concretas para PulseAudio, PipeWire, ALSA loopback, JACK y WASAPI loopback. Cada reader expone su config como un `T` tipado y validado en tiempo de ejecución (JSON strict o flags inline), de modo que añadir un nuevo backend es un único archivo.

## Requisitos

- [Bun](https://bun.sh) `>= 1.3`
- Una fuente de captura de audio que coincida con el reader elegido:
  - Linux PulseAudio: `pulseaudio-utils` (`parec`).
  - Linux PipeWire: `pipewire` (`pw-record`).
  - Linux ALSA: módulo `snd-aloop` + `arecord` (de `alsa-utils`).
  - Linux/macOS JACK: `jack-tools` (`jack_rec`) o `sox` con backend JACK.
  - Windows: `ffmpeg` (≥ 5.x con `wasapi`) y, opcionalmente, `node-wasapi-loopback`.
- Opcional, para HTTPS sin avisos del navegador: [mkcert](https://github.com/FiloSottile/mkcert) (`brew install mkcert` / `apt install mkcert`). Si no, `scripts/gen-cert.sh` usa `openssl` y el cert sale autofirmado (aviso del navegador la 1ª vez).

## Comandos

```bash
bun install
bun run start        # arranca el server en :8080 (HTTP plano)
bun run dev          # mismo con --watch
bun run check        # tsc --noEmit
bun run scripts/smoke.ts          # corre los 9 smoke tests del CLI
./scripts/gen-cert.sh             # genera cert autofirmado para LAN
```

Para HTTPS en LAN (mejor latencia y compatibilidad con `AudioWorklet`):

```bash
./scripts/gen-cert.sh
TLS_CERT=certs/cert.pem TLS_KEY=certs/key.pem bun run start
```

## Uso

### Auto-detect (lo más simple)

```bash
bun run start
```

El server detecta el mejor reader disponible para el sistema (PipeWire > PulseAudio > ALSA loopback > JACK; en Windows usa WASAPI loopback) y levanta HTTP en `:8080`. Abre `http://<ip>:8080/` desde el móvil o el PC y toca "Iniciar reproducción".

### Elegir reader explícito

```bash
bun run start -- --reader pipewire
bun run start -- --reader pulseaudio
bun run start -- --reader wasapi-loopback     # Windows
```

Si pasas `--reader name` sin más, el reader usa su `canonical()` (defaults completos, incluyendo los `required`).

### Config por archivo JSON (estricta)

```bash
bun run start -- --reader pipewire --configjson examples/pipewire.json
```

El JSON **debe** contener todos los campos `obligatorios` del reader; los `opcionales` se completan con sus defaults. Si falta un `required` o un tipo no coincide, el proceso termina con un error `ConfigError` indicando el reader y la clave. Ejemplo:

```json
{
  "sampleRate": 48000,
  "channels": 2,
  "sampleFormat": "s16le",
  "latency": "20ms"
}
```

### Flags inline (sin archivo)

```bash
bun run start -- --reader pipewire --sampleRate 48000 --channels 2 --sampleFormat s16le
bun run start -- --reader pulseaudio --device @DEFAULT_SINK@ --latencyMs 30
```

Precedencia, de menor a mayor: `defaults del schema` < `canonical()` < `--configjson` (cuando está) < flags inline. Coerción de tipos automática (`number`, `boolean`, `enum` según el schema). Los nombres de los flags coinciden con los campos del config — ejecuta `bun run start -- --help` para ver el schema de cada reader.

### Ayuda

```bash
bun run start -- --help
```

Imprime el uso y los schemas de cada reader (obligatorios / opcionales / defaults).

## HTTPS / TLS en LAN

El cliente (`index.html`) intenta cargar el `AudioWorkletProcessor` desde `/pcm-sink.js`. Esa llamada a `audioCtx.audioWorklet.addModule()` **requiere un contexto seguro**, lo que en navegadores modernos significa:

- `https://<ip>:8080` (WSS), o
- `http://localhost:8080` (loopback cuenta como seguro).

Sobre `http://192.168.x.x:8080` (HTTP plano en LAN) el navegador rechaza cargar el módulo de worklet aunque el `AudioContext` se cree bien. Para esos casos el cliente **cae automáticamente a `ScriptProcessorNode`** (sirve el audio pero añade ~23 ms de latencia) y avisa en pantalla con el mensaje "AudioWorklet no soportado / contexto no seguro".

Para activar el sink de baja latencia en LAN, sirve el server por TLS.

### 1. Generar el certificado

```bash
./scripts/gen-cert.sh                       # autodetecta IPs del host
./scripts/gen-cert.sh 192.168.1.10          # añade un alias extra
./scripts/gen-cert.sh stream.local          # alias mDNS (macOS)
```

El script:

- Detecta IPs LAN en Linux (`ip -4 -o addr`), macOS/BSD (`ifconfig`) con fallback (`hostname -I`).
- Genera un cert con `Subject Alternative Name` cubriendo: `localhost`, `127.0.0.1`, el hostname corto, `*.local` (mDNS) y cada IP detectada.
- Si tienes `mkcert` instalado, lo usa (cert reconocido por el navegador sin avisos).
- Si no, genera un cert autofirmado con `openssl`. El navegador lo aceptará tras un clic en "Avanzado → continuar" la primera vez.

Salida en `certs/cert.pem` + `certs/key.pem`.

### 2. Arrancar el server con TLS

```bash
TLS_CERT=certs/cert.pem TLS_KEY=certs/key.pem bun run start
```

Aparece:

```
=====================================
 Audio Stream (Bun + TypeScript)
=====================================
 HTTPS/WSS: https://0.0.0.0:8080/
 Audio:   44100Hz 2ch s16le
 Backend: pipewire
=====================================
```

Y desde el móvil u otro PC:

```
https://<ip>:8080/
```

El `infoEl` del cliente muestra el sink activo:

```
sink: worklet @ 44100Hz 2ch           ← sink preferido (HTTPS)
sink: script-processor @ 44100Hz 2ch  ← fallback (HTTP plano)
```

### 3. Si no quieres TLS

No hay problema: el cliente continúa automáticamente con `ScriptProcessor`. La latencia añadida es ~23 ms (1024 / 44100). Para muchos casos (música de fondo, podcast en otra habitación) es aceptable; para juego competitivo o instrumento en vivo, sí conviene TLS.

## Schemas por reader

| Reader               | Plataforma                       | Obligatorios                | Opcionales (con default)                             | Binario         |
| -------------------- | -------------------------------- | --------------------------- | ---------------------------------------------------- | --------------- |
| `pulseaudio`         | Linux (PulseAudio / PipeWire-PA) | `sampleRate channels sampleFormat` | `device=@DEFAULT_MONITOR@ latencyMs=20`        | `parec`         |
| `pipewire`           | Linux (PipeWire nativo)          | `sampleRate channels sampleFormat` | `target latency`                              | `pw-record`     |
| `alsa-loopback`      | Linux (ALSA)                     | `sampleRate channels sampleFormat` | `device=hw:Loopback,1,0`                       | `arecord`       |
| `jack`               | Linux / macOS                    | `sampleRate channels sampleFormat` | `backend=jack_rec portName`                   | `jack_rec`/`sox`|
| `wasapi-loopback`    | Windows                          | `sampleRate channels sampleFormat` | `backend=auto`                                  | `ffmpeg` (+ opcional `node-wasapi-loopback`) |

`sampleFormat` solo acepta `"s16le" | "s32le" | "f32le"`. El reader traduce al formato nativo del binario internamente (p. ej. `s16le -> s16` para `pw-record`).

## Configs de ejemplo

`examples/` contiene un JSON funcional por reader. Cópialo y modifícalo:

```
examples/
├── pulseaudio.json
├── pipewire.json
├── alsa-loopback.json
├── jack.json
└── wasapi-loopback.json
```

## Arquitectura

```
+-------------------------+    chunk/error/close    +-------------------------+
| AudioSystemReader (T)   | ---------------------->  | Bun.serve (HTTP + WS)   |
|  - format: AudioFormat  |                          |  - /     -> index.html  |
|  - on('chunk')/off      |                          |  - /ws   -> binary PCM  |
|  - start() / stop()     |                          +-------------------------+
|  - [Symbol.asyncIterator]|                                    |
+-------------------------+                                     v
        ^                                                WebSocket clients
        |                                                (browser audio sink)
+------- + --------------------------------------------------+
|  Concrete readers (uno por backend)                        |
|   PulseAudioReader | PipeWireReader | AlsaLoopbackReader    |
|   JackReader       | WasapiLoopbackReader                   |
+-----------------------------------------------------------+
        ^
        |
+------- + --------------------------------------------------+
|  Config <T> + Schema para cada reader                       |
|   - required / optional / defaults / fields / enums         |
|   - validate() en runtime                                   |
|   - applyCliFlags() para flags inline                       |
+-----------------------------------------------------------+
```

### `AudioSystemReader` (interfaz)

```ts
export interface AudioSystemReader {
  readonly format: AudioFormat;

  on(event: "chunk", listener: (chunk: AudioChunk) => void): this;
  on(event: "error", listener: (err: Error) => void): this;
  on(event: "close", listener: (code: number | null) => void): this;
  off(...): this;

  start(): Promise<void>;
  stop(): Promise<void>;
  readonly isRunning: boolean;

  [Symbol.asyncIterator](): AsyncIterableIterator<AudioChunk>;
}
```

Diseño:

- **EventEmitter (push)** porque el audio del sistema es un stream push contínuo (todas las fuentes entregan bytes por `stdout.data`). Es multi-subscriber, latencia mínima y encaja nativamente con el ciclo de vida del child process.
- **`[Symbol.asyncIterator]`** adaptador para quien prefiera `for await (const chunk of reader) { ... }`.

### Capa de validación (`src/config/schema.ts`)

```ts
export interface ConfigSchema<T extends object> {
  readonly required: ReadonlyArray<keyof T & string>;
  readonly optional: ReadonlyArray<keyof T & string>;
  readonly defaults?: Partial<T>;
  readonly fields?: Partial<Record<keyof T & string, "string" | "number" | "boolean" | "enum">>;
  readonly enums?: Partial<Record<keyof T & string, readonly string[]>>;
}
```

Funciones expuestas:

- `validate(raw, schema, name)` — rechaza claves desconocidas, exige `required`, comprueba tipos y enums. Devuelve `T`.
- `loadConfigFromFile(path, schema, name)` — sincrono, lanza `ConfigError` con detalle si el archivo no existe, el JSON es inválido o falta algún `required`.
- `mergeWithDefaults(cfg, schema)` — superpone `defaults`.
- `applyCliFlags(cfg, flags, schema, name)` — coerción tipada + rechazo de flags no declarados.
- `resolveReaderConfig(input, schema, name)` — punto único que el constructor de cada reader usa; soporta `string | { configPath } | { config } | Partial<T>`.

### Constructor de un reader (4 formas)

```ts
new PulseAudioReader()                                            // canonical
new PulseAudioReader("/etc/pulseaudio.json")                      // path
new PulseAudioReader({ configPath: "/etc/p.json" })               // path (wrapper)
new PulseAudioReader({ config: { device: "@DEFAULT_SINK@" } })    // direct config
```

Las 4 pasan por `resolveReaderConfig` y se validan igual.

### Registry (`src/audio/registry.ts`)

```ts
export const REGISTRY = { pulseaudio, pipewire, "alsa-loopback": alsaLoopback, jack, "wasapi-loopback": wasapiLoopback };
```

Cada entrada expone `{ name, schema, canonical, create }`. El CLI trabaja contra el registry; nuevos readers se enchufan ahí y quedan disponibles para `--reader <nombre>` con su schema/`--help`/validación completos sin tocar el CLI ni el server.

### Servidor (`src/server.ts`)

`Bun.serve` con WebSocket nativo. Al conectar (`/ws`), el server envía un `hello` JSON:

```json
{ "type": "hello", "sampleRate": 44100, "channels": 2, "sampleFormat": "s16le", "backend": "pipewire" }
```

A continuación reenvía cada `chunk` del reader como frame binario. El cliente (`index.html`) decodifica el PCM s16le estéreo y lo entrega al **sink activo**:

- **`worklet`** (preferido): corre en un hilo aparte, ring buffer Float32 pre-asignado, decode dentro del worklet, transferencia cero copias. Latencia mínima pero exige HTTPS o `localhost`.
- **`script-processor`** (fallback automático): corre en el main thread con `ScriptProcessorNode` + ring buffer equivalente. ~23 ms extra de latencia, pero funciona en HTTP plano sobre LAN.

El cliente elige automáticamente entre los dos según contexto seguro y soporte del navegador (visible en `infoEl`). Más detalles: [HTTPS / TLS en LAN](#https--tls-en-lan).

El server soporta TLS opcional vía env vars `TLS_CERT` + `TLS_KEY` (ver sección siguiente). Soporta también servir archivos estáticos desde `public/` con MIME y `Cache-Control` apropiados — el worklet vive ahí como `/pcm-sink.js`.

## Añadir un nuevo reader

1. Crear `src/audio/readers/<nombre>.ts`:

   ```ts
   import type { ConfigSchema, ReaderConfigInput } from "../../config/schema.ts";
   import { resolveReaderConfig } from "../../config/schema.ts";
   import type { SampleFormat } from "../types.ts";
   import { SpawnedAudioReader } from "./process-reader.ts";

   export interface CoreAudioConfig {
     sampleRate: number;
     channels: number;
     sampleFormat: SampleFormat;
     device?: string;
   }

   export const CoreAudioSchema: ConfigSchema<CoreAudioConfig> = {
     required: ["sampleRate", "channels", "sampleFormat"],
     optional: ["device"],
     defaults: { device: "default" },
     fields: { sampleRate: "number", channels: "number", sampleFormat: "enum", device: "string" },
     enums: { sampleFormat: ["s16le", "s32le", "f32le"] },
   };

   export type CoreAudioInput = ReaderConfigInput<CoreAudioConfig>;

   export class CoreAudioReader extends SpawnedAudioReader {
     static canonical(): CoreAudioConfig {
       return { sampleRate: 44100, channels: 2, sampleFormat: "s16le" };
     }
     constructor(input: CoreAudioInput = CoreAudioReader.canonical()) {
       const cfg = resolveReaderConfig(input, CoreAudioSchema, "coreaudio");
       super({
         command: "ffmpeg",
         args: ["-f", "avfoundation", "-i", `:${cfg.device}`, "-ar", String(cfg.sampleRate),
                "-ac", String(cfg.channels), "-f", "s16le", "-"],
         format: { sampleRate: cfg.sampleRate, channels: cfg.channels, sampleFormat: cfg.sampleFormat },
         label: "coreaudio",
       });
     }
   }
   ```

2. Registrar en `src/audio/registry.ts`:

   ```ts
   const coreaudio: ReaderFactory<CoreAudioConfig> = {
     name: "coreaudio",
     schema: CoreAudioSchema,
     canonical: CoreAudioReader.canonical,
     create: (cfg) => new CoreAudioReader(cfg),
   };
   export const REGISTRY = { ..., coreaudio } as const;
   ```

3. Exportar desde `src/audio/index.ts`.

Listo. `--reader coreaudio`, `--reader coreaudio --configjson ...`, `--reader coreaudio --sampleRate 48000` y `--help` ya funcionan.

Para backends sin child process (p. ej. un binding nativo a CoreAudio directo), extender `BaseAudioSystemReader` en lugar de `SpawnedAudioReader` y llamar a `emitChunk({ data, timestamp: Date.now() })` desde el callback nativo.

## Smoke tests

`bun run scripts/smoke.ts` arranca nueve subprocesos del server y verifica el comportamiento end-to-end:

```
[OK]   auto-detect → backend disponible
[OK]   --reader pipewire (canonical)
[OK]   --reader pipewire --configjson examples/pipewire.json
[OK]   --reader pipewire --sampleRate 48000 (inline override)
[OK]   --reader pulseaudio --device @DEFAULT_SINK@ --latencyMs 30
[OK]   JSON con campos requeridos omitidos          (rechazado, exit != 0)
[OK]   flag desconocido                            (rechazado, exit != 0)
[OK]   reader desconocido                          (rechazado, exit != 0)
[OK]   JSON con required omitidos (real)           (rechazado, exit != 0)

9/9 ok
```

## Estructura del proyecto

```
.
├── index.html                 # cliente web (worklet + fallback ScriptProcessor + WS)
├── package.json
├── tsconfig.json
├── examples/                  # JSON configs listas por reader
├── public/
│   └── pcm-sink.js            # AudioWorkletProcessor servido como estático
├── scripts/
│   ├── smoke.ts               # smoke tests del CLI (9 casos)
│   └── gen-cert.sh            # genera cert TLS autofirmado para LAN
├── certs/                     # (opcional) cert.pem + key.pem generados por gen-cert.sh
└── src/
    ├── config/
    │   └── schema.ts          # ConfigSchema<T>, validate, loadConfigFromFile,
    │                          # mergeWithDefaults, applyCliFlags, resolveReaderConfig
    ├── audio/
    │   ├── AudioSystemReader.ts   # interfaz + BaseAudioSystemReader (emitter + AsyncIterable)
    │   ├── types.ts               # AudioFormat, AudioChunk
    │   ├── detect.ts              # auto-detect del backend disponible
    │   ├── registry.ts            # REGISTRY: name -> { schema, canonical, create }
    │   ├── index.ts               # barrel
    │   └── readers/
    │       ├── process-reader.ts  # SpawnedAudioReader (PCM por stdout)
    │       ├── pulseaudio.ts      # parec
    │       ├── pipewire.ts        # pw-record
    │       ├── alsa-loopback.ts   # arecord -D hw:Loopback,1,0
    │       ├── jack.ts            # jack_rec / sox
    │       └── wasapi.ts          # ffmpeg -f wasapi o node-wasapi-loopback
    ├── cli.ts                  # parseArgs, buildReader, printHelp
    └── server.ts               # Bun.serve (HTTP/HTTPS + WebSocket, static files)
```

## Notas / limitaciones

- El contrato del cliente web (`type:hello` JSON + frames binarios s16le) está pensado para audio del sistema, no como un stream genérico de media. Para algo más rico (codecs, resampling, jitter buffer de cliente) el reader necesitaría un pipeline más complejo o un transporte diferente.
- El cliente (`index.html`) decodifica s16le estéreo directamente al `AudioContext`. Si cambias `sampleFormat` o `channels`, el cliente actualmente no se adapta: el formato debe coincidir o hay que ajustar el decoder en `index.html`.
- En Linux, `--reader jack` requiere un servidor JACK en marcha (p. ej. `pipewire-jack-client` o `jackd`). En macOS, JACK se puede levantar con `jackdmp` o `jack2`.
- En WASAPI, el backend `auto` requiere `node-wasapi-loopback` instalado para tomar el camino nativo; sin él, cae automáticamente a `ffmpeg -f wasapi -loopback 1`.
- **AudioWorklet y contexto seguro**: sobre HTTP plano en LAN el cliente cae automáticamente a `ScriptProcessorNode` (~23 ms extra de latencia). Activar `AudioWorklet` exige HTTPS o `localhost` — ver [HTTPS / TLS en LAN](#https--tls-en-lan).

## Licencia

MIT (o la que aplique según el repositorio upstream).
