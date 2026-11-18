// A board's REST API from the outside (the CLI). `url` is the board's base, e.g. http://127.0.0.1:3077/b/t72.
import type { BoardElement, DiagramBlock, Snapshot } from "./store.ts";

/** The board did not answer (exit code 3). */
export class UnreachableError extends Error {}

export class BoardHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface Image {
  readonly format: "png" | "svg";
  readonly data: string;
  readonly renderer?: string;
  readonly width?: number;
  readonly height?: number;
  readonly warnings?: string[];
}

type Answer = { success?: boolean; error?: string; element?: BoardElement; elements?: BoardElement[] } & Record<
  string,
  unknown
>;

export interface BlockPutResult {
  readonly success: true;
  readonly status: "created" | "updated" | "moved" | "unchanged";
  readonly block: DiagramBlock;
}

const blockPath = (id: string) => `/api/blocks/${encodeURIComponent(id)}`;

export class BoardClient {
  constructor(readonly url: string) {}

  async call<T = Answer>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.url.replace(/\/$/, "")}${path}`, {
        method,
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (e) {
      throw new UnreachableError(`Board at ${this.url} is unreachable (${e instanceof Error ? e.message : e})`);
    }
    const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
    if (!res.ok || data === null)
      throw new BoardHttpError(data?.error ?? `HTTP ${res.status} ${res.statusText}`, res.status);
    return data;
  }

  health = () => this.call<Record<string, unknown>>("GET", "/health");
  elements = async () => (await this.call("GET", "/api/elements")).elements ?? [];
  scene = async () => {
    try {
      return await this.call<{ elements: BoardElement[]; blocks: DiagramBlock[] }>("GET", "/api/scene");
    } catch (e) {
      // An older sidecar can keep serving its live boards after the CLI is upgraded.
      if (!(e instanceof BoardHttpError) || e.status !== 404) throw e;
      return { elements: await this.elements(), blocks: [] };
    }
  };
  getBlock = async (id: string) => (await this.call<{ block: DiagramBlock }>("GET", blockPath(id))).block;
  putBlock = (id: string, source: string, options?: { x?: number; y?: number; expectedSource?: string }) =>
    this.call<BlockPutResult>("PUT", blockPath(id), { ...options, source });
  search = async (q: URLSearchParams) => (await this.call("GET", `/api/elements/search?${q}`)).elements ?? [];
  get = async (id: string) =>
    (await this.call("GET", `/api/elements/${encodeURIComponent(id)}`)).element as BoardElement;
  batch = async (elements: unknown[], replace = false, blocks?: unknown) => {
    // An older sidecar ignores the blocks field in a batch. Check before writing.
    if (blocks !== undefined && !(Array.isArray(blocks) && blocks.length === 0)) await this.call("GET", "/api/blocks");
    return (await this.call("POST", "/api/elements/batch", { elements, replace, blocks })).elements ?? [];
  };
  update = async (id: string, fields: Record<string, unknown>) =>
    (await this.call("PUT", `/api/elements/${encodeURIComponent(id)}`, fields)).element as BoardElement;
  remove = (id: string) => this.call("DELETE", `/api/elements/${encodeURIComponent(id)}`);
  clear = () => this.call("DELETE", "/api/elements/clear");
  saveSnapshot = (name: string) => this.call("POST", "/api/snapshots", { name });
  snapshots = async () => (await this.call<{ snapshots?: unknown[] }>("GET", "/api/snapshots")).snapshots ?? [];
  snapshot = async (name: string) =>
    (await this.call<{ snapshot: Snapshot }>("GET", `/api/snapshots/${encodeURIComponent(name)}`)).snapshot;
  image = (options: Record<string, unknown>) => this.call<Image>("POST", "/api/export/image", options);
}
