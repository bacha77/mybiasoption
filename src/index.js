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

const logFile = path.join(process.cwd(), 'system.log');
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
    const msg = `Uncaught Exception: ${err.message}\n${err.stack}`;
    console.error(msg);
    logToFile(msg);
    process.exit(1);
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

const engine = new LiquidityEngine();
const simulator = new RealDataManager();
const lastAlerts = new Map();
let globalLastAlertTime = 0;

// Helper to prevent Telegram flooding (Max 1 alert per 60s globally)
function canSendGlobal(isPriority = false) {
    const now = Date.now();
    // Non-priority signals (Walls, Squeezes) are blocked if a priority signal just fired
    if (!isPriority && (now - globalLastAlertTime < 120000)) return false; // 2 min wait for soft alerts
    if (isPriority && (now - globalLastAlertTime < 60000)) return false; // 1 min wait for hard signals
    return true;
}

async function startServer() {
    console.log("Starting BIAS Strategy Server...");
    await simulator.initialize();
    
    // Start News Service
    const newsService = new NewsService(io);
    newsService.start();

    console.log(`[INIT] Watchlist loaded with ${simulator.watchlist.length} symbols.`);

    // --- INSTITUTIONAL SIGNAL GUARD: Anti-Spam Logic ---
    simulator.onBlockCallback = (block) => {
        if (block.isElite) {
            const whaleKey = `WHALE_${block.symbol}`;
            const lastWhale = lastAlerts.get(whaleKey) || 0;
            const cooldown = 900000; // 15 Minute Cooldown per symbol for Whale Spikes

            // Only fire Telegram if > $5M AND cooldown passed (Extreme Noise Reduction)
            if (block.value >= 5000000 && (Date.now() - lastWhale > 1800000) && canSendGlobal()) {
                telegram.sendWhaleAlert(block.symbol, block.price, block.value, block.type).catch(() => { });
                lastAlerts.set(whaleKey, Date.now());
                globalLastAlertTime = Date.now();
            }
            
            // Still emit to Dashboard in real-time (No cooldown for HUD)
            io.emit('whale_alert', block);
        }
    };

    simulator.onPriceUpdateCallback = (symbol, price, change, candles) => {
        // Emit high-frequency update for the dashboard's focused symbol
        if (symbol === simulator.currentSymbol) {
            const latestCandle = candles[simulator.currentTimeframe]?.slice(-1)[0];
            io.emit('price_update', {
                symbol,
                price,
                change,
                candle: latestCandle,
                // Include partial radar/bias updates if they can be calculated quickly
                // For now, just the price for maximum speed
            });
        }
    };

    // Serve static dashboard
    app.use(express.static(path.join(__dirname, '../public')));
    app.use(express.json());

    // Dynamic symbol management API
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

    // PayPal Webhook Receiver
    app.post('/api/paypal/webhook', async (req, res) => {
        try {
            const event = req.body;
            console.log("[PAYPAL WEBHOOK] Received event:", event.event_type);
            
            // Example logic for updating the user profile when subscription is active
            if (event.event_type === 'BILLING.SUBSCRIPTION.ACTIVATED') {
                const sub = event.resource;
                const custom_id = sub.custom_id; // In PayPal button, pass custom_id: session.user.id
                
                if (custom_id) {
                    const { createClient } = await import('@supabase/supabase-js');
                    const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY); // Or Service Role Key
                    
                    await supabaseAdmin.from('profiles').update({
                        subscription_status: 'active',
                        tier: 'elite', // Map this based on plan_id
                        paypal_sub_id: sub.id
                    }).eq('id', custom_id);
                    console.log(`[PAYPAL] Subscription active for User ${custom_id}`);
                }
            }
            res.status(200).send('Webhook handled');
        } catch (err) {
            console.error("[PAYPAL ERROR] Error processing webhook:", err);
            res.status(500).send('Webhook error');
        }
    });

    app.get('/debug-state', (req, res) => {
        res.json({
            internals: simulator.internals,
            sectors: simulator.sectors.map(s => ({
                symbol: s,
                price: simulator.stocks[s]?.currentPrice,
                prev: simulator.stocks[s]?.previousClose,
                change: simulator.stocks[s]?.dailyChangePercent
            })),
            vix_stock: simulator.stocks['^VIX'],
            dxy_stock: simulator.stocks['UUP']
        });
    });

    // SSE / WebSocket updates
    io.on('connection', (socket) => {
        console.log('Client connected to BIAS dashboard');

        const initialData = processData();
        socket.emit('init', {
            ...initialData,
            watchlist: processWatchlist(),
            blockTrades: simulator.blockTrades,
            blockTrades: simulator.blockTrades,
            sectors: simulator.sectors.map(s => ({
                symbol: s,
                change: simulator.stocks[s]?.dailyChangePercent || 0
            }))
        });

        socket.on('switch_timeframe', (tf) => {
            if (simulator.timeframes.includes(tf)) {
                simulator.currentTimeframe = tf;
                const update = processData();
                const wl = processWatchlist();
                socket.emit('tf_updated', {
                    ...update,
                    watchlist: wl,
                    blockTrades: simulator.blockTrades,
                    blockTrades: simulator.blockTrades,
                    sectors: simulator.sectors.map(s => ({
                        symbol: s,
                        change: simulator.stocks[s]?.dailyChangePercent || 0
                    }))
                });
                console.log(`[SOCKET] Emitted tf_updated to client for timeframe ${tf}. Watchlist size: ${wl.length}`);
            }
        });

        socket.on('switch_symbol', async (symbol) => {
            try {
                symbol = symbol.toUpperCase().trim();
                
                // Normalization for common search formats to Yahoo-friendly ones
                if (symbol === 'BTCUSD') symbol = 'BTC-USD';
                if (symbol === 'ETHUSD') symbol = 'ETH-USD';
                if (symbol === 'EURUSD') symbol = 'EURUSD=X';
                if (symbol === 'GBPUSD') symbol = 'GBPUSD=X';
                if (symbol === 'USDJPY') symbol = 'USDJPY=X';
                if (symbol === 'DXY' || symbol === 'DX-Y') symbol = 'DX-Y.NYB';

                console.log(`[SOCKET] switch_symbol normalized to: ${symbol}`);
                
                // Update internal symbol tracker
                simulator.currentSymbol = symbol;

                // Ensure data exists for this symbol
                if (!simulator.stocks[symbol]) {
                    console.log(`[SEARCH] Symbol ${symbol} not in system. Fetching quote...`);
                    await simulator.addSymbol(symbol);
                }

                // CRITICAL: Force history refresh for the new symbol on-demand
                await simulator.refreshHistoricalData(symbol);
                
                const update = processData();
                const wl = processWatchlist();

                socket.emit('symbol_updated', {
                    ...update,
                    watchlist: wl,
                    blockTrades: simulator.blockTrades,
                    blockTrades: simulator.blockTrades,
                    sectors: simulator.sectors.map(s => ({
                        symbol: s,
                        change: simulator.stocks[s]?.dailyChangePercent || 0
                    }))
                });
                console.log(`[SOCKET] Sent symbol_updated for ${symbol}.`);
            } catch (err) {
                console.error(`[SEARCH ERROR] Failed to switch to ${symbol}:`, err.message);
            }
        });

        socket.on('ping_latency', (callback) => {
            if (typeof callback === 'function') callback();
        });
    });

    // Safe recursive update loop (Prevents overlapping execution)
    const runUpdateLoop = async () => {
        try {
            await simulator.updateAll();
            const currentUpdate = processData();
            const watchlistUpdate = processWatchlist();

            // High-performance NY Time calculation
            const nyFormatter = new Intl.DateTimeFormat('en-US', {
                timeZone: 'America/New_York',
                hour: 'numeric',
                hour12: false
            });
            const nyHour = parseInt(nyFormatter.format(new Date()));

            // Heartbeat log
            console.log(`[${new Date().toLocaleTimeString()}] Pulse: Check ${simulator.watchlist.length} symbols. SPY Price: $${simulator.stocks['SPY']?.currentPrice || 'N/A'}`);

            // --- INSTITUTIONAL HEALTH MATRIX ENGINE MONITORING ---
            const engineDefs = {
                'SPY_ENGINE': ['XLK', 'XLY', 'XLF'],
                'QQQ_ENGINE': ['XLK', 'XLC', 'SMH', 'AMD'],
                'IWM_ENGINE': ['KRE', 'XBI', 'IYT'],
                'FX_ENGINE': ['UUP', 'EURUSD=X', 'GBPUSD=X', 'USDJPY=X', '^TNX']
            };

            Object.entries(engineDefs).forEach(([engineName, symbols]) => {
                const statuses = symbols.map(s => {
                    const price = simulator.stocks[s]?.currentPrice || 0;
                    const prev = simulator.stocks[s]?.previousClose || 0;
                    const change = prev > 0 ? (price - prev) / prev * 100 : 0;
                    // Strict threshold: 0.1% for matrix alignment
                    return change > 0.1 ? 'BULLISH' : change < -0.1 ? 'BEARISH' : 'NEUTRAL';
                });

                const allBullish = statuses.every(s => s === 'BULLISH');
                const allBearish = statuses.every(s => s === 'BEARISH');

                if (allBullish || allBearish) {
                    const direction = allBullish ? 'BULLISH' : 'BEARISH';
                    const alertKey = `${engineName}_MATRIX_${direction}_${new Date().getHours()}`;
                    // Squelch engine confluence alerts (Only once per 6 hours)
                    const lastEngine = lastAlerts.get(alertKey) || 0;
                    if (!lastAlerts.has(alertKey) && (Date.now() - lastEngine > 21600000) && canSendGlobal()) {
                        telegram.sendEngineConfluenceAlert(engineName, direction, symbols).catch(() => { });
                        lastAlerts.set(alertKey, Date.now());
                        globalLastAlertTime = Date.now();
                    }
                }
            });

            // Telegram Alert Logic - Check all symbols in watchlist
            simulator.watchlist.forEach(symbol => {
                const stockData = processData(symbol);
                const rec = stockData.recommendation;
                
                const isFX = symbol.includes('=X') || symbol.includes('USD');
                const isAlertWindow = isFX || (nyHour >= 6 && nyHour < 20);

                if (rec) {
                    if (rec.action !== 'WAIT') {
                        console.log(`[${symbol}] ACTION: ${rec.action} | Stable: ${rec.isStable} | Bias: ${stockData.bias.score}`);
                    } else {
                        // Periodic debug for first few symbols to see why they WAIT
                        // if (symbol === 'SPY' || symbol === 'NVDA') {
                        //     const m = stockData.markers;
                        //     console.log(`[DEBUG ${symbol}] Price: ${stockData.currentPrice} | VWAP: ${m.vwap.toFixed(2)} | POC: ${m.poc.toFixed(2)} | Rationale: ${rec.rationale}`);
                        // }
                    }
                }

                // --- WALL & STDEV PROXIMITY ALERTS ---
                if (stockData && stockData.markers && stockData.currentPrice) {
                    const price = stockData.currentPrice;
                    const m = stockData.markers;
                    const isFX = symbol.includes('=X') || symbol.includes('USD');
                    const thresh = isFX ? 0.0003 : (price > 100 ? 0.20 : 0.05); // 20 cents for large equities, 5 for small, 3 pips for FX
                    
                    const triggers = [];
                    if (m.callWall && Math.abs(price - m.callWall) <= thresh) triggers.push({ name: 'Current CALL WALL (Ceiling)', val: m.callWall, type: 'BEARISH' });
                    if (m.putWall && Math.abs(price - m.putWall) <= thresh) triggers.push({ name: 'Current PUT WALL (Floor)', val: m.putWall, type: 'BULLISH' });
                    if (m.vwapStdev > 0) {
                        const upStdev = m.vwap + (m.vwapStdev * 2);
                        const dnStdev = m.vwap - (m.vwapStdev * 2);
                        if (Math.abs(price - upStdev) <= thresh) triggers.push({ name: '+2 VWAP STDEV (Overbought)', val: upStdev, type: 'BEARISH' });
                        if (Math.abs(price - dnStdev) <= thresh) triggers.push({ name: '-2 VWAP STDEV (Oversold)', val: dnStdev, type: 'BULLISH' });
                    }

                    triggers.forEach(t => {
                        const alertKey = `${symbol}_WALL_${t.name}`;
                        const lastTime = lastAlerts.get(alertKey);
                        // 8 Hour cooldown for the same wall level (Aggressive de-clutter)
                        if (isAlertWindow && (!lastTime || (Date.now() - lastTime > 28800000)) && canSendGlobal()) {
                            console.log(`[TAG] ${symbol} hit ${t.name} at ${price}`);
                            telegram.sendWallAlert(symbol, price, t.name, t.val, t.type).catch(() => {});
                            lastAlerts.set(alertKey, Date.now());
                            globalLastAlertTime = Date.now();
                        }
                    });
                }

                // --- SILVER BULLET SESSION ALERT ---
                if (stockData.session && (stockData.session.session === 'SILVER_BULLET' || stockData.session.session === 'LONDON_BULLET')) {
                    const sbKey = `SB_ALERT_${symbol}_${new Date().getHours()}`;
                    if (isAlertWindow && !lastAlerts.has(sbKey) && canSendGlobal(true)) {
                        const isCall = rec && rec.action.includes('CALL');
                        const isPut = rec && rec.action.includes('PUT');
                        if (isCall || isPut) {
                            console.log(`[SB] ${symbol} Silver Bullet Entry Detected!`);
                            telegram.sendSignalAlert(symbol, stockData.bias.bias, stockData.currentPrice, rec.action, "🚀 SILVER BULLET ALGO ENTRY: Expansion window is active. Follow institutional volume.", rec.strike, rec.trim, rec.target, rec.sl, "1h", stockData.session.session).catch(() => {});
                            lastAlerts.set(sbKey, Date.now());
                            globalLastAlertTime = Date.now();
                        }
                    }
                }

                // --- VOLATILITY SQUEEZE ALERT (DE-PRIORITIZED) ---
                if (stockData.bias && stockData.bias.squeeze && stockData.bias.squeeze.status === 'SQUEEZING') {
                    const squeezeKey = `SQUEEZE_${symbol}_${new Date().getHours()}`;
                    // Intensity must be > 0.85 and only once per day per symbol for squeals
                    if (isAlertWindow && !lastAlerts.has(squeezeKey) && stockData.bias.squeeze.intensity > 0.85 && canSendGlobal()) { 
                        console.log(`[SQUEEZE] ${symbol} is coiling... Intensity: ${stockData.bias.squeeze.intensity}`);
                        telegram.sendSqueezeAlert(symbol, stockData.bias.squeeze.intensity).catch(() => {});
                        lastAlerts.set(squeezeKey, Date.now());
                        globalLastAlertTime = Date.now();
                    }
                }

                // --- SMT DIVERGENCE ALERTS ---
                if (stockData && stockData.markers && stockData.markers.smt) {
                    const smt = stockData.markers.smt;
                    const smtKey = `${symbol}_SMT_${smt.type}_${new Date().getHours()}`;
                    // SMT cooldown increased to 8 hours
                    const lastSmt = lastAlerts.get(smtKey) || 0;
                    if (isAlertWindow && (Date.now() - lastSmt > 28800000) && canSendGlobal()) { 
                        console.log(`[SMT] ${symbol} vs ${smt.symbol} | ${smt.type} Divergence!`);
                        telegram.sendSmtAlert(symbol, smt.symbol, smt.type, smt.message).catch(() => {});
                        lastAlerts.set(smtKey, Date.now());
                        globalLastAlertTime = Date.now();
                    }
                }

                // --- TELEGRAM ALERT LOGIC (GOLD STANDARD FILTER) ---
                // Requirement for Sellable Signals:
                // 1. Stable Signal (40+ seconds of consistent confluence)
                // 2. Trend Alignment (1m, 5m, 15m agreeing)
                // 3. High Confidence Score (80+)
                // 4. HOLY GRAIL: Macro Internals Aligned (DXY/VIX)

                const internals = simulator.internals;
                const dxyPrev = simulator.stocks['UUP']?.previousClose || 0;
                const isCall = rec && rec.action.includes('CALL');
                const isPut = rec && rec.action.includes('PUT');

                // Macro Filter:
                // Calls: VIX < 22 and DXY not soaring
                // Puts: VIX > 15 and DXY not crashing
                const macroAligned = isCall ? (internals.vix < 22 && internals.dxy <= dxyPrev * 1.002) :
                    isPut ? (internals.vix > 15 && internals.dxy >= dxyPrev * 0.998) : false;

                const sectors = simulator.sectors.map(s => ({
                    symbol: s,
                    change: simulator.stocks[s]?.dailyChangePercent || 0
                }));
                const techSector = sectors.find(s => s.symbol === 'XLK')?.change || 0;
                const techHeavy = ['SPY', 'QQQ', 'NVDA', 'AAPL', 'MSFT', 'AMD', 'SMH'];

                // --- INSTITUTIONAL HEALTH MATRIX AGREEMENT ---
                // We only signal if the specific sub-sectors for the ticker are aligned
                const smhSector = sectors.find(s => s.symbol === 'SMH')?.change || 0;
                const semiStock = ['NVDA', 'AMD', 'MU', 'TSM', 'ASML', 'AVGO'];

                let matrixAgreement = true;
                if (techHeavy.includes(symbol)) {
                    // Tech/Semis: XLK must be in trend and SMH must be aligned if it's a chip stock
                    const techAligned = isCall ? techSector > 0.1 : isPut ? techSector < -0.1 : true;
                    const semiAligned = semiStock.includes(symbol) ? (isCall ? smhSector > 0.1 : isPut ? smhSector < -0.1 : true) : true;
                    matrixAgreement = techAligned && semiAligned;
                }

                // The Golden Filter: 
                // 1. All standard confluence (Stable + Trend)
                // 2. High Confidence (90+)
                // 3. MASTER HEALTH SCORE (The 92%+ threshold)
                // 4. Macro & Matrix Agreement
                const isGoldStandard = stockData && !stockData.loading && rec && rec.isStable &&
                    stockData.checklist?.trendAlign && (rec.confidence >= 90) &&
                    (stockData.confluenceScore >= 92) && // Extreme threshold for professional alerts
                    macroAligned && matrixAgreement;

                if (isGoldStandard && rec.action !== 'WAIT') {
                    const symbolKey = `${symbol}_LAST_ACTION`;
                    const lastActionData = lastAlerts.get(symbolKey); // { action, time }

                    console.log(`--- [PRIME] SIGNAL DETECTED: ${symbol} ${rec.action} (Confidence: ${rec.confidence}) ---`);

                    let canSend = false;
                    if (!lastActionData) {
                        canSend = canSendGlobal(true);
                    } else {
                        const timeSinceLast = Date.now() - lastActionData.time;
                        const isOpposite = (lastActionData.action.includes('CALL') && rec.action.includes('PUT')) ||
                            (lastActionData.action.includes('PUT') && rec.action.includes('CALL'));

                        // Block opposite signals for 4 hours (Prevent Flip-Flopping)
                        if (isOpposite && timeSinceLast < 14400000) {
                            console.log(`[${symbol}] Alert Blocked: Direction flip cooldown (Wait 4h).`);
                            canSend = false;
                        }
                        // Block same-direction signals for 4 hours (Professional Frequency)
                        else if (!isOpposite && timeSinceLast < 14400000) {
                            console.log(`[${symbol}] Alert Blocked: Cooldown period (Wait 4h).`);
                            canSend = false;
                        }
                        else {
                            canSend = canSendGlobal(true);
                        }
                    }

                    if (canSend && isAlertWindow) {
                        console.log(`[${symbol}] >>> FIRING PREMIUM TELEGRAM ALERT: ${rec.action} (Acc: ${rec.confidence}%) <<<`);
                        telegram.sendSignalAlert(
                            symbol,
                            stockData.bias.bias,
                            stockData.currentPrice,
                            rec.action,
                            rec.rationale,
                            rec.strike,
                            rec.trim,
                            rec.target,
                            rec.sl,
                            rec.duration,
                            rec.session
                        ).catch(() => { });
                        lastAlerts.set(symbolKey, { action: rec.action, time: Date.now() });
                        globalLastAlertTime = Date.now();
                    }
                } else if (rec && rec.action !== 'WAIT') {
                    // LOG why we didn't send
                    if (symbol === 'SPY' || symbol === 'NVDA') {
                        console.log(`[DEBUG ${symbol}] Potential signal bypassed: Stable=${rec.isStable} | TrendAlign=${stockData.checklist?.trendAlign} | Conf=${rec.confidence}`);
                    }
                }

                // Exit Alert Logic
                if (rec && rec.exit) {
                    const exitKey = `${symbol}_EXIT_${rec.exit.action}_${Math.floor(Date.now() / 3600000)}`;
                    if (isAlertWindow && !lastAlerts.has(exitKey)) {
                        console.log(`--- EXIT DETECTED: ${symbol} ${rec.exit.action} ---`);
                        telegram.sendExitAlert(symbol, rec.exit).catch(() => { });
                        lastAlerts.set(exitKey, Date.now());
                    }
                }

                // --- EXPERT UPGRADE: SIMULATED PAPER TRADING ---

                // --- HIGH CONFLUENCE ALERT (Whale Detector) - SILENCED TO REDUCE NOISE ---
                /*
                if (activeCriteria.length >= 5) {
                    const confluenceKey = `${symbol}_CONFLUENCE_ALERT`;
                    const lastAlertTime = lastAlerts.get(confluenceKey) || 0;

                    if (isAlertWindow && (Date.now() - lastAlertTime > 7200000)) { // 2 Hour cooldown per symbol
                        console.log(`[${symbol}] >>> FIRING HIGH CONFLUENCE ALERT: ${activeCriteria.length}/5 Indicators <<<`);
                        telegram.sendConfluenceAlert(
                            symbol,
                            stockData.currentPrice,
                            stockData.bias.bias,
                            activeCriteria.length,
                            5,
                            activeCriteria
                        ).catch(() => { });
                        lastAlerts.set(confluenceKey, Date.now());
                    }
                }
                */
            });


            // --- MACRO PULSE MONITORING (VIX Velocity & RORO Shift) ---
            const vix = simulator.internals.vix;
            const vixPrev = simulator.internals.vixPrev;
            const roro = engine.calculateRORO(simulator.internals, 'SPY');
            
            // RORO Shift Alert
            const roroKey = `RORO_SHIFT_${roro.label}`;
            if ((nyHour >= 6 && nyHour < 20) && !lastAlerts.has(roroKey)) {
                console.log(`[RORO] Macro sentiment shifted to ${roro.label}`);
                telegram.sendRoroAlert(roro).catch(() => {});
                lastAlerts.set(roroKey, Date.now());
                // Clear other RORO keys to allow switching back
                ['HEAVY RISK-ON', 'RISK-ON', 'NEUTRAL', 'RISK-OFF', 'HEAVY RISK-OFF'].forEach(l => {
                    if (l !== roro.label) lastAlerts.delete(`RORO_SHIFT_${l}`);
                });
            }

            if (vix > 0 && vixPrev > 0) {
                const velocity = (vix - vixPrev) / vixPrev;
                if ((nyHour >= 6 && nyHour < 20) && velocity > 0.03) { // 3% spike in a single pulse
                    const alertKey = `VIX_SPIKE_${Math.floor(Date.now() / 3600000)}`;
                    if (!lastAlerts.has(alertKey)) {
                        telegram.sendMacroAlert('VIX VOLATILITY SPIKE', `VIX jumped ${(velocity * 100).toFixed(1)}% rapidly. Institutional risk-off in effect.`, 'HIGH').catch(() => {});
                        lastAlerts.set(alertKey, Date.now());
                    }
                }
            }

            // --- MIDNIGHT OPEN REPORT (DAILY AT 00:00 EST) ---
            const now = new Date();
            const nyTime = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
            const dateStr = nyTime.toDateString();
            const hour = nyTime.getHours();

            if (lastAlerts.get('MIDNIGHT_REPORT') !== dateStr) {
                console.log(`[${new Date().toLocaleTimeString()}] 🟢 Triggering Midnight Open Report for ${dateStr}...`);
                const reportData = simulator.watchlist.map(symbol => {
                    const m = simulator.getInstitutionalMarkers(symbol);
                    if (m.midnightOpen === 0) return null;

                    // Simple Bias Prediction:
                    // If Midnight Open is above the midpoint of previous day's range, we lean Bullish.
                    const midpoint = (m.pdh + m.pdl) / 2;
                    let bias = 'NEUTRAL';
                    if (m.midnightOpen > midpoint) bias = 'BULLISH';
                    if (m.midnightOpen < midpoint) bias = 'BEARISH';

                    // Extra weight: If we are already above PDH, very bullish.
                    if (m.midnightOpen > m.pdh) bias = 'STRONG_BULLISH';
                    if (m.midnightOpen < m.pdl) bias = 'STRONG_BEARISH';

                    return {
                        symbol,
                        midnightOpen: m.midnightOpen,
                        pdh: m.pdh,
                        pdl: m.pdl,
                        bias
                    };
                }).filter(i => i !== null);

                if (reportData.length > 0) {
                    await telegram.sendMidnightOpenReport(reportData).catch(err => {
                        console.error("❌ Failed to send Midnight Report:", err.message);
                    });
                    lastAlerts.set('MIDNIGHT_REPORT', dateStr);
                }
            }

            io.emit('update', {
                ...currentUpdate,
                watchlist: watchlistUpdate,
                blockTrades: simulator.blockTrades,
                sectors: processSectors()
            });
        } catch (err) {
            console.error("Update Loop Error:", err.message);
        } finally {
            setTimeout(runUpdateLoop, 2000);
        }
    };

    runUpdateLoop();

    // Full refresh loop
    setInterval(async () => {
        console.log("Performing full data refresh...");
        for (const symbol of simulator.watchlist) {
            await simulator.refreshHistoricalData(symbol);
        }
    }, 300000);

    const PORT = process.env.PORT || 3000;
    httpServer.listen(PORT, '0.0.0.0', () => {
        console.log(`BIAS Strategy Server running at http://0.0.0.0:${PORT}`);
        logToFile(`Server started on port ${PORT}`);
    }).on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            const msg = `[CRITICAL] Port ${PORT} is already in use. Please close any other BIAS windows or other apps using this port.`;
            console.error(msg);
            logToFile(msg);
            // On Windows, the batch pause will catch this if we don't exit too fast
            setTimeout(() => process.exit(1), 5000);
        } else {
            console.error("Server error:", err.message);
            logToFile(`Server error: ${err.message}`);
        }
    });
}

