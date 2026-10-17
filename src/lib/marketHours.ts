// Preserve the existing broker-style weekend window. This is fixed UTC, not DST-aware.
export function isForexMarketClosed(now = new Date()): boolean {
  const day = now.getUTCDay(); const hour = now.getUTCHours();
  return day === 6 || (day === 5 && hour >= 22) || (day === 0 && hour < 22);
}
