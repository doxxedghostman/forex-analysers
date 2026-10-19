const {test}=require('node:test');const assert=require('node:assert/strict');const path=require('node:path');
const {loader,fixture,fakeDb,root}=require('./helpers.cjs');
const input=(candles=fixture())=>({pair:'EURUSD',tier:'core',fetched_at:new Date().toISOString(),candles});
const validation=loader()(path.join(root,'src/services/analysisInputs.ts'));
test('input validation rejects missing, stale, future, malformed and partial bundles',()=>{
 const good=input();assert.equal(validation.validateAnalysisInput(good,'EURUSD','core')['1h'].length,250);
 for(const bad of [null,{...good,tier:'extended_c'},{...good,fetched_at:'invalid'},
  {...good,fetched_at:new Date(Date.now()-20*60000).toISOString()},
  {...good,fetched_at:new Date(Date.now()+5*60000).toISOString()},
  {...good,candles:{...good.candles,'4h':[]}},
  {...good,candles:{...good.candles,'15m':[{...good.candles['15m'][0],close:NaN},...good.candles['15m'].slice(1)]}}])
  assert.throws(()=>validation.validateAnalysisInput(bad,'EURUSD','core'));
});
test('provider staleness is detected on a weekday despite a new fetch timestamp',()=>{
 const now=Date.parse('2026-10-16T14:00:00Z');const good=input();good.fetched_at=new Date(now).toISOString();
 for(const tf of Object.keys(good.candles))good.candles[tf]=good.candles[tf].map((c,i,arr)=>({...c,timestamp:now/1000-10*86400-(arr.length-i)*900}));
 assert.throws(()=>validation.validateAnalysisInput(good,'EURUSD','core',now),/Provider candles are stale/);
});
for(const [pair,tier,base] of [['EURUSD','core',1.1],['USDJPY','core',150],['CPPER','extended_c',4.5],['PLTUM','extended_c',1000]]){
 test('saved-input analysis preserves legacy snapshot output for '+pair,async()=>{
  const candles=fixture(base);let oldSnapshot;let networkCalls=0;
  const db=fakeDb(q=>{
   if(q.table==='market_snapshots'&&q.operation==='upsert')oldSnapshot=q.payload;
   if(q.operation!=='select')return {data:null,error:null};
   if(q.table==='market_snapshots')return {data:{live_price:base},error:null};
   if(q.table==='market_candle_cache')return {data:['15m','1h','4h'].map(timeframe=>({timeframe,candles:[],history_backfilled_at:new Date().toISOString()})),error:null};
   return {data:{candles:[]},error:null};
  });
  const mocks={};
  mocks['./marketData']={fetchOHLCV:async(_pair,tf)=>candles[tf],fetchHistoricalOHLCV:async()=>{throw Error('unexpected backfill');}};
  mocks['../lib/supabaseAdmin']={getSupabaseAdmin:()=>db};mocks['./alertService']={checkAlertsForPair:async()=>{}};
  for(const module of ['marketAnalyzer','smcAnalysis','structureBridge','chartPatterns','analysisTypes','snapshotConfig'])
   mocks['./'+module]=loader()(path.join(root,'src/services',module+'.ts'));
  mocks['../lib/candleCacheMerge']=loader()(path.resolve(root,'../forex-cron/src/lib/candleCacheMerge.ts'));
  mocks['./aiPredictor']=loader(mocks)(path.join(root,'tests/fixtures/legacyPredictor.fixture.ts'));
  const legacy=loader(mocks)(path.join(root,'tests/fixtures/legacySnapshot.fixture.ts'));
  const originalFetch=global.fetch;global.fetch=async()=>{networkCalls++;throw Error('No provider requests allowed');};
  // Avoid the fixture's scheduling sleeps; analysis math and ordering stay intact.
  const realTimeout=global.setTimeout;global.setTimeout=(f,_ms,...args)=>realTimeout(f,0,...args);
  try{
   assert.equal((await legacy.runSnapshotForPair(pair,tier)).ok,true);
   const engine=loader()(path.join(root,'src/services/analysisEngine.ts'));
   const fresh=await engine.computeSnapshot(pair,tier,candles);
   delete fresh.updated_at;delete oldSnapshot.updated_at;
   assert.deepEqual(JSON.parse(JSON.stringify(fresh)),JSON.parse(JSON.stringify(oldSnapshot)));
   assert.equal(networkCalls,0);
  }finally{global.fetch=originalFetch;global.setTimeout=realTimeout;}
 });
}
test('shadow run never publishes; active run excludes live prices and uses input version',async()=>{
 const row=input();let publishes=[];const db=fakeDb(q=>({data:q.table==='market_analysis_inputs'?row:{analysis_input_at:null},error:null}));
 db.rpc=async(name,args)=>{publishes.push({name,args});return {data:true,error:null};};
 const service=loader({'../lib/supabaseAdmin':{getSupabaseAdmin:()=>db}})(path.join(root,'src/services/analysisService.ts'));
 assert.equal((await service.analysePair('EURUSD','core')).dryRun,true);assert.equal(publishes.length,0);
 assert.equal((await service.analysePair('EURUSD','core',false)).published,true);
 assert.equal(publishes[0].args.p_input_at,row.fetched_at);
 for(const key of ['live_price','price_updated_at','price_source','updated_at'])assert.equal(key in publishes[0].args.p_analysis,false);
});
test('already analysed and stale inputs do not calculate or publish',async()=>{
 let row=input();let computed=0;const db=fakeDb(q=>({data:q.table==='market_analysis_inputs'?row:{analysis_input_at:row.fetched_at},error:null}));
 const service=loader({'../lib/supabaseAdmin':{getSupabaseAdmin:()=>db},'./analysisEngine':{computeSnapshot:async()=>{computed++;throw Error('should not compute');}}})(path.join(root,'src/services/analysisService.ts'));
 assert.equal((await service.analysePair('EURUSD','core',false)).skipped,true);
 row={...row,fetched_at:'2020-01-01T00:00:00Z'};assert.equal((await service.analysePair('EURUSD','core',false)).ok,false);assert.equal(computed,0);
});
test('cron routes require a secret, validate tiers, default to shadow, and honour dryRun',async()=>{
 const {NextRequest}=require('next/server');const calls=[];const route=loader({'@/services/analysisService':{runAnalysisBatch:async(...args)=>{calls.push(args);return {failed:[]};}}})(path.join(root,'src/app/api/cron/analyse/route.ts'));
 const env={...process.env};process.env.CRON_SECRET='test-secret';delete process.env.ANALYSIS_MODE;
 const req=(query='',secret='test-secret')=>new NextRequest('https://example.test/api/cron/analyse?force=1&'+query,{headers:{'x-cron-secret':secret}});
 try{
  assert.equal((await route.GET(req('tier=core','wrong'))).status,401);
  assert.equal((await route.GET(req('tier=__proto__'))).status,400);
  assert.equal((await route.GET(req('tier=core'))).status,200);assert.deepEqual(calls.at(-1),['core',true]);
  process.env.ANALYSIS_MODE='active';await route.GET(req('tier=core'));assert.deepEqual(calls.at(-1),['core',false]);
  await route.GET(req('tier=core&dryRun=1'));assert.deepEqual(calls.at(-1),['core',true]);
  process.env.ANALYSIS_MODE='bad';assert.equal((await route.GET(req('tier=core'))).status,503);
 }finally{process.env=env;}
});
test('sentiment shadow run fetches its sources without writing; active saves the same score',async()=>{
 const writes=[];const db=fakeDb(q=>{
  if(q.operation==='upsert'){writes.push(q);return {data:null,error:null};}
  if(q.table==='market_snapshots')return {data:[{pair:'EURUSD',direction:'Long',confidence_score:80,updated_at:new Date().toISOString()}],error:null};
  return {data:{cot_fetched_at:new Date().toISOString(),components:{cot:{score:60,status:'fresh',fetchedAt:new Date().toISOString()}}},error:null};
 });
 const service=loader({'@/lib/supabaseAdmin':{getSupabaseAdmin:()=>db}})(path.join(root,'src/services/marketSentimentService.ts'));
 const original=global.fetch;let requests=[];global.fetch=async url=>{requests.push(url);return {ok:true,headers:{get:()=> 'application/json'},json:async()=>({chart:{result:[{meta:{regularMarketPrice:18,regularMarketTime:Math.floor(Date.now()/1000)},indicators:{quote:[{close:[17,17,17,17,17,18,18]}]}}]}})};};
 try{
  const shadow=await service.refreshMarketSentiment(true);assert.equal(writes.length,0);assert.equal(shadow.dryRun,true);
  const active=await service.refreshMarketSentiment(false);assert.equal(writes.length,1);assert.equal(active.score,shadow.score);
  assert.equal(writes[0].table,'market_sentiment');assert.ok(requests.some(url=>url.includes('DX-Y.NYB')));assert.ok(requests.some(url=>url.includes('%5EVIX')));
 }finally{global.fetch=original;}
});

