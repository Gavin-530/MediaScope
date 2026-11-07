import {projectTest} from '../../helpers/case-test.mjs';
const test=projectTest(import.meta.url);
import assert from '../../helpers/assert.mjs';
import {timingSummary, formatElapsedSeconds} from '../../../public/timing.js';

test('result totals use task time without double-counting concurrent stages or inventing missing time', () => {
  const summary = timingSummary([
    {computeSeconds: 10, stages: [{elapsedSeconds: 8, concurrentGroup: 'parallel'}, {elapsedSeconds: 7, concurrentGroup: 'parallel'}]},
    {computeSeconds: 0}, {computeSeconds: 2.5}, undefined, {computeSeconds: -1}, {computeSeconds: '5'},
  ]);
  assert.equal(summary.totalComputeSeconds, 12.5);
  assert.equal(summary.recordedResults, 3);
  assert.equal(summary.missingResults, 3);
  assert.equal(timingSummary([undefined]).totalComputeSeconds, null);
  assert.equal(formatElapsedSeconds(null), '未记录');
  assert.equal(formatElapsedSeconds(0), '0.00 秒');
  assert.equal(formatElapsedSeconds(3661), '1 小时 1 分 1 秒');
});
