import {saveMeasurements} from './test-evidence.mjs';
const [generated,evidence]=process.argv.slice(2);
if(!generated||!evidence)throw Error('Expected generated and evidence directories');
console.log(JSON.stringify(await saveMeasurements(generated,evidence,{failed:true})));
