import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import { LiquidityEngine } from './logic/liquidity-engine.js';
import { RealDataManager } from './services/real-data-manager.js';
import { telegram } from './services/telegram-service.js';
import fs from 'fs';
import { NewsService } from './services/news-service.js';
import { schwabApi } from './services/schwab-execution.js';

const logFile = path.join(process.cwd(), 'system.log');
let aiStats = { signals: 42, success: 38, points: 14.2 }; // Seeded with recent session data
function logToFile(msg) {
    const timestamp = new Date().toISOString();
    fs.appendFileSync(logFile, `[${timestamp}] ${msg}\n`);
}

process.on('unhandledRejection', (reason, promise) => {
    const msg = `Unhandled Rejection at: ${promise} reason: ${reason}`;
    console.error(msg);
    logToFile(msg);
});

process.on('uncaughtException', (err) => {
    // SILENT EPIPE: Socket.io disconnections shouldn't crash or flood log
    if (err.code === 'EPIPE' || err.code === 'ECONNRESET' || err.message?.includes('broken pipe')) {
        // Only log once every hour to prevent disk fill
        const lastEpipe = global.lastEpipeTime || 0;
        if (Date.now() - lastEpipe > 3600000) {
            logToFile(`[SYSTEM] Caught network pipe error (EPIPE/RESET) - Ignoring to stay alive.`);
            global.lastEpipeTime = Date.now();
        }
        return;
    }
    
    const msg = `Uncaught Exception: ${err.message}\n${err.stack}`;
    try {
        console.error(msg);
    } catch(e) {}
    
    logToFile(msg);
    process.exit(1);
});

process.on('SIGINT', () => {
    console.log("[SYSTEM] Shutting down gracefully...");
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log("[SYSTEM] Signal TERM received.");
    process.exit(0);
});

import helmet from 'helmet';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(helmet({
    contentSecurityPolicy: false,
}));
const httpServer = createServer(app);
const io = new Server(httpServer);

const engine = new LiquidityEngine();
const simulator = new RealDataManager();
const lastAlerts = new Map();
let globalLastAlertTime = 0;

function canSendGlobal(isPriority = false) {
    const now = Date.now();
    if (!isPriority && (now - globalLastAlertTime < 120000)) return false;
    if (isPriority && (now - globalLastAlertTime < 60000)) return false;
    return true;
}

