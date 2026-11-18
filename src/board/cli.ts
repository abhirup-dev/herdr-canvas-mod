// The board CLI: the commands, flags and output of mcp-excalidraw-server 2.1.2's CLI (`excalidraw-canvas`) that
// the excalidraw skill uses, against one board's REST URL. Results are JSON on stdout (except `describe`, and raw
// content without --out); diagnostics on stderr. Exit codes: 0 ok, 1 error, 2 usage, 3 board unreachable.
//   await run(["add", "-"], { url: "http://127.0.0.1:3077/b/t72", ensure })   -> exit code
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Alignment, align, type Direction, distribute, duplicate, group, setLocked, ungroup } from "./arrange.ts";
import { BoardClient, BoardHttpError, UnreachableError } from "./client.ts";
import { labelOverflowWarnings } from "./overflow.ts";
import { describeScene, prepareElement, prepareUpdate } from "./prepare.ts";
import { renderingWarnings } from "./render.ts";
import { sceneFile } from "./scene-file.ts";
import { type BoardElement, type DiagramBlock, isBlockId } from "./store.ts";

export interface CliOptions {
  /** The board's base URL, e.g. http://127.0.0.1:3077/b/t72. */
  readonly url: string;
  /** Makes sure the sidecar runs; called before every board command (the upstream CLI's auto-start). */
  readonly ensure?: () => Promise<void>;
  /** Input for `-` / no file (default: process stdin). */
  readonly stdin?: () => Promise<string>;
}

class UsageError extends Error {}

type Flags = Record<string, string | boolean | string[]>;
interface Ctx {
  readonly c: BoardClient;
  readonly pos: string[];
  readonly flags: Flags;
  readonly input: (file: string | undefined, what: string) => Promise<unknown>;
  readonly text: (file: string | undefined) => Promise<string>;
}
interface Command {
  readonly usage: string;
  readonly summary: string;
  /** Flag name -> takes a value (string) / boolean switch / repeatable value. */
  readonly flags?: Record<string, "value" | "switch" | "repeat">;
  readonly run: (x: Ctx) => Promise<void>;
}

const print = (v: unknown): void => {
  process.stdout.write(`${JSON.stringify(v, null, 2)}\n`);
};
const str = (v: unknown) => (typeof v === "string" ? v : undefined);

function asUsage(e: unknown): never {
  const message = e instanceof Error ? e.message : String(e);
  if (/^id .+ exists; use update$/.test(message)) throw new UsageError(message);
  throw e;
}

/** JSON result. `warnings` is present only when a touched label does not fit its shape. */
/** Prints a write's result with both kinds of warnings: labels that overflow their shape, and arrow labels drawn beside the shaft. */
async function finish(c: BoardClient, body: Record<string, unknown>, elements: BoardElement[]): Promise<void> {
  const warnings = [
    ...labelOverflowWarnings(elements),
    ...((await renderingWarnings(await c.elements())).warnings ?? []),
  ];
  print(warnings.length ? { ...body, warnings } : body);
}

function parseArgs(
  argv: string[],
  spec: Record<string, "value" | "switch" | "repeat">,
): { pos: string[]; flags: Flags } {
  const pos: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i] as string;
    if (!tok.startsWith("--")) {
      pos.push(tok);
      continue;
    }
    const [name, inline] = tok.slice(2).split(/=(.*)/s) as [string, string | undefined];
    const kind = spec[name];
    if (!kind) throw new UsageError(`Unknown flag --${name}`);
    if (kind === "switch") {
      if (inline !== undefined) throw new UsageError(`Flag --${name} does not take a value`);
      flags[name] = true;
      continue;
    }
    const value = inline ?? argv[++i];
    if (value === undefined) throw new UsageError(`Flag --${name} requires a value`);
    flags[name] = kind === "repeat" ? [...((flags[name] as string[] | undefined) ?? []), value] : value;
  }
  return { pos, flags };
}

const idList = (v: unknown, usage: string): string[] => {
  const ids = (str(v) ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!ids.length) throw new UsageError(usage);
  return ids;
};

