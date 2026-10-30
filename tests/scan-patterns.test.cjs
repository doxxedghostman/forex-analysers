const {test}=require('node:test');const assert=require('node:assert/strict');const path=require('node:path');
const {loader,root}=require('./helpers.cjs');
const {detectChartPatterns,CHART_PATTERN_VERSION}=loader()(path.join(root,'src/services/chartPatterns.ts'));
const candles=(n=24)=>Array.from({length:n},(_,i)=>({timestamp:1700000000+i*3600,close:1.095}));
const swing=(index,price,type)=>({index,time:1700000000+index*3600,price,type});
const highs=[swing(10,1.1,'high'),swing(20,1.1001,'high')];const lows=[swing(15,1.09,'low')];
test('recent intact formations remain detectable, without a price-probability interpretation',()=>{
 assert.equal(CHART_PATTERN_VERSION,2);assert.equal(detectChartPatterns(highs,lows,candles()).double_top.detected,true);
 const hs=[swing(15,1.11,'high')],ls=[swing(10,1.09,'low'),swing(20,1.0901,'low')];
 assert.equal(detectChartPatterns(hs,ls,candles()).double_bottom.detected,true);
});
test('old pivots and missing candle context cannot become current patterns',()=>{
 assert.equal(detectChartPatterns(highs,lows,candles(250)).double_top.detected,false);
 assert.equal(detectChartPatterns(highs,lows).double_top.detected,false);
 assert.equal(detectChartPatterns(highs,lows,candles(26)).double_top.detected,true);
 assert.equal(detectChartPatterns(highs,lows,candles(27)).double_top.detected,false);
});
test('a close through either top/bottom invalidates the pattern even if price later returns',()=>{
 const c=candles();c[21].close=1.101;
 assert.equal(detectChartPatterns(highs,lows,c).double_top.detected,false);
 const hs=[swing(15,1.11,'high')],ls=[swing(10,1.09,'low'),swing(20,1.0901,'low')];
 c[21].close=1.08;assert.equal(detectChartPatterns(hs,ls,c).double_bottom.detected,false);
});
test('head-and-shoulders and its inverse expire and invalidate at the head',()=>{
 const hs=[swing(10,1.1,'high'),swing(15,1.12,'high'),swing(20,1.1,'high')];
 const ls=[swing(12,1.08,'low'),swing(18,1.08,'low')];
 const c=candles();assert.equal(detectChartPatterns(hs,ls,c).head_and_shoulders.detected,true);
 c[22].close=1.121;assert.equal(detectChartPatterns(hs,ls,c).head_and_shoulders.detected,false);
 const inverseHighs=ls.map(x=>({...x,price:2-x.price,type:'high'}));
 const inverseLows=hs.map(x=>({...x,price:2-x.price,type:'low'}));
 const inverseCandles=candles().map(x=>({...x,close:2-x.close}));
 assert.equal(detectChartPatterns(inverseHighs,inverseLows,inverseCandles).inverse_head_and_shoulders.detected,true);
 inverseCandles[22].close=0.879;
 assert.equal(detectChartPatterns(inverseHighs,inverseLows,inverseCandles).inverse_head_and_shoulders.detected,false);
});
test('misaligned pivots, non-finite closes and invalid prices are rejected',()=>{
 const c=candles();c[20].timestamp++;
 assert.equal(detectChartPatterns(highs,lows,c).double_top.detected,false);
 c[20].timestamp--;c[22].close=NaN;
 assert.equal(detectChartPatterns(highs,lows,c).double_top.detected,false);
 assert.equal(detectChartPatterns([{...highs[0],price:NaN},highs[1]],lows,candles()).double_top.detected,false);
});
test('snapshot generation marks validated patterns and keeps the forming candle out of pattern detection',async()=>{
 const seen=[];const base=loader()(path.join(root,'src/services/chartPatterns.ts'));
 const {computeSnapshot}=loader({
  './chartPatterns':{...base,detectChartPatterns:(h,l,c=[])=>{if(c.length)seen.push(c);return base.detectChartPatterns(h,l,c);}},
 })(path.join(root,'src/services/analysisEngine.ts'));
 const {fixture}=require('./helpers.cjs');const windows=fixture();
 const result=await computeSnapshot('EURUSD','core',windows);
 assert.equal(seen.length,4);
 for(const [index,tf]of ['15m','1h','4h','1d'].entries()){
  assert.equal(result.multi_tf[tf].patternVersion,2);
  assert.equal(seen[index].length,windows[tf].length-1);
  assert.equal(seen[index].at(-1).timestamp,windows[tf].at(-2).timestamp);
 }
});
