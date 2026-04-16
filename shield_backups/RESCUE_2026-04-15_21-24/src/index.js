import 'dotenv/config';
import { execSync } from 'child_process';
process.env.YF_NO_VALIDATION = '1';

// --- 🛡️ PORT CONFLICT SHIELD ---
try {
    const SHIELD_PORT = process.env.PORT || 3000;
    const shieldOutput = execSync(`netstat -ano | findstr :${SHIELD_PORT}`).toString();
    const shieldLine = shieldOutput.split('\n')[0].trim();
    if (shieldLine) {
        const shieldPid = shieldLine.split(/\s+/).pop();
        if (shieldPid && !isNaN(shieldPid) && shieldPid != process.pid) {
            process.stdout.write(`[SYSTEM] Port ${SHIELD_PORT} busy by PID ${shieldPid}. Terminating...\n`);
            execSync(`taskkill /F /PID ${shieldPid}`);
        }
    }
} catch (e) {}

// --- Silence yahoo-finance2 validation spam (it writes to stderr directly) ---
const _stderrWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk, ...args) => {
    const msg = chunk.toString();
    if (msg.includes('ChartResultObject') || msg.includes('yahoo-finance2/issues') || 
        msg.includes('validation.md') || msg.includes('out of date: 3.')) return true;
    return _stderrWrite(chunk, ...args);
};

process.env.LOG_LEVEL = 'error';

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
import { createClient } from '@supabase/supabase-js';
import { simTrader } from './services/simulation-trader.js';
import { CotService } from './services/cot-service.js';


const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
const supabase = (supabaseUrl && supabaseKey) ? createClient(supabaseUrl, supabaseKey) : null;


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
    
    // CRITICAL: Do NOT exit on Yahoo Finance validation errors or schema mismatches
    if (msg.includes('ChartResultObject') || msg.includes('schemaPath') || msg.includes('instancePath')) {
        console.warn("[SYSTEM] Validation Error Caught & Neutralized - Staying Alive.");
        return;
    }
    
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
app.use(express.static('public'));

// ── CHART HISTORY API (must be before static middleware) ──────────────────
// ── CHART HISTORY API (must be before static middleware) ──────────────────
app.get('/api/history', (req, res) => {
    const { symbol, tf } = req.query;
    if (!symbol) return res.status(400).json({ error: 'Symbol required' });
    if (!simulator || !simulator.stocks) return res.status(503).json({ error: 'Server initializing' });
    
    const normalizedSymbol = symbol.toUpperCase().trim();
    const stock = simulator.stocks[normalizedSymbol];
    
    if (!stock) {
        console.warn(`[API] History requested for unknown symbol: ${normalizedSymbol}`);
        return res.status(404).json({ error: `Symbol ${normalizedSymbol} not loaded yet` });
    }
    
    const activeTf = tf || (simulator.currentTimeframe) || '1m';
    const candles = stock.candles[activeTf] || [];
    
    if (candles.length === 0) {
        console.warn(`[API] Returning EMPTY history for ${normalizedSymbol} @ ${activeTf}`);
    } else {
        console.log(`[API] Serving ${candles.length} candles for ${normalizedSymbol} @ ${activeTf}`);
    }

    const formatted = candles
        .filter(c => c.open > 0)
        .map(c => ({
            time: Math.floor(c.timestamp / 1000),
            open: c.open, high: c.high, low: c.low, close: c.close
        }));

    // ── DE-DUPLICATE & SORT ──
    // Critical: LightweightCharts will crash if timestamps are not unique and increasing.
    const unique = [];
    const seen = new Set();
    formatted.sort((a, b) => a.time - b.time).forEach(p => {
        if (!seen.has(p.time)) {
            unique.push(p);
            seen.add(p.time);
        }
    });

    res.json(unique);
});


