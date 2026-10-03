import type { ConfigSchema, ReaderConfigInput } from "../../config/schema.ts";
import { resolveReaderConfig } from "../../config/schema.ts";
import type { SampleFormat } from "../types.ts";
import { SpawnedAudioReader } from "./process-reader.ts";

export type JackBackend = "jack_rec" | "sox";

export interface JackConfig {
  /** Opcional. Default: `jack_rec`. */
  backend?: JackBackend;
  /** Opcional. Solo se usa con backend=sox. */
  portName?: string;
  /** OBLIGATORIO. */
  sampleRate: number;
  /** OBLIGATORIO. */
  channels: number;
  /** OBLIGATORIO. */
  sampleFormat: SampleFormat;
}

export const JackSchema: ConfigSchema<JackConfig> = {
  required: ["sampleRate", "channels", "sampleFormat"],
  optional: ["backend", "portName"],
  defaults: { backend: "jack_rec" },
  fields: {
    backend: "enum",
    portName: "string",
    sampleRate: "number",
    channels: "number",
    sampleFormat: "enum",
  },
  enums: {
    backend: ["jack_rec", "sox"],
    sampleFormat: ["s16le", "s32le", "f32le"],
  },
};

export type JackInput = ReaderConfigInput<JackConfig>;

/** jack_rec solo expone enteros; en ese backend sampleFormat se reduce a s16le | s32le. */
function jackRecArgs(cfg: JackConfig): string[] {
  const fmt: SampleFormat = cfg.sampleFormat === "f32le" ? "s16le" : cfg.sampleFormat;
  const width = fmt === "s32le" ? 32 : 16;
  const fmtTag = fmt === "s32le" ? "s32" : "s16";
  return [
    "-f",
    fmtTag,
    "-b",
    String(width),
    "-c",
    String(cfg.channels),
    "-r",
    String(cfg.sampleRate),
    "-",
  ];
}

function soxArgs(cfg: JackConfig): string[] {
  return [
    "-q",
    "-t",
    "jack",
    cfg.portName ?? "system:playback_1",
    "-r",
    String(cfg.sampleRate),
    "-c",
    String(cfg.channels),
    "-t",
    "raw",
    "-e",
    "signed-integer",
    "-b",
    cfg.sampleFormat === "s32le" ? "32" : "16",
    "-",
  ];
}

export class JackReader extends SpawnedAudioReader {
  static canonical(): JackConfig {
    return {
      backend: "jack_rec",
      sampleRate: 44100,
      channels: 2,
      sampleFormat: "s16le",
    };
  }

  constructor(input: JackInput = JackReader.canonical()) {
    const cfg = resolveReaderConfig(input, JackSchema, "jack");
    const backend = cfg.backend ?? "jack_rec";
    super({
      command: backend === "jack_rec" ? "jack_rec" : "sox",
      args: backend === "jack_rec" ? jackRecArgs(cfg) : soxArgs(cfg),
      format: {
        sampleRate: cfg.sampleRate,
        channels: cfg.channels,
        sampleFormat: cfg.sampleFormat,
      },
      label: "jack",
    });
  }
}
