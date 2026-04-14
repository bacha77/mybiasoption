import WebSocket from 'ws';
import { InstitutionalAlgorithm } from '../logic/institutional-algorithm.js';
import { LiquidityEngine } from '../logic/liquidity-engine.js';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { sourceManager, yahooFinance } from './data-sources.js';
import { CotService } from './cot-service.js';
import supabase from './supabase-client.js';

export class RealDataManager {
    constructor() {
        this.apiKey = process.env.FINNHUB_API_KEY;
        this.configPath = path.join(process.cwd(), 'watchlist.json');
        this.watchlist = this.loadWatchlist();
        this.sectors = ['SPY', 'QQQ', 'DIA', 'IWM', 'BTC-USD', 'DXY', 'VIX', 'GOLD', 'GLD', 'XLK', 'XLY', 'XLF', 'XLC', 'XLE', 'XLV', 'XLI', 'XLP', 'XLU', 'XLRE', 'XLB', 'SMH', 'NVDA', 'AMD', 'META', 'GOOGL', 'TSLA', 'AAPL', 'MSFT', 'KRE', 'XBI', 'IYT', 'EURUSD=X', 'GBPUSD=X', 'USDJPY=X', 'AUDUSD=X', 'NZDUSD=X', 'USDCAD=X', 'USDCHF=X', '^TNX', 'UUP'];
        this.symbolMap = {
            'EURUSD=X': 'OANDA:EUR_USD',
            'GBPUSD=X': 'OANDA:GBP_USD',
            'USDJPY=X': 'OANDA:USD_JPY',
            'AUDUSD=X': 'OANDA:AUD_USD',
            'NZDUSD=X': 'OANDA:NZD_USD',
            'USDCAD=X': 'OANDA:USD_CAD',
            'USDCHF=X': 'OANDA:USD_CHF',
            'BTC-USD': 'BINANCE:BTCUSDT',
            'DXY': 'DX-Y',
            'VIX': '^VIX',
            'GOLD': 'GLD'
        };
        this.revMap = Object.fromEntries(Object.entries(this.symbolMap).map(([k, v]) => [v, k]));

        this.timeframes = ['1m', '5m', '15m', '1h', '1d'];
        this.currentTimeframe = '1m';
        this.currentSymbol = 'SPY';
        this.stocks = {};
        this.internals = { vix: 0, vixPrev: 0, dxy: 0, dxyPrev: 0, tnx: 0, newsImpact: 'LOW', breadth: 50 };
        this.ws = null;
        this.isInitialized = false;

        // Unified Symbols for consistent frontend mapping
        const macroIndices = ['DXY', 'VIX', '^TNX', 'BTC-USD', 'GOLD'];
        const listToInitialize = [...new Set([...this.watchlist, ...macroIndices, ...this.sectors])];

        this.eliteAlgo = new InstitutionalAlgorithm();
        listToInitialize.forEach(symbol => { 
            this.stocks[symbol] = {
                currentPrice: 0,
                previousClose: 0,
                dailyChangePercent: 0,
                cvd: 0,
                netWhaleFlow: 0, 
                whaleBuyVol: 0,
                whaleSellVol: 0,
                volumeClusters: {},
                dailyQuotes: [],
                candles: {},
                bloomberg: { omon: 'NEUTRAL', btm: 'STALE', wei: 'NEUTRAL', sentiment: 0 },
                news: []
            };
            this.timeframes.forEach(tf => this.stocks[symbol].candles[tf] = []);
        });

        this.blockTrades = []; // Store recent institutional blocks
        this.activePositions = {}; // Tracks { [symbol]: { type, entry, sl, tp, active } }
        this.onBlockCallback = null;
        this.onPriceUpdateCallback = null;
        this.maxBlockTrades = 20; // Keep only 20 most recent
        this.cot = new CotService();
        this.engine = new LiquidityEngine();
        console.log("[INIT] Institutional Algorithm Engine Loaded");
    }