function parseJson(raw: string, what: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new UsageError(`Invalid JSON ${what}: ${(e as Error).message}`);
  }
}

// --- element commands ------------------------------------------------------------------------------------

async function applyUpdates(
  c: BoardClient,
  entries: Record<string, unknown>[],
  known: Map<string, BoardElement>,
): Promise<BoardElement[]> {
  const updated: BoardElement[] = [];
  for (const u of entries) {
    const { id, set, ...rest } = u as { id?: unknown; set?: unknown } & Record<string, unknown>;
    if (typeof id !== "string" || !id) throw new UsageError('Every update entry needs an "id"');
    if (set !== undefined && (Object.keys(rest).length || !set || typeof set !== "object"))
      throw new UsageError('Use either direct update fields or "set" (an object), not both');
    const existing = known.get(id);
    if (!existing) throw new Error(`Element ${id} not found`);
    updated.push(await c.update(id, prepareUpdate((set ?? rest) as Record<string, unknown>, existing.type, existing)));
  }
  return updated;
}

async function applyPatch({ c, pos, input }: Ctx): Promise<void> {
  const raw = await input(pos[0], "patch");
  const patch = (Array.isArray(raw) ? { create: raw } : raw) as {
    create?: Record<string, unknown>[];
    update?: Record<string, unknown>[];
    delete?: string[];
  };
  if (!patch.create?.length && !patch.update?.length && !patch.delete?.length)
    throw new UsageError("Patch has no create/update/delete operations");
  const created = patch.create?.length ? await c.batch(patch.create.map(prepareElement)).catch(asUsage) : [];
  const known = new Map((await c.elements()).map((e) => [e.id, e]));
  const updated = await applyUpdates(c, patch.update ?? [], known);
  for (const id of patch.delete ?? []) await c.remove(id);
  const deleted = patch.delete?.length ?? 0;
  await finish(c, { success: true, created: created.length, updated: updated.length, deleted, elements: created }, [
    ...created,
    ...updated,
  ]);
}

async function add({ c, pos, flags, input }: Ctx): Promise<void> {
  const one = str(flags.one);
  const raw = one !== undefined ? [parseJson(one, "in --one")] : await input(pos[0], "elements");
  const els = (Array.isArray(raw) ? raw : [raw]) as Record<string, unknown>[];
  const created = await c.batch(els.map(prepareElement)).catch(asUsage);
  await finish(c, { success: true, count: created.length, elements: created }, created);
}

async function update({ c, pos, flags, input }: Ctx): Promise<void> {
  const id = pos[0];
  if (!id) throw new UsageError("Usage: update <id> --set '{...}'");
  const set = str(flags.set);
  const fields = (set !== undefined ? parseJson(set, "in --set") : await input(pos[1], "updates")) as Record<
    string,
    unknown
  >;
  const existing = await c.get(id);
  const element = await c.update(id, prepareUpdate(fields, existing.type, existing));
  await finish(c, { success: true, element }, [element]);
}

async function query({ c, flags }: Ctx): Promise<void> {
  const q = new URLSearchParams();
  const type = str(flags.type);
  if (type) q.set("type", type);
  const bbox = str(flags.bbox);
  if (bbox) {
    const p = bbox.split(",").map((s) => Number(s.trim()));
    if (p.length !== 4 || p.some(Number.isNaN)) throw new UsageError('--bbox expects "x_min,y_min,x_max,y_max"');
    ["x_min", "y_min", "x_max", "y_max"].forEach((k, i) => {
      q.set(k, String(p[i]));
    });
  }
  let els = q.size ? await c.search(q) : await c.elements();
  const lookup = (o: unknown, key: string) =>
    key.split(".").reduce<unknown>((a, k) => (a == null ? a : (a as Record<string, unknown>)[k]), o);
  const matches = (actual: unknown, ...want: unknown[]) =>
    Array.isArray(actual) ? want.some((w) => actual.includes(w)) : want.includes(actual);
  for (const pair of (flags.filter as string[] | undefined) ?? []) {
    const eq = pair.indexOf("=");
    if (eq < 0) throw new UsageError(`--filter expects key=value, got "${pair}"`);
    const [key, raw] = [pair.slice(0, eq), pair.slice(eq + 1)];
    els = els.filter((e) => matches(lookup(e, key), raw, coerce(raw)));
  }
  const fj = str(flags["filter-json"]);
  if (fj) {
    const want = parseJson(fj, "in --filter-json") as Record<string, unknown>;
    els = els.filter((e) => Object.entries(want).every(([k, v]) => matches(lookup(e, k), v)));
  }
  print(els);
}

