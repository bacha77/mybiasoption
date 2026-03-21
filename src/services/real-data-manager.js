import WebSocket from 'ws';
import { InstitutionalAlgorithm } from '../logic/institutional-algorithm.js';
import { LiquidityEngine } from '../logic/liquidity-engine.js';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { sourceManager } from './data-sources.js';

export class RealDataManager {
    constructor() {
        this.apiKey = process.env.FINNHUB_API_KEY;
        this.configPath = path.join(process.cwd(), 'watchlist.json');
        this.watchlist = this.loadWatchlist();
        this.sectors = ['XLK', 'XLY', 'XLF', 'XLC', 'SMH', 'NVDA', 'AMD', 'META', 'GOOGL', 'KRE', 'XBI', 'IYT', 'EURUSD=X', 'GBPUSD=X', 'USDJPY=X', '^TNX', 'UUP'];
        this.symbolMap = {
            'EURUSD=X': 'OANDA:EUR_USD',
            'GBPUSD=X': 'OANDA:GBP_USD',
            'USDJPY=X': 'OANDA:USD_JPY',
            'AUDUSD=X': 'OANDA:AUD_USD',
            'BTC-USD': 'BINANCE:BTCUSDT',
            'DX-Y.NYB': 'DX-Y'
        };
        this.revMap = Object.fromEntries(Object.entries(this.symbolMap).map(([k, v]) => [v, k]));

        this.timeframes = ['1m', '5m', '15m', '1h', '1d'];
        this.currentTimeframe = '1m';
        this.currentSymbol = 'SPY';
        this.stocks = {};
        this.internals = { vix: 0, vixPrev: 0, dxy: 0, tnx: 0, newsImpact: 'LOW', breadth: 50 };
        this.ws = null;
        this.isInitialized = false;

        [...this.watchlist, '^VIX', 'DX-Y.NYB', ...this.sectors].forEach(symbol => { 
            this.stocks[symbol] = {
                currentPrice: 0,
                previousClose: 0,
                dailyChangePercent: 0,
                cvd: 0,
                netWhaleFlow: 0, // Cumulative value of institutional blocks
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

        const allSymbols = [...this.watchlist, '^VIX', 'DX-Y.NYB', ...this.sectors];
        
        // Step 1: Sequential Quote Fetch (Essential for current state)
        console.log("Fetching current quotes and market state...");
        for (const symbol of allSymbols) {
            try {
                await this.refreshQuote(symbol);
            } catch (err) { }
        }

        // Step 2: Fetch history only for current symbol (to start UI immediately)
        console.log(`Loading initial history for ${this.currentSymbol}...`);
        await this.refreshHistoricalData(this.currentSymbol);

        // Step 3: Background fetch for others (Delayed to avoid rate limit/spike)
        this.isInitialized = true;
        this.internals.vix = this.stocks['^VIX']?.currentPrice || 0;
        this.internals.dxy = this.stocks['DX-Y.NYB']?.currentPrice || 0;

        this.connectWebSocket();
        console.log("Real-Time Data Manager Initialized.");

        // Load thermal/history for sector matrix + macro in background
        const priorityList = ['^VIX', 'DX-Y.NYB', ...this.sectors];
        priorityList.forEach((s, idx) => {
            setTimeout(() => {
                this.refreshHistoricalData(s).catch(() => {});
            }, 3000 + (idx * 2000));
        });
    }

    async refreshQuote(symbol) {
        try {
            const quote = await sourceManager.getQuote(symbol);
            if (quote) {
                const stock = this.stocks[symbol];
                stock.currentPrice = quote.price;
                stock.previousClose = quote.prevClose || stock.previousClose || quote.price;
                stock.dailyChangePercent = quote.change || 0;
                stock.dataSource = quote.source; // Track where the data is coming from
                
                // Sanity check for PDH/PDL fallback
                if (!stock.pdh || isNaN(stock.pdh)) {
                    stock.pdh = quote.high || stock.previousClose;
                    stock.pdl = quote.low || stock.previousClose;
                }
            }
        } catch (error) {
            console.error(`[DATA ERROR] Failed to refresh quote for ${symbol}:`, error.message);
        }
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
                const dailyRes = await yahooFinance.chart(symbol, { period1: p1String, interval: '1d' });
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
                        // Sanity Check: Ensure PDH/PDL aren't thousands of % away
                        const current = stock.currentPrice || targetDay.close;
                        if (Math.abs(targetDay.high - current) / current < 0.5) {
                            stock.pdh = targetDay.high;
                            stock.pdl = targetDay.low;
                        }
                        stock.dailyQuotes = dailyRes.quotes.filter(q => q.high != null);
                        console.log(`[${symbol}] Anchored Daily Levels.`);
                    }
                }
            } catch (err) { }

            for (const tf of this.timeframes) {
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
                                // Clean up massive anomalous wicks (common with Yahoo Finance pre/post market data)
                                const bodyMax = Math.max(c.open, c.close);
                                const bodyMin = Math.min(c.open, c.close);
                                const bodySize = Math.max(bodyMax - bodyMin, c.open * 0.0005);
                                
                                if (c.high - bodyMax > bodySize * 4) c.high = bodyMax + bodySize;
                                if (bodyMin - c.low > bodySize * 4) c.low = bodyMin - bodySize;
                                
                                cleanedCandles.push(c);
                            }
                            stock.candles[tf] = cleanedCandles;
                    }
                } catch (err) { }
            }
            console.log(`[${symbol}] Candles loaded.`);
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
            const instruments = [...this.watchlist, '^VIX', 'UUP', ...this.sectors];
            instruments.forEach(symbol => {
                const subSymbol = this.symbolMap[symbol] || symbol;
                this.ws.send(JSON.stringify({ type: 'subscribe', symbol: subSymbol }));
            });
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

            // SAFETY FILTER: Tighter deviation to prevent massive fake wicks on the chart
            if (stock.currentPrice > 0) {
                const deviation = Math.abs(price - stock.currentPrice) / stock.currentPrice;
                // Allow 2% max deviation for Crypto/FX in a single tick, 0.5% for Stocks
                const maxDeviation = (symbol.includes('=X') || symbol === 'BTC-USD') ? 0.02 : 0.005;
                if (deviation > maxDeviation) return; // Drop bad ticks
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

            stock.currentPrice = price;

            // Update daily change percent correctly
            if (stock.previousClose > 0) {
                stock.dailyChangePercent = ((price - stock.previousClose) / stock.previousClose) * 100;
            }

            // HOLY GRAIL: Real-time update of macro internals
            if (symbol === '^VIX') {
                this.internals.vixPrev = this.internals.vix;
                this.internals.vix = price;
            }
            if (symbol === 'UUP') this.internals.dxy = price;
            if (symbol === '^TNX') this.internals.tnx = price;

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

            if (this.onPriceUpdateCallback) {
                this.onPriceUpdateCallback(symbol, price, stock.dailyChangePercent, stock.candles);
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
            if (this.stocks['UUP']?.currentPrice > 0) this.internals.dxy = this.stocks['UUP'].currentPrice;
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

    getInstitutionalMarkers(symbol = this.currentSymbol, tf = this.currentTimeframe) {
        const stock = this.stocks[symbol];
        if (!stock) return { pdh: 0, pdl: 0, midnightOpen: 0, vwap: 0, poc: 0, cvd: 0 };
        const candles = stock.candles[tf];
        if (!candles || candles.length === 0) return { pdh: 0, pdl: 0, midnightOpen: 0, vwap: 0, poc: 0, cvd: 0 };

        // Find POC (Price with highest volume cluster)
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

        // Helper to find candle closest to a timestamp
        const findCandleAt = (ts) => {
            let best = candles[0];
            let minDiff = Math.abs(candles[0].timestamp - ts);
            for (const c of candles) {
                const diff = Math.abs(c.timestamp - ts);
                if (diff < minDiff) {
                    minDiff = diff;
                    best = c;
                }
                if (c.timestamp > ts && diff > minDiff) break;
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

        return {
            pdh: stock.pdh || 0,
            pdl: stock.pdl || 0,
            pdc: stock.previousClose || 0,
            todayHigh,
            todayLow,
            midnightOpen,
            nyOpen: findCandleAt(nyOpenTs).open,
            londonOpen: findCandleAt(lonOpenTs).open,
            vwap: vwapMetrics.vwap,
            vwapStdev: vwapMetrics.stdev,
            callWall,
            putWall,
            poc: poc || candles[0].close,
            cvd: stock.cvd,
            netWhaleFlow: stock.netWhaleFlow || 0,
            whaleImbalance: (stock.whaleBuyVol + stock.whaleSellVol > 0) ?
                ((stock.whaleBuyVol - stock.whaleSellVol) / (stock.whaleBuyVol + stock.whaleSellVol) * 100) : 0,
            smt: this.detectSMT(symbol, tf),
            adr,
            radar: this.getInstitutionalRadar(symbol, tf)
        };
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
            'GBPUSD=X': 'EURUSD=X'
        };

        const other = pairs[symbol];
        if (!other || !this.stocks[other]) return null;

        return this.eliteAlgo.detectSMT(
            symbol, this.stocks[symbol].currentPrice, this.stocks[symbol].candles[tf],
            other, this.stocks[other].currentPrice, this.stocks[other].candles[tf]
        );
    }
}
