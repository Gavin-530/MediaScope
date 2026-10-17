"""Pinned, unchanged siti-tools 0.6.0 reference; never import production JS/C#.

The adapter supplies integer native layouts / standard RGB luma coefficients.
For 9/14/16-bit limited range, nominal endpoints extend the 8/10/12-bit table.
"""
import ast
import subprocess
import base64
import hashlib
import json
import logging
import math
from enum import Enum
from pathlib import Path
from typing import Dict, List, Tuple, Callable, Optional, Union, cast
import numpy as np
from scipy import ndimage

ROOT = Path(__file__).resolve().parents[2]
subprocess.run(["node", str(ROOT / "testing-tools/prepare-fixtures.mjs")], check=True, cwd=ROOT)
lock_bytes = (ROOT / "testing-tools/fixtures.lock.json").read_bytes()
CACHE = ROOT / ".build/testing-fixtures" / hashlib.sha256(lock_bytes).hexdigest() / "siti"
SOURCE = CACHE / "vqeg-reference.py"
HASH = "84557e030e302fa14e28a1cd1227f3320986050c4cf5f5f4d590215971329873"
if hashlib.sha256(SOURCE.read_bytes()).hexdigest() != HASH:
    raise RuntimeError("Pinned VQEG source hash mismatch")
tree = ast.parse(SOURCE.read_text(encoding="utf-8"))
names = ["normalize_between_0_1", "normalize_to_original_si_range", "apply_display_model", "eotf_1886", "eotf_inv_srgb", "eotf_hlg", "oetf_pq", "si", "ti"]
namespace = {"np": np, "ndimage": ndimage, "Enum": Enum, "Dict": Dict, "List": List, "Tuple": Tuple, "Callable": Callable, "Optional": Optional, "Union": Union, "cast": cast, "logger": logging.getLogger("reference")}
module = ast.Module(body=[n for n in tree.body if isinstance(n, ast.ClassDef)], type_ignores=[])
exec(compile(ast.fix_missing_locations(module), str(SOURCE), "exec"), namespace)
reference = namespace["SiTiCalculator"]
historical = json.loads((CACHE / "vqeg-pq.json").read_text(encoding="utf-8"))["historical"]

cases = []

def pq_oetf(luminance):
    return reference.oetf_pq(luminance)

def sdr_eotf(values, domain):
    return reference.apply_display_model(values, eotf_function=namespace["EotfFunction"].INV_SRGB if domain == "srgb" else namespace["EotfFunction"].BT1886)

def hlg_eotf(values, white=1000.0, black=0.01):
    return reference.eotf_hlg(values, l_max=white, l_min=black)

