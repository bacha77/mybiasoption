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
    detectAbsorption(candles) {
        if (candles.length < 5) return null;
        const lastCandles = candles.slice(-5);
        const avgVol = lastCandles.reduce((s, c) => s + c.volume, 0) / 5;
        const lastCandle = lastCandles[lastCandles.length - 1];

        const bodySize = Math.abs(lastCandle.open - lastCandle.close);
        const candleRange = lastCandle.high - lastCandle.low;

        if (lastCandle.volume > avgVol * 1.8 && bodySize < candleRange * 0.25) {
            return { type: 'ABSORPTION', price: lastCandle.close, volume: lastCandle.volume };
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
    getSessionInfo() {
        const now = new Date();
        const nyTime = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
        const hour = nyTime.getHours();
        const minute = nyTime.getMinutes();
        const day = nyTime.getDay();
        const isWeekend = day === 0 || day === 6;
        const totalMinutes = (hour * 60) + minute;

        const marketOpen = 570; // 9:30 AM
        const marketClose = 960; // 4:00 PM
        const isMarketOpen = !isWeekend && totalMinutes >= marketOpen && totalMinutes < marketClose;

        if (isWeekend) return { session: 'WEEKEND', status: 'MARKET CLOSED', color: '#ff3366', isMarketOpen: false };

        if (totalMinutes >= 570 && totalMinutes <= 660) return { session: 'NY_OPEN', status: 'HIGH VOLATILITY', color: '#00f2ff', isMarketOpen: true };
        if (totalMinutes > 660 && totalMinutes < 780) return { session: 'NY_AM', status: 'TRENDING', color: '#00ff88', isMarketOpen: true };
        if (totalMinutes >= 780 && totalMinutes <= 810) return { session: 'LUNCH', status: 'CONSOLIDATION', color: '#94a3b8', isMarketOpen: true };
        if (totalMinutes > 810 && totalMinutes < 960) return { session: 'NY_PM', status: 'EOD DRIVE', color: '#00f2ff', isMarketOpen: true };

        return { session: 'OFF_HOURS', status: 'NO TRADE ZONE', color: '#94a3b8', isMarketOpen: false };
    }
    calculateBias(currentPrice, fvgs, liquidityDraws, bloombergMetrics = {}, markers = {}, relativeStrength = 0, internals = { vix: 0, dxy: 0, newsImpact: 'LOW' }) {
        let bullishScore = 0;
        let bearishScore = 0;
        const vwap = markers.vwap || 0;
        const poc = markers.poc || 0;
        const cvd = markers.cvd || 0;
        const midnightOpen = markers.midnightOpen || 0;
        const londonOpen = markers.londonOpen || 0;
        const nyOpen = markers.nyOpen || 0;
        let confPoints = 0;

        // Market Internals Filter (VIX/DXY)
        if (internals.vix > 20) bearishScore += 2;
        if (internals.vix > 30) { bearishScore += 5; bullishScore -= 3; }
        if (internals.dxy > 26.5) bearishScore += 1;

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

        let finalBullish = bullishScore;
        let finalBearish = bearishScore;
        if (internals.newsImpact === 'HIGH') {
            finalBullish *= 0.5;
            finalBearish *= 0.5;
        }

        const totalScore = finalBullish - finalBearish;
        let biasLabel = 'NEUTRAL';
        if (totalScore >= 5) biasLabel = 'BULLISH';
        else if (totalScore <= -5) biasLabel = 'BEARISH';

        // ADR Exhaustion Check (New)
        const dayRange = Math.max(...(markers.todayHigh ? [markers.todayHigh - markers.todayLow] : [0]));
        if (markers.adr > 0 && dayRange > markers.adr * 0.9) {
            // If we've already moved 90% of the daily average, be VERY careful
            biasLabel = 'CONSOLIDATION/EXHAUSTED';
            confPoints = Math.max(0, confPoints - 30);
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

        return { bias: biasLabel, score: totalScore, confidence: Math.min(confPoints, 100), metrics: bloombergMetrics, vwap, poc, cvd, internals };
    }

    getOptionRecommendation(bias, markers, currentPrice, timeframe = '1m', symbol = 'SPY', candles = []) {
        const session = this.getSessionInfo();
        const multipliers = { '1m': 1, '5m': 5, '15m': 15 };
        const stateKey = `${symbol}_${timeframe}`;

        if (!session.isMarketOpen) {
            return { action: 'WAIT', strike: '-', target: '-', rationale: 'US MARKET CLOSED', duration: '-', isStable: true };
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
            const raw = currentPrice + (0.1 * multipliers[timeframe]);
            rawStrike = Math.round(raw * 2) / 2;
            rawTrim = vwap.toFixed(2);
            rawTarget = (pdh > currentPrice) ? pdh.toFixed(2) : (currentPrice * 1.01).toFixed(2);

            if (isJudasLong) {
                rawRationale = `👑 MIDNIGHT STRATEGY: Judas Swing detected. Buying below True Open with Bullish Confluence.`;
            } else if (isBullishDiv) {
                rawRationale = `👑 PREMIER: Bullish Divergence at Daily Low.`;
            } else {
                rawRationale = `👑 PREMIER: Triple Technical Confluence (VWAP/POC/MID).`;
            }
        } else if ((hasBearishTechnical && hasBearishDelta) || isBearishDiv || ultraHighProbBear || isJudasShort) {
            rawAction = 'BUY PUT';
            const raw = currentPrice - (0.1 * multipliers[timeframe]);
            rawStrike = Math.round(raw * 2) / 2;
            rawTrim = vwap.toFixed(2);
            rawTarget = (pdl < currentPrice && pdl > 0) ? pdl.toFixed(2) : (currentPrice * 0.99).toFixed(2);

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
            const rrRatio = potentialRisk > 0 ? potentialProfit / potentialRisk : 0;

            // Block low R:R trades (Must be at least 1.5:1)
            if (rrRatio < 1.5) {
                return {
                    action: 'WAIT',
                    strike: '-',
                    target: '-',
                    rationale: `Low R:R Ratio (${rrRatio.toFixed(1)}:1). Reward doesn't justify risk.`,
                    isStable: true
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
            exit: exitSignal
        };
    }
}