function processSectors() {
    return simulator.sectors.map(s => {
        const stock = simulator.stocks[s];
        if (!stock) return { symbol: s, change: 0, bias: 'NEUTRAL' };
        
        const tf = simulator.currentTimeframe;
        const candles = stock.candles[tf] || [];
        const markers = simulator.getInstitutionalMarkers(s, tf);
        const bias = engine.calculateBias(stock.currentPrice || 0, [], [], stock.bloomberg, markers, 0, simulator.internals, s, candles);
        
        return {
            symbol: s,
            change: stock.dailyChangePercent || 0,
            price: stock.currentPrice || 0,
            bias: bias.bias
        };
    });
}

function calculateConfluenceScore(symbol, stock, bias, markers, relativeStrength, multiTfBias) {
    let confScoreValue = 0;
    if (bias && bias.bias !== 'NEUTRAL') {
        // 1. TF Alignment check (40 pts)
        const tfs = ['1m', '5m', '15m'];
        const matchCount = tfs.filter(t => multiTfBias[t] === bias.bias).length;
        confScoreValue += (matchCount / tfs.length) * 40;

        // 2. Midnight Open Alignment (20 pts)
        if (markers.midnightOpen > 0) {
            const isAbv = stock.currentPrice > markers.midnightOpen;
            if ((bias.bias === 'BULLISH' && isAbv) || (bias.bias === 'BEARISH' && !isAbv)) {
                confScoreValue += 20;
            }
        }

        // 3. CVD / Volume Confirmation (20 pts)
        if (markers.cvd !== undefined) {
            if ((bias.bias === 'BULLISH' && markers.cvd > 0) || (bias.bias === 'BEARISH' && markers.cvd < 0)) {
                confScoreValue += 20;
            }
        }

        // 4. Relative Strength vs SPY (20 pts)
        if ((bias.bias === 'BULLISH' && relativeStrength > 0) || (bias.bias === 'BEARISH' && relativeStrength < 0)) {
            confScoreValue += 20;
        }
    }
    return Math.round(confScoreValue);
}

