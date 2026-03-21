import YahooFinance from 'yahoo-finance2';
import axios from 'axios';

const yahooFinance = new YahooFinance();

export class DataSourceManager {
    constructor() {
        this.polygonKey = process.env.POLYGON_API_KEY;
        this.fhubKey = process.env.FINNHUB_API_KEY;
        this.lastSourceUsed = 'YAHOO';
    }

    async getQuote(symbol) {
        // Source 1: Yahoo Finance (Priority)
        try {
            const quote = await yahooFinance.quote(symbol);
            if (quote && quote.regularMarketPrice > 0) {
                this.lastSourceUsed = 'YAHOO';
                return {
                    price: quote.regularMarketPrice,
                    prevClose: quote.regularMarketPreviousClose,
                    change: quote.regularMarketChangePercent,
                    high: quote.regularMarketDayHigh,
                    low: quote.regularMarketDayLow,
                    source: 'YAHOO'
                };
            }
        } catch (err) {
            console.warn(`[DATA SOURCE] Yahoo quote failed for ${symbol}, trying fallback...`);
        }

        // Source 2: Polygon.io (Fallback for Stocks)
        if (this.polygonKey && !symbol.includes('=X') && !symbol.includes('^')) {
            try {
                // Polygon Ticker format: SPY, TSLA (no changes needed for most)
                const url = `https://api.polygon.io/v2/aggs/ticker/${symbol}/prev?adjusted=true&apiKey=${this.polygonKey}`;
                const res = await axios.get(url);
                if (res.data && res.data.results && res.data.results[0]) {
                    const r = res.data.results[0];
                    this.lastSourceUsed = 'POLYGON';
                    return {
                        price: r.c, // Close of previous day as starting point if real-time fails
                        prevClose: r.c,
                        change: 0,
                        high: r.h,
                        low: r.l,
                        source: 'POLYGON'
                    };
                }
            } catch (err) {
                console.warn(`[DATA SOURCE] Polygon fallback failed for ${symbol}`);
            }
        }

        // Source 3: Finnhub (Fallback for Quotes)
        if (this.fhubKey) {
            try {
                const url = `https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${this.fhubKey}`;
                const res = await axios.get(url);
                if (res.data && res.data.c > 0) {
                    this.lastSourceUsed = 'FINNHUB';
                    return {
                        price: res.data.c,
                        prevClose: res.data.pc,
                        change: res.data.dp,
                        high: res.data.h,
                        low: res.data.l,
                        source: 'FINNHUB'
                    };
                }
            } catch (err) {
                console.warn(`[DATA SOURCE] Finnhub fallback failed for ${symbol}`);
            }
        }

        return null;
    }

    async getHistory(symbol, interval, daysBack) {
        // Yahoo Finance is still the best for deep history free
        try {
            const p1 = new Date();
            p1.setDate(p1.getDate() - daysBack);
            const chart = await yahooFinance.chart(symbol, { period1: p1, interval });
            if (chart && chart.quotes) {
                return chart.quotes.filter(q => q.open != null && q.open > 0);
            }
        } catch (err) {
            console.error(`[DATA SOURCE] Global History Failure for ${symbol}`);
        }
        return [];
    }
}

export const sourceManager = new DataSourceManager();
