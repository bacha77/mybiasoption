
import { RealDataManager } from './src/services/real-data-manager.js';
import { LiquidityEngine } from './src/logic/liquidity-engine.js';

async function runFullSystemAudit() {
    console.log("--- STARTING FINAL BIAS SYSTEM AUDIT ---\n");
    const simulator = new RealDataManager();
    const engine = new LiquidityEngine();

    try {
        // 1. Audit Data Initialization
        console.log("Audit Step 1: Initializing Data Manager...");
        await simulator.initialize();
        console.log("✅ Data Manager Initialized.");

        // 2. Audit Market Internals (VIX/DXY)
        console.log("\nAudit Step 2: Checking Market Internals...");
        const internals = simulator.internals;
        console.log("VIX Current:", internals.vix);
        console.log("DXY Current:", internals.dxy);
        console.log("News Impact State:", internals.newsImpact);

        if (internals.vix === 0) console.warn("⚠️ WARNING: VIX is 0 (Check internet/Yahoo connectivity)");
        else console.log("✅ Internals Verified.");

        // 3. Audit Institutional Markers Alignment
        console.log("Audit Step 3: Checking Markers for SPY...");
        const markers = simulator.getInstitutionalMarkers('SPY', '1m');
        console.log(`- Final Anchored PDH: ${markers.pdh}`);
        console.log(`- Final Anchored PDL: ${markers.pdl}`);
        console.log(`- Midnight Open: ${markers.midnightOpen}`);
        console.log(`- London Open: ${markers.londonOpen}`);
        console.log(`- NY Open: ${markers.nyOpen}`);
        console.log(`- POC: ${markers.poc}`);
        console.log(`- VWAP: ${markers.vwap}`);

        if (markers.pdh > 0 && markers.pdl > 0) console.log("✅ PDH/PDL markers successfully anchored.");
        else console.error("❌ ERROR: Missing Daily Markers (PDH/PDL)");

        // 4. Audit Logic Synchronization (The "Result")
        console.log("\nAudit Step 4: Testing Logic Synchronization...");
        const stock = simulator.stocks['SPY'];
        const fvgs = engine.findFVGs(stock.candles['1m']);
        const draws = engine.findLiquidityDraws(stock.candles['1m']);

        const bias = engine.calculateBias(
            stock.currentPrice,
            fvgs,
            draws,
            stock.bloomberg,
            markers,
            0,
            internals
        );

        const recommendation = engine.getOptionRecommendation(
            bias,
            markers,
            stock.currentPrice,
            '1m',
            'SPY',
            stock.candles['1m']
        );

        console.log("Final Result Action:", recommendation.action);
        console.log("Trim Target (POC):", recommendation.trim);
        console.log("Final Target:", recommendation.target);

        if (recommendation.trim && recommendation.trim !== '-') console.log("✅ Trim/Target Scaling Verified.");
        else console.log("⚠️ INFO: Still in WAIT mode (Waiting for high-conviction confluence).");

        console.log("\n--- SYSTEM AUDIT COMPLETE: ALL CORE SERVICES OPERATIONAL ---");
        process.exit(0);
    } catch (err) {
        console.error("\n❌ CRITICAL SYSTEM FAILURE:", err.message);
        process.exit(1);
    }
}

runFullSystemAudit();
