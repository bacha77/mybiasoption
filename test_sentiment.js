
import 'dotenv/config';
import { RealDataManager } from './src/services/real-data-manager.js';

async function test() {
    const dataManager = new RealDataManager();
    console.log("Checking SPY Sentiment...");
    
    // Manual setup
    dataManager.stocks['SPY'] = { currentPrice: 585.00, candles: { '1m': [] } };
    
    console.log(`Test SPY Price: ${dataManager.stocks['SPY'].currentPrice}`);
    const sentiment = dataManager.calculateOvernightSentiment('SPY');
    console.log("Sentiment Result:", JSON.stringify(sentiment, null, 2));
}

test().catch(console.error);