test('accepts small real-world Yahoo daily FX boundary mismatches without mutating saved candles',()=>{
 const now=Date.now(), candles=fixture();
 const original={...candles['1d'][40]};
 // Measured Yahoo daily FX row from Dec 2025: low slightly above close.
 candles['1d'][40]={...original,open:1.1628988981246948,high:1.1675832271575928,
   low:1.1628177165985107,close:1.1627906560897827};
 const row=input(candles);
 const copy=JSON.parse(JSON.stringify(row.candles['1d'][40]));
 const windows=validation.validateAnalysisInput(row,'EURUSD','core',now);
 assert.deepEqual(row.candles['1d'][40],copy);
 assert.notStrictEqual(windows['1d'][40],row.candles['1d'][40]);
 assert.equal(windows['1d'][40].low,windows['1d'][40].close);
 assert.equal(windows['1d'][40].high,copy.high);
 assert.equal(windows['15m'],candles['15m']);
 assert.equal(windows['1h'],candles['1h']);
 assert.equal(windows['4h'],candles['4h']);
});
test('rejects large daily FX deviations, excessive range-relative changes, and malformed intraday candles',()=>{
 const now=Date.now(), good=fixture();
 const build=(tf,index,bar)=>({ ...input(), candles: {...good, [tf]: good[tf].map((c,i)=>i===index?bar:c)} });
 const original=good['1d'][40];
 assert.throws(()=>validation.validateAnalysisInput(build('1d',40,{
   ...original,high:original.open*0.8
 }), 'EURUSD','core',now),/Malformed or unordered/);
 assert.throws(()=>validation.validateAnalysisInput(build('1d',40,{
   ...original,open:100,close:100.09,high:100.07,low:100
 }), 'EURUSD','core',now),/Malformed or unordered/);
 const minute=good['15m'][40];
 assert.throws(()=>validation.validateAnalysisInput(build('15m',40,{
   ...minute,high:Math.max(minute.open,minute.close)-0.00001
 }), 'EURUSD','core',now),/Malformed or unordered/);
});
test('never normalizes invalid metals, non-finite daily prices or inverted ranges',()=>{
 const now=Date.now(), base=fixture();
 function bad(tf,change){const bars={...base,[tf]:base[tf].map((b,i)=>i===40?{...b,...change}:b)};
  return {pair:'XAUUSD',tier:'core',fetched_at:new Date(now).toISOString(),candles:bars};}
 const gold=base['1d'][40];
 assert.throws(()=>validation.validateAnalysisInput(
  bad('1d',{high:Math.max(gold.open,gold.close)-0.00001}),'XAUUSD','core',now
 ),/Malformed or unordered/);
 const fx={...input(base),candles:{...base,'1d':base['1d'].map((b,i)=>i===40?{...b,high:NaN}:b)}};
 assert.throws(()=>validation.validateAnalysisInput(fx,'EURUSD','core',now),/Malformed or unordered/);
 const reversed={...input(base),candles:{...base,'1d':base['1d'].map((b,i)=>i===40?{...b,high:b.low-0.001}:b)}};
 assert.throws(()=>validation.validateAnalysisInput(reversed,'EURUSD','core',now),/Malformed or unordered/);
});