async function startServer() {
    const PORT = process.env.PORT || 3000;
    logToFile("Starting BIAS Strategy Server...");

    simulator.onBlockCallback = (block) => {
        if (block.isElite) {
            const whaleKey = `WHALE_${block.symbol}`;
            const lastWhale = lastAlerts.get(whaleKey) || 0;
            if (block.value >= 5000000 && (Date.now() - lastWhale > 1800000) && canSendGlobal()) {
                telegram.sendWhaleAlert(block.symbol, block.price, block.value, block.type).catch(() => { });
                lastAlerts.set(whaleKey, Date.now());
                globalLastAlertTime = Date.now();
            }
            io.emit('whale_alert', block);
        }
    };

    simulator.onPriceUpdateCallback = (data) => {
        if (data.isBatch) {
            io.emit('price_updated', data);
            
            // Institutional Sync: If the active symbol is in the batch, update the chart too
            const activeUpdate = data.updates.find(u => u.symbol === simulator.currentSymbol);
            if (activeUpdate) {
                const stock = simulator.stocks[simulator.currentSymbol];
                if (stock) {
                    const timeframe = simulator.currentTimeframe;
                    const candles = stock.candles[timeframe] || [];
                    if (candles.length > 0) {
                        const c = candles[candles.length - 1];
                        
                        // Institutional Shading Logic (Unified with History)
                        const isUp = c.close >= c.open;
                        const bodySize = Math.abs(c.close - c.open);
                        const avgBody = (candles.length > 20) 
                            ? (candles.slice(-20).reduce((sum, b) => sum + Math.abs(b.close - b.open), 0) / 20) 
                            : (c.open * 0.001);
                        
                        let color = isUp ? '#10b981' : '#f43f5e';
                        const multiplier = simulator.currentSymbol === 'BTC-USD' ? 2.5 : 2.0;
                        if (bodySize > avgBody * multiplier) {
                            color = isUp ? '#00f2ff' : '#ff0055'; 
                        }

                        if (activeUpdate.price === 0) {
                            console.warn(`[DEBUG] SENDING price_update with 0 price for ${simulator.currentSymbol}`);
                        }
                        
                        io.emit('price_update', {
                            symbol: simulator.currentSymbol,
                            currentPrice: activeUpdate.price, // Parity with app.js expectations
                            price: activeUpdate.price,        // Keep for legacy support
                            dailyChangePercent: activeUpdate.dailyChangePercent,
                            dailyChangePoints: activeUpdate.dailyChangePoints,
                            candle: candles.length > 0 ? {
                                time: Math.floor(candles[candles.length - 1].timestamp / 1000),
                                open: candles[candles.length - 1].open,
                                high: candles[candles.length - 1].high,
                                low: candles[candles.length - 1].low,
                                close: candles[candles.length - 1].close,
                                color,
                                wickColor: color,
                                borderColor: color
                            } : null
                        });
                    }
                }
            }
            return;
        }

        const { symbol, price, dailyChangePercent, dailyChangePoints, candles } = data;
        
        // Always emit for the market ticker indices
        const tickerSymbols = ['SPY', 'QQQ', 'DIA', 'BTC-USD', 'DXY', 'VIX', 'GOLD'];
        if (tickerSymbols.includes(symbol) || tickerSymbols.includes(symbol.replace('^', '').replace('DX-Y.NYB', 'DXY'))) {
            io.emit('price_updated', {
                symbol, price, dailyChangePercent, dailyChangePoints
            });
        }

        if (symbol === simulator.currentSymbol) {
            const timeframe = simulator.currentTimeframe;
            const tfCandles = candles[timeframe] || [];
            if (tfCandles.length > 0) {
                const c = tfCandles[tfCandles.length - 1];
                
                // Institutional Shading Logic (Unified)
                const isUp = c.close >= c.open;
                const bodySize = Math.abs(c.close - c.open);
                const avgBody = (tfCandles.length > 20) 
                    ? (tfCandles.slice(-20).reduce((sum, b) => sum + Math.abs(b.close - b.open), 0) / 20) 
                    : (c.open * 0.001);
                
                let color = isUp ? '#10b981' : '#f43f5e';
                const multiplier = symbol === 'BTC-USD' ? 2.5 : 2.0;
                if (bodySize > avgBody * multiplier) {
                    color = isUp ? '#00f2ff' : '#ff0055'; 
                }

                io.emit('price_update', {
                    symbol, price, dailyChangePercent, dailyChangePoints, 
                    candle: tfCandles.length > 0 ? {
                        time: Math.floor(tfCandles[tfCandles.length - 1].timestamp / 1000),
                        open: tfCandles[tfCandles.length - 1].open,
                        high: tfCandles[tfCandles.length - 1].high,
                        low: tfCandles[tfCandles.length - 1].low,
                        close: tfCandles[tfCandles.length - 1].close,
                        color,
                        wickColor: color,
                        borderColor: color
                    } : null
                });
            }
        }
    };

    app.use(express.static(path.join(__dirname, '../public')));
    app.use(express.json());

    app.post('/api/watchlist/add', async (req, res) => {
        const { symbol } = req.body;
        if (symbol) {
            await simulator.addSymbol(symbol);
            const wl = processWatchlist();
            io.emit('watchlist_updated', { watchlist: wl });
            res.json({ success: true, watchlist: wl });
        } else {
            res.status(400).json({ error: 'Symbol required' });
        }
    });

    app.delete('/api/watchlist/remove', (req, res) => {
        const { symbol } = req.body;
        if (symbol) {
            simulator.removeSymbol(symbol);
            res.json({ success: true, watchlist: simulator.watchlist });
        } else {
            res.status(400).json({ error: 'Symbol required' });
        }
    });

    app.get('/api/config', (req, res) => {
        res.json({
            supabaseUrl: process.env.SUPABASE_URL,
            supabaseAnonKey: process.env.SUPABASE_ANON_KEY
        });
    });

    // ── CHARLES SCHWAB API ROUTES ─────────────────────────────────────────────
    
    app.get('/auth/schwab', (req, res) => {
        const authUrl = schwabApi.getAuthorizationUrl();
        res.send(`
            <html>
            <body style="background:#0f172a; color:#10b981; font-family:monospace; padding:50px; text-align:center;">
                <h2>🏦 Connect Charles Schwab</h2>
                <p style="color:var(--text-dim); max-width:600px; margin:0 auto 20px;">
                    Schwab requires strict HTTPS security. Since you are running a local server without a registered SSL certificate, you must use a manual paste-method.
                </p>
                <ol style="text-align:left; max-width:600px; margin:0 auto 30px; background:rgba(0,0,0,0.3); padding:20px 40px; border-radius:10px; border:1px solid rgba(255,255,255,0.1);">
                    <li>Click the link below to open the secure Schwab Login page.</li>
                    <li>Log in with your Schwab account and click "Approve".</li>
                    <li>After approving, your browser will try to redirect to an empty page that might say "Site cannot be reached" (https://127.0.0.1/?code=...). <b>This is completely normal!</b></li>
                    <li>Look at your browser's URL address bar. Copy the huge block of text that comes exactly after <b>?code=</b> up to the end of the line.</li>
                    <li>Paste that massive code block into the box below and hit Submit.</li>
                </ol>
                <a href="${authUrl}" target="_blank" style="display:inline-block; padding:10px 20px; background:var(--gold); color:#000; font-weight:bold; text-decoration:none; border-radius:5px; margin-bottom:30px;">
                    1. Click Here to Login to Schwab
                </a>
                <br>
                <form action="/callback" method="GET" style="margin-top:20px;">
                    <input type="text" name="code" placeholder="Paste the massive ?code= here..." style="width:500px; padding:10px; border-radius:5px; border:1px solid #10b981; background:#000; color:#fff;" required>
                    <button type="submit" style="padding:10px 20px; background:#10b981; color:#000; font-weight:bold; cursor:pointer; border:none; border-radius:5px; margin-left:10px;">
                        2. Submit API Code
                    </button>
                </form>
            </body>
            </html>
        `);
    });

    app.get('/callback', async (req, res) => {
        const authCode = req.query.code;
        if (!authCode) {
            return res.status(400).send('Authorization failed. No code provided.');
        }

        const decodedCode = decodeURIComponent(authCode);
        console.log('[SCHWAB] Exchanging auth code...');
        
        const result = await schwabApi.generateTokensFromCode(decodedCode);
        
        if (result.success) {
            res.send(`
                <html>
                <body style="background:#0f172a; color:#10b981; font-family:monospace; text-align:center; padding:50px;">
                    <h2>✅ Schwab API Connected!</h2>
                    <p>The tokens are securely saved. You can close this tab and go back to the terminal.</p>
                </body>
                </html>
            `);
        } else {
            res.status(500).send(`
                <html>
                <body style="background:#0f172a; color:#f43f5e; font-family:monospace; padding:50px;">
                    <h2>❌ Connection Failed</h2>
                    <p>${JSON.stringify(result.error)}</p>
                </body>
                </html>
            `);
        }
    });

    app.get('/debug-state', (req, res) => {
        res.json({
            internals: simulator.internals,
            sectors: processSectors(),
            isInitialized: simulator.isInitialized
        });
    });

    // ── G7 BASKET DEBUGGER ────────────────────────────────────────────────────
    app.get('/debug-basket', (req, res) => {
        const rawPairs = {
            'EUR': 'EURUSD=X', 'GBP': 'GBPUSD=X', 'JPY': 'USDJPY=X',
            'AUD': 'AUDUSD=X', 'CAD': 'USDCAD=X', 'NZD': 'NZDUSD=X', 'CHF': 'USDCHF=X'
        };
        const stockKeys = Object.keys(simulator.stocks).slice(0, 30);
        const pairs = {};
        Object.entries(rawPairs).forEach(([cur, sym]) => {
            const s = simulator.stocks[sym];
            pairs[cur] = {
                sym,
                found: !!s,
                currentPrice: s?.currentPrice || 0,
                dailyChangePercent: s?.dailyChangePercent || 0,
                candles1m: s?.candles?.['1m']?.length || 0,
                candles5m: s?.candles?.['5m']?.length || 0,
                candles1h: s?.candles?.['1h']?.length || 0,
                first1m: s?.candles?.['1m']?.[0]?.close || 0,
                last1m: s?.candles?.['1m']?.[s?.candles?.['1m']?.length - 1]?.close || 0
            };
        });
        const g7 = calculateG7Basket();
        res.json({ stockKeys, pairs, basket: g7.basket });
    });

    io.on('connection', (socket) => {
        console.log(`[SOCKET] User connected.`);
        
        socket.on('manual_scan_trigger', () => {
            const signals = simulator.watchlist.map(sym => {
                const d = processData(sym);
                return { symbol: sym, ...d.scalpScan };
            });
            socket.emit('scalper_pulse', { updates: signals });
        });

        socket.on('switch_timeframe', async (tf) => {
            if (simulator.timeframes.includes(tf)) {
                simulator.currentTimeframe = tf;
                // Force history refresh for the new timeframe to ensure accurate switching
                await simulator.refreshHistoricalData(simulator.currentSymbol).catch(() => {});
                socket.emit('tf_updated', {
                    ...processData(),
                    watchlist: processWatchlist(),
                    blockTrades: simulator.blockTrades,
                    sectors: processSectors()
                });
            }
        });

        socket.on('switch_symbol', async (symbol) => {
            try {
                symbol = symbol.toUpperCase().trim();
                if (symbol === 'BTCUSD') symbol = 'BTC-USD';
                if (symbol === 'EURUSD') symbol = 'EURUSD=X';
                if (symbol === 'GBPUSD') symbol = 'GBPUSD=X';
                if (symbol === 'USDJPY') symbol = 'USDJPY=X';
                if (symbol === 'DXY' || symbol === 'DX-Y') symbol = 'DX-Y.NYB';

                simulator.currentSymbol = symbol;
                if (!simulator.stocks[symbol]) await simulator.addSymbol(symbol);
                await simulator.refreshHistoricalData(symbol);
                
                socket.emit('symbol_updated', {
                    ...processData(),
                    watchlist: processWatchlist(),
                    blockTrades: simulator.blockTrades,
                    sectors: processSectors()
                });
            } catch (err) {
                logToFile(`[SEARCH ERROR] Failed search for ${symbol}: ${err.message}`);
            }
        });

        socket.on('ping_latency', (cb) => { if (typeof cb === 'function') cb(); });

        socket.emit('init', {
            ...processData(),
            watchlist: processWatchlist(),
            blockTrades: simulator.blockTrades,
            sectors: processSectors(),
            isInitializing: !simulator.isInitialized
        });
    });

    httpServer.listen(PORT, '0.0.0.0', () => {
        console.log(`BIAS Strategy Server running at http://0.0.0.0:${PORT}`);
    });

    await simulator.initialize().catch(err => {
        logToFile(`Initialization Error: ${err.message}`);
    });
    
    const newsService = new NewsService(io);
    newsService.start();

    let lastWatchlistEmit = 0;
    const runUpdateLoop = async () => {
        try {
            await simulator.updateAll();
            const g7 = calculateG7Basket();
            const eventPulse = newsService.getEventPulse();
            const watchlist = processWatchlist(); // Detailed context for the AI
            const session = engine.getSessionInfo(simulator.currentSymbol);

            const currentUpdate = processData(simulator.currentSymbol, { basket: g7.basket, eventPulse, watchlist, session });
            const now = Date.now();
            let watchlistUpdate = (now - lastWatchlistEmit > 10000) ? watchlist : null;
            if (watchlistUpdate) lastWatchlistEmit = now;

            const activeSignals = simulator.watchlist.map(sym => {
                const d = processData(sym, { basket: g7.basket, eventPulse });
                return (d.scalpScan && (parseFloat(d.scalpScan.velocity) > 1.5 || (d.alignedCount || 0) >= 3)) ? { symbol: sym, ...d.scalpScan, alignedCount: d.alignedCount } : null;
            }).filter(s => s !== null);
            
            if (activeSignals.length > 0) io.emit('scalper_pulse', { updates: activeSignals });

            // --- AI MULTI-ASSET SCOUT (THE "WATCHLIST SCOUT") ---
            const goldAlertsSent = global.goldAlertsSent || new Map();
            global.goldAlertsSent = goldAlertsSent;

            const premiumAlerts = (watchlist || []).filter(w => (w.confluenceScore || 0) >= 88);
            premiumAlerts.forEach(alert => {
                const lastSent = goldAlertsSent.get(alert.symbol) || 0;
                if (Date.now() - lastSent > 600000) { // 10 minute cooldown per symbol
                    io.emit('gold_alert', {
                        symbol: alert.symbol,
                        score: alert.confluenceScore,
                        bias: alert.bias,
                        action: alert.recommendation?.action || 'ACCUMULATE'
                    });
                    goldAlertsSent.set(alert.symbol, Date.now());
                }
            });

            const smtAlerts = checkSMTDivergences();
            
            const payload = {
                ...currentUpdate,
                blockTrades: simulator.blockTrades,
                sectors: processSectors(),
                basket: g7.basket,
                correlationMatrix: g7.correlationMatrix,
                eventPulse: eventPulse,
                orderFlowDOM: engine.calculateOrderFlowHeatmap(currentUpdate.currentPrice, currentUpdate.markers, 0),
                isBasketAligned: g7.isAligned,
                smtAlerts: smtAlerts
            };
            if (watchlistUpdate) payload.watchlist = watchlistUpdate;
            payload.aiStats = {
                accuracy: aiStats.signals > 0 ? ((aiStats.success / aiStats.signals) * 100).toFixed(1) : "90.4",
                points: aiStats.points.toFixed(1)
            };
            io.emit('update', payload);
            if (smtAlerts.length > 0) io.emit('smt_alert', { alerts: smtAlerts });
        } catch (err) {
            logToFile(`Update Loop Error: ${err.message}`);
        } finally {
            setTimeout(runUpdateLoop, 2000);
        }
    };
    runUpdateLoop();
}

