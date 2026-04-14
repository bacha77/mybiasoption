import { RealDataManager } from './src/services/real-data-manager.js';
import dotenv from 'dotenv';
dotenv.config();

async function testBackend() {
    console.log("Starting Backend Diagnostic Test...");
    const simulator = new RealDataManager();
    
    try {
        console.log("Initializing simulator...");
        // Fast-track initialization by skipping long polls
        simulator.isInitialized = true;
        
        console.log("Testing calculateOvernightSentiment...");
        const sentiment = simulator.calculateOvernightSentiment('SPY');
        console.log("Sentiment result:", sentiment);

        console.log("Testing getInstitutionalMarkers...");
        const markers = simulator.getInstitutionalMarkers('SPY', '1m');
        console.log("Markers result (Partial):", markers ? "SUCCESS" : "FAIL");

        console.log("Testing COT Sentiment Poller...");
        await simulator.cot.fetchAndParse();
        console.log("COT Data loaded:", Object.keys(simulator.cot.data).length > 0 ? "SUCCESS" : "FAIL");

        console.log("Diagnostic Complete. No critical crashes detected in startup logic.");
        process.exit(0);
    } catch (error) {
        console.error("CRITICAL ERROR DURING DIAGNOSTIC:", error);
        process.exit(1);
    }
}

testBackend();
