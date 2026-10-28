import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {FF,FP,run,probe} from '../../engine.mjs';
import {analyzeRepeats,repeatContentSha256} from '../../repeat.mjs';
import {fixtures,fixtureLock} from './fixtures.mjs';
import {zipMembers} from './jvet-reference.mjs';
import {repeatTestToolIdentity} from './repeat-tooling.mjs';

export async function auditOfficialRepeat(work,ctx={commands:[]}){
  const digest=b=>createHash('sha256').update(b).digest('hex'),canon=s=>s.replace(/\r\n/g,'\n').trimEnd()+'\n';
  const members=zipMembers(await fixtures.read('repeat/nist-shabytetestvectors.zip'));
  const vector=name=>{const entry=members.get('shabytetestvectors/'+name);assert.ok(entry,'Missing locked vector '+name);return entry.toString('utf8');};
  const results={startedAtUtc:new Date().toISOString(),scope:'Official NIST vector replay; one exact upstream FFmpeg FATE case replay and product integration; selected upstream implementation cross-checks. Not the complete FATE suite or certification.',ffmpegTag:'n8.1.3',ffmpegCommit:'1041abdc962f4cc4f394aa8de9dc5236c0c3b9e7',outcome:'running',inputs:[],source:[],tools:[],checks:[]};
  await fs.mkdir(path.join(work,'generated'),{recursive:true});
  const productFiles=['repeat.mjs','repeat-samples.mjs','engine.mjs','public/repeat-model.js','public/repeat-difference.js','public/analysis-limits.js','testing-tools/helpers/repeat-oracle.mjs','testing-tools/helpers/repeat-official.mjs'];
  try{
   for(const name of productFiles){const b=await fs.readFile(name);results.source.push({path:name,bytes:b.length,sha256:digest(b)});}
   for(const entry of fixtureLock.files.filter(f=>f.path.startsWith('repeat/'))){await fixtures.read(entry.path);results.inputs.push(entry);}
   for(const [name,exe]of [['node',process.execPath],['ffmpeg',FF],['ffprobe',FP]])results.tools.push(await repeatTestToolIdentity(name,exe));
   results.versions={node:process.version,ffmpeg:(await run(FF,['-version'])).split('\n')[0],ffprobe:(await run(FP,['-version'])).split('\n')[0]};
   const selected=[];
   for(const name of ['SHA256ShortMsg.rsp','SHA256LongMsg.rsp']){
    const raw=vector(name),cases=[...raw.matchAll(/Len = (\d+)\s+Msg = ([a-f0-9]+)\s+MD = ([a-f0-9]{64})/gi)],answers=[];
    assert.ok(cases.length>0);
    for(const [,length,text,expected]of cases){const bits=Number(length);assert.equal(bits%8,0);const bytes=bits?Buffer.from(text,'hex'):Buffer.alloc(0);assert.equal(bytes.length,bits/8);
     const native=digest(bytes);assert.equal(native,expected);
     const file=path.join(work,'generated',name+'-'+bits+'.bin');await fs.writeFile(file,bytes);assert.equal(await repeatContentSha256(file),expected);
     answers.push({bits,expected,actual:native,fileContentActual:expected});
     if(name.includes('Short')&&[8,440,448,504,512].includes(bits)||name.includes('Long')&&[cases[0][1],cases.at(-1)[1]].includes(length))selected.push({name,bits,bytes,expected,file});
    }
    results.checks.push({name:'NIST '+name,kind:'official-response-vectors',outcome:'passed',cases:answers});
   }
   const monte=vector('SHA256Monte.rsp'),intermediate=vector('SHA256Monte.txt');
   let seed=Buffer.from(/Seed = ([a-f0-9]+)/i.exec(monte)[1],'hex');const checkpoints=[...monte.matchAll(/COUNT = (\d+)\s+MD = ([a-f0-9]{64})/gi)],innerAnswers=[...intermediate.matchAll(/\ti = (\d+)\s+\tM = ([a-f0-9]+)\s+\tMDi = ([a-f0-9]{64})/gi)];
   let innerCount=0;const monteAnswers=[];
   for(const [index,[,count,expected]]of checkpoints.entries()){
    assert.equal(Number(count),index);let d0=seed,d1=seed,d2=seed;
    for(let i=3;i<=1002;i++){
     const message=Buffer.concat([d0,d1,d2]),next=createHash('sha256').update(message).digest();
     if(i<=7){const answer=innerAnswers[innerCount++];assert.equal(Number(answer[1]),i);assert.equal(message.toString('hex'),answer[2]);assert.equal(next.toString('hex'),answer[3]);}
     [d0,d1,d2]=[d1,d2,next];
    }
    assert.equal(d2.toString('hex'),expected);seed=d2;monteAnswers.push({count:index,expected,actual:d2.toString('hex')});
   }
   assert.equal(innerCount,innerAnswers.length);results.checks.push({name:'NIST SHA256 Monte Carlo',kind:'official-response-and-intermediate-vectors',outcome:'passed',outerChecks:monteAnswers,innerChecks:innerCount,hashEvaluations:checkpoints.length*1000});
   const hashCases=[];
   for(const c of selected){
    const raw=await run(FF,['-v','error','-noauto_conversion_filters','-f','rawvideo','-pixel_format','gray','-video_size',`${c.bytes.length}x1`,'-framerate','1','-i',c.file,'-c:v','rawvideo','-threads:v','1','-pix_fmt','+gray','-f','framehash','-hash','sha256','-'],ctx);
    const hashes=raw.split(/\r?\n/).filter(l=>l&&!l.startsWith('#')).map(l=>l.split(',').at(-1).trim());assert.deepEqual(hashes,[c.expected]);
    const pair=path.join(work,'generated',c.name+'-'+c.bits+'-pair.raw'),file=pair+'.nut';await fs.writeFile(pair,Buffer.concat([c.bytes,c.bytes]));
    await run(FF,['-v','error','-y','-noauto_conversion_filters','-f','rawvideo','-pixel_format','gray','-video_size',`${c.bytes.length}x1`,'-framerate','1','-i',pair,'-c:v','rawvideo','-threads:v','1',file],ctx);
    const stream=(await probe(file,ctx)).raw.streams[0],r=await analyzeRepeats(file,stream,ctx);assert.deepEqual(r.frames.map(f=>f.sha256),[c.expected,c.expected]);assert.equal(r.frames[1].equalPrevious,true);assert.equal(r.exact.duplicates,1);
    hashCases.push({vector:c.name,bits:c.bits,expected:c.expected,officialFramehash:raw,productHashes:r.frames.map(f=>f.sha256),directEqual:r.frames[1].equalPrevious});
   }
   results.checks.push({name:'NIST selected vectors through native FFmpeg framehash and product pipeline',kind:'official-vectors-product-integration',outcome:'passed',cases:hashCases});
   const definition=(await fixtures.read('repeat/ffmpeg-n8.1.3/tests/fate/filter-video.mak')).toString('utf8');
   assert.ok(definition.includes('FILTER_METADATA_COMMAND = ffprobe$(PROGSSUF)$(EXESUF) -of compact=p=0 -show_entries frame=pts:frame_tags -bitexact -f lavfi'));
   assert.ok(definition.includes('fate-filter-metadata-freezedetect: CMD = run $(FILTER_METADATA_COMMAND) "sws_flags=+accurate_rnd+bitexact;mptestsrc=r=25:d=10:m=51,freezedetect"'));
   const filter='sws_flags=+accurate_rnd+bitexact;mptestsrc=r=25:d=10:m=51',expectedText=canon((await fixtures.read('repeat/ffmpeg-n8.1.3/tests/ref/fate/filter-metadata-freezedetect')).toString('utf8'));
   const actualText=canon(await run(FP,['-v','error','-of','compact=p=0','-show_entries','frame=pts:frame_tags','-bitexact','-f','lavfi',filter+',freezedetect'],ctx));assert.equal(actualText,expectedText);
   const file=path.join(work,'generated/fate-freeze.nut');
   await run(FF,['-v','error','-y','-noauto_conversion_filters','-f','lavfi','-i',filter,'-c:v','rawvideo','-threads:v','1','-fps_mode','passthrough',file],ctx);
   const stream=(await probe(file,ctx)).raw.streams[0],r=await analyzeRepeats(file,stream,ctx,{freeze:true});assert.equal(r.freeze.status,'complete',r.freeze.reason);
   const officialEvents=[];let frame=0;
   for(const line of expectedText.trimEnd().split('\n')){assert.equal(Number(/^pts=(\d+)/.exec(line)[1]),frame);for(const [,kind,value]of line.matchAll(/tag:lavfi\.freezedetect\.freeze_(start|duration|end)=([^|]+)/g))officialEvents.push({kind,value,frame});frame++;}
   const eventOrder={start:0,duration:1,end:2},sort=events=>events.toSorted((a,b)=>a.frame-b.frame||eventOrder[a.kind]-eventOrder[b.kind]);
   assert.equal(r.frames.length,frame);assert.deepEqual(sort(r.freeze.events.map(({kind,value,frame})=>({kind,value,frame}))),sort(officialEvents));
   for(const e of r.freeze.events){assert.equal(e.filterPts,r.frames[e.frame].pts);assert.equal(BigInt(e.filterPts)*BigInt(stream.time_base.split('/')[0])*25n,BigInt(e.frame)*BigInt(stream.time_base.split('/')[1]));}
   results.checks.push({name:'FFmpeg n8.1.3 fate-filter-metadata-freezedetect',kind:'exact-official-FATE-case-replay-and-product-integration',outcome:'passed',frames:frame,exactReferenceTextMatched:true,normalization:'CRLF to LF and final newline only; no value or tag changes',officialEvents,productEvents:r.freeze.events,productSegments:r.freeze.segments,productTimeBase:r.timeBase,referenceText:expectedText,actualText});
   results.outcome='passed';
  }catch(error){results.outcome='failed';results.error=error.stack;throw error;}
  finally{results.commands=ctx.commands;results.finishedAtUtc=new Date().toISOString();await fs.writeFile(path.join(work,'official-vectors.json'),JSON.stringify(results)+'\n');}
  return results;
}
