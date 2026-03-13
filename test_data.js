import 'dotenv/config';
import { RealDataManager } from './src/services/real-data-manager.js';

async function test() {
    console.log("Starting diagnostic scan...");
    const manager = new RealDataManager();
    
    // Test Yahoo Finance History
    console.log("Testing Yahoo Finance connectivity...");
    try {
        await manager.refreshHistoricalData('SPY');
        const spy = manager.stocks['SPY'];
        if (spy && spy.candles['5m'].length > 0) {
            console.log(`✅ SUCCESS: Real SPY history loaded. Last Close: ${spy.currentPrice}`);
        } else {
            console.log("❌ ERROR: SPY history is empty.");
        }
    } catch (e) {
        console.log(`❌ ERROR: Yahoo Finance failed. ${e.message}`);
    }

    // Test Finnhub Connectivity
    console.log("Testing Finnhub WebSocket connectivity...");
    if (process.env.FINNHUB_API_KEY) {
        console.log("✅ Finnhub API Key found.");
    } else {
        console.log("❌ ERROR: FINNHUB_API_KEY missing from environment.");
    }
}

test().then(() => process.exit(0));
