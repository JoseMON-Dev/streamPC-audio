import type { ConfigSchema } from "../config/schema.ts";
import type { AudioSystemReader } from "./AudioSystemReader.ts";
import {
  PulseAudioReader,
  type PulseAudioConfig,
  PulseAudioSchema,
} from "./readers/pulseaudio.ts";
import {
  PipeWireReader,
  type PipeWireConfig,
  PipeWireSchema,
} from "./readers/pipewire.ts";
import {
  AlsaLoopbackReader,
  type AlsaLoopbackConfig,
  AlsaLoopbackSchema,
} from "./readers/alsa-loopback.ts";
import {
  JackReader,
  type JackConfig,
  JackSchema,
} from "./readers/jack.ts";
import {
  WasapiLoopbackReader,
  type WasapiLoopbackConfig,
  WasapiLoopbackSchema,
} from "./readers/wasapi.ts";

export type ReaderKind =
  | "pulseaudio"
  | "pipewire"
  | "alsa-loopback"
  | "jack"
  | "wasapi-loopback";

/**
 * Una factory con su schema asociado, de modo que el CLI puede:
 *   - validar el JSON (con `loadConfigFromFile(path, schema, name)`),
 *   - aplicar flags del CLI (con `applyCliFlags(...)`),
 *   - construir el reader (con el config validado vía `create(config)`).
 */
export interface ReaderFactory<C extends object> {
  readonly name: ReaderKind;
  readonly schema: ConfigSchema<C>;
  /** Config canónica (full defaults, incluyendo `required`). Usada por auto-detect. */
  readonly canonical: () => C;
  readonly create: (config: C) => AudioSystemReader;
}

const pulseaudio: ReaderFactory<PulseAudioConfig> = {
  name: "pulseaudio",
  schema: PulseAudioSchema,
  canonical: PulseAudioReader.canonical,
  create: (cfg) => new PulseAudioReader(cfg),
};

const pipewire: ReaderFactory<PipeWireConfig> = {
  name: "pipewire",
  schema: PipeWireSchema,
  canonical: PipeWireReader.canonical,
  create: (cfg) => new PipeWireReader(cfg),
};

const alsaLoopback: ReaderFactory<AlsaLoopbackConfig> = {
  name: "alsa-loopback",
  schema: AlsaLoopbackSchema,
  canonical: AlsaLoopbackReader.canonical,
  create: (cfg) => new AlsaLoopbackReader(cfg),
};

const jack: ReaderFactory<JackConfig> = {
  name: "jack",
  schema: JackSchema,
  canonical: JackReader.canonical,
  create: (cfg) => new JackReader(cfg),
};

const wasapiLoopback: ReaderFactory<WasapiLoopbackConfig> = {
  name: "wasapi-loopback",
  schema: WasapiLoopbackSchema,
  canonical: WasapiLoopbackReader.canonical,
  create: (cfg) => new WasapiLoopbackReader(cfg),
};

/**
 * Registro inmutable: nombre → factory. Cada entrada expone `schema`,
 * `canonical()` y `create(config)`. No usamos `as const` aquí para que el
 * TS permita leer el schema genérico desde el CLI.
 */
export const REGISTRY = {
  pulseaudio,
  pipewire,
  "alsa-loopback": alsaLoopback,
  jack,
  "wasapi-loopback": wasapiLoopback,
} as const;

export type RegisteredFactories = {
  -readonly [K in keyof typeof REGISTRY]: (typeof REGISTRY)[K];
};

export function getFactory(name: string): ReaderFactory<object> | undefined {
  return (REGISTRY as Record<string, ReaderFactory<object>>)[name];
}

export function listReaders(): readonly ReaderKind[] {
  return Object.keys(REGISTRY) as ReaderKind[];
}
