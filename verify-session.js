import 'dotenv/config';
import { RealDataManager } from './src/services/real-data-manager.js';
import { LiquidityEngine } from './src/logic/liquidity-engine.js';

async function verifySignals() {
    const simulator = new RealDataManager();
    const engine = new LiquidityEngine();

    console.log("--- Verifying Current NY Session Signals ---");
    await simulator.initialize();

    // Give it a moment to fetch data
    await new Promise(r => setTimeout(r, 3000));

    const internals = simulator.internals;
    console.log(`\n[MACO CHECK] VIX: ${internals.vix.toFixed(2)} | DXY (UUP Proxy): ${internals.dxy.toFixed(2)}`);
    console.log(`[NEWS CHECK] Impact: ${internals.newsImpact}`);

    for (const symbol of ['SPY', 'NVDA', 'QQQ']) {
        const stock = simulator.stocks[symbol];
        if (!stock) continue;

        const tf = '1m';
        const candles = stock.candles[tf];
        const markers = simulator.getInstitutionalMarkers(symbol, tf);

        // Mocking some metrics for verification
        const bloomberg = stock.bloomberg;
        const bias = engine.calculateBias(stock.currentPrice, [], { highs: [], lows: [] }, bloomberg, markers, 0, internals, symbol);
        const rec = engine.getOptionRecommendation(bias, markers, stock.currentPrice, tf, symbol, candles);

        console.log(`\n[${symbol}] Price: $${stock.currentPrice.toFixed(2)}`);
        console.log(`Bias: ${bias.bias} (Score: ${bias.score}, Conf: ${bias.confidence}%)`);
        console.log(`Action: ${rec.action} | Stable: ${rec.isStable}`);
        console.log(`Rationale: ${rec.rationale}`);

        // Check Gold Standard + Macro Filter
        const dxyPrev = simulator.stocks['UUP']?.previousClose || 0;
        const isCall = rec.action.includes('CALL');
        const isPut = rec.action.includes('PUT');

        const trendAlign = true; // Mocking for check
        const macroAligned = isCall ? (internals.vix < 22 && internals.dxy <= dxyPrev * 1.002) :
            isPut ? (internals.vix > 15 && internals.dxy >= dxyPrev * 0.998) : false;

        const isGoldStandard = rec.isStable && (bias.confidence >= 80) && macroAligned;

        if (isGoldStandard && rec.action !== 'WAIT') {
            console.log(`✅ VERIFIED: This signal WOULD fire to Telegram.`);
        } else if (rec.action !== 'WAIT') {
            console.log(`❌ BYPASSED: Signal exists but failed filter.`);
            if (!macroAligned) console.log(`   - Reason: Macro Mismatch (VIX: ${internals.vix.toFixed(2)}, DXY: ${internals.dxy.toFixed(2)})`);
            if (bias.confidence < 80) console.log(`   - Reason: Confidence too low (${bias.confidence}%)`);
        } else {
            console.log(`⏳ STATUS: Waiting for institutional setup.`);
        }
    }

    process.exit(0);
}

verifySignals();