    async initialize() {
        if (this.isInitialized) return;
        console.log("Initializing Real-Time Data Manager (Finnhub + Yahoo)...");

        // Use harmonized friendly names for the initial quote fetch
        const allSymbols = [...new Set([...this.watchlist, 'VIX', 'DXY', 'GOLD', ...this.sectors])];
        
        // Step 1: Parallel Quote Fetch in Batches (Faster boot)
        console.log(`Fetching current quotes for ${allSymbols.length} systems...`);
        const batchSize = 6;
        for (let i = 0; i < allSymbols.length; i += batchSize) {
            const batch = allSymbols.slice(i, i + batchSize);
            await Promise.all(batch.map(symbol => 
                Promise.race([
                    this.refreshQuote(symbol),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 10000))
                ]).catch(err => {
                    console.warn(`[INIT] Parallel quote warning for ${symbol}: ${err.message}`);
                })
            ));
            // Tiny delay between batches to respect API limits if any
            if (i + batchSize < allSymbols.length) await new Promise(r => setTimeout(r, 500));
        }


        // Step 2: Fetch history only for current symbol (to start UI immediately)
        console.log(`Loading initial history for ${this.currentSymbol}...`);
        await this.refreshHistoricalData(this.currentSymbol);

        // Step 3: Start Macro Polling Loop (Essential for symbols not on WS)
        this.startMacroPolling();

        this.connectWebSocket();
        console.log("Real-Time Data Manager Initialized.");

        // Load thermal/history for sector matrix + macro in background (SEQUENTIAL to prevent OOM/Rate-Limits)
        const g7Pairs = ['EURUSD=X', 'GBPUSD=X', 'USDJPY=X', 'AUDUSD=X', 'USDCAD=X', 'NZDUSD=X', 'USDCHF=X'];
        const priorityList = ['DXY', 'VIX', 'SPY', 'QQQ', 'BTC-USD', 'GOLD', ...g7Pairs];
        
        // Background Worker: Process priority list without blocking the main sync
        (async () => {
            console.log(`[INIT] Background Sync started for ${priorityList.length} systems (Parallel Mode)...`);
            const batchSize = 3;
            for (let i = 0; i < priorityList.length; i += batchSize) {
                const batch = priorityList.slice(i, i + batchSize);
                await Promise.all(batch.map(async (s) => {
                    try {
                        await this.refreshHistoricalData(s);
                    } catch (err) {
                        console.warn(`[INIT] Background refresh failed for ${s}:`, err.message);
                    }
                }));
                // Breathing room between batches
                await new Promise(r => setTimeout(r, 400)); 
            }
            console.log("[INIT] Background Sync Complete.");
        })();

        this.isInitialized = true;
    }

    startMacroPolling() {
        // Institutional Heartbeat: Recursive Pulse for zero-collision delivery
        const poll = async () => {
            const g7Pairs = ['EURUSD=X', 'GBPUSD=X', 'USDJPY=X', 'AUDUSD=X', 'USDCAD=X', 'NZDUSD=X', 'USDCHF=X'];
            const allSectors = ['XLK', 'XLF', 'XLY', 'XLE', 'XLV', 'XLC', 'XLI', 'XLP', 'XLU', 'XLRE', 'XLB'];
            const macroPoll = [...new Set(['SPY', 'QQQ', 'DIA', 'BTC-USD', 'DXY', 'VIX', 'GOLD', 'ES=F', 'NQ=F', '6E=F', '6B=F', ...g7Pairs, ...this.sectors])];
            if (this.currentSymbol && !macroPoll.includes(this.currentSymbol)) macroPoll.push(this.currentSymbol);
            try {
                const results = await sourceManager.getQuotes(macroPoll);
                const batchUpdates = [];
                const benchmarkSentiment = this.calculateOvernightSentiment('SPY');

                Object.entries(results).forEach(([sym, quote]) => {
                    this.ingestQuote(sym, quote);
                    const stock = this.stocks[sym];
                    if (stock) {
                        batchUpdates.push({
                            symbol: sym,
                            price: stock.currentPrice,
                            dailyChangePercent: stock.dailyChangePercent,
                            dailyChangePoints: (stock.currentPrice - stock.previousClose) || 0,
                            overnightSentiment: sym === this.currentSymbol ? this.calculateOvernightSentiment(sym) : null,
                            benchmarkSentiment: benchmarkSentiment
                        });
                    }
                });
                if (batchUpdates.length > 0 && this.onPriceUpdateCallback) {
                    this.onPriceUpdateCallback({ isBatch: true, updates: batchUpdates });
                }
            } catch (e) {}
            setTimeout(poll, 1000);
        };
        poll();

        // ── G7 FX DEDICATED YAHOO POLLER ─────────────────────────────────────
        // Runs independently of Pyth. Yahoo gives real prevClose & changePercent.
        // This guarantees the G7 basket always has fresh, non-zero data.
        const refreshG7Direct = async () => {
            console.log("--- [G7] INITIATING DIRECT YAHOO BENCHMARK POLLER ---");
            const g7Map = {
                'EURUSD=X': 'EUR', 'GBPUSD=X': 'GBP', 'USDJPY=X': 'JPY',
                'AUDUSD=X': 'AUD', 'USDCAD=X': 'CAD', 'NZDUSD=X': 'NZD', 'USDCHF=X': 'CHF'
            };
            let successCount = 0;
            for (const [sym] of Object.entries(g7Map)) {
                try {
                    const q = await Promise.race([
                        yahooFinance.quote(sym, {}, { validate: false }),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 8000))
                    ]).catch(err => {
                        if (err.message === 'TIMEOUT') console.warn(`[G7] Yahoo quote TIMEOUT for ${sym}`);
                        return null;
                    });

                    if (q && q.regularMarketPrice > 0) {
                        if (!this.stocks[sym]) {
                            console.warn(`[G7] ${sym} missing from simulator memory, initializing...`);
                            this.stocks[sym] = { currentPrice: 0, previousClose: 0, dailyChangePercent: 0, candles: { '1m': [], '5m': [], '15m': [], '1h': [], '1d': [] }, bloomberg: { sentiment: 0 }, news: [] };
                        }
                        const stock = this.stocks[sym];
                        stock.currentPrice = q.regularMarketPrice;
                        const prevClose = q.regularMarketPreviousClose || q.regularMarketOpen || 0;
                        if (prevClose > 0) {
                            stock.previousClose = prevClose;
                            stock.dailyChangePercent = ((q.regularMarketPrice - prevClose) / prevClose) * 100;
                        } else if (typeof q.regularMarketChangePercent === 'number') {
                            stock.dailyChangePercent = q.regularMarketChangePercent;
                            if (q.regularMarketPrice > 0 && q.regularMarketChangePercent !== 0) {
                                stock.previousClose = q.regularMarketPrice / (1 + q.regularMarketChangePercent / 100);
                            }
                        }
                        console.log(`[G7] ✅ ${sym}: price=${q.regularMarketPrice.toFixed(5)} prev=${stock.previousClose.toFixed(5)} chg=${stock.dailyChangePercent.toFixed(3)}%`);
                        successCount++;
                    } else {
                        console.warn(`[G7] ⚠️ Yahoo returned NO DATA for ${sym}`);
                    }
                } catch (e) {
                    console.warn(`[G7] ❌ Yahoo fetch failed for ${sym}: ${e.message}`);
                }
                // Small delay between calls to avoid rate limiting
                await new Promise(r => setTimeout(r, 200));
            }
            console.log(`--- [G7] BENCHMARK COMPLETE: ${successCount}/7 PAIRS PULLED ---`);
        };
        // Run immediately on startup, then every 45 seconds
        refreshG7Direct();
        setInterval(refreshG7Direct, 45000);

        // Background sector matrix refresh
        setInterval(() => {
            this.sectors.forEach(sym => this.refreshQuote(sym).catch(() => {}));
            this.updateAll().catch(() => {});
        }, 30000);

        // ── COT SENTIMENT POLLER ─────────────────────────────────────────────
        const pollCOT = async () => {
            console.log("[COT] Refreshing Institutional Whale Positioning...");
            await this.cot.fetchAndParse();
            // Sync current sentiment to simulator state
            Object.keys(this.stocks).forEach(sym => {
                const s = this.cot.getSentiment(sym);
                if (s && this.stocks[sym]) {
                    this.stocks[sym].netWhaleFlow = s.net;
                    this.stocks[sym].institutionalSentiment = s;
                }
            });
        };
        pollCOT(); 
        setInterval(pollCOT, 3600000); // Hourly refresh (COT reports are weekly)

        this.isInitialized = true;
    }

    async refreshQuote(symbol) {
        try {
            const quote = await sourceManager.getQuote(symbol);
            if (quote) this.ingestQuote(symbol, quote);
        } catch (e) {}
    }

    async refreshQuotes(symbols) {
        try {
            const quotes = await sourceManager.getQuotes(symbols);
            const updates = [];
            Object.keys(quotes).forEach(symbol => {
                const quote = quotes[symbol];
                const update = this.ingestQuote(symbol, quote, true); // true = supress individual callback
                if (update) updates.push(update);
            });
            
            if (this.onPriceUpdateCallback && updates.length > 0) {
                this.onPriceUpdateCallback({ isBatch: true, updates });
            }
        } catch (e) {
            console.error("[DATA SYNC] Batch Quote Fetch Failed:", e.message);
        }
    }

    ingestQuote(symbol, quote, suppressCallback = false) {
        // --- 📊 INSTITUTIONAL SYMBOL NORMALIZATION ---
        // Maps internal feed symbols (DX-Y.NYB, ^VIX) to clean UI symbols (DXY, VIX)
        let displaySymbol = symbol;
        if (symbol === '^VIX' || symbol === 'VIX') displaySymbol = 'VIX';
        if (symbol === 'DX-Y.NYB' || symbol === 'DX-Y' || symbol === 'DXY') displaySymbol = 'DXY';
        if (symbol === 'GC=F' || symbol === 'GLD' || symbol === 'GOLD') displaySymbol = 'GOLD';

        if (!this.stocks[displaySymbol]) {
            this.stocks[displaySymbol] = {
                symbol: displaySymbol,
                currentPrice: 0,
                previousClose: 0,
                dailyChangePercent: 0,
                cvd: 0,
                netWhaleFlow: 0, 
                whaleBuyVol: 0,
                whaleSellVol: 0,
                volumeClusters: {},
                dailyQuotes: [],
                candles: { '1m': [], '5m': [], '15m': [], '1h': [], '1d': [] },
                bloomberg: { omon: 'NEUTRAL', btm: 'STALE', wei: 'NEUTRAL', sentiment: 0 },
                news: []
            };
        }
        
        const stock = this.stocks[displaySymbol];
        const price = quote.price || 0;
        const volume = quote.volume || 0;

        if (price > 0) {
            stock.currentPrice = price;
        }
        
        // Cache the previous close to avoid 0.00% flip-flopping
        if (quote.prevClose && quote.prevClose > 0) {
            stock.previousClose = quote.prevClose;
        } else if (!stock.previousClose || stock.previousClose === 0) {
            // Only fallback to hard-baselines or currentPrice if we TRULY have no history
            const dp = quote.change || 0;
            if (dp !== 0 && stock.currentPrice > 0) {
                stock.previousClose = stock.currentPrice / (1 + (dp / 100));
            } else {
                const stableBaselines = { 
                    'SPY': 520.45, 'QQQ': 443.12, 'DIA': 391.20, 
                    'DXY': 104.25, 'DX-Y': 104.25, 'DX-Y.NYB': 104.25,
                    '^VIX': 14.50, 'VIX': 14.50, 'BTC-USD': 69420.00, 'GC=F': 2330.40
                };
                if (stableBaselines[symbol] && stock.currentPrice > 0) {
                    stock.previousClose = stableBaselines[symbol];
                } else {
                    // Critical: If we don't have a previousClose yet, default it, 
                    // but don't overwrite a valid one if it exists!
                    stock.previousClose = stock.currentPrice;
                }
            }
        }
        
        if (stock.previousClose > 0 && stock.previousClose !== stock.currentPrice) {
            stock.dailyChangePercent = ((stock.currentPrice - stock.previousClose) / stock.previousClose) * 100;
        } else if (typeof quote.change === 'number' && quote.change !== 0) {
            stock.dailyChangePercent = quote.change;
            if (stock.currentPrice > 0) {
                stock.previousClose = stock.currentPrice / (1 + (quote.change / 100));
            }
        }

        const pointsChange = stock.previousClose > 0 ? (stock.currentPrice - stock.previousClose) : 0;
        stock.dataSource = quote.source;
        
        if (quote.confidence !== undefined) {
            stock.pythConfidence = quote.confidence;
        }

        // ── HEARTBEAT SYNC: Ensure polled quotes also update the candle chart ──
        this.synchronizeCandles(displaySymbol, price, volume);

        // --- HOLY GRAIL: Real-Time Macro Sync ---
        if (symbol === 'DX-Y.NYB' || symbol === 'DX-Y' || symbol === 'UUP' || symbol === 'DXY') {
            this.internals.dxyPrev = this.internals.dxy || stock.previousClose;
            this.internals.dxy = stock.currentPrice;
            this.internals.dxyChange = stock.dailyChangePercent;
        }
        if (symbol === '^VIX' || symbol === 'VIX') {
            this.internals.vixPrev = this.internals.vix;
            this.internals.vix = stock.currentPrice;
        }
        if (symbol === '^TNX' || symbol === 'TNX') this.internals.tnx = stock.currentPrice;

        const updatePayload = {
            symbol: displaySymbol,
            price: stock.currentPrice,
            dailyChangePercent: stock.dailyChangePercent,
            dailyChangePoints: pointsChange,
            source: stock.dataSource
        };

        if (this.onPriceUpdateCallback && !suppressCallback) {
            this.onPriceUpdateCallback(updatePayload);
        }
        return updatePayload;
    }

    updateROROStatus() {
        const dxy = this.internals.dxy || 104;
        const vix = this.internals.vix || 15;
        
        // Dynamic baseline sync (institutional proxy)
        const dxyBase = 104; 
        const vixBase = 15;
        
        const dxyRel = (dxyBase - dxy) * 10; // Positive if DXY is dropping (Risk ON)
        const vixRel = (vixBase - vix) * 2;  // Positive if VIX is dropping (Risk ON)
        
        const score = Math.max(0, Math.min(100, 50 + dxyRel + vixRel));
        
        this.internals.prevRoro = this.internals.roro || 50;
        this.internals.roro = score;
        
        // FLASH DETECTION: Change of > 5 points in a single tick
        this.internals.isRoroFlash = Math.abs(this.internals.roro - this.internals.prevRoro) > 5;
        this.internals.roroDirection = this.internals.roro > this.internals.prevRoro ? 'ON' : 'OFF';
    }

    async refreshHistoricalData(symbol) {
        try {
            await this.refreshQuote(symbol);
            const stock = this.stocks[symbol];

            // --- SOPHISTICATED PDH/PDL SELECTOR ---
            const date10d = new Date();
            date10d.setDate(date10d.getDate() - 10);
            const p1String = date10d.toISOString().split('T')[0];
            
            try {
                const dailyRes = await Promise.race([
                    yahooFinance.chart(symbol, { period1: p1String, interval: '1d' }, { validateResult: false }),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 12000))
                ]).catch(err => {
                    if (err.message === 'TIMEOUT') console.warn(`[SYNC] PDH/PDL Yahoo Chart TIMEOUT for ${symbol}`);
                    return null;
                });

                if (dailyRes && dailyRes.quotes && dailyRes.quotes.length > 0) {
                    const nyNow = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
                    const currentNYDate = nyNow.toISOString().split('T')[0];
                    const hour = nyNow.getHours();

                    const quotes = dailyRes.quotes.filter(q => q.high !== null);
                    const lastIdx = quotes.length - 1;
                    const lastQuote = quotes[lastIdx];
                    const lastQuoteDate = lastQuote.date.toISOString().split('T')[0];

                    let targetDay;
                    const isAfterClose = (hour >= 16);
                    if (lastQuoteDate === currentNYDate) {
                        targetDay = isAfterClose ? lastQuote : quotes[lastIdx - 1];
                    } else {
                        targetDay = lastQuote;
                    }

                    if (targetDay) {
                        const stock = this.stocks[symbol];
                        // CRITICAL: Inject historical close as baseline if missing
                        if (stock && (!stock.previousClose || stock.previousClose === 0)) {
                            stock.previousClose = targetDay.close;
                            console.log(`[SYNC] Seeded Previous Close for ${symbol}: ${stock.previousClose}`);
                            if (stock.currentPrice > 0) {
                                stock.dailyChangePercent = ((stock.currentPrice / stock.previousClose) - 1) * 100;
                            }
                        }

                        // Sanity Check: Ensure PDH/PDL aren't thousands of % away
                        const current = stock.currentPrice || targetDay.close;
                        if (Math.abs(targetDay.high - current) / current < 0.5) {
                            stock.pdh = targetDay.high;
                            stock.pdl = targetDay.low;
                        }
                        stock.dailyQuotes = dailyRes.quotes.filter(q => q.high != null);
                    }
                }
            } catch (err) { }

            const tfPromises = this.timeframes.map(async (tf) => {
                let daysBack = (tf === '1d') ? 365 : (tf === '1h' ? 30 : (tf === '15m' ? 10 : 5));

                try {
                    const quotes = await sourceManager.getHistory(symbol, tf, daysBack);
                    if (quotes && quotes.length > 0) {
                        const candles = quotes
                            .filter(q => q.open != null && q.open > 0)
                            .map(q => ({
                                timestamp: q.date.getTime(),
                                open: q.open,
                                high: q.high,
                                low: q.low,
                                close: q.close,
                                volume: q.volume
                            }));
                        let cleanedCandles = [];
                        for (let i = 0; i < candles.length; i++) {
                            let c = candles[i];
                            // Clean up massive anomalous wicks
                            const bodyMax = Math.max(c.open, c.close);
                            const bodyMin = Math.min(c.open, c.close);
                            const bodySize = Math.max(bodyMax - bodyMin, c.open * 0.0005);
                            
                            if (c.high - bodyMax > bodySize * 4) c.high = bodyMax + bodySize;
                            if (bodyMin - c.low > bodySize * 4) c.low = bodyMin - bodySize;
                            
                            cleanedCandles.push(c);
                        }
                        // --- MEMORY SHIELD: Limit to prevent OOM ---
                        const maxStored = (tf === '1m') ? 1000 : 500;
                        stock.candles[tf] = cleanedCandles.slice(-maxStored);
                        
                        // Reduced logging to keep terminal clean
                        if (symbol === this.currentSymbol) {
                            console.log(`[SYNC] Initialized ${stock.candles[tf].length} candles for ${symbol} @ ${tf}`);
                        }
                    } else {
                        console.warn(`[FETCH] No candles returned for ${symbol} @ ${tf}`);
                    }
                } catch (err) { 
                    if (!err.message?.includes('EPIPE')) {
                        console.warn(`[FETCH] History failed for ${symbol} @ ${tf}`);
                    }
                }
            });

            await Promise.all(tfPromises);
        } catch (error) {
            console.error(`Historical fetch failed for ${symbol}:`, error.message);
        }
    }

    connectWebSocket() {
        if (this.ws) this.ws.terminate();

        this.ws = new WebSocket(`wss://ws.finnhub.io?token=${this.apiKey}`);

        this.ws.on('open', () => {
            console.log('--- FINNHUB WEBSOCKET CONNECTED ---');
            // Subscribe to all in watchlist + macro proxies + sectors
            const instruments = Object.keys(this.stocks);
            
            // THRESHOLD: Spreading out subscriptions to prevent anti-spam disconnection
            let index = 0;
            const batchInterval = setInterval(() => {
                const batch = instruments.slice(index, index + 10); // 10 per tick
                if (batch.length === 0) {
                    clearInterval(batchInterval);
                    return;
                }
                
                batch.forEach(symbol => {
                    // SkipIndices which Finnhub doesn't support on free tier websocket
                    if (symbol.startsWith('^') && !this.symbolMap[symbol]) return;
                    
                    const subSymbol = this.symbolMap[symbol] || symbol;
                    try {
                        if (this.ws.readyState === WebSocket.OPEN) {
                            this.ws.send(JSON.stringify({ type: 'subscribe', symbol: subSymbol }));
                        }
                    } catch (e) { }
                });
                index += 10;
            }, 100); // Pulse every 100ms (100 symbols per second)
        });

        this.ws.on('message', (data) => {
            const raw = JSON.parse(data.toString());
            if (raw.type === 'trade') {
                raw.data.forEach(trade => {
                    const displaySymbol = this.revMap[trade.s] || trade.s;
                    this.updatePriceFromTrade(displaySymbol, trade.p, trade.v);
                });
            }
        });

        this.ws.on('error', (err) => console.error('WS Error:', err.message));
        this.ws.on('close', () => {
            console.log('WS Disconnected. Reconnecting in 5s...');
            setTimeout(() => this.connectWebSocket(), 5000);
        });
    }

    updatePriceFromTrade(symbol, price, volume = 1) {
        // --- 📊 INSTITUTIONAL SYMBOL NORMALIZATION ---
        let displaySymbol = symbol;
        if (symbol === '^VIX' || symbol === 'VIX') displaySymbol = 'VIX';
        if (symbol === 'DX-Y.NYB' || symbol === 'DX-Y' || symbol === 'DXY') displaySymbol = 'DXY';
        if (symbol === 'GC=F' || symbol === 'GLD' || symbol === 'GOLD') displaySymbol = 'GOLD';

        if (this.stocks[displaySymbol]) {
            const stock = this.stocks[displaySymbol];

            // Check for session reset (e.g., first trade after 9:30 AM NY)
            this.checkSessionReset(displaySymbol);

            // SAFETY FILTER: Loose filter during sync to prevent price freezing
            if (stock.currentPrice > 0) {
                const deviation = Math.abs(price - stock.currentPrice) / stock.currentPrice;
                // Allow 5% max deviation during live trading to prevent data stalls
                const maxDeviation = 0.05;
                if (deviation > maxDeviation) return; 
            }

            // --- CVD & Aggression Logic (Tick Rule) ---
            if (stock.currentPrice > 0) {
                if (price > stock.currentPrice) {
                    stock.cvd += volume;
                } else if (price < stock.currentPrice) {
                    stock.cvd -= volume;
                }
            }

            // --- POC (Point of Control) Cluster Logic ---
            const roundedPrice = Math.round(price * 100) / 100;
            stock.volumeClusters[roundedPrice] = (stock.volumeClusters[roundedPrice] || 0) + volume;

            // --- Institutional Block Detection (Dark Pool Approximation) ---
            const tradeValue = price * volume;
            const isForex = symbol.includes('=X') || symbol === 'BTC-USD';
            const threshold = isForex ? 500000 : 100000; // $500k for FX/Crypto, $100k for Stocks

            if (tradeValue >= threshold) {
                const isElite = tradeValue >= 1000000;
                const block = {
                    symbol,
                    price,
                    volume,
                    value: tradeValue,
                    time: new Date().toLocaleTimeString(),
                    type: price > (stock.currentPrice || 0) ? 'BULLISH' : 'BEARISH',
                    isElite
                };
                this.blockTrades.unshift(block);
                if (this.blockTrades.length > this.maxBlockTrades) this.blockTrades.pop();

                // Update Order-Flow Imbalance
                const flow = block.type === 'BULLISH' ? tradeValue : -tradeValue;
                stock.netWhaleFlow = (stock.netWhaleFlow || 0) + flow;
                if (block.type === 'BULLISH') stock.whaleBuyVol += tradeValue;
                else stock.whaleSellVol += tradeValue;

                if (isElite) {
                    console.log(`[WHALE] 🐋 ELITE BLOCK: ${symbol} | $${(tradeValue / 1000000).toFixed(2)}M | Price: ${price}`);
                } else {
                    console.log(`[BLOCK] ${symbol} | $${tradeValue.toLocaleString()} | Price: ${price}`);
                }

                if (this.onBlockCallback) {
                    this.onBlockCallback(block);
                }
            }

            if (price && price > 0) {
                stock.currentPrice = price;
            }
            let pointsChange = 0;

            if (stock.previousClose > 0) {
                stock.dailyChangePercent = ((price - stock.previousClose) / stock.previousClose) * 100;
                pointsChange = price - stock.previousClose;
            }

            // HOLY GRAIL: Real-time Macro Sync
            if (symbol === 'VIX' || symbol === '^VIX') {
                this.internals.vixPrev = this.internals.vix;
                this.internals.vix = price;
            }
            if (symbol === 'DXY' || symbol === 'DX-Y' || symbol === 'DX-Y.NYB') {
                this.internals.dxyPrev = this.internals.dxy || stock.previousClose || price;
                this.internals.dxy = price;
                this.internals.dxyChange = stock.dailyChangePercent;
            }
            if (symbol === '^TNX' || symbol === 'TNX') this.internals.tnx = price;

            // Update current candles for all timeframes
            this.synchronizeCandles(displaySymbol, price, volume);

            // --- PRECISION-GATED UI EMITTANCE ---
            const oldPrice = stock.lastEmittedPrice || 0;
            const priceThreshold = stock.currentPrice * 0.00001; 
            const isSignificant = Math.abs(price - oldPrice) > priceThreshold || (Date.now() - (stock.lastEmittedTime || 0) > 2000);

            if (this.onPriceUpdateCallback && isSignificant) {
                stock.lastEmittedPrice = price;
                stock.lastEmittedTime = Date.now();

                let liquidityStatus = 'STABLE';
                if (stock.pythConfidence !== undefined) {
                    const bps = (stock.pythConfidence / price) * 10000;
                    if (bps > 15) liquidityStatus = 'DANGEROUS';
                    else if (bps > 5) liquidityStatus = 'THIN';
                }

                this.onPriceUpdateCallback({
                    symbol: displaySymbol,
                    price,
                    dailyChangePercent: stock.dailyChangePercent,
                    dailyChangePoints: (price - stock.previousClose) || 0,
                    candles: stock.candles,
                    pythConfidence: stock.pythConfidence,
                    liquidityStatus,
                    hybridCVD: (stock.cvd || 0) + ((stock.netWhaleFlow || 0) / (price || 1)),
                    netWhaleFlow: stock.netWhaleFlow || 0,
                    source: stock.dataSource
                });
            }
        }
    }

    synchronizeCandles(symbol, price, volume = 1) {
        const stock = this.stocks[symbol];
        if (!stock) return;

        this.timeframes.forEach(tf => {
            const candles = stock.candles[tf];
            const tfMs = this.getTfMs(tf);
            const candleTs = Math.floor(Date.now() / tfMs) * tfMs;

            if (candles && candles.length > 0) {
                const last = candles[candles.length - 1];

                if (candleTs > last.timestamp) {
                    // NEW CANDLE
                    candles.push({
                        timestamp: candleTs,
                        open: price,
                        high: price,
                        low: price,
                        close: price,
                        volume: volume
                    });
                    if (candles.length > 300) candles.shift();
                } else {
                    // UPDATE EXISTING
                    last.close = price;
                    last.high = Math.max(last.high, price);
                    last.low = Math.min(last.low, price);
                    if (volume) last.volume = (last.volume || 0) + volume;
                }
            } else {
                // Initial candle if array was empty
                stock.candles[tf] = [{
                    timestamp: candleTs,
                    open: price,
                    high: price,
                    low: price,
                    close: price,
                    volume: volume
                }];
            }
        });
    }

    getTfMs(tf) {
        const value = parseInt(tf);
        if (tf.includes('m')) return value * 60 * 1000;
        if (tf.includes('h')) return value * 60 * 60 * 1000;
        if (tf.includes('d')) return value * 24 * 60 * 60 * 1000;
        return 60 * 1000;
    }

    checkSessionReset(symbol) {
        const stock = this.stocks[symbol];
        const now = new Date();
        const nyTime = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
        const dateStr = nyTime.toDateString();

        if (stock.lastSessionDate !== dateStr) {
            console.log(`New session detected for ${symbol} (${dateStr}). Resetting intraday markers.`);
            stock.cvd = 0;
            stock.netWhaleFlow = 0;
            stock.whaleBuyVol = 0;
            stock.whaleSellVol = 0;
            stock.volumeClusters = {};
            stock.lastSessionDate = dateStr;
            // PDH/PDL will be refreshed by the 5-min update loop or manual refresh
        }
    }

    calculateBloombergMetrics(quote) {
        const change = quote.regularMarketChangePercent;
        let wei = 'NEUTRAL', omon = 'NEUTRAL', btm = 'STALE';
        if (change > 1.5) wei = 'BULLISH'; else if (change < -1.5) wei = 'BEARISH';
        if (quote.regularMarketVolume > quote.averageDailyVolume10Day * 1.2) omon = change > 0 ? 'CALL_BUYING' : 'PUT_BUYING';
        if (Math.abs(change) > 0.5) btm = change > 0 ? 'BUY_BLOCKS' : 'SELL_BLOCKS';

        // Preserve sentiment
        const sentiment = this.stocks[quote.symbol]?.bloomberg?.sentiment || 0;
        return { omon, btm, wei, sentiment, timestamp: Date.now() };
    }

    async updateAll() {
        await this.refreshNews();
        
        const now = Date.now();
        // INSTITUTIONAL PULSE: Core macros (SPY, QQQ, VIX, etc) updated every 3s
        if (!this.lastQuoteUpdate || now - this.lastQuoteUpdate > 3000) {
            // Batch all sectors + macros + current active symbol
            const activeSym = this.currentSymbol || 'SPY';
            const batchSymbols = Array.from(new Set(['VIX', 'DXY', 'GOLD', '^VIX', 'DX-Y.NYB', activeSym, ...this.sectors]));
            await this.refreshQuotes(batchSymbols);
            this.lastQuoteUpdate = now;
        }

        // Heavy history refresh only every 10 minutes OR when specifically needed
        if (!this.lastMacroRefresh || now - this.lastMacroRefresh > 600000) {
            console.log("Performing essential macro history refresh...");
            await this.refreshHistoricalData('^VIX');
            await this.refreshHistoricalData('DX-Y.NYB');
            await this.refreshHistoricalData(this.currentSymbol);

            // Fetch Real Options GEX
            this.refreshOptionsData('SPY');
            this.refreshOptionsData('QQQ');
            if (this.currentSymbol !== 'SPY' && this.currentSymbol !== 'QQQ') {
                this.refreshOptionsData(this.currentSymbol);
            }

            this.lastMacroRefresh = now;
        }
    }

    async refreshOptionsData(symbol) {
        if (symbol.includes('=X') || symbol.includes('USD') || symbol.startsWith('^')) return;
        try {
            const res = await Promise.race([
                yahooFinance.options(symbol),
                new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 10000))
            ]);

            if (res && res.options && res.options.length > 0) {
                const chain = res.options[0]; // Nearest expiration
                if (this.stocks[symbol]) {
                    this.stocks[symbol].optionsChain = chain;
                    console.log(`[GEX] Real options chain loaded for ${symbol}. Calls: ${chain.calls?.length || 0}, Puts: ${chain.puts?.length || 0}`);
                }
            }
        } catch (e) {
            // Silence silent pipe errors
        }
    }

    async refreshNews() {
        try {
            const feedUrl = 'https://feeds.bloomberg.com/markets/news.rss';
            const res = await axios.get(feedUrl, { timeout: 10000 });
            const xml = res.data;

            const items = [];
            const itemRegex = /<item>([\s\S]*?)<\/item>/g;
            const lexicon = {
                'bullish': 2, 'record': 1, 'surge': 2, 'growth': 1, 'buy': 1, 'high': 1, 'rally': 2, 'positive': 1, 'profit': 1,
                'bearish': -2, 'crash': -3, 'decline': -1, 'fall': -1, 'debt': -1, 'crisis': -2, 'sell': -1, 'low': -1, 'negative': -1
            };

            // News Guardian: High Impact Keywords (Forex + Stocks)
            const highImpactKeywords = ['CPI', 'FOMC', 'POWELL', 'FED', 'INFLATION', 'NFP', 'JOBS REPORT', 'INTEREST RATE', 'ECB', 'LAGARDE', 'BOE', 'BAILEY', 'BOJ', 'YEN', 'DOLLAR INDEX'];
            let redFolderDetected = false;

            let match;
            while ((match = itemRegex.exec(xml)) !== null) {
                const title = match[1].match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/)?.[1] ||
                    match[1].match(/<title>([\s\S]*?)<\/title>/)?.[1];
                if (title) {
                    const text = title.trim();
                    items.push({ text, timestamp: Date.now() });
                    if (highImpactKeywords.some(k => text.toUpperCase().includes(k))) redFolderDetected = true;
                }
            }

            this.internals.newsImpact = redFolderDetected ? 'HIGH' : 'LOW';
            // VIX and DXY are now updated in real-time via updatePriceFromTrade, 
            // but we keep a fallback here for robustness.
            if (this.stocks['^VIX']?.currentPrice > 0) this.internals.vix = this.stocks['^VIX'].currentPrice;
            if (this.stocks['DX-Y.NYB']?.currentPrice > 0) {
                this.internals.dxyPrev = this.internals.dxy || this.stocks['DX-Y.NYB'].previousClose;
                this.internals.dxy = this.stocks['DX-Y.NYB'].currentPrice;
                this.internals.dxyChange = this.stocks['DX-Y.NYB'].dailyChangePercent;
            }
            if (this.stocks['^TNX']?.currentPrice > 0) this.internals.tnx = this.stocks['^TNX'].currentPrice;

            // --- CALCULATE MARKET BREADTH ---
            const bullCount = this.watchlist.filter(s => (this.stocks[s]?.dailyChangePercent || 0) > 0.05).length;
            this.internals.breadth = (bullCount / this.watchlist.length) * 100;

            this.watchlist.forEach(symbol => {
                const stock = this.stocks[symbol];
                const relevant = items.filter(item =>
                    item.text.toUpperCase().includes(symbol) ||
                    (symbol === 'BTC-USD' && item.text.toUpperCase().includes('BITCOIN'))
                );

                let totalSentiment = 0;
                const pool = relevant.length > 0 ? relevant : items.slice(0, 5);

                pool.forEach(item => {
                    const words = item.text.toLowerCase().split(/\W+/);
                    words.forEach(word => {
                        if (lexicon[word]) totalSentiment += lexicon[word];
                    });
                });

                stock.bloomberg.sentiment = totalSentiment;
                stock.news = pool.slice(0, 5);
            });
        } catch (err) {
            console.error("News Refresh Error:", err.message);
        }
    }

    async addSymbol(symbol) {
        symbol = symbol.toUpperCase();
        if (this.stocks[symbol]) return;

        console.log(`Adding ${symbol} to watchlist...`);
        this.watchlist.push(symbol);
        this.saveWatchlist();
        this.stocks[symbol] = {
            currentPrice: 0,
            previousClose: 0,
            dailyChangePercent: 0,
            cvd: 0,
            netWhaleFlow: 0,
            volumeClusters: {},
            dailyQuotes: [],
            candles: { '1m': [], '5m': [], '15m': [], '1h': [], '1d': [] },
            bloomberg: { omon: 'NEUTRAL', btm: 'STALE', wei: 'NEUTRAL', sentiment: 0 },
            news: []
        };

        // Fetch initial markers immediately for the new symbol
        await this.refreshHistoricalData(symbol);
        console.log(`✅ ${symbol} initialized with history.`);

        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            const subSymbol = this.symbolMap[symbol] || symbol;
            this.ws.send(JSON.stringify({ type: 'subscribe', symbol: subSymbol }));
        }
    }

    removeSymbol(symbol) {
        this.watchlist = this.watchlist.filter(s => s !== symbol);
        this.saveWatchlist();
        delete this.stocks[symbol];
    }

    loadWatchlist() {
        try {
            if (fs.existsSync(this.configPath)) {
                return JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
            }
        } catch (e) { console.error("Load Watchlist Error:", e.message); }
        return ['SPY', 'QQQ', 'IWM', 'SMH', 'NVDA', 'TSLA', 'AAPL', 'MSFT', 'META', 'AMZN', 'GOOGL', 'AMD', 'NFLX', 'BTC-USD', 'ETH-USD', 'EURUSD=X', 'GBPUSD=X', 'USDJPY=X', 'AUDUSD=X'];
    }

    saveWatchlist() {
        try {
            fs.writeFileSync(this.configPath, JSON.stringify(this.watchlist, null, 2));
        } catch (e) { console.error("Save Watchlist Error:", e.message); }
    }

    calculateVWAP(symbol, tf = '1m') {
        const stock = this.stocks[symbol];
        const candles = stock.candles[tf];
        if (!candles || candles.length === 0) return { vwap: 0, stdev: 0 };

        // Session-anchored VWAP (approximate using current candle history for the day)
        const nyNow = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
        nyNow.setHours(9, 30, 0, 0);
        const sessionStart = nyNow.getTime();

        let tpv = 0;
        let totalVol = 0;
        let sumSqrPriceVol = 0;
        candles.forEach(c => {
            if (c.timestamp >= sessionStart) {
                const typicalPrice = (c.high + c.low + c.close) / 3;
                // Guard: use volume 1 as fallback for forex/off-hours candles with no volume data
                const vol = (c.volume && isFinite(c.volume) && c.volume > 0) ? c.volume : 1;
                tpv += typicalPrice * vol;
                totalVol += vol;
                sumSqrPriceVol += typicalPrice * typicalPrice * vol;
            }
        });

        if (totalVol === 0) return { vwap: candles[candles.length - 1].close, stdev: 0 };
        
        const vwap = tpv / totalVol;
        const variance = Math.max(0, (sumSqrPriceVol / totalVol) - (vwap * vwap));
        const stdev = Math.sqrt(variance);

        return { vwap, stdev };
    }

    // =========================================================================
    // TIER 1 INSTITUTIONAL EDGES
    // =========================================================================

    /**
     * T1-A: VWAP Deviation Bands (±1σ, ±2σ)
     * Institutions use these as mean-reversion fade zones.
     * Price at +2σ = statistically overbought → fade zone for longs.
     * Price returning to VWAP = highest-probability retest entry target.
     */
    getVWAPBands(symbol, tf = '1m') {
        const { vwap, stdev } = this.calculateVWAP(symbol, tf);
        if (!vwap || vwap === 0) return null;
        
        const cp = this.stocks[symbol]?.currentPrice || 0;
        let zone = 'VWAP EQUILIBRIUM';
        if (cp > vwap + stdev * 2) zone = 'EXTREME PREMIUM';
        else if (cp > vwap + stdev) zone = 'PREMIUM ZONE';
        else if (cp < vwap - stdev * 2) zone = 'EXTREME DISCOUNT';
        else if (cp < vwap - stdev) zone = 'DISCOUNT ZONE';

        return {
            vwap,
            zone,
            upper1Side: parseFloat((vwap + stdev).toFixed(4)),
            lower1Side: parseFloat((vwap - stdev).toFixed(4)),
            upper2Side: parseFloat((vwap + stdev * 2).toFixed(4)),
            lower2Side: parseFloat((vwap - stdev * 2).toFixed(4)),
            upper1:     parseFloat((vwap + stdev).toFixed(2)), // For UI display
            upper2:     parseFloat((vwap + stdev * 2).toFixed(2)), // For UI display
            stdev:      parseFloat(stdev.toFixed(4))
        };
    }

    /**
     * T1-B: RELATIVE VOLUME (RVOL)
     * Compare current bar volume to the rolling average volume for the same
     * time slot across recent candle history.
     * RVOL > 1.5 = institutional participation confirmed.
     * RVOL < 0.7 = thin tape — fake moves, low conviction.
     */
    calculateRVOL(symbol, tf = '5m') {
        const stock = this.stocks[symbol];
        if (!stock) return { rvol: 1, label: 'NORMAL', raw: 0 };
        const candles = stock.candles[tf] || [];
        if (candles.length < 20) return { rvol: 1, label: 'NORMAL', raw: 0 };

        // Current volume = last complete candle
        const last = candles[candles.length - 1];
        const currentVol = (last.volume && isFinite(last.volume)) ? last.volume : 0;
        if (currentVol === 0) return { rvol: 1, label: 'NORMAL', raw: 0 };

        // Average of previous 20 candles (exclude last)
        const history = candles.slice(-21, -1);
        const avgVol = history.reduce((s, c) => s + (c.volume || 0), 0) / history.length;
        if (avgVol === 0) return { rvol: 1, label: 'NORMAL', raw: currentVol };

        const rvol = parseFloat((currentVol / avgVol).toFixed(2));
        const label = rvol >= 2.0 ? 'EXTREME' : rvol >= 1.5 ? 'HIGH' : rvol >= 0.8 ? 'NORMAL' : 'THIN';
        return { rvol, label, raw: currentVol, avg: Math.round(avgVol) };
    }

    /**
     * T1-C: OPENING RANGE BREAKOUT (ORB)
     * The first 15 minutes of RTH (9:30–9:45am EST) defines the Opening Range.
     * Breakouts from this range after 9:45am are high-probability institutional moves.
     * The ORB is the single most reliable entry trigger for prop desks.
     */
    calculateORB(symbol, tf = '1m') {
        const stock = this.stocks[symbol];
        if (!stock) return null;
        const candles = stock.candles[tf] || [];
        if (candles.length === 0) return null;

        const isEquity = !symbol.includes('=X') && symbol !== 'BTC-USD';
        if (!isEquity) return null; // ORB is equity-only

        const nyNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
        const openTime  = new Date(nyNow); openTime.setHours(9, 30, 0, 0);
        const orEndTime = new Date(nyNow); orEndTime.setHours(9, 45, 0, 0);
        const openTs    = openTime.getTime();
        const orEndTs   = orEndTime.getTime();
        const nyNowTs   = nyNow.getTime();

        // Only calculate during/after market open
        if (nyNowTs < openTs) return { active: false, label: 'PRE-MARKET' };

        const orCandles = candles.filter(c => c.timestamp >= openTs && c.timestamp < orEndTs);
        if (orCandles.length === 0) return { active: false, label: 'ORB BUILDING' };

        const orbHigh = Math.max(...orCandles.map(c => c.high));
        const orbLow  = Math.min(...orCandles.map(c => c.low));
        const currentPrice = stock.currentPrice || 0;

        // Is the range still building (< 9:45am)?
        const isBuilding = nyNowTs < orEndTs;
        if (isBuilding) {
            return { active: false, orbHigh, orbLow, label: 'ORB BUILDING', breakout: 'NONE' };
        }

        // Determine breakout direction
        const bullBreak = currentPrice > orbHigh;
        const bearBreak = currentPrice < orbLow;
        const breakout  = bullBreak ? 'BULLISH' : bearBreak ? 'BEARISH' : 'NONE';
        const breakoutPct = bullBreak
            ? parseFloat(((currentPrice - orbHigh) / orbHigh * 100).toFixed(3))
            : bearBreak
            ? parseFloat(((orbLow - currentPrice) / orbLow * 100).toFixed(3))
            : 0;

        return {
            active:      true,
            orbHigh:     parseFloat(orbHigh.toFixed(2)),
            orbLow:      parseFloat(orbLow.toFixed(2)),
            orbRange:    parseFloat((orbHigh - orbLow).toFixed(2)),
            breakout,
            breakoutPct,
            label:       breakout === 'NONE' ? 'ORB RANGE INTACT' : `ORB ${breakout} BREAKOUT`,
            confidence:  breakout !== 'NONE' ? Math.min(90, Math.round(breakoutPct * 100)) : 0
        };
    }

    /**
     * T1-D: OVERNIGHT GAP FILL PROBABILITY
     * Compare previous session close to today's opening candle.
     * Gaps > 0.3% have ~65-70% historical probability of filling within 2 hours.
     * This is a powerful anti-chasing filter: prevents buying gap-up opens.
     */
    calculateGapFill(symbol, tf = '1m') {
        const stock = this.stocks[symbol];
        if (!stock) return null;

        const prevClose  = stock.previousClose || 0;
        if (prevClose === 0) return null;

        const candles = stock.candles[tf] || [];
        if (candles.length === 0) return null;

        // Today's open = first candle after midnight
        const nyNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
        const midnightTs = new Date(nyNow).setHours(0, 0, 0, 0);
        const todayCandles = candles.filter(c => c.timestamp >= midnightTs);
        if (todayCandles.length === 0) return null;

        const todayOpen  = todayCandles[0].open;
        const gapPct     = parseFloat(((todayOpen - prevClose) / prevClose * 100).toFixed(3));
        const absGap     = Math.abs(gapPct);

        if (absGap < 0.15) return { hasGap: false, gapPct: 0, label: 'NO GAP' };

        const gapDirection   = gapPct > 0 ? 'UP' : 'DOWN';
        const fillTarget     = prevClose; // Gap fills when price returns to prevClose
        const currentPrice   = stock.currentPrice || 0;
        const alreadyFilled  = gapDirection === 'UP'
            ? currentPrice <= prevClose
            : currentPrice >= prevClose;

        // Probability: increases with gap size but plateaus at ~72%
        const fillProb = alreadyFilled
            ? 100
            : Math.min(72, Math.round(50 + absGap * 15));

        return {
            hasGap:       true,
            gapPct,
            absGap,
            gapDirection,
            fillTarget:   parseFloat(fillTarget.toFixed(2)),
            fillProb,
            alreadyFilled,
            label:        alreadyFilled
                ? `GAP ${gapDirection} — FILLED`
                : `GAP ${gapDirection} ${absGap.toFixed(2)}% — ${fillProb}% FILL PROB`,
            isHighRisk:   absGap > 0.5 && !alreadyFilled // High risk if large unfilled gap
        };
    }

    /**
     * T1-E: EQUAL HIGHS / EQUAL LOWS (Engineered Liquidity Levels)
     * Institutional stop-hunting targets: clusters of 2+ near-identical highs/lows.
     * These are not random — they represent engineered stop pools.
     * When price approaches equal highs from below, expect a sweep then reversal.
     */
    detectEqualHighsLows(symbol, tf = '5m', tolerance = 0.0008) {
        const stock = this.stocks[symbol];
        if (!stock) return { equalHighs: [], equalLows: [] };
        const candles = stock.candles[tf] || [];
        if (candles.length < 20) return { equalHighs: [], equalLows: [] };

        const isForex = symbol.includes('=X');
        const tol = isForex ? 0.0003 : tolerance; // tighter for forex

        const recent = candles.slice(-60); // Look back 60 candles
        const highs  = recent.map(c => c.high);
        const lows   = recent.map(c => c.low);

        const cluster = (arr) => {
            const clusters = [];
            const used = new Set();
            for (let i = 0; i < arr.length; i++) {
                if (used.has(i)) continue;
                const group = [arr[i]];
                for (let j = i + 1; j < arr.length; j++) {
                    if (used.has(j)) continue;
                    if (Math.abs(arr[i] - arr[j]) / arr[i] <= tol) {
                        group.push(arr[j]);
                        used.add(j);
                    }
                }
                if (group.length >= 2) {
                    clusters.push({
                        level:    parseFloat((group.reduce((s, v) => s + v, 0) / group.length).toFixed(isForex ? 5 : 2)),
                        count:    group.length,
                        strength: Math.min(100, group.length * 25)
                    });
                }
                used.add(i);
            }
            return clusters.sort((a, b) => b.count - a.count).slice(0, 3);
        };

        return {
            equalHighs: cluster(highs),
            equalLows:  cluster(lows)
        };
    }

    /**
     * T1-G: VOLUME POINT OF CONTROL (VPOC) & VALUE AREA
     * Institutional algos map transaction volume vertically (Y-Axis). 
     * Calculates the exact price handling the maximum volume today, and the 70% Value Area.
     */
    calculateVPOC(symbol, tf = '5m') {
        const stock = this.stocks[symbol];
        if (!stock) return { vpoc: 0, vah: 0, val: 0, currentZone: 'NEUTRAL' };
        
        const candles = stock.candles[tf] || [];
        if (!candles.length) return { vpoc: 0, vah: 0, val: 0, currentZone: 'NEUTRAL' };
        
        const now = new Date();
        const nyNow = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
        nyNow.setHours(0, 0, 0, 0);
        const midnightTs = nyNow.getTime();
        
        const sessionCandles = candles.filter(c => c.timestamp >= midnightTs);
        if (sessionCandles.length === 0) return { vpoc: 0, vah: 0, val: 0, currentZone: 'NEUTRAL' };

        const isForex = symbol.includes('=X') || symbol.includes('USD');
        const binSize = isForex ? 0.0005 : (stock.currentPrice > 100 ? 0.5 : 0.1);
        
        const profile = {};
        let totalVol = 0;
        
        sessionCandles.forEach(c => {
            const typicalPrice = (c.high + c.low + c.close) / 3;
            const bin = Math.floor(typicalPrice / binSize) * binSize;
            if (!profile[bin]) profile[bin] = 0;
            const vol = c.volume || 1; 
            profile[bin] += vol;
            totalVol += vol;
        });
        
        let maxVol = 0;
        let vpoc = 0;
        const sortedBins = Object.keys(profile).map(Number).sort((a,b) => a-b);
        
        sortedBins.forEach(bin => {
            if (profile[bin] > maxVol) {
                maxVol = profile[bin];
                vpoc = bin;
            }
        });
        
        let volSum = maxVol;
        let vah = vpoc;
        let val = vpoc;
        const targetVol = totalVol * 0.70;
        
        let upIdx = sortedBins.indexOf(vpoc) + 1;
        let dnIdx = sortedBins.indexOf(vpoc) - 1;
        
        while (volSum < targetVol && (upIdx < sortedBins.length || dnIdx >= 0)) {
            const upVol = upIdx < sortedBins.length ? profile[sortedBins[upIdx]] : -1;
            const dnVol = dnIdx >= 0 ? profile[sortedBins[dnIdx]] : -1;
            
            if (upVol >= dnVol && upVol !== -1) {
                volSum += upVol;
                vah = sortedBins[upIdx];
                upIdx++;
            } else if (dnVol !== -1) {
                volSum += dnVol;
                val = sortedBins[dnIdx];
                dnIdx--;
            } else {
                break;
            }
        }
        
        const cp = stock.currentPrice;
        let currentZone = 'VALUE AREA';
        if (cp > vah) currentZone = 'PREMIUM';
        else if (cp < val) currentZone = 'DISCOUNT';
        
        return {
            vpoc: parseFloat(vpoc.toFixed(isForex ? 5 : 2)),
            vah: parseFloat(Math.max(vah, val).toFixed(isForex ? 5 : 2)),
            val: parseFloat(Math.min(vah, val).toFixed(isForex ? 5 : 2)),
            currentZone
        };
    }

    /**
     * T1-H: MACRO DIVERGENCE (Equities vs TNX vs DXY)
     * High yield/dollar spikes should crush equities. If equities decouple, it predicts a violent trap.
     */
    detectMacroDivergence(symbol) {
        if (!['SPY', 'QQQ', 'DIA'].includes(symbol)) return { active: false, type: 'NONE', label: 'N/A', rationale: 'This metric tracks US Equity vs Yield divergence.' };
        
        const stock = this.stocks[symbol];
        const tnx = this.stocks['^TNX'];
        const dxy = this.stocks['DXY'] || this.stocks['UUP']; 
        if (!stock || !tnx || !dxy) return { active: false, type: 'NONE', label: 'MISSING DATA', rationale: 'Awaiting TNX/DXY data sync...' };
        
        const stockPct = stock.dailyChangePercent || 0;
        const tnxPct = tnx.dailyChangePercent || 0;
        const dxyPct = dxy.dailyChangePercent || 0;
        
        if (stockPct > 0.15 && tnxPct > 0.5 && dxyPct > 0.1) {
            return { active: true, type: 'BEARISH FAKEOUT', label: 'BEARISH DIVERGENCE', rationale: 'Pricing in Yield Shock.' };
        }
        if (stockPct < -0.15 && tnxPct < -0.5 && dxyPct < -0.1) {
            return { active: true, type: 'BULLISH ACCUMULATION', label: 'BULLISH DIVERGENCE', rationale: 'Yields collapsing, equities buffering.' };
        }
        
        return { active: false, type: 'ALIGNED', label: 'ALIGNED', rationale: 'Yield pricing matches equities.' };
    }

    get currentPrice() { return this.stocks[this.currentSymbol]?.currentPrice || 0; }
    get candles() { return this.stocks[this.currentSymbol]?.candles[this.currentTimeframe] || []; }

    calculateOvernightSentiment(symbol) {
        let targetSym = symbol;
        const proxyMap = { 'SPY': 'ES=F', 'QQQ': 'NQ=F', 'DIA': 'YM=F' };
        
        const stock = this.stocks[targetSym];
        if (!stock) return { asia: 0, london: 0, ny: 0, global: 'NEUTRAL' };

        // --- INSTITUTIONAL PROXY PIVOT ---
        // If we are looking at an Equity that is closed overnight, use Futures to drive Asia/London delta
        const proxySym = proxyMap[targetSym];
        const proxyStock = proxySym ? this.stocks[proxySym] : null;

        const candles = stock.candles['1h'] && stock.candles['1h'].length > 5 ? stock.candles['1h'] : 
                      (stock.candles['15m'] && stock.candles['15m'].length > 10 ? stock.candles['15m'] : 
                      (stock.candles['5m'] || []));

        const currentPrice = stock.currentPrice || 0;
        if (currentPrice === 0 || candles.length === 0) return { asia: 0, london: 0, ny: 0, global: 'NEUTRAL' };

        if (!stock._sessionCache) stock._sessionCache = {};
        const now = Date.now();
        if (!stock._sessionCache.expiry || now > stock._sessionCache.expiry) {
            const findSessionAnchor = (sym, hourUTC) => {
                const s = this.stocks[sym];
                if (!s || !s.candles['1h']) return null;
                const cArr = s.candles['1h'];
                for (let i = cArr.length - 1; i >= 0; i--) {
                    const d = new Date(cArr[i].timestamp);
                    if (d.getUTCHours() === hourUTC) return cArr[i].open;
                }
                return null;
            };

            // Capture anchors. Use proxy for Asia/London/NY if the primary (Equity) is closed
            // COLD-START FIX: Fall back to previousClose (from Yahoo Finance seed) when candle history
            // doesn't have a matching UTC-hour anchor yet. This prevents 0.00% displays at startup.
            const prevClose = stock.previousClose || stock.currentPrice || candles[0]?.open;
            const proxyPrevClose = proxyStock?.previousClose || proxyStock?.currentPrice || prevClose;

            stock._sessionCache.asiaOpen   = findSessionAnchor(proxySym || targetSym, 22) || findSessionAnchor(proxySym || targetSym, 23) || findSessionAnchor(proxySym || targetSym, 0) || proxyPrevClose || prevClose;
            stock._sessionCache.londonOpen = findSessionAnchor(proxySym || targetSym, 7)  || findSessionAnchor(proxySym || targetSym, 8) || findSessionAnchor(targetSym, 9) || (proxyStock ? proxyPrevClose : prevClose);
            stock._sessionCache.nyMidnight = findSessionAnchor(proxySym || targetSym, 4)  || findSessionAnchor(proxySym || targetSym, 5) || findSessionAnchor(targetSym, 9) || prevClose;
            stock._sessionCache.expiry = now + 300000;
        }

        const asiaOpen = stock._sessionCache.asiaOpen;
        const londonOpen = stock._sessionCache.londonOpen;
        const nyMidnight = stock._sessionCache.nyMidnight;
        
        const d_asia = (currentPrice / (asiaOpen || 1) - 1);
        const d_london = (currentPrice / (londonOpen || 1) - 1);
        const d_ny = (currentPrice / (nyMidnight || 1) - 1);
        const d_prev = stock.dailyChangePercent / 100 || 0;

        let global = 'NEUTRAL';
        if (d_asia > 0.003 && d_london > 0.003) global = 'STRONGLY_BULLISH';
        else if (d_asia < -0.003 && d_london < -0.003) global = 'STRONGLY_BEARISH';
        else if (d_asia > 0 && d_london > 0) global = 'BULLISH';
        else if (d_asia < 0 && d_london < 0) global = 'BEARISH';

        return {
            asia: d_asia,
            london: d_london,
            ny: d_ny,
            previousSession: d_prev,
            global
        };
    }

    getInstitutionalMarkers(symbol = this.currentSymbol, tf = this.currentTimeframe, skipRadar = false) {
        if (this._isCalculatingMarkers) return { pdh: 0, pdl: 0, midnightOpen: 0, vwap: 0, poc: 0, cvd: 0 };
        this._isCalculatingMarkers = true;
        
        try {
            const stock = this.stocks[symbol];
        if (!stock) return { pdh: 0, pdl: 0, midnightOpen: 0, vwap: 0, poc: 0, cvd: 0 };
        const candles = stock.candles[tf];
        if (!candles || candles.length === 0) {
            // SILENT: Symbol likely still in background fetch queue
            return { pdh: 0, pdl: 0, midnightOpen: 0, vwap: 0, poc: 0, cvd: 0 };
        }
        let poc = 0;
        let maxVol = 0;
        Object.entries(stock.volumeClusters || {}).forEach(([price, vol]) => {
            if (vol > maxVol) {
                maxVol = vol;
                poc = parseFloat(price);
            }
        });

        // Accurate Midnight Open (00:00 EST)
        const now = new Date();
        const nyNow = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
        nyNow.setHours(0, 0, 0, 0);
        const midnightTs = nyNow.getTime();

        // NY Open (09:30 EST)
        const nyOpenTime = new Date(nyNow);
        nyOpenTime.setHours(9, 30, 0, 0);
        const nyOpenTs = nyOpenTime.getTime();

        // London Open (03:00 EST)
        const lonOpenTime = new Date(nyNow);
        lonOpenTime.setHours(3, 0, 0, 0);
        const lonOpenTs = lonOpenTime.getTime();

        // Optimized Binary Search to find candle closest to a timestamp (Critical for high-frequency Pyth updates)
        const findCandleAt = (ts) => {
            if (!candles.length) return null;
            let low = 0;
            let high = candles.length - 1;
            let best = candles[0];
            let minDiff = Math.abs(candles[0].timestamp - ts);

            while (low <= high) {
                const mid = Math.floor((low + high) / 2);
                const diff = Math.abs(candles[mid].timestamp - ts);
                
                if (diff < minDiff) {
                    minDiff = diff;
                    best = candles[mid];
                }

                if (candles[mid].timestamp < ts) {
                    low = mid + 1;
                } else if (candles[mid].timestamp > ts) {
                    high = mid - 1;
                } else {
                    return candles[mid];
                }
            }
            return best;
        };

        const midnightCandle = findCandleAt(midnightTs);
        const nyOpenCandle = findCandleAt(nyOpenTs);
        const lonOpenCandle = findCandleAt(lonOpenTs);

        // --- INSTITUTIONAL PIVOTS (PDH / PDL) ---
        const dailyCandles = stock.candles['1d'] || [];
        let pdh = 0, pdl = 0;
        if (dailyCandles.length > 1) {
            const yesterday = dailyCandles[dailyCandles.length - 2];
            pdh = yesterday.high;
            pdl = yesterday.low;
        }

        const engine = new LiquidityEngine();
        const adr = this.stocks[symbol].dailyQuotes ?
            engine.calculateADR(this.stocks[symbol].dailyQuotes) : 0;

        const sessionCandles = candles.filter(c => c.timestamp >= midnightTs);

        // --- IMPROVED MIDNIGHT OPEN DETECTION ---
        // 1. Try absolute midnight candle
        // 2. If missing (common in RTH-only data), use the FIRST candle of the session
        // 3. If no candles today yet, use Previous Close as the "True Open" anchor
        let midnightOpen = 0;
        if (sessionCandles.length > 0) {
            midnightOpen = sessionCandles[0].open;
        } else {
            const mc = findCandleAt(midnightTs);
            midnightOpen = mc ? mc.open : (stock.previousClose || candles[0].close);
        }

        const todayHigh = sessionCandles.length > 0 ? Math.max(...sessionCandles.map(c => c.high)) : candles[candles.length - 1].high;
        const todayLow = sessionCandles.length > 0 ? Math.min(...sessionCandles.map(c => c.low)) : candles[candles.length - 1].low;

        const vwapMetrics = this.calculateVWAP(symbol, tf);
        
        const radar = skipRadar ? null : this.getInstitutionalRadar(symbol, tf);
        
        // Proxy GEX Option Walls -> Real GEX Data
        let callWall = 0;
        let putWall = 0;
        
        if (radar && radar.gex && radar.gex.length > 0) {
            const calls = radar.gex.filter(g => g.type === 'CALL_WALL').sort((a, b) => b.gamma - a.gamma);
            const puts = radar.gex.filter(g => g.type === 'PUT_WALL').sort((a, b) => b.gamma - a.gamma);
            if (calls.length > 0) callWall = calls[0].strike;
            if (puts.length > 0) putWall = puts[0].strike;
        }

        // Fallback if missing options data
        if (callWall === 0 || putWall === 0) {
            const isForex = symbol.includes('=X') || symbol.includes('USD');
            const interval = isForex ? 0.01 : (stock.currentPrice > 100 ? 5 : 1); 
            callWall = callWall || (Math.ceil(stock.currentPrice / interval) * interval);
            putWall = putWall || (Math.floor(stock.currentPrice / interval) * interval);
        }

        const res = {
            pdh: pdh || stock.previousClose * 1.01,
            pdl: pdl || stock.previousClose * 0.99,
            pdc: stock.previousClose || 0,
            todayHigh,
            todayLow,
            midnightOpen,
            nyOpen: findCandleAt(nyOpenTs)?.open || 0,
            londonOpen: findCandleAt(lonOpenTs)?.open || 0,
            vwap: vwapMetrics.vwap,
            vwapStdev: vwapMetrics.stdev,
            callWall,
            putWall,
            poc: poc || (candles[0] ? candles[0].close : 0),
            cvd: stock.cvd,
            netWhaleFlow: stock.netWhaleFlow || 0,
            whaleImbalance: (stock.whaleBuyVol + stock.whaleSellVol > 0) ?
                ((stock.whaleBuyVol - stock.whaleSellVol) / (stock.whaleBuyVol + stock.whaleSellVol) * 100) : (stock.institutionalSentiment?.sentiment ? (stock.institutionalSentiment.sentiment * 2 - 100) : 0),
            asiaRange: (() => {
                const asia = candles.filter(c => c.timestamp >= midnightTs && c.timestamp < lonOpenTs);
                if (asia.length > 0) {
                    return { high: Math.max(...asia.map(c => c.high)), low: Math.min(...asia.map(c => c.low)) };
                }
                return { high: todayHigh, low: todayLow };
            })(),
            smt: this.detectSMT(symbol, tf),
            adr,
            radar: radar,
            vwapBands:       this.getVWAPBands(symbol, tf),
            rvol:            this.calculateRVOL(symbol, tf),
            orb:             this.calculateORB(symbol, tf),
            gapFill:         this.calculateGapFill(symbol, tf),
            equalLevels:     this.detectEqualHighsLows(symbol, tf),
            vpoc:            this.calculateVPOC(symbol, tf),
            macroDivergence: this.detectMacroDivergence(symbol),
            overnight:       this.calculateOvernightSentiment(symbol),
            // --- EXPECTED MOVE PROJECTIONS (High Precision) ---
            expectedHigh: stock.currentPrice + (adr * 0.8),
            expectedLow:  stock.currentPrice - (adr * 0.8),
            oteSweetSpot: stock.currentPrice > midnightOpen ? (midnightOpen + (stock.currentPrice - midnightOpen) * 0.705) : (midnightOpen - (midnightOpen - stock.currentPrice) * 0.705),
            sessionPoints: [
                { time: midnightTs, label: 'MIDNIGHT OPEN', color: '#38bdf8' },
                { time: lonOpenTs, label: 'LONDON OPEN', color: '#3b82f6' },
                { time: nyOpenTs, label: 'NY OPEN', color: '#f59e0b' }
            ]
        };

        res.cbdr = engine.calculateCBDR(candles);
        res.ote  = engine.calculateOTE(candles);
        res.heatmap = engine.calculateInstitutionalHeatmap(candles, res, stock.currentPrice, symbol);
        res.draws = engine.findLiquidityDraws(candles);

        if (symbol === 'SPY') console.log(`[DATA] Markers for SPY @ ${tf}: MO: ${res.midnightOpen}, PDH: ${res.pdh}, VWAP: ${res.vwap}`);
        return res;
        } finally {
            this._isCalculatingMarkers = false;
        }
    }

    getInstitutionalRadar(symbol, tf) {
        const stock = this.stocks[symbol];
        const killzone = this.eliteAlgo.getKillzoneStatus();
        if (!stock) return { killzone, gex: [], smt: null, irScore: 0 };
        
        const currentPrice = stock.currentPrice;
        const gex = this.eliteAlgo.calculateGEX(currentPrice, symbol, stock.optionsChain);
        
        // 1. STANDARD CORRELATIVE SMT (e.g., SPY vs QQQ)
        let smt = this.detectSMT(symbol, tf);
        
        // 2. MASTER INVERSE SMT (DXY Sync - The Highest Priority Signal)
        const dxy = this.stocks['DXY'] || this.stocks['DX-Y.NYB'];
        if (dxy && dxy.candles[tf] && dxy.currentPrice > 0) {
            const isFX = symbol.includes('=X') || symbol.includes('USD');
            const isEquity = ['SPY', 'QQQ', 'DIA'].includes(symbol);
            
            // Only compare against DXY if it's an asset that SHOULD move inversely
            if (isFX || isEquity) {
                const inverseSmt = this.eliteAlgo.detectInverseSMT(
                    symbol, stock.currentPrice, stock.candles[tf],
                    dxy.currentPrice, dxy.candles[tf]
                );
                // Inverse SMT is the True Master; it overrides standard correlation
                if (inverseSmt) smt = inverseSmt;
            }
        }
        
        // 3. INSTITUTIONAL IMBALANCE (FVG & MSS)
        const fvg = this.eliteAlgo.detectLiquidityVoids(stock.candles[tf]);
        const mss = this.eliteAlgo.detectMSS(stock.candles[tf]);
        
        // 4. FINAL INSTITUTIONAL REALITY SCORE (IR-SCORE)
        const irScore = this.eliteAlgo.calculateIRScore(
            { score: stock.dailyChangePercent, confidence: 70 }, 
            killzone,
            smt,
            gex,
            50 
        );

        const mtf = {};
        this.timeframes.forEach(timeframe => {
            if (stock.candles[timeframe] && stock.candles[timeframe].length > 5) {
                const tfMarkers = this.getInstitutionalMarkers(symbol, timeframe, true);
                const tfBias = this.engine.calculateBias(
                    currentPrice, 
                    tfMarkers.fvgs || [], 
                    tfMarkers.draws || [], 
                    stock.bloomberg, 
                    tfMarkers, 
                    0, 
                    this.internals, 
                    symbol, 
                    stock.candles[timeframe]
                );
                mtf[timeframe] = tfBias.bias;
            } else {
                mtf[timeframe] = 'NEUTRAL';
            }
        });

        return {
            killzone,
            gex,
            smt,
            fvg,
            mss,
            score: irScore?.score || 50,
            status: irScore?.status || 'NEUTRAL',
            amdPhase: mss?.type || 'ACCUMULATION',
            mtf: mtf,
            progress: killzone?.progress || 0,
            vwapAlign: (currentPrice > 0 && stock.markers?.vwap > 0) ? (currentPrice > stock.markers.vwap) : false,
            dxySync:   this.detectMacroDivergence(symbol).active === false, // Aligned = true
            retailSentiment: stock.institutionalSentiment?.sentiment || 50
        };
    }

    generateHeatmapData(liquidityDraws) {
        const heatmap = [];
        const stock = this.stocks[this.currentSymbol];
        if (!stock) return heatmap;

        liquidityDraws.highs.concat(liquidityDraws.lows).forEach(draw => {
            const roundedPrice = Math.round(draw.price * 100) / 100;
            const volume = stock.volumeClusters[roundedPrice] || 0; // Remove random fallback
            heatmap.push({ price: draw.price, volume, type: draw.type });
        });
        return heatmap;
    }

    getNews() { return this.stocks[this.currentSymbol]?.news || []; }

    detectSMT(symbol, tf = '5m') {
        const pairs = {
            'SPY': 'QQQ',
            'QQQ': 'SPY',
            'EURUSD=X': 'GBPUSD=X',
            'GBPUSD=X': 'EURUSD=X',
            'AUDUSD=X': 'NZDUSD=X',
            'NZDUSD=X': 'AUDUSD=X',
            'USDJPY=X': 'USDCAD=X',
            'USDCAD=X': 'USDJPY=X',
            'BTC-USD': 'ETH-USD',
            'ETH-USD': 'BTC-USD'
        };

        const other = pairs[symbol];
        if (!other || !this.stocks[other] || !this.stocks[other].candles[tf]) return null;

        return this.eliteAlgo.detectSMT(
            symbol, this.stocks[symbol].currentPrice, this.stocks[symbol].candles[tf],
            other, this.stocks[other].currentPrice, this.stocks[other].candles[tf]
        );
    }

    detectMacroDivergence(symbol) {
        const stock = this.stocks[symbol];
        const dxy = this.stocks['DXY'] || this.stocks['DX-Y.NYB'];

        if (!stock || !dxy || !stock.candles['5m'] || !dxy.candles['5m']) {
            return { active: false, label: 'SYNCED', bias: 'NEUTRAL' };
        }

        const isFX = symbol.includes('=X') || symbol.includes('USD');
        const isBull = stock.currentPrice > (stock.candles['5m'][Math.max(0, stock.candles['5m'].length - 5)]?.close || 0);
        const dxyBull = dxy.currentPrice > (dxy.candles['5m'][Math.max(0, dxy.candles['5m'].length - 5)]?.close || 0);

        // If FX (Inverse to DXY usually) or Equities (Inverse to DXY)
        // Sync means they move in opposite directions.
        // Divergence means they move in the SAME direction (Unhealthy).
        if (isBull === dxyBull) {
            return { active: true, label: 'MACRO DIVERGENCE', bias: isBull ? 'BULLISH' : 'BEARISH' };
        }

        return { active: false, label: 'SYNCED', bias: 'NEUTRAL' };
    }
}
