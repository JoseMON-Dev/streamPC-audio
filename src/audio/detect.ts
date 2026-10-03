import type { AudioSystemReader } from "./AudioSystemReader.ts";
import { PulseAudioReader } from "./readers/pulseaudio.ts";
import { PipeWireReader } from "./readers/pipewire.ts";
import { AlsaLoopbackReader } from "./readers/alsa-loopback.ts";
import { JackReader } from "./readers/jack.ts";
import { WasapiLoopbackReader } from "./readers/wasapi.ts";
import type { ReaderKind } from "./registry.ts";

export interface DetectOptions {
  /** Forzar un reader en lugar de auto-descubrir. */
  readonly preferred?: ReaderKind;
  /** Si un binario no existe, prueba el siguiente. `false` = fallo duro. */
  readonly preferAvailableBinaries?: boolean;
}

async function hasBinary(name: string): Promise<boolean> {
  const proc = Bun.spawn(
    ["sh", "-c", `command -v ${name} >/dev/null 2>&1`],
    { stdio: ["ignore", "ignore", "ignore"] },
  );
  const code = await proc.exited;
  return code === 0;
}

/**
 * Auto-descubre el mejor reader disponible para el entorno actual.
 *
 * Orden de preferencia:
 *   1. `opts.preferred` si existe y su binario está disponible.
 *   2. PipeWire (más moderno).
 *   3. PulseAudio (cubre PipeWire-Pulse, Linux estándar).
 *   4. ALSA loopback.
 *   5. JACK.
 *   6. WASAPI en Windows (vía `ffmpeg -f wasapi`).
 *
 * Los readers usan su `static canonical()` como configuración por defecto.
 */
export async function detectReader(
  opts: DetectOptions = {},
): Promise<{ reader: AudioSystemReader; kind: ReaderKind }> {
  const isWindows = process.platform === "win32";
  if (isWindows) {
    return {
      reader: new WasapiLoopbackReader(WasapiLoopbackReader.canonical()),
      kind: "wasapi-loopback",
    };
  }

  const candidates: Array<{
    kind: ReaderKind;
    make: () => AudioSystemReader;
    binary: string;
  }> = [
    { kind: "pipewire", make: () => new PipeWireReader(PipeWireReader.canonical()), binary: "pw-record" },
    { kind: "pulseaudio", make: () => new PulseAudioReader(PulseAudioReader.canonical()), binary: "parec" },
    { kind: "alsa-loopback", make: () => new AlsaLoopbackReader(AlsaLoopbackReader.canonical()), binary: "arecord" },
    { kind: "jack", make: () => new JackReader(JackReader.canonical()), binary: "jack_rec" },
  ];

  const ordered = (() => {
    if (opts.preferred) {
      const idx = candidates.findIndex((c) => c.kind === opts.preferred);
      if (idx >= 0) {
        const [picked] = candidates.splice(idx, 1);
        if (picked) return [picked, ...candidates];
      }
    }
    return candidates;
  })();

  for (const c of ordered) {
    if (await hasBinary(c.binary)) {
      return { reader: c.make(), kind: c.kind };
    }
    if (!opts.preferAvailableBinaries) {
      throw new Error(
        `Binario '${c.binary}' no encontrado. Instala el paquete adecuado o usa AudioSystemReader custom.`,
      );
    }
  }
  throw new Error("No se encontró ningún backend de captura de audio soportado en este sistema.");
}
