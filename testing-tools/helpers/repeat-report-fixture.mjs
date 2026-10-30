import {createHash} from 'node:crypto';
import {repeatFrameFormat} from '../../public/repeat-model.js';
import {differenceConfiguration,SOURCE_CLASSIFICATION} from '../../public/repeat-difference.js';
import {genericRepeatAlgorithm} from '../../public/repeat-fingerprint.js';

// Generated protocol data with known native bytes, not a claimed media measurement.
export function repeatReportFixture({version=2,algorithm,encoding='hex'}={}){
  const stream={index:0,codec_type:'video',codec_name:'rawvideo',pix_fmt:'gray',width:16,height:16,time_base:'1/1',r_frame_rate:'1/1',avg_frame_rate:'1/1'};
  const bytes=[16,16,16,17,17].map(value=>Buffer.alloc(256,value));
  const format=repeatFrameFormat('gray',16,16),hash=(b,algorithm='sha256',encoding='hex')=>createHash(algorithm).update(b).digest(encoding);
  const frames=bytes.map((b,i)=>({frame:i,pts:String(i),bestEffortPts:String(i),duration:'1',durationSource:'duration',sha256:hash(b),hashPts:String(i),hashDuration:'1',hashBytes:256,interpretation:[null,null,null,null],equalPrevious:i?i!==3:null,difference:i===3?[[256,256,1,256,256,0,0]]:null}));
  const runs=[{startFrame:0,endFrame:2,frameCount:3,extraFrames:2,startPts:'0',endPts:'3',endSource:'next-original-pts'},{startFrame:3,endFrame:4,frameCount:2,extraFrames:1,startPts:'3',endPts:'5',endSource:'last-ffprobe-duration'}];
  const repeat={configurationVersion:2,status:'complete',source:{signature:'0'.repeat(64),contentSha256:hash(Buffer.concat(bytes)),stream:0,pixelFormat:'gray',width:16,height:16},sampleFormat:format,algorithm:'native-bytes-equal+FFmpeg/rawvideo/framehash/SHA256',tools:['ffmpeg','ffprobe','node'].map(role=>({role,path:'protocol-fixture/'+role,sha256:'1'.repeat(64)})),sourceClassification:{...SOURCE_CLASSIFICATION},differenceConfiguration:differenceConfiguration(format),differenceSummary:{comparisons:4,counts:{equal:3,'one-code':1,'two-codes':0,larger:0},sourceAttribution:'not-inferred'},constant:{method:'sample-constant-original-pts-v1',minimumSeconds:2,status:'complete',unresolvedRuns:0,segments:[{...runs[0],observedEndPts:'3',observedTicks:'3'}]},timeBase:'1/1',hashTimeBase:'1/1',gridRates:['1/1','1/1'],frames,exact:{frames:5,comparisons:4,duplicates:3,ratio:.75,runs},timeline:{status:'complete',missingPts:0,missingIntervals:0,nonIncreasing:0,intervals:[{ticks:'1',count:4}],longestIntervals:Array.from({length:4},(_,i)=>({frame:i,nextFrame:i+1,ticks:'1',startPts:String(i),endPts:String(i+1)})),grids:[{rate:'1/1',status:'undetermined',maxError:null}]},freeze:{status:'not-requested'}};
  if(version===1){
    repeat.configurationVersion=1;repeat.algorithm='FFmpeg/rawvideo/framehash/SHA256';delete repeat.source.contentSha256;
    for(const key of ['tools','sourceClassification','differenceConfiguration','differenceSummary','constant'])delete repeat[key];
    for(const frame of frames){delete frame.equalPrevious;delete frame.difference;}
  }
  if(algorithm){
    repeat.algorithm=genericRepeatAlgorithm;
    repeat.fingerprint={version:1,algorithm,bits:createHash(algorithm).digest().length*8,encoding,input:'native-frame-bytes',parameters:{}};
    frames.forEach((frame,i)=>{frame.digest=hash(bytes[i],algorithm,encoding);delete frame.sha256;});
  }
  return {type:'analyze',file:'protocol-fixture.mkv',createdAt:'2026-10-30T00:00:00Z',producer:{applicationVersion:'protocol-fixture'},raw:{format:{},streams:[stream]},stream:0,analysisTargets:{frames:false,bitrate:false,complexity:false,repeat:true},content:null,repeatAnalysis:repeat};
}
