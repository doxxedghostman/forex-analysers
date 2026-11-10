export interface CachedCandle {
  timestamp: number; open: number; high: number; low: number; close: number; volume?: number;
}
function normalizeCandle(value: unknown): CachedCandle | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const timestamp = Number(raw.timestamp), open = Number(raw.open), high = Number(raw.high);
  const low = Number(raw.low), close = Number(raw.close);
  const volume = raw.volume == null ? undefined : Number(raw.volume);
  if (!Number.isInteger(timestamp) || timestamp <= 0
      || ![open, high, low, close].every(number => Number.isFinite(number) && number > 0)
      || low > Math.min(open, close) || high < Math.max(open, close)
      || (volume != null && (!Number.isFinite(volume) || volume < 0))) return null;
  return { timestamp, open, high, low, close, ...(volume == null ? {} : { volume }) };
}
export function mergeCandleHistory(existing: unknown, incoming: readonly CachedCandle[]): CachedCandle[] {
  const byTimestamp = new Map<number, CachedCandle>();
  if (Array.isArray(existing)) for (const value of existing) {
    const candle = normalizeCandle(value); if (candle) byTimestamp.set(candle.timestamp, candle);
  }
  for (const value of incoming) {
    const candle = normalizeCandle(value); if (candle) byTimestamp.set(candle.timestamp, candle);
  }
  return [...byTimestamp.values()].sort((a,b)=>a.timestamp-b.timestamp);
}
const GRID: Partial<Record<"15m"|"1h"|"4h",number>>={"15m":900,"1h":3600};
export function dropOffGridCandles<T extends {timestamp:number}>(candles:readonly T[],tf:"15m"|"1h"|"4h"):T[]{
  const grid=GRID[tf];return grid?candles.filter(c=>Number.isInteger(c.timestamp)&&c.timestamp%grid===0):[...candles];
}
const RETENTION:Record<"15m"|"1h"|"4h",number>={"15m":31*86400,"1h":93*86400,"4h":93*86400};
export function trimIntradayHistory(candles:readonly CachedCandle[],tf:"15m"|"1h"|"4h"):CachedCandle[]{
  if(!candles.length)return [];
  const cutoff=candles[candles.length-1].timestamp-RETENTION[tf];
  return candles.filter(c=>c.timestamp>=cutoff);
}
export function resampleHourlyToDaily(hourly:readonly CachedCandle[]):CachedCandle[]{
  const valid=hourly.map(normalizeCandle).filter((c):c is CachedCandle=>c!==null).sort((a,b)=>a.timestamp-b.timestamp);
  const days=new Map<number,CachedCandle>();
  for(const c of valid){
    const day=Math.floor(c.timestamp/86400)*86400,current=days.get(day);
    if(!current){days.set(day,{timestamp:day,open:c.open,high:c.high,low:c.low,close:c.close,volume:c.volume??0});continue;}
    current.high=Math.max(current.high,c.high);current.low=Math.min(current.low,c.low);
    current.close=c.close;current.volume=(current.volume??0)+(c.volume??0);
  }
  return [...days.values()].sort((a,b)=>a.timestamp-b.timestamp);
}
export function mergeDailyByUtcDate(existing:unknown,incoming:readonly CachedCandle[]):CachedCandle[]{
  const days=new Map<string,CachedCandle>();
  const key=(timestamp:number)=>new Date(timestamp*1000).toISOString().slice(0,10);
  if(Array.isArray(existing))for(const value of existing){const c=normalizeCandle(value);if(c)days.set(key(c.timestamp),c);}
  for(const value of incoming){const c=normalizeCandle(value);if(c)days.set(key(c.timestamp),c);}
  return [...days.values()].sort((a,b)=>a.timestamp-b.timestamp);
}
