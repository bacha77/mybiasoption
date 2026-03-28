import WebSocket from 'ws';
import { InstitutionalAlgorithm } from '../logic/institutional-algorithm.js';
import { LiquidityEngine } from '../logic/liquidity-engine.js';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { sourceManager, yahooFinance } from './data-sources.js';

export class RealDataManager {
    constructor() {
        this.apiKey = process.env.FINNHUB_API_KEY;
        this.configPath = path.join(process.cwd(), 'watchlist.json');
        this.watchlist = this.loadWatchlist();
        this.sectors = ['SPY', 'QQQ', 'DIA', 'BTC-USD', 'GLD', 'XLK', 'XLY', 'XLF', 'XLC', 'SMH', 'NVDA', 'AMD', 'META', 'GOOGL', 'KRE', 'XBI', 'IYT', 'EURUSD=X', 'GBPUSD=X', 'USDJPY=X', 'AUDUSD=X', 'NZDUSD=X', 'USDCAD=X', 'USDCHF=X', '^TNX', 'UUP'];
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
        this.eliteAlgo = new InstitutionalAlgorithm();
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

        // Load thermal/history for sector matrix + macro in background
        const g7Pairs = ['EURUSD=X', 'GBPUSD=X', 'USDJPY=X', 'AUDUSD=X', 'USDCAD=X', 'NZDUSD=X', 'USDCHF=X'];
        const priorityList = ['DXY', 'VIX', 'SPY', 'QQQ', 'BTC-USD', 'GOLD', ...g7Pairs];
        priorityList.forEach((s, idx) => {
            setTimeout(() => {
                this.refreshHistoricalData(s).catch(() => {});
            }, 1000 + (idx * 500));
        });
    }

