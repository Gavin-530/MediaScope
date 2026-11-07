import {readFixture} from '../../../helpers/fixtures.mjs';
import {createHash} from 'node:crypto';
import assert from '../../../helpers/assert.mjs';

// Frozen independent descriptor/known-byte oracle. Do not regenerate from product code.
export const SITI_LAYOUT_ORACLE_SHA256='ed2bef0b5049cd5eba82933fb211b855482ab45a42e1c1bb4678e38a3298b9de';
export async function independentSitiLayouts(){
  const bytes=await readFixture('layout-reference.json');
  assert.equal(createHash('sha256').update(bytes).digest('hex'),SITI_LAYOUT_ORACLE_SHA256,'Independent SI/TI fixture changed');
  const data=JSON.parse(bytes);
  assert.equal(data.schema,1);assert.equal(data.cases.length,900);assert.equal(new Set(data.cases.map(c=>c.format)).size,150);
  return data;
}