function coerce(v: string): unknown {
  if (v === "true" || v === "false") return v === "true";
  if (v === "null") return null;
  return v.trim() !== "" && !Number.isNaN(Number(v)) ? Number(v) : v;
}

// --- scene commands --------------------------------------------------------------------------------------

async function screenshot({ c, flags }: Ctx): Promise<void> {
  const out = str(flags.out);
  const format = str(flags.format) ?? (out?.toLowerCase().endsWith(".svg") ? "svg" : "png");
  if (format !== "png" && format !== "svg") throw new UsageError("--format must be png or svg");
  const renderer = str(flags.renderer) ?? "auto";
  if (renderer === "browser") throw new UsageError("--renderer browser is not available: boards render headless");
  if (renderer !== "auto" && renderer !== "node") throw new UsageError("--renderer must be auto or node");
  const numFlag = (k: string) => {
    const v = str(flags[k]);
    if (v === undefined) return {};
    if (!Number.isFinite(Number(v))) throw new UsageError(`--${k} must be a number`);
    return { [k]: Number(v) };
  };
  const ids = flags.ids === undefined ? undefined : idList(flags.ids, "--ids needs at least one element id");
  if (ids && flags.frame) throw new UsageError("--ids and --frame are mutually exclusive");
  const img = await c.image({
    format,
    background: !flags["no-background"],
    ...(flags.dark ? { dark: true } : {}),
    ...numFlag("scale"),
    ...numFlag("padding"),
    ...(ids ? { elementIds: ids } : {}),
    ...(str(flags.frame) ? { frameId: flags.frame } : {}),
    ...(flags["no-embed-fonts"] ? { embedFonts: false } : {}),
  });
  for (const w of img.warnings ?? []) process.stderr.write(`warning: ${w}\n`);
  if (!out && format === "svg") return void process.stdout.write(`${img.data}\n`);
  const file = path.resolve(out ?? path.join(os.tmpdir(), `excalidraw-screenshot-${Date.now()}.png`));
  fs.writeFileSync(file, format === "svg" ? img.data : Buffer.from(img.data, "base64"));
  const size = img.width === undefined ? {} : { width: img.width, height: img.height };
  print({ success: true, file, format, renderer: img.renderer ?? "node", ...size });
}

async function exportScene({ c, flags }: Ctx): Promise<void> {
  const out = str(flags.out);
  const format = str(flags.format) ?? "json";
  if (format !== "json" || out?.endsWith(".md")) throw new UsageError("Canvas export writes Excalidraw JSON");
  const { elements, blocks } = await c.scene();
  const scene = sceneFile(elements, blocks);
  const text = JSON.stringify(scene, null, 2);
  if (!out) return void process.stdout.write(`${text}\n`);
  const file = path.resolve(out);
  fs.writeFileSync(file, text, "utf-8");
  print({ success: true, file, elements: scene.elements.length, format });
}

async function importScene({ c, pos, flags, text }: Ctx): Promise<void> {
  const raw = await text(pos[0]);
  if (!raw.trim()) throw new UsageError("No scene provided (pass a .excalidraw file or pipe JSON to stdin)");
  const data = parseJson(raw, "scene") as { elements?: unknown; herdrDraw?: { blocks?: unknown } } | unknown[] | null;
  const els = Array.isArray(data) ? data : data?.elements;
  const blocks = Array.isArray(data) ? undefined : data?.herdrDraw?.blocks;
  if (!Array.isArray(els) || (!els.length && !Array.isArray(blocks)))
    throw new Error("No elements found in the import data");
  const mode = flags.replace ? "replace" : "merge";
  await c.batch(els, mode === "replace", blocks);
  print({ success: true, imported: els.length, files: 0, mode });
}

