"""Generate new known-byte SI/TI controls independently of production code.

Usage: python -B SCRIPT SPEC AVUTIL FFMPEG OUTPUT
Writes a new candidate only. Native packing comes from pinned upstream
AVPixFmtDescriptor; expected metrics come from intended integer samples and
explicit scalar Sobel/population std, never from product JS/C#/FFmpeg SI/TI.
"""
import base64
import ctypes as C
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import subprocess
import sys

spec_path, dll_path, ff_path, output_path = map(Path, sys.argv[1:])
spec = json.loads(spec_path.read_text(encoding="utf-8"))
environment = json.loads((Path(__file__).parent / "environment.lock.json").read_text(encoding="utf-8"))
identity = environment["descriptorReference"]
if hashlib.sha256(dll_path.read_bytes()).hexdigest() != identity["dllSha256"]:
    raise RuntimeError("Independent descriptor DLL identity mismatch")
if output_path.exists() or ".build" not in output_path.parts:
    raise RuntimeError("Generate a fresh candidate inside project .build")
if sys.version_info[:2] != (3, 12):
    raise RuntimeError("Pinned CPython 3.12 required")
os.add_dll_directory(str(dll_path.parent.resolve()))
lib = C.CDLL(str(dll_path.resolve()))

class Component(C.Structure):
    _fields_ = [(name, C.c_int) for name in ("plane", "step", "offset", "shift", "depth")]

class Descriptor(C.Structure):
    _fields_ = [("name", C.c_char_p), ("count", C.c_uint8), ("cw", C.c_uint8),
                ("ch", C.c_uint8), ("flags", C.c_uint64), ("comp", Component*4), ("alias", C.c_char_p)]

lib.av_get_pix_fmt.argtypes = [C.c_char_p]
lib.av_get_pix_fmt.restype = C.c_int
lib.av_pix_fmt_desc_get.argtypes = [C.c_int]
lib.av_pix_fmt_desc_get.restype = C.POINTER(Descriptor)
lib.av_image_fill_arrays.argtypes = [C.POINTER(C.POINTER(C.c_uint8)), C.POINTER(C.c_int), C.POINTER(C.c_uint8), C.c_int, C.c_int, C.c_int, C.c_int]
lib.av_image_fill_arrays.restype = C.c_int
lib.av_read_image_line2.argtypes = [C.c_void_p, C.POINTER(C.POINTER(C.c_uint8)), C.POINTER(C.c_int), C.POINTER(Descriptor), C.c_int, C.c_int, C.c_int, C.c_int, C.c_int, C.c_int]
lib.avutil_version.restype = C.c_uint

def population_std(values):
    mean = math.fsum(values)/len(values)
    return math.sqrt(math.fsum((v-mean)**2 for v in values)/len(values))

def spatial(frame, w, h):
    values = []
    for y in range(1, h-1):
        for x in range(1, w-1):
            a,b,c,d,e,f,g,i,j = [frame[(y+dy)*w+x+dx] for dy in (-1,0,1) for dx in (-1,0,1)]
            gx = -a+c-2*d+2*f-g+j
            gy = -a-2*b-c+g+2*i+j
            values.append(math.hypot(gx, gy))
    return population_std(values)*255

