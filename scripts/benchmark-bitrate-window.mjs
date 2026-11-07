// Compatibility entry for the shared parameterized developer tool.
import {runExtension} from '../testing-tools/extensions/index.mjs';
await runExtension(['bitrate-performance',...process.argv.slice(2)]);
