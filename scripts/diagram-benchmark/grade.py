#!/usr/bin/env python3
"""Grade expected editable labels, links and identity from a scene export.

Use the PNG for layout, collisions, and visual chart geometry. An export alone
cannot show that the native Herdr mod rendered the scene within its budget.
"""
import argparse
from collections import Counter
import json
from pathlib import Path


def graph(rows):
    return {(start, end): label for start, end, label in rows}


ARCHITECTURE = graph([
    ("SDK", "Edge", ""), ("Edge", "Gateway", ""), ("Gateway", "Auth", ""),
    ("Auth", "Gateway", "Allow"), ("Auth", "Deny", "Reject"),
    ("Intake", "Validate", ""), ("Validate", "Dedup", "Valid"),
    ("Validate", "Dead Letter", "Invalid"), ("Dedup", "Dispatch", ""),
    ("Queue", "Worker", ""), ("Worker", "Provider", ""),
    ("Worker", "Retry Timer", "Failure"), ("Retry Timer", "Queue", "Retry"),
    ("Provider", "Receipt", "Ack"),
    ("Writer", "Event Store", ""), ("Event Store", "Analytics", ""),
    ("Control Plane", "Flags", ""), ("Monitor", "On-call", ""),
    ("Gateway", "Intake", "Submit"), ("Dispatch", "Queue", "Publish"),
    ("Dead Letter", "Writer", "Quarantine"), ("Receipt", "Writer", "Record"),
    ("Flags", "Gateway", "Config"), ("Analytics", "Monitor", "Signal"),
    ("Worker", "Monitor", "Metrics"),
])

RELEASE = graph([
    ("Gateway", "Router", ""), ("Router", "Control", ""), ("Router", "Canary", ""),
    ("Canary", "Health Gate", ""), ("Health Gate", "Ramp", "Pass"), ("Health Gate", "Rollback", "Fail"),
])

MESSAGES = ["GET /catalog", "Route", "Lookup", "Miss", "Read", "Rows", "200", "Response"]


def expected_graph(case, revised):
    expected = (RELEASE if case == "release" else ARCHITECTURE).copy()
    if not revised:
        return expected, {}
    if case == "release":
        del expected["Router", "Canary"]
        expected.update(graph([
            ("Router", "Policy Check", ""), ("Policy Check", "Canary", ""), ("Health Gate", "Ramp", "Healthy"),
        ]))
        return expected, {("Router", "Canary"): ""}
    removed = {("Gateway", "Intake"): "Submit", ("Worker", "Provider"): ""}
    for edge in removed:
        del expected[edge]
    expected.update(graph([
        ("Gateway", "Rate Limit", ""), ("Rate Limit", "Intake", "Submit"),
        ("Rate Limit", "Deny", "429"), ("Schema Registry", "Validate", "Contract"),
        ("Validate", "Dedup", "Accepted"), ("Worker", "Circuit Breaker", ""),
        ("Circuit Breaker", "Provider", ""), ("Circuit Breaker", "Retry Timer", "Open"),
        ("Writer", "Audit Index", "Index"), ("Audit Index", "Analytics", "Feed"),
    ]))
    return expected, removed


class Scene:
    def __init__(self, path):
        scene = json.loads(Path(path).read_text())
        self.elements = {e["id"]: e for e in scene["elements"] if not e.get("isDeleted")}
        members = {eid for block in scene.get("herdrDraw", {}).get("blocks", []) for eid in block["members"]}
        self.generated = [
            e for e in self.elements.values() if e["id"] in members or e.get("containerId") in members
        ]
        self.bound_text = {
            e["containerId"]: e["text"]
            for e in self.elements.values() if e.get("containerId") and e.get("text")
        }

    def edges(self):
        found = {}
        for arrow in self.elements.values():
            if arrow["type"] != "arrow":
                continue
            start = (arrow.get("startBinding") or {}).get("elementId")
            end = (arrow.get("endBinding") or {}).get("elementId")
            edge = (self.bound_text.get(start), self.bound_text.get(end))
            found.setdefault(edge, []).append((arrow["id"], self.bound_text.get(arrow["id"], "")))
        return found

    def shape_id(self, text):
        return next(
            (i for i, label in self.bound_text.items()
             if label == text and self.elements.get(i, {}).get("type") in {"rectangle", "diamond", "ellipse"}),
            None,
        )