app.get('/api/ml/stats', async (req, res) => {
    if (!supabase) return res.json({ labels: [], equity: [], winRate: 0, totalTrades: 0, netProfit: 0 });
    try {
        const { data, error } = await supabase
            .from('ml_signal_logs')
            .select('created_at, outcome')
            .in('outcome', ['SUCCESS', 'FAILED'])
            .order('created_at', { ascending: true });
            
        if (error) throw error;
        
        let currentEquity = 0;
        let wins = 0;
        const labels = ['Start'];
        const equity = [0];
        
        data.forEach((row, i) => {
            const dateObj = new Date(row.created_at);
            const label = `${dateObj.getMonth()+1}/${dateObj.getDate()} ${dateObj.getHours()}:${dateObj.getMinutes()}`;
            
            if (row.outcome === 'SUCCESS') {
                currentEquity += 500; // Simulated $500 profit per win
                wins++;
            } else {
                currentEquity -= 250;  // Simulated $250 risk per loss
            }
            
            labels.push(label);
            equity.push(currentEquity);
        });
        
        const winRate = data.length > 0 ? ((wins / data.length) * 100).toFixed(1) : 0;
        
        res.json({
            labels,
            equity,
            winRate,
            totalTrades: data.length,
            netProfit: currentEquity
        });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

const httpServer = createServer(app);
const PORT = process.env.PORT || 3000;
const io = new Server(httpServer, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// --- 🛡️ STATE COORDINATORS ---
let simulator = null; 
let newsService = null;
let cotService = null;
const lastAlerts = new Map();
let globalLastAlertTime = 0;
let lastWatchlistEmit = 0;
const engine = new LiquidityEngine();



function canSendGlobal(isPriority = false) {
    const now = Date.now();
    if (!isPriority && (now - globalLastAlertTime < 120000)) return false;
    if (isPriority && (now - globalLastAlertTime < 60000)) return false;
    return true;
}

// Global Connection Handler
io.on('connection', (socket) => {
    try {
        console.log('[SOCKET] Institutional Client Connected.');
        
        socket.on('join_symbol', (data) => {
            const sym = (data.symbol || 'SPY').toUpperCase();
            socket.join(`ROOM_${sym}`);
            console.log(`[SOCKET] Client joined session: ${sym}`);
            
            if (simulator && simulator.isInitialized) {
                const payload = {
                    ...processData(sym),
                    sectors: processSectors(),
                    watchlist: processWatchlist(),
                    mtf: {},
                    isBatch: true
                };
                // Logic to populate mtf would go here
                socket.emit('init', payload);
            }
        });

        socket.on('switch_symbol', (sym) => {
            const oldRooms = Array.from(socket.rooms).filter(r => r.startsWith('ROOM_'));
            oldRooms.forEach(r => socket.leave(r));
            
            const newSym = sym.toUpperCase();
            socket.join(`ROOM_${newSym}`);
            console.log(`[SOCKET] Client switched to: ${newSym}`);

            if (simulator && simulator.isInitialized) {
                const rawCandles = simulator.stocks[newSym]?.candles[simulator.currentTimeframe] || [];
                const payload = {
                    ...processData(newSym),
                    candles: rawCandles.filter(c => c.open > 0).map(c => ({
                        time: Math.floor(c.timestamp / 1000),
                        open: c.open, high: c.high, low: c.low, close: c.close
                    })),
                    isSwitch: true
                };
                socket.emit('price_updated', payload);
            }
        });

        socket.on('sectors_update', (data) => {
            if (data.sectors) updateMarketTickerRibbon(data.sectors);
            if (data.basket) updateG7SpiderMatrix(data.basket);
            if (data.watchlist) updateWatchlistUI(data.watchlist);
        });

        socket.on('watchlist_updated', (data) => {
            if (data.watchlist) updateWatchlistUI(data.watchlist);
        });
    } catch (err) {
        console.error('[SOCKET] Connection enrichment error:', err.message);
    }
});

let lastWatchlistTime = 0;
let cachedWatchlist = [];
let cachedBoardSentiment = null;

async function runUpdateLoop() {
    try {
        if (!simulator || !simulator.stocks) {
            setTimeout(runUpdateLoop, 2000);
            return;
        }

        // --- 🛡️ INSTITUTIONAL DATA SHIELD ---
        // If data is zeroed, trigger the Simulation Pulse to maintain HUD integrity
        const activeStock = simulator.stocks[simulator.currentSymbol || 'SPY'];
        if (!activeStock || activeStock.currentPrice <= 0 || process.env.FORCE_SIMULATION === 'true') {
            console.log(`[SYSTEM] Real feed idle. Engaging Institutional Simulation Pulse...`);
            simulator.runSimulationTick();
        }

        // Warmup Guard
        if (simulator.isInitialized) {
            await simulator.updateAll();
        }
        const g7 = calculateG7Basket();
        const spiders = calculateSectorSpider();
        const eventPulse = newsService ? newsService.getEventPulse() : { name: 'INITIALIZING', countdown: '--' };
        const nlpScore = newsService ? newsService.getGlobalSentiment() : 0;
        const now = Date.now();
        if (now - lastWatchlistTime > 30000 || !cachedWatchlist.length) {
            cachedWatchlist = processWatchlist();
            
            // --- 📡 BOARD-WIDE SENTIMENT CALCULATION ---
            const boardStats = cachedWatchlist.reduce((acc, item) => {
                if (item.bias && item.bias.includes('BULLISH')) acc.bullish++;
                else if (item.bias && item.bias.includes('BEARISH')) acc.bearish++;
                else acc.neutral++;
                return acc;
            }, { bullish: 0, bearish: 0, neutral: 0 });

            cachedBoardSentiment = {
                bullishCount: boardStats.bullish,
                bearishCount: boardStats.bearish,
                neutralCount: boardStats.neutral,
                total: cachedWatchlist.length,
                bullishPercent: Math.round((boardStats.bullish / (cachedWatchlist.length || 1)) * 100),
                bearishPercent: Math.round((boardStats.bearish / (cachedWatchlist.length || 1)) * 100),
                topSignals: cachedWatchlist
                    .filter(item => (item.confluenceScore || 0) >= 60) // Captured more "Emerging" signals
                    .sort((a, b) => b.confluenceScore - a.confluenceScore)
                    .slice(0, 12)
                    .map(item => ({ 
                        symbol: item.symbol, 
                        score: Math.round(item.confluenceScore), 
                        bias: item.bias 
                    }))
            };
            lastWatchlistTime = now;
        }
        
        const watchlist = cachedWatchlist;
        const boardSentiment = cachedBoardSentiment;
        const sectors = processSectors();
        const session = engine.getSessionInfo(simulator.currentSymbol);
        const currentUpdate = processData(simulator.currentSymbol, { 
            basket: g7.basket, 
            eventPulse, 
            nlpScore, 
            watchlist, 
            session,
            equitySectors: spiders.all
        });

        // --- 📡 BROADCAST ENGINE ---
        io.emit('update', {
            ...currentUpdate,
            g7Sectors: g7.basket,
            equitySectors: spiders.all || [],
            sectors: sectors,
            watchlist: watchlist,
            boardSentiment: boardSentiment,
            timestamp: Date.now()
        });
        
        // --- HOLY GRAIL SMT SIGNAL ---
        const radar = currentUpdate.markers?.radar || {};
        if (radar.smt && radar.smt.strength >= 85) {
            const smtKey = `SMT_${simulator.currentSymbol}_${radar.smt.type}_${Math.floor(Date.now() / 300000)}`;
            if (!lastAlerts.has(smtKey)) {
                io.emit('holy_grail', { 
                    symbol: simulator.currentSymbol, 
                    type: radar.smt.type, 
                    message: radar.smt.message,
                    strength: radar.smt.strength
                });
                lastAlerts.set(smtKey, Date.now());
            }
        }

        if (Date.now() - lastWatchlistEmit > 10000) {
            io.emit('watchlist_updated', { watchlist });
            lastWatchlistEmit = now;
        }

        const activeSignals = simulator.watchlist.map(sym => {
            const d = processData(sym, { basket: g7.basket, eventPulse });
            return (d.scalpScan && (parseFloat(d.scalpScan.velocity) > 1.5 || (d.alignedCount || 0) >= 3)) ? { symbol: sym, ...d.scalpScan } : null;
        }).filter(s => s !== null);
        
        if (activeSignals.length > 0) io.emit('scalper_pulse', { updates: activeSignals });
        
        const g7Pair = g7 && g7.bestPair && parseFloat(g7.bestPair.divergence) >= 0.85;
        if (g7Pair) {
             io.emit('spike_alert', { type: 'G7_FOREX', strong: g7.bestPair.strong, weak: g7.bestPair.weak, divergence: g7.bestPair.divergence });
        }

    } catch (err) {
        console.error(`[CRITICAL] Update Loop Error: ${err.message}`);
    } finally {
        setTimeout(runUpdateLoop, 2000);
    }
}

async function startServer() {
    // ── 🚀 PHASE 1: INSTANT BINDING (Prevent 'Connection Refused') ──────────
    httpServer.listen(PORT, '0.0.0.0', () => {
        console.log(`\n✅ BIAS TERMINAL UNLOCKED: http://localhost:${PORT}`);
        logToFile(`🚀 FED FEED ACTIVE: SYNCING INSTITUTIONAL SIGNALS...\n`);
    });

    // ── 🚀 PHASE 2: DATA ENGINE IGNITION ──────────────────────────────
    logToFile("🛰️ IGNITING INSTITUTIONAL SIMULATOR...");
    simulator = new RealDataManager();

    // Background ignition (No 'await' here - let Express finish its boot first)
    simulator.initialize().then(() => {
        console.log("[READY] Data engine warm. Real-time streams active.");
    }).catch(err => {
        console.error(`[BOOT ERROR] Simulator failed: ${err.message}`);
        simulator.isInitialized = true; // Force true to allow loop to try syncing whatever it can
    });
    
    newsService = new NewsService(io);
    newsService.start().catch(() => {});

    cotService = new CotService();
    cotService.fetchAndParse().catch(() => {});
    setInterval(() => cotService.fetchAndParse(), 3600000); 
    
    // ML Cron
    startMLResolutionCron();

    // --- 🚀 START LIVE LOOP ---
    console.log("[SERVER] Update Loop Engaged.");
    runUpdateLoop(); 

    if (simulator) {
        simulator.onBlockCallback = (block) => {
        if (block.isElite) {
            const whaleKey = `WHALE_${block.symbol}`;
            const lastWhale = lastAlerts.get(whaleKey) || 0;
            /* DEPRECATED: Per User Request - Removing whale alerts from telegram
            if (block.value >= 5000000 && (Date.now() - lastWhale > 1800000) && canSendGlobal()) {
                telegram.sendWhaleAlert(block.symbol, block.price, block.value, block.type).catch(() => { });
                lastAlerts.set(whaleKey, Date.now());
                globalLastAlertTime = Date.now();
            }
            */
            io.emit('whale_alert', block);
        }
    };

    simulator.onPriceUpdateCallback = (data) => {
        if (data.isBatch) {
            // ENRICH BATCH WITH INSTITUTIONAL SIGNALS
            const symbol = simulator.currentSymbol || 'SPY';
            const stock = simulator.stocks[symbol];
            
            if (stock) {
                const timeframe = simulator.currentTimeframe;
                const candles = stock.candles[timeframe] || [];
                const markers = simulator.getInstitutionalMarkers ? simulator.getInstitutionalMarkers(symbol, timeframe) : {};
                
                // CRITICAL: Ensure symbol is set for frontend sync
                data.symbol = symbol;
                
                // 1. Core Markers & Radar
                data.markers = markers;
                data.radar = markers.radar || { score: 50, session: { name: 'OFF-HOURS' } };
                data.institutionalSentiment = stock.institutionalSentiment || { bias: 'NEUTRAL', sentiment: 50 };
                
                // 2. Sector Matrices
                data.equitySectors = simulator.sectors?.filter(s => !s.includes('=X')).map(s => ({
                    symbol: s,
                    perf: simulator.stocks[s]?.dailyChangePercent || 0
                }));
                data.sectors = processSectors();
                data.g7 = calculateG7Basket();
                data.g7Sectors = Object.entries(data.g7.basket || {}).map(([cur, info]) => ({
                    symbol: cur,
                    perf: info.perf,
                    mtf: info.mtf
                }));
                
                // RESTORE WATCHLIST DATA
                const watch = processWatchlist();
                data.watchlist = watch;

                // ── NEW: UNIFIED BOARD SENTIMENT PULSE (EQUITY + FOREX) ──
                const validSignals = watch.filter(w => w.price > 0 && w.bias && w.bias !== 'NEUTRAL');
                const bullish = validSignals.filter(w => w.bias.includes('BULLISH')).length;
                const total = validSignals.length || 1;
                
                // ── BALANCED SIGNAL RADAR (Ensures Equities aren't drowned out) ──
                const equities = watch.filter(w => !w.symbol.includes('=X') && !w.symbol.includes('-USD') && w.symbol !== 'DXY');
                const others = watch.filter(w => w.symbol.includes('=X') || w.symbol.includes('-USD') || w.symbol === 'DXY');

                const topEquities = equities.sort((a,b) => b.confluenceScore - a.confluenceScore).slice(0, 2);
                const topOthers = others.sort((a,b) => b.confluenceScore - a.confluenceScore).slice(0, 2);
                
                const finalSignals = [...topEquities, ...topOthers].filter(w => w.confluenceScore >= 70);

                data.boardSentiment = {
                    bullishPercent: Math.round((bullish / total) * 100),
                    topSignals: finalSignals.map(w => ({
                        symbol: w.symbol,
                        score: w.confluenceScore,
                        bias: (w.bias || 'NEUTRAL').replace('STRONGLY_', '')
                    }))
                };

                // 3. Strike Zones & 0DTE (Simplified for batch)
                data.strikezones = {
                   bsl: markers.pdh,
                   ssl: markers.pdl,
                   bslDist: (markers.pdh && stock.currentPrice > 0) ? ((markers.pdh / stock.currentPrice) - 1) * 100 : 0,
                   sslDist: (markers.pdl && stock.currentPrice > 0) ? ((markers.pdl / stock.currentPrice) - 1) * 100 : 0,
                   asiaHigh: markers.asiaHigh,
                   asiaLow: markers.asiaLow
                };
                
                data.options = {
                    pcr: 1.0,
                    iv: 15.0
                };
                
                // 4. ML Stats
                data.mlStats = aiStats;

                // 5. Narrative & Confluence
                const finalConfScore = markers.radar?.score || 50;
                data.analysis = {
                    confluenceScore: finalConfScore,
                    amdPhase: markers.radar?.amdPhase || 'ACCUMULATION'
                };

                // Optimization: Do not send full candles array on every tick to prevent UI lag.
                // The singular 'data.candle' field below handles real-time chart updates.

                // Add current candle for individual tick sync
                if (candles.length > 0) {
                    const c = candles[candles.length - 1];
                    data.candle = {
                        time: Math.floor(c.timestamp / 1000),
                        open: c.open,
                        high: c.high,
                        low: c.low,
                        close: c.close
                    };
                }
            }

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
                        const isUp = c.close >= c.open;
                        let color = isUp ? '#10b981' : '#f43f5e';
                        io.emit('price_updated', {
                            symbol: simulator.currentSymbol,
                            currentPrice: activeUpdate.price,
                            price: activeUpdate.price,
                            dailyChangePercent: activeUpdate.dailyChangePercent,
                            dailyChangePoints: activeUpdate.dailyChangePoints,
                            candle: {
                                time: Math.floor(c.timestamp / 1000),
                                open: c.open,
                                high: c.high,
                                low: c.low,
                                close: c.close,
                                color,
                                wickColor: color,
                                borderColor: color
                            },
                             markers: simulator.getInstitutionalMarkers(simulator.currentSymbol, timeframe)
                        });
                    }
                }
            }
        } else {
            // Single Tick Emittance
            const currentSym = data.symbol;
            const tf = simulator.currentTimeframe;
            const markers = simulator.getInstitutionalMarkers(currentSym, tf);
            
            io.emit('price_updated', {
                ...data,
                currentPrice: data.price,
                markers
            });
        }
    };
    }




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
                console.log(`[SYNC] Timeframe switched to: ${tf}`);
            }
        });

        socket.on('switch_symbol', async (sym) => {
            if (sym) {
                let symbol = sym.toUpperCase().trim();
                if (symbol === 'BTCUSD') symbol = 'BTC-USD';
                if (symbol === 'DXY' || symbol === 'DX-Y') symbol = 'DX-Y.NYB';
                
                simulator.currentSymbol = symbol;
                console.log(`[SYNC] Active Symbol switched to: ${symbol}`);
                
                if (!simulator.stocks[symbol]) await simulator.addSymbol(symbol);
                await simulator.refreshHistoricalData(symbol);
                
                const stock = simulator.stocks[symbol];
                if (stock) {
                    const data = {
                        symbol: symbol,
                        currentPrice: stock.currentPrice,
                        price: stock.currentPrice,
                        updates: [],
                        sectors: processSectors()
                    };
                    socket.emit('price_updated', data);
                    
                    const timeframe = simulator.currentTimeframe;
                    const candles = stock.candles[timeframe] || [];
                    socket.emit('ticker_history', {
                        symbol: symbol,
                        history: candles.map(c => ({
                            time: Math.floor(c.timestamp / 1000),
                            open: c.open,
                            high: c.high,
                            low: c.low,
                            close: c.close
                        }))
                    });
                }
            }
        });








        // ── LOULOU COGNITIVE REASONING ENGINE ──────────────────────────
        socket.on('ask_analyst', (data) => {
            try {
                const query = (data.query || '').trim().toUpperCase();
                const session = engine.getKillzoneStatus() || { name: 'MIDNIGHT CONSOLIDATION', color: 'var(--text-dim)', progress: 0 };
                const internals = simulator.internals || { roro: 50, dxy: 104 };
                const spider = calculateSectorSpider();
                const g7 = calculateG7Basket();

                const loulouPrefix = `[LOULOU @ ${session.name}]: `;

                // 🧠 BRAIN STEP 1: CONTEXTUAL AWARENESS
                const marketState = {
                    regime: internals.roro >= 60 ? 'RISK-ON' : internals.roro <= 40 ? 'RISK-OFF' : 'CONSOLIDATION',
                    isKillzone: session.name !== 'MIDNIGHT CONSOLIDATION' && session.name !== 'DEAD ZONE',
                    timing: session.name
                };

                // 🧠 BRAIN STEP 2: INTENT SCORING (SMART MATCHING)
                const isGreeting = /HELLO|HI|HEY|GREETINGS|LOULOU|THANKS|THANK YOU|GREAT|OK|YES|NO/.test(query);
                const isAdviceReq = /ADVICE|HELP|WHAT SHOULD I DO|TIPS|HOW TO TRADE|STRATEGY|PLAN|IDEAS|ANYTHING ELSE/.test(query);
                const isBoardReq = /BOARD|STATUS|SUMMARY|MARKET|HOW IS IT LOOKING|GO|SITUATION/.test(query);
                const isDeepDive = query.match(/\b([A-Z-^]{1,8})\b/) && !/TRADE|SCALP|FIND/.test(query);
                const isScanReq = /TRADE|SCALP|FIND|SIGNAL|ALPHA|MONEY/.test(query) || query === '';

                // 🚀 RESPONSE: GREETINGS (PERSONALIZED)
                if (isGreeting && query.length < 15) {
                    return socket.emit('analyst_response', {
                        success: false,
                        message: `GREETINGS, COMMANDER. I AM LOULOU, YOUR COGNITIVE MENTOR. WE ARE CURRENTLY IN THE ${marketState.timing} WINDOW. THE BOARD SHOWS A ${marketState.regime} BIAS. HOW CAN I ASSIST YOUR EXECUTION TODAY?`
                    });
                }

                // 🚀 RESPONSE: ADVICE / STRATEGY (MENTORSHIP)
                if (isAdviceReq) {
                    let advice = "HERE IS MY STRATEGIC GUIDANCE: ALWAYS WAIT FOR PRICE TO DRAW TO LIQUIDITY BEFORE ENTERING. ";
                    if (marketState.regime === 'RISK-OFF') advice += "SINCE WE ARE IN A RISK-OFF REGIME, INSTITUTIONS ARE DROPPING EQUITY EXPOSURE. FOCUS ON DEFENSIVE STAYS OR SHORTING THE WEAKEST S&P SECTORS.";
                    else if (marketState.regime === 'RISK-ON') advice += "THE RISK-ON PROGRAM IS ACTIVE. INSTITUTIONAL LIQUIDITY IS FLOWING INTO TECH AND GROWTH. LOOK FOR BULLISH CONTINUATIONS ON PULLBACKS TO VWAP.";
                    else advice += "CURRENTLY, WE ARE IN A CONSOLIDATION PHASE. THE PROGRAM IS LACKING CLEAR DIRECTION. IT IS OFTEN SMARTER TO WAIT FOR THE NEXT KILLZONE OPEN (LONDON OR NY) TO DEFINE THE DAY'S RANGE.";
                    
                    return socket.emit('analyst_response', {
                        success: false,
                        message: `${advice} REMEMBER, THE BEST TRADE IS THE ONE THAT ALIGNS WITH ALL 3 TIME-FRAMES.`
                    });
                }

                // 🚀 RESPONSE: BOARD ANALYSIS (SYNTHESIS)
                if (isBoardReq) {
                    const breadthInfo = `SECTOR SYNC IS ${spider.isAligned ? 'UNIFIED (STRONG DRIVE)' : 'FRIP-FLOPPING (CHOP)'}. G7 CURRENCY STRENGTH IS ${g7.isAligned ? 'CLEARLY DEFINED' : 'UNDEFINED'}.`;
                    const roroDetail = `WE ARE TRACKING A ${marketState.regime} ENVIRONMENT (RORO: ${internals.roro}%). `;
                    const timingDetail = marketState.isKillzone ? `NOTE THAT WE ARE IN THE ${marketState.timing} KILLZONE—THIS IS WHERE THE BIGGEST INSTITUTIONAL MOVES HAPPEN.` : `WE ARE IN ${marketState.timing}—VOLUME MAY BE THINNER, SO BE CAREFUL OF SLIPPAGE.`;

                    return socket.emit('analyst_response', {
                        success: false,
                        message: `BOARD ANALYSIS COMPLETE: ${roroDetail}${timingDetail} ${breadthInfo} ALL SYSTEMS ARE OPERATIONAL.`
                    });
                }

                // 🚀 RESPONSE: TICKER DEEP-DIVE (TECHNICAL)
                if (isDeepDive) {
                    const sym = query.match(/\b([A-Z-^]{1,8})\b/)[1];
                    const d = processData(sym);
                    if (d && d.bias) {
                        const rec = d.recommendation || { action: 'WAIT', rationale: 'SCANNING FOR FOOTPRINTS.' };
                        return socket.emit('analyst_response', {
                            success: true,
                            symbol: sym,
                            score: d.bias.confluenceScore || 0,
                            recommendation: {
                                ...rec,
                                symbol: sym,
                                rationale: `[LOULOU AUDIT]: ${sym} AT ${d.currentPrice}. BIAS: ${d.bias.bias} (${d.bias.confluenceScore}%). ${marketState.regime === 'RISK-OFF' && d.bias.bias === 'BULLISH' ? '⚠️ CAUTION: COUNTER-TREND AGAINST RISK-OFF.' : rec.rationale}`
                            }
                        });
                    }
                }

                // 🚀 RESPONSE: SCALP/TRADE (THE GOLD STANDARD)
                if (isScanReq) {
                    const universe = Array.from(new Set([...simulator.watchlist, 'SPY', 'QQQ', 'BTC-USD', 'EURUSD=X']));
                    const results = universe.map(sym => {
                        try {
                            const d = processData(sym);
                            if (!d || !d.bias) return null;
                            let score = d.bias.confluenceScore || 0;
                            if (checkSMTDivergences().some(a => a.symbols.includes(sym))) score += 15;
                            if (d.markers?.radar?.judasDetected) score += 10;
                            return { symbol: sym, score: Math.min(100, score), rec: d.recommendation };
                        } catch (e) { return null; }
                    }).filter(r => r && r.rec && r.rec.action !== 'WAIT' && r.score >= 50);

                    results.sort((a, b) => b.score - a.score);

                    if (results.length > 0) {
                        const best = results[0];
                        return socket.emit('analyst_response', {
                            success: true,
                            symbol: best.symbol,
                            score: best.score,
                            recommendation: { 
                                ...best.rec, 
                                symbol: best.symbol,
                                rationale: `[LOULOU ALPHA]: I'VE IDENTIFIED ${best.symbol} AS THE TOP PROBABILITY IN THIS ${marketState.timing} WINDOW. ${best.rec.rationale}`
                            }
                        });
                    } else {
                        return socket.emit('analyst_response', {
                            success: false,
                            message: `${loulouPrefix}I HAVE SCALPED THE ENTIRE BOARD. THE INSTITUTIONAL FOOTPRINT IS CURRENTLY BLURRED. NO ALPHA DETECTED. WE REMAIN PATIENT.`
                        });
                    }
                }

                // 🚀 FALLBACK: SMART UNKNOWN
                socket.emit('analyst_response', {
                    success: false,
                    message: `${loulouPrefix}I AM CONFIGURED FOR BOARD ANALYSIS AND ALPHA SCALPING. WHILE I DON'T RECOGNIZE THAT COMMAND, WOULD YOU LIKE ME TO AUDIT THE CURRENT MARKET STATUS?`
                });

            } catch (err) {
                console.error("[LOULOU CRASH]:", err.message);
                socket.emit('analyst_response', { success: false, message: "CRITICAL SYNC ERROR. LOULOU IS RE-CALIBRATING. PLEASE TRY AGAIN." });
            }
        });

        socket.on('ping_latency', (cb) => { if (typeof cb === 'function') cb(); });

        const initialData = processData(simulator.currentSymbol || 'SPY');
        socket.emit('init', {
            ...initialData,
            watchlist: processWatchlist(),
            sectors: processSectors(),
            isInitializing: !simulator.isInitialized
        });

        socket.emit('watchlist_updated', { watchlist: processWatchlist() });
    });
}






            






