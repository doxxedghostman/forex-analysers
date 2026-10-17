// --- TYPES & INTERFACES ---
export interface Candle {
    timestamp?: number;
    t?: string | number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume?: number;
}

export interface IndicatorReport {
    sma_20: number | null;
    ema_20: number | null;
    ema_200: number | null;
    hull_ma_21: number | null;
    kama_10: number | null;
    tema_20: number | null;
    vwap: number | null;
    psar: number | null;
    rsi: number | null;
    cci: number | null;
    roc_10: number | null;
    williams_r: number | null;
    momentum: number | null;
    stoch_k: number | null;
    stoch_d: number | null;
    macd: number | null;
    macd_signal: number | null;
    macd_trend: string;
    atr: number | null;
    bb_upper: number | null;
    bb_lower: number | null;
    bb_signal: string;
    keltner_upper: number | null;
    keltner_lower: number | null;
    donchian_upper: number | null;
    donchian_lower: number | null;
    chandelier_exit: number | null;
    obv: number;
    mfi: number | null;
    cmf_20: number | null;
    volume_oscillator: number;
    supertrend: 'BUY' | 'SELL' | 'NEUTRAL';
    market_structure: string;
    bos_signal: string;
    recent_high: number | null;
    recent_low: number | null;
    ichimoku_base: number | null;
    ichimoku_conv: number | null;
    span_a: number | null;
    span_b: number | null;
    adx: number | null;
    di_plus: number | null;
    di_minus: number | null;
    support_levels_all: number[];
    resistance_levels_all: number[];
    support_levels: number[];
    resistance_levels: number[];
}

// --- UTILITY MATRICES ---
function safeFloat(value: any): number | null {
    if (value === null || value === undefined || isNaN(value) || !isFinite(value)) return null;
    return parseFloat(value);
}

// Rolling window helpers (actually used throughout this file — unlike the
// earlier unused version, every one of these is called below)
function rollingMax(arr: number[], period: number): number[] {
    return arr.map((_, i) => (i < period - 1 ? NaN : Math.max(...arr.slice(i - period + 1, i + 1))));
}
function rollingMin(arr: number[], period: number): number[] {
    return arr.map((_, i) => (i < period - 1 ? NaN : Math.min(...arr.slice(i - period + 1, i + 1))));
}
function rollingMean(arr: number[], period: number): number[] {
    return arr.map((_, i) => {
        if (i < period - 1) return NaN;
        const slice = arr.slice(i - period + 1, i + 1);
        return slice.reduce((a, b) => a + b, 0) / period;
    });
}
function rollingSum(arr: number[], period: number): number[] {
    return arr.map((_, i) => (i < period - 1 ? NaN : arr.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0)));
}
function last(arr: number[]): number {
    return arr[arr.length - 1];
}

// --- MATH ENGINES (core) ---

export function calculateSma(closes: number[], window: number): number | null {
    if (closes.length < window) return null;
    const sum = closes.slice(-window).reduce((a, b) => a + b, 0);
    return sum / window;
}

export function calculateEma(closes: number[], window: number): number | null {
    if (closes.length < window) return null;
    const alpha = 2 / (window + 1);
    let currentEma = closes.slice(0, window).reduce((a, b) => a + b, 0) / window;
    for (let i = window; i < closes.length; i++) {
        currentEma = (closes[i] - currentEma) * alpha + currentEma;
    }
    return currentEma;
}

// Continuous EMA seeded with the first value — matches pandas' ewm(adjust=False)
// behavior used for TEMA/Keltner in the Python original.
function continuousEma(data: number[], period: number): number[] {
    const alpha = 2 / (period + 1);
    const out: number[] = [data[0]];
    for (let i = 1; i < data.length; i++) {
        out.push((data[i] - out[i - 1]) * alpha + out[i - 1]);
    }
    return out;
}

