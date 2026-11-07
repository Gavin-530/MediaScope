import {projectTest} from '../../helpers/case-test.mjs';
const test=projectTest(import.meta.url);
import assert from '../../helpers/assert.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {createFixtureStore} from '../../helpers/fixtures.mjs';
import {checkToolSources} from '../../helpers/source-layout.mjs';

const workRoot=path.resolve(fileURLToPath(new URL('../../../.build/fixture-protocol/',import.meta.url)));
const bytes=Buffer.from('fixture transport protocol only\n');
const entry={path:'siti/example.bin',bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),url:'https://example.invalid/pinned-input'};
async function directory(t){
  await fs.mkdir(workRoot,{recursive:true});const root=await fs.mkdtemp(path.join(workRoot,'case-'));
  t.after(async()=>{assert.ok(root.startsWith(workRoot+path.sep));await fs.rm(root,{recursive:true,force:true})});return root;
}

test('[test-system] testing tools contain only maintained code and metadata',async()=>{
  await checkToolSources(fileURLToPath(new URL('../../',import.meta.url)));
  await assert.rejects(fs.access(new URL('../../../test/',import.meta.url)),{code:'ENOENT'});
});

test('[test-system] fixed input cache verifies reuse, concurrent preparation and post-cache tampering',async t=>{
  const root=await directory(t);let requests=0,receipts=0;
  const store=createFixtureStore({root,entries:[entry],fetcher:async()=>{requests++;return new Response(bytes)},onRead:()=>()=>receipts++});
  await Promise.all([store.ensure(entry.path),store.ensure(entry.path)]);assert.equal(requests,1);
  assert.equal(receipts,2);
  assert.deepEqual(await store.read(entry.path),bytes);assert.equal(requests,1);
  await fs.writeFile(store.file(entry.path),Buffer.alloc(bytes.length));
  await assert.rejects(store.read(entry.path),/checksum mismatch/);assert.equal(requests,1);

  const first={...entry,path:'siti/first.bin'},second={...entry,path:'siti/second.bin'},attachment={...entry,path:'siti/source.txt'};
  const checked=[];
  const batch=createFixtureStore({root,entries:[first,second,attachment],fetcher:async()=>new Response(bytes),
    dependencies:name=>name===attachment.path?[]:[attachment.path],onRead:item=>()=>checked.push(item.path)});
  const values=await batch.readMany([first.path,second.path,first.path]);
  assert.deepEqual([...values],[[first.path,bytes],[second.path,bytes]]);
  assert.deepEqual(checked,[attachment.path,first.path,second.path]);
  await fs.writeFile(batch.file(attachment.path),Buffer.alloc(bytes.length));
  await assert.rejects(batch.readMany([first.path,second.path]),/checksum mismatch/);
});

test('[test-system] bad downloads and unlocked paths never become test inputs',async t=>{
  let receipts=0;
  const root=await directory(t),store=createFixtureStore({root,entries:[entry],fetcher:async()=>new Response(Buffer.alloc(bytes.length)),onRead:()=>()=>receipts++});
  await assert.rejects(store.ensure(entry.path),/checksum mismatch/);
  assert.equal(receipts,0);
  await assert.rejects(fs.access(store.file(entry.path)),{code:'ENOENT'});
  assert.throws(()=>store.file('../outside.bin'),/not locked/);
  assert.throws(()=>createFixtureStore({root,entries:[{...entry,path:'siti/../outside'}]}),/Invalid fixture/);
  assert.throws(()=>createFixtureStore({root,entries:[entry],dependencies:()=>[entry.path]}),/Cyclic fixture/);
  assert.throws(()=>createFixtureStore({root,entries:[entry],dependencies:()=>['siti/missing.bin']}),/Unlocked fixture attachment/);
  assert.deepEqual(await fs.readdir(root),[]);
});

test('[test-system] testing tool boundary rejects generated media and reference data',async t=>{
  const root=await directory(t);await fs.writeFile(path.join(root,'fixture.mov'),'synthetic boundary sentinel');
  await assert.rejects(checkToolSources(root),/Material or output/);
});