test('recovers an unanalysed recent input from another tier without Yahoo requests',async()=>{
 const pending={pair:'NZDUSD',tier:'extended_b',fetched_at:new Date().toISOString(),candles:fixture()};
 const done={pair:'GBPUSD',tier:'core',fetched_at:new Date().toISOString()};
 const writes=[];let providerCalls=0;
 const db=fakeDb(q=>{
  if(q.table==='market_analysis_inputs'){
   if(q.filters.length)return {data:pending,error:null};
   return {data:[{pair:pending.pair,tier:pending.tier,fetched_at:pending.fetched_at},done],error:null};
  }
  if(q.table==='market_snapshots'){
   if(q.filters.length)return {data:{analysis_input_at:null},error:null};
   return {data:[{pair:done.pair,analysis_input_at:done.fetched_at}],error:null};
  }
  return {data:null,error:null};
 });
 db.rpc=async(name,args)=>{writes.push({name,args});return {data:true,error:null};};
 const service=loader({'../lib/supabaseAdmin':{getSupabaseAdmin:()=>db},'./analysisEngine':{
  computeSnapshot:async()=>({tier:'extended_b',direction:'Long',confidence_score:70,live_price:1.2,updated_at:new Date().toISOString()})
 }})(path.join(root,'src/services/analysisService.ts'));
 const original=global.fetch;global.fetch=async()=>{providerCalls++;throw Error('No Yahoo');};
 try {
  const results=await service.recoverPendingAnalysis('core');
  assert.equal(results.length,1);assert.equal(results[0].pair,'NZDUSD');
  assert.equal(results[0].published,true);assert.equal(providerCalls,0);
  assert.equal(writes.length,1);assert.equal(writes[0].name,'publish_market_analysis');
 }finally{global.fetch=original;}
});
