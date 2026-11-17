// "Close this pane?" on the pane itself. Cmd+W (`confirm-pane-close`) names the pane in
// shared("pane-ask"); that pane's header copy turns the focus border red (it's the focused pane)
// and hangs a card from the top of the pane, drawn in the layer above the window, so it shows
// though the header is only revealed on hover. Enter closes, Esc keeps, a click elsewhere drops
// the question; each puts the border's colour back.

import { div } from "gpui-kit";
import { v_flex, Popup } from "gpui-base";
import { layout, panes, run, settings, shared, setShared } from "herdr";

export const ASK = "pane-ask";
const RED = "ansi1";

// The shown layout's pane focus look, read or replaced (layout.set applies live).
const tabs = (n, out = []) => {
  if (n && typeof n === "object") {
    if (n.content?.tab !== undefined && n.content.pane) out.push(n.content.pane);
    for (const v of Object.values(n)) tabs(v, out);
  }
  return out;
};
const paint = (focus) => {
  const l = layout();
  for (const p of tabs(l)) p.focus = focus;
  run("layout.set", { layout: l });
};

// Puts the border back and drops the question.
function end(ask) {
  setShared(ASK, null);
  if (ask?.focus) paint(ask.focus);
}

// The header strip with the card added; `view` keeps `askFocus` (a focus handle) and the
// header's width, which is the pane's.
export function withAsk(view, strip, pane, t, cx) {
  const ask = shared(ASK);
  const on = Boolean(pane) && ask?.pane === pane;
  if (on && !ask.focus) {
    // The look from before, kept with the question: layout.set may make this copy anew.
    const focus = tabs(layout())[0]?.focus ?? { width: 2, color: "accent" };
    setShared(ASK, { ...ask, focus });
    paint({ ...focus, color: RED });
  }
  // shortcut: a question left open over a quit or a closed pane is cleared on the next draw after 2 minutes.
  if (on && Date.now() - ask.at > 120000) cx.timer.after(0, () => end(ask));
  // Focus once per question, after it's drawn (focusing in the same pass doesn't hold).
  if (on && view.asked !== ask.at) {
    view.asked = ask.at;
    cx.timer.after(30, () => view.askFocus.focus());
  }
  const done = (close) => {
    end(shared(ASK));
    run(close ? "pane.close" : "pane.focus", { pane });
  };
  const title = panes().find((p) => p.pane === pane)?.title || "";
  const card = v_flex().id("ask").track_focus(view.askFocus)
    .on_key_down((e, cx) => {
      if (e.key === "enter") done(true);
      else if (e.key === "escape") done(false);
      else return;
      cx.stop_propagation();
    })
    // The click goes where it was aimed.
    .on_mouse_down_out(() => end(shared(ASK)))
    // Measured sizes come zoomed, and w() zooms again.
    .mt(10).w(Math.min(420, (view.width ?? 452) / (settings().zoom ?? 1) - 32)).p(12).gap(6).rounded(10)
    .border_2().border_color(t[RED]).bg(t.popover).shadow_lg().text_size(13)
    .child(div().font_semibold().text_color(t.foreground).child("Close this pane?"))
    .child(div().truncate().text_color(t.muted).child(title || "Its terminal ends."))
    .child(div().text_size(11).text_color(t.dim).child("⏎ close · Esc keep"));
  return strip.id("strip").relative()
    .on_size_change(({ width }, cx) => { if (width !== view.width) { view.width = width; cx.notify(); } })
    .child(div().absolute().top(0).bottom(0).left(0).right(0).flex().justify_center().items_start()
      // The card hangs below its trigger: a 0px one at the top edge.
      .child(Popup.new("ask-" + pane, div().w(1).h(0)).anchor("top_center").when(on, (el) => el.content(card))));
}
