
/**
 * Institutional Intelligence Algorithm
 * The "Elite Layer" for the BIAS Terminal.
 * Synchronizes Dealer Gamma, Killzones, and SMT Divergence.
 */

export class InstitutionalAlgorithm {
    constructor() {
        this.gammaWalls = [];
        this.activeKillzone = null;
        this.smtDivergence = null;
    }

    calculateGEX(price, symbol, optionsChain = null) {
        if (price <= 0) return [];
        
        // 1. IF WE HAVE REAL OPTIONS DATA (The Upgrade)
        if (optionsChain && optionsChain.calls && optionsChain.puts) {
            let totalCalls = 0;
            optionsChain.calls.forEach(c => totalCalls += c.openInterest);
            let totalPuts = 0;
            optionsChain.puts.forEach(p => totalPuts += p.openInterest);
            const globalPCR = totalCalls > 0 ? (totalPuts / totalCalls) : 1;

            const walls = [];
            
            // Map Calls (Call Walls)
            const sortedCalls = optionsChain.calls
                .filter(c => c.openInterest > 0)
                .sort((a, b) => b.openInterest - a.openInterest)
                .slice(0, 5); // Top 5 Call Walls
                
            sortedCalls.forEach(c => {
                const distancePct = Math.abs(price - c.strike) / price;
                let gamma = (c.openInterest / 10000) * 10;
                
                // GRAVITY MULTIPLIER (0DTE Pinning)
                if (distancePct < 0.005) gamma *= 2.5; // Massive magnet if right at the money
                else if (distancePct < 0.015) gamma *= 1.5;
                else if (distancePct > 0.05) gamma *= 0.2; // Decays sharply if too far
                
                walls.push({
                    strike: c.strike,
                    type: 'CALL_WALL',
                    gamma: Math.min(100, gamma + 30), // Minimum baseline
                    isMagnet: gamma > 40,
                    integrity: 0.9 + (Math.random() * 0.1),
                    pcr: globalPCR
                });
            });

            // Map Puts (Put Walls)
            const sortedPuts = optionsChain.puts
                .filter(p => p.openInterest > 0)
                .sort((a, b) => b.openInterest - a.openInterest)
                .slice(0, 5); // Top 5 Put Walls
                
            sortedPuts.forEach(p => {
                const distancePct = Math.abs(price - p.strike) / price;
                let gamma = (p.openInterest / 10000) * 10;
                
                // GRAVITY MULTIPLIER
                if (distancePct < 0.005) gamma *= 2.5;
                else if (distancePct < 0.015) gamma *= 1.5;
                else if (distancePct > 0.05) gamma *= 0.2;
                
                walls.push({
                    strike: p.strike,
                    type: 'PUT_WALL',
                    gamma: Math.min(100, gamma + 30),
                    isMagnet: gamma > 40,
                    integrity: 0.9 + (Math.random() * 0.1),
                    pcr: globalPCR
                });
            });

            return walls.sort((a, b) => a.strike - b.strike);
        }

        // 2. FALLBACK/SYNTHETIC PROXY CALCULATION (Forex/Missing Data)
        const isFX = symbol.includes('=X') || symbol.includes('USD');
        const isSpu = symbol.includes('SPY') || symbol.includes('QQQ');
        
        // Define dynamic strike intervals based on asset class and price level
        let interval = 1;
        if (isFX) interval = 0.0050; // 50 pips
        else if (isSpu) interval = 5; // 5 points
        else if (price > 1000) interval = 50;
        else if (price > 100) interval = 10;
        else interval = 2.5;

        const base = Math.round(price / interval) * interval;
        const strikes = [base - (interval * 2), base - interval, base, base + interval, base + (interval * 2)];

        return strikes.map(strike => {
            const distance = Math.abs(price - strike) / price;
            
            // Base intensity from proximity
            let intensity = 1 - Math.min(distance * 50, 1);
            let gamma = intensity * 60; // Base gamma 0-60
            
            // Major Psychological Level Boost (Century/Half-Century)
            const isCentury = (strike % (interval * 10) === 0);
            const isHalfCentury = (strike % (interval * 5) === 0);
            
            if (isCentury) gamma += 40;
            else if (isHalfCentury) gamma += 20;

            const isMagnet = gamma > 75;
            const type = strike > price ? 'CALL_WALL' : 'PUT_WALL';

            return {
                strike,
                type,
                gamma: Math.min(100, gamma),
                isMagnet,
                integrity: 0.85 + (Math.random() * 0.1)
            };
        });
    }

