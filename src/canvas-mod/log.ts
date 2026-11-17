import * as fs from "fs/promises";
import { appHome, checking } from "herdr";

// Debug log for herdr-draw (`herdr-draw logs mod`): the mod runtime has no file append, so the last lines are kept
// here and the file rewritten (one writer at a time). Never throws.
const LOG_MAX = 300;
type Spawner = { spawn(f: () => Promise<void>): unknown };
export function modLogger(name: string): ((msg: string) => void) & { use(cx: Spawner): () => void } {
  // Mods may only write under the app home (herdr.d.ts), so mod logs live there; `herdr-draw logs` reads both.
  const dir = `${appHome()}/data/herdr-draw/logs`;
  const file = `${dir}/mod-${name}.log`;
  let lines: string[] = [];
  let writing = false;
  let again = false;
  let loaded = false;
  // Async work in a mod runs through a view's cx.spawn: lines wait until a view lends its cx (log.use).
  // Module code outlives the copies (Herdr 0.1.14+), so a closed copy's cx must not be used: each live copy lends its
  // own and takes it back in close(). The newest lender writes.
  const lenders: Spawner[] = [];
  const write = async (): Promise<void> => {
    if (writing) {
      again = true;
      return;
    }
    writing = true;
    try {
      if (!loaded) {
        loaded = true;
        await fs.mkdir(dir, { recursive: true }).catch(() => {});
        const old = await fs.readFile(file, "utf8").catch(() => "");
        lines = old.split("\n").filter(Boolean).slice(-LOG_MAX).concat(lines);
      }
      if (lines.length > LOG_MAX) lines = lines.slice(-LOG_MAX);
      if (lines.length) await fs.writeFile(file, `${lines.join("\n")}\n`);
    } catch {
      // logging must never break the mod
    }
    writing = false;
    if (again) {
      again = false;
      flush();
    }
  };
  const flush = () => {
    if (checking()) return; // herdr-app check: no file writes
    for (let lender = lenders.at(-1); lender; lender = lenders.at(-1)) {
      try {
        lender.spawn(write);
        return;
      } catch {
        lenders.pop(); // a copy that closed without returning its cx
      }
    }
  };
  const log = (msg: string) => {
    lines.push(`${new Date().toISOString()} app mod-${name} info  ${msg}`);
    flush();
  };
  log.use = (viewCx: Spawner) => {
    lenders.push(viewCx);
    flush();
    return () => {
      const i = lenders.indexOf(viewCx);
      if (i >= 0) lenders.splice(i, 1);
    };
  };
  return log;
}
