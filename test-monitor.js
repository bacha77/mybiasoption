import { LiquidityEngine } from './src/logic/liquidity-engine.js';
import { RealDataManager } from './src/services/real-data-manager.js';

async function monitor() {
    const engine = new LiquidityEngine();
    const simulator = new RealDataManager();
    await simulator.initialize();

    console.log(`\n[${new Date().toLocaleTimeString()}] --- LIVE GOLD STANDARD CHECK ---`);

    for (const symbol of simulator.watchlist) {
        const stock = simulator.stocks[symbol];
        const tf = '1m';
        const markers = simulator.getInstitutionalMarkers(symbol, tf);
        const midnightOpen = markers.midnightOpen;
        const vwap = markers.vwap;
        const poc = markers.poc;
        const cvd = markers.cvd;
        const price = stock.currentPrice;

        const isAboveOpen = price > midnightOpen;
        const isAboveVWAP = price > vwap;
        const isAbovePOC = price > poc;

        const isBelowOpen = price < midnightOpen;
        const isBelowVWAP = price < vwap;
        const isBelowPOC = price < poc;

        const bias = engine.calculateBias(price, [], { highs: [], lows: [] }, stock.bloomberg, markers, 0, simulator.internals);
        const rec = engine.getOptionRecommendation(bias, markers, price, tf, symbol, []);

        console.log(`${symbol}: $${price.toFixed(2)}`);
        console.log(`  M.Open: ${midnightOpen.toFixed(2)} | VWAP: ${vwap.toFixed(2)} | POC: ${poc.toFixed(2)} | CVD: ${cvd}`);
        console.log(`  Above: Open(${isAboveOpen}) VWAP(${isAboveVWAP}) POC(${isAbovePOC})`);
        console.log(`  Below: Open(${isBelowOpen}) VWAP(${isBelowVWAP}) POC(${isBelowPOC})`);
        console.log(`  STATUS: ${rec.action} (Stable: ${rec.isStable})`);
        console.log(`  Rationale: ${rec.rationale}`);
        console.log('------------------------------------------------');
    }
    process.exit(0);
}

monitor();
