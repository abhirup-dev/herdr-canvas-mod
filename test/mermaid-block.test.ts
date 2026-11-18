import { describe, expect, test } from "bun:test";
import { compileMermaidBlock } from "../src/board/mermaid-block.ts";
import { withPaints } from "../src/board/paints.ts";
import { prepare } from "../src/board/render.ts";
import { isCanvasElement, type LinearElement } from "../src/canvas/types.ts";

async function prepareCanvas(elements: readonly object[]) {
  return ((await prepare(elements)) as { type: string }[]).filter(isCanvasElement);
}

describe("Mermaid blocks", () => {
  test("namespaces parallel flowchart arrows without losing either binding or label", async () => {
    const source = "flowchart LR\nA[API] -->|fetch| B[DB]\nA -->|store| B";
    const elements = await compileMermaidBlock(source, "request");
    expect(new Set(elements.map((element) => element.id)).size).toBe(elements.length);
    const live = await prepareCanvas(elements);
    const arrows = live.filter((element): element is LinearElement => element.type === "arrow");
    expect(arrows).toHaveLength(2);
    for (const arrow of arrows) {
      expect(arrow.startBinding?.elementId).toBe("request:anchor:flowchart:A");
      expect(arrow.endBinding?.elementId).toBe("request:anchor:flowchart:B");
    }
    expect(live.filter((element) => element.type === "text").map((element) => element.text)).toEqual(
      expect.arrayContaining(["fetch", "store", "API", "DB"]),
    );
  });

  test("keeps participant identity when inserting a message", async () => {
    const initial = "sequenceDiagram\nparticipant A as API\nparticipant B as Auth\nA->>B: Validate\nB-->>A: OK";
    const updated = initial.replace("B-->>A", "A->>B: Fetch role\nB-->>A");
    const before = await compileMermaidBlock(initial, "auth");
    const after = await compileMermaidBlock(updated, "auth");
    const anchors = (elements: typeof before) => elements.filter((e) => e.type === "rectangle").map((e) => e.id);
    expect(anchors(after)).toEqual(anchors(before));
    const live = await prepareCanvas(after);
    expect(live.some((e) => e.type === "text" && e.text === "Fetch role" && e.containerId)).toBe(true);
  });

  test("converts Gantt tasks to native bars and visible labels", async () => {
    const elements = await compileMermaidBlock(
      "gantt\n  dateFormat YYYY-MM-DD\n  section Release\n  Build :build, 2026-11-20, 2d\n  Ship :ship, after build, 1d",
      "release",
    );
    const live = await prepareCanvas(elements);
    expect(live.some((e) => e.type === "rectangle" && e.width > 0)).toBe(true);
    expect(live.filter((element) => element.type === "text").map((element) => element.text)).toEqual(
      expect.arrayContaining(["Build", "Ship"]),
    );
  });

  test("creates native Sankey nodes and filled ribbon paints", async () => {
    const elements = await compileMermaidBlock("sankey-beta\nAPI,Cache,60\nAPI,DB,40\nDB,Disk,20", "traffic");
    const live = withPaints(await prepareCanvas(elements));
    expect(live.find((e) => e.id === "traffic:anchor:sankey:API")?.type).toBe("rectangle");
    const ribbons = live.filter((e): e is LinearElement => e.type === "line");
    expect(ribbons).toHaveLength(3);
    for (const ribbon of ribbons) {
      expect(ribbon.points[0]).toEqual(ribbon.points.at(-1));
      expect(ribbon.paints?.map((paint) => paint.kind)).toEqual(["fill"]);
    }
    expect(live.some((e) => e.type === "text" && e.text === "Cache 60")).toBe(true);
  });

  test("reports invalid syntax, circular flows, uneditable output and oversized source", async () => {
    await expect(compileMermaidBlock("sequenceDiagram\nA ! B: nope", "bad")).rejects.toThrow("Parse error");
    await expect(compileMermaidBlock("sankey-beta\nA,B,3\nB,A,2", "bad")).rejects.toThrow("circular");
    await expect(compileMermaidBlock("sankey-beta\nA,B,-2", "bad")).rejects.toThrow("non-negative");
    await expect(compileMermaidBlock('pie\n"A" : 42', "pie")).rejects.toThrow("did not produce editable");
    await expect(compileMermaidBlock("A".repeat(25_001), "large")).rejects.toThrow("exceeds");
  });
});
