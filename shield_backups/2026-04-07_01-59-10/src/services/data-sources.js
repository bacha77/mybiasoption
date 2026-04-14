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

    async getQuotes(symbols) {
        const output = {};
        try {
            // STEP 0: Cache initialization
            if (!this.prevCloseCache) this.prevCloseCache = {};

            // STEP 1: Pyth (High Speed Institutional Oracle)
            const pythSymbols = symbols.filter(s => s !== 'VIX');
            const pythResults = await pythService.getLatestPrices(pythSymbols).catch(() => ({}));
            
            Object.keys(pythResults).forEach(sym => {
                const pyth = pythResults[sym];
                if (pyth && pyth.price > 0) {
                    const cached = this.prevCloseCache[sym];
                    output[sym] = {
                        price:     pyth.price,
                        prevClose: (cached && cached.value > 0) ? cached.value : null,
                        confidence: pyth.confidence,
                        source:    'PYTH-BATCH'
                    };
                }
            });

            // STEP 2: Yahoo fallback (Rate-Limited Sequential Batches)
            const missing = symbols.filter(s => !output[s] || !output[s].prevClose);
            if (missing.length > 0) {
                // Batch size of 5 to avoid 429/403 errors
                const batchSize = 5;
                for (let i = 0; i < missing.length; i += batchSize) {
                    const batch = missing.slice(i, i + batchSize);
                    await Promise.all(batch.map(async (sym) => {
                        try {
                            let metaSym = sym;
                            if (metaSym === 'VIX')  metaSym = '^VIX';
                            if (metaSym === 'DXY')  metaSym = 'DX-Y.NYB';
                            if (metaSym === 'GOLD') metaSym = 'GC=F';

                            // Rate limit protection: Cache for 20s minimum (even on failure to avoid hammering)
                            const cached = this.prevCloseCache[metaSym];
                            const lastAttempt = this.lastPollAttempt?.[metaSym] || 0;
                            const now = Date.now();
                            
                            if (cached && (now - cached.time < 20000)) {
                                if (output[sym]) {
                                    output[sym].prevClose = cached.value;
                                } else if (cached.price > 0) {
                                    output[sym] = { price: cached.price, prevClose: cached.value, source: 'CACHE' };
                                }
                                return;
                            }

                            // If we already tried this symbol in the last 10s and it failed, skip it to avoid ban
                            if (now - lastAttempt < 10000) return;
                            
                            if (!this.lastPollAttempt) this.lastPollAttempt = {};
                            this.lastPollAttempt[metaSym] = now;
                            
                            const q = await Promise.race([
                                yahooFinance.quote(metaSym, {}, { validate: false }),
                                new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 8000))
                            ]).catch(err => {
                                if (err.message === 'TIMEOUT') console.warn(`[DATA SOURCE] Yahoo quote TIMEOUT for ${metaSym}`);
                                return null;
                            });

                            if (q && q.regularMarketPrice > 0) {
                                const pc = q.regularMarketPreviousClose || q.regularMarketOpen || q.regularMarketPrice;
                                if (output[sym]) {
                                    output[sym].prevClose = pc;
                                    output[sym].change = q.regularMarketChangePercent;
                                } else {
                                    output[sym] = {
                                        price:     q.regularMarketPrice,
                                        prevClose: pc,
                                        change:    q.regularMarketChangePercent,
                                        source:    'YAHOO-BENCH'
                                    };
                                }
                                this.prevCloseCache[metaSym] = { value: pc, price: q.regularMarketPrice, time: Date.now() };
                            }
                        } catch (e) {}
                    }));
                    if (i + batchSize < missing.length) await new Promise(r => setTimeout(r, 600)); // Cool down
                }
            }
        } catch (e) {
            console.error("[DATA SOURCE] Benchmark Batch Sync Failed:", e.message);
        }
        return output;
    }

    async getQuote(symbol) {
        // Source 0: Pyth Network (Ultra-High Speed Institutional Oracle)
        try {
            const pyth = await pythService.getLatestPrice(symbol);
            if (pyth && pyth.price > 0) {
                this.lastSourceUsed = 'PYTH';
                
                // --- INSTANT CACHE & ASYNC META (Performance Boost) ---
                if (!this.prevCloseCache) this.prevCloseCache = {};
                
                // Harmonize Metadata Source (Yahoo)
                let metaSym = symbol;
                if (metaSym === 'VIX') metaSym = '^VIX';
                if (metaSym === 'DXY') metaSym = 'DX-Y.NYB';
                if (metaSym === 'GOLD') metaSym = 'GC=F';

                const cached = this.prevCloseCache[metaSym];
                const now = Date.now();
                
                // If cache missing or older than 1 hour, refresh asychnronously
                if (!cached || (now - cached.time > 3600000)) {
                    Promise.race([
                        yahooFinance.quote(metaSym, {}, { validate: false }),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 8000))
                    ]).then(quote => {

                        if (quote) {
                            this.prevCloseCache[metaSym] = {
                                value: quote.regularMarketPreviousClose || quote.regularMarketOpen || quote.regularMarketPrice,
                                time: Date.now()
                            };
                        }
                    }).catch(() => {});
                }

                let prevClose = cached ? cached.value : null;
                if (!prevClose) {
                    const fallback = { 
                        'SPY': 635, 'QQQ': 560, 'DIA': 450, 'DXY': 105.5, 'VIX': 18.5, 'GOLD': 2500,
                        'EURUSD=X': 1.080, 'GBPUSD=X': 1.260, 'USDJPY=X': 151.50, 'AUDUSD=X': 0.655,
                        'USDCAD=X': 1.365, 'NZDUSD=X': 0.598, 'USDCHF=X': 0.905
                    };
                    prevClose = fallback[symbol] || pyth.price;
                }

                return {
                    price: pyth.price,
                    prevClose: prevClose, 
                    confidence: pyth.confidence,
                    source: 'PYTH-HERMES-V2'
                };
            }
        } catch (e) {}

        // Source 1: Yahoo Finance (Legacy Priority / History)
        try {
            const quote = await Promise.race([
                yahooFinance.quote(symbol, {}, { validate: false }),
                new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 8000))
            ]);

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

    async getHistoricalData(symbol, tf) {
        let sym = symbol.toUpperCase().trim();
        if (sym === 'BTCUSD') sym = 'BTC-USD';
        if (sym === 'EURUSD') sym = 'EURUSD=X';
        if (sym === 'GBPUSD') sym = 'GBPUSD=X';
        if (sym === 'USDJPY') sym = 'USDJPY=X';
        if (sym === 'AUDUSD') sym = 'AUDUSD=X';
        if (sym === 'USDCAD') sym = 'USDCAD=X';
        if (sym === 'USDCHF') sym = 'USDCHF=X';
        if (sym === 'NZDUSD') sym = 'NZDUSD=X';
        if (sym === 'DXY') sym = 'DX-Y.NYB';
        if (sym === 'VIX') sym = '^VIX';
        if (sym === 'GOLD') sym = 'GC=F';
        
        const daysBack = tf === '1d' ? 60 : (tf === '1h' ? 7 : 2);
        return await this.getHistory(sym, tf, daysBack);
    }

    async getHistory(symbol, interval, daysBack) {
        // --- PRIORITY 1: Yahoo Finance (Best for Free Deep History) ---
        try {
            const p1 = new Date();
            p1.setDate(p1.getDate() - daysBack);
            const chart = await Promise.race([
                yahooFinance.chart(symbol, { period1: p1, interval }, { validate: false }),
                new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 12000))
            ]);

            if (chart && chart.quotes && chart.quotes.length > 0) {
                return chart.quotes.filter(q => q.open != null && q.open > 0).map(q => ({
                    date: q.date,
                    open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume
                }));
            }
        } catch (err) {}

        // --- FALLBACK 1: Polygon.io (High Reliability for US Equities/FX) ---
        if (this.polygonKey) {
            try {
                let multiplier = 1, timespan = 'minute';
                if (interval === '1h') { multiplier = 1; timespan = 'hour'; }
                else if (interval === '1d') { multiplier = 1; timespan = 'day'; }
                else { multiplier = parseInt(interval.replace('m', '')) || 1; }

                const p1 = new Date();
                p1.setDate(p1.getDate() - daysBack);
                const from = p1.toISOString().split('T')[0];
                const to = new Date().toISOString().split('T')[0];

                let polyTicker = symbol.replace('=X', '');
                if (symbol.includes('=X')) polyTicker = `C:${polyTicker}`;
                
                const url = `https://api.polygon.io/v2/aggs/ticker/${polyTicker}/range/${multiplier}/${timespan}/${from}/${to}?adjusted=true&sort=asc&apiKey=${this.polygonKey}`;
                const res = await axios.get(url, { timeout: 10000 });
                
                if (res.data && res.data.results) {
                    console.log(`[DATA SOURCE] Polygon successfully recovered ${res.data.results.length} candles for ${symbol}`);
                    return res.data.results.map(r => ({
                        date: new Date(r.t),
                        open: r.o, high: r.h, low: r.l, close: r.c, volume: r.v
                    }));
                }
            } catch (err) {
                console.warn(`[DATA SOURCE] Polygon Fallback Refused for ${symbol}:`, err.message);
            }
        }

        // --- FALLBACK 2: Finnhub (Lightweight Candle Recovery) ---
        if (this.fhubKey) {
            try {
                const end = Math.floor(Date.now() / 1000);
                const start = end - (daysBack * 86400);
                const resolution = interval === '1d' ? 'D' : (interval === '1h' ? '60' : interval.replace('m', ''));
                
                const cleanSym = symbol.replace('=X', '').replace('^', '');
                const url = `https://finnhub.io/api/v1/stock/candle?symbol=${cleanSym}&resolution=${resolution}&from=${start}&to=${end}&token=${this.fhubKey}`;
                const res = await axios.get(url, { timeout: 10000 });
                
                if (res.data && res.data.s === 'ok') {
                    console.log(`[DATA SOURCE] Finnhub successfully recovered ${res.data.c.length} candles for ${symbol}`);
                    return res.data.c.map((c, i) => ({
                        date: new Date(res.data.t[i] * 1000),
                        open: res.data.o[i], high: res.data.h[i], low: res.data.l[i], close: c, volume: res.data.v[i]
                    }));
                }
            } catch (err) {}
        }

        console.error(`[DATA SOURCE] Critical Failure: No historical candles available for ${symbol} via any provider.`);
        return [];
    }
}

export const sourceManager = new DataSourceManager();
