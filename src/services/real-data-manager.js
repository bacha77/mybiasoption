import WebSocket from 'ws';
import YahooFinance from 'yahoo-finance2';
import { LiquidityEngine } from '../logic/liquidity-engine.js';
import fs from 'fs';
import path from 'path';

const yahooFinance = new YahooFinance();

export class RealDataManager {
    constructor() {
        this.apiKey = process.env.FINNHUB_API_KEY;
        this.configPath = path.join(process.cwd(), 'watchlist.json');
        this.watchlist = this.loadWatchlist();
        this.sectors = ['XLK', 'XLY', 'XLF', 'XLC', 'SMH', 'NVDA', 'AMD', 'META', 'GOOGL', 'KRE', 'XBI', 'IYT', 'EURUSD=X', 'GBPUSD=X', 'USDJPY=X', '^TNX'];
        this.symbolMap = {
            'EURUSD=X': 'OANDA:EUR_USD',
            'GBPUSD=X': 'OANDA:GBP_USD',
            'USDJPY=X': 'OANDA:USD_JPY',
            'AUDUSD=X': 'OANDA:AUD_USD',
            'BTC-USD': 'BINANCE:BTCUSDT'
        };
        this.revMap = Object.fromEntries(Object.entries(this.symbolMap).map(([k, v]) => [v, k]));

        this.timeframes = ['1m', '5m', '15m', '1h', '1d'];
        this.currentTimeframe = '1m';
        this.currentSymbol = 'SPY';
        this.stocks = {};
        this.internals = { vix: 0, vixPrev: 0, dxy: 0, tnx: 0, newsImpact: 'LOW', breadth: 50 };
        this.ws = null;
        this.isInitialized = false;

        [...this.watchlist, '^VIX', 'UUP', ...this.sectors].forEach(symbol => { // UUP as DXY proxy
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
        this.maxBlockTrades = 20; // Keep only 20 most recent
    }

    async initialize() {
        if (this.isInitialized) return;
        console.log("Initializing Real-Time Data Manager (Finnhub + Yahoo)...");

        const allSymbols = [...this.watchlist, '^VIX', 'UUP', ...this.sectors];
        for (const symbol of allSymbols) {
            console.log(`Fetching historical data for ${symbol}...`);
            await this.refreshHistoricalData(symbol);
        }

        this.isInitialized = true;

        // Sync internals immediately after history fetch
        this.internals.vix = this.stocks['^VIX']?.currentPrice || 0;
        this.internals.dxy = this.stocks['UUP']?.currentPrice || 0;

        this.connectWebSocket();
        console.log("Real-Time Data Manager Initialized.");
    }

    async refreshHistoricalData(symbol) {
        try {
            const quote = await yahooFinance.quote(symbol);
            if (quote) {
                this.stocks[symbol].currentPrice = quote.regularMarketPrice;
                this.stocks[symbol].previousClose = quote.regularMarketPreviousClose || quote.regularMarketOpen || quote.regularMarketPrice;
                this.stocks[symbol].dailyChangePercent = quote.regularMarketChangePercent || 0;
                this.stocks[symbol].bloomberg = this.calculateBloombergMetrics(quote);
            } else {
                console.warn(`Quote data not available for ${symbol}. Skipping some initializations.`);
            }

            // --- SOPHISTICATED PDH/PDL SELECTOR ---
            const date10d = new Date();
            date10d.setDate(date10d.getDate() - 10);
            const p1String = date10d.toISOString().split('T')[0];
            const dailyRes = await yahooFinance.chart(symbol, { period1: p1String, interval: '1d' });
            if (dailyRes && dailyRes.quotes && dailyRes.quotes.length > 0) {
                const nyNow = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
                const currentNYDate = nyNow.toISOString().split('T')[0];
                const hour = nyNow.getHours();
                const minute = nyNow.getMinutes();

                // Check if current candle is "Today"
                const quotes = dailyRes.quotes.filter(q => q.high !== null);
                const lastIdx = quotes.length - 1;
                const lastQuote = quotes[lastIdx];
                const lastQuoteDate = lastQuote.date.toISOString().split('T')[0];

                let targetDay;
                // If it's before the market open (9:30) OR after the close (16:00) 
                // and the last candle matches today, then today's (just ended) candle IS our PDH.
                // Otherwise, the PDH is the one before the current "active" session.
                const isAfterClose = (hour >= 16);
                const isBeforeOpen = (hour < 9 || (hour === 9 && minute < 30));

                if (lastQuoteDate === currentNYDate) {
                    // Today exists in the data. 
                    // Use today if session ended (isAfterClose), else use yesterday (lastIdx - 1).
                    targetDay = isAfterClose ? lastQuote : quotes[lastIdx - 1];
                } else {
                    // Today doesn't exist yet, last quote is definitively the previous session.
                    targetDay = lastQuote;
                }

                if (targetDay) {
                    this.stocks[symbol].pdh = targetDay.high;
                    this.stocks[symbol].pdl = targetDay.low;
                    this.stocks[symbol].dailyQuotes = dailyRes.quotes.filter(q => q.high != null);
                    console.log(`[${symbol}] Anchored PDH: ${targetDay.high} | PDL: ${targetDay.low} (From: ${targetDay.date.toISOString().split('T')[0]})`);
                }
            } else {
                console.warn(`Insufficient daily data for ${symbol}. Falling back to intraday estimation.`);
            }

            for (const tf of this.timeframes) {
                let daysBack = 30;
                if (tf === '1m') daysBack = 5;  // Use 5 days to cover weekends/holidays
                else if (tf === '5m') daysBack = 5;
                else if (tf === '1d') daysBack = 365;

                const p1 = new Date();
                p1.setDate(p1.getDate() - daysBack);

                const chart = await yahooFinance.chart(symbol, { period1: p1, interval: tf });
                if (chart && chart.quotes) {
                    const candles = chart.quotes
                        .filter(q => q.open != null && q.open > 0)
                        .map(q => ({
                            timestamp: q.date.getTime(),
                            open: q.open,
                            high: q.high,
                            low: q.low,
                            close: q.close,
                            volume: q.volume
                        }));
                    if (candles.length > 0) {
                        this.stocks[symbol].candles[tf] = candles;
                        console.log(`[${symbol}] ${tf}: ${candles.length} candles loaded.`);
                    } else {
                        console.warn(`[${symbol}] ${tf}: No candles returned (weekend/holiday?). Will fallback to previous data.`);
                    }
                }
            }
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

            // SAFETY FILTER: Ignore trade prices that deviate more than 25% from current known price
            if (stock.currentPrice > 0) {
                const deviation = Math.abs(price - stock.currentPrice) / stock.currentPrice;
                if (deviation > 0.25) return;
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
        // Force refresh macro indices and sectors if they are zero or every 30 seconds
        const now = Date.now();
        if (!this.lastMacroRefresh || now - this.lastMacroRefresh > 30000) {
            await this.refreshHistoricalData('^VIX');
            await this.refreshHistoricalData('UUP');

            // Also refresh sectors + drivers
            for (const sector of this.sectors) {
                await this.refreshHistoricalData(sector);
            }

            this.lastMacroRefresh = now;
        }
    }

    async refreshNews() {
        try {
            const feedUrl = 'https://feeds.bloomberg.com/markets/news.rss';
            const axios = (await import('axios')).default;
            const res = await axios.get(feedUrl);
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
        if (!candles || candles.length === 0) return 0;

        // Session-anchored VWAP (approximate using current candle history for the day)
        const nyNow = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
        nyNow.setHours(9, 30, 0, 0);
        const sessionStart = nyNow.getTime();

        let tpv = 0;
        let totalVol = 0;
        candles.forEach(c => {
            if (c.timestamp >= sessionStart) {
                const typicalPrice = (c.high + c.low + c.close) / 3;
                tpv += typicalPrice * c.volume;
                totalVol += c.volume;
            }
        });

        return totalVol > 0 ? tpv / totalVol : candles[candles.length - 1].close;
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

        return {
            pdh: stock.pdh || 0,
            pdl: stock.pdl || 0,
            pdc: stock.previousClose || 0,
            todayHigh,
            todayLow,
            midnightOpen,
            nyOpen: findCandleAt(nyOpenTs).open,
            londonOpen: findCandleAt(lonOpenTs).open,
            vwap: this.calculateVWAP(symbol, tf),
            poc: poc || candles[0].close,
            cvd: stock.cvd,
            netWhaleFlow: stock.netWhaleFlow || 0,
            whaleImbalance: (stock.whaleBuyVol + stock.whaleSellVol > 0) ?
                ((stock.whaleBuyVol - stock.whaleSellVol) / (stock.whaleBuyVol + stock.whaleSellVol) * 100) : 0,
            smt: this.detectSMT(symbol, tf),
            adr
        };
    }

    generateHeatmapData(liquidityDraws) {
        const heatmap = [];
        const stock = this.stocks[this.currentSymbol];
        if (!stock) return heatmap;

        liquidityDraws.highs.concat(liquidityDraws.lows).forEach(draw => {
            const roundedPrice = Math.round(draw.price * 100) / 100;
            const volume = stock.volumeClusters[roundedPrice] || Math.floor(Math.random() * 500) + 100; // Small fallback instead of total mock
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
        if (!other) return null;

        const stockA = this.stocks[symbol];
        const stockB = this.stocks[other];
        if (!stockA || !stockB || !stockA.candles[tf] || !stockB.candles[tf] || stockA.candles[tf].length < 10 || stockB.candles[tf].length < 10) return null;

        const cA = stockA.candles[tf].slice(-10);
        const cB = stockB.candles[tf].slice(-10);

        const lowA = Math.min(...cA.map(c => c.low));
        const lowB = Math.min(...cB.map(c => c.low));
        const highA = Math.max(...cA.map(c => c.high));
        const highB = Math.max(...cB.map(c => c.high));

        const lastA = cA[cA.length - 1];
        const lastB = cB[cB.length - 1];

        // Bullish SMT: One makes lower low, other makes higher low
        if (lastA.low <= lowA && lastB.low > lowB) return { type: 'BULLISH', symbol: other, message: `Bullish SMT Divergence (QQQ Strength)` };
        if (lastB.low <= lowB && lastA.low > lowA) return { type: 'BULLISH', symbol: other, message: `Bullish SMT Divergence (SPY Strength)` };

        // Bearish SMT: One makes higher high, other makes lower high
        if (lastA.high >= highA && lastB.high < highB) return { type: 'BEARISH', symbol: other, message: `Bearish SMT Divergence (QQQ Weakness)` };
        if (lastB.high >= highB && lastA.high < highA) return { type: 'BEARISH', symbol: other, message: `Bearish SMT Divergence (SPY Weakness)` };

        return null;
    }
}