    /**
     * Advanced Killzone Manager
     * Syncs institutional timing windows.
     */
    getKillzoneStatus() {
        const now = new Date();
        const nyTime = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
        const hour = nyTime.getHours();
        const min = nyTime.getMinutes();
        const totalMinutes = (hour * 60) + min;

        // Windows (in minutes from midnight EST)
        const windows = [
            { name: 'ASIA_OPEN', start: 1140, end: 1260, color: '#38bdf8', isKillzone: false },    // 7 PM - 9 PM
            { name: 'ASIA_ACCUMULATION', start: 1260, end: 1440, color: '#0ea5e9', isKillzone: true }, // 9 PM - 12 AM
            { name: 'LONDON_PRE', start: 0, end: 120, color: '#3b82f6', isKillzone: false },      // 12 AM - 2 AM
            { name: 'LONDON_OPEN', start: 120, end: 300, color: '#2563eb', isKillzone: true },    // 2 AM - 5 AM
            { name: 'LONDON_EXPANSION', start: 300, end: 510, color: '#60a5fa', isKillzone: false }, // 5 AM - 8:30 AM
            { name: 'NY_OPEN', start: 510, end: 660, color: '#f59e0b', isKillzone: true },        // 8:30 AM - 11 AM
            { name: 'SILVER_BULLET', start: 600, end: 660, color: '#ef4444', isKillzone: true },  // 10 AM - 11 AM (Overlap)
            { name: 'NY_AM_TREND', start: 660, end: 720, color: '#10b981', isKillzone: true },    // 11 AM - 12 PM
            { name: 'LUNCH_RANGE', start: 720, end: 810, color: '#94a3b8', isKillzone: false },   // 12 PM - 1:30 PM
            { name: 'NY_PM_MACRO', start: 810, end: 870, color: '#10b981', isKillzone: true },    // 1:30 PM - 2:30 PM
            { name: 'EOD_DRIVE', start: 870, end: 960, color: '#0ea5e9', isKillzone: true },      // 2:30 PM - 4 PM
            { name: 'POST_MARKET', start: 960, end: 1140, color: '#6366f1', isKillzone: false }   // 4 PM - 7 PM
        ];

        // Find the active window (last one that has started)
        const active = windows.slice().reverse().find(w => totalMinutes >= w.start && totalMinutes < w.end);
        
        if (active) {
            const progress = ((totalMinutes - active.start) / (active.end - active.start)) * 100;
            return { ...active, progress, active: true };
        }

        return { name: 'OFF-HOURS', active: false, color: '#94a3b8', progress: 0 };
    }