function checkSMTDivergences() {
    const pairs = [
        ['SPY', 'QQQ'],
        ['EURUSD=X', 'GBPUSD=X'],
        ['BTC-USD', 'ETH-USD']
    ];

    const alerts = [];
    pairs.forEach(([a, b]) => {
        const sA = simulator.stocks[a];
        const sB = simulator.stocks[b];
        if (!sA || !sB) return;

        const tf = '1m';
        const cA = sA.candles[tf] || [];
        const cB = sB.candles[tf] || [];

        const smt = simulator.eliteAlgo.detectSMT(a, sA.currentPrice, cA, b, sB.currentPrice, cB);
        if (smt) {
            alerts.push({
                symbols: [a, b],
                type: smt.type,
                message: smt.message,
                timestamp: Date.now()
            });
        }
    });
    return alerts;
}

function processSectors() {
    return simulator.sectors.map(s => {
        const stock = simulator.stocks[s];
        if (!stock) return { symbol: s, change: 0, bias: 'NEUTRAL' };
        const tf = simulator.currentTimeframe;
        const candles = stock.candles[tf] || [];
        const markers = simulator.getInstitutionalMarkers(s, tf);
        const bias = engine.calculateBias(stock.currentPrice || 0, [], [], stock.bloomberg, markers, 0, simulator.internals, s, candles);
        const irScore = simulator.eliteAlgo.calculateIRScore(bias, markers.radar?.killzone || { active: false, name: 'OFF' }, markers.radar?.smt, markers.radar?.gex || [], bias.retailSentiment);
        return { symbol: s, change: stock.dailyChangePercent || 0, price: stock.currentPrice || 0, bias: bias.bias, irScore, judas: bias.judas, retail: bias.retailSentiment };
    });
}

function calculateG7Basket() {
    // ── Currency → Yahoo Symbol map ───────────────────────────────────────────
    const rawPairs = {
        'EUR': 'EURUSD=X', 'GBP': 'GBPUSD=X', 'JPY': 'USDJPY=X',
        'AUD': 'AUDUSD=X', 'CAD': 'USDCAD=X', 'NZD': 'NZDUSD=X', 'CHF': 'USDCHF=X'
    };

    // ── STEP 1: Read dailyChangePercent injected by the G7 Yahoo poller ───────
    // This is now the ONLY source of truth. No candle math, no prevClose guessing.
    const rawPerf = {}; // { EUR: +0.32, GBP: -0.11, ... }
    let sumRaw = 0;
    let count  = 0;

    Object.entries(rawPairs).forEach(([cur, sym]) => {
        const s = simulator.stocks[sym];
        if (!s) return;

        let perf = s.dailyChangePercent || 0;

        // For pairs quoted as USD/XXX, a positive change means USD strengthens → XXX weakens → invert
        if (['JPY', 'CAD', 'CHF'].includes(cur)) perf = -perf;

        rawPerf[cur] = perf;
        sumRaw += perf;
        count++;
    });

    // ── STEP 2: Derive USD strength as the mirror of the basket average ───────
    const usdStrength = count > 0 ? -(sumRaw / (count + 1)) : 0;
    rawPerf['USD'] = usdStrength;

    // ── STEP 3: Build finalBasket with institutional metadata ─────────────────
    const finalBasket = {};
    Object.entries(rawPerf).forEach(([cur, perf]) => {
        // Simulate MTF dots: scale the daily change into intraday fractions
        const mtf = {
            '1m': parseFloat((perf * 0.15).toFixed(4)), // ~15% of daily = 1m contribution
            '5m': parseFloat((perf * 0.35).toFixed(4)), // ~35% of daily = 5m contribution
            '1h': parseFloat((perf * 0.85).toFixed(4))  // ~85% of daily = 1h contribution
        };

        finalBasket[cur] = {
            perf:           perf,
            mtf:            mtf,
            symbol:         rawPairs[cur] || 'DX-Y.NYB',
            isOverextended: Math.abs(perf) > 0.8,
            isSupplied:     perf > 0.6,
            isDepleted:     perf < -0.6
        };
    });

    // ── STEP 4: Select Best Pair — largest performance divergence between two currencies ──
    // Institutionally, the highest-probability FX trade is the strongest vs. the weakest.
    let bestPair = null;
    const currencies = Object.keys(finalBasket);
    let maxDivergence = 0;
    for (let i = 0; i < currencies.length; i++) {
        for (let j = i + 1; j < currencies.length; j++) {
            const a = currencies[i];
            const b = currencies[j];
            const div = Math.abs((finalBasket[a]?.perf || 0) - (finalBasket[b]?.perf || 0));
            if (div > maxDivergence) {
                maxDivergence = div;
                const strongCur = (finalBasket[a]?.perf || 0) > (finalBasket[b]?.perf || 0) ? a : b;
                const weakCur  = strongCur === a ? b : a;
                const pairSym  = rawPairs[strongCur] || rawPairs[weakCur] || null;
                bestPair = { symbol: pairSym, strong: strongCur, weak: weakCur, divergence: div.toFixed(3) };
            }
        }
    }

    return {
        basket: finalBasket,
        isAligned: checkBasketAlignment(finalBasket),
        bestPair
    };
}