function processData(symbol = simulator.currentSymbol) {
    // Normalize Yahoo symbols (e.g., BRK.B -> BRK-B)
    const normalizedSymbol = symbol.replace(/\./g, '-');

    const stock = simulator.stocks[normalizedSymbol];
    const tf = simulator.currentTimeframe;

    // Safety check: ensure stock exists and has candles for current timeframe
    // If 1m is empty (weekend/holiday), fall back to the next available timeframe
    let activeTf = tf;
    if (!stock || !stock.candles) {
        console.warn(`[${normalizedSymbol}] No stock data or candles found. Loading: true.`);
        return { symbol: normalizedSymbol, timeframe: activeTf, candles: [], loading: true, bias: { bias: 'LOADING' }, recommendation: { action: 'WAIT' }, markers: {} };
    }
    if (!stock.candles[tf] || stock.candles[tf].length === 0) {
        const fallbackOrder = ['5m', '15m', '1h', '1d'];
        for (const fallback of fallbackOrder) {
            if (stock.candles[fallback] && stock.candles[fallback].length > 0) {
                activeTf = fallback;
                console.log(`[${normalizedSymbol}] No ${tf} candles available. Falling back to ${fallback}.`);
                break;
            }
        }
        if (activeTf === tf || !stock.candles[activeTf] || stock.candles[activeTf].length === 0) {
            return { symbol, timeframe: activeTf, candles: [], loading: true, bias: { bias: 'LOADING' }, recommendation: { action: 'WAIT' }, markers: {} };
        }
    }

    const candles = stock.candles[activeTf];
    const fvgs = engine.findFVGs(candles);
    const draws = engine.findLiquidityDraws(candles);
    const bloomberg = stock.bloomberg;
    const markers = simulator.getInstitutionalMarkers(normalizedSymbol, activeTf);

    // Calculate Relative Strength vs SPY
    const spy = simulator.stocks['SPY'];
    const relativeStrength = (spy && symbol !== 'SPY') ?
        engine.calculateRelativeStrength(candles, spy.candles[activeTf] || spy.candles['5m'] || []) : 0;

    const internals = simulator.internals;
    const bias = engine.calculateBias(stock.currentPrice, fvgs, draws, bloomberg, markers, relativeStrength, internals, symbol, candles);
    const heatmap = simulator.generateHeatmapData(draws);

    const absorption = engine.detectAbsorption(candles);
    const sweeps = engine.detectLiquidationSweep(candles, draws);
    const recommendation = engine.getOptionRecommendation(bias, markers, stock.currentPrice, tf, symbol, candles);
    recommendation.tacticalNarrative = engine.getInstitutionalNarrative(symbol, stock.currentPrice, markers, bias, session);

    const multiTfBias = {};
    simulator.timeframes.forEach(timeframe => {
        const tfCandles = stock.candles[timeframe];
        if (tfCandles && tfCandles.length > 0) {
            const tfDraws = engine.findLiquidityDraws(tfCandles);
            const tfFvgs = engine.findFVGs(tfCandles);
            const tfMarkers = simulator.getInstitutionalMarkers(symbol, timeframe);
            const tfBias = engine.calculateBias(stock.currentPrice, tfFvgs, tfDraws, bloomberg, tfMarkers, 0, internals, symbol, tfCandles);
            multiTfBias[timeframe] = tfBias.bias;
        } else {
            multiTfBias[timeframe] = 'NEUTRAL';
        }
    });

    const gammaWalls = engine.getGammaWalls(stock.currentPrice, symbol);
    const gammaCheck = gammaWalls.some(w => Math.abs(stock.currentPrice - w) / stock.currentPrice < 0.001);
    const sweepDetected = sweeps.length > 0;
    const stableSignal = recommendation.isStable;
    const rsCheck = relativeStrength > 0.05;

    const finalConfScore = calculateConfluenceScore(symbol, stock, bias, markers, relativeStrength, multiTfBias);

    if (markers.radar) {
        markers.radar.irScore = simulator.eliteAlgo.calculateIRScore(
            bias, 
            markers.radar.killzone, 
            markers.radar.smt, 
            markers.radar.gex
        );
        console.log(`[DEBUG] Radar for ${symbol}: Score=${markers.radar.irScore}`);
    }

    const finalData = {
        symbol,
        currentPrice: stock.currentPrice,
        dailyChangePercent: stock.dailyChangePercent,
        candles: candles.slice(-200),
        fvgs,
        draws,
        bias,
        heatmap,
        bloomberg,
        markers: {
            ...markers,
            dxy: simulator.stocks['DX-Y.NYB']?.currentPrice || internals.dxy || 0,
            vix: simulator.stocks['^VIX']?.currentPrice || internals.vix || 0,
        },
        absorption,
        sweeps,
        recommendation,
        confluenceScore: finalConfScore,
        timeframe: activeTf,
        multiTfBias,
        news: simulator.getNews(),
        session: engine.getSessionInfo(symbol),
        checklist: {
            trendAlign: (multiTfBias['1h'] === multiTfBias['15m']) && (multiTfBias['15m'] === multiTfBias['5m']) && (multiTfBias['5m'] === multiTfBias['1m']) && multiTfBias['1m'] !== 'NEUTRAL',
            sweepDetected,
            stableSignal,
            relativeStrength: rsCheck,
            gammaCheck,
            confluenceScore: finalConfScore
        },
        forexRadar: (symbol.includes('=X') || symbol.includes('USD') || symbol.includes('EUR') || symbol.includes('GBP') || symbol.includes('JPY') || symbol.includes('BTC-USD')) ? {
            dxyCorr: engine.calculateCorrelation(candles, simulator.stocks['DX-Y.NYB']?.candles[activeTf] || []),
            eurGbpCorr: engine.calculateCorrelation(simulator.stocks['EURUSD=X']?.candles[activeTf] || [], simulator.stocks['GBPUSD=X']?.candles[activeTf] || []),
            isInverseDxy: (engine.calculateCorrelation(candles, simulator.stocks['DX-Y.NYB']?.candles[activeTf] || []) < -80),
            smt: markers.radar?.smt,
            session: engine.getMarketSession(symbol),
            globalSessions: engine.getGlobalForexSessions(),
            midnightOpen: markers.midnightOpen
        } : null,
        institutionalRadar: markers.radar
    };

    return finalData;
}

