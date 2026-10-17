import {validateReport} from './report.js';
import {encodeReport,decodeReport} from './report-codec.js';
import {timingSummary} from './timing.js';

export const utcNow=()=>new Date().toISOString().replace(/\.\d{3}Z$/,'Z');
export const utcFilename=()=>utcNow().replace(/[-:]/g,'');
export const portableFormat='MediaScope',portableVersion='0.4';
export const maxPortableBytes=256*1000*1000;
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const validTime=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,19)===v.slice(0,19);
const producer=v=>object(v)&&typeof v.applicationVersion==='string'&&v.applicationVersion.length>0&&v.applicationVersion.length<=128;

function entries(items,key){
  if(!Array.isArray(items)||items.length>10000)throw Error(key+' 必须是最多 10000 项的数组');
  const ids=new Set();
  for(const [i,item]of items.entries()){
    if(!object(item)||typeof item.entryId!=='string'||!item.entryId.length||item.entryId.length>128||ids.has(item.entryId))throw Error(`${key}[${i}] 的编号缺失或重复`);
    ids.add(item.entryId);
    if(key==='plans'&&(!object(item.input)||!['inspect','analyze','compare','trial'].includes(item.input.type)))throw Error(`${key}[${i}] 的任务参数无效`);
  }
}

export function validatePortable(value){
  if(!object(value)||value.format!==portableFormat||value.formatVersion!==portableVersion||Object.hasOwn(value,'schema')||Object.hasOwn(value,'kind'))throw Error('不支持的 JSON 格式或版本；仅接受 MediaScope 0.4');
  if(!validTime(value.createdAt)||!producer(value.producer))throw Error('文件缺少有效的创建时间或软件版本');
  entries(value.results,'results');entries(value.plans,'plans');
  if(!value.results.length&&!value.plans.length)throw Error('文件没有结果或计划');
  const results=value.results.map(item=>{
    const report=decodeReport(item.report);validateReport(report);return {...item,report};
  });
  const timing=timingSummary(results.map(item=>item.report.timing));
  if(!object(value.timing)||Object.keys(value.timing).length!==Object.keys(timing).length||Object.entries(timing).some(([key,wanted])=>value.timing[key]!==wanted))throw Error('文件计算耗时汇总不一致');
  return {...value,results};
}

export function parsePortable(text){
  let value;try{value=JSON.parse(text.replace(/^\uFEFF/,''));}catch{throw Error('JSON 无法解析，请选择完整导出的文件');}
  return validatePortable(value);
}

export function makePortable({createdAt=utcNow(),results=[],plans=[],applicationVersion}={}){
  if(!validTime(createdAt)||!producer({applicationVersion}))throw Error('文件缺少有效的创建时间或软件版本');
  entries(results,'results');entries(plans,'plans');
  return {format:portableFormat,formatVersion:portableVersion,createdAt,producer:{applicationVersion},results:results.map(item=>{validateReport(item.report);return {...item,report:encodeReport(item.report)};}),plans,timing:timingSummary(results.map(item=>item.report.timing))};
}

export function reportFromPortable(value){
  const saved=validatePortable(value);
  if(saved.results.length!==1||saved.plans.length)throw Error('报告接口必须包含一份完整结果');
  return saved.results[0].report;
}

const baseName=value=>{
  const name=String(value||'media').split(/[\\/]/).at(-1).replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').replace(/[. ]+$/,'')||'media';
  const dot=name.lastIndexOf('.'),extension=dot>0?name.slice(dot):'',stem=dot>0?name.slice(0,dot):name;
  if(Array.from(name).length<=100)return name;
  if(Array.from(extension).length>=100)return Array.from(name).slice(0,100).join('');
  return Array.from(stem).slice(0,100-Array.from(extension).length).join('')+extension;
};
export function portableFilename(results,plans,time=utcFilename()){
  if(!/^\d{8}T\d{6}Z$/.test(time))throw Error('导出文件名时间无效');
  if(!results.length&&!plans.length)throw Error('没有可导出的结果或计划');
  if(results.length+plans.length!==1)return `MediaScope-queue-${time}.json`;
  const item=results[0]?.report??plans[0]?.input;
  if(item?.type==='compare')return `MediaScope-compare-${time}.json`;
  const type=item?.type==='trial'?'trial':'analyze',file=item?.file??item?.source?.file;
  return `MediaScope-${type}-${baseName(file)}-${time}.json`;
}
