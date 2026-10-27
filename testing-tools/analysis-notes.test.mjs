import {test} from 'node:test';
import assert from 'node:assert/strict';
import {analysisNotes,analysisNoticeGroups} from '../public/analysis-notes.js';

test('[analysis-notes] unknown and changed messages, resource limits and unconfirmed scenes stay visible without modifying the source',()=>{
  // Text/status contracts only; these are not media measurements or reports.
  const warnings=[analysisNotes.gop,analysisNotes.metadata,'详细码流头解析达到独立资源上限，未完成全流头解析；显示帧、码率及 SI/TI 按各自状态解释。','未来版本的真实警告',analysisNotes.bitrate+'附加限制'];
  const notes=[...analysisNotes.siti,'场景边界未确认，全片结果可能含剪辑点 TI；分场景比较须确认边界。','未识别的历史计算说明','已选择 BWDIF 每帧输出一帧；按输出逐行画面计算，并核验帧数和时间戳。'];
  const input={warnings,content:{notes}},before=structuredClone(input),groups=analysisNoticeGroups(input);
  assert.deepEqual(groups.warnings,warnings.slice(2));
  assert.deepEqual(groups.sitiWarnings,notes.slice(5));
  assert.deepEqual(groups.metadata,[analysisNotes.metadata]);
  assert.deepEqual(input,before);
  assert.deepEqual(analysisNoticeGroups({}).warnings,[]);
});
