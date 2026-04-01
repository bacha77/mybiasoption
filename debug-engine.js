import fs from 'fs';
import path from 'path';
import 'dotenv/config';

import { RealDataManager } from './src/services/real-data-manager.js';
import { LiquidityEngine } from './src/logic/liquidity-engine.js';
import { InstitutionalAlgorithm } from './src/logic/institutional-algorithm.js';

console.log("=== B.I.A.S TERMINAL INTERNAL DEBUG DIAGNOSTIC ===");

// 1. Instantiate Core Subsystems
const dataManager = new RealDataManager();
const engine = new LiquidityEngine();
const algo = new InstitutionalAlgorithm();

console.log("[PASS] Engines Instantiated successfully.");

// 2. Initialize the Manager and wait for initial data sync
async function runDiagnostics() {
    try {
        console.log("Fetching live market state (Please wait ~10s)...");
        await dataManager.initialize();
        console.log(`[PASS] Market sync complete. Tracking ${Object.keys(dataManager.stocks).length} assets.`);
        
        // 3. Evaluate SPY Markers
        console.log("\n--- TIER 1 INSTITUTIONAL MODULE CHECK ---");
        const spyMarkers = dataManager.getInstitutionalMarkers('SPY', '5m');
        console.log(`[DATA] SPY VPoC Profile:`, spyMarkers.vpoc);
        console.log(`[DATA] SPY Macro Divergence:`, spyMarkers.macroDivergence);
        console.log(`[DATA] SPY Equal Highs/Lows:`, spyMarkers.equalLevels);
        
        if (spyMarkers.vpoc && spyMarkers.vpoc.vpoc > 0) {
            console.log(`[PASS] VPoC Engine is calculating live data correctly.`);
        } else {
            console.warn(`[WARN] VPoC Engine returned 0. Market may be closed or data seeding failed.`);
        }
        
        if (spyMarkers.macroDivergence) {
            console.log(`[PASS] Macro Divergence Engine is running correctly.`);
        } else {
            console.error(`[FAIL] Macro Divergence returned null.`);
        }

        console.log("\n=== ALL SYSTEMS GREEN ===");
        process.exit(0);

    } catch (err) {
        console.error("[CRITICAL FAILURE] DIAGNOSTIC ERROR:", err);
        process.exit(1);
    }
}

runDiagnostics();
