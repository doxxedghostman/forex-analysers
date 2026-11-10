const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {loader,root}=require('./helpers.cjs');

const higher=loader()(path.join(root,'src/services/higherTimeframes.ts'));
const at=day=>Date.parse(day+'T00:00:00Z')/1000;
const bar=(day,open,high,low,close)=>({timestamp:at(day),open,high,low,close,volume:100});

test('weekly aggregation uses Monday UTC calendar weeks and closed periods only',()=>{
 const daily=[
  bar('2026-11-02',10,12,9,11),
  bar('2026-11-03',11,15,10,12),
  bar('2026-11-06',12,13,8,9),
  bar('2026-11-09',9,10,7,8),
 ];
 const result=higher.aggregateDailyCandles(daily,'1w',Date.parse('2026-11-10T12:00:00Z'));
 assert.equal(result.length,2);
 assert.deepEqual(
  {timestamp:result[0].timestamp,open:result[0].open,high:result[0].high,low:result[0].low,close:result[0].close,dailyCount:result[0].dailyCount,complete:result[0].complete},
  {timestamp:at('2026-11-02'),open:10,high:15,low:8,close:9,dailyCount:3,complete:true}
 );
 assert.equal(result[1].complete,false);
});

test('monthly aggregation follows UTC calendar months, not rolling 30-day windows',()=>{
 const result=higher.aggregateDailyCandles([
  bar('2026-01-30',100,105,90,102),
  bar('2026-02-02',102,115,101,110),
  bar('2026-02-27',110,118,107,117),
  bar('2026-03-02',117,119,115,118),
 ],'1mo',Date.parse('2026-03-15T00:00:00Z'));
 assert.deepEqual(result.map(x=>x.timestamp),[at('2026-01-01'),at('2026-02-01'),at('2026-03-01')]);
 assert.deepEqual(
  {open:result[1].open,high:result[1].high,low:result[1].low,close:result[1].close,dailyCount:result[1].dailyCount,complete:result[1].complete},
  {open:102,high:118,low:101,close:117,dailyCount:2,complete:true}
 );
 assert.equal(result[2].complete,false);
});

test('aggregation sorts, deduplicates, and rejects malformed or future daily candles',()=>{
 const rows=[
  bar('2026-11-04',4,8,2,6),
  bar('2026-11-02',3,5,1,4),
  bar('2026-11-02',3,6,1,5),
  bar('2026-11-05',100,60,50,55),
  bar('2026-11-12',5,6,4,5),
 ];
 const result=higher.aggregateDailyCandles(rows,'1w',Date.parse('2026-11-06T12:00:00Z'));
 assert.equal(result.length,1);
 assert.deepEqual(
  {open:result[0].open,high:result[0].high,low:result[0].low,close:result[0].close,dailyCount:result[0].dailyCount},
  {open:3,high:8,low:1,close:6,dailyCount:2}
 );
});

test('missing trading days do not create synthetic weekly or monthly candles',()=>{
 const daily=[bar('2026-01-05',4,5,3,4),bar('2026-04-01',4,6,2,5)];
 assert.equal(higher.aggregateDailyCandles(daily,'1w',Date.parse('2026-05-01T00:00:00Z')).length,2);
 assert.equal(higher.aggregateDailyCandles(daily,'1mo',Date.parse('2026-05-01T00:00:00Z')).length,2);
});

test('higher-timeframe summaries exclude the current forming period',()=>{
 const daily=[
  bar('2026-11-02',10,15,8,11),
  bar('2026-11-06',11,13,9,12),
  bar('2026-11-09',1000,2000,999,1500),
 ];
 const summary=higher.summarizeHigherTimeframe(daily,'1w',Date.parse('2026-11-10T12:00:00Z'));
 assert.equal(summary.lastClose,12);
 assert.equal(summary.lastClosed.high,15);
 assert.equal(summary.closedCandles,1);
 assert.equal(summary.indicatorHistorySufficient,false);
 assert.equal(summary.supportCandidate,null);
 assert.equal(higher.summarizeHigherTimeframe([bar('2026-11-09',1,2,.9,1.5)],'1w',Date.parse('2026-11-10T12:00:00Z')),null);
});

test('13 completed monthly periods expose OHLC context but do not invent indicators',()=>{
 const daily=Array.from({length:405},(_,i)=>{
  const date=new Date(Date.UTC(2025,9,1+i));
  const price=1.1+i*.0001;
  return {timestamp:date.getTime()/1000,open:price,high:price+.001,low:price-.001,close:price+.0005};
 });
 const summary=higher.summarizeHigherTimeframe(daily,'1mo',Date.parse('2026-11-10T12:00:00Z'));
 assert.ok(summary);
 assert.equal(summary.indicatorHistorySufficient,false);
 assert.deepEqual(summary.indicators,{});
 assert.equal(summary.latestClosedPeriodStart,'2026-10-01T00:00:00.000Z');
 assert.equal(summary.derivedFrom,'1d');
});

test('long saved daily history enables weekly and monthly indicators',()=>{
 const daily=Array.from({length:1461},(_,i)=>{
  const date=new Date(Date.UTC(2022,0,1+i));
  const price=10+i/100;
  return {timestamp:date.getTime()/1000,open:price,high:price+1,low:price-1,close:price+.2,volume:100+i%30};
 });
 const summary=higher.summarizeHigherTimeframe(daily,'1mo',Date.parse('2026-01-15T00:00:00Z'));
 assert.ok(summary);
 assert.ok(summary.closedCandles>=35);
 assert.equal(summary.indicatorHistorySufficient,true);
 assert.equal(typeof summary.indicators.ema_20,'number');
});

test('weekly compatibility summary now uses calendar weeks and completed-week statistics',()=>{
 const summary=higher.computeWeeklyTrend([
  bar('2026-11-02',10,15,8,11),
  bar('2026-11-06',11,13,9,12),
  bar('2026-11-09',12,14,10,13),
 ],Date.parse('2026-11-10T12:00:00Z'));
 assert.equal(summary.weekCount,1);
 assert.equal(summary.weeks[0].weekStart,'2026-11-02T00:00:00.000Z');
 assert.equal(summary.weeks[0].complete,true);
 assert.equal(summary.weeks[1].complete,false);
 assert.equal(summary.recentSummary.lastNWeeks,1);
});