def grade(scene, case, revised, before):
    expected, removed = expected_graph(case, revised)
    observed = scene.edges()
    errors = [
        f"{a} → {b}: expected one arrow with label {label!r}, found {observed.get((a, b), [])!r}"
        for (a, b), label in expected.items()
        if len(observed.get((a, b), [])) != 1 or observed[a, b][0][1] != label
    ]
    errors += [f"Obsolete edge still present: {a} → {b}" for a, b in removed if (a, b) in observed]
    if case == "release":
        grade_release(scene, revised, errors)
    prefix, target, text = (
        ("ops", "Health Gate", "Ops approval pending") if case == "release"
        else ("gate", "Worker", "Escalation draft")
    )
    note, link = f"{prefix}-note", f"{prefix}-link"
    expected_note = before.bound_text.get(note) if before else text
    if not expected_note or scene.bound_text.get(note) != expected_note:
        errors.append(f"{note} should read {expected_note!r}")
    old_anchor = before.shape_id(target) if before else scene.shape_id(target)
    connector = scene.elements.get(link, {})
    if (not old_anchor or (connector.get("startBinding") or {}).get("elementId") != note
            or (connector.get("endBinding") or {}).get("elementId") != old_anchor
            or scene.shape_id(target) != old_anchor):
        errors.append(f"{link} must be bound from {note} to the original {target}")

    retained_edges = None
    if before:
        stable = [target] if case == "release" else [
            "Gateway", "Intake", "Dispatch", "Queue", "Worker", "Receipt", "Writer", "Monitor",
        ]
        for title in stable:
            if not before.shape_id(title) or scene.shape_id(title) != before.shape_id(title):
                errors.append(f"Original {title} ID did not survive")
        styled_ids = [note, before.shape_id(target)]
        if case == "architecture":
            styled_ids.append(before.shape_id("Gateway"))
        for eid in styled_ids:
            if eid and any(
                scene.elements.get(eid, {}).get(field) != before.elements.get(eid, {}).get(field)
                for field in ("strokeColor", "strokeWidth")
            ):
                errors.append(f"Canvas-applied style was lost on {eid}")
        old_edges = before.edges()
        common = old_edges.keys() & expected.keys()
        retained_edges = {
            "retained": sum(bool(
                {e[0] for e in old_edges[k]} & {e[0] for e in observed.get(k, [])}
            ) for k in common),
            "eligible": len(common),
        }
    # Count roles per diagram, so Gateway as a routing node and as a trace participant count separately.
    components = len({component for edge in expected for component in edge})
    if case == "release":
        components += (6 + 6 + 6) if revised else (5 + 5 + 4)
    return {
        "passed": not errors,
        "logical_components": components,
        "elements": len(scene.elements),
        "elements_by_type": dict(Counter(e["type"] for e in scene.elements.values())),
        "block_generated_elements": len(scene.generated),
        "block_generated_by_type": dict(Counter(e["type"] for e in scene.generated)),
        "elements_outside_blocks": len(scene.elements) - len(scene.generated),
        "expected_bound_edges": len(expected),
        "retained_edge_ids": retained_edges,
        "errors": errors,
    }


def grade_release(scene, revised, errors):
    messages = MESSAGES[:4] + ["Enqueue fallback", "Ack"] + MESSAGES[4:] if revised else MESSAGES
    text_elements = sorted(
        (element for element in scene.elements.values() if element["type"] == "text"),
        key=lambda element: element["y"],
    )
    actual_order = [el.get("text") for el in text_elements if el.get("text") in messages]
    if actual_order != messages:
        errors.append(f"Expected message order {messages}, found {actual_order}")
    all_text = {el.get("text") for el in text_elements}
    required = {"Client", "Gateway", "Canary", "Cache", "DB", "Baseline", "Deploy", "Observe", "Ramp"}
    if revised:
        required.update({"Queue", "Risk review", "Freeze", "Incoming 100", "Control 65",
                         "Canary 35", "Cache hit 73", "Database 22", "Retry 5"})
    else:
        # The first brief allows totals to be read from labeled individual flows.
        for name in ("Incoming", "Control", "Canary", "Cache hit", "Database"):
            if not any(label == name or label.startswith(f"{name} ") for label in all_text):
                errors.append(f"Missing Sankey node: {name}")
        required.update({"80", "20", "64", "16", "4"})
    for label in sorted(required):
        if label not in all_text:
            errors.append(f"Missing panel label: {label}")


def metrics(path):
    events_path = path / "turns.jsonl"
    actions_path = path / "actions.jsonl"
    events = [json.loads(line) for line in events_path.read_text().splitlines()] if events_path.exists() else []
    actions = [
        action for line in actions_path.read_text().splitlines()
        if (action := json.loads(line))["actor"] == "agent"
    ] if actions_path.exists() else []
    stage_spans = []
    for index, event in enumerate(events):
        start = event.get("sent_at")
        stop = events[index + 1].get("sent_at") if index + 1 < len(events) else float("inf")
        if start is None or stop is None:
            continue
        calls = [a for a in actions if start <= a["start"] < stop]
        if calls:
            span = max(a["end"] for a in calls) - min(a["start"] for a in calls)
            stage_spans.append({"stage": event["stage"], "first_to_last_cli_s": round(span, 2)})
    return {
        "recorded_turns": len(events),
        "stages": [event["stage"] for event in events],
        "cli_calls": len(actions),
        "failed_cli_calls": sum(a["code"] != 0 for a in actions),
        "cli_execution_s": round(sum(a["end"] - a["start"] for a in actions), 2),
        "stage_cli_spans": stage_spans,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("case", choices=["release", "architecture"])
    parser.add_argument("scene")
    parser.add_argument("--stage", choices=["1", "2"], default="2")
    parser.add_argument("--before", help="Export taken after the controller hand edits")
    args = parser.parse_args()
    if args.stage == "2" and not args.before:
        parser.error("stage 2 requires --before with the live checkpoint export")
    scene = Scene(args.scene)
    result = grade(scene, args.case, args.stage == "2", Scene(args.before) if args.before else None)
    result["metrics"] = metrics(Path(args.scene).parent)
    print(json.dumps(result, indent=2))
    raise SystemExit(0 if result["passed"] else 1)
