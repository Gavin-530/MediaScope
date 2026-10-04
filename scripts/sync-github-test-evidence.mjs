import path from 'node:path';
import {fileURLToPath} from 'node:url';
export function artifactIdentity(artifact){
  const match=artifact.name?.match(/^mediascope-test-evidence-([1-9][0-9]*)-([1-9][0-9]*)$/);
  if(!match)return null;
  if(String(artifact.workflow_run?.id)!==match[1])throw Error('Artifact/run identity mismatch');
  if(!/^[a-f0-9]{40}$/.test(artifact.workflow_run.head_sha))throw Error('Artifact commit identity missing');
  return {runId:match[1],attempt:match[2],sha:artifact.workflow_run.head_sha};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2);
  if(args.includes('--automatic'))console.log('Automatic GitHub archive sync is disabled; use npm run github:sync explicitly.');
  else{
    console.log('evidence:sync now delegates to github:sync; cloud records are stored in github-archive.');
    const {main}=await import('./github-archive.mjs');
    await main(['sync',...args]).catch(error=>{console.error('GitHub archive: '+error.message);process.exitCode=1});
  }
}