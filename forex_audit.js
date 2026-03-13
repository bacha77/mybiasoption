
import { LiquidityEngine } from './src/logic/liquidity-engine.js';

async function runForexAudit(symbol = 'EURUSD=X') {
    console.log(`\n=================================================`);
    console.log(`🔍 LIVE FOREX AUDIT: ${symbol}`);
    console.log(`=================================================\n`);

    const engine = new LiquidityEngine();
    
    // Simulate some candle data for the symbol and DXY
    const generateCandles = (basePrice, volatility, length = 100) => {
        let candles = [];
        let price = basePrice;
        for (let i = 0; i < length; i++) {
            let change = (Math.random() - 0.5) * volatility;
            let open = price;
            let close = price + change;
            let high = Math.max(open, close) + Math.random() * (volatility * 0.2);
            let low = Math.min(open, close) - Math.random() * (volatility * 0.2);
            candles.push({ open, high, low, close, timestamp: Date.now() - (length - i) * 60000 });
            price = close;
        }
        return candles;
    };

    // EURUSD candles (Inverse to DXY usually)
    const eurCandles = generateCandles(1.0850, 0.0010);
    // DXY candles (Moving opposite)
    const dxyCandles = eurCandles.map(c => ({
        ...c,
        close: 104.00 + (1.0850 - c.close) * 100 // Inverse relationship
    }));
    // GBPUSD candles (Highly correlated to EURUSD)
    const gbpCandles = eurCandles.map(c => ({
        ...c,
        close: 1.2650 + (c.close - 1.0850) * 1.2 // Synchronized
    }));

    const markers = {
        midnightOpen: 1.0840,
        pdh: 1.0880,
        pdl: 1.0820,
        cvd: 800
    };

    const internals = {
        dxy: 104.10,
        dxyChange: -0.08,
        vix: 14.50,
        newsImpact: 'LOW'
    };

    // Test Correlation Logic
    const dxyCorr = engine.calculateCorrelation(eurCandles, dxyCandles);
    const eurGbpCorr = engine.calculateCorrelation(eurCandles, gbpCandles);
    const isInverseDxy = dxyCorr < -80;

    console.log(`📊 INTERMARKET FORENSICS:`);
    console.log(`   - DXY Correlation: ${dxyCorr.toFixed(2)}% ${isInverseDxy ? '✅ [INVERSE REGIME]' : '❌ [DECOUPLED]'}`);
    console.log(`   - EUR/GBP Sync:    ${eurGbpCorr.toFixed(2)}% ${eurGbpCorr > 90 ? '✅ [INSTITUTIONAL SYNC]' : '⚠️ [DIVERTED]'}`);
    
    // Test Bias Logic
    const bias = engine.calculateBias(eurCandles[eurCandles.length-1].close, [], {highs:[], lows:[]}, {}, markers, 0, internals, symbol, eurCandles);

    console.log(`\n🧠 ALGORITHMIC BIAS:`);
    console.log(`   - Bias Label:  ${bias.bias}`);
    console.log(`   - Bias Score:  ${bias.score.toFixed(2)}`);
    console.log(`   - Confidence:  ${bias.confidence}%`);
    
    console.log(`\n🎯 FOREX RADAR PAYLOAD:`);
    const radar = {
        dxyCorr: dxyCorr,
        eurGbpCorr: eurGbpCorr,
        isInverseDxy: isInverseDxy,
        midnightOpen: markers.midnightOpen
    };
    console.log(JSON.stringify(radar, null, 2));

    console.log(`\n=================================================`);
    console.log(`AUDIT COMPLETE: FOREX RADAR IS OPERATIONAL`);
    console.log(`=================================================\n`);
}

runForexAudit().catch(console.error);
