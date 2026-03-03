
import YahooFinance from 'yahoo-finance2';
const yahooFinance = new YahooFinance();

async function inspectDaily() {
    const symbol = 'SPY';
    const date10d = new Date();
    date10d.setDate(date10d.getDate() - 10);
    const p1String = date10d.toISOString().split('T')[0];

    console.log(`Checking Daily Chart for ${symbol} starting ${p1String}...`);
    try {
        const dailyRes = await yahooFinance.chart(symbol, { period1: p1String, interval: '1d' });
        if (dailyRes && dailyRes.quotes) {
            const nyToday = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
            const todayStr = nyToday.toISOString().split('T')[0];

            console.log("Current NY Date String:", todayStr);
            console.log(`Total quotes: ${dailyRes.quotes.length}`);

            // Find candidates
            const candidates = dailyRes.quotes.filter(q => q.date && q.high);
            candidates.forEach((q, i) => {
                const qStr = q.date.toISOString().split('T')[0];
                console.log(`[${i}] Date: ${qStr} | H: ${q.high} | L: ${q.low}`);
            });

            // Pick the last one that IS NOT TODAY
            const historyOnly = candidates.filter(q => q.date.toISOString().split('T')[0] !== todayStr);
            if (historyOnly.length > 0) {
                const prev = historyOnly[historyOnly.length - 1];
                const prevStr = prev.date.toISOString().split('T')[0];
                console.log(`\nVerified Previous Day: ${prevStr} | H: ${prev.high} | L: ${prev.low}`);
            } else {
                console.log("No previous day found (only today or empty).");
            }
        }
    } catch (err) {
        console.error(err);
    }
}
inspectDaily();