    /**
     * SMT Master Engine (Holy Grail of FX)
     * Cross-asset divergence between SPY/QQQ or EURUSD/GBPUSD.
     * Institutions use these as "True High/Low" indicators when the primary asset fails to follow the correlated secondary.
     */
    detectSMT(symbol, currentPrice, candles, otherSymbol, otherPrice, otherCandles) {
        if (!Array.isArray(candles) || !Array.isArray(otherCandles) || candles.length < 15 || otherCandles.length < 15) return null;

        // Use the last 15 candles for better structural context (M1/M5)
        const cA = candles.slice(-15);
        const cB = otherCandles.slice(-15);

        // Previous Reference High/Low (excluding current bar)
        const lookback = 12; // Bars to check for previous peak/trough
        const refA = cA.slice(0, lookback);
        const refB = cB.slice(0, lookback);

        const lowA = Math.min(...refA.map(c => c.low));
        const lowB = Math.min(...refB.map(c => c.low));
        const highA = Math.max(...refA.map(c => c.high));
        const highB = Math.max(...refB.map(c => c.high));

        const lastA = cA[cA.length - 1];
        const lastB = cB[cB.length - 1];

        // --- BULLISH SMT: SMT LOW (Absorption) ---
        // Scenario 1: Asset A sweeps its low, but Asset B holds a Higher Low. 
        // Result: Asset B is the "Stronger" leader; Asset A's move is a fakeout/sweep.
        if (lastA.low < lowA && lastB.low > lowB) {
            return {
                type: 'BULLISH',
                symbol: otherSymbol,
                strength: 85,
                message: `SMT BULLISH: ${symbol} Swept Low / ${otherSymbol} Held Higher Low. ${otherSymbol} is Leading Strength.`,
                isSweep: true
            };
        }
        // Scenario 2: Asset B sweeps its low, but Asset A holds a Higher Low.
        if (lastB.low < lowB && lastA.low > lowA) {
            return {
                type: 'BULLISH',
                symbol: otherSymbol,
                strength: 85,
                message: `SMT BULLISH: ${otherSymbol} Swept Low / ${symbol} Held Higher Low. ${symbol} is Leading Strength.`,
                isSweep: true
            };
        }
        
        // --- BEARISH SMT: SMT HIGH (Distribution) ---
        // Scenario 1: Asset A sweeps its high, but Asset B holds a Lower High.
        if (lastA.high > highA && lastB.high < highB) {
            return {
                type: 'BEARISH',
                symbol: otherSymbol,
                strength: 85,
                message: `SMT BEARISH: ${symbol} Swept High / ${otherSymbol} Held Lower High. ${otherSymbol} is Leading Weakness.`,
                isSweep: true
            };
        }
        // Scenario 2: Asset B sweeps its high, but Asset A holds a Lower High.
        if (lastB.high > highB && lastA.high < highA) {
            return {
                type: 'BEARISH',
                symbol: otherSymbol,
                strength: 85,
                message: `SMT BEARISH: ${otherSymbol} Swept High / ${symbol} Held Lower High. ${symbol} is Leading Weakness.`,
                isSweep: true
            };
        }

        return null;
    }

    /**
     * Master Inverse SMT (DXY Sync)
     * For assets that move OPPOSITE to each other (e.g., DXY vs EURUSD or DXY vs SPY).
     * This is the single most critical signal for identifying when the dollar is a FAKE.
     */
    detectInverseSMT(symbol, currentPrice, candles, dxyPrice, dxyCandles) {
        if (!Array.isArray(candles) || !Array.isArray(dxyCandles) || candles.length < 15 || dxyCandles.length < 15) return null;

        const cA = candles.slice(-15);
        const cB = dxyCandles.slice(-15);

        const lookback = 12;
        const lowA = Math.min(...cA.slice(0, lookback).map(c => c.low));
        const highA = Math.max(...cA.slice(0, lookback).map(c => c.high));
        const lowB = Math.min(...cB.slice(0, lookback).map(c => c.low));
        const highB = Math.max(...cB.slice(0, lookback).map(c => c.high));

        const lastA = cA[cA.length - 1];
        const lastB = cB[cB.length - 1];

        // BULLISH INVERSE SMT (Risk-On Accumulation)
        // If DXY (B) makes a HIGHER HIGH, but EURUSD (A) fails to make a LOWER LOW.
        // Interpretation: Big players are selling the dollar but NOT selling the assets. Absorption.
        if (lastB.high > highB && lastA.low > lowA) {
            return {
                type: 'BULLISH_INVERSE',
                symbol: symbol,
                strength: 95,
                message: `MASTER SMT: ${symbol} Hidden Strength vs DXY Pulse. Institutional Accumulation verified.`,
                isMacro: true
            };
        }

        // BEARISH INVERSE SMT (Risk-Off Distribution)
        // If DXY (B) makes a LOWER LOW, but EURUSD (A) fails to make a HIGHER HIGH.
        if (lastB.low < lowB && lastA.high < highA) {
            return {
                type: 'BEARISH_INVERSE',
                symbol: symbol,
                strength: 95,
                message: `MASTER SMT: ${symbol} Hidden Weakness vs DXY Drop. Institutional Distribution verified.`,
                isMacro: true
            };
        }

        return null;
    }

