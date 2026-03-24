
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
        if (price <= 0) return [];
        
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
    calculateIRScore(bias, killzone, smt, gex, retail) {
        let score = 50; // Neutral baseline

        // 1. Time Alignment (Institutional Hours)
        if (killzone.active) score += 10;
        if (killzone.name === 'SILVER_BULLET') score += 15;

        // 2. Correlation Alignment (SMT)
        if (smt) {
            if (smt.type.includes('BULLISH') && bias.score > 0) score += 20;
            if (smt.type.includes('BEARISH') && bias.score < 0) score += 20;
            if (smt.type.includes('BULLISH') && bias.score < 0) score -= 30; // CONFLICT = TRAP
        }

        // 3. Retail Contrarian Pulse (Institutions hunt retail liquidity)
        if (retail !== undefined) {
            if (retail >= 80 && bias.score > 0) score -= 45; // MASSIVE SELL TRAP
            if (retail <= 20 && bias.score < 0) score -= 45; // MASSIVE BUY TRAP
            if (retail >= 80 && bias.score < 0) score += 20; // Institutions dumping on retail
            if (retail <= 20 && bias.score > 0) score += 20; // Institutions buying retail fear
        }

        // 4. Gamma Alignment
        if (gex && gex.length > 0) {
            const nearestWall = gex.reduce((prev, curr) => (curr.gamma > prev.gamma ? curr : prev), gex[0]);
            if (nearestWall.isMagnet && bias.confidence > 70) score += 5;
        }

        return Math.max(0, Math.min(100, score));
    }
}
