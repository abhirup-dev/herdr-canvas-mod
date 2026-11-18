#!/usr/bin/env python3
"""Save the approved build and inject the same hand edits in each live board."""
import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

sys.dont_write_bytecode = True
from grade import Scene

parser = argparse.ArgumentParser()
parser.add_argument("case", choices=["release", "architecture"])
parser.add_argument("run_dir", type=Path)
args = parser.parse_args()
run_dir = args.run_dir.resolve()
checkpoint = run_dir / "checkpoint"
checkpoint.mkdir()
for name in ("stage1.excalidraw", "stage1.png"):
    shutil.copy2(run_dir / name, checkpoint / name)
scene = Scene(checkpoint / "stage1.excalidraw")
edits = (
    [("ops-note", {"text": "Approved · Mei", "strokeColor": "#087f5b"}),
     (scene.shape_id("Health Gate"), {"strokeColor": "#c2255c", "strokeWidth": 4})]
    if args.case == "release" else
    [("gate-note", {"text": "Page primary · Noor", "strokeColor": "#087f5b"}),
     (scene.shape_id("Worker"), {"strokeColor": "#c2255c", "strokeWidth": 4}),
     (scene.shape_id("Gateway"), {"strokeColor": "#7048e8", "strokeWidth": 3})]
)
env = {**os.environ, "AUDIT_ACTOR": "controller"}


def canvas(*argv):
    subprocess.run([str(run_dir / "canvas"), *argv], cwd=run_dir, env=env, check=True, stdout=subprocess.DEVNULL)


for element_id, fields in edits:
    if not element_id or element_id not in scene.elements:
        raise RuntimeError("Build is missing a required edit target")
    canvas("update", element_id, "--set", json.dumps(fields))
canvas("export", "--out", str(checkpoint / "live-before.excalidraw"))