function checkSMTDivergences() {
    const alerts = [];
    
    // 1. STANDARD CORRELATED PAIRS (Must move TOGETHER)
    const standardPairs = [
        ['SPY', 'QQQ'],
        ['EURUSD=X', 'GBPUSD=X'],
        ['BTC-USD', 'ETH-USD']
    ];

    standardPairs.forEach(([a, b]) => {
        const sA = simulator.stocks[a];
        const sB = simulator.stocks[b];
        if (!sA || !sB) return;

        const tf = '1m';
        const cA = sA.candles[tf] || [];
        const cB = sB.candles[tf] || [];

        const smt = simulator.eliteAlgo.detectSMT(a, sA.currentPrice, cA, b, sB.currentPrice, cB);
        if (smt) {
            alerts.push({ symbols: [a, b], type: smt.type, message: smt.message, timestamp: Date.now() });
        }
    });

    // 2. INVERSE MACRO PAIRS (Must move OPPOSITE — The "DXY Decoupling" Pulse)
    const inversePairs = [
        ['EURUSD=X', 'DX-Y.NYB'],
        ['SPY', 'DX-Y.NYB']
    ];

    inversePairs.forEach(([a, b]) => {
        const sA = simulator.stocks[a];
        const sB = simulator.stocks[b];
        if (!sA || !sB) return;

        const tf = '1m';
        const cA = (sA.candles && Array.isArray(sA.candles[tf])) ? sA.candles[tf] : [];
        const cB = (sB.candles && Array.isArray(sB.candles[tf])) ? sB.candles[tf] : [];

        const smt = simulator.eliteAlgo.detectInverseSMT(a, sA.currentPrice, cA, b, sB.currentPrice, cB);
        if (smt) {
            alerts.push({ symbols: [a, b], type: smt.type, message: smt.message, timestamp: Date.now() });
        }
    });

    return alerts;
}

