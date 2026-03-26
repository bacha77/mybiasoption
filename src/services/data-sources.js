import YahooFinance from 'yahoo-finance2';
import axios from 'axios';
import { pythService } from './pyth-service.js';

export const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

export class DataSourceManager {
    constructor() {
        this.polygonKey = process.env.POLYGON_API_KEY;
        this.fhubKey = process.env.FINNHUB_API_KEY;
        this.lastSourceUsed = 'YAHOO';
    }

    async getQuote(symbol) {
        // Source 0: Pyth Network (Ultra-High Speed Institutional Oracle)
        try {
            const pyth = await pythService.getLatestPrice(symbol);
            if (pyth && pyth.price > 0) {
                this.lastSourceUsed = 'PYTH';
                // Try to get prevClose from Yahoo for % change, but return Pyth price immediately
                return {
                    price: pyth.price,
                    prevClose: null, // Will be filled by fallback logic if needed
                    confidence: pyth.confidence,
                    source: 'PYTH-HERMES'
                };
            }
        } catch (e) {}

        // Source 1: Yahoo Finance (Legacy Priority / History)
        try {
            const quote = await yahooFinance.quote(symbol, {}, { validate: false });

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
            // Silence common background pipe errors
            if (!err.message?.includes('EPIPE')) {
                console.warn(`[DATA SOURCE] Yahoo quote failed for ${symbol}, trying fallback...`);
            }
        }

        // Source 2: Polygon.io (Fallback for Stocks)
        if (this.polygonKey && !symbol.includes('=X') && !symbol.includes('^')) {
            try {
                const url = `https://api.polygon.io/v2/aggs/ticker/${symbol}/prev?adjusted=true&apiKey=${this.polygonKey}`;
                const res = await axios.get(url, { timeout: 10000 });
                if (res.data && res.data.results && res.data.results[0]) {
                    const r = res.data.results[0];
                    this.lastSourceUsed = 'POLYGON';
                    return {
                        price: r.c,
                        prevClose: r.c,
                        change: 0,
                        high: r.h,
                        low: r.l,
                        source: 'POLYGON'
                    };
                }
            } catch (err) {
                if (!err.message?.includes('EPIPE')) {
                    console.warn(`[DATA SOURCE] Polygon fallback failed for ${symbol}`);
                }
            }
        }

        // Source 3: Finnhub (Fallback for Quotes)
        if (this.fhubKey) {
            try {
                const url = `https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${this.fhubKey}`;
                const res = await axios.get(url, { timeout: 10000 });
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
                if (!err.message?.includes('EPIPE')) {
                    console.warn(`[DATA SOURCE] Finnhub fallback failed for ${symbol}`);
                }
            }
        }

        return null;
    }

    async getHistory(symbol, interval, daysBack) {
        // Yahoo Finance is still the best for deep history free
        try {
            const p1 = new Date();
            p1.setDate(p1.getDate() - daysBack);
            const chart = await yahooFinance.chart(symbol, { period1: p1, interval }, { validate: false });

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
