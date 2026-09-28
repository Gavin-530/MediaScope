import {validateReport} from './report.js';

export const portableSchema='MediaScope/0.3';
const earlierUnifiedSchema='MediaScopePortable/1';
export const legacyPortableSchemas={results:'MediaScopeResults/1',plan:'MediaScopePlan/1',bundle:'MediaScopeBundle/1'};
export const maxPortableBytes=256*1024*1024;

const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const entryId=value=>typeof value==='string'&&value.length>0&&value.length<=128;

function checkEntries(items,key){
  if(!Array.isArray(items)||items.length>10000)throw Error(key+' 必须是最多 10000 项的数组');
  const ids=new Set();
  items.forEach((item,i)=>{
   if(!object(item)||!entryId(item.entryId)||ids.has(item.entryId))throw Error(`${key}[${i}] 的编号缺失或重复`);
   ids.add(item.entryId);
   if(key==='results')validateReport(item.report);
   else if(!object(item.input)||!['inspect','analyze','compare','trial'].includes(item.input.type))throw Error(`${key}[${i}] 的任务参数无效`);
  });
}

export function validatePortable(value){
 if(!object(value))throw Error('文件顶层必须是对象');
 if(value.schema!==portableSchema)throw Error('不支持的导入文件版本或类型：'+String(value.schema??'未提供'));
 if(value.kind!==undefined)throw Error('统一格式不使用文件类型字段');
 if(typeof value.createdAt!=='string'||!Number.isFinite(Date.parse(value.createdAt)))throw Error('文件缺少有效的创建时间');
 checkEntries(value.results,'results');checkEntries(value.plans,'plans');
 return value;
}

function normalizeLegacy(value){
 if(['MediaScope/0.1','MediaScope/0.2'].includes(value.schema)){
  validateReport(value);
  return makePortable({results:[{entryId:'legacy-report',report:value}]});
 }
 const kind=Object.keys(legacyPortableSchemas).find(key=>legacyPortableSchemas[key]===value.schema);
 if(!kind)throw Error('不支持的导入文件版本或类型：'+String(value.schema??'未提供'));
 if(value.kind!==kind)throw Error('文件类型与版本标识不一致');
 if(typeof value.createdAt!=='string'||!Number.isFinite(Date.parse(value.createdAt)))throw Error('文件缺少有效的创建时间');
 if(kind==='results'||kind==='bundle')checkEntries(value.results,'results');
 else if(value.results!==undefined)throw Error('计划文件不能包含结果表');
 if(kind==='plan'||kind==='bundle')checkEntries(value.plans,'plans');
 else if(value.plans!==undefined)throw Error('结果文件不能包含计划表');
 return makePortable({createdAt:value.createdAt,results:value.results??[],plans:value.plans??[]});
}

export function parsePortable(text){
 let value;try{value=JSON.parse(text.replace(/^\uFEFF/,''))}catch{throw Error('JSON 无法解析，请选择完整导出的文件')}
 if(!object(value))throw Error('文件顶层必须是对象');
 if(value.schema===portableSchema)return validatePortable(value);
 if(value.schema===earlierUnifiedSchema){
  const updated={...value,schema:portableSchema};
  return validatePortable(updated);
 }
 return normalizeLegacy(value);
}

export function makePortable({createdAt=new Date().toISOString(),results=[],plans=[]}={}){
 const value={schema:portableSchema,createdAt,results,plans};
 validatePortable(value);return value;
}