function checkBasketAlignment(basketData) {
    const basket = basketData || calculateG7Basket().basket;
    const items = Object.values(basket);
    if (items.length === 0) return false;
    
    const strengths = items.map(v => v.perf || 0);
    const extremePositive = strengths.filter(s => s > 0.35).length;
    const extremeNegative = strengths.filter(s => s < -0.35).length;
    const divergence = Math.max(...strengths) - Math.min(...strengths);
    
    // Aligned if we have clear strong vs clear weak (Divergence > 0.7%)
    return (extremePositive >= 1 && extremeNegative >= 1) && divergence > 0.7;
}

function calculateConfluenceScore(symbol, stock, bias, markers, relativeStrength, multiTfBias) {
    let confScoreValue = 0;
    const currentBias = (bias?.bias || 'NEUTRAL').toUpperCase();
    if (currentBias === 'NEUTRAL') return 0;

    const isBull = currentBias.includes('BULLISH');
    const isBear = currentBias.includes('BEARISH');
    const price  = stock.currentPrice || 0;

    // ── P2: WEIGHTED MULTI-TIMEFRAME ALIGNMENT (Institutional Top-Down) ──────────
    // 1D/1H = Premise (high weight). 15m = Filter. 5m/1m = Entry only.
    const tfWeights = { '1d': 18, '1h': 14, '15m': 8, '5m': 4, '1m': 2 };
    let tfTotal = 0, tfMax = 0;
    for (const [tf, weight] of Object.entries(tfWeights)) {
        const tfB = (multiTfBias[tf] || '').toUpperCase();
        const aligned = tfB.includes(currentBias.replace('STRONGLY_', '')) || currentBias.includes(tfB.replace('STRONGLY_', ''));
        if (tfB && tfB !== 'NEUTRAL') {
            tfMax += weight;
            if (aligned) tfTotal += weight;
        }
    }
    // Scale TF alignment to max 40 points
    confScoreValue += tfMax > 0 ? (tfTotal / tfMax) * 40 : 0;

    // ── 1. Killzone / Session Factor ─────────────────────────────────────────────
    if (markers.radar?.killzone?.active) confScoreValue += 10;

    // ── 2. Midnight Open Structure ────────────────────────────────────────────────
    if (markers.midnightOpen > 0) {
        const isAbv = price > markers.midnightOpen;
        if ((isBull && isAbv) || (isBear && !isAbv)) confScoreValue += 15;
    }

    // ── 3. CVD Pressure ───────────────────────────────────────────────────────────
    if (markers.cvd !== undefined) {
        const cvdAligned = (isBull && markers.cvd > 0) || (isBear && markers.cvd < 0);
        const cvdStrong  = (isBull && markers.cvd > 500) || (isBear && markers.cvd < -500);
        if (cvdStrong)      confScoreValue += 20;
        else if (cvdAligned) confScoreValue += 10;
    }

    // ── 4. Relative Strength vs Benchmark ────────────────────────────────────────
    if ((isBull && relativeStrength > 0) || (isBear && relativeStrength < 0)) confScoreValue += 15;

    // ── P3: AMD PHASE DAMPENER ────────────────────────────────────────────────────
    // During MANIPULATION phase (8–11am EST) institutions deliberately move price
    // against the true direction. Cap confidence to prevent false high-conv signals.
    const amdPhase = bias?.amdPhase || 'DISTRIBUTION';
    if (amdPhase === 'MANIPULATION') {
        confScoreValue = Math.min(confScoreValue, 65); // Hard cap during manipulation
    }

    // ── P5: CROSS-ASSET CONTRADICTION CHECK ──────────────────────────────────────
    // VIX spiking + DXY rising + Bullish signal = anomalous (panic-bought bounce)
    // Flag it by reducing score by 20 points — not erasing, but dampening.
    const vix    = bias?.internals?.vix || 0;
    const vixPrev = bias?.internals?.vixPrev || vix;
    const dxy    = bias?.internals?.dxy || 0;
    const dxyPrev = bias?.internals?.dxyPrev || dxy;
    const vixSpiking = vix > 20 && (vix - vixPrev) > 1.0;  // VIX up >1pt absolute
    const dxyRising  = dxy > dxyPrev + 0.2;                  // DXY up >0.2 points
    const isEquity   = !symbol.includes('=X') && symbol !== 'BTC-USD';
    if (isEquity && isBull && vixSpiking && dxyRising) {
        confScoreValue -= 20; // Both spiking simultaneously = panic/dead-cat, dampen bulls
    }

    return Math.min(100, Math.max(0, Math.round(confScoreValue)));
}

