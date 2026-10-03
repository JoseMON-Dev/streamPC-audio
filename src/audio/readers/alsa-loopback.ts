import type { ConfigSchema, ReaderConfigInput } from "../../config/schema.ts";
import { resolveReaderConfig } from "../../config/schema.ts";
import type { SampleFormat } from "../types.ts";
import { SpawnedAudioReader } from "./process-reader.ts";

export interface AlsaLoopbackConfig {
  /** Opcional. Dispositivo ALSA. Default: `hw:Loopback,1,0`. */
  device?: string;
  /** OBLIGATORIO. */
  sampleRate: number;
  /** OBLIGATORIO. */
  channels: number;
  /** OBLIGATORIO. Solo formatos soportados por arecord. */
  sampleFormat: SampleFormat;
}

export const AlsaLoopbackSchema: ConfigSchema<AlsaLoopbackConfig> = {
  required: ["sampleRate", "channels", "sampleFormat"],
  optional: ["device"],
  defaults: { device: "hw:Loopback,1,0" },
  fields: {
    device: "string",
    sampleRate: "number",
    channels: "number",
    sampleFormat: "enum",
  },
  enums: { sampleFormat: ["s16le", "s32le", "f32le"] },
};

export type AlsaLoopbackInput = ReaderConfigInput<AlsaLoopbackConfig>;

/** arecord usa `-f S16_LE` en mayúsculas. */
const ALSA_FORMAT_FLAG: Record<SampleFormat, string> = {
  s16le: "S16_LE",
  s32le: "S32_LE",
  f32le: "FLOAT_LE",
};

export class AlsaLoopbackReader extends SpawnedAudioReader {
  static canonical(): AlsaLoopbackConfig {
    return {
      device: "hw:Loopback,1,0",
      sampleRate: 44100,
      channels: 2,
      sampleFormat: "s16le",
    };
  }

  constructor(input: AlsaLoopbackInput = AlsaLoopbackReader.canonical()) {
    const cfg = resolveReaderConfig(input, AlsaLoopbackSchema, "alsa-loopback");
    super({
      command: "arecord",
      args: [
        "-D",
        cfg.device!,
        "-f",
        ALSA_FORMAT_FLAG[cfg.sampleFormat],
        "-c",
        String(cfg.channels),
        "-r",
        String(cfg.sampleRate),
        "-t",
        "raw",
        "-q",
      ],
      format: {
        sampleRate: cfg.sampleRate,
        channels: cfg.channels,
        sampleFormat: cfg.sampleFormat,
      },
      label: "alsa-loopback",
    });
  }
}