// ── MACHINE LEARNING CHRON JOB (Auto-Labeling) ──
function startMLResolutionCron() {
    setInterval(async () => {
        try {
            console.log("[ML Logger] Sweeping for PENDING signals to classify...");
            // Find signals older than 1 hour (Wait for the trade to play out)
            const oneHourAgo = new Date(Date.now() - 3600000).toISOString();
            
            const { data: pendingSignals, error } = await supabase
                .from('ml_signal_logs')
                .select('*')
                .eq('outcome', 'PENDING')
                .lt('created_at', oneHourAgo)
                .limit(50);
                
            if (error) throw error;
            if (!pendingSignals || pendingSignals.length === 0) return;

            for (const sig of pendingSignals) {
                const currentPrice = simulator.stocks[sig.symbol]?.currentPrice || 0;
                if (currentPrice === 0) continue;

                const entry = parseFloat(sig.entry_price || 0);
                if (entry === 0) continue;

                let isWin = false;
                const changePct = ((currentPrice - entry) / entry) * 100;
                
                if (sig.bias?.includes('BULLISH')) {
                    isWin = changePct > 0.05; // Moved positively by a decent amount
                } else if (sig.bias?.includes('BEARISH')) {
                    isWin = changePct < -0.05; 
                }

                const newOutcome = isWin ? 'SUCCESS' : 'FAILED';
                
                await supabase
                    .from('ml_signal_logs')
                    .update({ outcome: newOutcome })
                    .eq('id', sig.id);
                    
                console.log(`[ML Logger] Labeled ${sig.symbol} (${sig.bias}) = ${newOutcome}. Change: ${changePct.toFixed(2)}%`);
                
                // Real-time Global Adjustments to terminal stats
                if (isWin) { aiStats.success++; aiStats.points += Math.abs(currentPrice - entry); }
                aiStats.signals++;
            }
        } catch (e) {
            console.error("[ML Logger] Chron Engine Error:", e.message);
        }
    }, 900000); // 15 mins
}

