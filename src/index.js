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

    simulator.onPriceUpdateCallback = (symbol, price, change, candles) => {
        if (symbol === simulator.currentSymbol) {
            const latestCandle = candles[simulator.currentTimeframe]?.slice(-1)[0];
            io.emit('price_update', {
                symbol, price, change, candle: latestCandle
            });
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

    app.get('/debug-state', (req, res) => {
        res.json({
            internals: simulator.internals,
            sectors: processSectors(),
            isInitialized: simulator.isInitialized
        });
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

        socket.on('switch_timeframe', (tf) => {
            if (simulator.timeframes.includes(tf)) {
                simulator.currentTimeframe = tf;
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
            const currentUpdate = processData();
            const now = Date.now();
            let watchlistUpdate = (now - lastWatchlistEmit > 10000) ? processWatchlist() : null;
            if (watchlistUpdate) lastWatchlistEmit = now;

            const activeSignals = simulator.watchlist.map(sym => {
                const d = processData(sym);
                return (d.scalpScan && (parseFloat(d.scalpScan.velocity) > 1.5 || (d.alignedCount || 0) >= 3)) ? { symbol: sym, ...d.scalpScan, alignedCount: d.alignedCount } : null;
            }).filter(s => s !== null);
            
            if (activeSignals.length > 0) io.emit('scalper_pulse', { updates: activeSignals });

            const payload = {
                ...currentUpdate,
                blockTrades: simulator.blockTrades,
                sectors: processSectors(),
                basket: calculateG7Basket(),
                isBasketAligned: checkBasketAlignment()
            };
            if (watchlistUpdate) payload.watchlist = watchlistUpdate;
            io.emit('update', payload);
        } catch (err) {
            logToFile(`Update Loop Error: ${err.message}`);
        } finally {
            setTimeout(runUpdateLoop, 2000);
        }
    };
    runUpdateLoop();
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
    const rawPairs = {
        'EUR': 'EURUSD=X', 'GBP': 'GBPUSD=X', 'JPY': 'USDJPY=X',
        'AUD': 'AUDUSD=X', 'CAD': 'USDCAD=X', 'NZD': 'NZDUSD=X',
        'CHF': 'USDCHF=X', 'DXY': 'DX-Y.NYB'
    };
    const basket = {};
    Object.entries(rawPairs).forEach(([cur, sym]) => {
        const s = simulator.stocks[sym];
        if (s) {
            let perf = s.dailyChangePercent || 0;
            // Normalize: If USDJPY goes UP, JPY is DOWN (weak)
            if (['JPY', 'CAD', 'CHF'].includes(cur)) perf = -perf;
            basket[cur] = { perf, symbol: sym };
        } else {
            basket[cur] = { perf: 0, symbol: sym };
        }
    });
    return basket;
}

function checkBasketAlignment() {
    const basket = calculateG7Basket();
    const perfs = Object.values(basket).map(v => v.perf).filter(p => p !== 0);
    if (perfs.length < 4) return false;
    const pos = perfs.filter(p => p > 0.05).length;
    const neg = perfs.filter(p => p < -0.05).length;
    return (pos >= 6 || neg >= 6);
}

function calculateConfluenceScore(symbol, stock, bias, markers, relativeStrength, multiTfBias) {
    let confScoreValue = 0;
    if (bias && bias.bias !== 'NEUTRAL') {
        const tfs = ['1m', '5m', '15m'];
        const matchCount = tfs.filter(t => multiTfBias[t] === bias.bias).length;
        confScoreValue += (matchCount / tfs.length) * 40;
        if (markers.midnightOpen > 0) {
            const isAbv = stock.currentPrice > markers.midnightOpen;
            if ((bias.bias === 'BULLISH' && isAbv) || (bias.bias === 'BEARISH' && !isAbv)) confScoreValue += 20;
        }
        if (markers.cvd !== undefined) {
             if ((bias.bias === 'BULLISH' && markers.cvd > 0) || (bias.bias === 'BEARISH' && markers.cvd < 0)) confScoreValue += 20;
        }
        if ((bias.bias === 'BULLISH' && relativeStrength > 0) || (bias.bias === 'BEARISH' && relativeStrength < 0)) confScoreValue += 20;
    }
    return Math.round(confScoreValue);
}

function processData(symbol = simulator.currentSymbol) {
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

    const bullCount = Object.values(multiTfBias).filter(b => b.includes('BULLISH')).length;
    const bearCount = Object.values(multiTfBias).filter(b => b.includes('BEARISH')).length;
    const alignedCount = Math.max(bullCount, bearCount);

    const finalConfScore = calculateConfluenceScore(symbol, stock, bias, markers, relativeStrength, multiTfBias);

    return {
        symbol,
        currentPrice: stock.currentPrice,
        dailyChangePercent: stock.dailyChangePercent,
        pythConfidence: stock.pythConfidence,
        priceDiscordance: stock.priceDiscordance,
        roro: internals.roro, 
        isRoroFlash: internals.isRoroFlash,
        roroDirection: internals.roroDirection,
        candles: candles.slice(-200),
        fvgs,
        draws,
        bias: { ...bias, internals },
        multiTfBias,
        heatmap: engine.calculateInstitutionalHeatmap(candles, markers, stock.currentPrice, symbol),
        bloomberg: stock.bloomberg,
        markers: {
            ...markers,
            radar: {
                ...markers.radar,
                irScore: markers.radar ? simulator.eliteAlgo.calculateIRScore(bias, markers.radar.killzone, markers.radar.smt, markers.radar.gex, bias.retailSentiment) : 0,
                amdPhase: bias.amdPhase,
                alignedCount: alignedCount,
                pythConfidence: stock.pythConfidence
            },
            dxy: simulator.stocks['DX-Y.NYB']?.currentPrice || simulator.stocks['UUP']?.currentPrice || internals.dxy || 104.0,
            dxyPrev: internals.dxyPrev || internals.dxy || 104.0,
            vix: simulator.stocks['^VIX']?.currentPrice || internals.vix || 15.0,
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
            alignedCount: alignedCount
        },
        news: simulator.getNews(),
        session: engine.getSessionInfo(symbol),
        sectors: processSectors(),
        scalpScan: { 
            velocity: ((Math.abs(markers.cvd || 0) / 1000).toFixed(1)), 
            signal: (Math.abs(markers.cvd || 0) > 1000 && stock.priceDiscordance > 20) ? 'INSTITUTIONAL RELOAD' : 
                    (Math.abs(markers.cvd || 0) > 1000 && stock.priceDiscordance < 10) ? '🔥 FIRE BREAKOUT' : 'SEARCHING...',
            color: (markers.cvd > 0 ? '#10b981' : markers.cvd < 0 ? '#f43f5e' : '#94a3b8'),
            isReload: (Math.abs(markers.cvd || 0) > 1000 && stock.priceDiscordance > 20)
        },
        blockTrades: simulator.blockTrades || []
    };
}

function processWatchlist() {
    const spy = simulator.stocks['SPY'];
    const spyChange = spy ? spy.dailyChangePercent : 0;

    return simulator.watchlist.map(symbol => {
        try {
            let normalizedSym = symbol.toUpperCase().trim();
            if (normalizedSym === 'BTCUSD') normalizedSym = 'BTC-USD';
            if (normalizedSym === 'EURUSD') normalizedSym = 'EURUSD=X';
            if (normalizedSym === 'GBPUSD') normalizedSym = 'GBPUSD=X';
            if (normalizedSym === 'USDJPY') normalizedSym = 'USDJPY=X';
            if (normalizedSym === 'DXY' || normalizedSym === 'DX-Y') normalizedSym = 'DX-Y.NYB';

            const stock = simulator.stocks[normalizedSym];
            if (!stock) return { symbol, price: 0, bias: 'OFFLINE', recommendation: { action: 'WAIT' } };

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

            const bullCount = Object.values(multiTfBias).filter(b => b.includes('BULLISH')).length;
            const bearCount = Object.values(multiTfBias).filter(b => b.includes('BEARISH')).length;
            const alignedCount = Math.max(bullCount, bearCount);

            return {
                symbol,
                price: stock.currentPrice || 0,
                dailyChangePercent: stock.dailyChangePercent || 0,
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

startServer().catch(err => {
    logToFile(`Critical server failure: ${err.message}`);
});