export function calculateRsi(closes: number[], period = 14): number | null {
    if (closes.length < period + 1) return null;
    const deltas: number[] = [];
    for (let i = 1; i < closes.length; i++) deltas.push(closes[i] - closes[i - 1]);

    let gains = deltas.map(d => d > 0 ? d : 0);
    let losses = deltas.map(d => d < 0 ? -d : 0);

    let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
    let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;

    if (avgLoss === 0) return 100.0;

    for (let i = period; i < deltas.length; i++) {
        avgGain = (avgGain * (period - 1) + gains[i]) / period;
        avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
    }

    if (avgLoss === 0) return 100.0;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
}

export function calculateMacd(closes: number[], fast = 12, slow = 26, signal = 9) {
    if (closes.length < slow) return { trend: "Not enough data", macd: null, signal: null, slope: null };

    const fastEma: number[] = [];
    const slowEma: number[] = [];

    let fEma = closes[0];
    let sEma = closes[0];
    const fAlpha = 2 / (fast + 1);
    const sAlpha = 2 / (slow + 1);

    for (let i = 0; i < closes.length; i++) {
        fEma = (closes[i] - fEma) * fAlpha + fEma;
        sEma = (closes[i] - sEma) * sAlpha + sEma;
        fastEma.push(fEma);
        slowEma.push(sEma);
    }

    const macdLine = fastEma.map((f, i) => f - slowEma[i]);
    const validMacd = macdLine.slice(slow - 1);

    if (validMacd.length < signal) return { trend: "Not enough data", macd: null, signal: null, slope: null };

    let sigEma = validMacd.slice(0, signal).reduce((a, b) => a + b, 0) / signal;
    const sigAlpha = 2 / (signal + 1);
    const signalLine: number[] = new Array(slow - 1 + signal - 1).fill(NaN);
    signalLine.push(sigEma);

    for (let i = signal; i < validMacd.length; i++) {
        sigEma = (validMacd[i] - sigEma) * sigAlpha + sigEma;
        signalLine.push(sigEma);
    }

    const latestMacd = macdLine[macdLine.length - 1];
    const latestSignal = signalLine[signalLine.length - 1];

    let slope = macdLine[macdLine.length - 1] - macdLine[macdLine.length - 2];
    let trend = "Neutral";
    if (latestMacd > latestSignal) trend = "Bullish crossover";
    if (latestMacd < latestSignal) trend = "Bearish crossover";

    const normSlope = slope / Math.max(Math.abs(latestMacd), 1.0);

    return { trend, macd: latestMacd, signal: latestSignal, slope: normSlope };
}

export function calculateBollingerBands(closes: number[], period = 20, stdDev = 2) {
    if (closes.length < period) return { upper: null, middle: null, lower: null, width: null, signal: "N/A" };
    const prices = closes.slice(-period);
    const mean = prices.reduce((a, b) => a + b, 0) / period;
    const variance = prices.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / period;
    const std = Math.sqrt(variance);

    const upper = mean + stdDev * std;
    const lower = mean - stdDev * std;
    const width = upper - lower;
    const latest = closes[closes.length - 1];

    let signal = "Neutral";
    if (latest > upper) signal = "Overbought";
    else if (latest < lower) signal = "Oversold";

    return { upper, middle: mean, lower, width, signal };
}

export function calculateCci(ohlc: Candle[], period = 20): number | null {
    if (ohlc.length < period) return null;
    const typicalPrices = ohlc.map(c => (c.high + c.low + c.close) / 3);

    const slice = typicalPrices.slice(-period);
    const sma = slice.reduce((a, b) => a + b, 0) / period;
    const mad = slice.reduce((a, b) => a + Math.abs(b - sma), 0) / period;

    if (mad === 0) return 0;
    const lastTp = typicalPrices[typicalPrices.length - 1];
    return (lastTp - sma) / (0.015 * mad);
}

