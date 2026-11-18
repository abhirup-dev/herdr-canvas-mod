// The board REST API, one per board under /b/<board>/: the routes and answers of mcp-excalidraw-server 2.1.2
// that the excalidraw skill's CLI uses (element CRUD, batch, search, clear, snapshots, headless screenshots,
// health). A plain (boards, Request) -> Response function, so tests need no port.
import { isLocalBoardId } from "../canvas/protocol.ts";
import { compileMermaidBlock } from "./mermaid-block.ts";
import { render } from "./render.ts";
import { type Board, type BoardChange, type BoardElement, BoardError, type DiagramBlock, isBlockId } from "./store.ts";
import { RenderError } from "./upstream/core/render/index.js";

export interface BoardInfo {
  readonly id: string;
  readonly elements: number;
  readonly viewers: number;
}

/** What the routes need from the process that owns the boards. */
export interface Boards {
  /** The board, created empty on first use. */
  board(id: string): Board;
  info(id: string): BoardInfo;
  list(): BoardInfo[];
  change?(id: string, job: () => Promise<BoardChange | undefined>): Promise<void>;
  reset?<T>(id: string, job: () => T): Promise<T>;
}

/** Identity the upstream CLI checks on /health before it writes anything. */
const UPSTREAM_SERVICE = "mcp-excalidraw-canvas";
export const SIDECAR_SERVICE = "herdr-draw-sidecar";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const fail = (error: string, status = 400) => json({ success: false, error }, status);

async function body(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (!text) return {};
  const v = JSON.parse(text) as unknown;
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export async function handle(boards: Boards, req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname === "/health")
    return json({ status: "healthy", service: SIDECAR_SERVICE, pid: process.pid, boards: boards.list() });
  if (url.pathname === "/boards") return json({ success: true, boards: boards.list() });
  const m = url.pathname.match(/^\/b\/([^/]+)(\/.*)$/);
  const id = m?.[1] ? decodeURIComponent(m[1]) : "";
  if (!m?.[2] || !isLocalBoardId(id)) return fail(`Not found: ${url.pathname}`, 404);
  try {
    return await route(boards, id, req, m[2], url.searchParams);
  } catch (e) {
    if (e instanceof BoardError || e instanceof RenderError) return fail(e.message, e.status);
    if (e instanceof SyntaxError) return fail(`Invalid JSON: ${e.message}`);
    return fail(String(e instanceof Error ? e.message : e), 500);
  }
}

async function route(boards: Boards, id: string, req: Request, path: string, q: URLSearchParams): Promise<Response> {
  const b = boards.board(id);
  const key = `${req.method} ${path}`;
  if (key === "GET /health") {
    const info = boards.info(id);
    return json({
      status: "healthy",
      service: UPSTREAM_SERVICE,
      board: id,
      timestamp: new Date().toISOString(),
      elements_count: b.elements.size,
      websocket_clients: info.viewers,
      renderers: { node: true, browser: 0 },
      pid: process.pid,
    });
  }
  if (path.startsWith("/api/elements"))
    return elements(b, req, path.slice("/api/elements".length), {
      q,
      reset: (job) => boards.reset?.(id, job) ?? Promise.resolve(job()),
    });
  if (path.startsWith("/api/snapshots")) return snapshots(b, req, path.slice("/api/snapshots".length));
  if (key === "GET /api/scene") return json({ elements: b.list(), blocks: [...b.blocks.values()] });
  if (key === "GET /api/blocks") return json({ blocks: [...b.blocks.values()] });
  const blockPath = /^\/api\/blocks\/([^/]+)(\/detach)?$/.exec(path);
  if (blockPath?.[1]) {
    const blockId = decodeURIComponent(blockPath[1]);
    if (!isBlockId(blockId)) throw new BoardError("Use a block ID of up to 64 letters, digits, hyphens or underscores");
    return block(b, req, { id: blockId, detach: !!blockPath[2] }, (job) => boards.change?.(id, job) ?? job());
  }
  if (key === "POST /api/export/image") return screenshot(b, await body(req));
  return fail(`Not found: ${req.method} ${path}`, 404);
}

async function elements(
  b: Board,
  req: Request,
  rest: string,
  { q, reset }: { q: URLSearchParams; reset: <T>(job: () => T) => Promise<T> },
): Promise<Response> {
  const all = (els: unknown[]) => json({ success: true, elements: els, count: els.length });
  const one = (element: unknown) => json({ success: true, element });
  const key = `${req.method} ${rest}`;
  if (key === "GET ") return all(b.list());
  if (key === "POST ") return one(b.create(await body(req)));
  if (key === "GET /search") return all(b.search(q));
  if (key === "POST /batch") {
    const { elements: els, replace = false, blocks } = await body(req);
    if (typeof replace !== "boolean") throw new BoardError("replace must be a boolean");
    return all(replace ? await reset(() => b.batch(els, true, blocks)) : b.batch(els, false, blocks));
  }
  if (key === "DELETE /clear") {
    const count = await reset(() => b.clear());
    return json({ success: true, message: `Cleared ${count} elements`, count });
  }
  const id = rest.match(/^\/([^/]+)$/)?.[1];
  if (!id) return fail(`Not found: ${req.method} /api/elements${rest}`, 404);
  const elId = decodeURIComponent(id);
  if (req.method === "GET") return one(b.get(elId));
  if (req.method === "PUT") return one(b.update(elId, await body(req)));
  if (req.method === "DELETE") {
    b.remove(elId);
    return json({ success: true, message: `Element ${elId} deleted successfully` });
  }
  return fail(`Not found: ${req.method} /api/elements${rest}`, 404);
}

