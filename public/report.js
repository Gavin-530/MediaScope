// Validate the saved data without normalizing, rounding or discarding evidence.
export function parseReport(text){
 let r;try{r=JSON.parse(text.replace(/^\uFEFF/,''))}catch{throw Error('JSON 无法解析，请选择完整导出的报告文件')}
 validateReport(r);return r;
}
export function validateReport(r){
 const fail=p=>{throw Error(`报告字段缺失或格式错误：${p}；无法完整还原预览`)};
 const obj=(v,p)=>{if(!v||typeof v!=='object'||Array.isArray(v))fail(p)};
 const arr=(v,p)=>{if(!Array.isArray(v))fail(p)};
 const index=(v,p)=>{if(!Number.isSafeInteger(v)||v<0)fail(p)};
 const objects=(v,p)=>{arr(v,p);v.forEach((x,i)=>obj(x,`${p}[${i}]`))};
 const file=(v,p)=>{obj(v,p);if(typeof v.file!=='string')fail(p+'.file')};
 const metrics=(v,p,required)=>{obj(v,p);for(const [k,m]of Object.entries(v)){if(!['psnr','ssim','vmaf'].includes(k))fail(p+'.'+k);obj(m,p+'.'+k);if(required||m.values!==undefined){arr(m.values,p+'.'+k+'.values');if(m.values.some(x=>x!==null&&x!=='Infinity'&&(typeof x!=='number'||!Number.isFinite(x))))fail(p+'.'+k+'.values')}if(m.worst!==undefined)objects(m.worst,p+'.'+k+'.worst')}};
 obj(r,'报告');
 if(!['MediaScope/0.1','MediaScope/0.2'].includes(r.schema))throw Error('不支持的报告版本：'+String(r.schema??'未报告'));
 if(!['inspect','analyze','compare','trial'].includes(r.type))fail('type');
 if(r.warnings!==undefined)arr(r.warnings,'warnings');
 if(r.type==='inspect'||r.type==='analyze'){
  file(r,'报告');obj(r.raw,'raw');objects(r.raw.streams,'raw.streams');obj(r.raw.format,'raw.format');
  r.raw.streams.forEach(s=>index(s.index,'raw.streams.index'));
  if(r.metadata){obj(r.metadata,'metadata');objects(r.metadata.items,'metadata.items');r.metadata.items.forEach(x=>arr(x.sources,'metadata.items.sources'))}
  if(r.type==='analyze'||r.frames!==undefined){
   objects(r.frames,'frames');obj(r.packets,'packets');objects(r.packets.bins,'packets.bins');obj(r.summary,'summary');
   if(r.tracks){objects(r.tracks,'tracks');r.tracks.forEach(x=>{index(x.index,'tracks.index');objects(x.bins,'tracks.bins')})}
   if(r.content?.available){obj(r.content.si,'content.si');objects(r.content.points,'content.points')}
   if(r.coding?.gops){objects(r.coding.gops,'coding.gops');let next=0;for(const [i,g]of r.coding.gops.entries()){if(g.index!==i||g.start!==next||!Number.isInteger(g.end)||g.end<g.start||g.end>=r.frames.length||g.count!==g.end-g.start+1)fail('coding.gops');next=g.end+1}if(next!==r.frames.length)fail('coding.gops')}
   if(r.coding?.codec==='av1'){obj(r.coding.counts,'coding.counts');for(const k of ['encoded','hidden','showExisting','shown'])index(r.coding.counts[k],'coding.counts.'+k);objects(r.coding.events,'coding.events');r.coding.events.forEach((e,i)=>{if(e.id!==i)fail('coding.events.id')})}
  }
 }else if(r.type==='compare'){
  file(r.reference,'reference');file(r.candidate,'candidate');obj(r.alignment,'alignment');metrics(r.metrics,'metrics',true);
  index(r.alignment.frames,'alignment.frames');for(const m of Object.values(r.metrics))if(m.values.length!==r.alignment.frames)fail('metrics.values.length');
  if(r.normalization?.crossDepth)obj(r.normalization.sourceFormats,'normalization.sourceFormats');
 }else{
  file(r.source,'source');obj(r.experiment,'experiment');arr(r.experiment.retainedFiles,'experiment.retainedFiles');objects(r.rows,'rows');if(!r.rows.length)fail('rows');r.rows.forEach(x=>metrics(x.metrics,'rows.metrics',false));
  if(r.experiment.actualFrames!==undefined){index(r.experiment.actualFrames,'experiment.actualFrames');for(const row of r.rows)for(const m of Object.values(row.metrics))if(m.values&&m.values.length!==r.experiment.actualFrames)fail('rows.metrics.values.length')}
  if(r.experiment.frameTimes!==undefined){const times=r.experiment.frameTimes;arr(times,'experiment.frameTimes');if(times.length!==r.experiment.actualFrames||times.some((t,i)=>!Number.isFinite(t)||t<0||(i>0&&t<=times[i-1])))fail('experiment.frameTimes')}
  if(r.experiment.preparation?.baseline){obj(r.experiment.preparation.baseline.psnr,'baseline.psnr');obj(r.experiment.preparation.baseline.ssim,'baseline.ssim')}
 }
 return r;
}