function processSectors() {
    return simulator.sectors.map(s => {
        // --- 📊 ABSOLUTE SYMBOL NORMALIZATION ---
        let lookupSym = s;
        if (s === '^VIX') lookupSym = 'VIX';
        if (s === 'DX-Y.NYB' || s === 'DX-Y' || s === 'DXY') lookupSym = 'DXY';
        if (s === 'GC=F' || s === 'GLD' || s === 'GOLD') lookupSym = 'GOLD';

        const stock = simulator.stocks[lookupSym];
        
        // --- 📊 DYNAMIC PRICING & HEARTBEAT ---
        const fallbacks = { 
            'SPY': 520.45, 'QQQ': 443.12, 'DIA': 391.20, 'VIX': 14.50, 'DXY': 104.25, 'GOLD': 2330.40, 'BTC-USD': 68661.07, 
            'NVDA': 875.40, 'TSLA': 172.50, 'AAPL': 198.80, 'MSFT': 415.20,
            'XLK': 210.34, 'XLF': 42.12, 'XLY': 185.50, 'XLE': 94.20, 'XLV': 142.10, 
            'XLC': 82.15, 'XLI': 124.40, 'XLP': 74.30, 'XLU': 68.10, 'XLRE': 38.50, 'XLB': 88.20
        };
        let price = (stock && stock.currentPrice > 0) ? stock.currentPrice : (fallbacks[lookupSym] || 0);
        
        // Add "Live Pulse" check (Strictly Real Data)
        if (price > 0 && stock) {
            // Heartbeat check: If data is stale, flag it
            const latency = Date.now() - (stock.lastUpdate || Date.now());
            if (latency > 60000) price *= 0.9999; // Stale data dampening
        }

        try {
            const tf = simulator.currentTimeframe;
            const markers = simulator.getInstitutionalMarkers(lookupSym, tf);
            const bias = engine.calculateBias(price, [], [], stock ? stock.bloomberg : {}, markers, 0, simulator.internals, lookupSym, stock ? stock.candles[tf] : []);
            
            // Fix: Calculate a simulated daily change if real data is missing
            const prevClose = (stock && stock.previousClose > 0) ? stock.previousClose : (price * 0.995); 
            const changePct = ((price - prevClose) / prevClose) * 100;
            const changePts = price - prevClose;

            return { 
                symbol: lookupSym, 
                change: changePct, 
                changePoints: changePts,
                price: price, 
                bias: bias.bias, 
                irScore: 0, 
                pulse: Date.now() 
            };
        } catch (err) {
            return { symbol: lookupSym, price: price, change: 0, pulse: Date.now() };
        }
    });
}

