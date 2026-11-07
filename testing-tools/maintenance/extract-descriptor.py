"""Extract only verified upstream descriptor runtime DLLs into a fresh workspace."""
import hashlib
import json
from pathlib import Path
import re
import sys
import zipfile
wheel, destination = map(Path, sys.argv[1:])
lock = json.loads((Path(__file__).parent/'environment.lock.json').read_text())['descriptorReference']
if hashlib.sha256(wheel.read_bytes()).hexdigest() != lock['sha256']:
    raise RuntimeError('Descriptor wheel identity mismatch')
if '.build' not in destination.parts or destination.exists():
    raise RuntimeError('Fresh descriptor directory inside project .build required')
with zipfile.ZipFile(wheel) as archive:
    for name in archive.namelist():
        if re.fullmatch(r'av\.libs/[A-Za-z0-9_.-]+\.dll',name):
            target=destination/name
            target.parent.mkdir(parents=True,exist_ok=True)
            with target.open('xb') as f:
                f.write(archive.read(name))
dll=destination/lock['dll']
if hashlib.sha256(dll.read_bytes()).hexdigest() != lock['dllSha256']:
    raise RuntimeError('Descriptor DLL identity mismatch')
print(json.dumps({'dll':str(dll)}))
