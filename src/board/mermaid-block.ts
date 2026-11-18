import { absolutize, normalize, parsePath } from "path-data-parser";
import { detectType, load, parse, render } from "pele/lazy";
import { pointsSize } from "../canvas/edit.ts";
import { isCanvasElement, type Point } from "../canvas/types.ts";
import { withRenderDom } from "./render.ts";
import { type BoardElement, BoardError } from "./store.ts";
import { getDomWindow } from "./upstream/core/render/excalidraw-node/dom.js";
import { measureTextWidth } from "./upstream/core/render/text-metrics.js";

const MAX_SOURCE = 25_000;
const MAX_ELEMENTS = 1_000;
const hasStableNodeIds = new Set(["flowchart", "swimlane", "sequence", "class", "state", "sankey"]);

type Skeleton = Record<string, unknown> & { type: string; x: number; y: number; id?: string };
interface SvgElement {
  readonly textContent: string | null;
  readonly parentElement: SvgElement | null;
  getAttribute(name: string): string | null;
}
interface SvgDocument {
  querySelector(selector: string): SvgElement | null;
  querySelectorAll(selector: string): ArrayLike<SvgElement>;
}

/** Compile Mermaid geometry with a local origin. Only source-backed node ids survive regeneration. */
export async function compileMermaidBlock(
  source: string,
  blockId: string,
  { elbow, fontSize }: { elbow?: boolean; fontSize?: number } = {},
): Promise<BoardElement[]> {
  if (typeof source !== "string" || !source.trim()) throw new BoardError("Mermaid source is required");
  if (source.length > MAX_SOURCE) throw new BoardError(`Mermaid source exceeds ${MAX_SOURCE} characters`);
  const type = detectType(source);
  if (!type) throw new BoardError("Unrecognized Mermaid diagram type");
  try {
    const elements = await withRenderDom(async () => {
      if (type === "sankey") return convertSankey(source, fontSize);
      const { parseMermaidToExcalidraw } = await import("@excalidraw/mermaid-to-excalidraw");
      const { elements, files } = await parseMermaidToExcalidraw(source, {
        ...(elbow === undefined ? {} : { elbow }),
        ...(fontSize === undefined ? {} : { themeVariables: { fontSize: `${fontSize}px` } }),
      });
      if (Object.keys(files ?? {}).length || elements.some((e: Skeleton) => !isCanvasElement(e))) {
        throw new BoardError(
          `Mermaid ${type} did not produce editable canvas elements. Use a Mermaid pin for display.`,
        );
      }
      return elements as Skeleton[];
    });
    if (elements.length === 0) throw new BoardError("Mermaid source produced an empty diagram");
    if (elements.length > MAX_ELEMENTS) throw new BoardError(`Diagram exceeds ${MAX_ELEMENTS} canvas elements`);
    return localElements(elements, blockId, type);
  } catch (error) {
    if (error instanceof BoardError) throw error;
    throw new BoardError(
      `Could not convert Mermaid ${type}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function localElements(elements: Skeleton[], blockId: string, diagramType: string): BoardElement[] {
  const counts = new Map<string, number>();
  for (const { id } of elements) if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  const refs = new Map<string, string>();
  const groups = new Map<string, string>();
  const identified = elements.map((element) => {
    const { id, type } = element;
    const unique = id !== undefined && counts.get(id) === 1;
    const node = type === "rectangle" || type === "diamond" || type === "ellipse";
    const next =
      hasStableNodeIds.has(diagramType) && unique && node
        ? `${blockId}:anchor:${diagramType}:${encodeURIComponent(id)}`
        : `${blockId}:part:${crypto.randomUUID()}`;
    if (unique) refs.set(id, next);
    return { element, id: next };
  });
  const groupIds = (value: unknown) =>
    Array.isArray(value)
      ? value.map((group: string) => {
          const id = groups.get(group) ?? `${blockId}:group:${groups.size}`;
          groups.set(group, id);
          return id;
        })
      : [];
  const min = (axis: "x" | "y", index: 0 | 1) =>
    Math.min(
      ...elements.map((e) => {
        const points = Array.isArray(e.points) ? (e.points as Point[]) : [];
        return e[axis] + Math.min(0, ...points.map((p) => p[index]));
      }),
    );
  const left = min("x", 0);
  const top = min("y", 1);
  const end = (value: unknown) => {
    if (!value || typeof value !== "object" || !("id" in value) || typeof value.id !== "string") return undefined;
    const id = refs.get(value.id);
    return id ? { ...value, id } : undefined;
  };
  return identified.map(({ element: e, id }) => {
    const label = e.label as Record<string, unknown> | undefined;
    return {
      ...e,
      id,
      x: e.x - left,
      y: e.y - top,
      groupIds: groupIds(e.groupIds),
      ...(label ? { label: { ...label, id: `${id}:label`, groupIds: groupIds(label.groupIds) } } : {}),
      ...(e.type === "arrow" ? { start: end(e.start), end: end(e.end) } : {}),
    };
  });
}

const attr = (el: SvgElement, name: string) => Number(el.getAttribute(name));
const dataId = (el: SvgElement | null) => el?.getAttribute("data-id") ?? "";
const fill = (el: SvgElement) => el.getAttribute("fill")?.match(/#[\da-f]{6}\b/i)?.[0] ?? "#4c78a8";
const cubic = (t: number, [a, b, c, d]: readonly [number, number, number, number]) =>
  (1 - t) ** 3 * a + 3 * (1 - t) ** 2 * t * b + 3 * (1 - t) * t ** 2 * c + t ** 3 * d;

function sampleCurve(points: Point[], data: number[]): void {
  const start = points.at(-1);
  if (!start || data.length !== 6 || !data.every(Number.isFinite)) throw new BoardError("Invalid Sankey ribbon curve");
  const [x, y, cx, cy, endX, endY] = data as [number, number, number, number, number, number];
  for (let i = 1; i <= 16; i++) {
    const t = i / 16;
    points.push([cubic(t, [start[0], x, cx, endX]), cubic(t, [start[1], y, cy, endY])]);
  }
}

function ribbon(path: SvgElement): Skeleton {
  const segments = normalize(absolutize(parsePath(path.getAttribute("d") ?? "")));
  const points: Point[] = [];
  for (const { key, data } of segments) {
    const [x, y] = data;
    if ((key === "M" || key === "L") && x !== undefined && y !== undefined) points.push([x, y]);
    if (key === "C") sampleCurve(points, data);
  }
  const first = points[0];
  if (!first || points.length < 3 || segments.at(-1)?.key.toUpperCase() !== "Z")
    throw new BoardError("Invalid closed Sankey ribbon");
  const [x, y] = first;
  const relative = [...points, first].map(([px, py]): Point => [px - x, py - y]);
  return {
    type: "line",
    x,
    y,
    ...pointsSize(relative),
    points: relative,
    backgroundColor: fill(path),
    strokeColor: "none",
    fillStyle: "solid",
    roughness: 0,
    opacity: 45,
  };
}

/** Pele lays out the flows. Its SVG exposes the native boxes and closed cubic ribbons. */
async function convertSankey(source: string, size?: number): Promise<Skeleton[]> {
  await load("sankey");
  const model = parse(source);
  if (model.type !== "sankey") throw new BoardError("Expected Mermaid Sankey source");
  if (model.nodes.length * 2 + model.links.length > MAX_ELEMENTS)
    throw new BoardError(`Diagram exceeds ${MAX_ELEMENTS} canvas elements`);
  if (model.links.some((link) => !Number.isFinite(link.value) || link.value < 0))
    throw new BoardError("Sankey flows must be finite, non-negative numbers");
  const { svg } = render(model, { fontFamily: "Excalifont", ...(size === undefined ? {} : { fontSize: size }) });
  const { DOMParser } = getDomWindow();
  const doc: SvgDocument = new DOMParser().parseFromString(svg, "image/svg+xml");
  const nodes = Array.from(doc.querySelectorAll("rect.pele-sankey-node"));
  if (!nodes.length) throw new BoardError("No editable nodes in the Sankey layout");
  const arrows = Array.from(doc.querySelectorAll("path.pele-sankey-link"), ribbon);
  const labels = Array.from(doc.querySelectorAll(".pele-labels > .pele-label > text"));
  const fontSize = Number(doc.querySelector(".pele-labels")?.getAttribute("font-size")) || 14;
  return [
    ...arrows,
    ...nodes.map(
      (el): Skeleton => ({
        type: "rectangle",
        id: dataId(el),
        x: attr(el, "x"),
        y: attr(el, "y"),
        width: attr(el, "width"),
        height: attr(el, "height"),
        backgroundColor: fill(el),
        strokeColor: "none",
        roughness: 0,
        fillStyle: "solid",
        groupIds: [dataId(el)],
      }),
    ),
    ...labels.map((el): Skeleton => {
      const text = el.textContent ?? "";
      const width = measureTextWidth(text, `${fontSize}px Excalifont`);
      const align = el.getAttribute("text-anchor");
      const offset = align === "end" ? width : 0;
      return {
        type: "text",
        text,
        x: attr(el, "x") - (align === "middle" ? width / 2 : offset),
        y: attr(el, "y") - fontSize,
        width,
        height: fontSize * 1.25,
        fontSize,
        fontFamily: 5,
        groupIds: [dataId(el.parentElement)],
      };
    }),
  ];
}
