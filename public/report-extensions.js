const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const unsafe=key=>['__proto__','prototype','constructor'].includes(key);
const requirements=new Set(['table/1','repeat/1','repeat/2','frame-digest/1']);

// Optional metadata is preserved as JSON data and never executed or interpreted as a method.
export function validateReportMetadata(value){
  const seen=new Set();let nodes=0;
  function visit(item,depth){
    if(++nodes>10000||depth>16)throw Error('扩展元数据超过结构预算');
    if(item===null||typeof item==='string'||typeof item==='boolean'||typeof item==='number'&&Number.isFinite(item))return;
    if(typeof item!=='object'||seen.has(item))throw Error('扩展元数据必须是无循环的 JSON 数据');
    if(!Array.isArray(item)&&![Object.prototype,null].includes(Object.getPrototypeOf(item)))throw Error('扩展元数据对象类型无效');
    const keys=Object.keys(item);
    if(keys.length>10000||Object.getOwnPropertySymbols(item).length)throw Error('扩展元数据超过结构预算或包含不能保存的属性');
    if(Array.isArray(item)){
      if(Object.getPrototypeOf(item)!==Array.prototype||item.length>10000||keys.length!==item.length||Object.getOwnPropertyNames(item).length!==item.length+1)throw Error('扩展元数据数组无效');
      for(let i=0;i<item.length;i++)if(!Object.hasOwn(item,i))throw Error('扩展元数据包含稀疏数组');
    }else if(Object.getOwnPropertyNames(item).length!==keys.length)throw Error('扩展元数据包含不能保存的属性');
    seen.add(item);
    for(const key of keys){const property=Object.getOwnPropertyDescriptor(item,key);if(unsafe(key)||!Object.hasOwn(property,'value'))throw Error('扩展元数据包含保留键或访问器');visit(property.value,depth+1);}
    seen.delete(item);
  }
  if(!object(value))throw Error('扩展元数据必须是对象');
  visit(value,0);
}

export function validateReportRequirements(value){
  if(!Array.isArray(value)||value.length>64||new Set(value).size!==value.length)throw Error('文件必需能力列表无效');
  for(const id of value)if(!requirements.has(id))throw Error('不支持的文件必需能力：'+String(id));
}

export function reportRequirements(results,declared=[]){
  validateReportRequirements(declared);const needed=new Set(declared);
  for(const {report}of results){
    if(report.requires!==undefined){validateReportRequirements(report.requires);for(const id of report.requires)needed.add(id);}
    if(report.repeatAnalysis){needed.add('repeat/'+report.repeatAnalysis.configurationVersion);if(report.repeatAnalysis.fingerprint)needed.add('frame-digest/1');}
  }
  return [...needed].sort();
}
