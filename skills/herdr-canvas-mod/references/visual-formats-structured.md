# Structured diagrams

Put a small Mermaid source into a named block to let the converter place nodes and route internal
arrows. The result is editable on the live canvas. Use one block per independently revised diagram.
Open the [live canvas](canvas.md) once if needed.

## Generate, then revise

```bash
herdr-draw canvas block put release - --at 40,120 <<'EOF'
flowchart TD
  Start --> Review --> Ship
EOF
```

To insert Verify, inspect the live board and block. Save and read the current source, then derive
the revision from that same file. The existing block keeps its origin.

```bash
herdr-draw canvas describe
herdr-draw canvas block get release
herdr-draw canvas block source release > release.before.mmd
cat release.before.mmd
sed 's/Review --> Ship/Review --> Verify --> Ship/' release.before.mmd |
  herdr-draw canvas block put release - --expect-source release.before.mmd
```

`get` returns source, origin, and member IDs. `put` reports `created`, `updated`, `moved`, or `unchanged`.
Replaying identical source without a new origin leaves the drawing untouched. If the source guard
rejects the write, read the latest source and merge the intended change before retrying.

A sequence is equally small. Insert a message in the source to place it between existing messages.

```bash
herdr-draw canvas block put trace - <<'EOF'
sequenceDiagram
  Client->>API: Submit
  API-->>Client: Accepted
EOF
```

For more syntax, see [flowchart](https://mermaid.js.org/syntax/flowchart.html),
[sequence](https://mermaid.js.org/syntax/sequenceDiagram.html), [Gantt](https://mermaid.js.org/syntax/gantt.html),
and [Sankey](https://mermaid.js.org/syntax/sankey.html). Use Gantt `after <task-id>` for dependent dates.
For Sankey, check input totals. Add native value labels if each ribbon needs a number.
To turn an existing pin into an editable block, pipe `herdr-draw mermaid source d1` into
`herdr-draw canvas block put release -`.

## Choose the edit by what changes

| Request | Approach |
|---|---|
| Change the flow, message order, task dependencies, or quantities | Edit the affected block source with a guarded `put`. |
| Move an entire diagram | Use `canvas block move <id> --at x,y`. Move separate annotations or borders alongside it as needed. |
| Bend an arrow, adjust a label visually, or restyle one shape | Use [native element edits](canvas.md#elements) on the current ID. Keep the block attached for occasional touch-ups. |
| Add notes, borders, or links between blocks | Create independent native elements with their own IDs. Bind arrows to node IDs found via `describe`. |

For example, keep a review note independent while its arrow points into the flow. Use the visible
Review shape ID from `describe` and put the note in free space.

```bash
herdr-draw canvas add - <<'EOF'
[
  {"id":"review-note","type":"rectangle","x":285,"y":244,"width":175,"height":58,"text":"Check timing"},
  {"id":"review-note-link","type":"arrow","x":0,"y":0,"startElementId":"review-note",
   "endElementId":"release:anchor:flowchart:Review"}
]
EOF
```

Before a source change, inspect live labels, styling, and bindings. Save a snapshot when substantial
manual work is at stake. Carry semantic edits into Mermaid and record any visual overrides to keep.
A changed source regenerates the block members. Keep Mermaid node keys stable. Find generated
arrows again by endpoints and label before restoring bends and styles. Independent notes survive.
Native arrows keep bindings to surviving IDs and lose bindings to removed IDs. Check their bends
and rebind replaced endpoints. Screenshot the whole scene to check spacing, labels, and routes.

## Hand off a block to native edits

For sustained control over the internal geometry, save a snapshot and save `block get <id>` output
including source and member IDs. Run `canvas block detach <id>` to keep the shapes and release their
source ownership. Continue with the [native element commands](canvas.md). If you add shapes that
belong to the detached diagram, track their IDs too.

To return to a live block, rewrite the saved source to match the current native diagram. Mermaid
generates a new layout, so record the visual overrides you want to carry forward.

1. Stage the updated source with `block put` under a **fresh block ID** in free space. Detached
   shapes keep their IDs, so putting the old block ID can fail with an element ID conflict.
2. Find the new node IDs and rebind external arrows before deleting old shapes. For example,
   `herdr-draw canvas update review-note-link --set '{"end":{"id":"release-next:anchor:flowchart:Review"}}'`
   changes that arrow's target while keeping its own ID.
3. Once bindings are verified, use `canvas delete <id> ...` on just the confirmed detached diagram
   members. Move the new block into place and reapply visual overrides. Inspect for duplicate
   shapes and verify the note and connectors with `describe`.