    /**
     * Institutional Liquidity Void Engine (FVG & Displacement)
     * Detects "Fair Value Gaps" where institutional order flow moved so fast it left a void.
     * These zones act as "Magnets" or "Launchpads" for price.
     */
    detectLiquidityVoids(candles) {
        if (!candles || candles.length < 5) return null;

        const voids = [];
        const lastIndex = candles.length - 1;

        // Check last 20 candles for imbalance (FVG)
        // A gap between Candle [i-2] and Candle [i] with Candle [i-1] being the displacement
        const lookback = Math.min(20, candles.length - 3);
        
        for (let i = lastIndex; i > lastIndex - lookback; i--) {
            const c1 = candles[i - 2];
            const c2 = candles[i - 1]; // Displacement bar
            const c3 = candles[i];

            if (!c1 || !c2 || !c3) continue;

            // Bullish FVG (Gap Up)
            if (c3.low > c1.high) {
                voids.push({
                    type: 'BULLISH_FVG',
                    top: c3.low,
                    bottom: c1.high,
                    size: c3.low - c1.high,
                    age: lastIndex - i,
                    status: 'UNFILLED'
                });
            }

            // Bearish FVG (Gap Down)
            if (c3.high < c1.low) {
                voids.push({
                    type: 'BEARISH_FVG',
                    top: c1.low,
                    bottom: c3.high,
                    size: c1.low - c3.high,
                    age: lastIndex - i,
                    status: 'UNFILLED'
                });
            }
        }

        // Return latest significant unfilled void
        if (voids.length === 0) return null;
        
        // Filter out "filled" voids (zones price has returned to)
        const currentPrice = candles[lastIndex].close;
        const validVoids = voids.filter(v => {
            if (v.type === 'BULLISH_FVG' && currentPrice < v.bottom) return false; // invalid
            if (v.type === 'BEARISH_FVG' && currentPrice > v.top) return false; // invalid
            return true;
        });

        return validVoids.length > 0 ? validVoids[0] : null;
    }

    /**
     * Market Structure Shift (MSS)
     * Identifies when institutions have successfully flipped the trend direction.
     */
    detectMSS(candles) {
        if (!candles || candles.length < 20) return null;

        const lookback = candles.slice(-20);
        const swingHighs = [];
        const swingLows = [];

        // Identify structural swings
        for (let i = 2; i < lookback.length - 2; i++) {
            if (lookback[i].high > lookback[i-1].high && lookback[i].high > lookback[i+1].high) {
                swingHighs.push(lookback[i].high);
            }
            if (lookback[i].low < lookback[i-1].low && lookback[i].low < lookback[i+1].low) {
                swingLows.push(lookback[i].low);
            }
        }

        const lastPrice = lookback[lookback.length - 1].close;
        const prevPrice = lookback[lookback.length - 2].close;

        // Bullish MSS: Price breaks latest swing high with displacement
        if (swingHighs.length > 0) {
            const latestHigh = swingHighs[swingHighs.length - 1];
            if (lastPrice > latestHigh && prevPrice <= latestHigh) {
                return { type: 'BULLISH_MSS', level: latestHigh };
            }
        }

        // Bearish MSS: Price breaks latest swing low with displacement
        if (swingLows.length > 0) {
            const latestLow = swingLows[swingLows.length - 1];
            if (lastPrice < latestLow && prevPrice >= latestLow) {
                return { type: 'BEARISH_MSS', level: latestLow };
            }
        }

        return null;
    }

