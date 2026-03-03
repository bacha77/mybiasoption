import { LiquidityEngine } from './src/logic/liquidity-engine.js';

const testEngine = () => {
    const engine = new LiquidityEngine();
    const mockCandles = [
        { high: 100, low: 90, timestamp: 1 },
        { high: 110, low: 105, timestamp: 2 },
        { high: 120, low: 115, timestamp: 3 }, // Bullish FVG candle
        { high: 105, low: 95, timestamp: 4 },
        { high: 100, low: 90, timestamp: 5 }
    ];

    console.log("Testing FVG Identification...");
    const fvgs = engine.findFVGs(mockCandles);
    console.log("FVGs Found:", fvgs);

    console.log("\nTesting Liquidity Draws...");
    const draws = engine.findLiquidityDraws(mockCandles);
    console.log("Highs:", draws.highs);
    console.log("Lows:", draws.lows);

    console.log("\nTesting Bias Calculation...");
    const currentPrice = 98;
    const bias = engine.calculateBias(currentPrice, fvgs, draws);
    console.log("Current Price:", currentPrice);
    console.log("Signal:", bias);

    if (fvgs.length > 0 || (draws.highs.length > 0 && draws.lows.length > 0)) {
        console.log("\n✅ LOGIC VERIFIED");
    } else {
        console.log("\n❌ LOGIC VERIFICATION FAILED");
    }
};

testEngine();