export function calculateAtr(ohlc: Candle[], period = 14): number | null {
    if (ohlc.length < period + 1) return null;
    const trs: number[] = [];
    for (let i = 1; i < ohlc.length; i++) {
        const tr = Math.max(
            ohlc[i].high - ohlc[i].low,
            Math.abs(ohlc[i].high - ohlc[i - 1].close),
            Math.abs(ohlc[i].low - ohlc[i - 1].close)
        );
        trs.push(tr);
    }
    const tail = trs.slice(-period);
    return tail.reduce((a, b) => a + b, 0) / period;
}

export function calculateSupertrend(ohlc: Candle[], period = 10, multiplier = 3): number {
    if (ohlc.length < period) return 0;
    const hl2 = ohlc.map(c => (c.high + c.low) / 2.0);

    const trs = ohlc.map((c, i) => {
        if (i === 0) return c.high - c.low;
        return Math.max(c.high - c.low, Math.abs(c.high - ohlc[i - 1].close), Math.abs(c.low - ohlc[i - 1].close));
    });

    const atr: number[] = [];
    let sum = trs.slice(0, period).reduce((a, b) => a + b, 0);
    atr.push(sum / period);
    for (let i = period; i < trs.length; i++) {
        sum = sum - trs[i - period] + trs[i];
        atr.push(sum / period);
    }

    const upperband = hl2.map((h, i) => i < period - 1 ? NaN : h + multiplier * atr[i - period + 1]);
    const lowerband = hl2.map((h, i) => i < period - 1 ? NaN : h - multiplier * atr[i - period + 1]);
    const inUptrend = new Array(ohlc.length).fill(true);

    for (let i = period; i < ohlc.length; i++) {
        const prev = i - 1;
        const currClose = ohlc[i].close;

        if (currClose > upperband[prev]) inUptrend[i] = true;
        else if (currClose < lowerband[prev]) inUptrend[i] = false;
        else {
            inUptrend[i] = inUptrend[prev];
            if (inUptrend[i] && lowerband[i] < lowerband[prev]) lowerband[i] = lowerband[prev];
            if (!inUptrend[i] && upperband[i] > upperband[prev]) upperband[i] = upperband[prev];
        }
    }
    return inUptrend[inUptrend.length - 1] ? 1 : -1;
}

export function detectMarketStructure(candles: Candle[], lookback = 20) {
    if (candles.length < lookback + 5) return { structure: "Syncing", signal: "Scanning..." };

    const closes = candles.map(c => c.close);
    const highs = candles.map(c => c.high);
    const lows = candles.map(c => c.low);

    const prevHighs = highs.slice(-(lookback + 5), -5);
    const prevLows = lows.slice(-(lookback + 5), -5);

    const confirmedHigh = Math.max(...prevHighs);
    const confirmedLow = Math.min(...prevLows);

    const lastClose = closes[closes.length - 1];
    const prevClose = closes[closes.length - 2];

    let structure = "Range";
    let signal = "Scanning...";

    if (lastClose > confirmedHigh) {
        structure = "Uptrend";
        signal = "BOS ↑ (Bullish Break)";
    } else if (lastClose < confirmedLow) {
        structure = "Downtrend";
        signal = "BOS ↓ (Bearish Break)";
    }

    if (prevClose < confirmedLow && lastClose > confirmedHigh) {
        structure = "Uptrend";
        signal = "CHoCH ↑ (Reversal Up)";
    } else if (prevClose > confirmedHigh && lastClose < confirmedLow) {
        structure = "Downtrend";
        signal = "CHoCH ↓ (Reversal Down)";
    }

    return { structure, recent_high: confirmedHigh, recent_low: confirmedLow, signal };
}

export function detectSupportResistance(candles: Candle[], lookback = 50, sensitivity = 3) {
    const highs = candles.map(c => c.high);
    const lows = candles.map(c => c.low);
    const levels: { support: number[]; resistance: number[] } = { support: [], resistance: [] };

    const boundary = Math.min(lookback, candles.length - sensitivity);

    for (let i = sensitivity; i < boundary - sensitivity; i++) {
        const lowSlice = lows.slice(i - sensitivity, i + sensitivity + 1);
        if (lows[i] === Math.min(...lowSlice)) levels.support.push(lows[i]);

        const highSlice = highs.slice(i - sensitivity, i + sensitivity + 1);
        if (highs[i] === Math.max(...highSlice)) levels.resistance.push(highs[i]);
    }

    levels.support = Array.from(new Set(levels.support)).sort((a, b) => a - b);
    levels.resistance = Array.from(new Set(levels.resistance)).sort((a, b) => a - b);
    return levels;
}

