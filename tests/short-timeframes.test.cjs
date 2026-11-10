const {test}=require('node:test');const assert=require('node:assert/strict');const path=require('node:path');
const {loader,fakeDb,fixture,root}=require('./helpers.cjs');
function shortWindows(now=Date.now()) {
 const bars=fixture()['15m'];
 return Object.fromEntries([['1m',60],['5m',300]].map(([tf,step])=>[tf,bars.map((b,i)=>({
  ...b,timestamp:Math.floor(now/1000/step)*step-(250-i)*step,
 }))]));
}
test('closed short frames require genuine fresh ordered history and enough bars for EMA200',()=>{
 const {validateShortCandles}=loader()(path.join(root,'src/services/shortTimeframeAnalysis.ts'));
 const now=Date.now(),windows=shortWindows(now);
 for(const tf of ['1m','5m'])assert.equal(validateShortCandles(tf,windows[tf],now),windows[tf].at(-1).timestamp);
 assert.throws(()=>validateShortCandles('1m',windows['1m'].slice(-199),now),/200-250/);
 assert.throws(()=>validateShortCandles('1m',windows['1m'].map(c=>({...c,timestamp:c.timestamp-3600})),now),/stale/);
 assert.throws(()=>validateShortCandles('1m',[...windows['1m'].slice(0,-1),{...windows['1m'].at(-1),timestamp:Math.floor(now/60000)*60}],now),/still-open/);
 const invalid=windows['5m'].map(c=>({...c}));invalid[20].high=invalid[20].low/2;
 assert.throws(()=>validateShortCandles('5m',invalid,now),/malformed/);
});
test('both short frames calculate real indicators, structure, patterns and valid-interval setups without HTTP',async()=>{
 const {computeShortTimeframeSnapshot}=loader()(path.join(root,'src/services/analysisEngine.ts'));
 const windows=shortWindows();const oldFetch=global.fetch;global.fetch=async()=>{throw Error('No provider or AI calls allowed');};
 try {
  const result=await computeShortTimeframeSnapshot('EURUSD',windows);
  for(const tf of ['1m','5m']) {
   assert.equal(result.multi_tf[tf].lastClose,windows[tf].at(-1).close);
   assert.ok(Number.isFinite(result.multi_tf[tf].indicators.rsi));
   assert.ok('bos' in result.structure_by_tf[tf]);assert.ok('engulfing' in result.patterns_by_tf[tf]);
   assert.ok(!result.setups[tf].reasoning.includes('Invalid interval'));
   assert.ok(Math.abs(result.setups[tf].live_price-windows[tf].at(-1).close)<=0.000005);
  }
  assert.equal('direction' in result,false);assert.equal('live_price' in result,false);
 }finally{global.fetch=oldFetch;}
});
test('short engine passes the most recently closed bar to pattern detection and closed-bar prediction',async()=>{
 const windows=shortWindows();const patternInputs=[],predictions=[];
 const realPatterns=loader()(path.join(root,'src/services/chartPatterns.ts'));
 const engine=loader({
  './chartPatterns':{...realPatterns,detectChartPatterns:(h,l,c)=>{if(c)patternInputs.push(c);return realPatterns.detectChartPatterns(h,l,c);}},
  './aiPredictor':{predictTrade:async(all,pair,tf,options)=>{predictions.push({tf,options});return {direction:'Neutral'};}},
 })(path.join(root,'src/services/analysisEngine.ts'));
 await engine.computeShortTimeframeSnapshot('EURUSD',windows);
 assert.equal(patternInputs.length,2);assert.equal(patternInputs[0].length,250);assert.equal(patternInputs[1].length,250);
 assert.ok(predictions.every(p=>p.options.candlesClosed===true));
});
function serviceSetup({same=false,stale=false,dryError=false,oneStale=false}={}) {
 const windows=shortWindows(),calls=[];
 if(stale)for(const tf of ['1m','5m'])windows[tf]=windows[tf].map(c=>({...c,timestamp:c.timestamp-3600}));
 if(oneStale)windows['1m']=windows['1m'].map(c=>({...c,timestamp:c.timestamp-3600}));
 const markers=same?Object.fromEntries(['1m','5m'].map(tf=>[tf,windows[tf].at(-1).timestamp])):{};
 const db=fakeDb(q=>({data:q.table==='market_snapshots'?[{pair:'EURUSD',short_analysis_sources:markers,multi_tf:{}}]:[],error:null}));
 db.rpc=async(name,args)=>{calls.push({name,args});return dryError?{data:null,error:{message:'publish unavailable'}}:{data:true,error:null};};
 const service=loader({'../lib/supabaseAdmin':{getSupabaseAdmin:()=>db},'./d1MarketData':{
  getD1CandleBundle:async(pair,tf)=>({pair,timeframe:tf,candles:pair==='EURUSD'?windows[tf]:[],fetchedAt:new Date().toISOString(),sourceCandleAt:null,candleCount:windows[tf]?.length??0}),
  mapWithConcurrency:async(values,_limit,task)=>Promise.all(values.map(task)),
 },'./analysisEngine':{computeShortTimeframeSnapshot:async()=>({multi_tf:{},patterns_by_tf:{},structure_by_tf:{},setups:{}})}})(path.join(root,'src/services/shortTimeframeAnalysis.ts'));
 return {service,calls};
}
test('new Deriv versions publish independently; already-analysed versions cause no candle download',async()=>{
 const active=serviceSetup();const result=await active.service.runPendingShortAnalysis(false);
 assert.equal(result.total,1);assert.equal(result.results[0].published,true);
 assert.deepEqual(active.calls.map(c=>c.name),['publish_short_timeframe_analysis']);
 assert.deepEqual(Object.keys(active.calls[0].args.p_sources),['1m','5m']);
 const same=serviceSetup({same:true});assert.equal((await same.service.runPendingShortAnalysis(false)).total,0);assert.equal(same.calls.length,0);
});
test('shadow mode does not publish and one stale short frame does not block the other',async()=>{
 const shadow=serviceSetup();assert.equal((await shadow.service.runPendingShortAnalysis(true)).succeeded,1);
 assert.equal(shadow.calls.length,0);
 const mixed=serviceSetup({oneStale:true});const result=await mixed.service.runPendingShortAnalysis(false);
 assert.deepEqual(result.results[0].timeframes,['5m']);assert.equal(result.failed.length,0);
 assert.ok(result.unavailable.some(row=>row.pair==='EURUSD'&&row.timeframe==='1m'));
});
test('stale/missing sources are reported without a provider request; failed publishes remain failures',async()=>{
 const stale=serviceSetup({stale:true});const result=await stale.service.runPendingShortAnalysis(false);
 assert.equal(result.total,0);assert.equal(stale.calls.length,0);
 assert.ok(result.unavailable.some(row=>row.pair==='CPPER'&&row.timeframe==='1m'));
 const failure=serviceSetup({dryError:true});assert.equal((await failure.service.runPendingShortAnalysis(false)).failed.length,1);
});
test('all-pending cron performs the short pass even when no longer-frame input is pending',async()=>{
 let calls=0;const db=fakeDb(()=>({data:[],error:null}));
 const service=loader({'../lib/supabaseAdmin':{getSupabaseAdmin:()=>db},'./d1MarketData':{getD1AnalysisInputMetadata:async()=>[]},'./shortTimeframeAnalysis':{
  runPendingShortAnalysis:async dryRun=>{calls++;assert.equal(dryRun,false);return {total:1,failed:[],succeeded:1};},
 }})(path.join(root,'src/services/analysisService.ts'));
 const result=await service.runAllPendingAnalysis(false);
 assert.equal(result.total,0);assert.equal(calls,1);assert.equal(result.shortTimeframes.total,1);
});