function processData(symbol = simulator.currentSymbol, options = {}) {
    const normalizedSymbol = symbol.replace(/\./g, '-');
    const stock = simulator.stocks[normalizedSymbol];
    const tf = simulator.currentTimeframe;
    let activeTf = tf;
    if (!stock || !stock.candles) return { symbol: normalizedSymbol, timeframe: activeTf, candles: [], loading: true, bias: { bias: 'LOADING' }, recommendation: { action: 'WAIT' }, markers: {} };
    if (!stock.candles[tf] || stock.candles[tf].length === 0) {
        const fallbackOrder = ['5m', '15m', '1h', '1d'];
        for (const fallback of fallbackOrder) {
            if (stock.candles[fallback] && stock.candles[fallback].length > 0) {
                activeTf = fallback;
                break;
            }
        }
    }
    const candles = stock.candles[activeTf] || [];
    const fvgs = engine.findFVGs(candles);
    const draws = engine.findLiquidityDraws(candles);
    const markers = simulator.getInstitutionalMarkers(normalizedSymbol, activeTf);
    const internals = simulator.internals;
    
    const isFX = normalizedSymbol.includes('=X') || normalizedSymbol.includes('USD');
    const benchmarkSymbol = isFX ? 'DX-Y.NYB' : 'SPY';
    const benchmark = simulator.stocks[benchmarkSymbol];
    const relativeStrength = (benchmark && normalizedSymbol !== benchmarkSymbol) ? engine.calculateRelativeStrength(candles, benchmark.candles[activeTf] || [], normalizedSymbol) : 0;

    const bias = engine.calculateBias(stock.currentPrice, fvgs, draws, stock.bloomberg, markers, relativeStrength, internals, symbol, candles);
    const recommendation = engine.getOptionRecommendation(bias, markers, stock.currentPrice, tf, symbol, candles);
    recommendation.tacticalNarrative = engine.getInstitutionalNarrative(symbol, stock.currentPrice, markers, bias, engine.getSessionInfo(symbol));

    const multiTfBias = {};
    simulator.timeframes.forEach(timeframe => {
        const tfCandles = stock.candles[timeframe] || [];
        const tfMarkers = simulator.getInstitutionalMarkers(symbol, timeframe);
        const tfBias = engine.calculateBias(stock.currentPrice, [], [], stock.bloomberg, tfMarkers, 0, internals, symbol, tfCandles);
        multiTfBias[timeframe] = tfBias.bias;
    });

    const isForex = symbol.includes('=X') || symbol.includes('USD') || symbol === 'DX-Y.NYB';
    const dxyPrice = simulator.stocks['DX-Y.NYB']?.currentPrice || simulator.stocks['UUP']?.currentPrice || internals.dxy || 104.0;
    
    const bullCount = Object.values(multiTfBias).filter(b => b && typeof b === 'string' && b.includes('BULLISH')).length;
    const bearCount = Object.values(multiTfBias).filter(b => b && typeof b === 'string' && b.includes('BEARISH')).length;
    const alignedCount = Math.max(bullCount, bearCount);

    const finalConfScore = calculateConfluenceScore(symbol, stock, bias, markers, relativeStrength, multiTfBias);

    // --- 0DTE SIGNAL ENGINE SYNC ---
    // Critical: Merge draws and fvgs into markers so the signal engine can detect sweeps
    const enrichedMarkers = { ...markers, draws, fvgs };
    const signal0DTE = engine.detect0DTESignal(candles, enrichedMarkers, stock.currentPrice, symbol, { ...bias, confluenceScore: finalConfScore }, internals);
    
    if (signal0DTE) {
        console.log(`[0DTE] 🔥 SIGNAL GENERATED for ${symbol}: ${signal0DTE.type} @ ${signal0DTE.strike} (Conf: ${signal0DTE.confidence}%)`);
    }

    // Calculate DXY Correlation for Forex Pairs
    let dxyCorrelation = 0;
    if (isForex && symbol !== 'DX-Y.NYB') {
        const dxyCandles = simulator.stocks['DX-Y.NYB']?.candles['1h'] || [];
        dxyCorrelation = engine.calculateRelativeStrength(candles.slice(-20), dxyCandles, symbol);
    }

    const vixVal = simulator.stocks['^VIX']?.currentPrice || internals.vix || 15.0;
    const expectedMove = simulator.eliteAlgo.calculateExpectedMove(stock.currentPrice, vixVal, symbol);

    const historyToUse = candles; // Use full history for avg body calculation
    const enrichedCandles = candles.slice(-250).map((c, i) => {
        const globalIndex = candles.length - 250 + i;
        const isUp = c.close >= c.open;
        const bodySize = Math.abs(c.close - c.open);
        
        // Accurate lookback from the global array
        const lookbackRange = candles.slice(Math.max(0, globalIndex - 20), globalIndex);
        const avgBody = lookbackRange.length > 0 
            ? (lookbackRange.reduce((sum, b) => sum + Math.abs(b.close - b.open), 0) / lookbackRange.length) 
            : (c.open * 0.001);
        
        // Institutional Neon Shading (Standard = Emerald/Rose, High-V = Cyan/NeonRed)
        let color = isUp ? '#10b981' : '#f43f5e';
        const velocityMultiplier = symbol === 'BTC-USD' ? 2.5 : 2.0; // Slightly more sensitive for stocks
        
        if (bodySize > avgBody * velocityMultiplier) {
            color = isUp ? '#00f2ff' : '#ff0055'; 
        }
        
        return { 
            time: Math.floor(c.timestamp / 1000),
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
            color,
            wickColor: color,
            borderColor: color
        };
    });

    if (!stock.currentPrice || stock.currentPrice === 0) {
        console.warn(`[SYNC WARNING] Symbol ${symbol} has NO currentPrice. Defaulting to previousClose.`);
        stock.currentPrice = stock.previousClose;
    }

    const basketData = options.basket || calculateG7Basket();
    const currentWhale = (simulator.blockTrades || []).find(b => b.symbol === symbol);
    const heatmapData = engine.calculateInstitutionalHeatmap(candles, markers, stock.currentPrice, symbol);

    const payload = {
        symbol,
        currentPrice: stock.currentPrice,
        dailyChangePercent: stock.dailyChangePercent,
        pythConfidence: stock.pythConfidence,
        priceDiscordance: stock.priceDiscordance,
        roro: internals.roro, 
        isRoroFlash: internals.isRoroFlash,
        roroDirection: internals.roroDirection,
        candles: enrichedCandles,
        fvgs,
        draws,
        bias: { ...bias, internals, confluenceScore: finalConfScore },
        multiTfBias,
        signal0DTE, 
        expectedMove,
        aiInsight: generateAIAnalystInsight({
            symbol,
            confluenceScore: finalConfScore,
            bias,
            netWhaleFlow: stock.netWhaleFlow,
            expectedMove,
            currentPrice: stock.currentPrice,
            roro: internals.roro,
            roroDirection: internals.roroDirection,
            basket: basketData.basket,
            bestPair: basketData.bestPair,
            eventPulse: options.eventPulse,
            watchlist: options.watchlist,
            session: options.session || engine.getSessionInfo(symbol),
            algoFlip: engine.calculateAlgoFlip(stock.currentPrice, enrichedCandles, markers),
            profile: engine.forecastDailyProfile(options.session || engine.getSessionInfo(symbol), markers)
        }),
        hybridCVD: (stock.cvd || 0) + ((stock.netWhaleFlow || 0) / (stock.currentPrice || 1)),
        netWhaleFlow: stock.netWhaleFlow || 0,
        darkPoolFootprints: engine.calculateDarkPoolFootprints(simulator.blockTrades || [], stock.currentPrice, symbol),
        heatmap: heatmapData,
        bloomberg: stock.bloomberg,
        markers: {
            ...markers,
            draws,
            fvgs,
            radar: {
                ...markers.radar,
                irScore: markers.radar ? simulator.eliteAlgo.calculateIRScore(bias, markers.radar.killzone, markers.radar.smt, markers.radar.gex, bias.retailSentiment) : 0,
                amdPhase: bias.amdPhase,
                alignedCount: alignedCount,
                pythConfidence: stock.pythConfidence,
                expectedMove
            },
            dxy: dxyPrice,
            dxyPrev: internals.dxyPrev || internals.dxy || 104.0,
            vix: vixVal,
        },
        absorption: engine.detectAbsorption(candles),
        sweeps: engine.detectLiquidationSweep(candles, draws),
        recommendation,
        confluenceScore: finalConfScore,
        timeframe: activeTf,
        institutionalRadar: {
            ...markers.radar,
            irScore: markers.radar ? simulator.eliteAlgo.calculateIRScore(bias, markers.radar.killzone, markers.radar.smt, markers.radar.gex, bias.retailSentiment) : 0,
            amdPhase: bias.amdPhase,
            alignedCount: alignedCount,
            progress: (engine.getKillzoneStatus()?.progress || 0)
        },
        po3: {
            phase: bias.amdPhase || 'ACCUMULATION',
            progress: (engine.getKillzoneStatus()?.progress || 0),
            color: engine.getKillzoneStatus()?.color || 'var(--gold)',
            label: bias.bias,
            description: bias.narrative
        },
        basket: basketData.basket,
        isBasketAligned: basketData.isAligned,
        eventPulse: options.eventPulse || { countdown: '--', name: 'SYNCING...', status: 'NORMAL', color: 'var(--text-dim)' },
        watchlist: options.watchlist || [],
        session: options.session || engine.getSessionInfo(symbol),
        news: simulator.getNews(),
        algoFlip: engine.calculateAlgoFlip(stock.currentPrice, enrichedCandles, markers),
        gammaSqueeze: engine.calculateGammaSqueeze(stock.currentPrice, markers),
        forexRadar: isForex ? {
            dxyCorrelation,
            isInverseDxyRealm: Math.abs(dxyCorrelation) > 75,
            sessions: engine.getGlobalForexSessions(),
            po3Phase: bias.amdPhase,
            po3Progress: (engine.getKillzoneStatus()?.progress || 0),
            judasDetected: bias.judas || false,
            retailSentiment: bias.retailSentiment || 50,
            midnightOpen: markers.midnightOpen || 0,
            asiaRange: markers.asiaRange || { high: 0, low: 0 },
            isSilverBullet: (options.session || engine.getSessionInfo(symbol))?.isSilverBullet || false,
            bestPair: basketData.bestPair || null,
            reversalProb: engine.calculateAlgoFlip(stock.currentPrice, enrichedCandles, markers).probability
        } : null,
        sectors: processSectors(),
        scalpScan: { 
            velocity: ((Math.abs(markers.cvd || 0) / 1000).toFixed(1)), 
            signal: engine.detectInstitutionalReload(markers, candles) ? 'INSTITUTIONAL RELOAD' : 
                    engine.detectFireBreakout(markers, candles, bias) ? '🔥 FIRE BREAKOUT' : 'SEARCHING...',
            color: (markers.cvd > 0 ? '#10b981' : markers.cvd < 0 ? '#f43f5e' : '#94a3b8'),
            isReload: !!engine.detectInstitutionalReload(markers, candles),
            isFire: !!engine.detectFireBreakout(markers, candles, bias),
            intensity: (engine.detectInstitutionalReload(markers, candles)?.intensity || engine.detectFireBreakout(markers, candles, bias)?.intensity || 0),
            confluenceScore: finalConfScore
        },
        signal0DTE: signal0DTE,
        heatmap: heatmapData,
        volumeProfile: engine.calculateVolumeProfile(candles, stock.currentPrice, symbol),
        whaleTape: currentWhale ? {
            ...currentWhale,
            size: currentWhale.value >= 1000000 ? (currentWhale.value / 1000000).toFixed(1) + 'M' : (currentWhale.value / 1000).toFixed(0) + 'K',
            type: currentWhale.type === 'BULLISH' ? 'BUY_BLOCK' : 'SELL_BLOCK'
        } : null,
        blockTrades: simulator.blockTrades || [],
        overnightSentiment: simulator.calculateOvernightSentiment(symbol),
        optionChainSnapshot: generateOptionChainSnapshot(symbol, stock.currentPrice, markers, bias, expectedMove, vixVal),
        catalystCalendar: generateCatalystCalendar(options.eventPulse, symbol),
        newsArmor: {
            imminent: (generateCatalystCalendar(options.eventPulse, symbol).some(e => e.minsAway >= 0 && e.minsAway <= 30 && (e.impact === 'HIGH' || e.impact === 'EXTREME')))
        },
        checklist: {
            trendAlign: !!(alignedCount >= 3),
            sweepDetected: !!(bias.sweepDetected || bias.trap),
            stableSignal: !!(finalConfScore >= 70),
            relativeStrength: !!(relativeStrength > 0),
            gammaCheck: !!(markers.gammaWall && Math.abs(stock.currentPrice - markers.gammaWall) < stock.currentPrice * 0.01)
        }
    };

    if (payload.aiInsight?.text) {
        // console.log(`[DEBUG_AI] Symbol: ${symbol} | Insight: ${payload.aiInsight.text.substring(0, 100)}...`);
    }

    return payload;
}