async function snapshot({ c, pos }: Ctx): Promise<void> {
  const [action, name] = pos;
  if (action === "list") return print(await c.snapshots());
  if ((action !== "save" && action !== "restore") || !name)
    throw new UsageError("Usage: snapshot save|list|restore [name]");
  if (action === "save") {
    const r = await c.saveSnapshot(name);
    return print({ success: true, name, elements: r.elementCount, createdAt: r.createdAt });
  }
  const snap = await c.snapshot(name).catch(() => {
    throw new Error(`Snapshot "${name}" not found`);
  });
  await c.batch(snap.elements, true, snap.blocks);
  print({ success: true, name, restored: snap.elements.length });
}

const ALIGNMENTS = new Set(["left", "center", "right", "top", "middle", "bottom"]);

function readBlockPosition(value: unknown): { x: number; y: number } | undefined {
  const at = str(value);
  if (at === undefined) return;
  const parts = at.split(",").map((part) => part.trim());
  const [x, y] = parts.map(Number);
  if (parts.length !== 2 || parts.some((part) => !part) || !Number.isFinite(x) || !Number.isFinite(y))
    throw new UsageError("--at expects x,y");
  return { x: Number(x), y: Number(y) };
}

async function diagramBlock({ c, pos, flags, text }: Ctx): Promise<void> {
  const [action, id, file] = pos;
  const expected = str(flags["expect-source"]);
  if (expected !== undefined && (action !== "put" || expected === "-"))
    throw new UsageError("--expect-source needs a file and is only supported by block put");
  if (action === "list" && !id) {
    const { blocks } = await c.call<{ blocks: DiagramBlock[] }>("GET", "/api/blocks");
    return print(blocks.map(({ id, x, y, members }) => ({ id, x, y, elements: members.length })));
  }
  if (!action || !["put", "get", "source", "move", "remove", "detach"].includes(action) || !isBlockId(id))
    throw new UsageError("Choose a block action and a valid block ID");
  if (pos.length > (action === "put" ? 3 : 2)) throw new UsageError("Too many block arguments");
  const position = readBlockPosition(flags.at);
  const url = `/api/blocks/${encodeURIComponent(id)}`;
  if (action === "get" || action === "source") {
    const block = await c.getBlock(id);
    if (action === "get") return print(block);
    return void process.stdout.write(block.source);
  }
  if (action === "move") {
    if (!position) throw new UsageError("move needs --at x,y");
    return print(await c.call("PATCH", url, position));
  }
  if (action === "detach") return print(await c.call("POST", `${url}/detach`));
  if (action === "remove") return print(await c.call("DELETE", url));
  const source = await text(file);
  const guard = expected === undefined ? {} : { expectedSource: await text(expected) };
  print(await c.putBlock(id, source, { ...position, ...guard }));
}

async function arrange({ c, pos, flags }: Ctx): Promise<void> {
  const op = pos[0];
  const to = str(flags.to);
  const ids = () => idList(flags.ids, `Usage: arrange ${op} --ids a,b,c`);
  if (op === "align") {
    if (!to || !ALIGNMENTS.has(to))
      throw new UsageError("arrange align requires --to left|center|right|top|middle|bottom");
    return print(await align(c, ids(), to as Alignment));
  }
  if (op === "distribute") {
    if (to !== "horizontal" && to !== "vertical")
      throw new UsageError("arrange distribute requires --to horizontal|vertical");
    return print(await distribute(c, ids(), to as Direction));
  }
  if (op === "group") return print(await group(c, ids()));
  if (op === "ungroup") {
    const g = str(flags.group);
    if (!g) throw new UsageError("Usage: arrange ungroup --group <groupId>");
    return print(await ungroup(c, g));
  }
  if (op === "lock" || op === "unlock") {
    const r = await setLocked(c, ids(), op === "lock");
    return print({ [op === "lock" ? "locked" : "unlocked"]: true, ...r });
  }
  if (op === "duplicate") {
    const [dx, dy] = (str(flags.offset) ?? "20,20").split(",").map((s) => Number(s.trim()));
    if (dx === undefined || dy === undefined || Number.isNaN(dx) || Number.isNaN(dy))
      throw new UsageError('--offset expects "x,y"');
    return print({ success: true, ...(await duplicate(c, ids(), dx, dy)) });
  }
  throw new UsageError("Usage: arrange align|distribute|group|ungroup|lock|unlock|duplicate ...");
}

