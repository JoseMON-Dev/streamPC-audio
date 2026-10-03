import { readFileSync } from "node:fs";

export type FieldType = "string" | "number" | "boolean" | "enum";

export interface ConfigSchema<T extends object> {
  readonly required: ReadonlyArray<keyof T & string>;
  readonly optional: ReadonlyArray<keyof T & string>;
  readonly defaults?: Partial<T>;
  readonly fields?: Partial<Record<keyof T & string, FieldType>>;
  readonly enums?: Partial<Record<keyof T & string, readonly string[]>>;
}

export class ConfigError extends Error {
  constructor(
    public readonly readerName: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(`[config/${readerName}] ${message}`);
    this.name = "ConfigError";
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Validación *estricta*:
 *  - rechaza claves desconocidas,
 *  - exige todas las `required` presentes,
 *  - comprueba el tipo declarado por cada campo presente (incluyendo enums),
 *  - NO aplica defaults; eso es responsabilidad de `mergeWithDefaults`.
 */
export function validate<T extends object>(
  raw: unknown,
  schema: ConfigSchema<T>,
  readerName: string,
): T {
  if (!isObject(raw)) {
    throw new ConfigError(
      readerName,
      `config debe ser un objeto JSON, recibido ${raw === null ? "null" : typeof raw}`,
    );
  }
  const allowed = new Set<string>([...schema.required, ...schema.optional]);

  const unknownKeys = Object.keys(raw).filter((k) => !allowed.has(k));
  if (unknownKeys.length > 0) {
    throw new ConfigError(
      readerName,
      `claves desconocidas en config: ${unknownKeys.join(", ")}`,
      { unknown: unknownKeys },
    );
  }

  const missing = schema.required.filter((k) => !(k in raw));
  if (missing.length > 0) {
    throw new ConfigError(
      readerName,
      `faltan campos requeridos: ${missing.join(", ")}`,
      { missing },
    );
  }

  for (const k of allowed) {
    if (!(k in raw)) continue;
    const v = raw[k];
    const t = schema.fields?.[k as keyof T & string];
    if (t === "number") {
      if (typeof v !== "number" || !Number.isFinite(v)) {
        throw new ConfigError(
          readerName,
          `campo '${k}' debe ser número finito, recibido ${JSON.stringify(v)}`,
        );
      }
    } else if (t === "string") {
      if (typeof v !== "string") {
        throw new ConfigError(
          readerName,
          `campo '${k}' debe ser string, recibido ${typeof v}`,
        );
      }
    } else if (t === "boolean") {
      if (typeof v !== "boolean") {
        throw new ConfigError(
          readerName,
          `campo '${k}' debe ser boolean, recibido ${typeof v}`,
        );
      }
    } else if (t === "enum") {
      const enumValues = schema.enums?.[k as keyof T & string];
      if (!enumValues) {
        throw new ConfigError(
          readerName,
          `enum interno no declarado para '${k}' (campo mal definido en schema)`,
        );
      }
      if (typeof v !== "string" || !enumValues.includes(v)) {
        throw new ConfigError(
          readerName,
          `campo '${k}' debe ser uno de [${enumValues.join("|")}], recibido '${String(v)}'`,
        );
      }
    }
  }
  return raw as T;
}

export function loadConfigFromFile<T extends object>(
  path: string,
  schema: ConfigSchema<T>,
  readerName: string,
): T {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    throw new ConfigError(
      readerName,
      `archivo de config no encontrado o inaccesible: ${path} (${(e as Error).message})`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new ConfigError(
      readerName,
      `JSON inválido en ${path}: ${(e as Error).message}`,
    );
  }
  return validate(raw, schema, readerName);
}

export function mergeWithDefaults<T extends object>(
  cfg: Partial<T>,
  schema: ConfigSchema<T>,
): Partial<T> {
  const out: Record<string, unknown> = {};
  if (schema.defaults) {
    for (const [k, v] of Object.entries(schema.defaults as Record<string, unknown>)) {
      out[k] = v;
    }
  }
  for (const [k, v] of Object.entries(cfg as Record<string, unknown>)) {
    if (v !== undefined) out[k] = v;
  }
  return out as Partial<T>;
}

/**
 * Aplica flags CLI (`--key value`) sobre un `Partial<T>`.
 *  - coerción de tipos (number, boolean, string, enum),
 *  - flags con clave no declarada en el schema → error,
 *  - no rellena `required` faltantes (eso es responsabilidad del caller).
 */
export function applyCliFlags<T extends object>(
  cfg: Partial<T>,
  flags: Record<string, string>,
  schema: ConfigSchema<T>,
  readerName: string,
): Partial<T> {
  const out: Record<string, unknown> = { ...(cfg as Record<string, unknown>) };
  const allowed = new Set<string>([...schema.required, ...schema.optional]);
  for (const [k, v] of Object.entries(flags)) {
    if (!allowed.has(k)) {
      throw new ConfigError(readerName, `flag desconocido '--${k}'`, { flag: k });
    }
    const t = schema.fields?.[k as keyof T & string];
    if (t === "number") {
      const n = Number(v);
      if (!Number.isFinite(n)) {
        throw new ConfigError(
          readerName,
          `flag '--${k}' debe ser número, recibido '${v}'`,
        );
      }
      out[k] = n;
    } else if (t === "boolean") {
      out[k] = v === "true" || v === "1";
    } else if (t === "enum") {
      const enumValues = schema.enums?.[k as keyof T & string];
      if (!enumValues || !enumValues.includes(v)) {
        throw new ConfigError(
          readerName,
          `flag '--${k}' debe ser uno de [${(enumValues ?? []).join("|")}], recibido '${v}'`,
        );
      }
      out[k] = v;
    } else {
      out[k] = v;
    }
  }
  return out as Partial<T>;
}

/**
 * Input genérico que acepta el constructor de cualquier reader:
 *  - `string`                              → ruta al JSON
 *  - `{ configPath: string }`               → ruta al JSON (objeto)
 *  - `{ config: Partial<T> }`               → config envuelta
 *  - `Partial<T>`                          → config directa (con defaults aplicados)
 */
export type ReaderConfigInput<T> =
  | string
  | { configPath: string }
  | { config: Partial<T> }
  | Partial<T>;

/**
 * Punto único de validación al construir un reader.
 *  - Si recibe una ruta, la carga y la valida.
 *  - Si recibe un objeto, le aplica los `defaults` y lo valida.
 * Lanza `ConfigError` si el JSON no trae los `required` o si los tipos no coinciden.
 */
export function resolveReaderConfig<T extends object>(
  input: ReaderConfigInput<T>,
  schema: ConfigSchema<T>,
  readerName: string,
): T {
  let partial: Partial<T>;
  if (typeof input === "string") {
    partial = loadConfigFromFile(input, schema, readerName);
  } else if ("configPath" in input) {
    partial = loadConfigFromFile(input.configPath, schema, readerName);
  } else if ("config" in input) {
    partial = input.config;
  } else {
    partial = input as Partial<T>;
  }
  const merged = mergeWithDefaults(partial, schema);
  return validate(merged, schema, readerName);
}
