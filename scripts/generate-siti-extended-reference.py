"""Independent NumPy / pinned VQEG operators for declared P.910 interpretations.

These vectors validate implementation, not an official resolution of P.910 errata.
No application/runtime dependency; preserve the historical SDR fixture.
"""
import ast
import hashlib
import json
from pathlib import Path
from typing import Optional, cast
import numpy as np
from scipy import ndimage

root = Path(__file__).resolve().parent.parent
source = root / 'test/reference/siti/vqeg-v0.3.0.py'
digest = hashlib.sha256(source.read_bytes()).hexdigest()
assert digest == '231e4524b1bfca6b90d4b91fc86f9c89d65621cb2f256714a59506ba6cbf091c'
tree = ast.parse(source.read_text(encoding='utf-8'))
cls = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == 'SiTiCalculator')
cls.body = [n for n in cls.body if isinstance(n, ast.FunctionDef) and n.name in {'si', 'ti', 'oetf_pq'}]
namespace = {'np': np, 'ndimage': ndimage, 'Optional': Optional, 'cast': cast}
exec(compile(ast.fix_missing_locations(ast.Module(body=[cls], type_ignores=[])), str(source), 'exec'), namespace)
reference = namespace['SiTiCalculator']
cases = []
for depth in [8, 9, 10, 12, 14, 16]:
    for range_name in ['tv', 'pc']:
        for domain in ['sdr', 'pq', 'hlg']:
            w, h = 10, 8
            lo, hi = (16*2**(depth-8), 235*2**(depth-8)) if range_name == 'tv' else (0, 2**depth-1)
            y, x = np.indices((h, w))
            frames = [np.full((h, w), lo), np.full((h, w), hi)]
            frames += [lo + ((x*37+y*53+x*y*11+n*29)*2**(depth-8) % (hi-lo+1)) for n in range(3)]
            model = {'whiteCdM2': 1000, 'blackCdM2': .01, 'gamma': 1.2}
            settings = {'transfer': domain}
            if domain == 'pq':
                settings['pqInterpretation'] = 'preserve-pq'
            if domain == 'hlg':
                if depth == 16:
                    model = {'whiteCdM2': 2000, 'blackCdM2': .005, 'gamma': 1.2+.42*np.log10(2)}
                settings['hlg'] = model
            values, previous = [], None
            for raw in frames:
                v = np.array(raw, dtype=np.float64)/(2**depth-1)
                if range_name == 'tv':
                    v = (v-16/255)/(219/255)
                if domain == 'sdr':
                    gain = (300**(1/2.4)-.01**(1/2.4))**2.4
                    lift = .01**(1/2.4)/(300**(1/2.4)-.01**(1/2.4))
                    frame = reference.oetf_pq(gain*np.maximum(v+lift, 0)**2.4)
                elif domain == 'pq':
                    frame = v
                else:
                    # BT.2100-2 Table 5 reference HLG EOTF, achromatic signal.
                    beta = np.sqrt(3*(model['blackCdM2']/model['whiteCdM2'])**(1/model['gamma']))
                    signal = np.maximum((1-beta)*v+beta, 0)
                    a = .17883277
                    b, c = 1-4*a, .5-a*np.log(4*a)
                    light = np.where(signal<=.5, signal**2/3, (np.exp((signal-c)/a)+b)/12)
                    frame = reference.oetf_pq(model['whiteCdM2']*light**model['gamma'])
                ti = reference.ti(frame, previous)
                values.append({'si': float(reference.si(frame))*(2**depth-1), 'ti': None if ti is None else float(ti)*(2**depth-1)})
                previous = frame
            cases.append({'name': f'{domain}-{depth}-{range_name}', 'depth': depth, 'range': range_name, 'domain': domain, 'settings': settings, 'width': w, 'height': h, 'frames': [f.reshape(-1).tolist() for f in frames], 'expected': values})
destination = root / 'test/reference/siti/p910-2023-extended.json'
destination.write_text(json.dumps({'schema': 1, 'basis': 'P.910 literal range/output equations; BT.1886 Annex 1; preserved PQ interpretation; BT.2100-2 Table 5 achromatic HLG EOTF', 'sourceSha256': digest, 'numpy': np.__version__, 'cases': cases}, indent=2, allow_nan=False)+'\n', encoding='utf-8')
print(destination)
