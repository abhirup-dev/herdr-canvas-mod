import { describe, expect, test } from "bun:test";
import { handle } from "../src/board/http.ts";
import { prepare } from "../src/board/render.ts";
import { sceneFile } from "../src/board/scene-file.ts";
import { Board } from "../src/board/store.ts";
import { frame, isLocalBoardId, parseClientFrame, parseServerFrame, splitBoard } from "../src/canvas/protocol.ts";
import type { CanvasElement } from "../src/canvas/types.ts";
import { Registry, type Viewer } from "../src/sidecar/boards.ts";

/** A registry whose "conversion" passes raw elements through, so no SDK is loaded. */
const registry = () => new Registry(async (raw) => raw as unknown as CanvasElement[]);

function call(boards: Registry, method: string, path: string, body?: unknown) {
  const init = body === undefined ? { method } : { method, body: JSON.stringify(body) };
  return handle(boards, new Request(`http://127.0.0.1${path}`, init)).then(async (r) => ({
    status: r.status,
    body: (await r.json()) as Record<string, unknown> & { element?: Record<string, unknown>; elements?: unknown[] },
  }));
}

describe("board store", () => {
  test("arrow start/end resolve to edge points and follow a moved shape", () => {
    const b = new Board();
    b.batch([
      { id: "a", type: "rectangle", x: 0, y: 0, width: 100, height: 50 },
      { id: "c", type: "rectangle", x: 300, y: 0, width: 100, height: 50 },
      { id: "ar", type: "arrow", x: 0, y: 0, start: { id: "a" }, end: { id: "c" } },
    ]);
    expect(b.get("ar")).toMatchObject({ x: 108, y: 25, start: { id: "a" }, end: { id: "c" } });
    expect((b.get("ar").points as number[][])[1]?.[0]).toBeCloseTo(184);
    b.update("a", { x: 10 });
    expect(b.get("ar").x).toBe(118);
    expect(b.get("ar").version).toBe(2);
  });

  test("an imported arrow rebinds and disconnects in the saved scene", () => {
    const board = new Board();
    board.batch([
      { id: "a", type: "rectangle", x: 0, y: 0, width: 100, height: 50 },
      { id: "b", type: "rectangle", x: 200, y: 0, width: 100, height: 50 },
      { id: "c", type: "rectangle", x: 400, y: 0, width: 100, height: 50 },
      { id: "arrow", type: "arrow", x: 0, y: 0, start: { id: "a" }, end: { id: "b" } },
    ]);
    board.batch(sceneFile(board.list()).elements, true);
    board.update("arrow", { end: { id: "c" } });
    const reopened = new Board();
    reopened.batch(sceneFile(board.list()).elements, true);
    expect(reopened.get("arrow")).toMatchObject({
      startBinding: { elementId: "a" },
      endBinding: { elementId: "c" },
    });
    expect(reopened.get("b").boundElements).toEqual([]);
    expect(reopened.get("c").boundElements).toEqual([{ id: "arrow", type: "arrow" }]);
    reopened.update("arrow", { end: null });
    reopened.batch(sceneFile(reopened.list()).elements, true);
    expect(reopened.get("arrow").endBinding).toBeNull();
    expect(reopened.get("c").boundElements).toEqual([]);
  });

  test("validates type and coordinates; unknown ids are 404", () => {
    const b = new Board();
    expect(() => b.create({ type: "bogus", x: 0, y: 0 })).toThrow("Invalid element type");
    expect(() => b.create({ type: "rectangle", x: "1", y: 0 })).toThrow("x:");
    expect(() => b.update("nope", { x: 1 })).toThrow(expect.objectContaining({ status: 404 }));
  });

  test("a rejected replace batch leaves the scene as it was", () => {
    const b = new Board();
    b.create({ id: "keep", type: "ellipse", x: 0, y: 0 });
    expect(() =>
      b.batch(
        [
          { type: "rectangle", x: 0, y: 0 },
          { type: "nope", x: 0, y: 0 },
        ],
        true,
      ),
    ).toThrow();
    expect([...b.elements.keys()]).toEqual(["keep"]);
  });

  test("text edits keep originalText in step; snapshots are copies", () => {
    const b = new Board();
    b.create({ id: "t", type: "text", x: 0, y: 0, text: "a", originalText: "a" });
    const snap = b.saveSnapshot("s");
    b.update("t", { text: "b" });
    expect(b.get("t").originalText).toBe("b");
    expect(snap.elements[0]?.text).toBe("a");
  });
});

