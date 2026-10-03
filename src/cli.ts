import {
  applyCliFlags,
  loadConfigFromFile,
  mergeWithDefaults,
  validate,
  type ConfigSchema,
} from "./config/schema.ts";
import {
  REGISTRY,
  getFactory,
  listReaders,
  type ReaderKind,
} from "./audio/registry.ts";
import { detectReader } from "./audio/detect.ts";
import type { AudioSystemReader } from "./audio/AudioSystemReader.ts";

export interface ParsedArgs {
  /** `--reader` o `--reader auto` (default). */
  reader: string;
  /** Ruta al JSON de config del reader seleccionado. */
  configPath?: string;
  /** Flags sueltos `--key value` que se aplican encima del JSON. */
  flags: Record<string, string>;
  /** `--help` o `-h`. */
  help: boolean;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    reader: "auto",
    flags: {},
    help: false,
  };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i]!;
    if (a === "--reader" || a === "-r") {
      const v = argv[++i];
      if (!v) throw new Error("--reader requiere un valor (ej. --reader pulseaudio)");
      out.reader = v;
    } else if (a === "--configjson" || a === "--config" || a === "--json") {
      const v = argv[++i];
      if (!v) throw new Error("--configjson requiere una ruta");
      out.configPath = v;
    } else if (a === "--help" || a === "-h") {
      out.help = true;
    } else if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        out.flags[key] = next;
        i++;
      } else {
        out.flags[key] = "true";
      }
    } else {
      throw new Error(`argumento posicional no soportado: ${a}`);
    }
    i++;
  }
  return out;
}

/**
 * Construye el config final a partir de: canonical < JSON < CLI flags,
 * y lo valida. Si no hay `--configjson`, parte del `canonical()` del reader
 * (cumple los `required` automáticamente). Si lo hay, exige los `required`
 * en el JSON (loader estricto).
 */
function buildConfigFor<C extends object>(
  name: ReaderKind,
  schema: ConfigSchema<C>,
  canonical: () => C,
  args: ParsedArgs,
): C {
  let partial: Partial<C>;
  if (args.configPath) {
    // JSON es estricto: loadConfigFromFile exige `required` y tipos correctos.
    partial = loadConfigFromFile(args.configPath, schema, name);
  } else {
    // Sin JSON: partir del canonical (cumple required).
    partial = canonical();
  }
  // Flags opcionales (JSON o canonical pueden ser sobreescritos).
  partial = applyCliFlags(partial, args.flags, schema, name);
  // Defaults del schema rellenan cualquier optional que falte.
  partial = mergeWithDefaults(partial, schema);
  // Validación final (tipos + unknown keys).
  return validate(partial, schema, name);
}

export interface BuildReaderResult {
  reader: AudioSystemReader;
  kind: ReaderKind | "auto";
}

export async function buildReader(args: ParsedArgs): Promise<BuildReaderResult> {
  if (args.reader === "auto") {
    return detectReader({ preferAvailableBinaries: true });
  }
  const factory = getFactory(args.reader);
  if (!factory) {
    throw new Error(
      `reader desconocido '${args.reader}'. Disponibles: ${listReaders().join(", ")}`,
    );
  }
  const kind = args.reader as ReaderKind;
  // Cast seguro: `factory.schema` es `ConfigSchema<C>` en runtime.
  const schema = factory.schema as ConfigSchema<object>;
  const canonical = factory.canonical as () => object;
  const config = buildConfigFor(kind, schema, canonical, args);
  return { reader: factory.create(config), kind };
}

export function printHelp(): void {
  const lines: string[] = [];
  lines.push("Uso: bun run src/server.ts [opciones]");
  lines.push("");
  lines.push("Opciones:");
  lines.push("  -r, --reader <nombre>      reader (auto|pulseaudio|pipewire|alsa-loopback|jack|wasapi-loopback)");
  lines.push("      --configjson <ruta>   ruta al JSON con la config del reader");
  lines.push("      --<clave> <valor>     flag inline del reader (se mergea encima del JSON)");
  lines.push("  -h, --help                 muestra esta ayuda");
  lines.push("");
  lines.push("Cada reader declara campos 'obligatorios' (sin defaults) y 'opcionales' (con defaults).");
  lines.push("Si pasas --configjson, el JSON debe contener todos los obligatorios.");
  lines.push("Si no pasas --configjson, se usa el config 'canonical' del reader y los flags lo sobreescriben.");
  lines.push("");
  lines.push("Schemas disponibles:");
  for (const name of listReaders()) {
    const f = REGISTRY[name];
    const req = f.schema.required.length > 0 ? f.schema.required.join(", ") : "(ninguno)";
    const opt = f.schema.optional.length > 0 ? f.schema.optional.join(", ") : "(ninguno)";
    const def = f.schema.defaults
      ? Object.entries(f.schema.defaults)
          .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
          .join(", ")
      : "";
    lines.push(`  ${name}`);
    lines.push(`    obligatorios: ${req}`);
    lines.push(`    opcionales:  ${opt}`);
    if (def) lines.push(`    defaults:     ${def}`);
  }
  console.log(lines.join("\n"));
}
