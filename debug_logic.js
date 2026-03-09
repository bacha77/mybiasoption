
import { RealDataManager } from './src/services/real-data-manager.js';
import { LiquidityEngine } from './src/logic/liquidity-engine.js';
import dotenv from 'dotenv';
dotenv.config();

async function test() {
    const rdm = new RealDataManager();
    await rdm.initialize();

    const symbol = 'NVDA';
    const stock = rdm.stocks[symbol];
    console.log(`Initial ${symbol} Price: ${stock.currentPrice}`);

    // Simulate a $1.1M trade (threshold is 100k)
    // We need tradeValue >= 100000. 180 * 600 = 108,000.
    const volume = 6000; // 180 * 6000 = 1,080,000 (Elite)
    rdm.updatePriceFromTrade(symbol, stock.currentPrice + 0.1, volume);
    console.log(`Updated netWhaleFlow: ${stock.netWhaleFlow}`);

    const markers = rdm.getInstitutionalMarkers(symbol, '1m');
    console.log(`Markers netWhaleFlow: ${markers.netWhaleFlow}`);

    const engine = new LiquidityEngine();
    const bias = { bias: 'BULLISH', score: 10, confidence: 90, internals: rdm.internals };
    const rec = engine.getOptionRecommendation(bias, markers, stock.currentPrice, '1m', symbol, stock.candles['1m']);
    console.log(`Recommendation R/R: ${rec.rrRatio}`);

    process.exit(0);
}

test().catch(err => {
    console.error(err);
    process.exit(1);
});
