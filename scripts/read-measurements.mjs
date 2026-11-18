import {readFile} from 'node:fs/promises';
import {decodeMeasurements} from '../testing-tools/helpers/measurement-codec.mjs';

const [file,option]=process.argv.slice(2);
if(!file||process.argv.length>4||(option&&option!=='--check')){
  throw Error('Usage: node scripts/read-measurements.mjs <measurements.json.gz> [--check]');
}
const measurements=decodeMeasurements(await readFile(file));
if(!option)process.stdout.write(JSON.stringify(measurements,null,2)+'\n');
