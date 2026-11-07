import path from 'node:path';
import {createFixtureStore,fixtures,maintenanceFixtures,maintenanceLock} from './helpers/fixtures.mjs';

const args=process.argv.slice(2),names=[];let cache,scope='formal';
while(args.length){const flag=args.shift(),value=args.shift();if(!value||value.startsWith('--'))throw Error('Expected option value');if(flag==='--cache'&&!cache)cache=value;else if(flag==='--input')names.push(value);else if(flag==='--scope'&&['formal','maintenance'].includes(value))scope=value;else throw Error('Unknown fixture preparation option: '+flag)}
const store=cache?createFixtureStore({root:path.resolve(cache),...(scope==='maintenance'?{entries:maintenanceLock.files}:{})}):scope==='maintenance'?maintenanceFixtures:fixtures;
const result=await store.prepareAll(names.length?[...new Set(names)]:undefined);
console.log(`Verified ${result.files} fixed inputs (${result.bytes} bytes): ${store.root}`);
