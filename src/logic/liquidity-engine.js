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
     * Identifies current trading session based on US Market Hours.
     */
    getSessionInfo(symbol = 'SPY') {
        const now = new Date();
        const nyTime = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
        const hour = nyTime.getHours();
        const minute = nyTime.getMinutes();
        const day = nyTime.getDay();
        const isWeekend = day === 0 || (day === 6 && hour < 17); // Saturday or early Sunday
        const totalMinutes = (hour * 60) + minute;

        const isForex = symbol === 'BTC-USD' || symbol.includes('=X');
        const marketOpen = 570; // 9:30 AM
        const marketClose = 960; // 4:00 PM

        // Forex is 24/5. US Market is 9:30-4:00.
        let isMarketOpen = !isWeekend && totalMinutes >= marketOpen && totalMinutes < marketClose;
        if (isForex && !isWeekend) isMarketOpen = true;

        if (isWeekend) return { session: 'WEEKEND', status: 'MARKET CLOSED', color: '#ff3366', isMarketOpen: false };

        if (!isForex) {
            if (totalMinutes >= 600 && totalMinutes <= 660) return { session: 'SILVER_BULLET', status: 'ALGO EXPANSION', color: '#f59e0b', isMarketOpen: true };
            if (totalMinutes >= 570 && totalMinutes <= 660) return { session: 'NY_OPEN', status: 'HIGH VOLATILITY', color: '#00f2ff', isMarketOpen: true };
            if (totalMinutes > 660 && totalMinutes < 780) return { session: 'NY_AM', status: 'TRENDING', color: '#00ff88', isMarketOpen: true };
            if (totalMinutes >= 780 && totalMinutes <= 810) return { session: 'LUNCH', status: 'CONSOLIDATION', color: '#94a3b8', isMarketOpen: true };
            if (totalMinutes > 810 && totalMinutes <= 960) return { session: 'NY_PM', status: 'EOD DRIVE', color: '#00f2ff', isMarketOpen: true };
            if (totalMinutes > 960 && totalMinutes <= 1200) return { session: 'POST_MARKET', status: 'LOW LIQUIDITY', color: '#6366f1', isMarketOpen: true };

            return { session: 'OFF_HOURS', status: 'MARKET CLOSED', color: '#334155', isMarketOpen: false };
        } else {
            // Forex-specific Follow-The-Sun Session logic
            if (hour >= 3 && hour < 4) return { session: 'LONDON_BULLET', status: 'ALGO EXPANSION', color: '#f59e0b', isMarketOpen: true };
            if (hour >= 2 && hour < 5) return { session: 'LONDON_OPEN', status: 'HIGH VOLUME', color: '#00f2ff', isMarketOpen: true };
            if (hour >= 5 && hour < 11) return { session: 'LONDON_DRIVE', status: 'TRENDING', color: '#00ff88', isMarketOpen: true };
            if (hour >= 8 && hour < 12) return { session: 'NY_OVERLAP', status: 'PEAK LIQUIDITY', color: '#f59e0b', isMarketOpen: true };
            if (hour >= 18 || hour < 20) return { session: 'ASIA_OPEN', status: 'ACCUMULATION', color: '#94a3b8', isMarketOpen: true };
            if (hour >= 20 || hour < 3) return { session: 'TOKYO_DRIVE', status: 'STEADY', color: '#6366f1', isMarketOpen: true };
            return { session: 'GLOBAL_FLOW', status: 'STEADY', color: '#334155', isMarketOpen: true };
        }
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
            bullish += (move * 30); // If price up 1%, retail +30% bullish
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
        let bullishScore = 0;
        let bearishScore = 0;
        const isForex = symbol.includes('=X') || symbol === 'BTC-USD';
        const isUSDQuote = symbol.includes('USD') && !symbol.startsWith('USD'); // e.g., EURUSD

        // --- DXY CORRELATION (Critical for Forex) ---
        if (isForex && internals.dxy > 0) {
            const dxyStrength = internals.dxy > 102.5; // Institutional base
            const dxyBullish = internals.dxyChange > 0;
            
            if (isUSDQuote) {
                // If EURUSD/GBPUSD: DXY UP = BEARISH, DXY DOWN = BULLISH
                if (dxyBullish) bearishScore += 4.0;
                else bullishScore += 3.0;
            } else if (symbol.startsWith('USD')) {
                // If USDJPY/USDCAD: DXY UP = BULLISH, DXY DOWN = BEARISH
                if (dxyBullish) bullishScore += 4.0;
                else bearishScore += 3.0;
            }
        }

        // --- VIX DYNAMIC SENSITIVITY (Fear Gauge) ---
        if (!isForex) {
            const vix = internals.vix || 0;
            const vixPrev = internals.vixPrev || vix;
            const vixVelocity = vixPrev > 0 ? (vix - vixPrev) / vixPrev : 0;

            if (vix > 20) bearishScore += 2;
            if (vix > 30) { bearishScore += 5; bullishScore -= 3; }

            // Fear Spike: If VIX jumps > 2% rapidly, suppress longs
            if (vixVelocity > 0.02) {
                bearishScore += 4;
                bullishScore -= 5;
            }
        }

        // --- DXY & YIELD HEADWINDS (Macro Filters) ---
        if (!isForex) {
            const dxy = internals.dxy || 0;
            const tnx = internals.tnx || 0; // 10Y Yield
            
            // Strong Dollar = Headwind for Stocks
            if (dxy > 104.5) bearishScore += 2; 

            // Rising Yields = Headwind for Tech
            const isTech = ['QQQ', 'NVDA', 'AAPL', 'MSFT', 'AMD', 'SMH'].includes(symbol);
            if (isTech && tnx > 4.2) bearishScore += 3; // Yields above 4.2% pressure tech
        }

        // --- SECTOR UNDER THE HOOD CHECK ---
        if (internals.sectors && internals.sectors.length > 0) {
            const tech = internals.sectors.find(s => s.symbol === 'XLK');
            const cons = internals.sectors.find(s => s.symbol === 'XLY');
            const fin = internals.sectors.find(s => s.symbol === 'XLF');

            // If Technology is strong, it's a tailwind for SPY/QQQ/Tech stocks
            const techHeavy = ['SPY', 'QQQ', 'NVDA', 'AAPL', 'MSFT', 'AMD', 'SMH'];
            if (techHeavy.includes(symbol) && tech) {
                if (tech.change > 0.3) bullishScore += 3; // Increased impact
                else if (tech.change < -0.3) bearishScore += 3;
            }

            // Market Breadth (Percentage of watchlist trending)
            const breadth = internals.breadth || 0;
            if (breadth > 70) bullishScore += 2; // 70%+ of market is bullish
            else if (breadth < 30) bearishScore += 2; // 70%+ of market is bearish
        }

        const vwap = markers.vwap || 0;
        const poc = markers.poc || 0;
        const cvd = markers.cvd || 0;
        const midnightOpen = markers.midnightOpen || 0;
        const londonOpen = markers.londonOpen || 0;
        const nyOpen = markers.nyOpen || 0;
        let confPoints = 0;

        if (bloombergMetrics.wei === 'BULLISH') bullishScore += 3;
        if (bloombergMetrics.wei === 'BEARISH') bearishScore += 3;
        if (bloombergMetrics.omon === 'CALL_BUYING') bullishScore += 2;
        if (bloombergMetrics.omon === 'PUT_BUYING') bearishScore += 2;
        if (bloombergMetrics.btm === 'SELL_BLOCKS') bearishScore += 2;
        if (bloombergMetrics.btm === 'BUY_BLOCKS') bullishScore += 2;

        // VWAP & POC Confluence
        if (vwap > 0 && currentPrice > vwap) bullishScore += 1.5;
        if (vwap > 0 && currentPrice < vwap) bearishScore += 1.5;
        if (poc > 0 && currentPrice > poc) bullishScore += 1;
        if (poc > 0 && currentPrice < poc) bearishScore += 1;

        // Midnight Open Strategy
        if (midnightOpen > 0) {
            if (currentPrice > midnightOpen) bullishScore += 2;
            else if (currentPrice < midnightOpen) bearishScore += 2;
        }

        // London Open (03:00 EST) Confluence
        if (londonOpen > 0) {
            if (currentPrice > londonOpen) bullishScore += 1;
            else if (currentPrice < londonOpen) bearishScore += 1;
        }

        // NY Open (09:30 EST) Confluence
        if (nyOpen > 0) {
            const nyDiff = Math.abs(currentPrice - nyOpen) / nyOpen;
            if (currentPrice > nyOpen) bullishScore += 3;
            else if (currentPrice < nyOpen) bearishScore += 3;

            // NY Rejection (Trap) logic
            if (nyDiff < 0.0005) {
                if (cvd > 500) bullishScore += 2;
                if (cvd < -500) bearishScore += 2;
            }
        }

        if (relativeStrength > 0.05) bullishScore += 2;
        if (relativeStrength < -0.05) bearishScore += 2;

        // CVD Logic & Divergence
        if (cvd > 1000) bullishScore += 2;
        if (cvd < -1000) bearishScore += 2;

        if (markers.pdh && currentPrice > markers.pdh * 0.998 && cvd < -500) bearishScore += 4;

        // --- Gamma Wall & Psychological Magnet Logic ---
        const gammaWalls = this.getGammaWalls(currentPrice, symbol);
        gammaWalls.forEach(wall => {
            const distance = Math.abs(currentPrice - wall) / currentPrice;
            if (distance < 0.001) { // Within 0.1% of a major level
                // If approaching from below, it's a resistance/magnet
                if (currentPrice < wall) {
                    bearishScore += 1; // Anticipate rejection/consolidation
                    bullishScore += 1; // Attracted as magnet
                } else {
                    bullishScore += 1; // Support/magnet
                    bearishScore += 1; // Rejection probability
                }
            }
        });
        if (markers.pdl && currentPrice < markers.pdl * 1.002 && cvd > 500) bullishScore += 4;

        // Fair Value Gaps (FVGs)
        let bullishFvgCount = 0;
        let bearishFvgCount = 0;
        fvgs.forEach(fvg => {
            if (fvg.type === 'bullish_fvg' && currentPrice < fvg.bottom && bullishFvgCount < 10) {
                bullishScore += 2;
                bullishFvgCount++;
            }
            if (fvg.type === 'bearish_fvg' && currentPrice > fvg.top && bearishFvgCount < 10) {
                bearishScore += 2;
                bearishFvgCount++;
            }
        });

        if (bloombergMetrics.sentiment > 2) bullishScore += 2.5;
        if (bloombergMetrics.sentiment < -2) bearishScore += 2.5;

        if (markers.pdh > 0 && currentPrice < markers.pdh) bullishScore += 1.5;
        if (markers.pdl > 0 && currentPrice > markers.pdl) bearishScore += 1.5;

        // --- ELITE: HOLY GRAIL SIGNALS ---
        // 1. SMT Divergence (+5 pts)
        if (markers.smt) {
            if (markers.smt.type === 'BULLISH') bullishScore += 5;
            else if (markers.smt.type === 'BEARISH') bearishScore += 5;
        }

        // 2. Institutional Absorption (+3 pts)
        const absorption = this.detectAbsorption(candles, markers);
        if (absorption) {
            if (absorption.type.includes('BULLISH')) bullishScore += 3;
            else bearishScore += 3;
        }

        // 3. Institutional Displacement (FVG) (+5 pts)
        const fvg = this.detectFVG(candles);
        if (fvg) {
            if (fvg.type.includes('BULLISH')) bullishScore += 5;
            else bearishScore += 5;
        }

        // 4. Whale Imbalance skewing (+2 pts for over 70% imbalance)
        if (markers.whaleImbalance > 70) bullishScore += 2;
        if (markers.whaleImbalance < -70) bearishScore += 2;

        // --- ELITE: DOLLAR SENSITIVITY (FX WEIGHTING) ---
        if (isForex && internals && typeof internals.dxyChange === 'number') {
            const dxyChange = internals.dxyChange;
            if (isUSDQuote) {
                if (dxyChange > 0) bearishScore += 5.0; // Heavy negative correlation
                else bullishScore += 4.0;
            } else if (symbol.startsWith('USD')) {
                if (dxyChange > 0) bullishScore += 5.0; // Positive correlation
                else bearishScore += 4.0;
            }
        }

        // --- RETAIL CONTRARIAN WEIGHTING ---
        const retailSentiment = this.calculateRetailSentiment(currentPrice, markers, candles);
        if (retailSentiment > 75) bearishScore += 5; // Extreme bullish retail = Institutional Sell
        if (retailSentiment < 25) bullishScore += 5; // Extreme bearish retail = Institutional Buy

        // --- FOREX KILLZONE INTENSITY ---
        const session = this.getSessionInfo(symbol);
        if (isForex) {
            if (session.session.includes('LONDON') || session.session.includes('NY')) {
                bullishScore *= 1.5;
                bearishScore *= 1.5;
            } else {
                // Outside Killzones, dampen signals to avoid range chop
                bullishScore *= 0.5;
                bearishScore *= 0.5;
            }
        }

        // --- PROFESSIONAL UPGRADE: SETUP-BASED BIAS WEIGHTING ---
        // Trap detection (Now influences Bias Score)
        const trap = this.detectDeltaTrap(currentPrice, markers.cvd || 0, candles);
        if (trap) {
            if (trap.type.includes('BEAR_TRAP')) bullishScore += 12; // Powerful reversal logic
            else if (trap.type.includes('BULL_TRAP')) bearishScore += 12;
        }

        // Bullish/Bearish Divergence (Now influences Bias Score)
        const isBullishDiv = (markers.pdl > 0 && currentPrice < markers.pdl * 1.002 && (markers.cvd || 0) > 500);
        const isBearishDiv = (markers.pdh > 0 && currentPrice > markers.pdh * 0.998 && (markers.cvd || 0) < -500);

        if (isBullishDiv) bullishScore += 15;
        if (isBearishDiv) bearishScore += 15;

        // --- NEW: ASIA RANGE & LIQUIDITY MAGNETS ---
        const asiaRange = this.calculateAsiaRange(candles);
        if (asiaRange) {
            // Judas Swing Detection: Sweep high then dive
            if (currentPrice > asiaRange.high) bearishScore += 2; // Potential fakeout high
            if (currentPrice < asiaRange.low) bullishScore += 2;  // Potential fakeout low
            
            // Above Asia Mid = Bullish Control
            if (currentPrice > asiaRange.mid) bullishScore += 1.5;
            else bearishScore += 1.5;
        }

        const eLiquidity = this.detectEqualHighsLows(candles);
        if (eLiquidity) {
            // Magnets draw price
            if (eLiquidity.eqh && currentPrice < eLiquidity.eqh.price) bullishScore += 2; // Draws price UP
            if (eLiquidity.eql && currentPrice > eLiquidity.eql.price) bearishScore += 2; // Draws price DOWN
        }

        // --- NEW: CBDR PROJECTIONS ---
        const cbdr = this.calculateCBDR(candles);
        if (cbdr) {
            // Price at SD2 (Standard Deviation 2) of CBDR is an extreme reversal zone
            if (currentPrice > cbdr.sd2_high) bearishScore += 3;
            if (currentPrice < cbdr.sd2_low) bullishScore += 3;
        }

        // --- NEW: OPTIMAL TRADE ENTRY (OTE) ---
        const ote = this.calculateOTE(candles);
        if (ote) {
            if (ote.type === 'BULLISH_OTE' && currentPrice >= ote.fib79 && currentPrice <= ote.fib62) {
                bullishScore += 4; // High conviction entry zone
            } else if (ote.type === 'BEARISH_OTE' && currentPrice <= ote.fib79 && currentPrice >= ote.fib62) {
                bearishScore += 4;
            }
        }

        const flout = this.calculateCBDRFlout(candles);

        const finalMultiplier = (internals && internals.newsImpact === 'HIGH') ? 0.5 : 1;
        const totalScore = (bullishScore * finalMultiplier) - (bearishScore * finalMultiplier);

        let biasLabel = 'NEUTRAL';
        if (totalScore >= 10) biasLabel = 'STRONG BULLISH';
        else if (totalScore >= 3) biasLabel = 'BULLISH';
        else if (totalScore <= -10) biasLabel = 'STRONG BEARISH';
        else if (totalScore <= -3) biasLabel = 'BEARISH';

        // ADR Extended check: Only override to CONSOLIDATION if not strongly trending
        const dayRange = (markers.todayHigh && markers.todayLow) ? markers.todayHigh - markers.todayLow : 0;
        if (markers.adr > 0 && dayRange > markers.adr * 1.4 && Math.abs(totalScore) < 10) {
            biasLabel = 'CONSOLIDATION';
            confPoints = Math.max(0, confPoints - 20);
        }

        // Accuracy Booster: Confidence Logic
        if (midnightOpen > 0) {
            if (biasLabel === 'BULLISH' && currentPrice < midnightOpen) confPoints += 15;
            if (biasLabel === 'BEARISH' && currentPrice > midnightOpen) confPoints += 15;
            if (biasLabel === 'BULLISH' && currentPrice > midnightOpen) confPoints += 10;
            if (biasLabel === 'BEARISH' && currentPrice < midnightOpen) confPoints += 10;
        }

        if (vwap > 0 && Math.abs(currentPrice - vwap) / vwap < 0.002) confPoints += 20;
        if (Math.abs(cvd) > 800) confPoints += 20;
        if (internals.newsImpact === 'LOW') confPoints += 20;
        if (Math.abs(totalScore) >= 10) confPoints += 40;

        // --- INSTITUTIONAL NARRATIVE ENGINE ---
        let narrative = "Synchronizing institutional pulse...";
        const reasons = [];
        if (biasLabel.includes('BULLISH')) {
            if (currentPrice > midnightOpen) reasons.push("Price holding above Midnight Open structure.");
            if (currentPrice > vwap) reasons.push("Institutional VWAP accumulation detected.");
            if (isBullishDiv) reasons.push("Bullish SMT/Delta divergence confirmed.");
            if (trap && trap.type.includes('BEAR_TRAP')) reasons.push("Cleverly engineered Bear Trap liquidated early sellers.");
            if (cvd > 500) reasons.push("Aggressive whale buying (CVD) detected.");
            narrative = "BULLISH BIAS: " + (reasons[0] || "Expanding toward liquidity ceiling.") + " " + (reasons[1] || "");
        } else if (biasLabel.includes('BEARISH')) {
            if (currentPrice < midnightOpen) reasons.push("Institutional selling below Midnight Open.");
            if (currentPrice < vwap) reasons.push("VWAP distribution confirmed.");
            if (isBearishDiv) reasons.push("Bearish SMT/Delta divergence detected.");
            if (trap && trap.type.includes('BULL_TRAP')) reasons.push("Retail Bull Trap successfully triggered.");
            if (cvd < -500) reasons.push("Significant institutional liquidation pressure.");
            narrative = "BEARISH BIAS: " + (reasons[0] || "Diving toward sell-side liquidity pools.") + " " + (reasons[1] || "");
        } else {
            narrative = "NEUTRAL: Market is hunting for a clear liquidity draw. Expect range chop.";
        }

        return {
            bias: biasLabel,
            score: totalScore,
            confidence: Math.min(100, Math.max(0, confPoints)),
            bullScore: bullishScore,
            bearScore: bearishScore,
            isDisplacement: this.detectDisplacement(candles),
            narrative: narrative.trim(),
            metrics: bloombergMetrics,
            vwap,
            poc,
            cvd,
            internals,
            trap,
            smt: markers.smt,
            amdPhase: this.getAMDPhase(),
            mss: this.detectMSS(candles, liquidityDraws, markers),
            fundingCandle: this.detectFundingCandle(candles, markers),
            absorption: this.detectAbsorption(candles, markers),
            fvg: this.detectFVG(candles),
            volumeImbalance: this.detectVolumeImbalance(candles),
            squeeze: this.detectSqueeze(candles),
            roro: this.calculateRORO(internals, symbol),
            orderBlock: this.detectOrderBlocks(candles),
            whaleImbalance: markers.whaleImbalance,
            asiaRange: asiaRange,
            cbdr: cbdr,
            flout: flout,
            ote: ote,
            restingLiquidity: eLiquidity,
            bloombergSentiment: this.getBloombergSentiment(markers, internals),
            intermarketCorrelation: this.getIntermarketCorrelation(symbol, markers),
            retailSentiment: retailSentiment,
            judas: this.detectJudasSwing(candles, markers, session)
        };
    }

    getAMDPhase() {
        // --- ELITE CALIBRATION: Algorithmic Timing Windows (NY TIME) ---
        const nyTime = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
        const hour = nyTime.getHours();
        const min = nyTime.getMinutes();
        const timeVal = hour + (min / 60);

        // 1. ASIA ACCUMULATION (20:00 - 02:00)
        if (timeVal >= 20 || timeVal < 2) {
            return {
                label: 'ACCUMULATION (ASIA)',
                color: '#38bdf8',
                desc: 'Setting the Liquidity Anchor',
                narrative: 'Asia is defining the structural range. Watch 12:00 AM (Midnight) as the True Daily Open.',
                next: 'LON PRE-OPEN (RESETS)'
            };
        }

        // 2. LONDON PRE-OPEN / MIDNIGHT RESET (02:00 - 03:00)
        if (timeVal >= 2 && timeVal < 3) {
            return {
                label: 'LON PRE-OPEN (RESET)',
                color: '#818cf8',
                desc: 'Institutional Re-Pricing',
                narrative: 'Smart Money is re-calculating the CBDR range. High probability of a small fake-move before 3:00 AM.',
                next: 'MANIPULATION (LONDON)'
            };
        }

        // 3. LONDON OPEN/MANIPULATION (03:00 - 05:00)
        if (timeVal >= 3 && timeVal < 5) {
            const isBullet = (hour === 3);
            return {
                label: isBullet ? 'LON SILVER BULLET 🎯' : 'MANIPULATION (LONDON)',
                color: '#f59e0b',
                desc: isBullet ? 'High-Priority Algo Window' : 'Judas Swing in Progress',
                narrative: isBullet ? 'The 3-4 AM window is actively hunting liquidity. Expect rapid stop-runs of Asia High/Low.' : 'Price is engineering liquidity. Do not trust the initial direction if DXY is decoupled.',
                next: 'LONDON EXPANSION'
            };
        }

        // 4. LONDON EXPANSION (05:00 - 08:30)
        if (timeVal >= 5 && timeVal < 8.5) {
            return {
                label: 'LONDON EXPANSION',
                color: '#10b981',
                desc: 'Institutional Trend Realization',
                narrative: 'London has established the daily trend. Distributing size toward major liquidity pools.',
                next: 'NY PRE-OPEN (MACRO)'
            };
        }

        // 5. NY PRE-OPEN / MACRO WINDOW (08:30 - 09:30)
        if (timeVal >= 8.5 && timeVal < 9.5) {
            return {
                label: 'NY PRE-OPEN (MACRO)',
                color: '#ec4899',
                desc: 'Economic Data/Macro Pulse',
                narrative: '8:30 AM data releases often act as the secondary manipulation for the NY session.',
                next: 'DISTRIBUTION (NY)'
            };
        }

        // 6. NY OPEN/DISTRIBUTION (09:30 - 13:30)
        if (timeVal >= 9.5 && timeVal < 13.5) {
            const isBullet = (hour === 10);
            return {
                label: isBullet ? 'NY SILVER BULLET 🎯' : 'DISTRIBUTION (NY)',
                color: '#10b981',
                desc: isBullet ? 'High-Priority Algo Window' : 'Institutional Trend Expansion',
                narrative: isBullet ? 'The 10-11 AM window is seeking internal range liquidity. Watch for FVG re-tests.' : 'New York is driving price toward the daily target. Institutional volume is at peak.',
                next: 'NY PM SESSION'
            };
        }

        // 7. NY PM SESSION (13:30 - 16:00)
        if (timeVal >= 13.5 && timeVal < 16) {
            return {
                label: 'NY PM SESSION',
                color: '#06b6d4',
                desc: 'Afternoon Trend/Reversal',
                narrative: 'Profit-taking or secondary expansion. Watch the 2:00 PM (14:00) macro for reversals.',
                next: 'MARKET CLOSE / CBDR'
            };
        }

        // 8. MARKET CLOSE / CBDR (16:00 - 20:00)
        return {
            label: 'OFF-SESSION / RESET',
            color: '#64748b',
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
        // MSS (Market Structure Shift) = Swept Liquidity + Break of Last Swing Point + FVG/Displacement
        const lastCandle = candles[candles.length - 1];
        const lastSwingHigh = draws?.bsl ? draws.bsl[0] : 0;
        const lastSwingLow = draws?.ssl ? draws.ssl[0] : 0;

        // Bullish MSS: Price swept liquidity, then broke original swing high
        if (lastCandle.close > lastSwingHigh && lastSwingHigh > 0) {
            return { type: 'BULLISH_MSS', price: lastSwingHigh, timestamp: lastCandle.timestamp };
        }
        // Bearish MSS: Price swept, then broke original swing low
        if (lastCandle.close < lastSwingLow && lastSwingLow > 0) {
            return { type: 'BEARISH_MSS', price: lastSwingLow, timestamp: lastCandle.timestamp };
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

        const nyTime = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
        const hour = nyTime.getHours();
        const minute = nyTime.getMinutes();
        const totalMinutes = (hour * 60) + minute;
        const isForex = symbol === 'BTC-USD' || symbol.includes('=X');

        // Midnight Strategy Window (00:00 AM - 09:30 AM EST)
        const isMidnightWindow = totalMinutes >= 0 && totalMinutes < 570;

        if (!isForex) {
            // Stocks/ETFs logic
            if (!session.isMarketOpen && !isMidnightWindow) {
                return {
                    action: 'WAIT',
                    strike: '-',
                    target: '-',
                    rationale: `STOCK MARKET CLOSED (${session.session}). Signaling resumes at Midnight EST for Judas Swings.`,
                    duration: '-',
                    isStable: true
                };
            }
        } else {
            // Forex/Crypto logic
            if (!session.isMarketOpen) {
                return {
                    action: 'WAIT',
                    strike: '-',
                    target: '-',
                    rationale: `FOREX MARKET CLOSED (${session.session}).`,
                    duration: '-',
                    isStable: true
                };
            }
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

        const isJudasLong = (bias.bias === 'BULLISH' && currentPrice < midnightOpen && cvd > 200);
        const isJudasShort = (bias.bias === 'BEARISH' && currentPrice > midnightOpen && cvd < -200);

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
                rawRationale = `👑 MIDNIGHT STRATEGY: Judas Swing detected. Buying below True Open with Bullish Confluence.`;
            } else if (isBullishDiv) {
                rawRationale = `👑 PREMIER: Bullish Divergence at Daily Low.`;
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
                rawRationale = `👑 MIDNIGHT STRATEGY: Judas Swing detected. Selling above True Open with Bearish Confluence.`;
            } else if (isBearishDiv) {
                rawRationale = `👑 PREMIER: Bearish Divergence at Daily High.`;
            } else {
                rawRationale = `👑 PREMIER: Triple Technical Confluence (VWAP/POC/MID).`;
            }
        }

        if (!this.signalState[stateKey]) {
            this.signalState[stateKey] = { action: rawAction, strike: rawStrike, target: rawTarget, trim: rawTrim, rationale: newsWarning + rawRationale, count: 1 };
        } else {
            const state = this.signalState[stateKey];
            if (state.action === rawAction) {
                state.count = Math.min(state.count + 1, 10); // Increased cap to 10
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
        const isKillZone = (session.session === 'NY_OPEN' || session.session === 'NY_PM');
        const killZoneWarning = !isKillZone ? '⚠️ OFF-HOURS: Low Institutional Volume. ' : '';

        if (stable.action !== 'WAIT') {
            const isCall = stable.action.includes('CALL');
            const isForex = symbol.includes('=X') || symbol === 'BTC-USD';
            
            if (isForex) {
                // Forex SL: Use ATR-based pips (usually 20-50 pips)
                const pips = atr * 2.0;
                sl = isCall ? (currentPrice - pips).toFixed(5) : (currentPrice + pips).toFixed(5);
            } else {
                sl = isCall ? (currentPrice - (atr * 1.8)).toFixed(2) : (currentPrice + (atr * 1.8)).toFixed(2);
            }

            // --- EXPERT UPGRADE: RISK-TO-REWARD (R:R) VALIDATION ---
            const targetPrice = parseFloat(stable.target);
            const slPrice = parseFloat(sl);
            const potentialProfit = Math.abs(targetPrice - currentPrice);
            const potentialRisk = Math.abs(currentPrice - slPrice);
            rrRatioValue = potentialRisk > 0 ? potentialProfit / potentialRisk : 0;

            // Block low R:R trades (Must be at least 1.5:1)
            if (rrRatioValue < 1.5) {
                return {
                    action: 'WAIT',
                    strike: '-',
                    target: '-',
                    rationale: `Low R:R Ratio (${rrRatioValue.toFixed(1)}:1). Reward doesn't justify risk.`,
                    isStable: true,
                    rrRatio: rrRatioValue.toFixed(1)
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

        return {
            action: stable.action,
            strike: stable.strike,
            target: stable.target,
            trim: stable.trim,
            sl,
            tp: stable.target,
            size,
            duration: timeframe === '1m' ? '15m' : '1h',
            rationale: killZoneWarning + newsWarning + stable.rationale,
            session: session.session,
            isStable: stable.count >= 8,
            confidence: bias.confidence || 0,
            rrRatio: rrRatioValue.toFixed(1),
            exit: exitSignal
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

        return null;
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
     * Institutional Liquidity Heatmap (Gravity Engine)
     * Maps the market as a schedule of transactions by identifying "Liquidity Pools" 
     * and "Value Hubs" where institutional activity is concentrated.
     */
    calculateInstitutionalHeatmap(candles, markers, currentPrice, symbol) {
        if (!candles || candles.length < 50) return [];
        
        const heatmap = [];
        const isForex = symbol.includes('=X') || symbol.includes('USD');
        const precision = isForex ? 5 : 2;
        
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
        
        // Displacement is a large, high-volume candle that leaves an FVG
        for (let i = candles.length - 1; i >= 3; i--) {
            const current = candles[i];
            const prev = candles[i - 1];
            const root = candles[i - 2];

            const body = Math.abs(prev.close - prev.open);
            const avgBody = candles.slice(i - 10, i - 1).reduce((s, c) => s + Math.abs(c.close - c.open), 0) / 9;
            const isHighVolume = prev.volume > (candles.slice(i - 10, i - 1).reduce((s, c) => s + c.volume, 0) / 9) * 1.5;

            // Large Body + High Volume usually = Displacement
            if (body > avgBody * 2 && isHighVolume) {
                // If it also created an FVG, it's confirmed
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
}
