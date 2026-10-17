import assert from 'node:assert/strict';

// Set by the snapshot runner, never inferred from missing DOM or a version string.
export function requireFeature(t,available,description,{historical=process.env.MEDIASCOPE_TEST_SOURCE_KIND==='git'}={}){
  if(available)return true;
  if(historical){t.skip('Not applicable to this historical source: '+description);return false}
  assert.fail('Required current-version feature is missing: '+description);
}

export function supportedThemeModes(declaration,{historical=process.env.MEDIASCOPE_TEST_SOURCE_KIND==='git'}={}){
  const declared=declaration.trim().split(/\s+/);
  return historical?['light','dark'].filter(mode=>declared.includes(mode)):['light','dark'];
}
