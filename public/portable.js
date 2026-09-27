import {validateReport} from './report.js';

export const portableSchemas={results:'MediaScopeResults/1',plan:'MediaScopePlan/1',bundle:'MediaScopeBundle/1'};
export const maxPortableBytes=256*1024*1024;

const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const entryId=value=>typeof value==='string'&&value.length>0&&value.length<=128;

export function validatePortable(value){
 if(!object(value))throw Error('文件顶层必须是对象');
 const kind=Object.keys(portableSchemas).find(key=>portableSchemas[key]===value.schema);
 if(!kind)throw Error('不支持的导入文件版本或类型：'+String(value.schema??'未提供'));
 if(value.kind!==kind)throw Error('文件类型与版本标识不一致');
 if(typeof value.createdAt!=='string'||!Number.isFinite(Date.parse(value.createdAt)))throw Error('文件缺少有效的创建时间');
 const check=(items,key)=>{
  if(!Array.isArray(items)||items.length>10000)throw Error(key+' 必须是最多 10000 项的数组');
  const ids=new Set();
  items.forEach((item,i)=>{
   if(!object(item)||!entryId(item.entryId)||ids.has(item.entryId))throw Error(`${key}[${i}] 的编号缺失或重复`);
   ids.add(item.entryId);
   if(key==='results')validateReport(item.report);
   else if(!object(item.input)||!['inspect','analyze','compare','trial'].includes(item.input.type))throw Error(`${key}[${i}] 的任务参数无效`);
  });
 };
 if(kind==='results'||kind==='bundle')check(value.results,'results');
 else if(value.results!==undefined)throw Error('计划文件不能包含结果表');
 if(kind==='plan'||kind==='bundle')check(value.plans,'plans');
 else if(value.plans!==undefined)throw Error('结果文件不能包含计划表');
 return kind;
}

export function parsePortable(text){
 let value;try{value=JSON.parse(text.replace(/^\uFEFF/,''))}catch{throw Error('JSON 无法解析，请选择完整导出的文件')}
 validatePortable(value);return value;
}

export function makePortable(kind,{results=[],plans=[]}={}){
 if(!portableSchemas[kind])throw Error('未知导出类型');
 const value={schema:portableSchemas[kind],kind,createdAt:new Date().toISOString()};
 if(kind==='results'||kind==='bundle')value.results=results;
 if(kind==='plan'||kind==='bundle')value.plans=plans;
 validatePortable(value);return value;
}
