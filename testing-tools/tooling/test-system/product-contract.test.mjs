import {projectTest} from '../../helpers/case-test.mjs';
import assert from '../../helpers/assert.mjs';
import {caseCatalog,selectCases} from '../../helpers/case-catalog.mjs';
import {productContract,validateProduct,assessRequirements,affectedModules,requirementCases} from '../../helpers/product-contract.mjs';
import {completeAssessment,packagedSourceReadiness} from '../../../scripts/test-complete.mjs';
import {createHash} from 'node:crypto';
const test=projectTest(import.meta.url);
test('software contract rejects unbound behavior, interfaces and cases instead of inferring coverage from totals',async()=>{
 const actual=await validateProduct(caseCatalog);assert.ok(actual.sources>0&&actual.requirements>0);
 const contract=structuredClone(productContract);contract.requirements[0].cases.push('not-a-case');await assert.rejects(validateProduct(caseCatalog,{contract}),/Unknown product/);
 const changed=structuredClone(productContract);changed.sources[0].exports.push('unreviewed');await assert.rejects(validateProduct(caseCatalog,{contract:changed}),/Unreviewed product interface/);
 const catalog=structuredClone(caseCatalog);catalog.cases.push({...catalog.cases.find(c=>c.module==='repeat'),id:'repeat.unbound'});await assert.rejects(validateProduct(catalog),/Unbound product case/);
 const partial=assessRequirements({cases:[{id:productContract.requirements[0].cases[0],status:'passed'}]});assert.equal(partial.complete,false);assert.ok(partial.requirements.some(r=>r.status==='not-selected'));
});
test('complete software acceptance requires each independent stage with matching source and package evidence',()=>{
 const identity={source:'a'.repeat(64),harness:'b'.repeat(64),contract:'c'.repeat(64)};
 const stages=productContract.requiredStages.map(r=>({id:r.id,status:'passed',exitCode:0,checks:1,...identity,receiptSha256:'d'.repeat(64),artifactBinding:true,packageSha256:'e'.repeat(64)}));
 assert.equal(completeAssessment(stages,identity).accepted,true);
 for(const mutate of [s=>s.pop(),s=>s.push(s[0]),s=>s[0].skipped=1,s=>s[1].source='other',s=>s[2].receiptSha256=null,s=>s[4].packageSha256='other',s=>s[3].artifactBinding=false,s=>s[3].checks=0,s=>s[0].status='blocked']){const changed=structuredClone(stages);mutate(changed);assert.equal(completeAssessment(changed,identity).accepted,false)}
 // Protocol controls only: source-byte/compiled-input binding, never media oracles.
 const digest=b=>createHash('sha256').update(b).digest('hex'),code=Buffer.from('reviewed source'),bootstrap=Buffer.from('reviewed bootstrap'),binary=Buffer.from('protocol executable');
 const members=new Map([['engine.mjs',code],['scripts/fast-bootstrap.mjs',bootstrap],['scripts/MediaScope.Launcher.exe',binary],['scripts/launcher-build.json',Buffer.from(JSON.stringify({schema:1,fingerprint:'f'.repeat(64),bootstrapHash:digest(bootstrap),executableHash:digest(binary)}))]]);
 const contract={sources:[{file:'engine.mjs',shipment:'source'},{file:'scripts/fast-bootstrap.mjs',shipment:'source'},{file:'scripts/launcher/Launcher.cs',shipment:'build-input'}]},source={files:[{path:'engine.mjs',bytes:code.length,sha256:digest(code)},{path:'scripts/fast-bootstrap.mjs',bytes:bootstrap.length,sha256:digest(bootstrap)}]},options={contract,launcherFingerprint:'f'.repeat(64)};
 assert.equal(packagedSourceReadiness(members,source,options).accepted,true);
 for(const [file,value]of [['engine.mjs',undefined],['engine.mjs',Buffer.from('changed source')],['scripts/MediaScope.Launcher.exe',Buffer.from('changed binary')]]){const changed=new Map(members);value?changed.set(file,value):changed.delete(file);assert.equal(packagedSourceReadiness(changed,source,options).accepted,false)}
 assert.equal(packagedSourceReadiness(members,source,{...options,launcherFingerprint:'0'.repeat(64)}).accepted,false);
});
test('domain and affected selections include their related layers but exclude extensions and unrelated domains',()=>{
 const siti=selectCases({modules:['siti']});assert.ok(siti.cases.some(c=>c.module==='jobs'));assert.ok(siti.cases.some(c=>c.module==='ui'));assert.ok(siti.cases.every(c=>c.covers.includes('siti')));assert.ok(siti.cases.every(c=>!['gpu','native'].includes(c.scope)));
 assert.deepEqual(affectedModules(['repeat.mjs']),['repeat']);
 assert.deepEqual(affectedModules(['testing-tools/extensions/siti.mjs']),[]);
 assert.ok(affectedModules(['unknown.mjs']).includes('test-system'));
 assert.deepEqual(affectedModules(['docs/testing.md']),[]);
 assert.deepEqual(requirementCases(['repeat.samples']),productContract.requirements.find(r=>r.id==='repeat.samples').cases);
 assert.throws(()=>requirementCases(['not-a-requirement']),/Unknown behavior requirement/);
 const bitrate=selectCases({modules:['bitrate']});assert.ok(bitrate.cases.some(c=>c.id==='reports.all-four-actual-report-types-round-trip-without-altering-measureme.606df52f'));
});
