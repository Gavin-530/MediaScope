"""Independent controlled reference generation. Never imports product JS/C#.

Inputs: pinned unmodified VQEG Python source, explicit output path.
Outputs are candidates; this script refuses to overwrite an existing file.
"""
import ast
import base64
import hashlib
import json
import logging
import os
import platform
import sys
from enum import Enum
from pathlib import Path
from typing import Dict, List, Tuple, Callable, Optional, Union, cast
import numpy as np
import scipy
from scipy import ndimage

if sys.version_info[:2] != (3, 12) or np.__version__ != "2.1.3" or scipy.__version__ != "1.14.1":
    raise RuntimeError("Use the independently locked CPython/NumPy/SciPy environment")
source = Path(sys.argv[1])
destination = Path(sys.argv[2])
expected_source = "84557e030e302fa14e28a1cd1227f3320986050c4cf5f5f4d590215971329873"
if hashlib.sha256(source.read_bytes()).hexdigest() != expected_source:
    raise RuntimeError("Pinned VQEG source identity mismatch")
if destination.exists() or ".build" not in destination.parts:
    raise RuntimeError("Generate a new candidate inside project .build")
tree = ast.parse(source.read_text(encoding="utf-8"))
namespace = dict(np=np, ndimage=ndimage, Enum=Enum, Dict=Dict, List=List, Tuple=Tuple,
                 Callable=Callable, Optional=Optional, Union=Union, cast=cast,
                 logger=logging.getLogger("independent-reference"))
classes = ast.Module(body=[item for item in tree.body if isinstance(item, ast.ClassDef)], type_ignores=[])
exec(compile(ast.fix_missing_locations(classes), str(source), "exec"), namespace)
reference = namespace["SiTiCalculator"]
cases = []
for domain in ["sdr", "pq"]:
    width, height, count = 64, 48, 5
    limited = domain == "sdr"
    low, high = (16, 235) if limited else (0, 255)
    calculator = reference(bit_depth=8, color_range=namespace["ColorRange"].LIMITED if limited else namespace["ColorRange"].FULL)
    frames, expected, hashes = [], [], []
    previous = None
    for frame in range(count):
        # Self-authored integer pattern: endpoints, 2D texture and frame changes.
        codes = np.array([[low + ((x*17 + y*29 + x*y*3 + frame*31) % (high-low+1))
                           for x in range(width)] for y in range(height)], dtype=np.uint8)
        if frame == 0:
            codes[:, :width//2] = low
            codes[:, width//2:] = high
        normalized = calculator.normalize_between_0_1(codes)
        prepared = reference.oetf_pq(reference.apply_display_model(normalized)) if domain == "sdr" else normalized
        si = reference.si(prepared)*255
        ti = reference.ti(prepared, previous)
        expected.append(dict(si=float(si), ti=None if ti is None else float(ti*255)))
        previous = prepared
        raw = codes.tobytes()
        frames.append(base64.b64encode(raw).decode("ascii"))
        hashes.append(hashlib.sha256(raw).hexdigest())
    cases.append(dict(name="controlled-"+domain, width=width, height=height, depth=8,
                      format="gray", domain=domain, range="tv" if limited else "pc",
                      settings=dict(range="tv" if limited else "pc", transfer=domain),
                      frames=frames, frameSha256=hashes, expected=expected))
result = dict(schema=1, kind="project-independent-controlled-reference",
              license="Self-authored integer samples; reference implementation attribution in licenses/VQEG-siti-tools.txt",
              reference=dict(project="VQEG/siti-tools", commit="c537e33793266187aad87c859fd62a9de9033854",
                             sourceSha256=expected_source, unmodifiedFunctions=["normalize_between_0_1", "apply_display_model", "oetf_pq", "si", "ti"]),
              generation=dict(python=platform.python_version(), numpy=np.__version__, scipy=scipy.__version__,
                              scriptSha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest()),
              scope="Independent of production JS/C#; pinned upstream compatibility profile, not standards certification",
              cases=cases)
destination.parent.mkdir(parents=True, exist_ok=True)
destination.write_text(json.dumps(result, separators=(",", ":"), allow_nan=False)+"\n", encoding="utf-8")
print(json.dumps(dict(cases=len(cases), frames=sum(len(c["frames"]) for c in cases), file=str(destination))))