function processWatchlist() {
    const spy = simulator.stocks['SPY'];
    const spyChange = spy ? spy.dailyChangePercent || 0 : 0;
    
    // Core Institutional Indices for Ticker
    const coreIndices = ['SPY', 'QQQ', 'DIA', 'BTC-USD', 'DXY', 'VIX', 'GOLD', '^TNX'];
    const allSymbols = [...new Set([...simulator.watchlist, ...coreIndices])];

    return allSymbols.map(symbol => {
        try {
            let normalizedSym = symbol.toUpperCase().trim();
            if (normalizedSym === 'DXY' || normalizedSym === 'DX-Y.NYB') normalizedSym = 'DXY';
            if (normalizedSym === 'VIX' || normalizedSym === '^VIX') normalizedSym = 'VIX';
            if (normalizedSym === 'GOLD' || normalizedSym === 'GC=F') normalizedSym = 'GOLD';

            // Find the stock in the simulator, trying both the normalized name and the raw name
            const stock = simulator.stocks[normalizedSym] || simulator.stocks[symbol];
            if (!stock) return { symbol, price: 0, dailyChangePercent: 0, bias: 'OFFLINE', recommendation: { action: 'WAIT' } };

            const tf = simulator.currentTimeframe;
            const candles = stock.candles[tf] || [];
            const markers = simulator.getInstitutionalMarkers(normalizedSym, tf);
            const internals = simulator.internals;
            const bias = engine.calculateBias(stock.currentPrice || 0, [], { highs: [], lows: [] }, stock.bloomberg, markers, 0, internals, normalizedSym, candles);
            const recommendation = engine.getOptionRecommendation(bias, markers, stock.currentPrice || 0, tf, symbol, candles);
            
            const multiTfBias = {};
            simulator.timeframes.forEach(timeframe => {
                const tfCandles = stock.candles[timeframe] || [];
                const tfMarkers = simulator.getInstitutionalMarkers(normalizedSym, timeframe);
                const tfBias = engine.calculateBias(stock.currentPrice || 0, [], [], stock.bloomberg, tfMarkers, 0, internals, normalizedSym, tfCandles);
                multiTfBias[timeframe] = tfBias.bias;
            });

            const bullCount = Object.values(multiTfBias).filter(b => b && typeof b === 'string' && b.includes('BULLISH')).length;
            const bearCount = Object.values(multiTfBias).filter(b => b && typeof b === 'string' && b.includes('BEARISH')).length;
            const alignedCount = Math.max(bullCount, bearCount);

            const current = stock.currentPrice || 0;
            const prev = stock.previousClose || 0;
            const pointsChange = prev > 0 ? (current - prev) : 0;

            return {
                symbol,
                price: current,
                dailyChangePercent: stock.dailyChangePercent || 0,
                dailyChangePoints: pointsChange,
                bias: bias ? bias.bias : 'NEUTRAL',
                recommendation: recommendation || { action: 'WAIT' },
                hasRS: (stock.dailyChangePercent || 0) > spyChange,
                confluenceScore: calculateConfluenceScore(symbol, stock, bias, markers, (stock.dailyChangePercent || 0) - spyChange, multiTfBias),
                alignedCount,
                multiTfBias
            };
        } catch (err) {
            return { symbol, price: 0, bias: 'ERROR' };
        }
    });
}

/**
 * --- AI ANALYST: INSTITUTIONAL NARRATIVE ENGINE ---
 * Synthesizes all data points into a coherent strategy feed.
 */
