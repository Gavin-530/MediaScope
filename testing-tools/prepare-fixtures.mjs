import path from 'node:path';
import {createFixtureStore,fixtures} from './helpers/fixtures.mjs';

const args=process.argv.slice(2);
if(args.length&&!(args.length===2&&args[0]==='--cache'))throw Error('Usage: node testing-tools/prepare-fixtures.mjs [--cache <directory>]');
const store=args.length?createFixtureStore({root:path.resolve(args[1])}):fixtures;
const result=await store.prepareAll();
console.log(`Verified ${result.files} fixed inputs (${result.bytes} bytes): ${store.root}`);
