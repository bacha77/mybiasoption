import YahooFinance from 'yahoo-finance2';

const yahooFinance = new YahooFinance();

async function testYahoo() {
    try {
        const query = 'SPY';
        const quote = await yahooFinance.quote(query);
        console.log(`Current price of ${query}: ${quote.regularMarketPrice}`);

        const chart = await yahooFinance.chart(query, { period1: '2026-02-20', interval: '1d' });
        console.log(`Fetched ${chart.quotes.length} candles for ${query}`);
    } catch (error) {
        console.error('Error fetching data:', error);
    }
}

testYahoo();
