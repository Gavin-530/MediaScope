// Compatibility entry: explicit developer selection; no implicit workloads.
import {runExtension} from './extensions/index.mjs';
await runExtension(process.argv.slice(2));
