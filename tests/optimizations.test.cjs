const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {loader,fixture,fakeDb,root}=require('./helpers.cjs');
const service=name=>path.join(root,'src/services',name+'.ts');
function closedWindows(){
 const base=fixture()['15m'];const now=Math.floor(Date.now()/1000);
 return Object.fromEntries([['1m',60],['5m',300]].map(([tf,step])=>[tf,base.map((c,i)=>({...c,timestamp:Math.floor(now/step)*step-(250-i)*step}))]));
}
// Frozen original implementation: exact arithmetic/order, intentionally
// retaining its repeated work as an independent numeric regression oracle.
function originalAdx(ohlc,period=14){
 const sum=(a,p)=>a.map((_,i)=>i<p-1?NaN:a.slice(i-p+1,i+1).reduce((a,b)=>a+b,0));
 const mean=(a,p)=>a.map((_,i)=>i<p-1?NaN:a.slice(i-p+1,i+1).reduce((a,b)=>a+b,0)/p);
 const last=a=>a[a.length-1];
 if(ohlc.length<period+1)return {adx:null,plusDi:null,minusDi:null};
 const high=ohlc.map(c=>c.high),low=ohlc.map(c=>c.low),close=ohlc.map(c=>c.close),tr=[],plus=[],minus=[];
 for(let i=1;i<high.length;i++){
  tr.push(Math.max(high[i]-low[i],Math.abs(high[i]-close[i-1]),Math.abs(low[i]-close[i-1])));
  const up=high[i]-high[i-1],down=low[i-1]-low[i];
  plus.push(up>down&&up>0?up:0);minus.push(down>up&&down>0?down:0);
 }
 const totals=sum(tr,period),p=totals.map((t,i)=>100*(sum(plus,period)[i]/t)),m=totals.map((t,i)=>100*(sum(minus,period)[i]/t));
 const dx=p.map((v,i)=>v+m[i]===0?NaN:Math.abs(v-m[i])/(v+m[i])*100);
 const result={adx:last(mean(dx,period)),plusDi:last(p),minusDi:last(m)};
 return Object.fromEntries(Object.entries(result).map(([k,v])=>[k,isNaN(v)?null:v]));
}
test('ADX preserves exact original numeric output across histories, flat bars and periods',()=>{
 const {calculateAdxDi}=loader()(service('marketAnalyzer'));
 for(const base of [1.1,150,2400])for(const n of [0,10,15,28,250,400])for(const period of [7,14,21]){
  const bars=fixture(base)['1d'].slice(0,n);
  assert.deepEqual(calculateAdxDi(bars,period),originalAdx(bars,period));
 }
 const flat=Array.from({length:250},()=>({open:10,high:10,low:10,close:10}));
 assert.deepEqual(calculateAdxDi(flat),originalAdx(flat));
});
test('bounded candle cache detects old-bar corrections and volume changes; callers cannot poison results',()=>{
 const {createCandleCalculationCache}=loader()(service('candleCalculationCache'));
 const cached=createCandleCalculationCache(2);let calls=0;
 const calculate=()=>({nested:{value:++calls}}),bars=fixture()['15m'];
 const first=cached('one',bars,calculate);first.nested.value=999;
 assert.equal(cached('one',structuredClone(bars),calculate).nested.value,1);
 const correction=structuredClone(bars);correction[5].high+=0.001;
 cached('one',correction,calculate);assert.equal(calls,2);
 correction[5].volume++;cached('one',correction,calculate);assert.equal(calls,3);
 cached('two',bars,calculate);cached('three',bars,calculate);
 cached('one',correction,calculate);assert.equal(calls,6);
});
test('warm frame reuse preserves the entire output and invalidates only changed candle windows',async()=>{
 const calls=[],real=loader()(service('marketAnalyzer'));
 const engine=loader({'./marketAnalyzer':{...real,computeIndicators:bars=>{calls.push(bars.length);return real.computeIndicators(bars);}}})(service('analysisEngine'));
 const bars=fixture();
 const first=await engine.computeSnapshot('EURUSD','core',bars);delete first.updated_at;
 assert.equal(calls.length,4);
 const second=await engine.computeSnapshot('EURUSD','core',structuredClone(bars));delete second.updated_at;
 assert.deepEqual(second,first);assert.equal(calls.length,4);
 second.multi_tf['1h'].indicators.rsi=-100;
 const third=await engine.computeSnapshot('EURUSD','core',bars);delete third.updated_at;
 assert.deepEqual(third,first);
 bars['1h'][5].high+=0.01;
 const changed=await engine.computeSnapshot('EURUSD','core',bars);delete changed.updated_at;
 assert.equal(calls.length,5);
 const cold=await loader()(service('analysisEngine')).computeSnapshot('EURUSD','core',bars);delete cold.updated_at;
 assert.deepEqual(changed,cold);
});
test('short-only calculation preserves unchanged-frame alignment and recomputes setups for new higher context',async()=>{
 const windows=closedWindows(),engine=loader()(service('analysisEngine'));
 const higher={'1d':{rsi:70,ema_200:1,macd:1,macd_signal:0},'4h':{rsi:60},'1h':{rsi:60}};
 const full=await engine.computeShortTimeframeSnapshot('EURUSD',windows,higher);
 const partial=await engine.computeShortTimeframeSnapshot('EURUSD',{'1m':windows['1m']},higher,windows);
 for(const key of ['multi_tf','structure_by_tf','patterns_by_tf','setups']){
  assert.deepEqual(partial[key]['1m'],full[key]['1m']);assert.equal('5m' in partial[key],false);
 }
 const newHigher={'1d':{rsi:20,ema_200:2,macd:-1,macd_signal:0},'4h':{rsi:20},'1h':{rsi:20}};
 const warm=await engine.computeShortTimeframeSnapshot('EURUSD',windows,newHigher);
 const cold=await loader()(service('analysisEngine')).computeShortTimeframeSnapshot('EURUSD',windows,newHigher);
 assert.deepEqual(warm,cold);
});
test('short service reads D1 windows and skips a published 5m frame while retaining its context for a new 1m source',async()=>{
 const windows=closedWindows(),calls=[],computed=[];
 const markers={'5m':windows['5m'].at(-1).timestamp};
 const db=fakeDb(q=>({data:q.table==='market_snapshots'?[{pair:'EURUSD',short_analysis_sources:markers,multi_tf:{}}]:[],error:null}));
 db.rpc=async(name,args)=>{calls.push({name,args});return {data:true,error:null};};
 const analysis=loader({'../lib/supabaseAdmin':{getSupabaseAdmin:()=>db},'./d1MarketData':{
  getD1CandleBundle:async(pair,tf)=>({pair,timeframe:tf,candles:pair==='EURUSD'?windows[tf]:[],fetchedAt:new Date().toISOString(),sourceCandleAt:null,candleCount:windows[tf]?.length??0}),
  mapWithConcurrency:async(values,_limit,task)=>Promise.all(values.map(task)),
 },'./analysisEngine':{computeShortTimeframeSnapshot:async(...args)=>{computed.push(args);return {};}}})(service('shortTimeframeAnalysis'));
 const result=await analysis.runPendingShortAnalysis(false);
 assert.equal(result.failed.length,0);assert.deepEqual(Object.keys(computed[0][1]),['1m']);
 assert.deepEqual(Object.keys(computed[0][3]),['1m','5m']);
 assert.deepEqual(Object.keys(calls.at(-1).args.p_sources),['1m']);
});
test('pending batch reuses publication markers and leaves the final database version check in place',async()=>{
 const row={pair:'EURUSD',tier:'core',fetched_at:new Date().toISOString(),candles:fixture()},reads=[],writes=[],short=[];
 const db=fakeDb(q=>{reads.push(q);return {data:{analysis_input_at:null},error:null};});
 db.rpc=async(name,args)=>{writes.push({name,args});return {data:false,error:null};};
 const analysis=loader({'../lib/supabaseAdmin':{getSupabaseAdmin:()=>db},'./d1MarketData':{
  getD1AnalysisInputMetadata:async()=>[{pair:'EURUSD',tier:'core',fetched_at:row.fetched_at}],
  getD1AnalysisInput:async()=>row,
 },'./analysisEngine':{computeSnapshot:async()=>({tier:'core'})},'./shortTimeframeAnalysis':{runPendingShortAnalysis:async(...args)=>{short.push(args);return {failed:[]};}}})(service('analysisService'));
 const result=await analysis.runAllPendingAnalysis(false);
 assert.equal(result.failed.length,0);assert.equal(result.results[0].skipped,true);
 assert.equal(reads.filter(q=>q.table==='market_snapshots').length,1);
 assert.deepEqual(short[0][2],[{analysis_input_at:null}]);assert.equal(writes[0].name,'publish_market_analysis_from_d1');
 assert.equal(writes[0].args.p_input_at,row.fetched_at);
});
