
import YahooFinance from 'yahoo-finance2';
const yahooFinance = new YahooFinance();

async function testYahoo() {
    try {
        console.log("Testing historical call...");
        const res = await yahooFinance.historical('SPY', { period1: '2026-01-01', interval: '1d' });
        console.log("✅ Success! Length:", res.length);

        console.log("\nTesting chart call...");
        const res2 = await yahooFinance.chart('SPY', { period1: '2026-02-20', interval: '1m' });
        console.log("✅ Success! Quotes:", res2.quotes.length);
    } catch (err) {
        console.error("❌ Failed:", err.message);
        if (err.errors) console.error("Validation Errors:", JSON.stringify(err.errors, null, 2));
    }
}
testYahoo();
