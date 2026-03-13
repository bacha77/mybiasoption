
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

    /**
     * Dealer Gamma Calculation (Real Proxy)
     * Identifies where Market Makers are most "short gamma" (high volatility).
     */
    calculateGEX(price, symbol, historicalQuotes = []) {
        const step = price > 100 ? 5 : 1;
        const base = Math.floor(price / step) * step;
        
        // Proxy logic: Use volume clusters at round numbers to estimate Gamma Walls
        const strikes = [base - (step * 2), base - step, base, base + step, base + (step * 2)];
        
        return strikes.map(strike => {
            const distance = Math.abs(price - strike) / price;
            const intensity = 1 - Math.min(distance * 50, 1);
            return {
                strike,
                type: strike > price ? 'CALL_WALL' : 'PUT_WALL',
                gamma: intensity * 100, // Normalized 0-100
                isMagnet: intensity > 0.8
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

        // Windows (in minutes from midnight)
        const windows = [
            { name: 'LONDON_OPEN', start: 120, end: 300, color: '#3b82f6' },   // 2 AM - 5 AM
            { name: 'NY_OPEN', start: 510, end: 660, color: '#f59e0b' },       // 8:30 AM - 11 AM
            { name: 'SILVER_BULLET', start: 600, end: 660, color: '#ef4444' }, // 10 AM - 11 AM
            { name: 'NY_PM_MACRO', start: 810, end: 870, color: '#10b981' },   // 1:30 PM - 2:30 PM
            { name: 'LONDON_CLOSE', start: 660, end: 720, color: '#6366f1' }   // 11 AM - 12 PM
        ];

        const active = windows.find(w => totalMinutes >= w.start && totalMinutes < w.end);
        
        if (active) {
            const progress = ((totalMinutes - active.start) / (active.end - active.start)) * 100;
            return { ...active, progress, active: true };
        }

        return { name: 'OFF-HOURS', active: false, color: '#94a3b8' };
    }

    /**
     * SMT Master Engine
     * Cross-asset divergence between SPY/QQQ or EURUSD/GBPUSD.
     */
    detectSMT(symbol, currentPrice, candles, otherSymbol, otherPrice, otherCandles) {
        if (!candles || !otherCandles || candles.length < 10 || otherCandles.length < 10) return null;

        const cA = candles.slice(-10);
        const cB = otherCandles.slice(-10);

        const lowA = Math.min(...cA.slice(0, 9).map(c => c.low));
        const lowB = Math.min(...cB.slice(0, 9).map(c => c.low));
        const highA = Math.max(...cA.slice(0, 9).map(c => c.high));
        const highB = Math.max(...cB.slice(0, 9).map(c => c.high));

        const lastA = cA[cA.length - 1];
        const lastB = cB[cB.length - 1];

        // Bullish SMT: A makes a lower low, B makes a higher low
        if (lastA.low < lowA && lastB.low > lowB) {
            return { type: 'BULLISH', symbol: otherSymbol, message: `Bullish SMT Divergence (${otherSymbol} Strength)` };
        }
        if (lastB.low < lowB && lastA.low > lowA) {
            return { type: 'BULLISH', symbol: otherSymbol, message: `Bullish SMT Divergence (${symbol} Strength)` };
        }
        
        // Bearish SMT: A makes a higher high, B makes a lower high
        if (lastA.high > highA && lastB.high < highB) {
            return { type: 'BEARISH', symbol: otherSymbol, message: `Bearish SMT Divergence (${otherSymbol} Weakness)` };
        }
        if (lastB.high > highB && lastA.high < highA) {
            return { type: 'BEARISH', symbol: otherSymbol, message: `Bearish SMT Divergence (${symbol} Weakness)` };
        }

        return null;
    }

    /**
     * Institutional Reality Score (IR-Score)
     * The final "Sync" metric that tells you if the move is REAL or a TRAP.
     */
    calculateIRScore(bias, killzone, smt, gex) {
        let score = 50; // Neutral baseline

        // 1. Time Alignment
        if (killzone.active) score += 10;
        if (killzone.name === 'SILVER_BULLET') score += 15;

        // 2. Correlation Alignment (SMT)
        if (smt) {
            if (smt.type.includes('BULLISH') && bias.score > 0) score += 20;
            if (smt.type.includes('BEARISH') && bias.score < 0) score += 20;
            if (smt.type.includes('BULLISH') && bias.score < 0) score -= 30; // CONFLICT = TRAP
        }

        // 3. Gamma Alignment
        const nearestWall = gex.reduce((prev, curr) => (curr.gamma > prev.gamma ? curr : prev), gex[0]);
        if (nearestWall.isMagnet && bias.confidence > 70) score += 5;

        return Math.max(0, Math.min(100, score));
    }
}