export function calculateVwap(ohlc: Candle[]): number | null {
    if (!ohlc || ohlc.length < 1) return null;
    let cumTpVol = 0;
    let cumVol = 0;
    for (const c of ohlc) {
        const tp = (c.high + c.low + c.close) / 3;
        const vol = c.volume || 0;
        cumTpVol += tp * vol;
        cumVol += vol;
    }
    return cumVol === 0 ? ohlc[ohlc.length - 1].close : cumTpVol / cumVol;
}

export function calculateWilliamsR(ohlc: Candle[], period = 14): number | null {
    if (ohlc.length < period) return null;
    const slice = ohlc.slice(-period);
    const highestHigh = Math.max(...slice.map(c => c.high));
    const lowestLow = Math.min(...slice.map(c => c.low));
    const denom = highestHigh - lowestLow;
    if (denom === 0) return 0;
    return -100 * (highestHigh - ohlc[ohlc.length - 1].close) / denom;
}

// --- MATH ENGINES (extended — ported from full indicators.py) ---

export function calculateRoc(closes: number[], period = 10): number | null {
    if (closes.length <= period) return null;
    const past = closes[closes.length - 1 - period];
    const curr = closes[closes.length - 1];
    if (past === 0) return null;
    return ((curr - past) / past) * 100;
}

export function calculateMomentum(closes: number[], period = 10): number | null {
    if (closes.length <= period) return null;
    const startPrice = closes[closes.length - 1 - period];
    const endPrice = closes[closes.length - 1];
    if (!startPrice || !isFinite(startPrice)) return null;
    return ((endPrice - startPrice) / startPrice) * 100;
}

export function calculateHullMa(closes: number[], period = 21): number | null {
    const halfLength = Math.floor(period / 2);
    const sqrtLength = Math.floor(Math.sqrt(period));
    const wmaHalf = rollingMean(closes, halfLength);
    const wmaFull = rollingMean(closes, period);
    const rawHull = wmaHalf.map((h, i) => 2 * h - wmaFull[i]);
    const hull = rollingMean(rawHull, sqrtLength);
    const val = last(hull);
    return isNaN(val) ? null : val;
}

export function calculateTema(closes: number[], period = 20): number | null {
    if (closes.length < period) return null;
    const ema1 = continuousEma(closes, period);
    const ema2 = continuousEma(ema1, period);
    const ema3 = continuousEma(ema2, period);
    const tema = ema1.map((e1, i) => 3 * e1 - 3 * ema2[i] + ema3[i]);
    return last(tema);
}

export function calculateKama(closes: number[], period = 10): number | null {
    if (closes.length <= period) return null;
    const kama: number[] = [closes[0]];
    for (let i = 1; i < closes.length; i++) {
        const change = i >= period ? Math.abs(closes[i] - closes[i - period]) : NaN;
        // volatility = sum of abs diffs over the period window
        let volatility = 0;
        for (let j = Math.max(1, i - period + 1); j <= i; j++) {
            volatility += Math.abs(closes[j] - closes[j - 1]);
        }
        const er = volatility === 0 ? 0 : change / volatility;
        const sc = Math.pow((isNaN(er) ? 0 : er) * (2 / 3 - 2 / 31) + 2 / 31, 2);
        kama.push(kama[i - 1] + sc * (closes[i] - kama[i - 1]));
    }
    return last(kama);
}

