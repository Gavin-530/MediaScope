"""Generate explicit numerical fixtures; never a runtime application dependency.

Uses the pinned, unmodified VQEG Sobel/TI/PQ functions and independent NumPy
preprocessing from the documented ITU text profile. Requires numpy and scipy.
"""
import ast
import hashlib
import json
from pathlib import Path
from typing import Optional, cast
import numpy as np
from scipy import ndimage

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "test/reference/siti/vqeg-v0.3.0.py"
HASH = "231e4524b1bfca6b90d4b91fc86f9c89d65621cb2f256714a59506ba6cbf091c"
if hashlib.sha256(SOURCE.read_bytes()).hexdigest() != HASH:
    raise RuntimeError("Pinned VQEG source hash mismatch")
tree = ast.parse(SOURCE.read_text(encoding="utf-8"))
reference_class = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == "SiTiCalculator")
names = {"si", "ti", "oetf_pq"}
functions = [n for n in reference_class.body if isinstance(n, ast.FunctionDef) and n.name in names]
if len(functions) != len(names):
    raise RuntimeError("Missing pinned reference math functions")
# Extract function ASTs unchanged, without importing container readers or optional plotting.
reference_class.body = functions
module = ast.Module(body=[reference_class], type_ignores=[])
namespace = {"np": np, "ndimage": ndimage, "Optional": Optional, "cast": cast}
exec(compile(ast.fix_missing_locations(module), str(SOURCE), "exec"), namespace)
reference = namespace["SiTiCalculator"]

def preprocess(raw, depth, limited):
    v = np.array(raw, dtype=np.float64) / (2**depth - 1)
    if limited:
        v = (v - 16/255) / (235/255 - 16/255)
    # Independent a/b form from BT.1886 Annex 1, with P.910 B.2 parameters.
    a = (300**(1/2.4) - 0.01**(1/2.4))**2.4
    b = 0.01**(1/2.4) / (300**(1/2.4) - 0.01**(1/2.4))
    luminance = a * np.maximum(v+b, 0)**2.4
    return reference.oetf_pq(luminance)

cases = []
for depth in [8, 10]:
    for limited in [False, True]:
        width, height = 10, 8
        low, high = (16*2**(depth-8), 235*2**(depth-8)) if limited else (0, 2**depth-1)
        span = high-low+1
        y, x = np.indices((height, width))
        raw_frames = [np.full((height, width), low, dtype=int), np.full((height, width), high, dtype=int)]
        raw_frames += [low + ((x*37+y*53+x*y*11+n*29) % span) for n in range(3)]
        values = []
        previous = None
        for raw in raw_frames:
            frame = preprocess(raw, depth, limited)
            si = float(reference.si(frame))*(2**depth-1)
            ti = reference.ti(frame, previous)
            values.append({"si": si, "ti": None if ti is None else float(ti)*(2**depth-1)})
            previous = frame
        cases.append({"name": f"{depth}-{'limited' if limited else 'full'}", "depth": depth, "range": "tv" if limited else "pc", "width": width, "height": height,
                      "frames": [raw.reshape(-1).tolist() for raw in raw_frames], "expected": values,
                      "expectedMean": {"si": float(np.mean([v['si'] for v in values])), "ti": float(np.mean([v['ti'] for v in values[1:]]))}})
data = {"schema": 1, "profile": "P910-2023-SDR-BT1886-text-v1", "reference": {"project": "VQEG/siti-tools", "tag": "v0.3.0", "commit": "e172805cd6b7f0783e54e10d4cc543fb660138e6", "sourceSha256": HASH, "unmodifiedFunctions": sorted(names)},
        "preprocessing": {"basis": "P.910 (10/2023) explicit equations, BT.1886 Annex 1, BT.2100-2 Table 4", "whiteCdM2": 300, "blackCdM2": 0.01, "gamma": 2.4, "outputMultiplier": "2**inputBitDepth - 1", "isVqegDefaultPipeline": False},
        "generator": "scripts/generate-siti-p910-reference.py", "numpy": np.__version__, "scipy": __import__('scipy').__version__, "cases": cases}
destination = ROOT / "test/reference/siti/p910-2023-sdr.json"
destination.write_text(json.dumps(data, indent=2, allow_nan=False)+"\n", encoding="utf-8")
print(destination)