const IMAGE_FLAGS = {
  out: "value",
  format: "value",
  "no-background": "switch",
  renderer: "value",
  dark: "switch",
  scale: "value",
  padding: "value",
  ids: "value",
  frame: "value",
  "no-embed-fonts": "switch",
} as const;

export const COMMANDS: Record<string, Command> = {
  status: { usage: "status", summary: "Board health and element count", run: async ({ c }) => print(await c.health()) },
  start: { usage: "start", summary: "Start the sidecar if needed", run: async ({ c }) => print(await c.health()) },
  stop: {
    usage: "stop",
    summary: "No-op: the sidecar is shared by every board",
    run: async () =>
      print({ success: true, stopped: false, note: "the herdr-draw sidecar is shared; it keeps running" }),
  },
  apply: {
    usage: "apply [patch.json|-]",
    summary: "Apply a {create,update,delete} patch; creating an existing id is an error",
    run: applyPatch,
  },
  add: {
    usage: "add [elements.json] (or stdin) | add --one '{...}'",
    summary: "Create elements from a JSON array; an existing id is an error (use update)",
    flags: { one: "value" },
    run: add,
  },
  update: { usage: "update <id> --set '{...}'", summary: "Update one element", flags: { set: "value" }, run: update },
  delete: {
    usage: "delete <id> [<id> ...]",
    summary: "Delete elements by id",
    run: async ({ c, pos }) => {
      if (!pos.length) throw new UsageError("Usage: delete <id> [<id> ...]");
      for (const id of pos) await c.remove(id);
      print({ success: true, deleted: pos, count: pos.length });
    },
  },
  get: {
    usage: "get <id>",
    summary: "Get one element by id",
    run: async ({ c, pos }) => {
      if (!pos[0]) throw new UsageError("Usage: get <id>");
      print(await c.get(pos[0]));
    },
  },
  query: {
    usage: "query [--type t] [--bbox x0,y0,x1,y1] [--filter k=v] [--filter-json '{...}']",
    summary: "Query elements",
    flags: { type: "value", bbox: "value", filter: "repeat", "filter-json": "value" },
    run: query,
  },
  describe: {
    usage: "describe",
    summary: "AI-readable scene description with arrow endpoints and frame names",
    run: async ({ c }) => {
      const { elements, blocks } = await c.scene();
      const details = blocks.map(
        (block) => `  ${block.id} at (${block.x}, ${block.y})\n    ${block.members.join(", ")}`,
      );
      const section = details.length ? `\n\n### Mermaid blocks\n${details.join("\n")}` : "";
      process.stdout.write(`${describeScene(elements)}${section}\n`);
    },
  },
  block: {
    usage:
      "block put <id> [file.mmd|-] [--at x,y] [--expect-source before.mmd] | block get|source|remove|detach <id> | block list | block move <id> --at x,y",
    summary: "Generate or manage editable, source-backed Mermaid blocks",
    flags: { at: "value", "expect-source": "value" },
    run: diagramBlock,
  },
  screenshot: {
    usage:
      "screenshot [--out f.png|f.svg] [--format png|svg] [--no-background] [--dark] [--scale N] [--padding N] [--ids a,b] [--frame id] [--no-embed-fonts] [--renderer auto|node]",
    summary: "Render the board to PNG/SVG (headless)",
    flags: IMAGE_FLAGS,
    run: screenshot,
  },
  export: {
    usage: "export [--out scene.excalidraw] [--format json]",
    summary: "Export the scene as .excalidraw JSON",
    flags: { out: "value", format: "value" },
    run: exportScene,
  },
  import: {
    usage: "import [scene.excalidraw|-] [--replace]",
    summary: "Import a .excalidraw file (merge by default)",
    flags: { replace: "switch" },
    run: importScene,
  },
  snapshot: { usage: "snapshot save|list|restore [name]", summary: "Named board snapshots", run: snapshot },
  arrange: {
    usage:
      "arrange align|distribute|group|lock|unlock|duplicate --ids a,b,c [--to ...] [--offset x,y] | arrange ungroup --group <groupId>",
    summary: "Align, distribute, group, lock, duplicate elements",
    flags: { ids: "value", to: "value", group: "value", offset: "value" },
    run: arrange,
  },
  clear: {
    usage: "clear --yes",
    summary: "Clear the whole board",
    flags: { yes: "switch" },
    run: async ({ c, flags }) => {
      if (!flags.yes) throw new UsageError("clear wipes the whole board; pass --yes to confirm");
      print({ success: true, cleared: (await c.clear()).count ?? 0 });
    },
  },
};

