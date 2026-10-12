"""Independent NumPy reference for declared display light and alpha composition."""
import ast
import base64
import hashlib
import json
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
ns={'np':np,'ndimage':ndimage,'Optional':Optional,'cast':cast}
exec(compile(ast.fix_missing_locations(ast.Module(body=[cls],type_ignores=[])),str(source),'exec'),ns)
ref=ns['SiTiCalculator']
weights={'bt601':np.array([.299,.587,.114]),'bt709':np.array([.2126,.7152,.0722]),'bt2020':np.array([.2627,.678,.0593])}

def case(fmt,depth,encoding,mode,scale,index):
    w,h=7,5
    rgb=not fmt.startswith('gray'); floating='f32' in fmt
    matrix=['bt601','bt709','bt2020'][index%3] if rgb else None
    coeff=weights[matrix] if rgb else np.ones(1)
    alpha=mode is not None
    physical=encoding in ['normalized-linear','absolute-cdm2']
    range_name='pc' if physical or index%2 else 'tv'
    maximum=2**depth-1
    low,high=(16*2**(depth-8)/maximum,235*2**(depth-8)/maximum) if range_name=='tv' else (0,1)
    if floating:low,high=float(np.float32(low)),float(np.float32(high))
    display={'blackCdM2':.02,'whiteCdM2':1400}
    hlg={'blackCdM2':.01,'whiteCdM2':1000,'gamma':1.2}
    background=np.array([.02,17,203])
    settings={'range':range_name,'scale':scale}
    if rgb:settings['matrix']=matrix
    if floating:settings.update(floatDepth=depth,floatEncoding=encoding if physical else 'normalized-nonlinear')
    if encoding=='normalized-linear':settings['linearDisplay']=display
    if not physical:settings['transfer']=encoding
    if encoding=='hlg':settings['hlg']=hlg
    if alpha:settings['alpha']={'mode':mode,'backgroundCdM2':background.tolist()}
    frames,expected=[],[]; previous=None
    for frame in range(5):
        x,y=np.meshgrid(np.arange(w),np.arange(h))
        values=np.stack([np.full((h,w),0 if frame==0 else 1) if frame<2 else ((x*37+y*53+x*y*11+frame*29+c*71)%257)/256 for c in range(3 if rgb else 1)])
        av=np.full((h,w),0 if frame==0 else 1) if frame<2 else ((x+2*y+frame)%5)/4
        if alpha:av=av.astype(np.float32).astype(np.float64) if floating else np.rint(av*maximum)/maximum
        if encoding=='absolute-cdm2':values=values*10000
        if mode=='premultiplied-signal':values=values*av
        stored=values if physical else low+values*(high-low)
        stored=stored.astype(np.float32).astype(np.float64) if floating else np.rint(stored*maximum)/maximum
        storage=stored if floating else np.rint(stored*maximum).astype(np.uint16)
        if fmt.startswith('gbr'):payload=np.concatenate([storage[1].reshape(-1),storage[2].reshape(-1),storage[0].reshape(-1)]+([av.reshape(-1) if floating else np.rint(av*maximum).reshape(-1)] if alpha else []))
        elif rgb:
            order=[2,1,0] if fmt.startswith('bgra') else [0,1,2]
            payload=np.stack([storage[c] for c in order]+([av if floating else np.rint(av*maximum)] if alpha else []),axis=-1).reshape(-1)
        else:payload=storage.reshape(-1)
        endian='>' if fmt.endswith('be') else '<'
        dtype=endian+('f4' if floating else 'u1' if depth==8 else 'u2')
        frames.append(base64.b64encode(payload.astype(dtype).tobytes()).decode('ascii'))
        values=stored if physical else (stored-low)/(high-low)
        if mode=='premultiplied-signal':values=np.minimum(10000 if encoding=='absolute-cdm2' else 1,np.divide(values,av,out=np.zeros_like(values),where=av!=0))
        if encoding=='absolute-cdm2':light=values
        elif encoding=='normalized-linear':light=display['blackCdM2']+(display['whiteCdM2']-display['blackCdM2'])*values
        elif encoding=='sdr':light=((300**(1/2.4)-.01**(1/2.4))*values+.01**(1/2.4))**2.4
        elif encoding=='pq':
            power=values**(32/2523)
            light=10000*(np.maximum(power-3424/4096,0)/(2413/128-(2392/128)*power))**(16384/2610)
        else:
            beta=np.sqrt(3*(hlg['blackCdM2']/hlg['whiteCdM2'])**(1/hlg['gamma']))
            signal=(1-beta)*values+beta
            a=.17883277;b=1-4*a;c=.5-a*np.log(4*a)
            scene=np.where(signal<=.5,signal**2/3,(np.exp((signal-c)/a)+b)/12)
            ys=np.sum(coeff[:,None,None]*scene,axis=0)
            light=hlg['whiteCdM2']*ys**(hlg['gamma']-1)*scene
        if alpha:light=av*light+(1-av)*background[:,None,None]
        luminance=np.sum(coeff[:,None,None]*light,axis=0)
        plane=ref.oetf_pq(luminance)
        multiplier=255 if scale=='reference-255' else maximum
        ti=ref.ti(plane,previous)
        expected.append({'si':float(ref.si(plane))*multiplier,'ti':None if ti is None else float(ti)*multiplier})
        previous=plane
    name='-'.join([fmt,encoding,mode or 'opaque',scale])
    return {'name':name,'format':fmt,'depth':depth,'range':range_name,'domain':encoding,'matrix':matrix,'width':w,'height':h,'settings':settings,'frames':frames,'expected':expected}

cases=[]
for fmt,depth in [('grayf32le',10),('grayf32be',12),('gbrpf32le',10),('gbrpf32be',16)]:
    for encoding in ['normalized-linear','absolute-cdm2']:
        for scale in ['literal','reference-255']:cases.append(case(fmt,depth,encoding,None,scale,len(cases)))
for fmt,depth in [('rgba',8),('bgra64le',16),('gbrapf32le',10),('gbrapf32be',12)]:
    for encoding in (['sdr','pq','hlg','normalized-linear','absolute-cdm2'] if 'f32' in fmt else ['sdr','pq','hlg']):
        for mode in ['straight','premultiplied-signal']:
            for scale in ['literal','reference-255']:cases.append(case(fmt,depth,encoding,mode,scale,len(cases)))
target=root/'test/reference/siti/p910-2023-physical.json'
target.write_text(json.dumps({'schema':1,'sourceSha256':digest,'numpy':np.__version__,'basis':'independent display-light mapping and source-over alpha; per-component EOTF; linear luma then pinned VQEG PQ/Sobel/TI','cases':cases},indent=2,allow_nan=False)+'\n',encoding='utf-8')
print(f'{target}: {len(cases)} cases')
