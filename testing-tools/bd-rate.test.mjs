import {test} from 'node:test';
import assert from 'node:assert/strict';
import {bdRate} from '../public/bd-rate.js';
import {trialBdRate,rowLabel} from '../public/trial-model.js';

// Explicit mathematical vectors, not measured media. Nonlinear reference answers
// were independently evaluated with SciPy 1.17.1 PchipInterpolator.integrate.
const points = (qualities, rates) => qualities.map((quality, i) => ({quality, rate: rates[i]}));
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} differs from ${b}`);
const linear = [30, 32, 35, 40].map(quality => ({quality, rate: Math.exp(quality / 10)}));
test('[bd-rate] identical, proportional and reversed curves obey analytic results without mutation', () => {
  const anchor = structuredClone(linear), test = anchor.map(p => ({...p, rate: p.rate * .8}));
  const original = JSON.stringify([anchor, test]);
  close(bdRate(anchor, anchor).percent, 0);
  close(bdRate(anchor, test).percent, -20);
  close(bdRate(test, anchor).percent, 25);
  close(bdRate([...anchor].reverse(), test).percent, -20);
  close(bdRate(anchor.map(p => ({...p, rate: p.rate * 1e6})), test.map(p => ({...p, rate: p.rate * 1e6}))).percent, -20);
  assert.equal(JSON.stringify([anchor, test]), original);
  assert.deepEqual(bdRate(anchor, test).warnings, []);
});
test('[bd-rate] two-point lines and three-point PCHIP calculate with sparse-sampling warnings', () => {
  for (const count of [2,3]) {
    const anchor = linear.slice(0,count), candidate = anchor.map(p => ({...p,rate:p.rate*.8})),
      result = bdRate(anchor,candidate);
    assert.equal(result.ok,true);close(result.percent,-20);close(bdRate(candidate,anchor).percent,25);
    assert.deepEqual(result.pointCounts,[count,count]);
    assert.match(result.warnings[0],new RegExp(`采样稀疏：基准组 ${count} 点，对比组 ${count} 点`));
  }
  const mixed = bdRate(points([30,40],[1,20]),points([31,34,41],[1.2,3,18]));
  assert.equal(mixed.ok,true);close(mixed.percent,-14.86021871140441);
  assert.deepEqual(mixed.qualityRange,[31,40]);assert.deepEqual(mixed.pointCounts,[2,3]);
  const three = bdRate(points([30,33,40],[1,2,20]),points([31,35,41],[1.1,5,22]));
  close(three.percent,22.4938240853289);
  for (const [a,b] of [[linear.slice(0,2),linear],[linear,linear.slice(0,3)]])
    assert.match(bdRate(a,b).warnings[0],/采样稀疏/);
});
test('[bd-rate] PCHIP matches FAU-LMS example and independent SciPy nonlinear partial-overlap vectors', () => {
  // FAU-LMS/bjontegaard README example; method here is PCHIP, not README's Akima.
  const result = bdRate(points([40.037,38.615,36.845,34.851], [9487.76,4593.60,2486.44,1358.24]),
    points([40.121,38.651,36.970,34.987], [9787.80,4469.00,2451.52,1356.24]));
  assert.equal(result.ok, true);close(result.percent, -4.417485350589112);
  assert.deepEqual(result.qualityRange, [34.987,40.037]);
  const unequal = bdRate(points([30,31,33,40], [1,1.01,4,20]), points([30.5,32,34,36,41], [.8,2,5,8,25]));
  close(unequal.percent, -14.950875369163914);assert.deepEqual(unequal.pointCounts, [4,5]);
  close(unequal.coverage[0], .95);close(unequal.coverage[1], 9.5/10.5);
  const clipped = bdRate(points([0,1,2,3], [1,1.01,2,10]), points([.25,1.25,2.25,3.25], [.9,1.5,5,12]));
  close(clipped.percent, 37.6845368340335);
});
test('[bd-rate] ITU-T HSTP-VID-WPOM table 1 reproduces the common PSNR interval and PCHIP result', () => {
  // Official table 1, rounded printed values. This recomputation is not a result
  // claimed by ITU; independent SciPy integration yields -37.47148438998018%.
  const result=bdRate(points([40.19,39.44,38.42,36.90],[29419.76,8876.16,4564.60,2551.37]),
    points([40.38,39.70,38.86,37.54],[28020.45,7622.83,3661.62,1979.02]));
  assert.equal(result.ok,true);assert.deepEqual(result.qualityRange,[37.54,40.19]);
  close(result.percent,-37.47148438998018);
});
test('[bd-rate] quality affine transforms and uneven sampling preserve an analytic log-linear curve', () => {
  const test = [31,32.5,34,36,39,41].map(quality => ({quality, rate: .7*Math.exp(quality/10)}));
  close(bdRate(linear, test).percent, -30);
  close(bdRate(linear.map(p => ({...p, quality: p.quality * 8 + 50})), test.map(p => ({...p, quality: p.quality * 8 + 50}))).percent, -30);
  assert.deepEqual(bdRate(linear, test).qualityRange, [31,40]);
});
test('[bd-rate] insufficient, missing, infinite, duplicate and nonmonotonic samples are refused without dropping points', () => {
  for (const bad of [null, [], linear.slice(0,1), linear.map((p,i) => i ? p : {...p,quality:'Infinity'}),
    linear.map((p,i) => i ? p : {...p,quality:null}), linear.map((p,i) => i ? p : {...p,rate:0}),
    linear.map((p,i) => i ? p : {...p,rate:NaN}), linear.map((p,i) => i === 1 ? {...p,quality:30} : p),
    linear.map((p,i) => i === 1 ? {...p,rate:1} : p), linear.map((p,i) => i === 1 ? {...p,rate:linear[0].rate} : p)]) {
    const result = bdRate(bad, linear);assert.equal(result.ok, false);assert.ok(result.reason);
  }
  assert.match(bdRate(linear,linear.slice(0,1)).reason,/对比组至少需要 2 个/);
  for (const shift of [10,11]) assert.equal(bdRate(linear, linear.map(p => ({...p,quality:p.quality+shift}))).ok, false);
});
test('[bd-rate] trial PSNR, SSIM dB and VMAF use pooled quality and video-only bitrate', () => {
  // Constructed rows test the adapter's definition only; browser tests encode real media.
  const rows = [0,1].flatMap(group => [10,20,30,40].map((q,i) => ({bitDepth:8,preset:group?'fast':'medium',crf:40-i*6,
    videoMbps:Math.exp(q/10)*(group?.8:1), metrics:{psnr:{pooled:q},ssim:{pooled:1-10**(-q/10)},vmaf:{pooled:q,model:'vmaf_v0.6.1'}}})));
  const a = rowLabel(rows[0]), b = rowLabel(rows[4]);
  for (const metric of ['psnr','ssim','vmaf']) {
    const result = trialBdRate(rows,a,b,metric);assert.equal(result.ok,true);close(result.percent,-20);
    assert.equal(result.metric,metric);
  }
  assert.match(trialBdRate(rows,a,b,'ssim').qualityDomain,/log10/);
  assert.equal(trialBdRate(rows,a,a,'psnr').ok,false);
  assert.match(trialBdRate(rows,a,a,'psnr').reason,/当前基准组与对比组相同/);
  assert.match(trialBdRate(rows.slice(0,4),a,a,'psnr').reason,/当前报告只有一组/);
  assert.equal(trialBdRate(rows,a,b,'other').ok,false);
  const saturated = structuredClone(rows);saturated[0].metrics.ssim.pooled=1;
  assert.equal(trialBdRate(saturated,a,b,'ssim').ok,false);
  const missing = structuredClone(rows);delete missing[0].metrics.psnr;
  assert.equal(trialBdRate(missing,a,b,'psnr').ok,false);
  const models = structuredClone(rows);models[0].metrics.vmaf.model='vmaf_4k_v0.6.1';
  assert.equal(trialBdRate(models,a,b,'vmaf').ok,false);
});
