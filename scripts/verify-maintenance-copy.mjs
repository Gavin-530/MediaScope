import path from 'node:path';
import {verifySnapshot} from './github-archive-store.mjs';
const file=path.resolve(process.argv[2]);
const match=file.match(/^(.*[\\/]revisions[\\/][^\\/]+)[\\/]/);
if(!match)throw Error('Permanent copy is outside a platform revision');
await verifySnapshot(match[1]);
