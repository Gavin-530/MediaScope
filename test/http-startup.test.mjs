import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {startServer} from './helpers/server.mjs';

test('[startup-infrastructure] a real blocked HTTP port is replaced before product checks, with its startup log retained',async()=>{
  const dir=path.resolve('test-work/http-startup');
  // 6679 is the real port rejected in the archived merge regression, and is blocked by Fetch.
  const app=await startServer(dir,{port:6679});
  try{
    assert.notEqual(new URL(app.base).port,'6679');
    assert.match(await readFile(path.join(dir,'server-rejected-port-1.log'),'utf8'),/已启动：http:\/\/127\.0\.0\.1:6679/);
    const status=await app.request('status');
    assert.match(status.versions.ffmpeg,/ffmpeg version/);
    assert.ok(status.metrics.includes('psnr'));
    assert.match(await(await fetch(app.base)).text(),/MediaScope/);
  }finally{await app.stop()}
});
