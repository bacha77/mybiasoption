import WebSocket from 'ws';
import YahooFinance from 'yahoo-finance2';
import { LiquidityEngine } from '../logic/liquidity-engine.js';

const yahooFinance = new YahooFinance();

export class RealDataManager {
    constructor() {
        this.apiKey = process.env.FINNHUB_API_KEY;
        this.watchlist = ['SPY', 'QQQ', 'IWM', 'SMH', 'NVDA', 'TSLA', 'AAPL', 'MSFT', 'META', 'AMZN', 'GOOGL', 'AMD', 'NFLX', 'BTC-USD'];
        this.timeframes = ['1m', '5m', '15m'];
        this.currentTimeframe = '1m';
        this.currentSymbol = 'SPY';
        this.stocks = {};
        this.internals = { vix: 0, dxy: 0, newsImpact: 'LOW' }; // New Market Internals
        this.ws = null;
        this.isInitialized = false;

        [...this.watchlist, '^VIX', 'UUP'].forEach(symbol => { // UUP as DXY proxy
            this.stocks[symbol] = {
                currentPrice: 0,
                previousClose: 0,
                dailyChangePercent: 0,
                cvd: 0,
                volumeClusters: {},
                dailyQuotes: [],
                candles: { '1m': [], '5m': [], '15m': [] },
                bloomberg: { omon: 'NEUTRAL', btm: 'STALE', wei: 'NEUTRAL', sentiment: 0 },
                news: []
            };
        });
    }

    async initialize() {
        if (this.isInitialized) return;
        console.log("Initializing Real-Time Data Manager (Finnhub + Yahoo)...");

        const allSymbols = [...this.watchlist, '^VIX', 'UUP'];
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
            const date5d = new Date();
            date5d.setDate(date5d.getDate() - 5);
            const p1String = date5d.toISOString().split('T')[0];
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
                const daysBack = tf === '1m' ? 1 : tf === '5m' ? 5 : 10;
                const dateTf = new Date();
                dateTf.setDate(dateTf.getDate() - daysBack);
                const p1Tf = dateTf.toISOString().split('T')[0];

                const chart = await yahooFinance.chart(symbol, { period1: p1Tf, interval: tf });
                if (chart && chart.quotes) {
                    this.stocks[symbol].candles[tf] = chart.quotes
                        .filter(q => q.open != null)
                        .map(q => ({
                            timestamp: q.date.getTime(),
                            open: q.open,
                            high: q.high,
                            low: q.low,
                            close: q.close,
                            volume: q.volume
                        }));
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
            // Subscribe to all in watchlist
            this.watchlist.forEach(symbol => {
                this.ws.send(JSON.stringify({ type: 'subscribe', symbol }));
            });
        });

        this.ws.on('message', (data) => {
            const raw = JSON.parse(data.toString());
            if (raw.type === 'trade') {
                raw.data.forEach(trade => {
                    this.updatePriceFromTrade(trade.s, trade.p, trade.v);
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

            stock.currentPrice = price;

            // Update daily change percent correctly
            if (stock.previousClose > 0) {
                stock.dailyChangePercent = ((price - stock.previousClose) / stock.previousClose) * 100;
            }

            // Update current candles for all timeframes
            this.timeframes.forEach(tf => {
                const candles = stock.candles[tf];
                if (candles && candles.length > 0) {
                    const last = candles[candles.length - 1];
                    last.close = price;
                    last.high = Math.max(last.high, price);
                    last.low = Math.min(last.low, price);
                }
            });
        }
    }

    checkSessionReset(symbol) {
        const stock = this.stocks[symbol];
        const now = new Date();
        const nyTime = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
        const dateStr = nyTime.toDateString();

        if (stock.lastSessionDate !== dateStr) {
            console.log(`New session detected for ${symbol} (${dateStr}). Resetting intraday markers.`);
            stock.cvd = 0;
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

            // News Guardian: High Impact Keywords
            const highImpactKeywords = ['CPI', 'FOMC', 'POWELL', 'FED', 'INFLATION', 'NFP', 'JOBS REPORT', 'INTEREST RATE'];
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
            this.internals.vix = this.stocks['^VIX']?.currentPrice || 0;
            this.internals.dxy = this.stocks['UUP']?.currentPrice || 0;

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
        this.stocks[symbol] = {
            currentPrice: 0,
            previousClose: 0,
            dailyChangePercent: 0,
            cvd: 0,
            volumeClusters: {},
            candles: { '1m': [], '5m': [], '15m': [] },
            bloomberg: { omon: 'NEUTRAL', btm: 'STALE', wei: 'NEUTRAL', sentiment: 0 },
            news: []
        };

        // Fetch initial markers immediately for the new symbol
        await this.refreshHistoricalData(symbol);
        console.log(`✅ ${symbol} initialized with history.`);

        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type: 'subscribe', symbol }));
        }
    }

    removeSymbol(symbol) {
        this.watchlist = this.watchlist.filter(s => s !== symbol);
        delete this.stocks[symbol];
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

        return {
            pdh: stock.pdh || 0,
            pdl: stock.pdl || 0,
            todayHigh: Math.max(...candles.map(c => c.high)),
            todayLow: Math.min(...candles.map(c => c.low)),
            midnightOpen: midnightCandle.open,
            nyOpen: nyOpenCandle.open,
            londonOpen: lonOpenCandle.open,
            vwap: this.calculateVWAP(symbol, tf),
            poc: poc || candles[0].close,
            cvd: stock.cvd,
            adr
        };
    }

    generateHeatmapData(liquidityDraws) {
        const heatmap = [];
        liquidityDraws.highs.concat(liquidityDraws.lows).forEach(draw => {
            heatmap.push({ price: draw.price, volume: Math.floor(Math.random() * 5000) + 5000, type: draw.type });
        });
        return heatmap;
    }

    getNews() { return this.stocks[this.currentSymbol]?.news || []; }
}