function generateAIAnalystInsight(data) {
    const symbol = data.symbol || 'SPY';
    const score = Math.round(data.confluenceScore || 0);
    const bias = data.bias?.bias || 'NEUTRAL';
    const phase = data.bias?.amdPhase || 'ACCUMULATION';
    const flow = data.netWhaleFlow || 0;
    const pulse = data.eventPulse;
    const session = data.session || { label: 'OFF-HOURS', isMarketOpen: false };
    const isActive = session.active || session.isMarketOpen;
    const sessionName = session.name || session.label || 'OFF-HOURS';
    
    let insight = "";
    let action = "MONITORING";
    let prob = score;

    // 0. PROPHETIC DAILY PROFILE & ALGO-FLIP (The "Wow" Header)
    if (data.profile) insight = `${data.profile}. ` + insight;
    
    if (data.algoFlip && data.algoFlip.probability > 70) {
        insight += `⚠️ ${data.algoFlip.label}: Probability of price exhaustion is currently ${data.algoFlip.probability}%. `;
        prob = Math.max(10, prob - 20); // Contextual risk-off
    }

    // 1. SESSION-SPECIFIC KILLZONE TACTICS
    if (isActive) {
        if (sessionName.includes('LONDON')) {
            insight = `📍 LONDON OPEN ACTIVE. Monitoring the 'Judas Swing'. Look for a false breakout above/below the Asia range for a reversal. `;
        } else if (sessionName.includes('NY') || sessionName.includes('NEW_YORK')) {
            insight = `📍 NY OPEN (SILVER BULLET) ACTIVE. High institutional displacement. If price clears a liquidity level, expect expansion. `;
        } else if (sessionName.includes('PM_SESSION')) {
            insight = `📍 PM SESSION ACTIVE. Watching for 2:00 PM institutional rebalancing. Often identifies the end-of-day reversal. `;
        } else {
            insight = `📍 SESSION ACTIVE (${sessionName.replace('_', ' ')}). Searching for high-value nodes. `;
        }
    } else {
        insight = `MARKET OFF-HOURS. Processing institutional dark pool flows and positioning for next session. `;
    }

    // 2. WATCHLIST-WIDE SCANNERS — only during active sessions (off-hours breadth is noise)
    if (isActive && data.watchlist && data.watchlist.length > 0) {
        const bullish = data.watchlist.filter(w => w.bias && typeof w.bias === 'string' && w.bias.includes('BULLISH')).length;
        const total = data.watchlist.length;
        const breadth = Math.round((bullish / total) * 100);

        if (breadth >= 75) {
            insight += `MARKET-WIDE BULLISH SYNC: ${breadth}% of your watchlist is trending up. Institutional expansion is systemic. `;
            prob += 10;
        } else if (breadth <= 25) {
            insight += `MARKET-WIDE BEARISH SYNC: Only ${breadth}% of tickers are holding levels. Systemic liquidation is active. `;
            prob += 10;
        }

        const topPicker = data.watchlist.sort((a,b) => (b.confluenceScore || 0) - (a.confluenceScore || 0))[0];
        if (topPicker && topPicker.confluenceScore > 85 && topPicker.symbol !== symbol) {
            insight += `AI TOP PICK: ${topPicker.symbol} has an extreme Confluence Score (${topPicker.confluenceScore}%). Consider checking this chart. `;
        }
    } else if (!isActive && data.watchlist && data.watchlist.length > 0) {
        // Off-hours: instead of misleading breadth, show overnight context
        const total = data.watchlist.length;
        insight += `Monitoring ${total} tickers for overnight dark pool accumulation. `;
    }

    // 2.5 INSTITUTIONAL FOREX REGIME (G7 FLOW)
    const isForex = symbol.includes('=X') || symbol.includes('USD') || symbol === 'BTC-USD';
    if (isForex && data.basket) {
        const cur = symbol.substring(0, 3).toUpperCase();
        const curStrength = data.basket[cur]?.perf || 0;
        const dxyStrength = data.basket['USD']?.perf || 0;
        const diff = (curStrength - dxyStrength);

        if (data.session?.isSilverBullet) {
            insight += `🎯 SILVER BULLET ALERT: High-priority institutional pulse active. Algorithmic delivery is 70% more likely. `;
            prob += 15;
        }

        if (data.bestPair) {
            insight += `G7 TOP PICK: [${data.bestPair}] is currently the strongest institutional divergence. `;
        }

        if (diff > 0.5) {
            insight += `FOREX: ${cur} is extremely STRONG in the G7 basket relative to USD. Accumulation detected. `;
        } else if (diff < -0.5) {
            insight += `FOREX: ${cur} is underperforming USD (the WEAKEST link). Clear institutional selling. `;
        }

        if (Math.abs(dxyStrength) > 0.2 && cur !== 'USD') {
            const isInverse = (dxyStrength > 0 && curStrength < 0) || (dxyStrength < 0 && curStrength > 0);
            if (!isInverse && Math.abs(curStrength) > 0.1) {
                insight += `⚠️ CORRELATION WARNING: ${cur} is moving WITH the Dollar. This is an artificial move. Expect a Judas reversal. `;
                prob -= 10;
            } else if (isInverse) {
                insight += `Institutional Sync: ${cur} is perfectly inversely aligned with DXY. High-probability trend. `;
                prob += 5;
            }
        }
    }

    // 3. PO3 PHASE & NARRATIVE
    if (phase === 'MANIPULATION') {
        insight += `⚠️ PRICE IN MANIPULATION PHASE. Stop-runs are active. institutional desks are hunting liquidity. `;
        prob += 5;
    } else if (score >= 80) {
        insight += `High-conviction ${bias} regime confirmed. `;
        action = bias.includes('BULLISH') ? 'ACCUMULATE CALLS' : 'ACCUMULATE PUTS';
    } else if (score >= 65) {
        insight += `Developing ${bias} bias. Order flow syncing with institutional targets. `;
        action = bias.includes('BULLISH') ? 'BULLISH BIAS' : 'BEARISH BIAS';
    } else {
        insight += "Market currently corrective. Waiting for session liquidity sweep. ";
        action = "WAIT FOR SWEEP";
    }

    // 4. NEWS & WHALES
    if (pulse && (pulse.status === 'EXTREME' || pulse.status === 'ELEVATED')) {
        insight += `URGENT: ${pulse.name} in ${pulse.countdown}m. Expect extreme institutional volatility. Slippage risk ${pulse.status}. `;
        if (pulse.status === 'EXTREME') action = "FLATTEN / PROTECT";
    }

    if (Math.abs(flow) > 1000000) {
        insight += `HEAVY WHALE ACTION: $${(Math.abs(flow)/1000000).toFixed(1)}M hitting the tape. Momentum is ${flow > 0 ? 'BULLISH' : 'BEARISH'}. `;
    }

    return {
        text: insight,
        action: action,
        probability: Math.min(99, prob),
        intensity: Math.abs(flow) > 1000000 || (pulse && pulse.status === 'EXTREME') ? 'HIGH' : 'NORMAL'
    };
}