export function calculateParabolicSar(ohlc: Candle[], step = 0.02, maxStep = 0.2): number | null {
    if (ohlc.length < 2) return null;
    const highs = ohlc.map(c => c.high);
    const lows = ohlc.map(c => c.low);

    const psar: number[] = [lows[0]];
    let uptrend = true;
    let af = step;
    let ep = highs[0];

    for (let i = 1; i < highs.length; i++) {
        const prevPsar = psar[psar.length - 1];
        let psarVal = prevPsar + af * (ep - prevPsar);
        psar.push(psarVal);

        if (uptrend) {
            if (lows[i] < psarVal) {
                uptrend = false;
                psar[psar.length - 1] = ep;
                af = step;
                ep = lows[i];
            } else if (highs[i] > ep) {
                ep = highs[i];
                af = Math.min(af + step, maxStep);
            }
        } else {
            if (highs[i] > psarVal) {
                uptrend = true;
                psar[psar.length - 1] = ep;
                af = step;
                ep = highs[i];
            } else if (lows[i] < ep) {
                ep = lows[i];
                af = Math.min(af + step, maxStep);
            }
        }
    }
    return last(psar);
}

export function calculateStochastic(ohlc: Candle[], kPeriod = 14, dPeriod = 3): { k: number | null; d: number | null } {
    if (ohlc.length < kPeriod) return { k: null, d: null };
    const closes = ohlc.map(c => c.close);
    const highs = ohlc.map(c => c.high);
    const lows = ohlc.map(c => c.low);

    const kValues: number[] = [];
    for (let i = kPeriod - 1; i < closes.length; i++) {
        const lowMin = Math.min(...lows.slice(i - kPeriod + 1, i + 1));
        const highMax = Math.max(...highs.slice(i - kPeriod + 1, i + 1));
        const denom = highMax - lowMin;
        kValues.push(denom === 0 ? 50.0 : (100 * (closes[i] - lowMin)) / denom);
    }

    const dValues = rollingMean(kValues, dPeriod);
    const dLast = last(dValues);

    return { k: last(kValues), d: isNaN(dLast) ? null : dLast };
}

export function calculateDonchian(ohlc: Candle[], period = 20): { upper: number | null; lower: number | null } {
    if (ohlc.length < period) return { upper: null, lower: null };
    const highs = ohlc.map(c => c.high);
    const lows = ohlc.map(c => c.low);
    return {
        upper: last(rollingMax(highs, period)),
        lower: last(rollingMin(lows, period)),
    };
}

export function calculateKeltnerChannels(ohlc: Candle[], period = 20): { upper: number | null; lower: number | null } {
    if (ohlc.length < period) return { upper: null, lower: null };
    const typicalPrices = ohlc.map(c => (c.high + c.low + c.close) / 3);
    const ema = continuousEma(typicalPrices, period);
    const tr = ohlc.map(c => c.high - c.low);
    const atr = rollingMean(tr, period);
    const emaLast = last(ema);
    const atrLast = last(atr);
    if (isNaN(atrLast)) return { upper: null, lower: null };
    return { upper: emaLast + 2 * atrLast, lower: emaLast - 2 * atrLast };
}

export function calculateChandelierExit(ohlc: Candle[], period = 22, multiplier = 3): number | null {
    if (ohlc.length < period) return null;
    const highs = ohlc.map(c => c.high);
    const tr = ohlc.map(c => c.high - c.low);
    const atr = last(rollingMean(tr, period));
    const highestHigh = last(rollingMax(highs, period));
    if (isNaN(atr) || isNaN(highestHigh)) return null;
    return highestHigh - atr * multiplier;
}

export function calculateObv(ohlc: Candle[]): number {
    const closes = ohlc.map(c => c.close);
    const volumes = ohlc.map(c => c.volume || 0);
    let obv = 0;
    for (let i = 1; i < closes.length; i++) {
        if (closes[i] > closes[i - 1]) obv += volumes[i];
        else if (closes[i] < closes[i - 1]) obv -= volumes[i];
    }
    return obv;
}