function help(): void {
  const lines = Object.values(COMMANDS).map((c) => `  ${c.usage}\n      ${c.summary}`);
  const codes = "exit codes: 0 ok, 1 error, 2 usage, 3 board unreachable";
  process.stdout.write(`Board commands (results are JSON on stdout; ${codes}):\n${lines.join("\n")}\n`);
}

const HELP = new Set(["help", "--help", "-h"]);

/** Runs one board command; resolves to the exit code. */
export async function run(argv: string[], opts: CliOptions): Promise<number> {
  const [name, ...rest] = argv;
  // help, help <command>, <command> --help
  if (!name || HELP.has(name) || rest.some((a) => HELP.has(a) && a !== "help")) {
    const cmd = name && COMMANDS[HELP.has(name) ? (rest[0] ?? "") : name];
    if (cmd) process.stdout.write(`Usage: ${cmd.usage}\n  ${cmd.summary}\n`);
    else help();
    return 0;
  }
  const cmd = COMMANDS[name];
  if (!cmd) {
    process.stderr.write(`Unknown command "${name}". Run \`help\` for the list.\n`);
    return 2;
  }
  const stdin = opts.stdin ?? (() => Bun.stdin.text());
  const text = (file: string | undefined) =>
    file !== undefined && file !== "-" ? Promise.resolve(fs.readFileSync(path.resolve(file), "utf-8")) : stdin();
  try {
    const { pos, flags } = parseArgs(rest, cmd.flags ?? {});
    const input = async (file: string | undefined, what: string) => {
      const raw = await text(file);
      if (!raw.trim()) throw new UsageError(`No ${what} provided (pass a file argument or pipe JSON to stdin)`);
      return parseJson(raw, what);
    };
    if (name !== "stop") await opts.ensure?.();
    await cmd.run({ c: new BoardClient(opts.url), pos, flags, input, text });
    return 0;
  } catch (e) {
    if (e instanceof BoardHttpError && e.status === 404 && /^Not found: \w+ \/api\/blocks/.test(e.message)) {
      process.stderr.write(
        "Error: The running sidecar predates Mermaid blocks. See the upgrade instructions in the Herdr Canvas Mod README.\n",
      );
      return 1;
    }
    process.stderr.write(`Error: ${(e as Error).message}\n`);
    if (e instanceof UsageError) {
      process.stderr.write(`Usage: ${cmd.usage}\n`);
      return 2;
    }
    return e instanceof UnreachableError ? 3 : 1;
  }
}

if (import.meta.main) {
  // Same convention as the upstream CLI: the board URL comes from EXPRESS_SERVER_URL.
  const url = process.env.EXPRESS_SERVER_URL ?? `http://127.0.0.1:${process.env.CANVAS_SIDECAR_PORT ?? 3077}/b/default`;
  process.exitCode = await run(process.argv.slice(2), { url });
}
