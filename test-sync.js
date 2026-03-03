
import { LiquidityEngine } from './src/logic/liquidity-engine.js';

async function testSynchronization() {
    const engine = new LiquidityEngine();
    // Mock session to be open for testing
    engine.getSessionInfo = () => ({ session: 'NY_OPEN', status: 'TESTING', color: '#00f2ff', isMarketOpen: true });

    const symbol = 'SPY';
    const timeframe = '1m';

    console.log("--- STARTING LIQUIDITY ENGINE SYNCHRONIZATION TEST ---\n");

    const markers = { pdh: 600.00, pdl: 590.00, vwap: 595.00, poc: 595.00, cvd: 0 };

    // Scenario 1: Partial Alignment
    let rec1 = engine.getOptionRecommendation({ score: 2, bias: 'NEUTRAL', cvd: 0 }, markers, 596.00, timeframe, symbol, []);
    console.log("Scenario 1 (Partial):", rec1.action === 'WAIT' ? "✅ PASS" : "❌ FAIL");
    console.log("-> Rationale:", rec1.rationale);

    // Scenario 2: Full Bullish Confluence
    let rec2 = engine.getOptionRecommendation({ score: 6, bias: 'BULLISH', cvd: 1200 }, { ...markers, cvd: 1200 }, 597.00, timeframe, symbol, []);
    console.log("\nScenario 2 (Bullish):", rec2.action === 'BUY CALL' ? "✅ PASS" : "❌ FAIL");
    console.log("-> Rationale:", rec2.rationale);

    // Scenario 3: Bullish Divergence at PDL
    let rec3 = engine.getOptionRecommendation({ score: 3, bias: 'NEUTRAL', cvd: 800 }, { ...markers, cvd: 800 }, 590.10, timeframe, symbol, []);
    console.log("\nScenario 3 (Divergence):", rec3.action === 'BUY CALL' ? "✅ PASS" : "❌ FAIL");
    console.log("-> Rationale:", rec3.rationale);

    // Scenario 4: Bearish Confluence
    let rec4 = engine.getOptionRecommendation({ score: -7, bias: 'BEARISH', cvd: -1500 }, { ...markers, cvd: -1500 }, 593.00, timeframe, symbol, []);
    console.log("\nScenario 4 (Bearish):", rec4.action === 'BUY PUT' ? "✅ PASS" : "❌ FAIL");
    console.log("-> Rationale:", rec4.rationale);

    console.log("\n--- TEST COMPLETE ---");
}

testSynchronization();