    /**
     * Institutional Reality Score (IR-Score)
     * The final "Sync" metric that tells you if the move is REAL or a TRAP.
     */
    calculateIRScore(bias = {}, killzone = {}, smt = null, gex = [], retail = 50) {
        let score = 50; 
        if (!bias) bias = { score: 0, confidence: 50 };
        if (!killzone) killzone = { active: false };

        // 1. Time Alignment (Institutional Hours)
        if (killzone.active) score += 10;
        if (killzone.name === 'SILVER_BULLET') score += 15;

        // 2. Correlation Alignment (SMT)
        if (smt && smt.type) {
            const hasSmtBull = (smt.type || '').includes('BULLISH');
            const hasSmtBear = (smt.type || '').includes('BEARISH');
            const biasScore = bias.score || 0;

            if (hasSmtBull && biasScore > 0) score += 20;
            if (hasSmtBear && biasScore < 0) score += 20;
            if (hasSmtBull && biasScore < 0) score -= 30; // CONFLICT = TRAP
        }

        // 3. Retail Contrarian Pulse (Institutions hunt retail liquidity)
        if (retail !== undefined) {
            const biasScore = bias.score || 0;
            if (retail >= 80 && biasScore > 0) score -= 45; // MASSIVE SELL TRAP
            if (retail <= 20 && biasScore < 0) score -= 45; // MASSIVE BUY TRAP
            if (retail >= 80 && biasScore < 0) score += 20; // Institutions dumping on retail
            if (retail <= 20 && biasScore > 0) score += 20; // Institutions buying retail fear
        }

        // 4. Gamma Alignment & PCR Filter
        if (gex && Array.isArray(gex) && gex.length > 0) {
            const nearestWall = gex.reduce((prev, curr) => ((curr.gamma || 0) > (prev.gamma || 0) ? curr : prev), gex[0]);
            if (nearestWall && nearestWall.isMagnet && (bias.confidence || 0) > 70) score += 5;
            
            // Put/Call Ratio Squeeze Logic
            if (nearestWall && nearestWall.pcr) {
                const pcr = nearestWall.pcr;
                const biasScore = bias.score || 0;
                if (pcr > 1.25 && biasScore > 0) score += 20; // Short Squeeze Fuel
                if (pcr > 1.25 && biasScore < 0) score -= 40; // Block bearish signals (Crash protection in place)
                if (pcr < 0.7 && biasScore < 0) score += 20;  // Long Squeeze Fuel (Calls are heavy, MM will drop it)
            }
        }

        const finalScore = Math.max(0, Math.min(100, score));
        let status = 'NEUTRAL';
        if (finalScore >= 80) status = 'HIGH_CONVICTION';
        else if (finalScore >= 65) status = 'STRENGTH';
        else if (finalScore <= 35) status = 'BIASED_TRAP';

        return {
            score: finalScore,
            status,
            shadow: { status: 'STABLE' }
        };
    }

    /**
     * 0DTE Expected Move Algorithm
     * Calculates the institutional range where 68% of price action is expected to reside.
     * Used by Market Makers to "pin" the price near high-gamma strikes.
     */
    calculateExpectedMove(price, vix, symbol) {
        if (price <= 0 || !vix) return null;

        const isFX = symbol.includes('=X') || symbol.includes('USD');
        // VIX is a proxy for equities. For Forex, we adjust or use a fixed vol proxy if needed.
        const iv = isFX ? 0.08 : (vix / 100); 
        const dailyMove = price * (iv / Math.sqrt(252));
        
        // Institutional Adjustment for 0DTE Gamma
        const mmAlpha = 1.25; 
        const expectedRange = dailyMove * mmAlpha;
        
        return {
            upper: parseFloat((price + expectedRange).toFixed(2)),
            lower: parseFloat((price - expectedRange).toFixed(2)),
            range: parseFloat(expectedRange.toFixed(2)),
            confidence: 0.68
        };
    }

