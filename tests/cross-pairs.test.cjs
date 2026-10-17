const {test}=require('node:test');const assert=require('node:assert/strict');const path=require('node:path');
const {loader,fixture,root}=require('./helpers.cjs');
const load=loader();const config=load(path.join(root,'src/services/snapshotConfig.ts'));const {computeSnapshot}=load(path.join(root,'src/services/analysisEngine.ts'));
test('analysis covers all 23 instruments once with the same eight tier IDs as the collector',()=>{
 assert.deepEqual(Object.keys(config.TIER_CONFIG),['core','extended_a','extended_b','extended_c','extended_d','extended_e','extended_f','extended_g']);
 const assigned=Object.values(config.TIER_CONFIG).flatMap(tier=>tier.pairs);
 assert.equal(assigned.length,23);assert.equal(new Set(assigned).size,23);assert.deepEqual(new Set(assigned),new Set(config.ALL_PAIRS));
});
for(const pair of 'EURJPY EURGBP AUDJPY EURAUD GBPAUD EURCHF CADJPY CHFJPY AUDCAD NZDJPY'.split(' ')){
 test(pair+' analysis produces all four timeframe setups without provider requests',async()=>{
  const original=global.fetch;let requests=0;global.fetch=async()=>{requests++;throw Error('Analysis may not fetch market candles');};
  try{
   const tier=Object.entries(config.TIER_CONFIG).find(([,value])=>value.pairs.includes(pair))[0];
   const snapshot=await computeSnapshot(pair,tier,fixture(pair.endsWith('JPY')?150:1.1));
   assert.equal(snapshot.pair,pair);assert.equal(snapshot.tier,tier);
   assert.deepEqual(Object.keys(snapshot.setups),['15m','1h','4h','1d']);
   assert.deepEqual(Object.keys(snapshot.multi_tf),['15m','1h','4h','1d']);
   assert.equal(requests,0);
  }finally{global.fetch=original;}
 });
}
