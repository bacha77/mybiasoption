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
            // ── STEP 0: Seed prevClose cache for FX pairs that Pyth doesn't supply ──
            // Run this once on cold start (cache missing). Yahoo has real prev close data.
            if (!this.prevCloseCache) this.prevCloseCache = {};
            const fxPairs = symbols.filter(s => s.includes('=X'));
            const coldFX  = fxPairs.filter(s => !this.prevCloseCache[s]);
            if (coldFX.length > 0) {
                await Promise.all(coldFX.map(async (sym) => {
                    try {
                        const q = await yahooFinance.quote(sym, {}, { validate: false }).catch(() => null);
                        if (q && q.regularMarketPrice > 0) {
                            const prevClose = q.regularMarketPreviousClose || q.regularMarketOpen || q.regularMarketPrice;
                            this.prevCloseCache[sym] = {
                                value: prevClose,
                                price: q.regularMarketPrice,
                                change: q.regularMarketChangePercent || 0,
                                time: Date.now()
                            };
                        }
                    } catch (e) {}
                }));
            }

            // ── STEP 1: Pyth (High Speed Institutional Oracle) ──────────────────
            const pythSymbols = symbols.filter(s => s !== 'VIX');
            const pythResults = await pythService.getLatestPrices(pythSymbols).catch(() => ({}));
            
            Object.keys(pythResults).forEach(sym => {
                const pyth = pythResults[sym];
                if (pyth && pyth.price > 0) {
                    // Pull real prevClose from the seeded cache (not price itself)
                    const cached = this.prevCloseCache[sym];
                    const prevClose = (cached && cached.value > 0) ? cached.value : null;
                    output[sym] = {
                        price:     pyth.price,
                        prevClose: prevClose,   // null if not yet seeded — ingestQuote handles null
                        confidence: pyth.confidence,
                        source:    'PYTH-BATCH'
                    };
                }
            });

            // ── STEP 2: Yahoo fallback for symbols Pyth missed ──────────────────
            const missing = symbols.filter(s => !output[s]);
            if (missing.length > 0) {
                await Promise.all(missing.map(async (sym) => {
                    try {
                        let metaSym = sym;
                        if (metaSym === 'VIX')  metaSym = '^VIX';
                        if (metaSym === 'DXY')  metaSym = 'DX-Y.NYB';
                        if (metaSym === 'GOLD') metaSym = 'GC=F';

                        // Yahoo Rate-Limit Shield: Only call if not in cache or 15s elapsed
                        const cached = this.prevCloseCache?.[metaSym];
                        if (cached && (Date.now() - cached.time < 15000)) {
                             output[sym] = { price: cached.price, prevClose: cached.value, source: 'CACHE' };
                             return;
                        }
                        
                        const q = await yahooFinance.quote(metaSym, {}, { validate: false }).catch(() => null);
                        if (q && q.regularMarketPrice > 0) {
                            output[sym] = {
                                price:     q.regularMarketPrice,
                                prevClose: q.regularMarketPreviousClose || q.regularMarketOpen,
                                change:    q.regularMarketChangePercent,
                                source:    'YAHOO-BENCH'
                            };
                            this.prevCloseCache[metaSym] = { value: output[sym].prevClose, price: q.regularMarketPrice, time: Date.now() };
                        }
                    } catch (e) {}
                }));
            }
        } catch (e) {
            console.error("[DATA SOURCE] Benchmark Pulse Failed:", e.message);
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
                    yahooFinance.quote(metaSym, {}, { validate: false }).then(quote => {
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