describe("board REST", () => {
  test("regenerates one live block, reroutes external bindings and undoes the update as one step", async () => {
    const boards = new Registry(async (raw) => (await prepare(raw)) as unknown as CanvasElement[]);
    const boardId = "structured";
    const store = boards.board(boardId);
    const addr = `/b/${boardId}/api/blocks/auth`;
    const source = "sequenceDiagram\nparticipant API\nparticipant Auth\nAPI->>Auth: Validate";
    const { status } = await call(boards, "PUT", addr, { source, x: 300, y: 50 });
    expect(status).toBe(200);
    const target = store.block("auth").members.find((id) => id.endsWith(":Auth-top"))!;
    expect(target).toBeTruthy();
    store.batch([
      { id: "manual", type: "rectangle", x: 0, y: 0, width: 100, height: 50 },
      { id: "external", type: "arrow", x: 0, y: 0, start: { id: "manual" }, end: { id: target } },
    ]);
    const reopened = sceneFile(store.list(), [store.block("auth")]);
    store.batch(reopened.elements, true, reopened.herdrDraw?.blocks);
    const oldArrow = store.get("external");
    expect(oldArrow.endBinding).toMatchObject({ elementId: target });
    const manual = store.get("manual");

    const invalid = await call(boards, "PUT", addr, { source: "not Mermaid" });
    expect(invalid.status).toBe(400);
    expect(store.block("auth").source).toBe(source);
    expect(store.get("external")).toBe(oldArrow);

    const updated = await call(boards, "PUT", addr, {
      source: `${source}\nAuth-->>API: OK`,
      x: 350,
      y: 100,
    });
    expect(updated.status).toBe(200);
    expect(store.block("auth").members).toContain(target);
    expect(store.get("manual")).toBe(manual);
    expect(store.get("external").points).not.toEqual(oldArrow.points);
    expect(store.get("external").endBinding).toMatchObject({ elementId: target });

    const viewer: Viewer = { send() {} };
    await boards.onClient(viewer, boardId, { type: "undo" });
    expect(store.block("auth").source).toBe(source);
    expect(store.get("external")).toBe(oldArrow);
    expect(store.get("manual")).toBe(manual);
    await boards.onClient(viewer, boardId, { type: "redo" });
    expect(store.block("auth").source).toContain("OK");
    expect((await call(boards, "DELETE", addr)).status).toBe(200);
    expect(store.list().map((el) => el.id)).toEqual(["manual", "external"]);
    expect(store.get("external").endBinding).toBeNull();
  });

  test("create, batch with shorthand label and arrow, update, delete, snapshot", async () => {
    const boards = registry();
    const created = await call(boards, "POST", "/b/t1/api/elements", {
      id: "box",
      type: "rectangle",
      x: 0,
      y: 0,
      width: 100,
      height: 50,
      label: { text: "Box" },
    });
    expect(created.status).toBe(200);
    expect(created.body.element).toMatchObject({ id: "box", label: { text: "Box" }, version: 1 });
    const batch = await call(boards, "POST", "/b/t1/api/elements/batch", {
      elements: [
        { id: "end", type: "ellipse", x: 300, y: 0, width: 100, height: 50 },
        { id: "link", type: "arrow", x: 0, y: 0, start: { id: "box" }, end: { id: "end" } },
      ],
    });
    expect(batch.body).toMatchObject({ success: true, count: 2 });
    expect((await call(boards, "PUT", "/b/t1/api/elements/box", { y: 10 })).body.element?.y).toBe(10);
    expect((await call(boards, "GET", "/b/t1/api/elements/search?type=ellipse")).body.count).toBe(1);
    expect((await call(boards, "POST", "/b/t1/api/snapshots", { name: "s" })).body.elementCount).toBe(3);
    expect((await call(boards, "DELETE", "/b/t1/api/elements/end")).status).toBe(200);
    expect((await call(boards, "DELETE", "/b/t1/api/elements/end")).status).toBe(404);
    const snap = await call(boards, "GET", "/b/t1/api/snapshots/s");
    expect((snap.body.snapshot as { elements: unknown[] }).elements).toHaveLength(3);
    expect((await call(boards, "DELETE", "/b/t1/api/elements/clear")).body.count).toBe(2);
  });

  test("boards are isolated; bad board ids and paths are 404; health speaks the upstream identity", async () => {
    const boards = registry();
    await call(boards, "POST", "/b/t1/api/elements", { type: "rectangle", x: 0, y: 0 });
    expect((await call(boards, "GET", "/b/t1/api/elements")).body.count).toBe(1);
    expect((await call(boards, "GET", "/b/t2/api/elements")).body.count).toBe(0);
    expect((await call(boards, "GET", "/b/..%2Fx/api/elements")).status).toBe(404);
    expect((await call(boards, "GET", "/b/t1/api/viewport")).status).toBe(404);
    expect((await call(boards, "POST", "/b/t1/api/elements", { type: "x", x: 0, y: 0 })).status).toBe(400);
    expect((await call(boards, "GET", "/b/t1/health")).body).toMatchObject({
      service: "mcp-excalidraw-canvas",
      elements_count: 1,
    });
    expect((await call(boards, "GET", "/health")).body.service).toBe("herdr-draw-sidecar");
  });

  test("screenshots render headless, per board, also concurrently", async () => {
    const boards = registry();
    await call(boards, "POST", "/b/a/api/elements", { type: "rectangle", x: 0, y: 0, width: 80, height: 40 });
    await call(boards, "POST", "/b/b/api/elements", { type: "ellipse", x: 0, y: 0, width: 300, height: 200 });
    const [a, b] = await Promise.all([
      call(boards, "POST", "/b/a/api/export/image", { format: "png" }),
      call(boards, "POST", "/b/b/api/export/image", { format: "svg" }),
    ]);
    expect(a.body).toMatchObject({ success: true, format: "png", renderer: "node", width: 100, height: 60 });
    expect(b.body).toMatchObject({ success: true, format: "svg" });
    expect(String(b.body.data)).toStartWith("<svg");
    const browser = await call(boards, "POST", "/b/a/api/export/image", { format: "png", renderer: "browser" });
    expect(browser.status).toBe(400);
  }, 30_000);
});

