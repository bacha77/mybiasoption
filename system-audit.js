
import 'dotenv/config';
import { RealDataManager } from './src/services/real-data-manager.js';
import { LiquidityEngine } from './src/logic/liquidity-engine.js';
import { SimulationTrader } from './src/services/simulation-trader.js';

async function runAudit() {
    console.log("=== BIAS DEEP AUDIT STARTED ===");
    let errors = 0;

    try {
        const simulator = new RealDataManager();
        const engine = new LiquidityEngine();
        const trader = new SimulationTrader();

        // 1. Check Data Consistency
        console.log("Checking Stock Object Structures...");
        const requiredFields = ['currentPrice', 'cvd', 'candles', 'bloomberg', 'news', 'dailyQuotes'];

        Object.keys(simulator.stocks).forEach(symbol => {
            const stock = simulator.stocks[symbol];
            requiredFields.forEach(field => {
                if (stock[field] === undefined) {
                    console.error(`[ERR] Missing field '${field}' in simulator.stocks['${symbol}']`);
                    errors++;
                }
            });
            // Check timeframes
            if (stock.candles['1h'] === undefined) {
                console.error(`[ERR] Missing '1h' timeframe in simulator.stocks['${symbol}'].candles`);
                errors++;
            }
        });

        // 2. Check Gamma Engine
        console.log("Validating Gamma Wall Logic...");
        const walls = engine.getGammaWalls(105.42, 'SPY');
        if (!Array.isArray(walls) || walls.length === 0) {
            console.error("[ERR] Gamma Wall logic returned invalid data for SPY");
            errors++;
        }
        const fxWalls = engine.getGammaWalls(1.0850, 'EURUSD=X');
        if (fxWalls[0] === undefined || !fxWalls.some(w => w.toString().includes('.'))) {
            console.error("[ERR] Gamma Wall logic returned invalid precision for FX");
            errors++;
        }

        // 3. Check State Persistence
        console.log("Checking Persistence Paths...");
        if (!trader.statePath || !trader.historyPath) {
            console.error("[ERR] SimulationTrader paths not initialized");
            errors++;
        }

        if (errors === 0) {
            console.log("✅ AUDIT PASSED: Core structures are consistent and logical.");
        } else {
            console.error(`❌ AUDIT FAILED: Found ${errors} structural issues.`);
        }

    } catch (err) {
        console.error("❌ CRITICAL AUDIT ERROR:", err.stack);
    }
}

runAudit();