export function calculateMfi(ohlc: Candle[], period = 14): number | null {
    if (ohlc.length < period + 1) return null;
    const typicalPrices = ohlc.map(c => (c.high + c.low + c.close) / 3);
    const volumes = ohlc.map(c => c.volume || 0);
    const moneyFlow = typicalPrices.map((tp, i) => tp * volumes[i]);

    const positiveFlow: number[] = [];
    const negativeFlow: number[] = [];
    for (let i = 1; i < typicalPrices.length; i++) {
        if (typicalPrices[i] > typicalPrices[i - 1]) {
            positiveFlow.push(moneyFlow[i]);
            negativeFlow.push(0);
        } else if (typicalPrices[i] < typicalPrices[i - 1]) {
            positiveFlow.push(0);
            negativeFlow.push(moneyFlow[i]);
        } else {
            positiveFlow.push(0);
            negativeFlow.push(0);
        }
    }

    const posSum = last(rollingSum(positiveFlow, period));
    const negSum = last(rollingSum(negativeFlow, period));
    if (isNaN(posSum) || isNaN(negSum) || posSum + negSum === 0) return null;
    return 100 * (posSum / (posSum + negSum));
}

export function calculateCmf(ohlc: Candle[], period = 20): number | null {
    if (ohlc.length < period) return null;
    const mfMultiplier = ohlc.map(c => {
        const range = c.high - c.low;
        if (range === 0) return 0;
        return ((c.close - c.low) - (c.high - c.close)) / range;
    });
    const volumes = ohlc.map(c => c.volume || 0);
    const mfVolume = mfMultiplier.map((m, i) => m * volumes[i]);

    const adSum = last(rollingSum(mfVolume, period));
    const volSum = last(rollingSum(volumes, period));
    if (isNaN(adSum) || isNaN(volSum) || volSum === 0) return 0;
    const cmf = adSum / volSum;
    return isFinite(cmf) ? cmf : 0;
}

export function calculateVolumeOscillator(ohlc: Candle[], shortPeriod = 5, longPeriod = 14): number | null {
    if (ohlc.length < longPeriod) return null;
    const volumes = ohlc.map(c => c.volume || 0);
    const shortMa = last(rollingMean(volumes, shortPeriod));
    const longMa = last(rollingMean(volumes, longPeriod));
    if (isNaN(shortMa) || isNaN(longMa) || longMa === 0) return null;
    return ((shortMa - longMa) / longMa) * 100;
}

export function calculateIchimoku(ohlc: Candle[]) {
    if (ohlc.length < 52) return { tenkan: null, kijun: null, span_a: null, span_b: null };
    const highs = ohlc.map(c => c.high);
    const lows = ohlc.map(c => c.low);

    const tenkan = (last(rollingMax(highs, 9)) + last(rollingMin(lows, 9))) / 2;
    const kijun = (last(rollingMax(highs, 26)) + last(rollingMin(lows, 26))) / 2;
    const spanA = (tenkan + kijun) / 2;
    const spanB = (last(rollingMax(highs, 52)) + last(rollingMin(lows, 52))) / 2;

    return { tenkan, kijun, span_a: spanA, span_b: spanB };
}

export function calculateAdxDi(ohlc: Candle[], period = 14): { adx: number | null; plusDi: number | null; minusDi: number | null } {
    if (ohlc.length < period + 1) return { adx: null, plusDi: null, minusDi: null };
    const highs = ohlc.map(c => c.high);
    const lows = ohlc.map(c => c.low);
    const closes = ohlc.map(c => c.close);

    const trList: number[] = [];
    const plusDm: number[] = [];
    const minusDm: number[] = [];

    for (let i = 1; i < highs.length; i++) {
        const tr = Math.max(
            highs[i] - lows[i],
            Math.abs(highs[i] - closes[i - 1]),
            Math.abs(lows[i] - closes[i - 1])
        );
        trList.push(tr);

        const upMove = highs[i] - highs[i - 1];
        const downMove = lows[i - 1] - lows[i];
        plusDm.push(upMove > downMove && upMove > 0 ? upMove : 0);
        minusDm.push(downMove > upMove && downMove > 0 ? downMove : 0);
    }

    const tr14 = rollingSum(trList, period);
    const plusDi14 = tr14.map((t, i) => 100 * (rollingSum(plusDm, period)[i] / t));
    const minusDi14 = tr14.map((t, i) => 100 * (rollingSum(minusDm, period)[i] / t));

    const dx = plusDi14.map((p, i) => {
        const m = minusDi14[i];
        const denom = p + m;
        return denom === 0 ? NaN : (Math.abs(p - m) / denom) * 100;
    });
    const adx = rollingMean(dx, period);

    const adxLast = last(adx);
    const plusLast = last(plusDi14);
    const minusLast = last(minusDi14);

    return {
        adx: isNaN(adxLast) ? null : adxLast,
        plusDi: isNaN(plusLast) ? null : plusLast,
        minusDi: isNaN(minusLast) ? null : minusLast,
    };
}

