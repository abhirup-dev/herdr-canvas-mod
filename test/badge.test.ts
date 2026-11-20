import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import { withBadge } from "../cli/lib/install.mjs";

test("the shipped main layout gets the badge header on its terminal panes", () => {
  const layout = {
    children: [{ content: { tab: "active", pane: { header: { content: { mod: "pane" }, height: 30 } } } }],
  };
  expect(withBadge(layout)).toBe(true);
  expect(layout.children[0]?.content.pane.header.content.mod).toBe("diagram-pane");
  const shipped = `${os.homedir()}/.config/herdr-app/layouts/main.json`;
  if (fs.existsSync(shipped)) expect(withBadge(JSON.parse(fs.readFileSync(shipped, "utf8")))).toBe(true);
});

test("a header another mod draws is left alone", () => {
  const layout = { pane: { header: { content: { mod: "my-header" } } } };
  expect(withBadge(layout)).toBe(false);
  expect(layout.pane.header.content.mod).toBe("my-header");
});