/** A fake mod socket that keeps what it receives, each frame flattened to {board, ...msg}. */
function viewer() {
  const got: Record<string, unknown>[] = [];
  const v: Viewer = {
    send: (d) => {
      const f = parseServerFrame(d);
      if (!f) throw new Error(`not a board frame: ${d}`);
      got.push({ board: f.board, ...f.msg });
    },
  };
  return { v, got };
}
const settle = () => new Promise((r) => setTimeout(r, 5));

describe("sidecar boards", () => {
  test("mods see only their board; undo history is per board", async () => {
    const boards = registry();
    const one = viewer();
    const two = viewer();
    boards.subscribe(one.v, "t1");
    boards.subscribe(two.v, "t2");
    expect(one.got.map((m) => m.type)).toEqual(["status", "scene", "history"]);
    const box = { id: "n", type: "rectangle", x: 0, y: 0, width: 10, height: 10 };
    await boards.onClient(one.v, "t1", { type: "ops", ops: [{ op: "create", element: box }] });
    await settle();
    expect(boards.board("t1").elements.has("n")).toBe(true);
    expect(boards.board("t2").elements.size).toBe(0);
    expect(one.got.some((m) => m.type === "patch" && m.board === "t1")).toBe(true);
    expect(two.got.every((m) => m.board === "t2")).toBe(true);
    expect(one.got.at(-1)).toMatchObject({ type: "history", board: "t1", canUndo: true });
    await boards.onClient(two.v, "t2", { type: "undo" }); // nothing to undo there
    expect(boards.board("t1").elements.has("n")).toBe(true);
    await boards.onClient(one.v, "t1", { type: "undo" });
    expect(boards.board("t1").elements.has("n")).toBe(false);
  });

  test("agent REST edits reach subscribed mods; remote boards report no relay", async () => {
    const boards = registry();
    const mod = viewer();
    boards.subscribe(mod.v, "t1");
    await call(boards, "POST", "/b/t1/api/elements", { id: "r", type: "rectangle", x: 0, y: 0 });
    await settle();
    expect(mod.got.at(-1)).toMatchObject({ type: "patch", board: "t1", rev: 1 });
    expect(boards.info("t1")).toEqual({ id: "t1", elements: 1, viewers: 1 });
    const remote = viewer();
    boards.subscribe(remote.v, "vpsme/t1f");
    expect(remote.got).toEqual([
      { type: "status", board: "vpsme/t1f", upstream: "disconnected", detail: "no relay to vpsme" },
    ]);
    boards.unsubscribe(mod.v);
    expect(boards.info("t1").viewers).toBe(0);
  });

  test("one socket can follow several boards (a relay) and leave one", async () => {
    const boards = registry();
    const relay = viewer();
    await boards.onClient(relay.v, "t1", { type: "subscribe" });
    await boards.onClient(relay.v, "t2", { type: "subscribe" });
    await boards.onClient(relay.v, "t1", { type: "unsubscribe" });
    expect(boards.list().map((b) => [b.id, b.viewers])).toEqual([
      ["t1", 0],
      ["t2", 1],
    ]);
    await call(boards, "POST", "/b/t2/api/elements", { type: "ellipse", x: 0, y: 0 });
    await call(boards, "POST", "/b/t1/api/elements", { type: "ellipse", x: 0, y: 0 });
    await settle();
    expect(relay.got.filter((m) => m.type === "patch").map((m) => m.board)).toEqual(["t2"]);
  });
});