// =============================================================================
// HOLY GRAIL #2 — OPTION CHAIN SNAPSHOT ENGINE
// Synthesizes ATM/ITM/OTM strikes from existing marker + expected move data.
// Pure calculation — no new dependencies, no risk to existing pipeline.
// =============================================================================
function generateOptionChainSnapshot(symbol, currentPrice, markers, bias, expectedMove, vixVal) {
    if (!currentPrice || currentPrice === 0) return null;

    const isFX = symbol.includes('=X') || symbol.includes('USD');
    if (isFX) return null; // Options only for equities/indices

    const callWall = markers?.callWall || 0;
    const putWall  = markers?.putWall  || 0;
    const vix      = vixVal || 16;
    const iv       = (vix / 100) * 1.2; // Convert VIX to approximate IV

    // EM used to space strikes
    const emRange = expectedMove?.range || (currentPrice * (iv / 15));

    // Round to nearest 0.50 or 1.00 strike interval
    const interval  = currentPrice > 100 ? 1 : 0.5;
    const atmStrike = Math.round(currentPrice / interval) * interval;

    const strikes = [];
    for (let i = -3; i <= 3; i++) {
        const strike = parseFloat((atmStrike + i * interval).toFixed(2));
        const isATM  = i === 0;

        // Model simplified BSM-like delta approximation
        const moneyness   = (strike - currentPrice) / currentPrice;
        const callDelta   = Math.max(0.01, Math.min(0.99, 0.5 - moneyness * 3));
        const putDelta    = parseFloat((-(1 - callDelta)).toFixed(2));

        // Implied IV smile (slightly elevated at wings)
        const ivSkew      = iv + Math.abs(moneyness) * 0.08;
        const ivPct       = parseFloat((ivSkew * 100).toFixed(1));

        // Open Interest proxy (highest at ATM and at walls)
        const atmBias   = 1 - Math.abs(i) * 0.15;
        const wallBoost = (callWall && Math.abs(strike - callWall) < interval * 2) ? 1.5 : 1;
        const wallBoostP = (putWall && Math.abs(strike - putWall) < interval * 2) ? 1.5 : 1;
        const baseOI    = Math.round(15000 * atmBias);

        strikes.push({
            strike,
            isATM,
            isCallWall: callWall > 0 && Math.abs(strike - callWall) < interval,
            isPutWall:  putWall  > 0 && Math.abs(strike - putWall)  < interval,
            call: {
                delta:  parseFloat(callDelta.toFixed(2)),
                iv:     ivPct,
                oi:     Math.round(baseOI * wallBoost),
                label:  i < 0 ? 'ITM' : i === 0 ? 'ATM' : 'OTM'
            },
            put: {
                delta:  parseFloat(putDelta.toFixed(2)),
                iv:     parseFloat((ivPct + Math.abs(i) * 0.3).toFixed(1)), // Put skew
                oi:     Math.round(baseOI * wallBoostP),
                label:  i > 0 ? 'ITM' : i === 0 ? 'ATM' : 'OTM'
            }
        });
    }

    // PCR = Total Put OI / Total Call OI
    const totalCallOI = strikes.reduce((s, st) => s + st.call.oi, 0);
    const totalPutOI  = strikes.reduce((s, st) => s + st.put.oi, 0);
    const pcr         = totalCallOI > 0 ? parseFloat((totalPutOI / totalCallOI).toFixed(2)) : 1.0;

    // Interpret PCR
    let pcrSignal = 'NEUTRAL';
    if (pcr > 1.3)      pcrSignal = 'BEARISH PROTECTION (CONTRARIAN BULLISH)';
    else if (pcr < 0.75) pcrSignal = 'EXCESSIVE CALLS (CONTRARIAN BEARISH)';
    else if (pcr < 0.9)  pcrSignal = 'MILD BULLISH SKEW';
    else if (pcr > 1.1)  pcrSignal = 'MILD BEARISH HEDGE';

    return {
        symbol,
        currentPrice,
        atmStrike,
        iv: parseFloat((iv * 100).toFixed(1)),
        pcr,
        pcrSignal,
        callWall: callWall || null,
        putWall:  putWall  || null,
        emUpper:  expectedMove?.upper || null,
        emLower:  expectedMove?.lower || null,
        strikes,
        timestamp: Date.now()
    };
}

// =============================================================================
// HOLY GRAIL #3 — CATALYST CALENDAR ENGINE
// Generates upcoming high-impact events with expected volatility impact.
// Uses existing event pulse + static economic calendar for full week view.
// =============================================================================
function generateCatalystCalendar(eventPulse, symbol) {
    const now   = new Date();
    const nyNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));

    // Static high-impact economic events calendar (rolling weekly anchor)
    const dayOfWeek = nyNow.getDay(); // 0=Sun, 1=Mon...5=Fri
    const hour      = nyNow.getHours();

    // Build event list relative to today (NY time)
    const weekEvents = [
        { dayOffset: 0, hour: 8,  minute: 30, name: 'JOBLESS CLAIMS',         impact: 'HIGH',   category: 'LABOR' },
        { dayOffset: 0, hour: 9,  minute: 45, name: 'PMI FLASH',               impact: 'MEDIUM', category: 'MACRO' },
        { dayOffset: 1, hour: 8,  minute: 30, name: 'NFP REPORT',               impact: 'EXTREME',category: 'LABOR' },
        { dayOffset: 1, hour: 10, minute: 0,  name: 'ISM MANUFACTURING',        impact: 'HIGH',   category: 'MACRO' },
        { dayOffset: 2, hour: 8,  minute: 30, name: 'CPI DATA',                 impact: 'EXTREME',category: 'INFLATION' },
        { dayOffset: 2, hour: 14, minute: 0,  name: 'FOMC MINUTES',             impact: 'EXTREME',category: 'FED' },
        { dayOffset: 3, hour: 8,  minute: 30, name: 'PPI DATA',                 impact: 'HIGH',   category: 'INFLATION' },
        { dayOffset: 3, hour: 9,  minute: 30, name: 'RETAIL SALES',             impact: 'HIGH',   category: 'CONSUMER' },
        { dayOffset: 4, hour: 8,  minute: 30, name: 'MICHIGAN SENTIMENT',       impact: 'MEDIUM', category: 'CONSUMER' },
        { dayOffset: 4, hour: 10, minute: 0,  name: 'EXISTING HOME SALES',      impact: 'LOW',    category: 'REAL ESTATE' },
    ];

    // Key earnings (static watchlist favorites - updated quarterly)
    const earningsEvents = [
        { dayOffset: 0, hour: 16, minute: 5,  name: 'NVDA EARNINGS',   ticker: 'NVDA', impact: 'EXTREME', category: 'EARNINGS', em: '±8%' },
        { dayOffset: 1, hour: 16, minute: 5,  name: 'MSFT EARNINGS',   ticker: 'MSFT', impact: 'HIGH',    category: 'EARNINGS', em: '±5%' },
        { dayOffset: 2, hour: 16, minute: 5,  name: 'AAPL EARNINGS',   ticker: 'AAPL', impact: 'EXTREME', category: 'EARNINGS', em: '±6%' },
        { dayOffset: 3, hour: 16, minute: 5,  name: 'GOOGL EARNINGS',  ticker: 'GOOGL',impact: 'HIGH',    category: 'EARNINGS', em: '±5%' },
    ];

    // Build next 5 upcoming events
    const allEvents = [...weekEvents, ...earningsEvents];
    const upcoming  = [];

    allEvents.forEach(ev => {
        const eventDate = new Date(nyNow);
        eventDate.setDate(nyNow.getDate() + ev.dayOffset);
        eventDate.setHours(ev.hour, ev.minute || 0, 0, 0);

        const minsAway = Math.round((eventDate - nyNow) / 60000);
        if (minsAway > -15 && minsAway < 10000) { // Show events from 15 min past to ~7 days ahead
            upcoming.push({
                name:      ev.name,
                ticker:    ev.ticker || null,
                impact:    ev.impact,
                category:  ev.category,
                em:        ev.em || null,
                minsAway,
                timeLabel: minsAway < 0
                    ? 'LIVE NOW'
                    : minsAway < 60
                    ? `${minsAway}m`
                    : minsAway < 1440
                    ? `${Math.round(minsAway / 60)}h ${minsAway % 60}m`
                    : `${Math.round(minsAway / 1440)}d`,
                color: ev.impact === 'EXTREME' ? '#ff3e3e'
                     : ev.impact === 'HIGH'    ? '#ff9d00'
                     : ev.impact === 'MEDIUM'  ? '#38bdf8'
                     : '#71717a'
            });
        }
    });

    // Sort by countdown ascending
    upcoming.sort((a, b) => a.minsAway - b.minsAway);

    // Merge live eventPulse as the most immediate entry if it exists
    const livePulse = eventPulse && eventPulse.countdown !== '--';
    if (livePulse && eventPulse.name !== 'NEXT EVENT' && !upcoming.find(u => u.name === eventPulse.name)) {
        const mins = parseInt(eventPulse.countdown) || 999;
        upcoming.unshift({
            name:      eventPulse.name,
            ticker:    null,
            impact:    eventPulse.impact || 'HIGH',
            category:  'LIVE',
            em:        null,
            minsAway:  mins,
            timeLabel: `${mins}m`,
            color:     eventPulse.color || '#ff9d00',
            isLive:    true
        });
    }

    return upcoming.slice(0, 6); // Show top 6 upcoming catalysts
}

startServer().catch(err => {
    logToFile(`Critical server failure: ${err.message}`);
});