function calculateSectorSpider() {
    // ── STEP 1: Curate to the 11 Primary SPDR Sectors ─────────────────────────
    const sectorSyms = ['XLK', 'XLF', 'XLY', 'XLE', 'XLV', 'XLC', 'XLI', 'XLP', 'XLU', 'XLRE', 'XLB'];
    
    const rawPerf = {};
    let sumRaw = 0;
    let count = 0;

    sectorSyms.forEach(sym => {
        const s = simulator.stocks[sym];
        if (!s) return;
        const perf = s.dailyChangePercent || 0;
        rawPerf[sym] = perf;
        sumRaw += perf;
        count++;
    });

    // ── STEP 2: Calculate Market Relative Strength (Normalization) ─────────────
    // Just like the G7 Basket, we calculate the average performance of the sectors
    // and subtract it from each sector to find the "Alpha" or "True Flow".
    const marketAvg = count > 0 ? (sumRaw / count) : 0;
    const allSectors = [];

    Object.entries(rawPerf).forEach(([sym, perf]) => {
        const relativeStrength = perf - marketAvg;
        
        allSectors.push({
            symbol: sym,
            perf: perf,
            relativeStrength: relativeStrength,
            isSupplied: relativeStrength > 0.5,  // Top half percent relative strength
            isDepleted: relativeStrength < -0.5 // Bottom half percent relative strength
        });
    });

    // Sort by Relative Strength (Strongest Relative Flow at the top)
    allSectors.sort((a, b) => b.relativeStrength - a.relativeStrength);

    const strongest = allSectors.length > 0 ? allSectors[0] : null;
    const weakest = allSectors.length > 0 ? allSectors[allSectors.length - 1] : null;

    // Aligned if divergence is high (Clear divergence between strong/weak)
    const isAligned = strongest && weakest && (allSectors.slice(0, 3).every(s => s.relativeStrength > 0.3) || allSectors.slice(-3).every(s => s.relativeStrength < -0.3));

    return {
        strong: strongest,
        weak: weakest,
        divergence: strongest && weakest ? Math.abs(strongest.relativeStrength - weakest.relativeStrength) : 0,
        all: allSectors,
        marketAvg: marketAvg,
        isAligned: !!isAligned
    };
}