function processWatchlist() {
    console.log(`[WATCHLIST] Processing ${simulator.watchlist.length} symbols...`);
    const spy = simulator.stocks['SPY'];
    const spyChange = spy ? spy.dailyChangePercent : 0;

    return simulator.watchlist.map(symbol => {
        try {
            // Apply Yahoo normalization (same as in switch_symbol)
            let normalizedSym = symbol.toUpperCase().trim();
            if (normalizedSym === 'BTCUSD') normalizedSym = 'BTC-USD';
            if (normalizedSym === 'ETHUSD') normalizedSym = 'ETH-USD';
            if (normalizedSym === 'EURUSD') normalizedSym = 'EURUSD=X';
            if (normalizedSym === 'GBPUSD') normalizedSym = 'GBPUSD=X';
            if (normalizedSym === 'USDJPY') normalizedSym = 'USDJPY=X';
            if (normalizedSym === 'DXY' || normalizedSym === 'DX-Y') normalizedSym = 'DX-Y.NYB';

            const stock = simulator.stocks[normalizedSym];
            if (!stock) {
                return { symbol, price: 0, bias: 'OFFLINE', recommendation: { action: 'WAIT' } };
            }

            const tf = simulator.currentTimeframe;
            const candles = stock.candles[tf] || [];
            const markers = simulator.getInstitutionalMarkers(normalizedSym, tf);
            const internals = simulator.internals;
            const bloomberg = stock.bloomberg || { omon: 'NEUTRAL' };
            const bias = engine.calculateBias(stock.currentPrice || 0, [], { highs: [], lows: [] }, bloomberg, markers, 0, internals, symbol, candles);
            const recommendation = engine.getOptionRecommendation(bias, markers, stock.currentPrice || 0, tf, symbol, candles);
            const hasRS = (stock.dailyChangePercent || 0) > spyChange;

            const multiTfBias = {};
            simulator.timeframes.forEach(timeframe => {
                const tfCandles = stock.candles[timeframe] || [];
                const tfMarkers = simulator.getInstitutionalMarkers(normalizedSym, timeframe);
                const tfBias = engine.calculateBias(stock.currentPrice || 0, [], [], bloomberg, tfMarkers, 0, internals, symbol, tfCandles);
                multiTfBias[timeframe] = tfBias.bias;
            });

            const score = calculateConfluenceScore(symbol, stock, bias, markers, (stock.dailyChangePercent || 0) - spyChange, multiTfBias);

            return {
                symbol,
                price: stock.currentPrice || 0,
                dailyChangePercent: stock.dailyChangePercent || 0,
                bias: bias ? bias.bias : 'NEUTRAL',
                omon: bloomberg.omon || 'NEUTRAL',
                recommendation: recommendation || { action: 'WAIT' },
                hasRS: (stock.dailyChangePercent || 0) > spyChange,
                confluenceScore: score
            };
        } catch (err) {
            console.error(`[WATCHLIST] Error processing ${symbol}:`, err.message);
            return { symbol, price: 0, bias: 'ERROR' };
        }
    });
}

startServer().catch(err => {
    console.error("Critical server failure:", err);
});
