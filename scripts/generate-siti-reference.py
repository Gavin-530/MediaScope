"""Independent P.910 display/scale reference; pinned VQEG Sobel/TI kernels.

The adapter supplies integer native layouts / standard RGB luma coefficients.
For 9/14/16-bit limited range, nominal endpoints extend the 8/10/12-bit table.
"""
import ast
import base64
import hashlib
import json
import logging
import math
from enum import Enum
from pathlib import Path
from typing import Optional, Union, cast
import numpy as np
from scipy import ndimage

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "test/reference/siti/vqeg-reference.py"
HASH = "84557e030e302fa14e28a1cd1227f3320986050c4cf5f5f4d590215971329873"
if hashlib.sha256(SOURCE.read_bytes()).hexdigest() != HASH:
    raise RuntimeError("Pinned VQEG source hash mismatch")
tree = ast.parse(SOURCE.read_text(encoding="utf-8"))
cls = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == "SiTiCalculator")
names = {"normalize_between_0_1", "normalize_to_original_si_range", "apply_display_model", "eotf_1886", "eotf_inv_srgb", "eotf_hlg", "oetf_pq", "si", "ti"}
cls.body = [n for n in cls.body if isinstance(n, ast.Assign) or isinstance(n, ast.FunctionDef) and n.name in names]
namespace = {"np": np, "ndimage": ndimage, "Enum": Enum, "Optional": Optional, "Union": Union, "cast": cast, "logger": logging.getLogger("reference")}
module = ast.Module(body=[n for n in tree.body if isinstance(n, ast.ClassDef)], type_ignores=[])
exec(compile(ast.fix_missing_locations(module), str(SOURCE), "exec"), namespace)
reference = namespace["SiTiCalculator"]
destination = ROOT / "test/reference/siti/vqeg-pq.json"
historical = json.loads(destination.read_text(encoding="utf-8"))["historical"]

cases = []

def pq_oetf(luminance):
    m1, m2 = 2610/16384, 2523/32
    c1, c2, c3 = 3424/4096, 2413/128, 2392/128
    power = np.power(luminance/10000, m1)
    return np.power((c1+c2*power)/(1+c3*power), m2)

def sdr_eotf(values, domain):
    if domain == "srgb":
        linear = np.where(values <= .04045, values/12.92, ((values+.055)/1.055)**2.4)
        return .2 + 79.8*linear
    white, black, gamma = 300., .01, 2.4
    root = white**(1/gamma)-black**(1/gamma)
    gain, lift = root**gamma, black**(1/gamma)/root
    return gain*np.maximum(values+lift, 0)**gamma

def hlg_eotf(values, white=1000.0, black=0.01):
    # Standard equations transcribed independently; never import production JS.
    a = 0.17883277
    b, c = 1 - 4*a, 0.5 - a*np.log(4*a)
    gamma = 1.2 + 0.42*np.log10(white/1000) if 400 <= white <= 2000 else 1.2*1.111**np.log2(white/1000)
    beta = np.sqrt(3*(black/white)**(1/gamma))
    signal = np.maximum(0, (1-beta)*values + beta)
    linear = np.where(signal <= 0.5, signal**2/3, (np.exp((signal-c)/a)+b)/12)
    return white*linear**gamma

def add(fmt, depth, layout, domain="sdr", limited=False, endian="le", alpha=False, order=None, subsample=(1, 1), shift=0, matrix=None, hlg=None, boundary=False):
    w, h = 10, 8
    maximum = 2**depth - 1
    low, high = (16*2**(depth-8), 235*2**(depth-8)) if limited else (0, maximum)
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
        normalized = (luma-low)/(high-low)
        if domain == "pq":
            prepared = normalized
        elif domain == "hlg":
            prepared = pq_oetf(hlg_eotf(normalized, **({"white": hlg["whiteCdM2"], "black": hlg["blackCdM2"]} if hlg else {})))
        else:
            prepared = pq_oetf(sdr_eotf(normalized, domain))
        ti = reference.ti(prepared, previous)
        expected.append({"si": float(reference.si(prepared)*maximum), "ti": None if ti is None else float(ti*maximum)})
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
data = {"reference": {"commit": "c537e33793266187aad87c859fd62a9de9033854", "sourceSha256": HASH, "unmodifiedFunctions": ["si", "ti"]}, "adapter": "BT.601/709/2020nc RGB luma; nominal integer endpoints extended to 9/14/16 bits", "method": "Independent native range, BT.1886 reference EOTF (300/.01), inverse sRGB reference display (80/.2), BT.2100 HLG and PQ OETF; output multiplied by 2^input_bit_depth-1", "historical": historical, "cases": cases}
data["hlgReference"] = {"standard": "ITU-R BT.2100-2 (07/2018)", "table": 5, "gamma": "note 5f; footnote 2 outside 400–2000 cd/m2", "eotf": "black lift beta, inverse OETF, then white * linear^gamma; corrects pinned VQEG HLG"}
data["hlgCurves"] = [{"whiteCdM2": white, "blackCdM2": black, "points": [{"signal": signal, "pq": float(pq_oetf(hlg_eotf(np.array(signal), white, black)))} for signal in [0, .1, .499999, .5, .500001, .75, 1]]} for white, black in [(200, .001), (400, .005), (600, .01), (1000, 0), (1000, .01), (2000, .02), (4000, .01), (10000, .05)]]
data["sdrCurves"] = [{"domain": domain, "points": [{"signal": signal, "luminance": float(sdr_eotf(np.array(signal), domain)), "pq": float(pq_oetf(sdr_eotf(np.array(signal), domain)))} for signal in [0, .001, .040449999, .04045, .040450001, .1, .25, .5, .75, 1]]} for domain in ["sdr", "srgb"]]
legacy = next(c for c in cases if c["name"] == "gray10le-hlg-tv-display")
prepared = [reference.oetf_pq(reference.eotf_hlg((np.frombuffer(base64.b64decode(f), dtype="<u2").reshape(8, 10)-64)/876, l_max=2000, l_min=.02)) for f in legacy["frames"]]
data["legacyHlg"] = {"case": legacy["name"], "expected": [{"si": float(reference.si(f)*255), "ti": None if i == 0 else float(reference.ti(f, prepared[i-1])*255)} for i, f in enumerate(prepared)]}
destination = ROOT / "test/reference/siti/vqeg-pq.json"
destination.write_text(json.dumps(data, separators=(",", ":"), allow_nan=False)+"\n", encoding="utf-8")
print(f"{len(cases)} reference cases: {destination}")
