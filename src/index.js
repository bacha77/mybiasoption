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
            const currentUpdate = processData();
            const now = Date.now();
            let watchlistUpdate = (now - lastWatchlistEmit > 10000) ? processWatchlist() : null;
            if (watchlistUpdate) lastWatchlistEmit = now;

            const activeSignals = simulator.watchlist.map(sym => {
                const d = processData(sym);
                return (d.scalpScan && (parseFloat(d.scalpScan.velocity) > 1.5 || (d.alignedCount || 0) >= 3)) ? { symbol: sym, ...d.scalpScan, alignedCount: d.alignedCount } : null;
            }).filter(s => s !== null);
            
            if (activeSignals.length > 0) io.emit('scalper_pulse', { updates: activeSignals });

            const g7 = calculateG7Basket();
            const payload = {
                ...currentUpdate,
                blockTrades: simulator.blockTrades,
                sectors: processSectors(),
                basket: g7.basket,
                correlationMatrix: g7.correlationMatrix,
                eventPulse: newsService.getEventPulse(),
                orderFlowDOM: engine.calculateOrderFlowHeatmap(currentUpdate.currentPrice, currentUpdate.markers, 0),
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
        'CHF': 'USDCHF=X'
    };
    
    const timeframes = ['1m', '5m', '1h'];
    const basketByTf = {};

    timeframes.forEach(tf => {
        let sumReturns = 0;
        let count = 0;
        const results = {};

        Object.entries(rawPairs).forEach(([cur, sym]) => {
            const s = simulator.stocks[sym];
            if (s && s.candles[tf] && s.candles[tf].length > 1) {
                const candles = s.candles[tf];
                const start = candles[0].close;
                const end = candles[candles.length - 1].close;
                let perf = ((end - start) / start) * 100;
                
                if (['JPY', 'CAD', 'CHF'].includes(cur)) perf = -perf;
                results[cur] = perf;
                sumReturns += perf;
                count++;
            }
        });

        const usdStrength = count > 0 ? -(sumReturns / (count + 1)) : 0;
        basketByTf[tf] = { 'USD': usdStrength };
        Object.keys(results).forEach(cur => {
            basketByTf[tf][cur] = (results[cur] || 0) + usdStrength;
        });
    });

    // 1m is the "Primary" live strength
    const primary = basketByTf['1m'] || {};
    const finalBasket = {};

    Object.keys(primary).forEach(cur => {
        const mtf = {
            '1m': primary[cur] || 0,
            '5m': (basketByTf['5m'] && basketByTf['5m'][cur]) || 0,
            '1h': (basketByTf['1h'] && basketByTf['1h'][cur]) || 0
        };

        // Institutional Basket Levels: Find extremes in the 1h lookback
        const h1Basket = basketByTf['1h'] || {};
        const h1Perf = h1Basket[cur] || 0;

        finalBasket[cur] = {
            perf: primary[cur], // Current 1m strength
            mtf: mtf,
            symbol: rawPairs[cur] || 'DX-Y.NYB',
            // High/Low Basket Targets (Institutional Exhaustion Levels)
            isOverextended: Math.abs(primary[cur]) > 0.8,
            isSupplied: h1Perf > 1.2, // Strong demand zone
            isDepleted: h1Perf < -1.2 // Strong supply zone
        };
    });

    const correlationMatrix = engine.calculateG7CorrelationMatrix(finalBasket);

    return {
        basket: finalBasket,
        correlationMatrix
    };
}

function checkBasketAlignment() {
    const basket = calculateG7Basket();
    const strengths = Object.values(basket).map(v => v.perf);
    const extremePositive = strengths.filter(s => s > 0.35).length;
    const extremeNegative = strengths.filter(s => s < -0.35).length;
    const divergence = Math.max(...strengths) - Math.min(...strengths);
    
    // Aligned if we have clear strong vs clear weak (Divergence > 0.7%)
    return (extremePositive >= 1 && extremeNegative >= 1) && divergence > 0.7;
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

    const isForex = symbol.includes('=X') || symbol.includes('USD') || symbol === 'DX-Y.NYB';
    const dxyPrice = simulator.stocks['DX-Y.NYB']?.currentPrice || simulator.stocks['UUP']?.currentPrice || internals.dxy || 104.0;
    
    const bullCount = Object.values(multiTfBias).filter(b => b.includes('BULLISH')).length;
    const bearCount = Object.values(multiTfBias).filter(b => b.includes('BEARISH')).length;
    const alignedCount = Math.max(bullCount, bearCount);

    const finalConfScore = calculateConfluenceScore(symbol, stock, bias, markers, relativeStrength, multiTfBias);

    // --- 0DTE SIGNAL ENGINE ---
    const signal0DTE = engine.detect0DTESignal(candles, markers, stock.currentPrice, symbol, { ...bias, confluenceScore: finalConfScore }, internals);

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

    return {
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
        bias: { ...bias, internals },
        multiTfBias,
        signal0DTE, 
        expectedMove,
        darkPoolFootprints: engine.calculateDarkPoolFootprints(simulator.blockTrades || [], stock.currentPrice, symbol),
        heatmap: engine.calculateInstitutionalHeatmap(candles, markers, stock.currentPrice, symbol),
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
            alignedCount: alignedCount
        },
        news: simulator.getNews(),
        session: engine.getSessionInfo(symbol),
        forexRadar: isForex ? {
            dxyCorrelation,
            isInverseDxyRealm: Math.abs(dxyCorrelation) > 75,
            sessions: engine.getGlobalForexSessions(),
            po3Phase: bias.amdPhase,
            po3Progress: (engine.getKillzoneStatus()?.progress || 0),
            judasDetected: bias.judas || false,
            retailSentiment: bias.retailSentiment || 50
        } : null,
        sectors: processSectors(),
        scalpScan: { 
            velocity: ((Math.abs(markers.cvd || 0) / 1000).toFixed(1)), 
            signal: engine.detectInstitutionalReload(markers, candles) ? 'INSTITUTIONAL RELOAD' : 
                    engine.detectFireBreakout(markers, candles, bias) ? '🔥 FIRE BREAKOUT' : 'SEARCHING...',
            color: (markers.cvd > 0 ? '#10b981' : markers.cvd < 0 ? '#f43f5e' : '#94a3b8'),
            isReload: !!engine.detectInstitutionalReload(markers, candles),
            isFire: !!engine.detectFireBreakout(markers, candles, bias),
            intensity: (engine.detectInstitutionalReload(markers, candles)?.intensity || engine.detectFireBreakout(markers, candles, bias)?.intensity || 0)
        },
        heatmap: engine.calculateInstitutionalHeatmap(candles, markers, stock.currentPrice, symbol),
        volumeProfile: engine.calculateVolumeProfile(candles, stock.currentPrice, symbol),
        whaleTape: (simulator.blockTrades || []).find(b => b.symbol === symbol),
        blockTrades: simulator.blockTrades || [],
        overnightSentiment: simulator.calculateOvernightSentiment(symbol)
    };
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

            const bullCount = Object.values(multiTfBias).filter(b => b.includes('BULLISH')).length;
            const bearCount = Object.values(multiTfBias).filter(b => b.includes('BEARISH')).length;
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

startServer().catch(err => {
    logToFile(`Critical server failure: ${err.message}`);
});
