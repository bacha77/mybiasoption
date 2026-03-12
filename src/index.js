import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import { LiquidityEngine } from './logic/liquidity-engine.js';
import { RealDataManager } from './services/real-data-manager.js';
import { telegram } from './services/telegram-service.js';
import { simTrader } from './services/simulation-trader.js';
import fs from 'fs';

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

async function startServer() {
    console.log("Starting BIAS Strategy Server...");
    await simulator.initialize();
    console.log(`[INIT] Watchlist loaded with ${simulator.watchlist.length} symbols.`);

    // Whale Alert Integration
    simulator.onBlockCallback = (block) => {
        if (block.isElite) {
            telegram.sendWhaleAlert(block.symbol, block.price, block.value, block.type).catch(() => { });
            io.emit('whale_alert', block);
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

    app.get('/api/trades', (req, res) => {
        res.json(simTrader.tradeHistory.slice(-10).reverse());
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
            simBalance: simTrader.balance,
            activeTrades: Array.from(simTrader.activePositions.values()),
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
                    simBalance: simTrader.balance,
                    activeTrades: Array.from(simTrader.activePositions.values()),
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
                    simBalance: simTrader.balance,
                    activeTrades: Array.from(simTrader.activePositions.values()),
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
                    if (!lastAlerts.has(alertKey)) {
                        telegram.sendEngineConfluenceAlert(engineName, direction, symbols).catch(() => { });
                        lastAlerts.set(alertKey, Date.now());
                    }
                }
            });

            // Telegram Alert Logic - Check all symbols in watchlist
            simulator.watchlist.forEach(symbol => {
                const stockData = processData(symbol);
                const rec = stockData.recommendation;
                
                const nyTime = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
                const nyHour = nyTime.getHours();
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
                        // 60 minute cooldown for the same wall
                        if (isAlertWindow && (!lastTime || (Date.now() - lastTime > 3600000))) {
                            console.log(`[TAG] ${symbol} hit ${t.name} at ${price}`);
                            telegram.sendWallAlert(symbol, price, t.name, t.val, t.type).catch(() => {});
                            lastAlerts.set(alertKey, Date.now());
                        }
                    });
                }

                // --- SILVER BULLET SESSION ALERT ---
                if (stockData.session && (stockData.session.session === 'SILVER_BULLET' || stockData.session.session === 'LONDON_BULLET')) {
                    const sbKey = `SB_ALERT_${symbol}_${new Date().getHours()}`;
                    if (isAlertWindow && !lastAlerts.has(sbKey)) {
                        const isCall = rec && rec.action.includes('CALL');
                        const isPut = rec && rec.action.includes('PUT');
                        if (isCall || isPut) {
                            console.log(`[SB] ${symbol} Silver Bullet Entry Detected!`);
                            telegram.sendSignalAlert(symbol, stockData.bias.bias, stockData.currentPrice, rec.action, "🚀 SILVER BULLET ALGO ENTRY: Expansion window is active. Follow institutional volume.", rec.strike, rec.trim, rec.target, rec.sl, "1h", stockData.session.session).catch(() => {});
                            lastAlerts.set(sbKey, Date.now());
                        }
                    }
                }

                // --- VOLATILITY SQUEEZE ALERT ---
                if (stockData.bias && stockData.bias.squeeze && stockData.bias.squeeze.status === 'SQUEEZING') {
                    const squeezeKey = `SQUEEZE_${symbol}_${new Date().getHours()}`;
                    if (isAlertWindow && !lastAlerts.has(squeezeKey) && stockData.bias.squeeze.intensity > 0.6) {
                        console.log(`[SQUEEZE] ${symbol} is coiling... Intensity: ${stockData.bias.squeeze.intensity}`);
                        telegram.sendSqueezeAlert(symbol, stockData.bias.squeeze.intensity).catch(() => {});
                        lastAlerts.set(squeezeKey, Date.now());
                    }
                }

                // --- SMT DIVERGENCE ALERTS ---
                if (stockData && stockData.markers && stockData.markers.smt) {
                    const smt = stockData.markers.smt;
                    const smtKey = `${symbol}_SMT_${smt.type}_${new Date().getHours()}`;
                    if (isAlertWindow && !lastAlerts.has(smtKey)) {
                        console.log(`[SMT] ${symbol} vs ${smt.symbol} | ${smt.type} Divergence!`);
                        telegram.sendSmtAlert(symbol, smt.symbol, smt.type, smt.message).catch(() => {});
                        lastAlerts.set(smtKey, Date.now());
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
                // 2. High Confidence (80+)
                // 3. MASTER HEALTH SCORE (The 85%+ threshold)
                // 4. Macro & Matrix Agreement
                const isGoldStandard = stockData && !stockData.loading && rec && rec.isStable &&
                    stockData.checklist?.trendAlign && (rec.confidence >= 80) &&
                    (stockData.confluenceScore >= 85) && // MUST have 85%+ Health Matrix alignment
                    macroAligned && matrixAgreement;

                if (isGoldStandard && rec.action !== 'WAIT') {
                    const symbolKey = `${symbol}_LAST_ACTION`;
                    const lastActionData = lastAlerts.get(symbolKey); // { action, time }

                    console.log(`--- [PRIME] SIGNAL DETECTED: ${symbol} ${rec.action} (Confidence: ${rec.confidence}) ---`);

                    let canSend = false;
                    if (!lastActionData) {
                        canSend = true;
                    } else {
                        const timeSinceLast = Date.now() - lastActionData.time;
                        const isOpposite = (lastActionData.action.includes('CALL') && rec.action.includes('PUT')) ||
                            (lastActionData.action.includes('PUT') && rec.action.includes('CALL'));

                        // Block opposite signals for 2 hours (Prevent Flip-Flopping)
                        if (isOpposite && timeSinceLast < 7200000) {
                            console.log(`[${symbol}] Alert Blocked: Direction flip cooldown (Wait 2h).`);
                            canSend = false;
                        }
                        // Block same-direction signals for 2 hours (Professional Frequency)
                        else if (!isOpposite && timeSinceLast < 7200000) {
                            console.log(`[${symbol}] Alert Blocked: Cooldown period (Wait 2h).`);
                            canSend = false;
                        }
                        else {
                            canSend = true;
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
                if (rec && rec.action !== 'WAIT' && rec.isStable) {
                    simTrader.processSignal(symbol, rec, stockData.currentPrice).catch(() => { });
                }

                // --- NEW: HIGH CONFLUENCE ALERT (Whale Detector) ---
                const check = stockData.checklist || {};
                const activeCriteria = [];
                if (check.trendAlign) activeCriteria.push("1m/5m/15m Trend Alignment");
                if (check.sweepDetected) activeCriteria.push("Institutional Liquidity Sweep");
                if (check.stableSignal) activeCriteria.push("Stable Signal (Time-Based)");
                if (check.relativeStrength) activeCriteria.push("Relative Strength High");
                if (check.gammaCheck) activeCriteria.push("Gamma Wall / Price Magnet Confluence");

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
            });

            // Update all sim positions based on newest prices
            await simTrader.updatePositions(simulator.stocks).catch(() => { });

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

            console.log(`[EMIT] Sending update. Watchlist symbols: ${watchlistUpdate.length}`);
            io.emit('update', {
                ...currentUpdate,
                watchlist: watchlistUpdate,
                simBalance: simTrader.balance,
                activeTrades: Array.from(simTrader.activePositions.values()),
                blockTrades: simulator.blockTrades,
                sectors: simulator.sectors.map(s => ({
                    symbol: s,
                    change: simulator.stocks[s]?.dailyChangePercent || 0
                }))
            });
        } catch (err) {
            console.error("Update Loop Error:", err.message);
        } finally {
            setTimeout(runUpdateLoop, 5000);
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
    httpServer.listen(PORT, () => {
        console.log(`BIAS Strategy Server running at http://localhost:${PORT}`);
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
    const markers = simulator.getInstitutionalMarkers(symbol, activeTf);

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

    // --- Master Global Confluence Score Calculation ---
    // Alignment Points:
    // 1. Bias vs Multi-TF Bias (40 pts)
    // 2. Midnight Open Confluence (20 pts)
    // 3. CVD & Volume Confirmation (20 pts)
    // 4. Relative Strength Alignment (20 pts)
    let confScoreValue = 0;
    if (bias.bias !== 'NEUTRAL') {
        // TF Alignment check (Strong alignment if all TFs match)
        const tfs = ['1m', '5m', '15m'];
        const matchCount = tfs.filter(t => multiTfBias[t] === bias.bias).length;
        confScoreValue += (matchCount / tfs.length) * 40;

        // Midnight Open Alignment
        if (markers.midnightOpen > 0) {
            const isAbv = stock.currentPrice > markers.midnightOpen;
            if ((bias.bias === 'BULLISH' && isAbv) || (bias.bias === 'BEARISH' && !isAbv)) {
                confScoreValue += 20;
            }
        }

        // CVD / Volume Confirmation
        if (markers.cvd !== undefined) {
            if ((bias.bias === 'BULLISH' && markers.cvd > 0) || (bias.bias === 'BEARISH' && markers.cvd < 0)) {
                confScoreValue += 20;
            }
        }

        // Relative Strength vs SPY (Market Leadership)
        if ((bias.bias === 'BULLISH' && relativeStrength > 0) || (bias.bias === 'BEARISH' && relativeStrength < 0)) {
            confScoreValue += 20;
        }
    }
    const finalConfScore = Math.round(confScoreValue);

    return {
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
        }
    };
}

function processWatchlist() {
    console.log(`[WATCHLIST] Processing ${simulator.watchlist.length} symbols...`);
    const spy = simulator.stocks['SPY'];
    const spyChange = spy ? spy.dailyChangePercent : 0;

    return simulator.watchlist.map(symbol => {
        try {
            const stock = simulator.stocks[symbol];
            if (!stock) {
                return { symbol, price: 0, bias: 'OFFLINE', recommendation: { action: 'WAIT' } };
            }

            const tf = simulator.currentTimeframe;
            const candles = stock.candles[tf] || [];
            const markers = simulator.getInstitutionalMarkers(symbol, tf);
            const internals = simulator.internals;
            const bloomberg = stock.bloomberg || { omon: 'NEUTRAL' };
            const bias = engine.calculateBias(stock.currentPrice || 0, [], { highs: [], lows: [] }, bloomberg, markers, 0, internals, symbol, candles);
            const recommendation = engine.getOptionRecommendation(bias, markers, stock.currentPrice || 0, tf, symbol, candles);
            const hasRS = (stock.dailyChangePercent || 0) > spyChange;

            // Simple Score for Watchlist
            let score = 0;
            if (bias.bias !== 'NEUTRAL') {
                if (markers.midnightOpen > 0) {
                    const isAbv = stock.currentPrice > markers.midnightOpen;
                    if ((bias.bias === 'BULLISH' && isAbv) || (bias.bias === 'BEARISH' && !isAbv)) score += 25;
                }
                if (markers.cvd !== undefined) {
                    if ((bias.bias === 'BULLISH' && markers.cvd > 0) || (bias.bias === 'BEARISH' && markers.cvd < 0)) score += 25;
                }
                if (recommendation.isStable) score += 25;
                if ((bias.bias === 'BULLISH' && hasRS) || (bias.bias === 'BEARISH' && !hasRS)) score += 25;
            }

            return {
                symbol,
                price: stock.currentPrice || 0,
                dailyChangePercent: stock.dailyChangePercent || 0,
                bias: bias ? bias.bias : 'NEUTRAL',
                omon: bloomberg.omon || 'NEUTRAL',
                recommendation: recommendation || { action: 'WAIT' },
                hasRS: hasRS,
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