    startMacroPolling() {
        // Institutional Heartbeat: Recursive Pulse for zero-collision delivery
        const poll = async () => {
            const g7Pairs = ['EURUSD=X', 'GBPUSD=X', 'USDJPY=X', 'AUDUSD=X', 'USDCAD=X', 'NZDUSD=X', 'USDCHF=X'];
            const macroPoll = ['SPY', 'QQQ', 'DIA', 'BTC-USD', 'DXY', 'VIX', 'GOLD', 'ES=F', 'NQ=F', ...g7Pairs];
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

        // Background sector matrix refresh
        setInterval(() => {
            this.sectors.forEach(sym => this.refreshQuote(sym).catch(() => {}));
            this.updateAll().catch(() => {});
        }, 30000);
        this.isInitialized = true;
    }

    async refreshQuote(symbol) {
        try {
            const quote = await sourceManager.getQuote(symbol);
            if (quote) this.ingestQuote(symbol, quote);
        } catch (e) {}
    }

    ingestQuote(symbol, quote) {
        if (!this.stocks[symbol]) {
            this.stocks[symbol] = {
                symbol,
                currentPrice: 0,
                previousClose: 0,
                dailyChangePercent: 0,
                pdh: 0,
                pdl: 0,
                cvd: 0,
                netWhaleFlow: 0,
                whaleBuyVol: 0,
                whaleSellVol: 0,
                volumeClusters: {},
                dailyQuotes: [],
                candles: { '1m': [], '5m': [], '15m': [], '1h': [] },
                bloomberg: { omon: 'NEUTRAL', btm: 'STALE', wei: 'NEUTRAL', sentiment: 0 },
                news: []
            };
        }
        
        const stock = this.stocks[symbol];
        if (quote.price && quote.price > 0) {
            stock.currentPrice = quote.price;
        }
        
        // Cache the previous close to avoid 0.00% flip-flopping
        if (quote.prevClose && quote.prevClose > 0) {
            stock.previousClose = quote.prevClose;
        } else if (!stock.previousClose || stock.previousClose === 0) {
            // Dynamic Institutional Bootstrapping: Derive from the current price and % change if available
            const dp = quote.change || 0;
            if (dp !== 0) {
                stock.previousClose = stock.currentPrice / (1 + (dp / 100));
            } else {
                // Last Resort: Hard-baselines (kept as absolute minimal floor but corrected for current market)
                const stableBaselines = { 
                    'SPY': 635.00, 'QQQ': 565.00, 'DIA': 455.00, 
                    'DXY': 100.15, 'DX-Y': 100.15, 'DX-Y.NYB': 100.15,
                    '^VIX': 30.50, 'VIX': 30.50, 'BTC-USD': 66400.00, 'ETH-USD': 2850.10,
                    'GC=F': 4515.50, 'GOLD': 4515.50
                };
                stock.previousClose = stableBaselines[symbol] || stock.currentPrice;
            }
        }
        
        if (stock.previousClose > 0) {
            stock.dailyChangePercent = ((stock.currentPrice - stock.previousClose) / stock.previousClose) * 100;
        } else if (typeof quote.change === 'number') {
            stock.dailyChangePercent = quote.change;
        }

        stock.dataSource = quote.source;
        
        if (quote.confidence !== undefined) {
            stock.pythConfidence = quote.confidence;
            stock.priceDiscordance = (quote.confidence / quote.price) * 10000; // bps
        }

        // --- HOLY GRAIL: Real-Time Macro Sync ---
        if (symbol === 'DX-Y.NYB' || symbol === 'DX-Y' || symbol === 'UUP' || symbol === 'DXY') {
            this.internals.dxyPrev = this.internals.dxy || stock.previousClose;
            this.internals.dxy = quote.price;
            this.internals.dxyChange = stock.dailyChangePercent;
        }
        if (symbol === '^VIX' || symbol === 'VIX') {
            this.internals.vixPrev = this.internals.vix;
            this.internals.vix = quote.price;
        }
        if (symbol === '^TNX' || symbol === 'TNX') this.internals.tnx = quote.price;

        // --- INSTITUTIONAL CANDLE INTERPOLATION (TOS-STYLE REAL-TIME) ---
        // Force the last candle in every timeframe to reflect the most recent institutional tick
        Object.keys(stock.candles).forEach(tf => {
            const candles = stock.candles[tf];
            if (candles && candles.length > 0) {
                const last = candles[candles.length - 1];
                last.close = quote.price;
                if (quote.price > last.high) last.high = quote.price;
                if (quote.price < last.low) last.low = quote.price;
            }
        });

        // Broadcast Price Update
        this.updatePriceFromTrade(symbol, quote.price, 0); 
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
                const dailyRes = await yahooFinance.chart(symbol, { period1: p1String, interval: '1d' }, { validate: false });
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
                let daysBack = 5;
                if (tf === '1h') daysBack = 15;
                else if (tf === '1d') daysBack = 365;

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
                        stock.candles[tf] = cleanedCandles;
                        console.log(`[FETCH] Success: ${symbol} @ ${tf} (${cleanedCandles.length} candles)`);
                    } else {
                        console.warn(`[FETCH] No candles returned for ${symbol} @ ${tf}`);
                    }
                } catch (err) { 
                    console.warn(`[FETCH] History failed for ${symbol} @ ${tf}`);
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
        if (this.stocks[symbol]) {
            const stock = this.stocks[symbol];

            // Check for session reset (e.g., first trade after 9:30 AM NY)
            this.checkSessionReset(symbol);

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
                }
            });

            // --- PRECISION-GATED UI EMITTANCE ---
            // Institutional stabilization: Only broadcast to UI if change is significant (> 0.001%) 
            // This prevents "shimmering" on sub-cent ticks while keeping internal engine precise.
            const oldPrice = stock.lastEmittedPrice || 0;
            const priceThreshold = stock.currentPrice * 0.00001; 
            const isSignificant = Math.abs(price - oldPrice) > priceThreshold || (Date.now() - (stock.lastEmittedTime || 0) > 2000);

            if (this.onPriceUpdateCallback && isSignificant) {
                stock.lastEmittedPrice = price;
                stock.lastEmittedTime = Date.now();
                this.onPriceUpdateCallback({
                    symbol,
                    price,
                    dailyChangePercent: stock.dailyChangePercent,
                    dailyChangePoints: pointsChange,
                    candles: stock.candles,
                    pythConfidence: stock.pythConfidence,
                    source: stock.dataSource
                });
            }
        }
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
        // Quote update is fast, do it every 30s
        if (!this.lastQuoteUpdate || now - this.lastQuoteUpdate > 30000) {
            await this.refreshQuote('^VIX');
            await this.refreshQuote('DX-Y.NYB');
            for (const sector of this.sectors) {
                await this.refreshQuote(sector);
            }
            this.lastQuoteUpdate = now;
        }

        // Heavy history refresh only every 10 minutes OR when specifically needed
        if (!this.lastMacroRefresh || now - this.lastMacroRefresh > 600000) {
            console.log("Performing essential macro history refresh...");
            await this.refreshHistoricalData('^VIX');
            await this.refreshHistoricalData('DX-Y.NYB');
            await this.refreshHistoricalData(this.currentSymbol);
            this.lastMacroRefresh = now;
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
            candles: { '1m': [], '5m': [], '15m': [], '1h': [] },
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
        return ['SPY', 'QQQ', 'IWM', 'SMH', 'NVDA', 'TSLA', 'AAPL', 'MSFT', 'META', 'AMZN', 'GOOGL', 'AMD', 'NFLX', 'BTC-USD', 'EURUSD=X', 'GBPUSD=X', 'USDJPY=X', 'AUDUSD=X'];
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
                tpv += typicalPrice * c.volume;
                totalVol += c.volume;
                sumSqrPriceVol += typicalPrice * typicalPrice * c.volume;
            }
        });

        if (totalVol === 0) return { vwap: candles[candles.length - 1].close, stdev: 0 };
        
        const vwap = tpv / totalVol;
        const variance = Math.max(0, (sumSqrPriceVol / totalVol) - (vwap * vwap));
        const stdev = Math.sqrt(variance);

        return { vwap, stdev };
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
            stock._sessionCache.asiaOpen = findSessionAnchor(proxySym || targetSym, 22) || findSessionAnchor(proxySym || targetSym, 23) || findSessionAnchor(proxySym || targetSym, 0) || candles[0].open;
            stock._sessionCache.londonOpen = findSessionAnchor(proxySym || targetSym, 7) || findSessionAnchor(proxySym || targetSym, 8) || findSessionAnchor(targetSym, 9) || (proxyStock ? proxyStock.currentPrice : candles[0].open);
            stock._sessionCache.nyMidnight = findSessionAnchor(proxySym || targetSym, 4) || findSessionAnchor(proxySym || targetSym, 5) || findSessionAnchor(targetSym, 9) || candles[0].open;
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
            asia: d_asia * 100,
            london: d_london * 100,
            nyMidnight: d_ny * 100,
            previousSession: d_prev * 100,
            global
        };
    }

    getInstitutionalMarkers(symbol = this.currentSymbol, tf = this.currentTimeframe) {
        const stock = this.stocks[symbol];
        if (!stock) return { pdh: 0, pdl: 0, midnightOpen: 0, vwap: 0, poc: 0, cvd: 0 };
        const candles = stock.candles[tf];
        if (!candles || candles.length === 0) {
            // SILENT: Symbol likely still in background fetch queue
            return { pdh: 0, pdl: 0, midnightOpen: 0, vwap: 0, poc: 0, cvd: 0 };
        }
        let poc = 0;
        let maxVol = 0;
        Object.entries(stock.volumeClusters).forEach(([price, vol]) => {
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

        const adr = this.stocks[symbol].dailyQuotes ?
            new LiquidityEngine().calculateADR(this.stocks[symbol].dailyQuotes) : 0;

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
        
        // Proxy GEX Option Walls (Finding nearest heavy strike levels based on current price)
        const isForex = symbol.includes('=X') || symbol.includes('USD');
        const interval = isForex ? 0.01 : (stock.currentPrice > 100 ? 5 : 1); 
        const callWall = Math.ceil(stock.currentPrice / interval) * interval;
        const putWall = Math.floor(stock.currentPrice / interval) * interval;

        const result = {
            pdh: stock.pdh || 0,
            pdl: stock.pdl || 0,
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
                ((stock.whaleBuyVol - stock.whaleSellVol) / (stock.whaleBuyVol + stock.whaleSellVol) * 100) : 0,
            asiaRange: (() => {
                const asia = candles.filter(c => c.timestamp >= midnightTs && c.timestamp < lonOpenTs);
                if (asia.length > 0) {
                    return { high: Math.max(...asia.map(c => c.high)), low: Math.min(...asia.map(c => c.low)) };
                }
                // Fallback to day high/low if early in session or crypto-continuous
                return { high: todayHigh, low: todayLow };
            })(),
            smt: this.detectSMT(symbol, tf),
            adr,
            radar: this.getInstitutionalRadar(symbol, tf)
        };
        if (symbol === 'SPY') console.log(`[DATA] Markers for SPY @ ${tf}: MO: ${result.midnightOpen}, PDH: ${result.pdh}, VWAP: ${result.vwap}`);
        return result;
    }

    getInstitutionalRadar(symbol, tf) {
        const stock = this.stocks[symbol];
        const killzone = this.eliteAlgo.getKillzoneStatus();
        
        // Proxy GEX logic
        const currentPrice = stock ? stock.currentPrice : 0;
        const gex = this.eliteAlgo.calculateGEX(currentPrice, symbol);
        
        // SMT Logic (SPY vs QQQ)
        const other = (symbol === 'SPY' ? 'QQQ' : (symbol === 'QQQ' ? 'SPY' : null));
        let smt = null;
        if (other && this.stocks[other] && stock) {
            smt = this.eliteAlgo.detectSMT(
                symbol, stock.currentPrice, stock.candles[tf],
                other, this.stocks[other].currentPrice, this.stocks[other].candles[tf]
            );
        }

        return {
            killzone,
            gex,
            smt,
            irScore: 50 // Baseline
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
        if (!other || !this.stocks[other]) return null;

        return this.eliteAlgo.detectSMT(
            symbol, this.stocks[symbol].currentPrice, this.stocks[symbol].candles[tf],
            other, this.stocks[other].currentPrice, this.stocks[other].candles[tf]
        );
    }
}
