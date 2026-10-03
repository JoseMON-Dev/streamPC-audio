import type { ConfigSchema, ReaderConfigInput } from "../../config/schema.ts";
import { resolveReaderConfig } from "../../config/schema.ts";
import type { SampleFormat } from "../types.ts";
import { SpawnedAudioReader } from "./process-reader.ts";

export interface PipeWireConfig {
  /** Opcional. Nombre/serial del nodo PipeWire a capturar. Default: sink monitor del sistema. */
  target?: string;
  /** Opcional. Latencia del nodo PipeWire (e.g. "20ms"). */
  latency?: string;
  /** OBLIGATORIO. */
  sampleRate: number;
  /** OBLIGATORIO. */
  channels: number;
  /** OBLIGATORIO. */
  sampleFormat: SampleFormat;
}

export const PipeWireSchema: ConfigSchema<PipeWireConfig> = {
  required: ["sampleRate", "channels", "sampleFormat"],
  optional: ["target", "latency"],
  fields: {
    target: "string",
    latency: "string",
    sampleRate: "number",
    channels: "number",
    sampleFormat: "enum",
  },
  enums: { sampleFormat: ["s16le", "s32le", "f32le"] },
};

export type PipeWireInput = ReaderConfigInput<PipeWireConfig>;

/** Mapeo interno: sampleFormat del usuario → flag --format que entiende `pw-record`. */
const PW_FORMAT_FLAG: Record<SampleFormat, string> = {
  s16le: "s16",
  s32le: "s32",
  f32le: "f32",
};

export class PipeWireReader extends SpawnedAudioReader {
  static canonical(): PipeWireConfig {
    return {
      sampleRate: 44100,
      channels: 2,
      sampleFormat: "s16le",
    };
  }

  constructor(input: PipeWireInput = PipeWireReader.canonical()) {
    const cfg = resolveReaderConfig(input, PipeWireSchema, "pipewire");
    const args: string[] = [
      "-a",
      `--rate=${cfg.sampleRate}`,
      `--channels=${cfg.channels}`,
      `--format=${PW_FORMAT_FLAG[cfg.sampleFormat]}`,
      "-",
    ];
    if (cfg.target) args.push(`--target=${cfg.target}`);
    if (cfg.latency) args.push(`--latency=${cfg.latency}`);
    super({
      command: "pw-record",
      args,
      format: {
        sampleRate: cfg.sampleRate,
        channels: cfg.channels,
        sampleFormat: cfg.sampleFormat,
      },
      label: "pipewire",
    });
  }
}
