import 'dotenv/config';
import { RealDataManager } from './src/services/real-data-manager.js';

async function auditData() {
    const manager = new RealDataManager();
    console.log("--- STARTING SYSTEM DATA AUDIT ---");

    await manager.initialize();

    // Give it a few seconds to stabilize and receive WS messages
    console.log("Waiting for data stabilization (5s)...");
    await new Promise(r => setTimeout(r, 5000));

    console.log("\n[INTERNAL CHECK]");
    console.log(`VIX: ${manager.internals.vix}`);
    console.log(`DXY: ${manager.internals.dxy}`);

    console.log("\n[SECTOR CHECK]");
    manager.sectors.forEach(s => {
        const stock = manager.stocks[s];
        console.log(`${s}: Price=${stock.currentPrice}, PrevClose=${stock.previousClose}, Change=${stock.dailyChangePercent.toFixed(2)}%`);
    });

    console.log("\n[WATCHLIST CHECK]");
    manager.watchlist.slice(0, 3).forEach(s => {
        const stock = manager.stocks[s];
        console.log(`${s}: Price=${stock.currentPrice}, PrevClose=${stock.previousClose}, Change=${stock.dailyChangePercent.toFixed(2)}%`);
    });

    if (manager.sectors.every(s => manager.stocks[s].dailyChangePercent === 0)) {
        console.log("\n❌ ERROR: Sectors are NOT receiving live data.");
    } else {
        console.log("\n✅ SUCCESS: Sector data is flowing.");
    }

    process.exit(0);
}

auditData();
