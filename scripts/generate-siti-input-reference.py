"""Independent reference for native storage, RGB, float and range/scale choices."""
import ast
import base64
import hashlib
import json
import struct
from pathlib import Path
from typing import Optional, cast
import numpy as np
from scipy import ndimage

root=Path(__file__).resolve().parent.parent
source=root/'test/reference/siti/vqeg-v0.3.0.py'
digest=hashlib.sha256(source.read_bytes()).hexdigest()
assert digest=='231e4524b1bfca6b90d4b91fc86f9c89d65621cb2f256714a59506ba6cbf091c'
tree=ast.parse(source.read_text(encoding='utf-8'))
cls=next(n for n in tree.body if isinstance(n,ast.ClassDef) and n.name=='SiTiCalculator')
cls.body=[n for n in cls.body if isinstance(n,ast.FunctionDef) and n.name in {'si','ti','oetf_pq'}]
namespace={'np':np,'ndimage':ndimage,'Optional':Optional,'cast':cast}
exec(compile(ast.fix_missing_locations(ast.Module(body=[cls],type_ignores=[])),str(source),'exec'),namespace)
ref=namespace['SiTiCalculator']
weights={'bt601':np.array([.299,.587,.114]),'bt709':np.array([.2126,.7152,.0722]),'bt2020':np.array([.2627,.678,.0593])}

def encode(values,fmt,depth,w,h):
    endian='>' if fmt.endswith('be') else '<'
    floating='f32' in fmt
    sample='f' if floating else 'B' if depth==8 else 'H'
    def pack(v):return struct.pack(endian+sample*len(v),*v)
    rgb=fmt.startswith(('gbr','rgb','bgr','argb'))
    if rgb:
        r,g,b=values
        alpha=1.0 if floating else 2**depth-1
        if fmt.startswith('gbr'):
            return pack(np.concatenate([g,r*0+b,r]+([np.full(w*h,alpha)] if 'gbrap' in fmt else [])))
        order='argb' if fmt=='argb' else 'rgba' if fmt=='rgba' else 'rgb0' if fmt=='rgb0' else 'bgr' if fmt.startswith('bgr') else 'rgb'
        channels={'r':r,'g':g,'b':b,'a':np.full(w*h,alpha),'0':np.zeros(w*h,dtype=np.int64)}
        return pack(np.stack([channels[x] for x in order],axis=1).reshape(-1))
    y=values[0]
    if fmt.startswith('gray'):return pack(y)
    sub=[2,2] if fmt in ['nv12','p010le','p016be'] else [1,1]
    chroma=np.full(2*((w+sub[0]-1)//sub[0])*((h+sub[1]-1)//sub[1]),128*2**(depth-8),dtype=np.int64)
    shift=6 if fmt=='p010le' else 0
    return pack(np.concatenate([y,chroma])*(2**shift))

cases=[]
formats=[('rgb24',8),('bgr24',8),('rgba',8),('argb',8),('rgb0',8),('rgb48be',16),('gbrp10le',10),('gbrp12be',12),('gbrap16le',16),('gbrpf32le',10),('gbrpf32be',12),('gbrapf32le',16),('grayf32le',8),('grayf32be',16),('gray16be',16),('yuv444p12be',12),('nv12',8),('p010le',10),('p016be',16),('gbrpf32le-tv',10)]
for index,(token,depth) in enumerate(formats):
    fmt=token.removesuffix('-tv')
    for scale in ['literal','reference-255']:
        w,h=7,5
        rgb=fmt.startswith(('gbr','rgb','bgr','argb'))
        floating='f32' in fmt
        matrix=['bt601','bt709','bt2020'][index%3]
        domain=['sdr','pq','hlg'][index%3]
        range_name='tv' if token.endswith('-tv') else 'pc' if floating or index%2 else 'tv'
        max_code=2**depth-1
        lo,hi=(16*2**(depth-8),235*2**(depth-8)) if range_name=='tv' else (0,max_code)
        settings={'range':range_name,'transfer':domain,'scale':scale}
        if domain=='pq':settings['pqInterpretation']='preserve-pq'
        if rgb:settings['matrix']=matrix
        if floating:settings.update(floatDepth=depth,floatEncoding='normalized-nonlinear')
        model={'whiteCdM2':1000,'blackCdM2':.01,'gamma':1.2}
        if domain=='hlg':settings['hlg']=model
        payloads,expected=[],[]
        previous=None
        for frame in range(5):
            x,y=np.meshgrid(np.arange(w),np.arange(h))
            channels=[]
            for c in range(3 if rgb else 1):
                raw=np.full((h,w),lo if frame==0 else hi) if frame<2 else lo+(x*37+y*53+x*y*11+frame*29+c*71)*2**(depth-8)%(hi-lo+1)
                channels.append(raw.reshape(-1).astype(np.int64))
            values=[(c/max_code).astype(np.float32) if floating else c for c in channels]
            payloads.append(base64.b64encode(encode(values,fmt,depth,w,h)).decode('ascii'))
            normalized=np.array(values,dtype=np.float64)/(1 if floating else max_code)
            v=np.sum(normalized*weights[matrix][:,None],axis=0) if rgb else normalized[0]
            if range_name=='tv':v=(v-lo/max_code)/((hi-lo)/max_code) if scale=='reference-255' else (v-16/255)/(219/255)
            if domain=='sdr':
                gain=(300**(1/2.4)-.01**(1/2.4))**2.4
                lift=.01**(1/2.4)/(300**(1/2.4)-.01**(1/2.4))
                plane=ref.oetf_pq(gain*np.maximum(v+lift,0)**2.4)
            elif domain=='pq':plane=v
            else:
                beta=np.sqrt(3*(model['blackCdM2']/model['whiteCdM2'])**(1/model['gamma']))
                s=np.maximum((1-beta)*v+beta,0)
                a=.17883277;b=1-4*a;c=.5-a*np.log(4*a)
                light=np.where(s<=.5,s*s/3,(np.exp((s-c)/a)+b)/12)
                plane=ref.oetf_pq(model['whiteCdM2']*light**model['gamma'])
            plane=plane.reshape(h,w)
            multiplier=255 if scale=='reference-255' else max_code
            ti=ref.ti(plane,previous)
            expected.append({'si':float(ref.si(plane))*multiplier,'ti':None if ti is None else float(ti)*multiplier})
            previous=plane
        cases.append({'name':fmt+'-'+scale+('-tv' if token.endswith('-tv') else ''),'format':fmt,'depth':depth,'range':range_name,'domain':domain,'matrix':matrix if rgb else None,'width':w,'height':h,'settings':settings,'frames':payloads,'expected':expected})
target=root/'test/reference/siti/p910-2023-inputs.json'
target.write_text(json.dumps({'schema':1,'sourceSha256':digest,'numpy':np.__version__,'basis':'independent RGB/float normalization; literal or native legal endpoints; literal input-depth or fixed 255 output; pinned VQEG operators','cases':cases},indent=2,allow_nan=False)+'\n',encoding='utf-8')
print(target)
