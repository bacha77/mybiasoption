import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { LiquidityEngine } from './logic/liquidity-engine.js';
import { RealDataManager } from './services/real-data-manager.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

import { telegram } from './services/telegram-service.js';

const engine = new LiquidityEngine();
const simulator = new RealDataManager();
const lastAlerts = new Map();

async function startServer() {
    console.log("Starting BIAS Strategy Server...");
    await simulator.initialize();

    // Serve static dashboard
    app.use(express.static(path.join(__dirname, '../public')));
    app.use(express.json());

    // Dynamic symbol management API
    app.post('/api/watchlist/add', async (req, res) => {
        const { symbol } = req.body;
        if (symbol) {
            await simulator.addSymbol(symbol);
            res.json({ success: true, watchlist: simulator.watchlist });
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

    // SSE / WebSocket updates
    io.on('connection', (socket) => {
        console.log('Client connected to BIAS dashboard');

        const initialData = processData();
        socket.emit('init', { ...initialData, watchlist: processWatchlist() });

        socket.on('switch_timeframe', (tf) => {
            if (simulator.timeframes.includes(tf)) {
                simulator.currentTimeframe = tf;
                socket.emit('tf_updated', { timeframe: tf, watchlist: processWatchlist() });
            }
        });

        socket.on('switch_symbol', (symbol) => {
            if (simulator.watchlist.includes(symbol)) {
                simulator.currentSymbol = symbol;
                socket.emit('symbol_updated', { symbol, watchlist: processWatchlist() });
            }
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

            // Telegram Alert Logic - Check all symbols in watchlist
            simulator.watchlist.forEach(symbol => {
                const stockData = processData(symbol);
                const rec = stockData.recommendation;

                if (rec) {
                    if (rec.action !== 'WAIT') {
                        console.log(`[${symbol}] ACTION: ${rec.action} | Stable: ${rec.isStable} | Bias: ${stockData.bias.score}`);
                    } else {
                        // Periodic debug for first few symbols to see why they WAIT
                        if (symbol === 'SPY' || symbol === 'NVDA') {
                            const m = stockData.markers;
                            console.log(`[DEBUG ${symbol}] Price: ${stockData.currentPrice} | VWAP: ${m.vwap.toFixed(2)} | POC: ${m.poc.toFixed(2)} | Rationale: ${rec.rationale}`);
                        }
                    }
                }

                // --- TELEGRAM ALERT LOGIC (GOLD STANDARD FILTER) ---
                // Requirement for Sellable Signals:
                // 1. Stable Signal (40+ seconds of consistent confluence)
                // 2. Trend Alignment (1m, 5m, 15m agreeing)
                // 3. High Confidence Score (80+)
                const isGoldStandard = rec && rec.isStable && stockData.checklist.trendAlign && (rec.confidence >= 80);

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

                    if (canSend) {
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
                        console.log(`[DEBUG ${symbol}] Potential signal bypassed: Stable=${rec.isStable} | TrendAlign=${stockData.checklist.trendAlign} | Conf=${rec.confidence}`);
                    }
                }

                // Exit Alert Logic
                if (rec && rec.exit) {
                    const exitKey = `${symbol}_EXIT_${rec.exit.action}_${Math.floor(Date.now() / 3600000)}`;
                    if (!lastAlerts.has(exitKey)) {
                        console.log(`--- EXIT DETECTED: ${symbol} ${rec.exit.action} ---`);
                        telegram.sendExitAlert(symbol, rec.exit).catch(() => { });
                        lastAlerts.set(exitKey, Date.now());
                    }
                }
            });

            // --- MIDNIGHT OPEN REPORT (DAILY AT 00:00 EST) ---
            const now = new Date();
            const nyTime = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
            const dateStr = nyTime.toDateString();
            const hour = nyTime.getHours();

            if (hour === 0 && lastAlerts.get('MIDNIGHT_REPORT') !== dateStr) {
                console.log("Generating Midnight Open Report...");
                const reportData = simulator.watchlist.map(symbol => {
                    const markers = simulator.getInstitutionalMarkers(symbol);
                    return { symbol, midnightOpen: markers.midnightOpen };
                }).filter(i => i.midnightOpen > 0);

                if (reportData.length > 0) {
                    await telegram.sendMidnightOpenReport(reportData).catch(() => { });
                    lastAlerts.set('MIDNIGHT_REPORT', dateStr);
                }
            }

            io.emit('update', { ...currentUpdate, watchlist: watchlistUpdate });
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
    });
}

function processData(symbol = simulator.currentSymbol) {
    const stock = simulator.stocks[symbol];
    if (!stock || !stock.candles[simulator.currentTimeframe] || stock.candles[simulator.currentTimeframe].length === 0) {
        return { symbol, loading: true };
    }

    const tf = simulator.currentTimeframe;
    const candles = stock.candles[tf];
    const fvgs = engine.findFVGs(candles);
    const draws = engine.findLiquidityDraws(candles);
    const bloomberg = stock.bloomberg;
    const markers = simulator.getInstitutionalMarkers(symbol, tf);

    // Calculate Relative Strength vs SPY
    const spy = simulator.stocks['SPY'];
    const relativeStrength = (spy && symbol !== 'SPY') ?
        engine.calculateRelativeStrength(candles, spy.candles[tf]) : 0;

    const internals = simulator.internals;
    const bias = engine.calculateBias(stock.currentPrice, fvgs, draws, bloomberg, markers, relativeStrength, internals);
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
            const tfBias = engine.calculateBias(stock.currentPrice, tfFvgs, tfDraws, bloomberg, tfMarkers, 0, internals);
            multiTfBias[timeframe] = tfBias.bias;
        } else {
            multiTfBias[timeframe] = 'NEUTRAL';
        }
    });

    // Checklist Highlights
    const trendAlign = (multiTfBias['15m'] === multiTfBias['5m']) && (multiTfBias['5m'] === multiTfBias['1m']) && multiTfBias['1m'] !== 'NEUTRAL';
    const sweepDetected = sweeps.length > 0;
    const stableSignal = recommendation.isStable;
    const rsCheck = relativeStrength > 0.05; // 0.05% outperformance threshold

    return {
        symbol,
        currentPrice: stock.currentPrice,
        dailyChangePercent: stock.dailyChangePercent,
        candles: candles.slice(-50),
        fvgs,
        draws,
        bias,
        heatmap,
        bloomberg,
        markers,
        absorption,
        sweeps,
        recommendation,
        timeframe: tf,
        multiTfBias,
        news: simulator.getNews(),
        session: engine.getSessionInfo(),
        checklist: {
            trendAlign,
            sweepDetected,
            stableSignal,
            relativeStrength: rsCheck
        }
    };
}

function processWatchlist() {
    return simulator.watchlist.map(symbol => {
        const stock = simulator.stocks[symbol];
        const tf = simulator.currentTimeframe;
        const candles = stock.candles[tf];
        const draws = (candles && candles.length > 0) ? engine.findLocalExtrema(candles.map(c => c.high), 'max').length : 0; // Simple check
        const bloomberg = stock.bloomberg;
        const markers = simulator.getInstitutionalMarkers(symbol, tf);
        const internals = simulator.internals;
        const bias = engine.calculateBias(stock.currentPrice, [], { highs: [], lows: [] }, bloomberg, markers, 0, internals);
        const recommendation = engine.getOptionRecommendation(bias, markers, stock.currentPrice, tf, symbol, candles);

        return {
            symbol,
            price: stock.currentPrice,
            dailyChangePercent: stock.dailyChangePercent,
            bias: bias.bias,
            omon: bloomberg.omon,
            recommendation
        };
    });
}

startServer().catch(err => {
    console.error("Critical server failure:", err);
});
