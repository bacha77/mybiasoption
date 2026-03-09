import yahooFinance from 'yahoo-finance2';

async function checkTimestamps() {
    const symbol = 'EURUSD=X';
    const tf = '1h';
    const p1 = new Date();
    p1.setDate(p1.getDate() - 2);

    console.log(`Current Time (Local): ${new Date().toLocaleString()}`);
    console.log(`Current Time (UTC): ${new Date().toUTCString()}`);

    try {
        const result = await yahooFinance.chart(symbol, { period1: p1, interval: tf });
        if (result && result.quotes) {
            console.log(`Received ${result.quotes.length} quotes for ${symbol} @ ${tf}`);
            const lastFew = result.quotes.slice(-5);
            lastFew.forEach(q => {
                console.log(`Date: ${q.date.toISOString()} | Timestamp: ${q.date.getTime()} | Open: ${q.open}`);
            });
        }
    } catch (e) {
        console.error(e);
    }
}

checkTimestamps();