function blockPosition(o: Record<string, unknown>): { x: number; y: number } | undefined {
  if (o.x === undefined && o.y === undefined) return;
  if (typeof o.x !== "number" || typeof o.y !== "number" || !Number.isFinite(o.x) || !Number.isFinite(o.y))
    throw new BoardError("Block position needs finite x and y coordinates");
  return { x: o.x, y: o.y };
}

function defaultPosition(elements: readonly BoardElement[]): { x: number; y: number } {
  let right = 0;
  for (const el of elements) {
    const x = Number(el.x);
    right = Math.max(right, x, x + Number(el.width ?? 0));
    if (Array.isArray(el.points))
      for (const point of el.points)
        if (Array.isArray(point) && typeof point[0] === "number") right = Math.max(right, x + point[0]);
  }
  return { x: elements.length ? right + 80 : 0, y: 0 };
}

function translate(el: BoardElement, x: number, y: number): BoardElement {
  return { ...el, x: Number(el.x) + x, y: Number(el.y) + y };
}

async function block(
  b: Board,
  req: Request,
  { id, detach }: { id: string; detach: boolean },
  apply: (job: () => Promise<BoardChange | undefined>) => Promise<unknown>,
): Promise<Response> {
  if (!detach && req.method === "GET") return json({ block: b.block(id) });
  if (!detach && !["PUT", "PATCH", "DELETE"].includes(req.method)) return fail("Unknown block operation", 404);
  if (detach && req.method !== "POST") return fail("Unknown block operation", 404);
  const o = await body(req);
  const position = blockPosition(o);
  const put = req.method === "PUT";
  if (o.expectedSource !== undefined && (!put || typeof o.expectedSource !== "string"))
    throw new BoardError("Expected source text is only supported for block put");
  let next: DiagramBlock | undefined;
  let status: "created" | "updated" | "moved" | "unchanged" | undefined;
  await apply(async () => {
    const before = put ? b.blocks.get(id) : b.block(id);
    if (o.expectedSource !== undefined && before?.source !== o.expectedSource)
      throw new BoardError(`Diagram block "${id}" source changed. Read it before retrying.`, 409);
    if (detach || req.method === "DELETE") return b.changeBlock(id, before, undefined, detach ? undefined : []);
    const sameSource = put && before?.source === o.source;
    if (before && (req.method === "PATCH" || sameSource)) {
      if (sameSource && (!position || (position.x === before.x && position.y === before.y))) {
        status = "unchanged";
        next = before;
        return;
      }
      if (!position) throw new BoardError("Move needs a block position");
      const moved = b.blockElements(before).map((el) => translate(el, position.x - before.x, position.y - before.y));
      if (put) status = "moved";
      next = { ...before, ...position };
      return b.changeBlock(id, before, next, moved);
    }
    if (typeof o.source !== "string") throw new BoardError("Expected Mermaid source text");
    status = before ? "updated" : "created";
    const elements = await compileMermaidBlock(o.source, id);
    const { x, y } = position ?? before ?? defaultPosition(b.list());
    next = { id, source: o.source, x, y, members: elements.map((el) => el.id) };
    return b.changeBlock(
      id,
      before,
      next,
      elements.map((el) => translate(el, x, y)),
    );
  });
  return json(
    next ? { success: true, block: next, ...(status ? { status } : {}) } : { success: true, id, detached: detach },
  );
}

async function snapshots(b: Board, req: Request, rest: string): Promise<Response> {
  if (req.method === "POST" && !rest) {
    const s = b.saveSnapshot((await body(req)).name);
    return json({ success: true, name: s.name, elementCount: s.elements.length, createdAt: s.createdAt });
  }
  if (req.method === "GET" && !rest) {
    const list = [...b.snapshots.values()].map((s) => ({
      name: s.name,
      elementCount: s.elements.length,
      createdAt: s.createdAt,
    }));
    return json({ success: true, snapshots: list, count: list.length });
  }
  const name = rest.match(/^\/(.+)$/)?.[1];
  if (req.method === "GET" && name) return json({ success: true, snapshot: b.snapshot(decodeURIComponent(name)) });
  return fail(`Not found: ${req.method} /api/snapshots${rest}`, 404);
}

/** Headless only: there is no browser tab, so renderer "browser" is refused. */
async function screenshot(b: Board, o: Record<string, unknown>): Promise<Response> {
  if (o.format !== "png" && o.format !== "svg") return fail('format must be "png" or "svg"');
  if (o.renderer === "browser") return fail("renderer browser is not available: boards render headless");
  const pick = <T>(k: string, ok: (v: unknown) => boolean): Record<string, T> =>
    o[k] !== undefined && ok(o[k]) ? { [k]: o[k] as T } : {};
  const isNum = (v: unknown) => typeof v === "number";
  const isBool = (v: unknown) => typeof v === "boolean";
  const r = await render(b.list(), {
    format: o.format,
    ...pick<boolean>("background", isBool),
    ...pick<boolean>("dark", isBool),
    ...pick<boolean>("embedFonts", isBool),
    ...pick<number>("scale", isNum),
    ...pick<number>("padding", isNum),
    ...pick<string[]>("elementIds", Array.isArray),
    ...pick<string>("frameId", (v) => typeof v === "string"),
  });
  return json({
    success: true,
    format: r.format,
    data: r.data,
    renderer: "node",
    width: r.width,
    height: r.height,
    ...(r.warnings.length ? { warnings: r.warnings } : {}),
  });
}