// --- MAIN WRAPPER ENTRY POINT ---
export function computeIndicators(ohlcData: Candle[] | any[]): Partial<IndicatorReport> {
    const candles: Candle[] = Array.isArray(ohlcData) ? ohlcData.map(c => ({
        open: safeFloat(c.open || c.o) || 0,
        high: safeFloat(c.high || c.h) || 0,
        low: safeFloat(c.low || c.l) || 0,
        close: safeFloat(c.close || c.c) || 0,
        volume: safeFloat(c.volume || c.v) || 0
    })) : [];

    if (candles.length < 10) return {};

    const closes = candles.map(c => c.close);
    const dataLen = candles.length;
    const indicators: any = {};

    // Trend & moving averages
    indicators["sma_20"] = dataLen >= 20 ? safeFloat(calculateSma(closes, 20)) : null;
    indicators["ema_20"] = dataLen >= 20 ? safeFloat(calculateEma(closes, 20)) : null;
    indicators["ema_200"] = dataLen >= 200 ? safeFloat(calculateEma(closes, 200)) : null;
    indicators["hull_ma_21"] = dataLen >= 21 ? safeFloat(calculateHullMa(closes, 21)) : null;
    indicators["kama_10"] = dataLen >= 10 ? safeFloat(calculateKama(closes, 10)) : null;
    indicators["tema_20"] = dataLen >= 20 ? safeFloat(calculateTema(closes, 20)) : null;
    indicators["vwap"] = safeFloat(calculateVwap(candles));
    indicators["psar"] = safeFloat(calculateParabolicSar(candles));

    // Momentum oscillators
    indicators["rsi"] = dataLen >= 15 ? safeFloat(calculateRsi(closes, 14)) : null;
    indicators["cci"] = dataLen >= 20 ? safeFloat(calculateCci(candles, 20)) : null;
    indicators["roc_10"] = dataLen >= 11 ? safeFloat(calculateRoc(closes, 10)) : null;
    indicators["williams_r"] = dataLen >= 14 ? safeFloat(calculateWilliamsR(candles, 14)) : null;
    indicators["momentum"] = dataLen >= 11 ? safeFloat(calculateMomentum(closes, 10)) : null;

    const stoch = dataLen >= 14 ? calculateStochastic(candles) : { k: null, d: null };
    indicators["stoch_k"] = safeFloat(stoch.k);
    indicators["stoch_d"] = safeFloat(stoch.d);

    const macdData = dataLen >= 26 ? calculateMacd(closes) : null;
    if (macdData) {
        indicators["macd"] = safeFloat(macdData.macd);
        indicators["macd_signal"] = safeFloat(macdData.signal);
        indicators["macd_trend"] = macdData.trend;
    }

    // Volatility & channels
    indicators["atr"] = dataLen >= 15 ? safeFloat(calculateAtr(candles, 14)) : null;
    const bb = dataLen >= 20 ? calculateBollingerBands(closes) : null;
    if (bb) {
        indicators["bb_upper"] = safeFloat(bb.upper);
        indicators["bb_lower"] = safeFloat(bb.lower);
        indicators["bb_signal"] = bb.signal;
    }
    const keltner = dataLen >= 20 ? calculateKeltnerChannels(candles) : { upper: null, lower: null };
    indicators["keltner_upper"] = safeFloat(keltner.upper);
    indicators["keltner_lower"] = safeFloat(keltner.lower);

    const donchian = dataLen >= 20 ? calculateDonchian(candles) : { upper: null, lower: null };
    indicators["donchian_upper"] = safeFloat(donchian.upper);
    indicators["donchian_lower"] = safeFloat(donchian.lower);

    indicators["chandelier_exit"] = dataLen >= 22 ? safeFloat(calculateChandelierExit(candles)) : null;

    // Volume & flow
    const totalVol = candles.reduce((a, c) => a + (c.volume || 0), 0);
    if (totalVol > 0) {
        indicators["obv"] = safeFloat(calculateObv(candles)) ?? 0;
        indicators["mfi"] = dataLen >= 15 ? safeFloat(calculateMfi(candles, 14)) : null;
        indicators["cmf_20"] = dataLen >= 20 ? safeFloat(calculateCmf(candles, 20)) : null;
        const vo = dataLen >= 14 ? calculateVolumeOscillator(candles) : null;
        indicators["volume_oscillator"] = vo !== null ? safeFloat(vo / 100) ?? 0 : 0;
    } else {
        indicators["obv"] = 0;
        indicators["mfi"] = 50;
        indicators["cmf_20"] = 0;
        indicators["volume_oscillator"] = 0;
    }

    // Market structure (SMC-lite)
    const stVal = dataLen >= 20 ? calculateSupertrend(candles) : 0;
    indicators["supertrend"] = stVal === 1 ? "BUY" : (stVal === -1 ? "SELL" : "NEUTRAL");

    const ms = dataLen >= 20 ? detectMarketStructure(candles) : null;
    if (ms) {
        indicators["market_structure"] = ms.structure;
        indicators["bos_signal"] = ms.signal;
        indicators["recent_high"] = safeFloat(ms.recent_high);
        indicators["recent_low"] = safeFloat(ms.recent_low);
    }

    // Advanced tools
    const ichi = dataLen >= 52 ? calculateIchimoku(candles) : { tenkan: null, kijun: null, span_a: null, span_b: null };
    indicators["ichimoku_base"] = safeFloat(ichi.kijun);
    indicators["ichimoku_conv"] = safeFloat(ichi.tenkan);
    indicators["span_a"] = safeFloat(ichi.span_a);
    indicators["span_b"] = safeFloat(ichi.span_b);

    const adxDi = dataLen >= 28 ? calculateAdxDi(candles, 14) : { adx: null, plusDi: null, minusDi: null };
    indicators["adx"] = safeFloat(adxDi.adx);
    indicators["di_plus"] = safeFloat(adxDi.plusDi);
    indicators["di_minus"] = safeFloat(adxDi.minusDi);

    // S/R ladders & fallbacks
    const levels = dataLen >= 30 ? detectSupportResistance(candles) : null;
    const supAll = levels ? levels.support.map(x => safeFloat(x)).filter((x): x is number => x !== null) : [];
    const resAll = levels ? levels.resistance.map(x => safeFloat(x)).filter((x): x is number => x !== null) : [];

    indicators["support_levels_all"] = supAll;
    indicators["resistance_levels_all"] = resAll;
    indicators["support_levels"] = supAll.slice(-3);
    indicators["resistance_levels"] = resAll.slice(0, 3);

    if (indicators["support_levels_all"].length === 0) {
        const lowv = Math.min(...candles.map(c => c.low));
        indicators["support_levels_all"] = [lowv];
        indicators["support_levels"] = [lowv];
    }
    if (indicators["resistance_levels_all"].length === 0) {
        const highv = Math.max(...candles.map(c => c.high));
        indicators["resistance_levels_all"] = [highv];
        indicators["resistance_levels"] = [highv];
    }

    return indicators;
}
