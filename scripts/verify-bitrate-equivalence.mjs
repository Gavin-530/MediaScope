// Compatibility entry; all preparation and recording use the shared runner.
import {spawn} from 'node:child_process';
import {runExtension} from '../testing-tools/extensions/index.mjs';
const args=process.argv.slice(2);
if(args.length===1&&args[0]==='--suite'){const child=spawn(process.execPath,['scripts/test.mjs','--case','bitrate.packet-window-validation'],{stdio:'inherit',windowsHide:true});child.once('error',error=>{console.error(error);process.exitCode=2});child.once('close',code=>process.exitCode=code??2)}
else if(args.length===1)await runExtension(['bitrate-diagnostic','--file',args[0]]);
else throw Error('Use npm test -- --extend bitrate-diagnostic --file <media>, or --module bitrate');