describe("protocol", () => {
  test("frames carry a board and a known message; ids split by machine", () => {
    expect(parseClientFrame(frame("t72", { type: "subscribe" }))).toEqual({
      kind: "board",
      board: "t72",
      msg: { type: "subscribe" },
    });
    expect(parseClientFrame('{"kind":"board","board":"t1","msg":{"type":"unsubscribe"}}')).not.toBeNull();
    expect(parseClientFrame('{"type":"undo","board":"t1"}')).toBeNull();
    expect(parseClientFrame('{"kind":"board","board":"","msg":{"type":"undo"}}')).toBeNull();
    expect(parseClientFrame('{"kind":"board","board":"t1","msg":{"type":"scene"}}')).toBeNull();
    expect(parseClientFrame("null")).toBeNull();
    expect(parseServerFrame(frame("t1", { type: "history", canUndo: true, canRedo: false }))).not.toBeNull();
    expect(parseServerFrame('{"kind":"board","board":"t1","msg":null}')).toBeNull();
    expect(splitBoard("t72")).toEqual({ machine: null, local: "t72" });
    expect(splitBoard("vpsme/t1f")).toEqual({ machine: "vpsme", local: "t1f" });
    expect(isLocalBoardId("t72")).toBe(true);
    expect(isLocalBoardId("..")).toBe(false);
    expect(isLocalBoardId("a/b")).toBe(false);
  });
});
