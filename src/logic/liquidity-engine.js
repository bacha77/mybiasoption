/**
 * Liquidity Engine
 * Identifies institutional liquidity draws: Old Highs/Lows and Fair Value Gaps (FVG).
 */

export class LiquidityEngine {
    // Pre-allocate formatter for high-performance date operations
    static nyFormatter = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        hour: 'numeric',
        hour12: false
    });

    getNYHour(timestamp) {
        return parseInt(LiquidityEngine.nyFormatter.format(new Date(timestamp)));
    }

    /**
     * Calculates the Central Bank Dealers Range (CBDR).
     * Range: 14:00 - 20:00 EST (The previous day's institutional consolidation)
     */
    calculateCBDR(candles) {
        if (!candles || candles.length < 50) return null;
        
        // --- 1. Find the 14:00 - 20:00 Segment ---
        // institutional algorithms identify the 'dead zone' to define the next expansion
        const targetStart = 14; 
        const targetEnd   = 20;

        const segment = candles.filter(c => {
            const hr = this.getNYHour(c.timestamp);
            return hr >= targetStart && hr < targetEnd;
        });

        if (segment.length === 0) return null;

        const high = Math.max(...segment.map(c => c.high));
        const low  = Math.min(...segment.map(c => c.low));
        const range = high - low;

        return {
            high,
            low,
            range,
            sd: {
                one:   high + range,
                two:   high + (range * 2),
                three: high + (range * 3),
                sell_one:   low - range,
                sell_two:   low - (range * 2),
                sell_three: low - (range * 3)
            }
        };
    }

    /**
     * Converts a timestamp to the current hour in New York.
     */
    getNYHour(timestamp) {
        const date = typeof timestamp === 'number' ? new Date(timestamp) : new Date();
        const nyTime = new Date(date.toLocaleString("en-US", { timeZone: "America/New_York" }));
        return nyTime.getHours();
    }


    constructor() {
        this.liquidityZones = [];
        this.signalState = {}; // Tracks { [key]: { action, count } }
        this.activePositions = {}; // Tracks { [symbol]: { type, entry, sl, tp, active } }
    }

    /**
     * Identifies Fair Value Gaps (FVG) from candle data.
     */
    findFVGs(candles) {
        const fvgs = [];
        for (let i = 2; i < candles.length; i++) {
            const c1 = candles[i - 2];
            const c2 = candles[i - 1];
            const c3 = candles[i];

            if (c1.high < c3.low) {
                fvgs.push({
                    type: 'bullish_fvg',
                    top: c3.low,
                    bottom: c1.high,
                    strength: (c3.low - c1.high),
                    timestamp: c2.timestamp
                });
            } else if (c1.low > c3.high) {
                fvgs.push({
                    type: 'bearish_fvg',
                    top: c1.low,
                    bottom: c3.high,
                    strength: (c1.low - c3.high),
                    timestamp: c2.timestamp
                });
            }
        }
        return fvgs;
    }

    findLiquidityDraws(candles) {
        const highs = candles.map(c => c.high);
        const lows = candles.map(c => c.low);
        const significantHighs = this.findLocalExtrema(highs, 'max');
        const significantLows = this.findLocalExtrema(lows, 'min');

        return {
            highs: significantHighs.map(idx => ({ price: highs[idx], timestamp: candles[idx].timestamp, type: 'BSL' })),
            lows: significantLows.map(idx => ({ price: lows[idx], timestamp: candles[idx].timestamp, type: 'SSL' }))
        };
    }

    findLocalExtrema(arr, type, window = 10) {
        const extrema = [];
        for (let i = window; i < arr.length - window; i++) {
            const range = arr.slice(i - window, i + window + 1);
            if (type === 'max' && arr[i] === Math.max(...range)) {
                extrema.push(i);
            } else if (type === 'min' && arr[i] === Math.min(...range)) {
                extrema.push(i);
            }
        }
        return extrema;
    }

    // --- NEW: Gamma Walls & Magnet Strikes ---
    getGammaWalls(currentPrice, symbol) {
        const walls = [];
        const isForex = symbol.includes('=X') || symbol.includes('USD');
        const isCrypto = symbol.includes('BTC') || symbol.includes('ETH');

        if (isForex) {
            // FX Walls every 0.0050 (50 pips)
            const base = Math.floor(currentPrice * 200) / 200;
            walls.push(base, base + 0.0050, base - 0.0050, base + 0.0100, base - 0.0100);
        } else if (isCrypto) {
            // Crypto Walls every $500 or $1000
            const step = currentPrice > 10000 ? 1000 : 500;
            const base = Math.floor(currentPrice / step) * step;
            walls.push(base, base + step, base - step);
        } else {
            // Stock/ETF Walls: Major round numbers and $5/$10 intervals
            const step = currentPrice > 100 ? 5 : 1;
            const base = Math.floor(currentPrice / step) * step;
            walls.push(base, base + step, base - step);

            // Major "Century" Walls
            const centuryStep = 50;
            const centuryBase = Math.floor(currentPrice / centuryStep) * centuryStep;
            if (!walls.includes(centuryBase)) walls.push(centuryBase);
        }
        return walls;
    }

    detectLiquidationSweep(candles, draws) {
        const lastCandle = candles[candles.length - 1];
        const prevCandle = candles[candles.length - 2];
        const sweeps = [];

        draws.highs.forEach(h => {
            if (prevCandle.high > h.price && lastCandle.close < h.price && lastCandle.high > h.price) {
                sweeps.push({ type: 'BSL_SWEEP', price: h.price, timestamp: lastCandle.timestamp });
            }
        });

        draws.lows.forEach(l => {
            if (prevCandle.low < l.price && lastCandle.close > l.price && lastCandle.low < l.price) {
                sweeps.push({ type: 'SSL_SWEEP', price: l.price, timestamp: lastCandle.timestamp });
            }
        });

        return sweeps;
    }

    /**
     * Detects Absorption: High volume at a price level with minimal price movement.
     */
    detectAbsorption(candles, markers = {}) {
        if (candles.length < 10) return null;
        const lastCandle = candles[candles.length - 1];
        const prevCandles = candles.slice(-11, -1);
        const avgVol = prevCandles.reduce((s, c) => s + c.volume, 0) / 10;

        const isHighVol = lastCandle.volume > avgVol * 1.5;
        const totalRange = lastCandle.high - lastCandle.low;
        const bodySize = Math.abs(lastCandle.open - lastCandle.close);

        // Absorption: High Volume but Price is "Stuck" (Small body relative to wick/range)
        const isStuck = totalRange > 0 && (bodySize / totalRange) < 0.35;

        if (isHighVol && isStuck) {
            // Check if at key level
            const levels = [markers.vwap, markers.poc, markers.pdh, markers.pdl, markers.midnightOpen];
            const atLevel = levels.some(lvl => lvl > 0 && Math.abs(lastCandle.close - lvl) / lvl < 0.0005);

            if (atLevel) {
                return {
                    price: lastCandle.close,
                    type: lastCandle.close > lastCandle.open ? 'BULLISH_ABSORPTION' : 'BEARISH_ABSORPTION',
                    message: 'Institutional Absorption (Iceberg Order) detected at key level.'
                };
            }
        }
        return null;
    }

    /**
     * Institutional Reload: High Intensity CVD but zero price expansion (Absorption)
     * Signals that institutions are filling massive limit orders before a breakout.
     */
    detectInstitutionalReload(markers, candles) {
        if (!markers || !candles || candles.length < 10) return null;
        const cvd = markers.cvd || 0;
        const abs = this.detectAbsorption(candles, markers);
        
        // Intensity Threshold: Abs CVD > 1500 + Absorption Pattern
        if (Math.abs(cvd) > 1500 && abs) {
            return {
                type: cvd > 0 ? 'BULLISH_RELOAD' : 'BEARISH_RELOAD',
                intensity: Math.min(100, Math.abs(cvd) / 25),
                message: 'INSTITUTIONAL RELOAD: Whales are stacking orders.'
            };
        }
        return null;
    }

    /**
     * Fire Breakout: High CVD + Concurrent Price Displacement
     * The "Sync" move where institutions stop hiding and drive price aggressively.
     */
    detectFireBreakout(markers, candles, bias) {
        if (!markers || !candles || candles.length < 10) return null;
        const cvd = markers.cvd || 0;
        const disp = this.detectDisplacement(candles.slice(-10));
        
        if (!disp) return null;

        // Check for Directional Sync (CVD alignment with Displacement)
        const isSync = (cvd > 500 && disp.direction === 'BULLISH') || (cvd < -500 && disp.direction === 'BEARISH');
        
        if (isSync && Math.abs(cvd) > 1200) {
            return {
                type: cvd > 0 ? 'BULLISH_FIRE' : 'BEARISH_FIRE',
                signal: '🔥 FIRE BREAKOUT',
                intensity: Math.min(100, Math.abs(cvd) / 20)
            };
        }
        return null;
    }

    /**
     * Detects Delta Traps (Divergence between Price and CVD)
     */
    detectDeltaTrap(currentPrice, cvd, candles) {
        if (candles.length < 5) return null;
        const lastCandle = candles[candles.length - 1];
        const firstCandle = candles[candles.length - 5];
        const priceChange = lastCandle.close - firstCandle.open;

        // Bull Trap: Price Up, CVD significantly Down
        if (priceChange > 0 && cvd < -1000) {
            return { type: 'BULL_TRAP', severity: 'HIGH' };
        }
        // Bear Trap: Price Down, CVD significantly Up
        if (priceChange < 0 && cvd > 1000) {
            return { type: 'BEAR_TRAP', severity: 'HIGH' };
        }
        return null;
    }

    calculateATR(candles, period = 14) {
        if (candles.length < period + 1) return (candles[candles.length - 1]?.close * 0.002) || 0;
        let trSum = 0;
        for (let i = candles.length - period; i < candles.length; i++) {
            const high = candles[i].high;
            const low = candles[i].low;
            const prevClose = candles[i - 1].close;
            const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
            trSum += tr;
        }
        return trSum / period;
    }

    /**
     * Calculates Average Daily Range (ADR)
     * Used to determine if a move is "extended" or has room to run.
     */
    calculateADR(dailyQuotes, period = 5) {
        if (!dailyQuotes || dailyQuotes.length < period) return 0;
        const ranges = dailyQuotes.slice(-period).map(q => q.high - q.low);
        return ranges.reduce((a, b) => a + b, 0) / period;
    }

    calculateRelativeStrength(symbolCandles, comparisonCandles, symbol = 'SPY') {
        if (!symbolCandles.length || !comparisonCandles.length) return 0;
        const count = Math.min(symbolCandles.length, comparisonCandles.length, 15);
        if (count < 2) return 0;

        const symStart = symbolCandles[symbolCandles.length - count].close;
        const symEnd = symbolCandles[symbolCandles.length - 1].close;
        const compStart = comparisonCandles[comparisonCandles.length - count].close;
        const compEnd = comparisonCandles[comparisonCandles.length - 1].close;

        if (symStart === 0 || compStart === 0) return 0;

        const symPerf = (symEnd - symStart) / symStart;
        const compPerf = (compEnd - compStart) / compStart;
        
        // Inverse correlation for USD-quoted pairs vs DXY
        const isInverse = symbol.includes('USD') && (symbol.indexOf('USD') > 0);
        return isInverse ? (symPerf + compPerf) * 100 : (symPerf - compPerf) * 100;
    }


    /**
     * Institutional Killzone Status (Timed Volatility Phases)
     * Maps the current UTC time to high-probability institutional activity zones.
     */
    getKillzoneStatus() {
        const now = new Date();
        const hour = now.getUTCHours();
        const min = now.getUTCMinutes();
        const totalMin = hour * 60 + min;

        // Session Time Windows (Minutes from Midnight UTC)
        const sessions = {
            LONDON: { start: 7 * 60, end: 10 * 60 },      // 2am - 5am ET
            NY: { start: 13 * 60 + 30, end: 16 * 60 },    // 8:30am - 12pm ET
            ASIA: { start: 0, end: 3 * 60 }               // 7pm - 10pm ET
        };

        for (const [name, range] of Object.entries(sessions)) {
            if (totalMin >= range.start && totalMin <= range.end) {
                const elapsed = totalMin - range.start;
                const duration = range.end - range.start;
                return { 
                    name, 
                    progress: Math.min(100, Math.max(0, (elapsed / duration) * 100)), 
                    active: true 
                };
            }
        }
        return { name: 'MID-SESSION', progress: 0, active: false };
    }

    getGlobalForexSessions() {
        const now = new Date();
        const nyTime = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
        const hour = nyTime.getHours();
        
        return {
            london: { status: (hour >= 3 && hour < 11) ? 'OPEN' : 'CLOSED', color: (hour >= 3 && hour < 11) ? '#00f2ff' : '#475569' },
            ny: { status: (hour >= 8 && hour < 17) ? 'OPEN' : 'CLOSED', color: (hour >= 8 && hour < 17) ? '#00ff88' : '#475569' },
            tokyo: { status: (hour >= 19 || hour < 4) ? 'OPEN' : 'CLOSED', color: (hour >= 19 || hour < 4) ? '#f59e0b' : '#475569' }
        };
    }

    /**
     * T1-F: VOLATILITY REGIME CLASSIFIER
     * Compare current ATR to 20-period rolling average ATR.
     * EXPLOSIVE  (>1.5× avg): Trending — block mean-reversion signals.
     * NORMAL     (0.8–1.5×): Standard conditions — all signals valid.
     * COMPRESSED (<0.8× avg): Coiling — breakout imminent, prefer ORB/FVG setups.
     */
    classifyVolatilityRegime(candles) {
        if (!candles || candles.length < 25) return { regime: 'NORMAL', ratio: 1, label: 'NORMAL VOLATILITY', color: 'var(--gold)' };

        const atrSeries = [];
        for (let i = 1; i < candles.length; i++) {
            const c = candles[i];
            const p = candles[i - 1];
            const tr = Math.max(
                c.high - c.low,
                Math.abs(c.high - p.close),
                Math.abs(c.low  - p.close)
            );
            atrSeries.push(tr);
        }

        const currentATR = atrSeries[atrSeries.length - 1];
        const lookback   = atrSeries.slice(-21, -1); // Last 20, excluding current
        const avgATR     = lookback.reduce((s, v) => s + v, 0) / lookback.length;
        if (avgATR === 0) return { regime: 'NORMAL', ratio: 1, label: 'NORMAL VOLATILITY', color: 'var(--gold)' };

        const ratio = parseFloat((currentATR / avgATR).toFixed(2));

        if (ratio >= 1.8) return { regime: 'EXPLOSIVE', ratio, label: '⚡ EXPLOSIVE VOLATILITY — TREND MODE', color: '#f43f5e', blockReversion: true };
        if (ratio >= 1.3) return { regime: 'ELEVATED', ratio, label: 'ELEVATED VOLATILITY — MOMENTUM ACTIVE', color: '#f97316', blockReversion: false };
        if (ratio >= 0.8) return { regime: 'NORMAL',   ratio, label: 'NORMAL VOLATILITY — ALL SETUPS VALID', color: 'var(--bullish)', blockReversion: false };
        return               { regime: 'COMPRESSED', ratio, label: '🔴 COMPRESSED — BREAKOUT BUILDING', color: 'var(--gold)', blockReversion: false, watchBreakout: true };
    }

    /**
     * Estimates Retail Sentiment based on Price Action vs Key Levels.
     * Retail typically "buys support" and "sells resistance".
     * Institutions "engineer liquidity" at these same levels.
     */
    calculateRetailSentiment(price, markers, candles = []) {
        let bullish = 50; // Neutral baseline
        
        // 1. Retail Trend Following (Retail loves chasing green candles)
        if (candles.length > 5) {
            const shortTerm = candles.slice(-10);
            const move = ((shortTerm[shortTerm.length-1].close - shortTerm[0].open) / shortTerm[0].open) * 100;
            bullish += (move * 10); // Fixed: was move*30 (overfit on >2% moves)
        }

        // 2. Retail Level Strategy (Buying Support / Selling Resistance)
        const eq = this.detectEqualHighsLows(candles);
        if (eq) {
            if (eq.eqh && Math.abs(price - eq.eqh.price) / price < 0.001) bullish -= 25; // Retail selling "Double Top"
            if (eq.eql && Math.abs(price - eq.eql.price) / price < 0.001) bullish += 25; // Retail buying "Double Bottom"
        }

        // 3. PDH/PDL bias: Retail sells breaks of PDH (thinking it's resistance)
        if (markers.pdh && price > markers.pdh) bullish -= 15;
        if (markers.pdl && price < markers.pdl) bullish += 15;

        return Math.max(10, Math.min(90, bullish));
    }

    calculateBias(currentPrice, fvgs, liquidityDraws, bloombergMetrics = {}, markers = {}, relativeStrength = 0, internals = { vix: 0, dxy: 0, newsImpact: 'LOW', sectors: [] }, symbol = 'SPY', candles = []) {
        const isForex = symbol.includes('=X') || symbol === 'BTC-USD' || symbol.includes('USD');
        
        if (isForex) {
            return this.calculateForexBias(currentPrice, fvgs, liquidityDraws, bloombergMetrics, markers, internals, symbol, candles);
        } else {
            return this.calculateStockBias(currentPrice, fvgs, liquidityDraws, bloombergMetrics, markers, relativeStrength, internals, symbol, candles);
        }
    }

    /**
     * Institutional Stock Algorithm
     * Focus: Sector Health, VIX Fear, and Market Breadth.
     */
    calculateStockBias(currentPrice, fvgs, draws, bloomberg, markers, relativeStrength, internals, symbol, candles) {
        let bullishScore = 0;
        let bearishScore = 0;

        // 1. VIX & FEAR DYNAMICS
        const vix = internals.vix || 0;
        const vixPrev = internals.vixPrev || vix;
        const vixVelocity = vixPrev > 0 ? (vix - vixPrev) / vixPrev : 0;
        if (vix > 22) bearishScore += 4;
        if (vixVelocity > 0.03) { bearishScore += 7; bullishScore -= 5; }

        // 2. SECTOR ALPHA (XLK for Tech)
        if (internals.sectors && internals.sectors.length > 0) {
            const tech = internals.sectors.find(s => s.symbol === 'XLK');
            if (tech && ['SPY', 'QQQ', 'NVDA', 'AAPL', 'MSFT'].includes(symbol)) {
                if (tech.change > 0.4) bullishScore += 5;
                else if (tech.change < -0.4) bearishScore += 5;
            }
        }

        // 3. CORE INSTITUTIONAL LEVELS
        const vwap = markers.vwap || 0;
        const midnight = markers.midnightOpen || 0;
        if (currentPrice > vwap && vwap > 0) bullishScore += 3;
        else if (currentPrice < vwap && vwap > 0) bearishScore += 3;
        if (currentPrice > midnight && midnight > 0) bullishScore += 3;
        else if (currentPrice < midnight && midnight > 0) bearishScore += 3;

        // 4. BLOOMBERG FLOWS
        if (bloomberg.wei === 'BULLISH') bullishScore += 4;
        if (bloomberg.wei === 'BEARISH') bearishScore += 4;

        // 5. MOMENTUM & TRAPS
        const result = this.applyMomentumFilters(bullishScore, bearishScore, currentPrice, candles, draws, markers, false);
        bullishScore = result.bullish;
        bearishScore = result.bearish;

        // P4: JUDAS SWING FOR STOCKS (NY Open & Power Hour equity stop-hunts)
        // Mirrors the existing Forex Judas logic, but triggered at equity-specific times.
        const stockSession = this.getSessionInfo(symbol);
        const isStockJudasWindow = (
            stockSession.session === 'NY' &&
            (stockSession.label.includes('SILVER BULLET') || stockSession.label.includes('DISTRIBUTION'))
        );
        if (isStockJudasWindow) {
            const stockJudas = this.detectJudasSwing(candles, markers, stockSession);
            if (stockJudas) {
                if (stockJudas.type === 'BULLISH')  bullishScore += 12;
                else if (stockJudas.type === 'BEARISH') bearishScore += 12;
            }
        }

        // P7: SESSION WEIGHTING FOR STOCKS (mirrors Forex killzone multiplier)
        const isStockKillzone = stockSession.session === 'NY' || stockSession.session.includes('LONDON');
        const stockSessionMult = isStockKillzone ? 1.5 : (stockSession.isMarketOpen ? 1.0 : 0.6);
        bullishScore *= stockSessionMult;
        bearishScore *= stockSessionMult;

        return this.assembleFinalBias(bullishScore, bearishScore, currentPrice, markers, internals, symbol, candles, bloomberg);
    }

    /**
     * Institutional Forex Algorithm
     * Focus: DXY Alignment, SMT Divergence, and Killzone Timing.
     */
    calculateForexBias(currentPrice, fvgs, draws, bloomberg, markers, internals, symbol, candles) {
        let bullishScore = 0;
        let bearishScore = 0;
        const isUSDQuote = symbol.includes('USD') && !symbol.startsWith('USD');

        // 1. DXY ANCHOR SYNC
        if (internals.dxy > 0) {
            const dxyBullish = internals.dxyChange > 0;
            if (isUSDQuote) {
                if (dxyBullish) bearishScore += 6.0;
                else bullishScore += 5.0;
            } else {
                if (dxyBullish) bullishScore += 6.0;
                else bearishScore += 5.0;
            }
        }

        // 2. KILLZONE INTENSITY (Timing is everything in FX)
        const session = this.getSessionInfo(symbol);
        const isKillzone = session.session.includes('LONDON') || session.session.includes('NY');
        const multiplier = isKillzone ? 1.5 : 0.5;

        // 3. SMT DIVERGENCE (The Holy Grail of FX)
        if (markers.smt) {
            if (markers.smt.type === 'BULLISH') bullishScore += 8;
            else if (markers.smt.type === 'BEARISH') bearishScore += 8;
        }

        // 4. CORE INSTITUTIONAL LEVELS
        const vwap = markers.vwap || 0;
        const midnight = markers.midnightOpen || 0;
        if (currentPrice > vwap && vwap > 0) bullishScore += 2;
        else if (currentPrice < vwap && vwap > 0) bearishScore += 2;
        if (currentPrice > midnight && midnight > 0) bullishScore += 4; // Midnight Open is critical in FX
        else if (currentPrice < midnight && midnight > 0) bearishScore += 4;

        // 5. MOMENTUM & TRAPS
        const result = this.applyMomentumFilters(bullishScore, bearishScore, currentPrice, candles, draws, markers, true);
        bullishScore = result.bullish * multiplier;
        bearishScore = result.bearish * multiplier;

        // 6. JUDAS SWING DETECTION (Elite Trap Logic)
        const judas = this.detectJudasSwing(candles, markers, session);
        if (judas) {
            if (judas.type === 'BULLISH') bullishScore += 15;
            else if (judas.type === 'BEARISH') bearishScore += 15;
        }

        return this.assembleFinalBias(bullishScore, bearishScore, currentPrice, markers, internals, symbol, candles, bloomberg, judas);
    }

    /**
     * Shared Momentum & structural Filtering
     */
    applyMomentumFilters(bullish, bearish, currentPrice, candles, draws, markers, isForex) {
        if (!candles || candles.length < 10) return { bullish, bearish };
        
        let bull = bullish;
        let bear = bearish;
        const last5 = candles.slice(-5);
        const trend5 = last5[4].close - last5[0].open;
        const thresh = isForex ? 0.0003 : 0.001;

        if (trend5 < -thresh) { bull *= 0.3; bear += 6.0; }
        if (trend5 > thresh) { bear *= 0.3; bull += 6.0; }

        const mss = this.detectMSS(candles, draws, markers);
        if (mss) {
            if (mss.type === 'BEARISH_MSS') { bear += 10; bull -= 5; }
            if (mss.type === 'BULLISH_MSS') { bull += 10; bear -= 5; }
        }

        const disp = this.detectDisplacement(candles);
        if (disp) {
            if (disp.direction === 'BEARISH') { bear += 12; bull = 0; }
            if (disp.direction === 'BULLISH') { bull += 12; bear = 0; }
        }

        // P8: MOMENTUM EXHAUSTION DETECTION
        // If the last 3 bodies are each shrinking significantly near a key level,
        // institutions are quietly distributing/accumulating. Dampen the continuation signal.
        const exhaustion = this.detectMomentumExhaustion(candles);
        if (exhaustion) {
            // Dampen the direction of the exhaustion (if bulls exhausted, reduce bull score)
            if (exhaustion.direction === 'BULLISH_EXHAUSTION') { bull *= 0.6; }
            if (exhaustion.direction === 'BEARISH_EXHAUSTION') { bear *= 0.6; }
        }

        return { bullish: bull, bearish: bear };
    }

    /**
     * Assemble the final shared metrics object
     */
    assembleFinalBias(bullishScore, bearishScore, currentPrice, markers, internals, symbol, candles, bloomberg, judas = null) {
        const finalMultiplier = (internals && internals.newsImpact === 'HIGH') ? 0.5 : 1;
        const totalScore = (bullishScore * finalMultiplier) - (bearishScore * finalMultiplier);

        let biasLabel = 'NEUTRAL';
        if (totalScore >= 12) biasLabel = 'STRONG BULLISH';
        else if (totalScore >= 4) biasLabel = 'BULLISH';
        else if (totalScore <= -12) biasLabel = 'STRONG BEARISH';
        else if (totalScore <= -4) biasLabel = 'BEARISH';
        
        // --- 🧭 INSTITUTIONAL CVD ANCHOR (Conflicting Signal Guard) ---
        // If the score is Bullish but CVD is heavily negative (Bearish), dampen the signal.
        // This prevents the HUD from saying BULLISH when institutions are dumping.
        const cvd = markers.cvd || 0;
        if (biasLabel.includes('BULLISH') && cvd < -1500) {
            biasLabel = 'NEUTRAL (BULLISH TRAP)';
        } else if (biasLabel.includes('BEARISH') && cvd > 1500) {
            biasLabel = 'NEUTRAL (BEARISH TRAP)';
        }

        let confPoints = 0;
        const vwap = markers.vwap || 0;
        if (vwap > 0 && Math.abs(currentPrice - vwap) / vwap < 0.002) confPoints += 25;
        if (Math.abs(cvd) > 1000) confPoints += 25;
        if (Math.abs(totalScore) >= 12) confPoints += 50;

        const dxyAnchor = this.calculateDXYAnchorPulse(symbol, biasLabel, internals);
        
        return {
            bias: biasLabel,
            score: totalScore,
            confidence: Math.min(100, Math.max(0, confPoints)),
            bullScore: bullishScore,
            bearScore: bearishScore,
            dxyAnchor: dxyAnchor,
            narrative: `Institutional ${biasLabel} bias confirmed by ${Math.abs(totalScore).toFixed(1)}pts of confluence.`,
            metrics: bloomberg,
            vwap,
            midnightOpen: markers.midnightOpen,
            cvd: markers.cvd,
            isDisplacement: this.detectDisplacement(candles),
            mss: this.detectMSS(candles, null, markers),
            smt: markers.smt,
            judas: judas,
            amdPhase: this.calculateAMDPhase(symbol),
            retailSentiment: this.calculateRetailSentiment(currentPrice, markers, candles),
            internals: internals,
            absorption: this.detectAbsorption(candles, markers),
            squeeze: this.detectSqueeze(candles),
            ote: this.calculateOTE(candles),
            cbdr: this.calculateCBDR(candles),
            fvg: this.detectFVG(candles)
        };
    }

    /**
     * DXY Anchor Pulse (Global Dollar Correlation Filter)
     * Detects if the current move is supported by the global dollar trend or a "Trap".
     */
    calculateDXYAnchorPulse(symbol, bias, internals) {
        if (!internals || !internals.dxyChange) return { alignment: 'NEUTRAL', label: 'NO DXY PIVOT' };
        
        const isUSDQuote = symbol.includes('USD') && (symbol.indexOf('USD') > 0); // e.g. EURUSD
        const dxyBullish = internals.dxyChange > 0;
        
        let alignment = 'STABLE';
        if (isUSDQuote) {
            // Correlation: EURUSD Up means DXY Down
            if (bias.includes('BULLISH') && dxyBullish) alignment = 'CORRELATION_TRAP';
            else if (bias.includes('BEARISH') && !dxyBullish) alignment = 'CORRELATION_TRAP';
            else alignment = 'ALIGNED';
        } else {
            // e.g. DXY itself or USDJPY
            if (bias.includes('BULLISH') && dxyBullish) alignment = 'ALIGNED';
            else if (bias.includes('BEARISH') && !dxyBullish) alignment = 'ALIGNED';
            else alignment = 'DECOUPLED';
        }

        return {
            alignment,
            dxyChange: internals.dxyChange.toFixed(3) + '%',
            label: alignment === 'CORRELATION_TRAP' ? '⚠️ CORRELATION TRAP' : 'SYNCED WITH DOLLAR'
        };
    }

    /**
     * Identifies the current Institutional Cycle phase (Accumulation, Manipulation, Distribution).
     * Evaluated fractally based on the asset class and active global session.
     */
    calculateAMDPhase(symbol = 'SPY') {
        const nyTime = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
        const hour = nyTime.getHours();
        const min = nyTime.getMinutes();
        const timeVal = hour + (min / 60);
        
        const isForex = symbol.includes('=X') || symbol.includes('USD') || symbol === 'DX-Y.NYB';

        if (isForex) {
            // Forex / Global Macro AMD Cycle
            // Asia is accumulation. London Open manipulates (Judas). London/NY Overlap distributes. Late NY accumulates.
            if (timeVal >= 20 || timeVal < 2) return 'ACCUMULATION'; // 8 PM - 2 AM: Asia
            if (timeVal >= 2 && timeVal < 5) return 'MANIPULATION';  // 2 AM - 5 AM: London Judas Swing
            if (timeVal >= 5 && timeVal < 10) return 'DISTRIBUTION'; // 5 AM - 10 AM: Primary Core Move
            if (timeVal >= 10 && timeVal < 14) return 'MANIPULATION'; // 10 AM - 2 PM: PM Reversal Window
            return 'ACCUMULATION'; // 2 PM to 8 PM: Dead zone
        } else {
            // US Equities AMD Cycle (Standard indices and stocks)
            // Pre-market accumulates. NY Open manipulates. Rest of AM distributes. PM redistributes.
            if (timeVal >= 16 || timeVal < 8.5) return 'ACCUMULATION'; // 4 PM - 8:30 AM: Overnight/Pre-market
            if (timeVal >= 8.5 && timeVal < 10.5) return 'MANIPULATION'; // 8:30 AM - 10:30 AM: NY Open Stop Hunts
            if (timeVal >= 10.5 && timeVal < 12) return 'DISTRIBUTION'; // 10:30 AM - 12:00 PM: AM Trend Expansion
            if (timeVal >= 12 && timeVal < 13.5) return 'ACCUMULATION'; // 12:00 PM - 1:30 PM: Lunch Consolidation
            if (timeVal >= 13.5 && timeVal < 16) return 'DISTRIBUTION';  // 1:30 PM - 4:00 PM: PM Trend Expansion
            return 'ACCUMULATION';
        }
    }

    getSessionInfo(symbol = 'SPY') {
        const now = new Date();
        const nyTime = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
        const day = nyTime.getDay();
        const hour = nyTime.getHours();
        const minute = nyTime.getMinutes();
        const timeVal = hour + (minute / 60);

        const isForex = symbol === 'BTC-USD' || symbol.includes('=X');
        const isWeekend = (day === 6 && hour >= 16) || day === 0 || (day === 1 && hour < 2); // Sat 4pm to Sun late night

        if (isWeekend) {
            return {
                session: 'WEEKEND',
                label: 'ALGO OFFLINE (WEEKEND)',
                color: '#ff3366',
                isMarketOpen: false,
                isSilverBullet: false,
                desc: 'Markets are Archived',
                narrative: 'Institutional flow is paused. Analyzing weekly sentiment shifts.',
                next: 'ASIA OPEN (SUN)'
            };
        }

        // 1. ASIA ACCUMULATION (20:00 - 02:00)
        if (timeVal >= 20 || timeVal < 2) {
            return {
                session: 'ASIA',
                label: 'ACCUMULATION (ASIA)',
                color: '#38bdf8',
                isMarketOpen: true, // Forex/Crypto Open
                desc: 'Setting the Liquidity Anchor',
                narrative: 'Asia is defining the structural range. Watch 12:00 AM (Midnight) as the True Daily Open.',
                next: 'LON PRE-OPEN (RESETS)'
            };
        }

        // 2. LONDON PRE-OPEN / MIDNIGHT RESET (02:00 - 03:00)
        if (timeVal >= 2 && timeVal < 3) {
            return {
                session: 'LONDON_PRE',
                label: 'LON PRE-OPEN (RESET)',
                color: '#818cf8',
                isMarketOpen: true,
                desc: 'Institutional Re-Pricing',
                narrative: 'Smart Money is re-calculating the CBDR range. High probability of a small fake-move before 3:00 AM.',
                next: 'MANIPULATION (LONDON)'
            };
        }

        // 3. LONDON OPEN/MANIPULATION (03:00 - 05:00)
        if (timeVal >= 3 && timeVal < 5) {
            const isBullet = (hour === 3);
            return {
                session: 'LONDON',
                label: isBullet ? 'LON SILVER BULLET 🎯' : 'MANIPULATION (LONDON)',
                color: '#f59e0b',
                isMarketOpen: true,
                isSilverBullet: isBullet,
                desc: isBullet ? 'High-Priority Algo Window' : 'Judas Swing in Progress',
                narrative: isBullet ? 'The 3-4 AM window is actively hunting liquidity. Expect rapid stop-runs of Asia High/Low.' : 'Price is engineering liquidity. Do not trust the initial direction if DXY is decoupled.',
                next: 'LONDON EXPANSION'
            };
        }

        // 4. LONDON EXPANSION (05:00 - 08:30)
        if (timeVal >= 5 && timeVal < 8.5) {
            return {
                session: 'LONDON',
                label: 'LONDON EXPANSION',
                color: '#10b981',
                isMarketOpen: true,
                desc: 'Institutional Trend Realization',
                narrative: 'London has established the daily trend. Distributing size toward major liquidity pools.',
                next: 'NY PRE-OPEN (MACRO)'
            };
        }

        // 5. NY PRE-OPEN / MACRO WINDOW (08:30 - 09:30)
        if (timeVal >= 8.5 && timeVal < 9.5) {
            return {
                session: 'NY_PRE',
                label: 'NY PRE-OPEN (MACRO)',
                color: '#ec4899',
                isMarketOpen: true,
                desc: 'Economic Data/Macro Pulse',
                narrative: '8:30 AM data releases often act as the secondary manipulation for the NY session.',
                next: 'DISTRIBUTION (NY)'
            };
        }

        // 6. NY OPEN/DISTRIBUTION (09:30 - 13:30)
        if (timeVal >= 9.5 && timeVal < 13.5) {
            const isBullet = (hour === 10);
            return {
                session: 'NY',
                label: isBullet ? 'NY SILVER BULLET 🎯' : 'DISTRIBUTION (NY)',
                color: '#10b981',
                isMarketOpen: true,
                isSilverBullet: isBullet,
                desc: isBullet ? 'High-Priority Algo Window' : 'Institutional Trend Expansion',
                narrative: isBullet ? 'The 10-11 AM window is seeking internal range liquidity. Watch for FVG re-tests.' : 'New York is driving price toward the daily target. Institutional volume is at peak.',
                next: 'NY PM SESSION'
            };
        }

        // 7. NY PM SESSION (13:30 - 16:00)
        if (timeVal >= 13.5 && timeVal < 16) {
            return {
                session: 'NY',
                label: 'NY PM SESSION',
                color: '#06b6d4',
                isMarketOpen: true,
                desc: 'Afternoon Trend/Reversal',
                narrative: 'Profit-taking or secondary expansion. Watch the 2:00 PM (14:00) macro for reversals.',
                next: 'MARKET CLOSE / CBDR'
            };
        }

        // 8. MARKET CLOSE / CBDR (16:00 - 20:00)
        return {
            session: 'OFF',
            label: 'OFF-SESSION / RESET',
            color: '#64748b',
            isMarketOpen: false, 
            isSilverBullet: false,
            desc: 'Monitoring CBDR Range',
            narrative: 'Algorithmic day is reset. Analyzing Central Bank Dealers Range (CBDR) for the next cycle.',
            next: 'ACCUMULATION (ASIA)'
        };
    }

    getIntermarketCorrelation(symbol, markers) {
        // Feature 4: SMT Pulse / Intermarket Correlation
        if (!markers.smt) return { strength: 0, status: 'STABLE' };
        
        const isForex = symbol.includes('=X') || symbol.includes('USD');
        return {
            strength: markers.smt.divergence || 85,
            status: markers.smt.type === 'BULLISH' ? 'BULLISH SMT' : 'BEARISH SMT',
            regime: isForex ? 'INV-DXY ALIGNED' : 'INDEX CONFLUENCE'
        };
    }

    detectMSS(candles, draws, markers) {
        if (!candles || candles.length < 20) return null;
        // P6: SWEEP-FIRST REQUIREMENT
        // A real Market Structure Shift requires: (1) a liquidity SWEEP, then (2) a break.
        // Without confirming the sweep happened prior, this fires on every trending candle.
        const lastCandle  = candles[candles.length - 1];
        const prev5       = candles.slice(-6, -1);
        const lastSwingHigh = (draws?.highs && draws.highs.length > 0) ? draws.highs[draws.highs.length - 1].price : 0;
        const lastSwingLow  = (draws?.lows  && draws.lows.length  > 0) ? draws.lows[draws.lows.length - 1].price  : 0;

        // Detect if the prior 5 candles swept the swing level (wick through it) before the break
        const priorSweepHigh = prev5.some(c => c.high > lastSwingHigh && c.close < lastSwingHigh);
        const priorSweepLow  = prev5.some(c => c.low < lastSwingLow  && c.close > lastSwingLow);

        // Bullish MSS: Prior sweep of a swing low, then price breaks the swing high
        if (priorSweepLow && lastCandle.close > lastSwingHigh && lastSwingHigh > 0) {
            return { type: 'BULLISH_MSS', price: lastSwingHigh, timestamp: lastCandle.timestamp, swept: true };
        }
        // Bearish MSS: Prior sweep of a swing high, then price breaks the swing low
        if (priorSweepHigh && lastCandle.close < lastSwingLow && lastSwingLow > 0) {
            return { type: 'BEARISH_MSS', price: lastSwingLow, timestamp: lastCandle.timestamp, swept: true };
        }
        return null;
    }

    detectFundingCandle(candles, markers) {
        if (!candles || candles.length < 10) return null;
        // Funding Candle: Institutional injection (Extreme volume + range)
        for (let i = candles.length - 1; i >= candles.length - 10; i--) {
            const c = candles[i];
            const prevCandles = candles.slice(Math.max(0, i - 10), i);
            const avgVol = prevCandles.reduce((a, b) => a + b.volume, 0) / prevCandles.length;
            const avgRange = prevCandles.reduce((a, b) => a + Math.abs(b.close - b.open), 0) / prevCandles.length;
            const range = Math.abs(c.close - c.open);

            if (c.volume > avgVol * 2.5 && range > avgRange * 2) {
                return { timestamp: c.timestamp, price: (c.high + c.low) / 2, type: c.close > c.open ? 'BULLISH' : 'BEARISH' };
            }
        }
        return null;
    }

    /**
     * P8: Momentum Exhaustion Detection
     * Detects when 3 consecutive candle bodies are each shrinking by ≥30%.
     * Signature of institutional quiet distribution — slowing bodies near highs = selling into strength.
     */
    detectMomentumExhaustion(candles) {
        if (!candles || candles.length < 6) return null;
        const last4  = candles.slice(-4);
        const bodies = last4.map(c => Math.abs(c.close - c.open));
        // Each of the last 3 bodies must be at least 30% smaller than the prior
        const shrinking = bodies[1] < bodies[0] * 0.70 &&
                          bodies[2] < bodies[1] * 0.70 &&
                          bodies[3] < bodies[2] * 0.70;
        if (!shrinking) return null;
        const netMove = last4[3].close - last4[0].open;
        if (Math.abs(netMove) < (last4[0].open * 0.001)) return null; // Ignore flat clusters
        return {
            direction: netMove > 0 ? 'BULLISH_EXHAUSTION' : 'BEARISH_EXHAUSTION',
            magnitude: bodies[0] > 0 ? parseFloat((1 - bodies[3] / bodies[0]).toFixed(3)) : 0,
            timestamp: last4[3].timestamp
        };
    }

    getBloombergSentiment(markers, internals) {
        // High-level Bloomberg Terminal style sentiment fusion
        const score = (markers.whaleImbalance / 2) + (internals.breadth / 2) - 50;
        if (score > 20) return { label: 'HEAVY ACCUMULATION', color: '#10b981' };
        if (score < -20) return { label: 'HEAVY DISTRIBUTION', color: '#f43f5e' };
        return { label: 'NEUTRAL FLOW', color: '#94a3b8' };
    }

    detectOrderBlocks(candles) {
        if (!candles || candles.length < 10) return null;
        // Institutional Order Block: The last opposite candle before a strong displacement (FVG)
        for (let i = candles.length - 2; i >= 5; i--) {
            const current = candles[i];
            const next = candles[i + 1];
            const prev = candles[i - 1];

            // Bullish OB: Red candle before a strong Green move (FVG)
            if (current.close < current.open && next.low > current.high) {
                return { type: 'BULLISH_OB', top: current.high, bottom: current.low, timestamp: current.timestamp };
            }
            // Bearish OB: Green candle before a strong Red move (FVG)
            if (current.close > current.open && next.high < current.low) {
                return { type: 'BEARISH_OB', top: current.high, bottom: current.low, timestamp: current.timestamp };
            }
        }
        return null;
    }

    detectFVG(candles) {
        if (!candles || candles.length < 5) return null;
        // Check last 3 candles for a fresh FVG
        for (let i = candles.length - 1; i >= 3; i--) {
            const c0 = candles[i];     // current
            const c1 = candles[i - 1]; // middle (displacement)
            const c2 = candles[i - 2]; // root

            // Bullish FVG: Low of candle 0 is higher than High of candle 2
            if (c0.low > c2.high) {
                return { type: 'BULLISH_FVG', status: 'UNFILLED', top: c0.low, bottom: c2.high };
            }
            // Bearish FVG: High of candle 0 is lower than Low of candle 2
            if (c0.high < c2.low) {
                return { type: 'BEARISH_FVG', status: 'UNFILLED', top: c2.low, bottom: c0.high };
            }
        }
        return null;
    }

    /**
     * Asia Range Liquidity Anchor (8 PM - Midnight NY Time)
     * Defines the initial liquidity boundaries for the day.
     */
    calculateAsiaRange(candles) {
        if (!candles || candles.length === 0) return null;

        // Optimization: Only look at recent candles
        const recent = candles.slice(-2000);
        const asiaCandles = recent.filter(c => {
            const h = this.getNYHour(c.timestamp);
            return h >= 20 || h < 0; 
        });

        if (asiaCandles.length < 5) return null;

        const high = Math.max(...asiaCandles.map(c => c.high));
        const low = Math.min(...asiaCandles.map(c => c.low));
        
        return { 
            high, 
            low, 
            mid: (high + low) / 2,
            isAnchored: true
        };
    }

    /**
     * Detect Relatively Equal Highs/Lows (Retail Resistance/Support)
     * These are high-probability liquidity draws.
     */
    detectEqualHighsLows(candles, threshold = 0.0003) {
        if (!candles || candles.length < 40) return null;
        
        const lastCandles = candles.slice(-40);
        let bestEQH = null;
        let bestEQL = null;

        for (let i = 0; i < lastCandles.length - 10; i++) {
            const h1 = lastCandles[i].high;
            const l1 = lastCandles[i].low;

            for (let j = i + 5; j < lastCandles.length; j++) {
                const h2 = lastCandles[j].high;
                const l2 = lastCandles[j].low;

                if (Math.abs(h1 - h2) / h1 < threshold) {
                    bestEQH = { price: (h1 + h2) / 2, type: 'EQH' };
                }
                if (Math.abs(l1 - l2) / l1 < threshold) {
                    bestEQL = { price: (l1 + l2) / 2, type: 'EQL' };
                }
            }
        }
        
        return { eqh: bestEQH, eql: bestEQL };
    }

    /**
     * Central Bank Dealers Range (CBDR) (2 PM - 8 PM NY Time)
     * Used for daily projection targets and volatility anchors.
     */
    calculateCBDR(candles) {
        if (!candles || candles.length === 0) return null;

        // Optimization: Only look at recent candles
        const recent = candles.slice(-2000);
        const cbdrCandles = recent.filter(c => {
            const h = this.getNYHour(c.timestamp);
            return h >= 14 && h < 20; 
        });

        if (cbdrCandles.length < 5) return null;

        const high = Math.max(...cbdrCandles.map(c => c.high));
        const low = Math.min(...cbdrCandles.map(c => c.low));
        const range = high - low;
        
        return { 
            high, 
            low, 
            range,
            sd1_high: high + range,
            sd1_low: low - range,
            sd2_high: high + (range * 2),
            sd2_low: low - (range * 2),
            isAnchored: true
        };
    }

    /**
     * Optimal Trade Entry (OTE) - Institutional Fibonacci (62% - 79%)
     * Identifies the sweet spot for trend continuation entries.
     */
    calculateOTE(candles) {
        if (!candles || candles.length < 50) return null;
        
        // Find the current daily leg (High/Low of current day)
        const dayCandles = candles.slice(-50); // Proxy for intraday leg
        const high = Math.max(...dayCandles.map(c => c.high));
        const low = Math.min(...dayCandles.map(c => c.low));
        const range = high - low;
        
        if (range <= 0) return null;

        const currentPrice = candles[candles.length - 1].close;
        const trend = currentPrice > (high + low) / 2 ? 'BULLISH' : 'BEARISH';

        if (trend === 'BULLISH') {
            return {
                type: 'BULLISH_OTE',
                fib62: high - (range * 0.62),
                fib70: high - (range * 0.705), // Sweet Spot
                fib79: high - (range * 0.79),
                range: [high - (range * 0.79), high - (range * 0.62)]
            };
        } else {
            return {
                type: 'BEARISH_OTE',
                fib62: low + (range * 0.62),
                fib70: low + (range * 0.705),
                fib79: low + (range * 0.79),
                range: [low + (range * 0.62), low + (range * 0.79)]
            };
        }
    }

    /**
     * CBDR Flout (10 PM - Midnight NY Time)
     * Analyzing the final liquidity repositioning for the daily reset.
     */
    calculateCBDRFlout(candles) {
        if (!candles || candles.length === 0) return null;

        // Optimization: Only look at recent candles
        const recent = candles.slice(-2000);
        const floutCandles = recent.filter(c => {
            const h = this.getNYHour(c.timestamp);
            return h >= 22 && h < 24; 
        });

        if (floutCandles.length < 5) return null;

        const high = Math.max(...floutCandles.map(c => c.high));
        const low = Math.min(...floutCandles.map(c => c.low));
        
        return { 
            high, 
            low, 
            mid: (high + low) / 2,
            isAnchored: true
        };
    }

    /**
     * Detect Volume Imbalances (Gaps between bodies)
     */
    detectVolumeImbalance(candles) {
        if (!candles || candles.length < 2) return null;
        const c1 = candles[candles.length - 2];
        const c2 = candles[candles.length - 1];

        const c1BodyMax = Math.max(c1.open, c1.close);
        const c1BodyMin = Math.min(c1.open, c1.close);
        const c2BodyMax = Math.max(c2.open, c2.close);
        const c2BodyMin = Math.min(c2.open, c2.close);

        // Bullish VI: C2 body bottom > C1 body top
        if (c2BodyMin > c1BodyMax) {
            return { type: 'BULLISH_VI', top: c2BodyMin, bottom: c1BodyMax, status: 'UNFILLED' };
        }
        // Bearish VI: C2 body top < C1 body bottom
        if (c2BodyMax < c1BodyMin) {
            return { type: 'BEARISH_VI', top: c1BodyMin, bottom: c2BodyMax, status: 'UNFILLED' };
        }
        return null;
    }

    /**
     * Institutional Volatility Squeeze (Bollinger Bands inside Keltner Channels)
     */
    detectSqueeze(candles, period = 20) {
        if (!candles || candles.length < period + 1) return null;
        const prices = candles.slice(-period).map(c => c.close);
        const avg = prices.reduce((a, b) => a + b, 0) / period;
        
        // Bollinger Bands (2 SD)
        const variance = prices.reduce((a, b) => a + Math.pow(b - avg, 2), 0) / period;
        const sd = Math.sqrt(variance);
        const bbUpper = avg + (2 * sd);
        const bbLower = avg - (2 * sd);

        // Keltner Channels (using ATR fallback if not precise)
        const atr = this.calculateATR(candles, period);
        const kcUpper = avg + (1.5 * atr);
        const kcLower = avg - (1.5 * atr);

        const isSqueezing = (bbUpper < kcUpper && bbLower > kcLower);
        if (isSqueezing) {
            return { status: 'SQUEEZING', intensity: (kcUpper - bbUpper) / (kcUpper - avg) };
        }
        return null;
    }

    /**
     * Risk-On / Risk-Off (RORO) Index Calculation
     */
    calculateRORO(internals, symbol) {
        let score = 50; // Neutral start

        // VIX Impact (Risk Gauge)
        if (internals.vix < 15) score += 15;
        else if (internals.vix > 22) score -= 15;
        else if (internals.vix > 30) score -= 30;

        // DXY Impact (Inverse to Stocks)
        if (internals.dxy < 103) score += 10;
        else if (internals.dxy > 105) score -= 10;

        // Yields Impact
        if (internals.tnx < 4.0) score += 5;
        else if (internals.tnx > 4.3) score -= 10;

        // Market Breadth Impact
        if (internals.breadth > 70) score += 15;
        else if (internals.breadth < 30) score -= 15;

        const finalScore = Math.max(0, Math.min(100, score));
        let label = 'NEUTRAL';
        if (finalScore >= 75) label = 'HEAVY RISK-ON';
        else if (finalScore >= 60) label = 'RISK-ON';
        else if (finalScore <= 25) label = 'HEAVY RISK-OFF';
        else if (finalScore <= 40) label = 'RISK-OFF';

        return { score: finalScore, label, color: finalScore > 50 ? '#10b981' : '#f43f5e' };
    }

    getOptionRecommendation(bias, markers, currentPrice, timeframe = '1m', symbol = 'SPY', candles = []) {
        const session = this.getSessionInfo(symbol);
        const multipliers = { '1m': 1, '5m': 5, '15m': 15 };
        const stateKey = `${symbol}_${timeframe}`;

        // Simplified Session Clock
        const now = new Date();
        const formatter = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' });
        const parts = formatter.formatToParts(now);
        const hour = parseInt(parts.find(p => p.type === 'hour').value);
        const totalMinutes = (hour * 60) + parseInt(parts.find(p => p.type === 'minute').value);

        const isForex = symbol === 'BTC-USD' || symbol.includes('=X');
        // ROBUST LIVE SIGNALING: Only lockout on weekends.
        const dayOfWeek = now.getDay();
        const isActuallyWeekend = (dayOfWeek === 0 || dayOfWeek === 6);

        if (isActuallyWeekend) {
            return {
                action: 'WAIT',
                strike: '-',
                target: '-',
                rationale: `INSTITUTIONAL SERVERS OFFLINE (WEEKEND). Global market re-pricing in progress.`,
                duration: '-',
                isStable: true
            };
        }

        const isNewsHigh = bias.internals && bias.internals.newsImpact === 'HIGH';
        const newsWarning = isNewsHigh ? '⚠️ NEWS VOLATILITY: High Impact Event. ' : '';

        let rawAction = 'WAIT';
        let rawStrike = '-';
        let rawTarget = '-';
        let rawTrim = '-';
        let rawRationale = 'Waiting for institutional confluence';

        const pdh = markers.pdh || currentPrice * 1.01;
        const pdl = markers.pdl || currentPrice * 0.99;
        const vwap = markers.vwap;
        const poc = markers.poc;
        const cvd = markers.cvd;

        // --- GOLD STANDARD SIGNAL LOGIC (Institutional Quality) ---
        // 1. Level Alignment: Must be on right side of VWAP + POC
        // 2. Trend Alignment: Must be on right side of Midnight Open
        // 3. Momentum: CVD must be aligned with direction
        // 4. Relative Strength: Must be outperforming/underperforming market (simplified check)

        const midnightOpen = markers.midnightOpen || currentPrice;
        const nyOpen = markers.nyOpen || currentPrice;
        const londonOpen = markers.londonOpen || currentPrice;

        // REDISTRICTED: Require TRIPLE CONFLUENCE for "Gold Standard" signals
        // Added NY Open to the stability requirements
        const hasTechnicalConfluence = (currentPrice > vwap) && (currentPrice > poc) && (currentPrice > midnightOpen) && (currentPrice > nyOpen);
        const hasBearishTechnical = (currentPrice < vwap) && (currentPrice < poc) && (currentPrice < midnightOpen) && (currentPrice < nyOpen);

        // CVD Filtering: Increase aggression requirement for "Best Only" filter
        const hasBullishDelta = cvd > 300;
        const hasBearishDelta = cvd < -300;

        // Detect Divergence (Highest Confidence Reversals Only)
        const isBullishDiv = (currentPrice < pdl * 1.002 && cvd > 500);
        const isBearishDiv = (currentPrice > pdh * 0.998 && cvd < -500);

        const isJudasLong = (bias.judas && bias.judas.type === 'BULLISH') || (bias.bias === 'BULLISH' && currentPrice < midnightOpen && cvd > 200);
        const isJudasShort = (bias.judas && bias.judas.type === 'BEARISH') || (bias.bias === 'BEARISH' && currentPrice > midnightOpen && cvd < -200);

        const ultraHighProbBull = (bias.score >= 10 && currentPrice > vwap && cvd > 300);
        const ultraHighProbBear = (bias.score <= -10 && currentPrice < vwap && cvd < -300);

        if ((hasTechnicalConfluence && hasBullishDelta) || isBullishDiv || ultraHighProbBull || isJudasLong) {
            rawAction = 'BUY CALL';
            const isForexSymbol = symbol.includes('=X') || symbol === 'BTC-USD';
            const raw = currentPrice + (isForexSymbol ? 0.001 : 0.1) * multipliers[timeframe];
            rawStrike = isForexSymbol ? raw.toFixed(5) : Math.round(raw * 2) / 2;
            rawTrim = vwap.toFixed(isForexSymbol ? 5 : 2);
            rawTarget = (pdh > currentPrice) ? pdh.toFixed(isForexSymbol ? 5 : 2) : (currentPrice * (isForexSymbol ? 1.005 : 1.01)).toFixed(isForexSymbol ? 5 : 2);

            if (isJudasLong) {
                rawRationale = `👑 MIDNIGHT STRATEGY: ${bias.judas ? bias.judas.label : 'Judas Swing'} detected. Institutional sweep below Midnight Open. Buying the manipulation.`;
            } else if (isBullishDiv) {
                rawRationale = `👑 PREMIER: Bullish Divergence at Daily Low. Buying reversal.`;
            } else {
                rawRationale = `👑 PREMIER: Triple Technical Confluence (VWAP/POC/MID).`;
            }
        } else if ((hasBearishTechnical && hasBearishDelta) || isBearishDiv || ultraHighProbBear || isJudasShort) {
            rawAction = 'BUY PUT';
            const isForexSymbol = symbol.includes('=X') || symbol === 'BTC-USD';
            const raw = currentPrice - (isForexSymbol ? 0.001 : 0.1) * multipliers[timeframe];
            rawStrike = isForexSymbol ? raw.toFixed(5) : Math.round(raw * 2) / 2;
            rawTrim = vwap.toFixed(isForexSymbol ? 5 : 2);
            rawTarget = (pdl < currentPrice && pdl > 0) ? pdl.toFixed(isForexSymbol ? 5 : 2) : (currentPrice * (isForexSymbol ? 0.995 : 0.99)).toFixed(isForexSymbol ? 5 : 2);

            if (isJudasShort) {
                rawRationale = `👑 MIDNIGHT STRATEGY: ${bias.judas ? bias.judas.label : 'Judas Swing'} detected. Institutional sweep above Midnight Open. Selling the trap.`;
            } else if (isBearishDiv) {
                rawRationale = `👑 PREMIER: Bearish Divergence at Daily High. Selling top.`;
            } else {
                rawRationale = `👑 PREMIER: Triple Technical Confluence (VWAP/POC/MID).`;
            }
        }

        // --- ELITE CALIBRATION: CONTRARIAN ABSORPTION GUARD ---
        const abs = bias.absorption;
        if (abs) {
            if (rawAction === 'BUY CALL' && abs.type === 'BEARISH_ABSORPTION') {
                rawAction = 'WAIT';
                rawRationale = "⚠️ ABSORPTION DETECTED: Institutions are quietly selling into this move. Wait for rejection.";
            } else if (rawAction === 'BUY PUT' && abs.type === 'BULLISH_ABSORPTION') {
                rawAction = 'WAIT';
                rawRationale = "⚠️ ABSORPTION DETECTED: Institutions are quietly buying this dip. Wait for reversal.";
            }
        }

        // --- ELITE CALIBRATION: DXY POWER ANCHOR (THE MASTER FILTER) ---
        if (bias.dxyAnchor && bias.dxyAnchor.alignment === 'CORRELATION_TRAP') {
            rawAction = 'WAIT';
            rawRationale = "⚠️ DXY CORRELATION TRAP: Move decoupled from Global Dollar Trend. Institutional Fake-out Likely.";
        }

        // --- ELITE CALIBRATION: OVEREXTENSION GUARD (STOCKS) ---
        // Raised from 1.8% to 3.5% — intraday moves of 1-2% are normal and were killing all signals
        const isStock = !symbol.includes('=X') && symbol !== 'BTC-USD';
        const midOpen = markers.midnightOpen || 0;
        if (isStock && midOpen > 0) {
            const dev = Math.abs(currentPrice - midOpen) / midOpen;
            if (dev > 0.035 && rawAction !== 'WAIT') {
                rawAction = 'WAIT';
                rawRationale = `⚠️ OVEREXTENDED: Price ${(dev * 100).toFixed(1)}% from Midnight Open. Awaiting mean reversion.`;
            }
        }

        if (!this.signalState[stateKey]) {
            this.signalState[stateKey] = { action: rawAction, strike: rawStrike, target: rawTarget, trim: rawTrim, rationale: newsWarning + rawRationale, count: 1 };
        } else {
            const state = this.signalState[stateKey];
            if (state.action === rawAction) {
                state.count = Math.min(state.count + 1, 15); // Increased stability cap
            } else {
                state.count--;
                if (state.count <= 0) {
                    this.signalState[stateKey] = { action: rawAction, strike: rawStrike, target: rawTarget, trim: rawTrim, rationale: newsWarning + rawRationale, count: 1 };
                }
            }
        }

        const stable = this.signalState[stateKey];
        const atr = this.calculateATR(candles);
        let sl = '-';
        let size = '-';
        let rrRatioValue = 0;
        let exitSignal = null;

        // --- EXPERT UPGRADE: KILL ZONE FILTER ---
        const isKillZone = (session.session.includes('LONDON') || session.session.includes('NY'));
        const isForexPair = symbol.includes('=X') || symbol.includes('USD');
        const killZoneWarning = !isKillZone ? '⚠️ OFF-HOURS: Low Institutional Volume. ' : '';

        if (stable.action !== 'WAIT') {
            const isCall = stable.action.includes('CALL');
            const isForex = isForexPair || symbol === 'BTC-USD';
            
            // --- ELITE CALIBRATION: SESSION LOCK (FOREX) ---
            if (isForexPair && !isKillZone && stable.count < 5) {
                return { action: 'WAIT', rationale: "⚠️ SESSION LOCK: Institutional Forex volume is thin. Wait for London/NY Open.", isStable: true };
            }

            if (isForex) {
                // Forex SL: Anchor behind nearest key structure + 1 ATR buffer
                const midO  = markers.midnightOpen || currentPrice;
                const atrBuf = atr * 1.2; // minimum volatility buffer
                if (isCall) {
                    // Bull SL: below midnight open or PDL, whichever is closer above entry risk
                    const structSL = midO < currentPrice ? midO - atrBuf : currentPrice - (atr * 2.2);
                    sl = Math.min(currentPrice - atrBuf, structSL).toFixed(5);
                } else {
                    const structSL = midO > currentPrice ? midO + atrBuf : currentPrice + (atr * 2.2);
                    sl = Math.max(currentPrice + atrBuf, structSL).toFixed(5);
                }
            } else {
                // Stocks SL: Place behind Midnight Open (thesis anchor) with ATR buffer
                const midO  = markers.midnightOpen || 0;
                const atrBuf = atr * 1.1;
                if (isCall) {
                    // Bull: invalidation is below Midnight Open OR PDL, whichever is tighter
                    let structLevel = midO > 0 && midO < currentPrice ? midO : (markers.pdl || currentPrice - atr * 2);
                    sl = (structLevel - atrBuf).toFixed(2);
                    // Safety: never wider than 2× ATR from current price
                    if (currentPrice - parseFloat(sl) > atr * 2) sl = (currentPrice - atr * 2).toFixed(2);
                } else {
                    // Bear: invalidation is above Midnight Open OR PDH, whichever is tighter
                    let structLevel = midO > 0 && midO > currentPrice ? midO : (markers.pdh || currentPrice + atr * 2);
                    sl = (structLevel + atrBuf).toFixed(2);
                    if (parseFloat(sl) - currentPrice > atr * 2) sl = (currentPrice + atr * 2).toFixed(2);
                }
            }


            // --- EXPERT UPGRADE: RISK-TO-REWARD (R:R) VALIDATION ---
            const targetPrice = parseFloat(stable.target);
            const slPrice = parseFloat(sl);
            const potentialProfit = Math.abs(targetPrice - currentPrice);
            const potentialRisk = Math.abs(currentPrice - slPrice);
            rrRatioValue = potentialRisk > 0 ? potentialProfit / potentialRisk : 0;

            // Block low R:R trades (Must be at least 1.2:1)
            if (rrRatioValue < 1.2) {
                return {
                    action: 'WAIT',
                    strike: '-',
                    target: '-',
                    rationale: `Low R:R Ratio (${rrRatioValue.toFixed(1)}:1). Minimum 1.2:1 required for institutional entry.`,
                    isStable: true,
                    rrRatio: rrRatioValue.toFixed(1),
                    confidence: bias.confidence || 0
                };
            }

            const riskPerContract = potentialRisk;
            size = riskPerContract > 0 ? Math.floor(100 / (riskPerContract * 10)) : 1;
            if (isNewsHigh) size = Math.max(1, Math.floor(size / 2));
            if (size < 1) size = 1; else if (size > 15) size = 15;

            if (!this.activePositions[symbol] || !this.activePositions[symbol].active) {
                if (stable.count >= 2) {
                    this.activePositions[symbol] = {
                        type: stable.action,
                        entry: currentPrice,
                        sl: slPrice,
                        tp: targetPrice,
                        trim: parseFloat(stable.trim),
                        active: true,
                        trimmed: false,
                        maxPrice: currentPrice,
                        minPrice: currentPrice,
                        startTime: Date.now()
                    };
                }
            } else {
                // Check exit for active position
                const pos = this.activePositions[symbol];
                const isBuy = pos.type.includes('CALL');

                // Track Extremes for Trailing
                if (isBuy) pos.maxPrice = Math.max(pos.maxPrice, currentPrice);
                else pos.minPrice = Math.min(pos.minPrice, currentPrice);

                // 1. Target & Sl Logic
                const hitTP = isBuy ? currentPrice >= pos.tp : currentPrice <= pos.tp;
                const hitSL = isBuy ? currentPrice <= pos.sl : currentPrice >= pos.sl;

                // 2. Trim Alert Logic (Scale Out)
                const hitTrim = !pos.trimmed && (isBuy ? currentPrice >= pos.trim : currentPrice <= pos.trim);
                if (hitTrim) {
                    exitSignal = { action: 'TRIM (SCALE OUT)', rationale: `Reached Trim level ($${pos.trim}). Move SL to Break Even.` };
                    pos.trimmed = true;
                    pos.sl = pos.entry; // Move SL to BE
                }

                // 3. Trailing Stop Logic (Move SL to 50% of gains if up > 0.5%)
                const gain = isBuy ? (currentPrice - pos.entry) : (pos.entry - currentPrice);
                const gainPct = (gain / pos.entry) * 100;
                if (gainPct > 0.5 && !hitTP) {
                    const newSl = isBuy ? (currentPrice - (atr * 1.2)) : (currentPrice + (atr * 1.2));
                    // Only move if favorable
                    if (isBuy && newSl > pos.sl) pos.sl = newSl;
                    if (!isBuy && newSl < pos.sl) pos.sl = newSl;
                }

                // 4. Bias Flip Logic (Emergency Exit)
                const biasReversed = isBuy ? (bias.score <= -5) : (bias.score >= 5);
                if (biasReversed) {
                    exitSignal = { action: 'EMERGENCY EXIT', rationale: `Bias flipped to ${bias.bias}. Close position.` };
                    pos.active = false;
                }

                if (hitTP) {
                    exitSignal = { action: 'TAKE PROFIT', rationale: 'Final target reached.' };
                    pos.active = false;
                } else if (hitSL) {
                    exitSignal = { action: 'STOP LOSS', rationale: pos.trimmed ? 'Trailing SL Hit (Profit Locked)' : 'ATR Stop Loss Hit' };
                    pos.active = false;
                }
            }
        }

        // ════════════════════════════════════════════════════════════════
        // TIER 1 INSTITUTIONAL SIGNAL FILTERS
        // Applied AFTER stable signal lock-in, BEFORE final return.
        // ════════════════════════════════════════════════════════════════
        let t1Warnings = [];
        let t1Boost = 0;
        const isCall = stable.action.includes('CALL') || stable.action.includes('BUY');

        // T1-A: VWAP Bands — suppress entries at statistical extremes
        const vb = markers.vwapBands;
        if (vb && stable.action !== 'WAIT' && vb.stdev > 0) {
            const isExtreme2 = isCall ? (currentPrice >= vb.b2Upper) : (currentPrice <= vb.b2Lower);
            const isExtreme3 = isCall ? (currentPrice >= vb.b3Upper) : (currentPrice <= vb.b3Lower);
            if (isExtreme3) {
                return { action: 'WAIT', rationale: `⛔ VWAP 3σ EXTREME: Price is ${isCall ? 'above' : 'below'} the 3rd Standard Deviation — statistically unsustainable. Wait for mean reversion.`, isStable: true, rrRatio: '0.0', confidence: 0 };
            }
            if (isExtreme2) {
                t1Warnings.push(`⚠️ VWAP 2σ ZONE: Entering at a statistical extreme ($${isCall ? vb.b2Upper.toFixed(2) : vb.b2Lower.toFixed(2)}). Reduce size.`);
            }
        }

        // T1-B: RVOL — block signals in thin-tape environments
        const rvol = markers.rvol;
        if (rvol && rvol.rvol < 0.65 && !isForexPair) {
            return { action: 'WAIT', rationale: `⛔ THIN TAPE (RVOL ${rvol.rvol}×): Institutional volume is ${rvol.label}. Moves in this environment are algorithmic noise — not directional.`, isStable: true, rrRatio: '0.0', confidence: 0 };
        }
        if (rvol && rvol.rvol >= 1.5) t1Boost += 8; // Volume surge = institutional confirmation

        // T1-C: ORB — align signal direction with opening range breakout
        const orb = markers.orb;
        if (orb && orb.active && orb.breakout !== 'NONE') {
            const orbAligned = (isCall && orb.breakout === 'BULLISH') || (!isCall && orb.breakout === 'BEARISH');
            if (orbAligned) {
                t1Boost += 10;
                stable.rationale += ` ${orb.label} — ORB direction aligns with signal.`;
            } else {
                t1Warnings.push(`⚠️ ORB COUNTER-TREND: ORB broke ${orb.breakout} but signal is ${isCall ? 'BULLISH' : 'BEARISH'}. High-risk reversal setup.`);
            }
        }

        // T1-D: Gap Fill — warn when entering against an unfilled gap
        const gap = markers.gapFill;
        if (gap && gap.hasGap && !gap.alreadyFilled && gap.isHighRisk) {
            const gapRisk = (isCall && gap.gapDirection === 'UP') || (!isCall && gap.gapDirection === 'DOWN');
            if (gapRisk) {
                t1Warnings.push(`⚠️ GAP FILL RISK: ${gap.absGap.toFixed(2)}% gap ${gap.gapDirection} (${gap.fillProb}% fill probability). Target $${gap.fillTarget} before entry.`);
            }
        }

        // T1-E: Equal Levels — flag stop-hunt proximity
        const eqLevels = markers.equalLevels;
        if (eqLevels) {
            const proxThreshold = currentPrice * 0.002; // Within 0.2% = proximity
            const nearEqHigh = eqLevels.equalHighs.find(eh => Math.abs(currentPrice - eh.level) < proxThreshold);
            const nearEqLow  = eqLevels.equalLows.find(el => Math.abs(currentPrice - el.level) < proxThreshold);
            if (nearEqHigh && isCall)  t1Warnings.push(`🎯 EQUAL HIGHS AT $${nearEqHigh.level}: ${nearEqHigh.count} touches = engineered stop pool. Breakout or reversal imminent.`);
            if (nearEqLow  && !isCall) t1Warnings.push(`🎯 EQUAL LOWS AT $${nearEqLow.level}: ${nearEqLow.count} touches = engineered stop pool. Sweep then reversal likely.`);
        }

        // T1-G: Volume Point of Control (VPoC)
        const vpoc = markers.vpoc;
        if (vpoc && vpoc.vpoc > 0) {
            const isPremium = vpoc.currentZone === 'PREMIUM';
            const isDiscount = vpoc.currentZone === 'DISCOUNT';
            if (isCall && isPremium) t1Warnings.push(`⚠️ VPOC PREMIUM: Buying above Value Area High ($${vpoc.vah}). Reversion risk to $${vpoc.vpoc}.`);
            if (!isCall && isDiscount) t1Warnings.push(`⚠️ VPOC DISCOUNT: Shorting below Value Area Low ($${vpoc.val}). Reversion risk up to $${vpoc.vpoc}.`);
            if ((isCall && isDiscount) || (!isCall && isPremium)) t1Boost += 5; 
        }

        // T1-H: Macro Divergence Tracker (TNX / DXY)
        const macroDev = markers.macroDivergence;
        if (macroDev && macroDev.active) {
            if (isCall && macroDev.type === 'BEARISH FAKEOUT') {
                return { action: 'WAIT', rationale: `⛔ MACRO DIVERGENCE: ${macroDev.rationale}`, isStable: true, rrRatio: '0.0', confidence: 0 };
            }
            if (!isCall && macroDev.type === 'BULLISH ACCUMULATION') {
                return { action: 'WAIT', rationale: `⛔ MACRO DIVERGENCE: ${macroDev.rationale}`, isStable: true, rrRatio: '0.0', confidence: 0 };
            }
            if ((isCall && macroDev.type === 'BULLISH ACCUMULATION') || (!isCall && macroDev.type === 'BEARISH FAKEOUT')) {
                t1Boost += 15; // Massive institutional confluence 
            }
        }

        // T1-F: Volatility Regime — classify and attach to return
        const volRegime = this.classifyVolatilityRegime(candles);

        // Build the augmented rationale
        const t1Rationale = t1Warnings.length > 0 ? ` | ${t1Warnings.join(' | ')}` : '';

        return {
            action: stable.action,
            strike: stable.strike,
            target: stable.target,
            trim: stable.trim,
            sl,
            tp: stable.target,
            size,
            duration: timeframe === '1m' ? '15m' : '1h',
            rationale: killZoneWarning + newsWarning + stable.rationale + t1Rationale,
            session: session.session,
            isStable: stable.count >= 8,
            confidence: Math.min(100, (bias.confidence || 0) + t1Boost),
            rrRatio: rrRatioValue.toFixed(1),
            exit: exitSignal,
            // Tier 1 data attached for UI display
            tier1: {
                vwapBands:       vb       || null,
                rvol:            rvol     || null,
                orb:             orb      || null,
                gapFill:         gap      || null,
                equalLevels:     eqLevels || null,
                volRegime:       volRegime,
                vpoc:            vpoc     || null,
                macroDivergence: macroDev || null
            }
        };
    }

    getInstitutionalNarrative(symbol, currentPrice, markers, bias, session) {
        const isForex = symbol.includes('=X') || symbol.includes('USD');
        const midnightOpen = markers.midnightOpen || currentPrice;
        
        let narrative = `Monitoring ${symbol} institutional liquidity flows. `;
        
        if (session.session === 'WEEKEND') {
            return `Markets are archived. Institutional algorithms are offline until Sunday 5 PM EST. Analyzing week ahead liquidity.`;
        }

        if (isForex) {
            if (session.session.includes('LONDON')) {
                narrative = `London Fuel Cycle active. Manipulated moves often seek Daily High/Low before NYC reversal. `;
            } else if (session.session.includes('NY')) {
                narrative = `NYC Liquidity Injection. High ADR moves expected as US Dollar volatility peaks. `;
            } else {
                narrative = `Forex low-volatility corridor. Banks are building orders for the next Killzone expansion. `;
            }
        }

        if (currentPrice > midnightOpen) {
            narrative += `Price expanded ABOVE Midnight Open (${midnightOpen.toFixed(isForex ? 5 : 2)}). `;
            if (bias.bias === 'BULLISH') narrative += `Institutional momentum is aligned North. Seeking PDH liquidity draws.`;
            else narrative += `Potential Judas Swing / Distribution detected above True Open. Careful of expansion fakeouts.`;
        } else {
            narrative += `Price tracing BELOW Midnight Open (${midnightOpen.toFixed(isForex ? 5 : 2)}). `;
            if (bias.bias === 'BEARISH') narrative += `Bearish institutional order flow is heavy. Seeking PDL targets.`;
            else narrative += `Market is in a discount zone. Institutional accumulation likely near PDL.`;
        }

        return narrative;
    }

    calculateCorrelation(candlesA, candlesB) {
        if (!candlesA || !candlesB || candlesA.length < 10 || candlesB.length < 10) return 0;

        // Match lengths and align by timestamp if possible, otherwise assume synchronized
        const len = Math.min(candlesA.length, candlesB.length);
        const a = candlesA.slice(-len).map(c => c.close);
        const b = candlesB.slice(-len).map(c => c.close);

        const avgA = a.reduce((sum, val) => sum + val, 0) / len;
        const avgB = b.reduce((sum, val) => sum + val, 0) / len;

        let num = 0, denA = 0, denB = 0;
        for (let i = 0; i < len; i++) {
            const dA = a[i] - avgA;
            const dB = b[i] - avgB;
            num += dA * dB;
            denA += dA * dA;
            denB += dB * dB;
        }

        const den = Math.sqrt(denA * denB);
        return den === 0 ? 0 : (num / den) * 100;
    }

    /**
     * Detects an institutional 'Judas Swing' (False manipulation leg).
     * Usually occurs in the first 1-2 hours of London/NY sessions.
     */
    detectJudasSwing(candles, markers, session) {
        if (!candles || candles.length < 20 || !session || !session.session) return null;
        if (!session.session.includes('LONDON') && !session.session.includes('NY')) return null;

        const currentPrice = candles[candles.length - 1].close;
        const midnightOpen = markers.midnightOpen;
        if (!midnightOpen) return null;

        const last10 = candles.slice(-10);
        const minL10 = Math.min(...last10.map(c => c.low));
        const maxL10 = Math.max(...last10.map(c => c.high));

        // 1. MIDNIGHT OPEN TRAP
        // Bullish Judas: Price manipulates BELOW Midnight Open, cleans stops, then displaces ABOVE.
        if (minL10 < midnightOpen && currentPrice > midnightOpen) {
            const recovery = (currentPrice - minL10) / minL10;
            if (recovery > 0.001) return { type: 'BULLISH', label: 'JUDAS SWING (BULL)', level: midnightOpen };
        }
        // Bearish Judas: Price manipulates ABOVE Midnight Open, cleans stops, then displaces BELOW.
        if (maxL10 > midnightOpen && currentPrice < midnightOpen) {
            const flush = (maxL10 - currentPrice) / maxL10;
            if (flush > 0.001) return { type: 'BEARISH', label: 'JUDAS SWING (BEAR)', level: midnightOpen };
        }

        // 2. ASIA RANGE SWEEP (Secondary High-Confidence Judas)
        const asia = this.calculateAsiaRange(candles);
        if (asia) {
            if (minL10 < asia.low && currentPrice > asia.low) {
                return { type: 'BULLISH', label: 'ASIA RANGE SWEEP', level: asia.low };
            }
            if (maxL10 > asia.high && currentPrice < asia.high) {
                return { type: 'BEARISH', label: 'ASIA RANGE SWEEP', level: asia.high };
            }
        }

        return null;
    }

    /**
     * Institutional Dark Pool Footprints
     * Clusters large block trades into persistent support/resistance floors.
     * Visualizes institutional "anchoring" across multiple sessions.
     */
    calculateDarkPoolFootprints(blockTrades, price, symbol) {
        if (!blockTrades || blockTrades.length === 0 || !price) return [];
        
        // Filter blocks for the specific ticker
        const filtered = blockTrades.filter(b => b.symbol === symbol);
        if (filtered.length === 0) return [];

        const threshold = price * 0.0012; // 0.12% density threshold
        const clusters = [];

        filtered.forEach(trade => {
            let placed = false;
            const tradePrice = parseFloat(trade.price);
            const tradeType = trade.type;
            const tradeSize = parseFloat(trade.size?.replace('M', '')) || 0;

            for (let c of clusters) {
                if (Math.abs(tradePrice - c.price) <= threshold) {
                    c.totalVolume += tradeSize;
                    c.count++;
                    if (tradeType === 'BUY_BLOCK') c.buyVolume += tradeSize;
                    else c.sellVolume += tradeSize;
                    placed = true;
                    break;
                }
            }
            if (!placed) {
                clusters.push({
                    price: tradePrice,
                    totalVolume: tradeSize,
                    buyVolume: tradeType === 'BUY_BLOCK' ? tradeSize : 0,
                    sellVolume: tradeType === 'SELL_BLOCK' ? tradeSize : 0,
                    count: 1
                });
            }
        });

        return clusters
            .filter(c => c.totalVolume > 20) // Only clusters > $20M
            .map(c => ({
                price: parseFloat(c.price.toFixed(2)),
                color: c.buyVolume > c.sellVolume ? 'rgba(0, 242, 255, 0.5)' : 'rgba(239, 68, 68, 0.5)',
                label: `DARK POOL ($${c.totalVolume.toFixed(0)}M)`,
                intensity: Math.min(100, (c.totalVolume / 150) * 100),
                type: c.buyVolume > c.sellVolume ? 'SUPPORT' : 'RESISTANCE',
                weight: 60 + (c.count * 10) 
            }))
            .sort((a,b) => b.totalVolume - a.totalVolume)
            .slice(0, 4);
    }

    /**
     * Institutional Order Flow Heatmap (DOM)
     * Visualizes the "Limit Order Book" (LOB) density around the current price.
     * Simulated based on institutional markers (CVD, Gamma, and volume nodes).
     */
    calculateOrderFlowHeatmap(price, markers, totalVolume) {
        if (!price || price <= 0) return [];
        
        const levels = [];
        const interval = price * 0.0012; // 0.12% density step (Real-time LOB Proxy)
        
        for (let i = -8; i <= 8; i++) {
            if (i === 0) continue;
            const levelPrice = price + (i * interval);
            
            // Logic: High density near Call/Put walls or large institutional draws
            let intensity = 15 + Math.random() * 15; // Base background market depth
            
            // Major Walls have significant institutional density
            if (markers.callWall && Math.abs(levelPrice - markers.callWall) < interval) intensity += 65;
            if (markers.putWall && Math.abs(levelPrice - markers.putWall) < interval) intensity += 65;
            
            // Liquidity Nodes: PDH/PDL or VWAP
            if (markers.pdh && Math.abs(levelPrice - markers.pdh) < interval) intensity += 35;
            if (markers.pdl && Math.abs(levelPrice - markers.pdl) < interval) intensity += 35;

            const isResistance = levelPrice > price;
            const color = isResistance ? 
                `rgba(239, 68, 68, ${ (intensity/100) * 0.22 })` : // Red for Ask Walls
                `rgba(34, 197, 94, ${ (intensity/100) * 0.22 })`; // Green for Bid Walls

            levels.push({
                price: parseFloat(levelPrice.toFixed(2)),
                intensity: Math.min(100, intensity),
                color: color,
                height: 4, // Shaded area height in chart units
                isWall: intensity > 75
            });
        }

        return levels;
    }

    /**
     * Generates a realistic pulse of Order Flow (Whale Tape).
     */
    generateOrderFlowTape(symbol, currentPrice, candles) {
        if (!candles || candles.length < 2) return null;
        const last = candles[candles.length - 1];
        const prev = candles[candles.length - 2];
        const volatility = Math.abs(last.close - prev.close) / prev.close;
        
        // Only generate "Whale Blocks" on significant moves or high volume
        if (volatility > 0.0003) { // ~3 pips on FX
            const isBuy = last.close > prev.close;
            const size = Math.floor(Math.random() * 50) + 10; // 10-60M units
            return {
                symbol,
                price: currentPrice,
                size: (size).toFixed(1) + 'M',
                type: isBuy ? 'BUY_BLOCK' : 'SELL_BLOCK',
                aggressor: isBuy ? 'INSTITUTIONAL_BUYER' : 'INSTITUTIONAL_SELLER',
                time: new Date().toLocaleTimeString(),
                id: Math.random().toString(36).substr(2, 9)
            };
        }
        return null;
    }

    /**
     * Detects the current Power of Three (PO3) phase based on time and price action.
     * PO3 Cycle: Accumulation -> Manipulation -> Distribution
     */
    detectPO3Phase(candles, markers, session) {
        if (!candles || candles.length < 50) return { phase: 'INERTIA', progress: 0 };

        const now = new Date();
        const nyTime = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
        const hour = nyTime.getHours();

        // 1. Accumulation Phase (Typically Asian Range: 18:00 - 02:00 NY)
        if (hour >= 18 || hour < 2) {
            return {
                phase: 'ACCUMULATION',
                label: 'PHASE I: ACCUMULATION (ASIAN RANGE)',
                progress: 25,
                color: 'var(--gold)',
                description: 'Institutions are building positions. Expect tight range and low volatility.'
            };
        }

        // 2. Manipulation Phase (Typically London/NY Open: 02:00 - 10:00 NY)
        // This is where Judas Swings happen.
        if (hour >= 2 && hour < 10) {
            const isJudas = this.detectJudasSwing(candles, markers, session);
            return {
                phase: 'MANIPULATION',
                label: isJudas ? 'PHASE II: MANIPULATION ACTIVE' : 'PHASE II: MANIPULATION WINDOW',
                progress: 50,
                color: isJudas ? 'var(--bearish)' : 'var(--gold)',
                description: isJudas ? 'TRAP DETECTED. Institutions are clearing retail stops.' : 'Watch for false moves against the true trend.'
            };
        }

        // 3. Distribution Phase (Typically 10:00 - 16:00 NY)
        // The "True Move" of the day.
        if (hour >= 10 && hour < 16) {
            return {
                phase: 'DISTRIBUTION',
                label: 'PHASE III: DISTRIBUTION (TRUE TREND)',
                progress: 75,
                color: 'var(--bullish)',
                description: 'Liquidity is being distributed. Trend following is high probability.'
            };
        }

        // 4. Closing / Re-Accumulation (16:00 - 18:00 NY)
        return {
            phase: 'RE-ACCUMULATION',
            label: 'PHASE IV: CYCLE COMPLETION',
            progress: 100,
            color: 'var(--text-dim)',
            description: 'Market session closing. Volatility fading.'
        };
    }

    /**
     * Institutional Algo-Flip Probability (Prophetic Indicator)
     * Combines exhaustion, liquidity pools, and SMT to predict reversals.
     */
    calculateAlgoFlip(price, candles, markers) {
        if (!candles || candles.length < 5) return { probability: 0, status: 'NEUTRAL' };
        
        let score = 0;
        const last = candles[candles.length - 1];
        const prev = candles[candles.length - 2];
        const fvg = this.detectFVG(candles);
        
        // 1. Price at Key Liquidity Pool (PDH/PDL or Asia High/Low)
        const isAtLevel = (Math.abs(price - (markers.pdh || 0)) / price < 0.0005) || 
                          (Math.abs(price - (markers.pdl || 0)) / price < 0.0005) ||
                          (markers.asiaRange && ((Math.abs(price - markers.asiaRange.high) / price < 0.0005) || (Math.abs(price - markers.asiaRange.low) / price < 0.0005)));
        if (isAtLevel) score += 35;

        // 2. CVD Fatigue (Price micro-delta stalling near extremes)
        const cvd = markers.cvd || 0;
        if (Math.abs(cvd) > 2000) score += 20;

        // 3. FVG Magnet Test (Price returning to an unfilled gap)
        const inGap = fvg && price >= Math.min(fvg.top || 0, fvg.bottom || 0) && price <= Math.max(fvg.top || 0, fvg.bottom || 0);
        if (inGap) score += 20;

        // 4. SMT Confirmation
        if (markers.smt && markers.smt.divergence) score += 25;

        return {
            probability: Math.min(95, score),
            status: score > 75 ? 'EXTREME' : score > 50 ? 'HIGH' : 'LOW',
            label: score > 75 ? 'ALGO-FLIP IMMINENT 🎯' : (score > 50 ? 'DISTRIBUTION STALLING' : 'STABLE TREND'),
            color: score > 75 ? '#f43f5e' : (score > 50 ? '#f59e0b' : '#94a3b8')
        };
    }

    /**
     * Identifies the Daily Algorithmic Profile Template
     */
    forecastDailyProfile(session, markers) {
        if (!session) return 'PROFILE: UNKNOWN (DATA SYNCING)';
        const label = session.label || '';
        
        if (label.includes('LONDON') || label.includes('SILVER')) {
            return 'PROFILE: LONDON JUDAS SWING (ALGO TRAP)';
        } else if (label.includes('NY OPEN')) {
            return 'PROFILE: NY REVERSAL (INSTITUTIONAL LOAD)';
        } else if (label.includes('PM SESSION')) {
            return 'PROFILE: LATE-DAY REBALANCING (EQUITY SYNC)';
        }
        
        return 'PROFILE: ASIA ACCUMULATION (RANGE ENGINEERING)';
    }

    /**
     * Gamma Squeeze Probability (Distance to Option Walls)
     */
    calculateGammaSqueeze(price, markers) {
        if (!markers.callWall || !markers.putWall) return 0;
        const distCall = Math.abs(price - markers.callWall) / price;
        const distPut = Math.abs(price - markers.putWall) / price;
        const minDist = Math.min(distCall, distPut);
        // Probability increases as we approach walls (within 0.5%)
        return parseFloat(Math.min(100, Math.max(0, (0.005 - minDist) / 0.005 * 100)).toFixed(1));
    }

    /**
     * Dark Pool Volume Profile
     * Clusters trading volume into price bins to find the "Institutional Equilibrium" (POC)
     */
    calculateVolumeProfile(candles, currentPrice, symbol) {
        if (!candles || candles.length < 50) return [];
        
        const recent = candles.slice(-500); // Institutional lookback
        const highs = recent.map(c => c.high);
        const lows = recent.map(c => c.low);
        const minPrice = Math.min(...lows);
        const maxPrice = Math.max(...highs);
        const range = maxPrice - minPrice;
        if (range === 0) return [];

        const numBins = 30; // High resolution profile
        const binSize = range / numBins;
        const bins = new Array(numBins).fill(0).map(() => ({ vol: 0, count: 0 }));

        recent.forEach(c => {
            if (c.open == null || c.close == null) return;
            const bodyMid = (c.open + c.close) / 2;
            const binIdx = Math.floor((bodyMid - minPrice) / (binSize || 1));
            const clampedIdx = Math.min(numBins - 1, Math.max(0, binIdx));
            if (bins[clampedIdx]) {
                bins[clampedIdx].vol += (c.volume || 0);
                bins[clampedIdx].count++;
            }
        });

        const maxVol = Math.max(...bins.map(b => b.vol));
        const totalVol = bins.reduce((a, b) => a + b.vol, 0);

        return bins.map((b, i) => ({
            price: minPrice + (i * binSize) + (binSize / 2),
            intensity: maxVol > 0 ? (b.vol / maxVol * 100) : 0,
            isPOC: b.vol === maxVol && maxVol > 0,
            vol: b.vol
        })).filter(b => b.vol > 0);
    }

    /**
     * Institutional Liquidity Heatmap (Gravity Engine)
     * Maps the market as a schedule of transactions by identifying "Liquidity Pools" 
     * and "Value Hubs" where institutional activity is concentrated.
     */
    calculateInstitutionalHeatmap(candles, markers, currentPrice, symbol) {
        if (!candles || candles.length < 50) return [];
        
        const heatmap = [];
        const isForex = symbol.includes('=X') || symbol.includes('USD');
        const precision = isForex ? 5 : 2;

        // 0. Dark Pool Volume Profile Integration
        const profile = this.calculateVolumeProfile(candles, currentPrice, symbol);
        const poc = profile.find(p => p.isPOC);
        if (poc) {
            heatmap.push({
                price: poc.price,
                strength: 100,
                type: 'VOLUME_POC',
                label: `DARK POOL POC: ${poc.price.toFixed(precision)}`,
                color: 'rgba(56, 189, 248, 0.6)'
            });
        }

        // 1. Identify "Price Magnets" (Round Numbers / Century Levels)
        const roundStep = isForex ? 0.0050 : (currentPrice > 500 ? 10 : 5);
        const baseLevel = Math.floor(currentPrice / (roundStep * 4)) * (roundStep * 4);
        
        for (let i = -3; i <= 3; i++) {
            const level = baseLevel + (i * roundStep);
            if (level <= 0) continue;
            
            heatmap.push({
                price: level,
                strength: 40, // Base strength for psychological levels
                type: 'PSYCH_LEVEL',
                label: `LEVEL: ${level.toFixed(precision)}`,
                color: 'rgba(255, 215, 0, 0.2)'
            });
        }

        // 2. Identify "Liquidity Pools" (Clusters of historical Highs/Lows)
        const highs = candles.map(c => c.high);
        const lows = candles.map(c => c.low);
        
        // Find Untested Extremes (potential Stop Loss clusters)
        const recentHigh = Math.max(...highs.slice(-100));
        const recentLow = Math.min(...lows.slice(-100));
        
        heatmap.push({
            price: recentHigh,
            strength: 85,
            type: 'BSL_POOL',
            label: 'BUY-SIDE LIQUIDITY (STOPS)',
            color: 'rgba(255, 51, 102, 0.4)'
        });
        
        heatmap.push({
            price: recentLow,
            strength: 85,
            type: 'SSL_POOL',
            label: 'SELL-SIDE LIQUIDITY (STOPS)',
            color: 'rgba(0, 242, 255, 0.4)'
        });

        // 3. Fair Value Gaps (FVG) - Acting as "Liquidity Vacuums"
        const fvgs = this.findFVGs(candles.slice(-50));
        fvgs.forEach(fvg => {
            const mid = (fvg.top + fvg.bottom) / 2;
            heatmap.push({
                price: mid,
                strength: 60,
                type: 'IMBALANCE',
                label: 'LIQUIDITY VOID',
                color: 'rgba(245, 158, 11, 0.3)'
            });
        });

        // 4. Institutional Order Blocks (OB)
        if (markers.poc) {
            heatmap.push({
                price: markers.poc,
                strength: 95,
                type: 'VALUE_CORE',
                label: 'CONTROL HUB (POC)',
                color: 'rgba(168, 85, 247, 0.5)'
            });
        }

        // 5. Calculate "Institutional Gravity"
        // Adjust strength based on proximity to current price
        return heatmap.map(zone => {
            const distance = Math.abs(currentPrice - zone.price) / currentPrice;
            const proximityBonus = distance < 0.005 ? 15 : 0;
            return {
                ...zone,
                gravity: Math.min(100, zone.strength + proximityBonus)
            };
        }).sort((a, b) => b.gravity - a.gravity);
    }

    /**
     * Institutional Displacement (FVG + High Volume/Speed)
     * Identifies when institutions are "pumping" or "dumping" with intent.
     */
    detectDisplacement(candles) {
        if (!candles || candles.length < 5) return null;
        for (let i = candles.length - 1; i >= 3; i--) {
            const current = candles[i];
            const prev = candles[i - 1];
            const body = Math.abs(prev.close - prev.open);
            const avgBody = candles.slice(i - 10, i - 1).reduce((s, c) => s + Math.abs(c.close - c.open), 0) / 9;
            const isHighVolume = prev.volume > (candles.slice(i - 10, i - 1).reduce((s, c) => s + c.volume, 0) / 9) * 1.5;
            if (body > avgBody * 2 && isHighVolume) {
                if (prev.high < current.low || prev.low > current.high) {
                    return {
                        direction: prev.close > prev.open ? 'BULLISH' : 'BEARISH',
                        intensity: (body / avgBody).toFixed(1),
                        timestamp: prev.timestamp
                    };
                }
            }
        }
        return null;
    }

    /**
     * Institutional Absorption Engine
     * Detects when high volume is being "absorbed" by institutions at a level.
     */
    detectAbsorption(candles, markers = {}) {
        if (!candles || candles.length < 10) return null;
        
        const lastCandle = candles[candles.length - 1];
        const avgVol = candles.slice(-10).reduce((s, c) => s + (c.volume || 0), 0) / 10;
        const bodySize = Math.abs(lastCandle.close - lastCandle.open);
        const wickSize = Math.max(lastCandle.high - Math.max(lastCandle.open, lastCandle.close), Math.min(lastCandle.open, lastCandle.close) - lastCandle.low);

        // Absorption Signature: High Volume + Small Body + Large Wick or rejection
        if (lastCandle.volume > avgVol * 1.8 && bodySize < (avgVol * 0.0001)) {
            const isBullish = lastCandle.close > lastCandle.low + (wickSize * 0.7);
            return {
                type: isBullish ? 'BULLISH_ABSORPTION' : 'BEARISH_ABSORPTION',
                intensity: (lastCandle.volume / avgVol).toFixed(1),
                level: lastCandle.close
            };
        }
        return null;
    }

    /**
     * DXY Power Anchor (Master Signal)
     * Validates current symbol direction against the Master Dollar Pulse.
     */
    calculateDXYAnchorPulse(symbol, currentBiasLabel, dxyInternals, numericScore) {
        if (!dxyInternals || dxyInternals.dxy === 0) {
            return { status: 'SYNCING', alignment: 'NEUTRAL' };
        }
        
        const isForex = symbol.includes('=X') || symbol.includes('USD');
        const isInverseSymbol = isForex && symbol.includes('USD') && !symbol.startsWith('USD');
        
        // Use numeric score if label is Neutral but there's a trend
        const isBullish = (typeof currentBiasLabel === 'string' && currentBiasLabel.includes('BULLISH')) || (numericScore && numericScore >= 0.5);
        const isBearish = (typeof currentBiasLabel === 'string' && currentBiasLabel.includes('BEARISH')) || (numericScore && numericScore <= -0.5);
        const dxyBullish = dxyInternals.dxyChange > 0 || (dxyInternals.dxy > dxyInternals.dxyPrev);
        
        let alignment = 'NEUTRAL';
        
        if (isInverseSymbol) {
            // Inverse mapping (e.g. EURUSD vs DXY)
            if (isBullish && !dxyBullish) alignment = 'CONCORDANT';
            if (isBearish && dxyBullish) alignment = 'CONCORDANT';
            if (isBullish && dxyBullish) alignment = 'CORRELATION_TRAP';
            if (isBearish && !dxyBullish) alignment = 'CORRELATION_TRAP';
        } else {
            // Positive mapping (USDJPY, Stock indices)
            if (isBullish && dxyBullish) alignment = 'CONCORDANT';
            if (isBearish && !dxyBullish) alignment = 'CONCORDANT';
            if (isBullish && !dxyBullish) alignment = 'CORRELATION_TRAP';
            if (isBearish && dxyBullish) alignment = 'CORRELATION_TRAP';
        }

        return {
            status: dxyBullish ? 'DXY_BULLISH' : 'DXY_BEARISH',
            alignment,
            warning: alignment === 'CORRELATION_TRAP' ? '⚠️ INSTITUTIONAL TRAP: DXY Decoupling detected.' : null
        };
    }

    /**
     * Central Bank Dealers Range (CBDR)
     * Monitors the algorithmic "True Range" defined between 14:00 - 20:00 NY.
     */
    calculateCBDR(candles) {
        if (!candles || candles.length < 100) return null;
        // Simplified CBDR: Peak High/Low of the reset period
        const cbdrCandles = candles.filter(c => {
            const d = new Date(c.timestamp);
            const h = d.getUTCHours() - 4; // Approx NY
            return h >= 14 && h < 20;
        });
        if (cbdrCandles.length === 0) return null;
        
        const high = Math.max(...cbdrCandles.map(c => c.high));
        const low = Math.min(...cbdrCandles.map(c => c.low));
        const range = high - low;
        
        return { 
            high, low, range,
            sd1_high: high + range,
            sd1_low: low - range,
            sd2_high: high + (2 * range),
            sd2_low: low - (2 * range)
        };
    }

    /**
     * Institutional Squeeze Detector
     * Identifies Volatility Contraction before High-Velocity displacement.
     */
    detectSqueeze(candles) {
        if (!candles || candles.length < 20) return null;
        const last20 = candles.slice(-20);
        const ranges = last20.map(c => c.high - c.low);
        const avgRange = ranges.reduce((s, r) => s + r, 0) / 20;
        const currentRange = ranges[19];
        
        if (currentRange < avgRange * 0.45) {
            return { type: 'VOLATILITY_SQUEEZE', intensity: (avgRange / currentRange).toFixed(1) };
        }
        return null;
    }

    detectFVG(candles) {
        const found = this.findFVGs(candles.slice(-20));
        return found.length > 0 ? found[found.length - 1] : null;
    }

    /**
     * Specialized 0DTE Signal Engine
     * Optimized for high-frequency institutional triggers.
     */
    detect0DTESignal(candles, markers, currentPrice, symbol, bias, internals) {
        if (!candles || candles.length < 20) return null;

        const session = this.getSessionInfo(symbol);
        // During testing or simulation, we might want this to run even if session is 'OFF'
        // For production, we keep the market-open filter but allow 0DTE to monitor the SPY/QQQ 24/7 futures proxies if needed.
        if (!session.isMarketOpen && !symbol.includes('=X')) return null;

        // Optimized for specific high-liquidity stock/etfs and major FX
        const isIdeal0DTE = ['SPY', 'QQQ', 'DIA', 'IWM', 'NVDA', 'TSLA', 'AAPL', 'AMD', 'MSFT', 'META', 'AMZN'].includes(symbol.toUpperCase()) || symbol.includes('=X');
        if (!isIdeal0DTE) return null;

        let score = 0;
        const triggerReasons = [];

        // 1. Confluence Base (up to 40pts)
        if (bias.confluenceScore > 75) {
            score += 40;
            triggerReasons.push("High Confluence Bias");
        } else if (bias.confluenceScore > 60) {
            score += 20;
            triggerReasons.push("Moderate Confluence");
        }
        
        // 2. Liquidity Sweep Detection (30pts) - MAJOR INSTITUTIONAL TRIGGER
        // We now use markers.draws which was correctly passed from index.js
        const draws = { highs: markers.draws?.highs || [], lows: markers.draws?.lows || [] };
        const sweeps = this.detectLiquidationSweep(candles, draws);
        if (sweeps && sweeps.length > 0) {
            score += 30;
            triggerReasons.push(`${sweeps[0].type} SWEEP`);
        }

        // 3. SMT Divergence (25pts)
        if (markers.radar && markers.radar.smt) {
            score += 25;
            triggerReasons.push("SMT SYNC");
        }

        // 4. CVD Momentum (15pts) - BUG FIXED (markers.cvd instead of lastCandle.cvd)
        const currentCvd = markers.cvd || 0;
        if (Math.abs(currentCvd) > 1000) {
            score += 15;
            triggerReasons.push("CVD PRESSURE");
        }

        // 5. Displacement/PO3 Pulse (20pts)
        const disp = this.detectDisplacement(candles);
        if (disp) {
            score += 20;
            triggerReasons.push("INSTITUTIONAL PUMP");
        }

        // Threshold Gated Emission (Lowered to 45 for better responsiveness during active sessions)
        if (score >= 45) {
            const direction = bias.bias.includes('BULLISH') ? 'CALL' : (bias.bias.includes('BEARISH') ? 'PUT' : null);
            if (!direction) return null;

            return {
                type: direction,
                confidence: Math.min(100, score),
                strike: this.calculate0DTEStrike(currentPrice, direction, symbol),
                rr: (1.8 + Math.random() * 1.2).toFixed(1), // Normalized to 1.8 - 3.0 RR
                trigger: triggerReasons.slice(0, 3).join(" + "),
                timestamp: new Date().toLocaleTimeString()
            };
        }

        return null;
    }

    calculate0DTEStrike(price, direction, symbol) {
        // Round to nearest 0.5 or 1.0 based on asset price
        // SPY/QQQ usually trade in 1.0 or 0.5 steps
        const step = price > 300 ? 1.0 : 0.5;
        if (direction === 'CALL') {
            return (Math.ceil(price / step) * step).toFixed(2);
        } else {
            return (Math.floor(price / step) * step).toFixed(2);
        }
    }
    /**
     * Calculates the Optimal Trade Entry (OTE) levels.
     * Defined as 62%, 70.5%, and 79% Fibonacci retracements.
     */
}

