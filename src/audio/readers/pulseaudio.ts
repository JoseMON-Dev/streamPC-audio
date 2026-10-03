import type { ConfigSchema, ReaderConfigInput } from "../../config/schema.ts";
import { resolveReaderConfig } from "../../config/schema.ts";
import type { SampleFormat } from "../types.ts";
import { SpawnedAudioReader } from "./process-reader.ts";

export interface PulseAudioConfig {
  /** Opcional. Default: `@DEFAULT_MONITOR@`. */
  device?: string;
  /** Opcional. Default: `20`. */
  latencyMs?: number;
  /** OBLIGATORIO. Frecuencia de muestreo en Hz. */
  sampleRate: number;
  /** OBLIGATORIO. Canales. */
  channels: number;
  /** OBLIGATORIO. Formato PCM. */
  sampleFormat: SampleFormat;
}

export const PulseAudioSchema: ConfigSchema<PulseAudioConfig> = {
  required: ["sampleRate", "channels", "sampleFormat"],
  optional: ["device", "latencyMs"],
  defaults: { device: "@DEFAULT_MONITOR@", latencyMs: 20 },
  fields: {
    device: "string",
    latencyMs: "number",
    sampleRate: "number",
    channels: "number",
    sampleFormat: "enum",
  },
  enums: { sampleFormat: ["s16le", "s32le", "f32le"] },
};

export type PulseAudioInput = ReaderConfigInput<PulseAudioConfig>;

const FLAG_FORMAT: Record<SampleFormat, string> = {
  s16le: "s16le",
  s32le: "s32le",
  f32le: "f32le",
};

export class PulseAudioReader extends SpawnedAudioReader {
  static canonical(): PulseAudioConfig {
    return {
      device: "@DEFAULT_MONITOR@",
      latencyMs: 20,
      sampleRate: 44100,
      channels: 2,
      sampleFormat: "s16le",
    };
  }

  constructor(input: PulseAudioInput = PulseAudioReader.canonical()) {
    const cfg = resolveReaderConfig(input, PulseAudioSchema, "pulseaudio");
    super({
      command: "parec",
      args: [
        `--format=${FLAG_FORMAT[cfg.sampleFormat]}`,
        `--channels=${cfg.channels}`,
        `--rate=${cfg.sampleRate}`,
        `--latency-msec=${cfg.latencyMs}`,
        `--device=${cfg.device}`,
      ],
      format: {
        sampleRate: cfg.sampleRate,
        channels: cfg.channels,
        sampleFormat: cfg.sampleFormat,
      },
      label: "pulseaudio",
    });
  }
}