cases = []
for fmt in spec["formats"]:
    base = fmt.replace("msb", "")
    code = lib.av_get_pix_fmt(base.encode())
    if code < 0:
        raise RuntimeError("Unknown independent descriptor: "+base)
    pointer = lib.av_pix_fmt_desc_get(code)
    desc = pointer.contents
    rgb, alpha, endian = bool(desc.flags & 32), bool(desc.flags & 128), "big" if desc.flags & 1 else "little"
    for w,h in spec["dimensions"]:
        for range_name in spec["ranges"]:
            frames, expected, previous, hashes, normalized = [], [], None, [], []
            for frame_id in range(3):
                pointers, lines = (C.POINTER(C.c_uint8)*4)(), (C.c_int*4)()
                scratch = (C.c_uint8*(w*h*16+1024))()
                count = lib.av_image_fill_arrays(pointers,lines,scratch,code,w,h,1)
                if count < 0 or count > len(scratch):
                    raise RuntimeError("Invalid independent image layout")
                intended, component_codes = [], []
                for component in range(desc.count):
                    c = desc.comp[component]
                    is_alpha = alpha and component == desc.count-1
                    cw = (w+(1<<desc.cw)-1)>>desc.cw if not rgb and component in (1,2) else w
                    ch = (h+(1<<desc.ch)-1)>>desc.ch if not rgb and component in (1,2) else h
                    maximum = (1<<c.depth)-1
                    low, high = (16*2**(c.depth-8),235*2**(c.depth-8)) if range_name == "tv" else (0,maximum)
                    values = []
                    for y in range(ch):
                        for x in range(cw):
                            if is_alpha:
                                value = maximum
                            elif not rgb and component > 0:
                                value = 1 << (c.depth-1)
                            else:
                                lo, hi = math.ceil(low),math.floor(high)
                                value = lo + ((x*17+y*29+x*y*3+frame_id*31+component*43) % (hi-lo+1))
                                if y == 0 and x < 2:
                                    value = lo if (x+frame_id)%2 == 0 else hi
                            values.append(value)
                            offset = C.addressof(pointers[c.plane].contents)-C.addressof(scratch)+y*lines[c.plane]+x*c.step+c.offset
                            size = (c.depth+c.shift+7)//8
                            old = int.from_bytes(bytes(scratch[offset:offset+size]),endian)
                            packed = (old & ~(maximum<<c.shift)) | (value<<c.shift)
                            for k,b in enumerate(packed.to_bytes(size,endian)):
                                scratch[offset+k] = b
                    component_codes.append(values)
                    # Independent upstream unpacking confirms the writer at every sample.
                    for y in range(ch):
                        decoded = (C.c_uint32*cw)()
                        lib.av_read_image_line2(decoded,pointers,lines,pointer,0,y,component,cw,0,4)
                        if list(decoded) != values[y*cw:(y+1)*cw]:
                            raise RuntimeError("Independent native-byte round trip mismatch")
                if rgb:
                    for i in range(w*h):
                        value = 0
                        for c,weight in enumerate((.2126,.7152,.0722)):
                            depth = desc.comp[c].depth
                            lo,hi = (16*2**(depth-8),235*2**(depth-8)) if range_name == "tv" else (0,(1<<depth)-1)
                            value += weight*(component_codes[c][i]-lo)/(hi-lo)
                        intended.append(value)
                else:
                    depth = desc.comp[0].depth
                    lo,hi = (16*2**(depth-8),235*2**(depth-8)) if range_name == "tv" else (0,(1<<depth)-1)
                    intended = [(v-lo)/(hi-lo) for v in component_codes[0]]
                raw = bytes(scratch[:count])
                if "msb" in fmt:
                    args = [str(ff_path),'-v','error','-nostdin','-f','rawvideo','-pixel_format',base,'-video_size',f'{w}x{h}','-i','pipe:0','-frames:v','1','-c:v','rawvideo','-pix_fmt',fmt,'-f','rawvideo','pipe:1']
                    converted = subprocess.run(args,input=raw,stdout=subprocess.PIPE,stderr=subprocess.PIPE,check=True).stdout
                    reverse = args.copy();reverse[reverse.index(base)] = fmt;reverse[reverse.index(fmt,reverse.index('-pix_fmt')+1)] = base
                    back = subprocess.run(reverse,input=converted,stdout=subprocess.PIPE,stderr=subprocess.PIPE,check=True).stdout
                    if back != raw:
                        raise RuntimeError("Official same-depth MSB round trip changed native bytes")
                    raw = converted
                frames.append(base64.b64encode(raw).decode())
                normalized.append(intended)
                hashes.append(hashlib.sha256(raw).hexdigest())
                expected.append(dict(si=spatial(intended,w,h),ti=None if previous is None else population_std([v-p for v,p in zip(intended,previous)])*255))
                previous = intended
            cases.append(dict(name=f'{fmt}-{range_name}-{w}x{h}',format=fmt,width=w,height=h,range=range_name,domain='pq',settings=dict(range=range_name,transfer='pq',matrix='bt709'),frames=frames,frameSha256=hashes,normalized=normalized,expected=expected))
result = dict(schema=1,provenance=dict(origin='New self-authored deterministic integer patterns; no production code or old reference answers used',generatorSha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),specSha256=hashlib.sha256(spec_path.read_bytes()).hexdigest(),descriptor=identity,libavutilVersion=lib.avutil_version(),ffmpegSha256=hashlib.sha256(ff_path.read_bytes()).hexdigest(),python=platform.python_version(),math='Explicit scalar 2D valid Sobel; two-pass population standard deviation; adjacent normalized differences; scale 255',domain='PQ; BT.709 RGB luma; explicit full/limited ranges'),cases=cases)
with output_path.open('x',encoding='utf-8',newline='\n') as f:
    json.dump(result,f,separators=(',',':'));f.write('\n')
print(json.dumps(dict(outcome='generated-awaiting-review',cases=len(cases),formats=len(spec['formats']),output=str(output_path))))