    /**
     * Macro Regime Engine
     * Evaluates yield curves, dollar strength, and volatility to determine market probability.
     */
    calculateMacroRegime(dxy, tnx, vix, spy) {
        const dxyChange = dxy.dailyChangePercent || 0;
        const tnxChange = tnx.dailyChangePercent || 0;
        const vixVal = vix.currentPrice || 15;
        const spyChange = spy.dailyChangePercent || 0;

        let status = 'ACCUMULATION';
        let regime = 'NEUTRAL';
        let probability = 50;

        if (dxyChange < 0 && tnxChange < 0 && vixVal < 18) {
            regime = 'RISK-ON';
            status = 'BULLISH_REVERSE';
            probability = 85;
        } else if (dxyChange > 0 || tnxChange > 0 || vixVal > 22) {
            regime = 'RISK-OFF';
            status = 'DISTRIBUTION';
            probability = 25;
        }

        return { regime, status, probability, dxy: dxyChange, tnx: tnxChange, vix: vixVal };
    }

    /**
     * Multi-Timeframe Alignment (G-Matrix)
     * Checks if multiple timeframes are synced for high-conviction momentum.
     */
    getMultiTFAlignment(candlesMap) {
        let score = 0;
        const matrix = {};
        const tfs = ['1m', '5m', '15m', '1h', '1d'];

        tfs.forEach(tf => {
            const candles = candlesMap[tf] || [];
            if (candles.length < 2) {
                matrix[tf] = 'NEUTRAL';
                return;
            }
            const last = candles[candles.length - 1];
            const prev = candles[candles.length - 2];
            const bias = last.close > prev.close ? 'BULLISH' : 'BEARISH';
            matrix[tf] = bias;
            score += (bias === 'BULLISH' ? 20 : -20);
        });

        let signal = 'NEUTRAL';
        if (score >= 60) signal = 'BULLISH_SYNCED';
        else if (score <= -60) signal = 'BEARISH_SYNCED';

        return { matrix, signal, score };
    }

    /**
     * Master Alpha Trigger
     * The final decision layer that calculates trade probability by merging all indicators.
     */
    calculateAlphaTrigger(irScore, macroRegime, goMatrix, price, gex, bias, candles, news = []) {
        let probability = 50;
        let conviction = 60;
        const notes = [];

        // Convergence logic
        if (irScore.score > 70 && macroRegime.regime === 'RISK-ON') probability += 15;
        if (goMatrix.signal.includes('SYNCED')) probability += 10;
        if (bias.bias === 'BULLISH' && irScore.bias === 'BULLISH') probability += 10;
        
        // News sentiment integration
        if (news.length > 0) {
            const sentiment = news[0].sentiment || 0;
            if (sentiment > 0.5) probability += 5;
            else if (sentiment < -0.5) probability -= 10;
        }

        // Trap detection proxy
        if (irScore.score > 85 && macroRegime.probability < 40) notes.push("DIVERGENCE TRAP DETECTED");

        return {
            probability: Math.min(100, Math.max(0, probability)),
            conviction: Math.min(100, Math.max(0, conviction)),
            status: probability > 75 ? 'HIGH_CONVICTION' : 'WATCHING',
            expertNotes: notes
        };
    }

    /**
     * Inversion FVG (I-FVG)
     * Detects when a Fair Value Gap is successfully "inverted" (broken through), 
     * flagging a massive shift in institutional momentum.
     */
    detectInversionFVG(candles, currentPrice) {
        if (!candles || candles.length < 5) return null;
        // Simple logic for identification
        const last = candles[candles.length - 1];
        const prev = candles[candles.length - 2];
        if (last.close > prev.high && prev.low > 0) return { type: 'BULLISH_INVERSION', level: prev.high };
        return null;
    }

    /**
     * Shadow Block Engine (Shadow Icebergs)
     * Detects hidden limit order clusters that only appear as "Shadows" in order flow.
     */
    detectShadowBlocks(candles, currentPrice) {
        if (!candles || candles.length < 10) return null;
        // Search for absorption signs (High wick, low body, high volume)
        const last = candles[candles.length - 1];
        if (last.volume > 100000 && Math.abs(last.close - last.open) < (last.high - last.low) * 0.3) {
            return { type: 'SHADOW_ICEBERG', price: last.high };
        }
        return null;
    }
}
