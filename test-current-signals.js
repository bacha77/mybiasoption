import { LiquidityEngine } from './src/logic/liquidity-engine.js';
import { RealDataManager } from './src/services/real-data-manager.js';

async function test() {
    const engine = new LiquidityEngine();
    const simulator = new RealDataManager();

    console.log("Initializing Data Manager...");
    await simulator.initialize();

    console.log("\n--- CURRENT MARKET STATE ---");
    console.log(`News Impact: ${simulator.internals.newsImpact}`);
    console.log(`VIX: ${simulator.internals.vix}`);

    for (const symbol of simulator.watchlist) {
        const stock = simulator.stocks[symbol];
        const tf = '1m';
        const candles = stock.candles[tf];

        if (!candles || candles.length === 0) {
            console.log(`${symbol}: No candles`);
            continue;
        }

        const markers = simulator.getInstitutionalMarkers(symbol, tf);
        const relativeStrength = 0; // Simplified
        const internals = simulator.internals;

        const bias = engine.calculateBias(
            stock.currentPrice,
            engine.findFVGs(candles),
            engine.findLiquidityDraws(candles),
            stock.bloomberg,
            markers,
            relativeStrength,
            internals
        );

        const rec = engine.getOptionRecommendation(bias, markers, stock.currentPrice, tf, symbol, candles);

        console.log(`${symbol}:`);
        console.log(`  Price: $${stock.currentPrice}`);
        console.log(`  Bias: ${bias.bias} (Score: ${bias.score.toFixed(2)})`);
        console.log(`  VWAP: ${markers.vwap.toFixed(2)} | POC: ${markers.poc.toFixed(2)}`);
        console.log(`  Action: ${rec.action} (Stable: ${rec.isStable})`);
        console.log(`  Rationale: ${rec.rationale}`);
        console.log('----------------------------');
    }

    process.exit(0);
}

test().catch(console.error);
