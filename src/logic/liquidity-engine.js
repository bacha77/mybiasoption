/**
 * Liquidity Engine
 * Identifies institutional liquidity draws: Old Highs/Lows and Fair Value Gaps (FVG).
 */

export class LiquidityEngine {
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

    calculateRelativeStrength(symbolCandles, spyCandles) {
        if (!symbolCandles.length || !spyCandles.length) return 0;
        const count = Math.min(symbolCandles.length, spyCandles.length, 15);
        if (count < 2) return 0;

        const symStart = symbolCandles[symbolCandles.length - count].close;
        const symEnd = symbolCandles[symbolCandles.length - 1].close;
        const spyStart = spyCandles[spyCandles.length - count].close;
        const spyEnd = spyCandles[spyCandles.length - 1].close;

        if (symStart === 0 || spyStart === 0) return 0; // Protection against division by zero

        const symPerf = (symEnd - symStart) / symStart;
        const spyPerf = (spyEnd - spyStart) / spyStart;
        return (symPerf - spyPerf) * 100;
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
            if (totalMinutes > 810 && totalMinutes < 960) return { session: 'NY_PM', status: 'EOD DRIVE', color: '#00f2ff', isMarketOpen: true };

            // If it's a weekday but outside the above windows
            return { session: 'OFF_HOURS', status: 'MARKET CLOSED', color: '#334155', isMarketOpen: false };
        } else {
            // Forex-specific session logic
            if (hour >= 3 && hour < 4) return { session: 'LONDON_BULLET', status: 'ALGO EXPANSION', color: '#f59e0b', isMarketOpen: true };
            if (hour >= 3 && hour < 11) return { session: 'LONDON', status: 'HIGH VOLUME', color: '#00f2ff', isMarketOpen: true };
            if (hour >= 8 && hour < 17) return { session: 'NY_FX', status: 'OVERLAP/LIQUIDITY', color: '#00ff88', isMarketOpen: true };
            if (hour >= 19 || hour < 4) return { session: 'ASIA', status: 'STEADY', color: '#94a3b8', isMarketOpen: true };
            return { session: 'FOREX_QUIET', status: 'LOW VOLUME', color: '#334155', isMarketOpen: true };
        }
    }

    calculateBias(currentPrice, fvgs, liquidityDraws, bloombergMetrics = {}, markers = {}, relativeStrength = 0, internals = { vix: 0, dxy: 0, newsImpact: 'LOW', sectors: [] }, symbol = 'SPY', candles = []) {
        let bullishScore = 0;
        let bearishScore = 0;
        const isForex = symbol.includes('=X') || symbol === 'BTC-USD';
        const isUSDQuote = symbol.includes('USD') && !symbol.startsWith('USD'); // e.g., EURUSD

        // --- DXY CORRELATION (Critical for Forex) ---
        if (isForex && internals.dxy > 0) {
            const dxyStrength = internals.dxy > 103.5; 
            if (isUSDQuote) {
                if (dxyStrength) bearishScore += 2.5; // DXY UP = EURUSD DOWN
                else bullishScore += 1.5;
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

        return {
            bias: biasLabel,
            score: totalScore,
            confidence: Math.min(confPoints, 100),
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
            bloombergSentiment: this.getBloombergSentiment(markers, internals),
            intermarketCorrelation: this.getIntermarketCorrelation(symbol, markers)
        };
    }

    getAMDPhase() {
        // Power of 3: Accumulation, Manipulation, Distribution
        const nyTime = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
        const hour = nyTime.getHours();

        if (hour >= 0 && hour < 3) return { label: 'ACCUMULATION', color: '#38bdf8', desc: 'Institutions building size', narrative: 'Price is consolidating within a tight range. Big players are quietly building positions before the fakeout.', next: 'MANIPULATION' };
        if (hour >= 3 && hour < 10) return { label: 'MANIPULATION', color: '#f59e0b', desc: 'The Judas Swing / Fakeout Phase', narrative: 'The "Judas Swing" is in effect. Price is moving AGAINST the true trend to trap retail and hit stops before the real run.', next: 'DISTRIBUTION' };
        if (hour >= 10 && hour < 16) return { label: 'DISTRIBUTION', color: '#10b981', desc: 'Large players exiting near trend high/low', narrative: 'The real expansion is happening. Institutions are distributing orders to the late-comers. Look for the expansion run.', next: 'OFF-SESSION' };
        return { label: 'OFF-SESSION', color: '#64748b', desc: 'Waiting for Midnight liquidity', narrative: 'The algorithmic cycle has ended. Searching for the next liquidity pool for the Midnight restart.', next: 'ACCUMULATION' };
    }

    getIntermarketCorrelation(symbol, markers) {
        // Feature 4: SMT Pulse / Intermarket Correlation
        // This is a proxy for divergence strength
        if (!markers.smt) return { strength: 0, status: 'STABLE' };
        return {
            strength: markers.smt.divergence || 85,
            status: markers.smt.type === 'BULLISH' ? 'BULLISH DIVERGENCE' : 'BEARISH DIVERGENCE'
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
            sl = isCall ? (currentPrice - (atr * 1.8)).toFixed(2) : (currentPrice + (atr * 1.8)).toFixed(2);

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
}
