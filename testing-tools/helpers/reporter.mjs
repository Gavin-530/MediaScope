// Structured test events, independent of log language and source formatting.
import path from 'node:path';
import {caseCatalog,project} from './case-catalog.mjs';
const errorValue=e=>e?{name:e.name,message:e.message,code:e.code,stack:e.stack,failureType:e.failureType,actual:e.actual,expected:e.expected,operator:e.operator,cause:errorValue(e.cause)}:undefined;
export default async function* reporter(events) {
  for await (const {type,data} of events) {
    if(!['test:pass','test:fail','test:summary','test:stderr','test:stdout','test:diagnostic'].includes(type))continue;
    const value={...data};
    const id=/^\[([^\]]+)\] /.exec(value.name??'')?.[1];
    const entry=id&&caseCatalog.cases.find(c=>c.id===id);
    if(entry){value.caseId=entry.id;value.name=entry.name;value.file=path.join(project,entry.file);delete value.lineNumber;delete value.columnNumber;}
    if(value.details?.error)value.details={...value.details,error:errorValue(value.details.error)};
    yield JSON.stringify({type,data:value})+'\n';
  }
}
