// Browserless file commands. They share the live board's converter and renderer.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { compileMermaidBlock } from "./mermaid-block.ts";
import { prepare, render } from "./render.ts";
import { sceneFile } from "./scene-file.ts";

const flags = {
  help: { type: "boolean", short: "h" },
  out: { type: "string" },
  format: { type: "string" },
  padding: { type: "string" },
  scale: { type: "string" },
  theme: { type: "string" },
  transparent: { type: "boolean" },
  elbow: { type: "boolean" },
  "font-size": { type: "string" },
  "frame-id": { type: "string" },
  "all-frames": { type: "boolean" },
} as const;

class UsageError extends Error {}

function read(path: string): string {
  return readFileSync(path === "-" ? 0 : path, "utf8");
}

function write(path: string, data: string | Buffer): void {
  if (path === "-") process.stdout.write(data);
  else writeFileSync(path, data);
}

function summary(out: string, fields: Record<string, unknown>): void {
  if (out !== "-") process.stdout.write(`${JSON.stringify({ file: resolve(out), ...fields })}\n`);
}

function numeric(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const result = Number(value);
  if (!value.trim() || !Number.isFinite(result)) throw new UsageError(`--${name} expects a number`);
  return result;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function inferFormat(out: string, mermaid: boolean): string {
  const extension = extname(out).toLowerCase();
  if (extension === ".svg") return "svg";
  if (extension === ".png") return "png";
  return mermaid ? "excalidraw" : "png";
}

function parseOptions(args: string[]) {
  try {
    return parseArgs({ args, allowPositionals: true, options: flags });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
}

type Options = ReturnType<typeof parseOptions>["values"];
type Scene = {
  elements: Record<string, unknown>[];
  files: Record<string, unknown>;
  appState: Record<string, unknown>;
};

function fileFormat(mermaid: boolean, out: string, values: Options) {
  if (mermaid && (values["frame-id"] !== undefined || values["all-frames"]))
    throw new UsageError("Frame options require an Excalidraw scene; use render");
  if (!mermaid && (values.elbow || values["font-size"] !== undefined))
    throw new UsageError("--elbow and --font-size require Mermaid input");
  if (values["all-frames"] && (out === "-" || values["frame-id"] !== undefined))
    throw new UsageError("--all-frames needs an output directory and cannot be combined with --frame-id");
  const format = values.format ?? inferFormat(out, mermaid);
  if (format === "svg" || format === "png" || (mermaid && format === "excalidraw")) return format;
  throw new UsageError(`Unsupported output format "${format}"`);
}

async function readScene(input: string, mermaid: boolean, values: Options): Promise<Scene> {
  const source = read(input);
  if (mermaid) {
    const fontSize = values["font-size"] === undefined ? undefined : numeric(values["font-size"], 20, "font-size");
    if (fontSize !== undefined && fontSize <= 0) throw new UsageError("--font-size must be positive");
    const elements = await compileMermaidBlock(source, "diagram", {
      ...(values.elbow ? { elbow: true } : {}),
      ...(fontSize !== undefined ? { fontSize } : {}),
    });
    return { elements, files: {}, appState: {} };
  }
  const scene = object(JSON.parse(source));
  if (!Array.isArray(scene.elements) || !scene.elements.every((element) => element && typeof element === "object"))
    throw new Error("Expected an Excalidraw scene with an elements array");
  return { elements: scene.elements, files: object(scene.files), appState: object(scene.appState) };
}

async function writeImages(out: string, format: "svg" | "png", scene: Scene, values: Options): Promise<void> {
  const { appState, elements, files } = scene;
  const theme = values.theme;
  if (theme !== undefined && theme !== "light" && theme !== "dark")
    throw new UsageError("--theme expects light or dark");
  const options = {
    format,
    padding: numeric(values.padding, 20, "padding"),
    scale: numeric(values.scale, 1, "scale"),
    dark: theme === undefined ? appState.exportWithDarkMode === true : theme === "dark",
    background: !values.transparent && appState.exportBackground !== false,
    ...(typeof appState.viewBackgroundColor === "string" ? { viewBackgroundColor: appState.viewBackgroundColor } : {}),
  };
  const image = async (file: string, frameId?: string) => {
    const result = await render(elements, { ...options, ...(frameId !== undefined ? { frameId } : {}) }, files);
    for (const warning of result.warnings) process.stderr.write(`warning: ${warning}\n`);
    write(file, format === "svg" ? result.data : Buffer.from(result.data, "base64"));
    return { width: result.width, height: result.height };
  };
  if (!values["all-frames"]) return summary(out, { format, ...(await image(out, values["frame-id"])) });
  const frames = elements.filter(
    (element) => (element.type === "frame" || element.type === "magicframe") && !element.isDeleted,
  );
  if (!frames.length) throw new Error("No frames found");
  mkdirSync(out, { recursive: true });
  const outputs: string[] = [];
  for (const [index, frame] of frames.entries()) {
    if (typeof frame.id !== "string" || !frame.id) throw new Error("A frame is missing its id");
    const name = String(frame.name ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 100);
    const number = String(index + 1).padStart(String(Math.max(10, frames.length)).length, "0");
    const file = join(out, `${number}-${name || "frame"}.${format}`);
    await image(file, frame.id);
    outputs.push(resolve(file));
  }
  summary(out, { format, files: outputs });
}

async function run(command: string | undefined, args: string[]): Promise<void> {
  const mermaid = command === "mermaid";
  const { values, positionals } = parseOptions(args);
  if (values.help || args[0] === "help") {
    process.stdout.write(
      `Usage: herdr-draw ${command} <file|-> --out <file|->\n` +
        `  --format ${mermaid ? "excalidraw|png|svg" : "png|svg"}, inferred from output\n` +
        "  --padding <pixels> --scale <1–4> --theme light|dark --transparent\n" +
        (mermaid ? "  --elbow --font-size <pixels>\n" : "  --frame-id <id> | --all-frames\n"),
    );
    return;
  }
  const [input] = positionals;
  const out = values.out;
  if (!input || positionals.length !== 1 || !out) throw new UsageError("Specify one input and --out <file|->");
  const format = fileFormat(mermaid, out, values);
  const scene = await readScene(input, mermaid, values);
  if (format !== "excalidraw") return writeImages(out, format, scene, values);
  const exported = sceneFile(await prepare(scene.elements));
  write(out, `${JSON.stringify(exported, null, 2)}\n`);
  summary(out, { format, elements: exported.elements.length });
}

const [command, ...args] = process.argv.slice(2);
try {
  await run(command, args);
} catch (error) {
  process.stderr.write(`herdr-draw ${command}: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = error instanceof UsageError ? 2 : 1;
}