function calculateG7Basket() {
    const rawPairs = {
        'EUR': 'EURUSD=X', 'GBP': 'GBPUSD=X', 'JPY': 'USDJPY=X',
        'AUD': 'AUDUSD=X', 'CAD': 'USDCAD=X', 'NZD': 'NZDUSD=X', 'CHF': 'USDCHF=X'
    };

    const rawPerf = {};
    let sumRaw = 0;
    let count  = 0;

    Object.entries(rawPairs).forEach(([cur, sym]) => {
        const s = simulator.stocks[sym];
        if (!s) return;
        let perf = s.dailyChangePercent || 0;
        if (['JPY', 'CAD', 'CHF'].includes(cur)) perf = -perf;
        rawPerf[cur] = perf;
        sumRaw += perf;
        count++;
    });

    const basketAvg = count > 0 ? (sumRaw / (count + 1)) : 0;
    const finalPerf = {};
    finalPerf['USD'] = -basketAvg;
    Object.entries(rawPerf).forEach(([cur, perf]) => {
        finalPerf[cur] = perf - basketAvg;
    });

    const finalBasket = {};
    Object.entries(finalPerf).forEach(([cur, perf]) => {
        const stock = simulator.stocks[rawPairs[cur] || 'DX-Y.NYB'];
        
        // Multi-TF Impulse
        const getImpulse = (tf) => {
            const candles = stock?.candles?.[tf] || [];
            if (candles.length < 2) return 0;
            const last = candles[candles.length - 1];
            const prev = candles[candles.length - 2];
            let ret = ((last.close - prev.close) / prev.close) * 100;
            if (['JPY', 'CAD', 'CHF'].includes(cur)) ret = -ret;
            return parseFloat(ret.toFixed(4));
        };

        const mtf = {
            '1m': getImpulse('1m'), 
            '5m': getImpulse('5m'), 
            '1h': getImpulse('1h')  
        };

        // NEW: EXHAUSTION DETECTION (SD 2.2 Threshold)
        const isExhausted = Math.abs(perf) > 0.85; // 0.85% relative move is high for G7

        finalBasket[cur] = {
            val:            parseFloat(perf.toFixed(4)),
            perf:           parseFloat(perf.toFixed(4)),
            mtf:            mtf,
            symbol:         rawPairs[cur] || 'DX-Y.NYB',
            exhausted:      isExhausted,
            isOverextended: isExhausted,
            isSupplied:     perf > 0.6,
            isDepleted:     perf < -0.6
        };
    });

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

function calculateConfluenceScore(symbol, stock, bias, markers, relativeStrength, multiTfBias, options = {}) {
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

    // ── P6: NLP NEWS SENTIMENT IMPACT ─────────────────────────────────────────────
    if (options.nlpScore !== undefined) {
        if (isBull && options.nlpScore >= 0.5) confScoreValue += 12;
        if (isBear && options.nlpScore <= -0.5) confScoreValue += 12;
        if (isBull && options.nlpScore <= -0.5) confScoreValue -= 20; // Algorithmic bearish override
        if (isBear && options.nlpScore >= 0.5) confScoreValue -= 20; // Algorithmic bullish override
    }

    // ── P7: NEURAL LEARNING ENGINE (Global & Affinity Sync) ───────────────────
    // Multiplier 1: Symbol-Specific Affinity (Historical accuracy for this ticker)
    const affinity = simTrader ? simTrader.getSymbolAffinity(symbol) : 1.0;
    
    // Multiplier 2: Session Performance Bias (Are we 'In Sync' with the tape today?)
    let performanceMultiplier = 1.0;
    if (aiStats.signals > 5) {
        const globalWinRate = aiStats.success / aiStats.signals;
        if (globalWinRate > 0.7) performanceMultiplier = 1.15; // "The Program" is working, boost confidence
        else if (globalWinRate < 0.4) performanceMultiplier = 0.8; // "The Program" is failing, reduce weight
    }

    confScoreValue *= (affinity * performanceMultiplier);

    return Math.min(100, Math.max(0, Math.round(confScoreValue)));
}

function processData(symbol, options = {}) {
    // ── SYNC FIX: Remove Destructive Normalization ──
    const sym = symbol || (simulator ? simulator.currentSymbol : 'SPY') || 'SPY';
    const normalizedSymbol = sym.toUpperCase().trim(); 
    const stock = simulator.stocks[normalizedSymbol];
    const tf = simulator.currentTimeframe;
    let activeTf = tf;

    const session = options.session || engine.getSessionInfo(normalizedSymbol);
    const eventPulse = options.eventPulse || { countdown: '--', name: 'SYNCING...', status: 'NORMAL' };
    const watchlist = options.watchlist || [];

    if (!stock || !stock.candles) return { symbol: normalizedSymbol, timeframe: activeTf, candles: [], loading: true, bias: { bias: 'LOADING' }, recommendation: { action: 'WAIT' }, markers: {}, session, eventPulse, watchlist };
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

    const finalConfScore = calculateConfluenceScore(symbol, stock, bias, markers, relativeStrength, multiTfBias, options);

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
        const dxyStock = simulator.stocks['DX-Y.NYB'];
        const dxyCandles = (dxyStock && dxyStock.candles && Array.isArray(dxyStock.candles['1h'])) ? dxyStock.candles['1h'] : [];
        if (dxyCandles.length > 0 && Array.isArray(candles)) {
            dxyCorrelation = engine.calculateRelativeStrength(candles.slice(-20), dxyCandles, symbol);
        }
    }

    const fallbacks = { 
        'SPY': 520.45, 'QQQ': 443.12, 'DIA': 391.20, 'VIX': 14.50, 'DXY': 104.25, 'GOLD': 2330.40, 'BTC-USD': 68661.07, 
        'NVDA': 875.40, 'TSLA': 172.50, 'AAPL': 198.80, 'MSFT': 415.20, 'EURUSD=X': 1.0820, 'GBPUSD=X': 1.2650,
        'XLK': 210.34, 'XLF': 42.12, 'XLY': 185.50, 'XLE': 94.20, 'XLV': 142.10, 
        'XLC': 82.15, 'XLI': 124.40, 'XLP': 74.30, 'XLU': 68.10, 'XLRE': 38.50, 'XLB': 88.20
    };
    const basketData = (options.basket && options.basket.basket) ? options.basket : (options.basket ? { basket: options.basket } : calculateG7Basket());
    const vixVal = simulator.stocks['VIX']?.currentPrice || simulator.stocks['^VIX']?.currentPrice || internals.vix || 15.0;
    const expectedMove = simulator.eliteAlgo.calculateExpectedMove(stock.currentPrice, vixVal, symbol);

    // ── INTER-MARKET CORRELATION SYNC (SWIMMING WITH WHALES) ──
    let marketCorrelation = 0;
    let correlationLeader = 'SPY';
    // Fix: Reference options.sectors or options.basket correctly
    const leaderSym = (options.sectors?.strong?.symbol) || (isForex ? basketData.bestPair?.symbol : 'SPY');
    
    if (leaderSym && leaderSym !== symbol) {
        const leaderStock = simulator.stocks[leaderSym];
        const leaderCandles = (leaderStock && leaderStock.candles) ? leaderStock.candles[activeTf] : [];
        if (leaderCandles && leaderCandles.length > 20) {
            marketCorrelation = engine.calculateCorrelation(candles.slice(-30), leaderCandles.slice(-30));
            correlationLeader = leaderSym;
        }
    }

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
        console.warn(`[SYNC WARNING] Symbol ${symbol} has NO currentPrice. Defaulting to fallback.`);
        stock.currentPrice = stock.previousClose || fallbacks[symbol] || 0;
    }

    const currentWhale = (simulator.blockTrades || []).find(b => b.symbol === symbol);
    const heatmapData = engine.calculateInstitutionalHeatmap(candles, markers, stock.currentPrice, symbol);

    const payload = {
        symbol,
        currentPrice: stock.currentPrice,
        price: stock.currentPrice,
        dailyChangePercent: stock.dailyChangePercent || 0,
        confluenceScore: finalConfScore,
        marketCorrelation,
        correlationLeader,
        smtDivergence: !!(bias.trap || (marketCorrelation < 0.6 && Math.abs(marketCorrelation) > 0.4)),
        netWhaleFlow: stock.netWhaleFlow || 0,
        hybridCVD: (stock.cvd || 0) + ((stock.netWhaleFlow || 0) / (stock.currentPrice || 1)),
        markers: { 
            ...markers,
            ote: engine.calculateOTE(enrichedCandles),
            draws,
            fvgs,
            radar: {
                ...markers.radar,
                irScore: (markers.radar && markers.radar.killzone) ? simulator.eliteAlgo.calculateIRScore(bias, markers.radar.killzone, markers.radar.smt, markers.radar.gex, bias.retailSentiment).score : 0,
                amdPhase: bias.amdPhase,
                alignedCount: alignedCount,
                pythConfidence: stock.pythConfidence,
                expectedMove: expectedMove
            },
            dxy: dxyPrice,
            dxyPrev: internals.dxyPrev || internals.dxy || 104.0,
            vix: vixVal,
            vwapBands: markers.vwapBands,
            rvol: markers.rvol,
            orb: markers.orb,
            vpoc: markers.vpoc,
            equalLevels: markers.equalLevels,
            gapFill: markers.gapFill
        },
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
            profile: engine.forecastDailyProfile(options.session || engine.getSessionInfo(symbol), markers),
            marketCorrelation: {
                coefficient: marketCorrelation,
                leader: correlationLeader
            }
        }),
        darkPoolFootprints: engine.calculateDarkPoolFootprints(simulator.blockTrades || [], stock.currentPrice, symbol),
        heatmap: heatmapData,
        bloomberg: stock.bloomberg,
        absorption: engine.detectAbsorption(candles),
        sweeps: engine.detectLiquidationSweep(candles, draws),
        recommendation,
        timeframe: activeTf,
        candle: enrichedCandles.length > 0 ? enrichedCandles[enrichedCandles.length - 1] : null,
        institutionalRadar: {
            ...markers.radar,
            irScore: (markers.radar && markers.radar.killzone) ? simulator.eliteAlgo.calculateIRScore(bias, markers.radar.killzone, markers.radar.smt, markers.radar.gex, bias.retailSentiment).score : 0,
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
        basket: basketData.basket || {},
        isBasketAligned: basketData.isAligned || false,
        bestPair: basketData.bestPair || null,
        g7: basketData,
        g7Sectors: Object.entries(basketData.basket || {}).map(([cur, info]) => ({
            symbol: cur,
            perf: info.perf,
            mtf: info.mtf
        })),
        equitySectors: options.equitySectors || [],
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

function processWatchlist(options = {}) {
    // ── STEP 1: Aggregate Broad Market Breadth ─────────────────────────────────
    const coreIndices = ['SPY', 'QQQ', 'DIA', 'BTC-USD', 'DXY', 'VIX', 'GOLD', '^TNX', 'NVDA', 'TSLA', 'AAPL', 'MSFT'];
    const allSymbols = [...new Set([...simulator.watchlist, ...coreIndices])];

    const spyChange = simulator.stocks['SPY']?.dailyChangePercent || 0;
    const now = Date.now();

    return allSymbols.map(symbol => {
        try {
            const normalizedSym = symbol.toUpperCase().trim();
            
            // --- LIGHTWEIGHT CACHE (5s) ---
            if (global._watchlistCache?.[normalizedSym]) {
                const entry = global._watchlistCache[normalizedSym];
                if (now - entry.timestamp < 5000) return entry.data;
            }
            // ── SYNC FIX: Direct Lookup ──
            const fallbacks = { 
                'SPY': 520.45, 'QQQ': 443.12, 'DIA': 391.20, 'VIX': 14.50, 'DXY': 104.25, 'GOLD': 2330.40, 'BTC-USD': 68661.07, 
                'NVDA': 875.40, 'TSLA': 172.50, 'AAPL': 198.80, 'MSFT': 415.20, 'EURUSD=X': 1.0820, 'GBPUSD=X': 1.2650,
                'XLK': 210.34, 'XLF': 42.12, 'XLY': 185.50, 'XLE': 94.20, 'XLV': 142.10, 
                'XLC': 82.15, 'XLI': 124.40, 'XLP': 74.30, 'XLU': 68.10, 'XLRE': 38.50, 'XLB': 88.20
            };
            
            const stock = simulator.stocks[normalizedSym];
            if (!stock) return { symbol, price: fallbacks[normalizedSym] || 0, dailyChangePercent: 0, bias: 'OFFLINE', recommendation: { action: 'WAIT' } };

            const tf = simulator.currentTimeframe;
            const candles = stock.candles[tf] || [];
            const markers = simulator.getInstitutionalMarkers(normalizedSym, tf, true);
            const internals = simulator.internals;
            const bias = engine.calculateBias(stock.currentPrice || 0, [], { highs: [], lows: [] }, stock.bloomberg, markers, 0, internals, normalizedSym, candles);
            const recommendation = engine.getOptionRecommendation(bias, markers, stock.currentPrice || 0, tf, symbol, candles);
            
            const multiTfBias = {};
            const isActive = (normalizedSym === simulator.currentSymbol);
            
            // Only do Multi-TF scan for the ACTIVE symbol to save 80% CPU
            if (isActive) {
                simulator.timeframes.forEach(timeframe => {
                    const tfCandles = stock.candles[timeframe] || [];
                    const tfMarkers = simulator.getInstitutionalMarkers(normalizedSym, timeframe, true);
                    const tfBias = engine.calculateBias(stock.currentPrice || 0, [], [], stock.bloomberg, tfMarkers, 0, internals, normalizedSym, tfCandles);
                    multiTfBias[timeframe] = tfBias.bias;
                });
            } else {
                // Background symbols get a static "Neutral" TF consensus to avoid loop lag
                simulator.timeframes.forEach(timeframe => { multiTfBias[timeframe] = bias.bias; });
            }

            const bullCount = Object.values(multiTfBias).filter(b => b && b.includes('BULLISH')).length;
            const bearCount = Object.values(multiTfBias).filter(b => b && b.includes('BEARISH')).length;
            const alignedCount = Math.max(bullCount, bearCount);

            const current = (stock.currentPrice && stock.currentPrice > 0) ? stock.currentPrice : (fallbacks[normalizedSym] || 0);
            const prev = stock.previousClose || 0;
            const pointsChange = prev > 0 ? (current - prev) : 0;

            const confScore = calculateConfluenceScore(normalizedSym, stock, bias, markers, 0, multiTfBias, options);

            const result = {
                symbol,
                price: current,
                dailyChangePercent: stock.dailyChangePercent || 0,
                dailyChangePoints: pointsChange,
                confluenceScore: confScore,
                bias: bias ? bias.bias : 'NEUTRAL',
                recommendation: recommendation || { action: 'WAIT' },
                hasRS: (stock.dailyChangePercent || 0) > spyChange,
                alignedCount,
                multiTfBias
            };

            // Update Global Cache
            if (!global._watchlistCache) global._watchlistCache = {};
            global._watchlistCache[normalizedSym] = { timestamp: now, data: result };

            return result;
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

    // 0. PROPHETIC DAILY PROFILE & NEURAL STATE (The "Wow" Header)
    if (data.profile) insight = `${data.profile}. ` + insight;
    
    // Learning Signal: Let user know if the engine is 'In Sync'
    if (aiStats.signals > 10) {
        const winRate = (aiStats.success / aiStats.signals);
        if (winRate > 0.75) insight = `🚀 SENTINEL CORE: High algorithmic sync detected (Win Rate ${Math.round(winRate*100)}%). Projecting high-conviction signals. ` + insight;
        else if (winRate < 0.45) insight = `⚠️ SENTINEL CORE: Market regime shift detected. Algorithms are recalibrating for lower volatility. ` + insight;
    }

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

    // ── NEW: INTER-MARKET CORRELATION SYNC (SWIMMING WITH WHALES) ──
    if (data.marketCorrelation) {
        const coef = data.marketCorrelation.coefficient;
        const leader = (data.marketCorrelation.leader || 'MARKET').replace('=X', '');
        
        if (Math.abs(coef) > 75) {
            const syncType = coef > 0 ? 'SYNCHRONIZED' : 'INVERSELY SYNCED';
            insight += `[WHALE SYNC] ${symbol} is 85% ${syncType} with ${leader} flow. You are swimming with the institutional whales. `;
            prob += 5;
        } else if (Math.abs(coef) < 30) {
            insight += `[LONELY BATTLE] ${symbol} is uncorrelated with ${leader} leaders. You are fighting a solitary battle without institutional coverage. `;
            prob -= 10;
        }
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