def add(fmt, depth, layout, domain="sdr", limited=False, endian="le", alpha=False, order=None, subsample=(1, 1), shift=0, matrix=None, hlg=None, boundary=False):
    w, h = 10, 8
    maximum = 2**depth - 1
    low, high = (16*2**(depth-8), 235*2**(depth-8)) if limited else (0, maximum)
    calculator = reference(bit_depth=depth if depth in [8, 10, 12] else 8, color_range=namespace["ColorRange"].LIMITED if limited else namespace["ColorRange"].FULL)
    if depth not in [8, 10, 12]:
        # Explicit input extension; never label this as an upstream supported depth.
        calculator.bit_depth = depth
        calculator.LIMITED_RANGE = {**calculator.LIMITED_RANGE, depth: {"min": low, "max": high}}
    yy, xx = np.indices((h, w))
    dtype = np.dtype("u1" if depth == 8 else "<u2" if endian == "le" else ">u2")
    frames, expected = [], []
    previous = None
    weights = {"bt601": [.299, .587, .114], "bt709": [.2126, .7152, .0722], "bt2020": [.2627, .678, .0593]}.get(matrix)
    for frame in range(5):
        codes = np.full((h, w), low if frame == 0 else high, dtype=int) if frame < 2 else low+(xx*37+yy*53+xx*yy*11+frame*29) % (high-low+1)
        if boundary and frame < 2:
            codes = np.full((h, w), (low+high)//2, dtype=int)
            if frame == 1:
                codes[:h//2] += 1
        if weights:
            rgb = [codes, low+(codes-low+37) % (high-low+1), low+(codes-low+83) % (high-low+1)]
            if frame < 2:
                rgb = [codes, codes, codes]
            luma = sum(weight*plane for weight, plane in zip(weights, rgb))
            if frame < 2:
                luma = codes  # Exact neutral endpoints, without coefficient-sum roundoff.
        else:
            luma = codes
        normalized = calculator.normalize_between_0_1(luma)
        if domain == "pq":
            prepared = normalized
        elif domain == "hlg":
            prepared = pq_oetf(hlg_eotf(normalized, **({"white": hlg["whiteCdM2"], "black": hlg["blackCdM2"]} if hlg else {})))
        else:
            prepared = pq_oetf(sdr_eotf(normalized, domain))
        ti = reference.ti(prepared, previous)
        expected.append({"si": float(calculator.normalize_to_original_si_range(reference.si(prepared))), "ti": None if ti is None else float(calculator.normalize_to_original_si_range(ti))})
        previous = prepared
        if layout == "gray":
            samples = codes.reshape(-1)
        elif layout == "gbr-planar":
            samples = np.concatenate([rgb[1].reshape(-1), rgb[2].reshape(-1), rgb[0].reshape(-1)] + ([np.full(w*h, maximum)] if alpha else []))
        elif layout == "rgb-packed":
            channels = dict(zip("rgb", rgb)); channels.update(a=np.full((h, w), maximum), **{"0": np.zeros((h, w), dtype=int)})
            samples = np.stack([channels[c] for c in order], axis=-1).reshape(-1)
        else:
            chroma = math.ceil(w/subsample[0])*math.ceil(h/subsample[1])*2
            samples = np.concatenate([codes.reshape(-1), np.full(chroma, 128*2**(depth-8))] + ([np.full(w*h, maximum)] if alpha else []))
        frames.append(base64.b64encode((samples.astype(np.uint32) << shift).astype(dtype).tobytes()).decode())
    settings = {"range": "tv" if limited else "pc", "transfer": domain}
    if matrix:
        settings["matrix"] = matrix
    if hlg:
        settings["hlg"] = hlg
    cases.append({"name": f"{fmt}-{domain}-{'tv' if limited else 'pc'}"+('-display' if hlg else '')+('-step' if boundary else ''), "format": fmt, "depth": depth, "domain": domain, "range": settings["range"], "matrix": matrix, "width": w, "height": h, "settings": settings, "frames": frames, "expected": expected})

for depth in [8, 9, 10, 12, 14, 16]:
    for domain in ["sdr", "srgb", "pq", "hlg"]:
        for limited in [False, True]:
            add("gray" + (str(depth)+"le" if depth != 8 else ""), depth, "gray", domain, limited)
for depth in [9, 10, 12, 14, 16]:
    add(f"gray{depth}be", depth, "gray", limited=True, endian="be")
for sampling, subs in [("420", (2, 2)), ("422", (2, 1)), ("444", (1, 1)), ("440", (1, 2)), ("411", (4, 1)), ("410", (4, 4))]:
    add(f"yuv{sampling}p", 8, "yuv-planar", limited=True, subsample=subs)
add("yuva420p10le", 10, "yuv-planar", alpha=True, subsample=(2, 2))
for fmt, depth, subs, shift in [("nv12", 8, (2, 2), 0), ("nv21", 8, (2, 2), 0), ("nv16", 8, (2, 1), 0), ("nv24", 8, (1, 1), 0), ("p010le", 10, (2, 2), 6), ("p212be", 12, (2, 1), 4), ("p416le", 16, (1, 1), 0)]:
    add(fmt, depth, "yuv-semi", limited=True, subsample=subs, shift=shift, endian="be" if fmt.endswith("be") else "le")
for fmt, order, depth, endian in [("rgb24", "rgb", 8, "le"), ("bgr24", "bgr", 8, "le"), ("rgb0", "rgb0", 8, "le"), ("0bgr", "0bgr", 8, "le"), ("rgba", "rgba", 8, "le"), ("argb", "argb", 8, "le"), ("rgb48be", "rgb", 16, "be"), ("bgra64le", "bgra", 16, "le")]:
    add(fmt, depth, "rgb-packed", order=order, endian=endian, alpha="a" in order, matrix="bt709")
for fmt, depth, endian, alpha in [("gbrp", 8, "le", False), ("gbrp10be", 10, "be", False), ("gbrp12le", 12, "le", False), ("gbrap16le", 16, "le", True)]:
    add(fmt, depth, "gbr-planar", endian=endian, alpha=alpha, matrix="bt2020", domain="pq")
add("rgb24", 8, "rgb-packed", order="rgb", matrix="bt601", domain="srgb", limited=True)
add("gray10le", 10, "gray", domain="hlg", limited=True, hlg={"whiteCdM2": 2000, "blackCdM2": .02})
add("rgb24", 8, "rgb-packed", order="rgb", matrix="bt2020", domain="hlg")
for limited in [False, True]:
    add("gray10le", 10, "gray", domain="hlg", limited=limited, boundary=True)
data = {"reference": {"version": "0.6.0", "commit": "c537e33793266187aad87c859fd62a9de9033854", "sourceSha256": HASH, "unmodifiedFunctions": names}, "adapter": "BT.601/709/2020nc RGB luma; nominal integer endpoints extended to 9/14/16 bits; not upstream file reader coverage", "method": "Unchanged upstream normalization, display/PQ, SI/TI and fixed 255 output", "historical": historical, "cases": cases}
data["hlgReference"] = {"implementation": "siti-tools 0.6.0 eotf_hlg", "eotf": "Pinned high branch and affine black mapping, including discontinuity"}
data["hlgCurves"] = [{"whiteCdM2": white, "blackCdM2": black, "points": [{"signal": signal, "pq": float(pq_oetf(hlg_eotf(np.array(signal), white, black)))} for signal in [0, .1, .499999, .5, .500001, .75, 1]]} for white, black in [(200, .001), (400, .005), (600, .01), (1000, 0), (1000, .01), (2000, .02), (4000, .01), (10000, .05)]]
data["sdrCurves"] = [{"domain": domain, "points": [{"signal": signal, "luminance": float(sdr_eotf(np.array(signal), domain)), "pq": float(pq_oetf(sdr_eotf(np.array(signal), domain)))} for signal in [0, .001, .040449999, .04045, .040450001, .1, .25, .5, .75, 1]]} for domain in ["sdr", "srgb"]]
legacy = next(c for c in cases if c["name"] == "gray10le-hlg-tv-display")
prepared = [reference.oetf_pq(reference.eotf_hlg((np.frombuffer(base64.b64decode(f), dtype="<u2").reshape(8, 10)-64)/876, l_max=2000, l_min=.02)) for f in legacy["frames"]]
data["legacyHlg"] = {"case": legacy["name"], "expected": [{"si": float(reference.si(f)*255), "ti": None if i == 0 else float(reference.ti(f, prepared[i-1])*255)} for i, f in enumerate(prepared)]}
destination = ROOT / ".build/generated-siti-reference/vqeg-060.json"
destination.parent.mkdir(parents=True, exist_ok=True)
destination.write_text(json.dumps(data, separators=(",", ":"), allow_nan=False)+"\n", encoding="utf-8")
print(f"{len(cases)} reference cases: {destination}")
