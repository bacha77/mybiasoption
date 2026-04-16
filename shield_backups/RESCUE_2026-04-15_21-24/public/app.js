/**
 * B.I.A.S Terminal | Institutional Positioning & Trading Intelligence Suite
 * (C) 2026 - Advanced Institutional Signal Engine
 * Version 4.0.0 - STABILIZED & UNIFIED
 */

// --- Global State ---
let socket;
let currentSymbol = 'SPY';
let currentTimeframe = '1m';
let chart, candleSeries;
let priceLines = [];
const TG_ENTRY_KEY = 'bias_tg_entry_price';
window._tgEntryPrice = parseFloat(localStorage.getItem(TG_ENTRY_KEY)) || 0;
let _voiceEnabled = false;
let _lastSquawkState = "";
window._chartLoaded = false;

// --- Initialization ---
document.addEventListener('DOMContentLoaded', () => {
    console.log('[SYSTEM] Initializing B.I.A.S Elite Terminal...');
    
    // 1. Initialize Chart
    initChart();
    
    // 2. Setup Socket
    socket = io();
    setupSocketListeners();
    
    // 3. Setup UI Controls
    setupUIControls();
    
    // 4. Start Clocks
    startNYClock();
    
    // 5. Restore State
    restoreEntryTracker();
    
    showToast('B.I.A.S ELITE: ENGINE SYNCED', 'toast-gold');
});

// --- Chart Engine ---
function initChart() {
    const container = document.getElementById('priceChart');
    if (!container) return;

    if (chart) chart.remove();

    chart = LightweightCharts.createChart(container, {
        width: container.clientWidth,
        height: 600,
        layout: { 
            background: { type: 'solid', color: '#000000' }, 
            textColor: '#94a3b8', 
            fontSize: 11, 
            fontFamily: 'JetBrains Mono' 
        },
        grid: { 
            vertLines: { color: 'rgba(56, 189, 248, 0.04)' }, 
            horzLines: { color: 'rgba(56, 189, 248, 0.04)' } 
        },
        crosshair: { 
            mode: LightweightCharts.CrosshairMode.Normal, 
            vertLine: { labelBackgroundColor: '#38bdf8', color: 'rgba(56, 189, 248, 0.4)', labelVisible: true }, 
            horzLine: { labelBackgroundColor: '#38bdf8', color: 'rgba(56, 189, 248, 0.4)', labelVisible: true } 
        },
        timeScale: { 
            borderColor: 'rgba(255,255,255,0.08)', 
            timeVisible: true, 
            secondsVisible: false, 
            barSpacing: 8,
            rightOffset: 12
        },
        handleScroll: { vertTouchDrag: false },
        handleScale: { axisPressedMouseMove: true }
    });

    candleSeries = chart.addCandlestickSeries({
        upColor: '#00f2ff', 
        downColor: '#ff0055',
        borderVisible: false, 
        wickUpColor: '#00f2ff', 
        wickDownColor: '#ff0055',
        priceFormat: { type: 'price', precision: 2, minMove: 0.01 }
    });

    chart.priceScale('right').applyOptions({ 
        borderColor: 'rgba(255,255,255,0.08)', 
        textColor: '#94a3b8',
        autoScale: true,
        alignLabels: true
    });

    window.addEventListener('resize', () => {
        if (chart && container) chart.applyOptions({ width: container.clientWidth });
    });

    const zoomIn = document.getElementById('zoom-in-btn');
    const zoomOut = document.getElementById('zoom-out-btn');
    if (zoomIn) zoomIn.onclick = () => chart.timeScale().zoomIn(0.2);
    if (zoomOut) zoomOut.onclick = () => chart.timeScale().zoomOut(0.2);
}

function loadChartHistory(symbol, tf) {
    if (!candleSeries) return;
    const sym = symbol.toUpperCase().trim();
    const ts = Date.now();
    
    // ANTI-FLICKER: Don't reload if already loading the same symbol/tf
    if (window._currentLoading === `${sym}_${tf}`) return;
    window._currentLoading = `${sym}_${tf}`;

    fetch(`/api/history?symbol=${encodeURIComponent(sym)}&tf=${encodeURIComponent(tf)}&t=${ts}`)
        .then(r => r.json())
        .then(data => {
            window._currentLoading = null;
            if (Array.isArray(data) && data.length > 0) {
                // ── CRITICAL: STRICT TIMESTAMP SORTING ──
                // Lightweight charts WILL crash if candles are out of order
                const sortedData = data
                    .filter(c => c.time !== undefined && c.close !== undefined)
                    .sort((a, b) => a.time - b.time);

                console.log(`[CHART] Successfully loaded ${sortedData.length} candles for ${sym}`);
                
                try {
                    candleSeries.setData(sortedData);
                    chart.timeScale().fitContent();
                    window._chartLoaded = true;
                } catch (e) {
                    console.error('[CHART] setData Error (Structural):', e);
                }
                
                // Update precision for FX
                const isFX = sym.includes('=X') || sym.includes('USD') || sym === 'DXY' || sym === 'DX-Y.NYB';
                candleSeries.applyOptions({
                    priceFormat: {
                        precision: isFX ? 5 : 2,
                        minMove: isFX ? 0.00001 : 0.01
                    }
                });
            } else {
                console.warn(`[CHART] Received empty history for ${sym}.`);
            }
        })
        .catch(err => {
            window._currentLoading = null;
            console.error('[CHART] History Load Error:', err);
        });
}

// --- Socket Handlers ---
function setupSocketListeners() {
    socket.on('connect', () => {
        console.log('[SOCKET] Connected to Institutional Server');
        updateSystemStatus(true);
        socket.emit('join_symbol', { symbol: currentSymbol });
        
        // Backfill history on reconnect
        loadChartHistory(currentSymbol, currentTimeframe);
    });

    socket.on('disconnect', () => {
        console.warn('[SOCKET] Disconnected');
        updateSystemStatus(false);
    });

    socket.on('update', (data) => {
        if (!data) return;
        
        // 1. Benchmark Ribbon Updates
        if (data.updates) updateMarketTickerRibbon(data.updates);
        if (data.sectors) updateMarketTickerRibbon(data.sectors);
        
        // 2. Symbol-Specific Updates
        if (data.symbol === currentSymbol || data.isBatch || (!data.symbol && data.currentPrice)) {
            updateTerminalBoard(data);
        }
    });

    socket.on('init', (data) => {
        console.log('[SOCKET] Init payload received');
        if (data.symbol) currentSymbol = data.symbol;
        updateTerminalBoard(data);
    });

    socket.on('price_updated', (data) => {
        if (!data) return;

        // 1. Always process global metrics (Watchlist, Sentiment)
        if (data.watchlist) updateWatchlistUI(data.watchlist);
        if (data.boardSentiment) updateSentinelCore(data);
        if (data.updates) updateMarketTickerRibbon(data.updates);

        // 2. Chart-Specific Updates
        if (data.symbol === currentSymbol || data.isBatch) {
            if (candleSeries && data.candle) {
                try {
                    // --- 🛡️ UPDATE GUARD: CRITICAL FOR STABILITY ---
                    // LightweightCharts strictly requires time >= last candle's time.
                    // If we receive an older candle (e.g. from a slightly delayed socket), it WILL crash.
                    const lastData = candleSeries.data ? candleSeries.data() : [];
                    const lastTime = lastData.length > 0 ? lastData[lastData.length - 1].time : 0;
                    
                    if (data.candle.time >= lastTime) {
                        candleSeries.update(data.candle);
                    }
                } catch (e) {
                    // Silently absorb sequence conflicts to keep terminal active
                }
            }
            try {
                updateTerminalBoard(data);
            } catch (e) {
                console.error('[SYSTEM] Terminal Board Render Exception:', e);
            }
        }
    });

    socket.on('sectors_update', (data) => {
        if (data.sectors) updateMarketTickerRibbon(data.sectors);
        if (data.basket) updateG7SpiderMatrix(data.basket);
        if (data.watchlist) updateWatchlistUI(data.watchlist);
    });
}

// --- Board Orchestrator ---
function updateTerminalBoard(data) {
    if (!data) return;

    // ── STRICTION CROSS-SYMBOL GUARD ──
    // We ONLY update the main chart and HUD if the incoming symbol matches our active focus.
    // Background pulses for other symbols should ONLY touch the Watchlist or Global Sentiment.
    if (data.symbol && data.symbol !== currentSymbol && !data.isInit) {
        // This is a background update for another ticker. Skip chart/HUD impact.
        return;
    }

    if (candleSeries) {
        // --- 🛡️ SINGLE SOURCE OF TRUTH: History Loading ---
        // We only call setData in loadChartHistory to prevent race-condition crashes.
        // updateTerminalBoard should only handle incremental 'update' packets.
        if (data.candle) {
            try {
                const lastData = candleSeries.data ? candleSeries.data() : [];
                const lastTime = lastData.length > 0 ? lastData[lastData.length - 1].time : 0;
                if (data.candle.time >= lastTime) {
                    candleSeries.update(data.candle);
                }
            } catch (e) {}
        }
    }

    // 2. HUD & Basic Metrics
    updateHUD(data);
    
    // 3. Marker System (Price lines & stats)
    if (data.markers) {
        updateMarkersUI(data.markers, currentSymbol);
        updateChartPriceLines(data.markers, currentSymbol);
    }

    // 4. Institutional Matrices
    if (data.g7Sectors) updateG7SpiderMatrix(data.g7Sectors);
    if (data.basket) updateG7SpiderMatrix(data.basket);
    if (data.equitySectors) updateEquitySpiderMatrix(data.equitySectors);
    
    // 5. Sentiment & Analysis
    if (data.institutionalSentiment) updateCotUI(data.institutionalSentiment, currentSymbol);
    if (data.analysis) updateAIAnalyst(data.analysis);
    if (data.watchlist) updateWatchlistUI(data.watchlist);
    
    // 6. Bias & Confluence
    const score = data.confluenceScore !== undefined ? data.confluenceScore : (data.analysis?.confluenceScore);
    if (score !== undefined) updateConfluenceUI(score);
    
    // 7. Badges
    updateBadges(data);
    
    // 8. Other cards
    if (data.roro !== undefined || data.internals) updateMacroCorrelation(data);
    if (data.session) updateSessionRadar(data.session);

    // 9. Sentinel Core Evaluation (Expert System)
    updateSentinelCore(data);

    // 10. Tier 1 Institutional Edge Panel (The missing link)
    if (data.markers) {
        updateTier1EdgePanel(data.markers, currentSymbol);
        updateGlobalOvernightPulse(data.markers.overnight);
        updateInstitutionalRadar(data.markers.radar, data.confluenceScore, data);
    }
}

// --- Specific UI Handlers ---

function updateHUD(data) {
    const price = data.currentPrice || data.price || 0;
    const change = data.dailyChangePercent || 0;
    const sym = data.symbol || currentSymbol;

    const priceEl = document.getElementById('current-price');
    const changeEl = document.getElementById('price-change');
    const symbolEl = document.getElementById('symbol-display');

    if (priceEl && price > 0) {
        const isFX = sym.includes('=X') || sym.includes('USD');
        priceEl.innerText = isFX ? price.toFixed(5) : price.toFixed(2);
    }
    if (changeEl) {
        const sign = change >= 0 ? '+' : '';
        changeEl.innerText = `${sign}${change.toFixed(2)}%`;
        changeEl.className = change >= 0 ? 'main-change bullish-text' : 'main-change bearish-text';
    }
    if (symbolEl) symbolEl.innerText = sym.replace('=X', '');
}

function updateMarketTickerRibbon(updates) {
    if (!updates) return;
    const items = Array.isArray(updates) ? updates : [updates];
    
    items.forEach(item => {
        let sym = item.symbol;
        if (!sym) return;

        // Normalize
        const displaySym = sym.replace('=X', '').replace('^', '').replace('DX-Y.NYB', 'DXY');
        const rootSym = sym === 'DX-Y.NYB' ? 'DXY' : (sym === 'GC=F' ? 'GOLD' : displaySym);

        const priceEl = document.getElementById(`pr-${rootSym}`);
        const pointsEl = document.getElementById(`pt-${rootSym}`);
        const changeEl = document.getElementById(`pc-${rootSym}`);
        const pulse = document.getElementById(`p-${rootSym}`);

        if (!priceEl) return;

        const price = item.price || item.currentPrice || 0;
        const change = item.dailyChangePercent !== undefined ? item.dailyChangePercent : (item.change || 0);
        const points = item.dailyChangePoints || item.changePoints || 0;

        const isFX = sym.includes('=X') || sym === 'DX-Y.NYB' || sym === 'BTC-USD';
        priceEl.innerText = price > 0 ? (isFX ? price.toFixed(4) : price.toFixed(2)) : '--';
        
        if (pointsEl) {
            pointsEl.innerText = (points >= 0 ? '+' : '') + points.toFixed(2);
            pointsEl.className = points >= 0 ? 't-points bullish-text' : 't-points bearish-text';
        }
        if (changeEl) {
            changeEl.innerText = (change >= 0 ? '+' : '') + change.toFixed(2) + '%';
            changeEl.className = change >= 0 ? 't-change bullish-text' : 't-change bearish-text';
        }
        if (pulse && price > 0) {
            pulse.classList.remove('active');
            void pulse.offsetWidth;
            pulse.classList.add('active');
        }
    });
}

function updateG7SpiderMatrix(basket) {
    if (!basket) return;
    const grid = document.getElementById('spider-grid');
    if (!grid) return;

    // Handle both Array and Object formats
    const currencies = Array.isArray(basket) ? basket : Object.entries(basket).map(([sym, d]) => ({ symbol: sym, ...d }));

    currencies.forEach(curData => {
        const node = grid.querySelector(`[data-cur="${curData.symbol}"]`);
        if (!node) return;

        const valEl = node.querySelector('.val');
        const fillEl = node.querySelector('.strength-bar-fill');
        const badge = node.querySelector('.exhaustion-badge');
        const perf = curData.perf || 0;

        if (valEl) {
            valEl.innerText = `${perf >= 0 ? '+' : ''}${perf.toFixed(2)}%`;
            valEl.style.color = perf >= 0 ? 'var(--bullish)' : 'var(--bearish)';
        }

        if (fillEl) {
            const width = Math.min(100, Math.max(0, 50 + (perf * 50)));
            fillEl.style.width = width + '%';
            fillEl.style.background = perf >= 0 ? 'var(--bullish)' : 'var(--bearish)';
        }

        // MTF Dots
        if (curData.mtf) {
            ['1m', '5m', '1h'].forEach(tf => {
                const dot = node.querySelector(`.tf-dot[data-tf="${tf}"]`);
                if (dot) {
                    const impulse = curData.mtf[tf] || 0;
                    dot.style.background = impulse > 0 ? 'var(--bullish)' : (impulse < 0 ? 'var(--bearish)' : 'rgba(255,255,255,0.1)');
                }
            });
        }
    });

    // Update Header
    const sorted = [...currencies].sort((a,b) => (b.perf || 0) - (a.perf || 0));
    if (sorted.length > 0) {
        const top = sorted[0];
        const weak = sorted[sorted.length-1];
        setEl('g7-top-cur', top.symbol);
        setEl('g7-top-val', `${top.perf >= 0 ? '+' : ''}${top.perf.toFixed(2)}%`);
        setEl('g7-weak-cur', weak.symbol);
        setEl('g7-weak-val', `${weak.perf >= 0 ? '+' : ''}${weak.perf.toFixed(2)}%`);
        
        // Best Pair Logic
        setEl('g7-best-pair', `${top.symbol}/${weak.symbol}`);
        setEl('g7-best-dir', `LONG ${top.symbol}`);
    }
}

let spiderRadarChartInstance = null;

function updateEquitySpiderMatrix(sectors) {
    if (!sectors) return;
    const canvas = document.getElementById('spiderRadarCanvas');
    if (!canvas) return; // Wait for DOM if needed

    const data = Array.isArray(sectors) ? sectors : Object.values(sectors);
    
    // Sort alphabetically so the Radar shape stays consistent across ticks
    data.sort((a,b) => a.symbol.localeCompare(b.symbol));
    
    const labels = data.map(s => s.symbol);
    const rsData = data.map(s => s.relativeStrength || 0);
    const pointColors = rsData.map(rs => rs >= 0 ? '#00f2ff' : '#ff0055');

    if (!spiderRadarChartInstance) {
        // Initialize Radar Chart
        const ctx = canvas.getContext('2d');
        spiderRadarChartInstance = new Chart(ctx, {
            type: 'radar',
            data: {
                labels: labels,
                datasets: [{
                    label: 'Relative Strength',
                    data: rsData,
                    backgroundColor: 'rgba(56, 189, 248, 0.1)', // #38bdf8 w/ opacity
                    borderColor: '#38bdf8',
                    pointBackgroundColor: pointColors,
                    pointBorderColor: '#fff',
                    pointHoverBackgroundColor: '#fff',
                    pointHoverBorderColor: '#38bdf8',
                    borderWidth: 2,
                    fill: true
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    r: {
                        angleLines: { color: 'rgba(255, 255, 255, 0.1)' },
                        grid: { color: 'rgba(255, 255, 255, 0.1)' },
                        pointLabels: {
                            color: '#94a3b8',
                            font: { family: 'JetBrains Mono', size: 10, weight: 'bold' }
                        },
                        ticks: {
                            display: false,
                            backdropColor: 'transparent',
                        }
                    }
                },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        backgroundColor: 'rgba(0, 0, 0, 0.8)',
                        titleColor: '#fff',
                        bodyColor: '#38bdf8',
                        borderColor: 'rgba(255, 255, 255, 0.1)',
                        borderWidth: 1,
                        callbacks: {
                            label: function(context) {
                                const val = context.parsed.r;
                                return ` RS: ${val >= 0 ? '+' : ''}${val.toFixed(2)}%`;
                            }
                        }
                    }
                }
            }
        });
    } else {
        // Update live data matrix smoothly
        spiderRadarChartInstance.data.labels = labels;
        spiderRadarChartInstance.data.datasets[0].data = rsData;
        spiderRadarChartInstance.data.datasets[0].pointBackgroundColor = pointColors;
        spiderRadarChartInstance.update('none'); // Update without full layout animation to prevent stutter
    }

    // Update Header (Top / Weak Flow)
    const sorted = [...data].sort((a,b) => (b.relativeStrength || 0) - (a.relativeStrength || 0));
    if (sorted.length > 0) {
        const top = sorted[0];
        const weak = sorted[sorted.length-1];
        setEl('eq-top-cur', top.symbol);
        setEl('eq-top-val', `${top.relativeStrength >= 0 ? '+' : ''}${(top.relativeStrength || 0).toFixed(2)}% RS`);
        setEl('eq-weak-cur', weak.symbol);
        setEl('eq-weak-val', `${weak.relativeStrength >= 0 ? '+' : ''}${(weak.relativeStrength || 0).toFixed(2)}% RS`);
    }
}

function updateWatchlistUI(watchlist) {
    if (!watchlist || !Array.isArray(watchlist)) return;
    
    const stocksList = document.getElementById('stocks-list');
    const forexList = document.getElementById('forex-list');
    
    const equities = watchlist.filter(item => !item.symbol.includes('=X') && !item.symbol.includes('-USD') && !item.symbol.includes('^') && item.symbol !== 'DXY');
    const forexCrypto = watchlist.filter(item => item.symbol.includes('=X') || item.symbol.includes('-USD') || item.symbol === 'BTC-USD' || item.symbol === 'ETH-USD' || item.symbol === 'DXY');

    const renderItem = (item) => {
        const price = (item.price || 0).toFixed(item.symbol.includes('=X') ? 5 : 2);
        const change = item.dailyChangePercent || 0;
        const color = change >= 0 ? 'var(--bullish)' : 'var(--bearish)';
        const biasColor = (item.bias || 'NEUTRAL').includes('BULL') ? 'var(--bullish)' : ((item.bias || 'NEUTRAL').includes('BEAR') ? 'var(--bearish)' : 'var(--gold)');

        return `
            <div class="watchlist-item" onclick="switchSymbol('${item.symbol}')" style="display: flex; justify-content: space-between; align-items: center; padding: 10px 12px; border-bottom: 1px solid rgba(255,255,255,0.03); cursor: pointer; transition: background 0.2s;">
                <div class="sym" style="font-size: 0.75rem; font-weight: 800; color: #fff; letter-spacing: 0.5px;">${item.symbol.replace('=X', '')}</div>
                <div class="val-box" style="text-align: right;">
                    <div class="price" style="font-size: 0.75rem; font-weight: 900; font-family: 'JetBrains Mono', monospace; color: ${color};">${price}</div>
                    <div class="bias" style="font-size: 0.48rem; font-weight: 800; color: ${biasColor}; text-transform: uppercase; letter-spacing: 1px;">${item.bias || 'OFFLINE'}</div>
                </div>
            </div>
        `;
    };

    if (stocksList) {
        stocksList.innerHTML = equities.map(renderItem).join('');
        setEl('stocks-count', `${equities.length} TICKERS`, 0);
    }
    if (forexList) {
        forexList.innerHTML = forexCrypto.map(renderItem).join('');
        setEl('forex-count', `${forexCrypto.length} TICKERS`, 0);
    }
}

function updateMarkersUI(m, sym) {
    if (!m) return;
    const prec = sym.includes('=X') ? 5 : 2;
    setEl('midnight-open-val', m.midnightOpen, prec);
    setEl('pdh-val', m.pdh, prec);
    setEl('pdl-val', m.pdl, prec);
    setEl('vwap-val', m.vwap, prec);
    setEl('adr-val', m.adr, 2);
    setEl('call-wall-val', m.callWall, prec);
    setEl('put-wall-val', m.putWall, prec);
    setEl('expected-high-val', m.expectedHigh, prec);
    setEl('expected-low-val', m.expectedLow, prec);
    setEl('ote-sweet-spot-val', m.oteSweetSpot, prec);
    setEl('t1-vpoc-val', m.poc, prec);

    const imbBar = document.getElementById('imbalance-bar');
    const imbText = document.getElementById('imbalance-text');
    if (imbBar && m.whaleImbalance !== undefined) {
        const pct = 50 + (m.whaleImbalance / 2);
        imbBar.style.width = `${pct}%`;
        if (imbText) imbText.innerText = `${pct.toFixed(0)}% BULL / ${(100-pct).toFixed(0)}% BEAR`;
    }
}

function updateChartPriceLines(m, symbol) {
    if (!candleSeries || !m) return;
    priceLines.forEach(l => candleSeries.removePriceLine(l));
    priceLines = [];

    const addLine = (price, label, color, style = LightweightCharts.LineStyle.Dashed) => {
        if (!price || price <= 0) return;
        const line = candleSeries.createPriceLine({
            price: price, 
            color: color, 
            lineWidth: 1, 
            lineStyle: style, 
            axisLabelVisible: true, 
            title: label.toUpperCase(),
        });
        priceLines.push(line);
    };

    // ── PRIMARY HUD LEVELS (Titanium System) ──
    const isFX = symbol.includes('=X') || symbol.includes('USD');
    const p = isFX ? 5 : 2;

    if (m.callWall) addLine(m.callWall, 'CALL WALL', '#ff3e3e', LightweightCharts.LineStyle.Solid);
    if (m.vwap)     addLine(m.vwap,     'VWAP',      '#ff9d00', LightweightCharts.LineStyle.Solid);
    if (m.putWall)  addLine(m.putWall,  'PUT WALL',   '#10b981', LightweightCharts.LineStyle.Solid);
    
    if (m.midnightOpen) addLine(m.midnightOpen, 'MIDNIGHT OPEN', '#38bdf8', LightweightCharts.LineStyle.Dashed);
    if (m.pdh)          addLine(m.pdh,          'PDH',           '#ffffff', LightweightCharts.LineStyle.Dashed);
    if (m.pdl)          addLine(m.pdl,          'PDL',           '#ffffff', LightweightCharts.LineStyle.Dashed);

    // ── LIQUIDITY & VALUE ZONES ──
    if (m.poc)          addLine(m.poc,          'CONTROL HUB (POC)', '#a855f7', LightweightCharts.LineStyle.Solid);
    if (m.oteSweetSpot) addLine(m.oteSweetSpot, 'OTE SWEET SPOT',    '#f59e0b', LightweightCharts.LineStyle.Dashed);
    if (m.ote79)        addLine(m.ote79,        'OTE 79%',           '#f59e0b', LightweightCharts.LineStyle.Dashed);
    
    // ── PROJECTIONS ──
    if (m.expectedHigh)  addLine(m.expectedHigh, 'EXPECTED HIGH (68%)', '#00ff88', LightweightCharts.LineStyle.Dotted);
    if (m.darkpoolPoc)   addLine(m.darkpoolPoc,  'DARK POOL POC', '#38bdf8', LightweightCharts.LineStyle.Solid);

    // ── SESSION GUIDE MARKERS (Vertical Guidelines) ──
    const drawVerticalMarker = (time, label, color) => {
        if (!time) return;
        // Markers are bar-relative, so we find the bar index or timestamp
        // For simplicity, we use markers on the candle series at the top
        // But better is to just add a priceLine on a zero-volume series if needed.
        // Here we'll use candle markers as guided 'flags'
    };

    // Update Session Markers
    const markers = [];
    if (m.sessionPoints) {
        m.sessionPoints.forEach(p => {
            markers.push({
                time: p.time / 1000,
                position: 'aboveBar',
                color: p.color || '#38bdf8',
                shape: 'arrowDown',
                text: p.label
            });
        });
    }
    candleSeries.setMarkers(markers);
}

function updateConfluenceUI(score) {
    const formatted = (score || 0).toString().padStart(2, '0') + '%';
    const color = score >= 70 ? 'var(--bullish)' : (score <= 30 ? 'var(--bearish)' : 'var(--gold)');

    setEl('master-confluence-score', formatted);
    const scoreEl = document.getElementById('master-confluence-score');
    if (scoreEl) scoreEl.style.color = color;
    
    setEl('radar-ir-score', score.toString().padStart(2, '0'));
    const irScore = document.getElementById('radar-ir-score');
    if (irScore) irScore.style.color = color;

    const bar = document.getElementById('confidence-bar');
    if (bar) {
        bar.style.width = score + '%';
        bar.style.background = color;
    }
}

function updateBadges(data) {
    const m = data.markers || {};
    const b = data.analysis || {};
    const amdHud = document.getElementById('amd-hud');
    if (amdHud) {
        const phase = m.radar?.amdPhase || b.amdPhase || 'ACCUMULATION';
        amdHud.innerText = phase;
        amdHud.className = 'amd-hud ' + phase.toLowerCase();
    }

    const toggle = (id, active) => {
        const el = document.getElementById(id);
        if (el) el.style.display = active ? 'block' : 'none';
    };

    toggle('mss-badge', m.mss || b.mss);
    toggle('smt-badge', m.smt || b.smt);
    toggle('fvg-badge', m.fvg || b.fvg);
}

function updateAIAnalyst(analysis) {
    const aiEl = document.getElementById('loulou-response-text');
    if (aiEl && analysis.narrative) {
        aiEl.innerText = analysis.narrative;
    }
}

function updateCotUI(cot, sym) {
    const el = document.getElementById('cot-bias-val');
    const pctEl = document.getElementById('cot-sentiment-pct');
    const bar = document.getElementById('cot-sentiment-bar');
    if (!el || !cot) return;

    el.innerText = cot.bias || 'NEUTRAL';
    if (pctEl) pctEl.innerText = (cot.sentimentPct || 50).toFixed(1) + '%';
    if (bar) bar.style.width = (cot.sentimentPct || 50) + '%';
}

function updateMacroCorrelation(data) {
    const bar = document.getElementById('roro-bar');
    if (bar && data.roro !== undefined) bar.style.width = data.roro + '%';
    
    if (data.internals) {
        setEl('dxy-val-hud', data.internals.dxy, 2);
        setEl('vix-val-ticker', data.internals.vix, 2);
        setEl('tnx-val-hud', data.internals.tnx, 2);
    }
}

function updateSessionRadar(sess) {
    const nameEl = document.getElementById('radar-session-name');
    const progBar = document.getElementById('radar-session-progress');
    if (nameEl) {
        nameEl.innerText = sess.label || 'OFF-HOURS';
        nameEl.style.color = sess.isValid ? 'var(--gold)' : 'var(--text-dim)';
    }
    if (progBar && sess.progress !== undefined) {
        progBar.style.width = sess.progress + '%';
    }
}

// --- Voice Squawk Engine ---
function squawk(text) {
    if (!_voiceEnabled || !window.speechSynthesis) return;
    
    // Stop any existing speech to prevent stacking lag
    window.speechSynthesis.cancel();
    
    const msg = new SpeechSynthesisUtterance(text);
    msg.rate = 1.0;
    msg.pitch = 0.9; // Slightly deeper institutional tone
    msg.volume = 1.0;
    
    // Select a professional sounding voice if available
    const voices = window.speechSynthesis.getVoices();
    const targetVoice = voices.find(v => v.name.includes('Google US English') || v.name.includes('Male')) || voices[0];
    if (targetVoice) msg.voice = targetVoice;
    
    window.speechSynthesis.speak(msg);
}

// --- Sentinel Core Expert System ---
function updateSentinelCore(data) {
    if (!data) return;
    
    let conviction = 0;
    let rationale = [];
    let state = "EVALUATING";
    let stateDesc = "Scanning multidimensional flow...";
    
    const price = data.currentPrice || data.price || 0;
    const vwap = data.markers?.vwap || 0;
    const cvd = (data.hybridCVD !== undefined) ? data.hybridCVD : (data.markers?.cvd || 0);
    const flow = (data.netWhaleFlow !== undefined) ? data.netWhaleFlow : (data.markers?.netWhaleFlow || 0);
    
    // 0. SMT & Divergence Detection (Power Multiplier)
    let smtActive = data.markers?.smt || data.analysis?.smt || false;
    let divergenceDetected = data.markers?.macroDivergence?.active || false;

    // 1. VWAP Relation (±25)
    let vwapFactor = '';
    if (vwap > 0 && price > 0) {
        if (price > vwap) { conviction += 25; vwapFactor = 'ACTIVE'; rationale.push("Bullish VWAP hold."); }
        else { conviction -= 25; vwapFactor = 'DANGER'; rationale.push("Distribution below VWAP."); }
    }
    
    // 2. Hybrid CVD (±25)
    let cvdFactor = '';
    if (cvd > 500) { conviction += 25; cvdFactor = 'ACTIVE'; rationale.push("Aggressive accumulation."); }
    else if (cvd < -500) { conviction -= 25; cvdFactor = 'DANGER'; rationale.push("Aggressive distribution."); }
    else { cvdFactor = 'WARN'; }
    
    // 3. Net Whale Flow (±25)
    if (flow > 100000) { conviction += 25; rationale.push("Whale inflows detected."); }
    else if (flow < -100000) { conviction -= 25; rationale.push("Whale dumping detected."); }
    
    // 4. Timeframe Alignment (±25)
    const score = data.confluenceScore || (data.analysis?.confluenceScore) || 0;
    let tfFactor = 'WARN';
    if (score > 65) { conviction += 25; tfFactor = 'ACTIVE'; rationale.push("High macro sync."); }
    else if (score < 35) { conviction -= 25; tfFactor = 'DANGER'; rationale.push("Macro drag active."); }

    // Factor Update Helpers
    const setFactor = (id, fClass) => {
        const el = document.getElementById(id);
        if (el) {
            el.className = 'tg-factor';
            if (fClass === 'ACTIVE') el.classList.add('tg-active');
            else if (fClass === 'DANGER') el.classList.add('tg-danger');
            else if (fClass === 'WARN') el.classList.add('tg-warn');
        }
    };
    
    setFactor('tg-f-cvd', cvdFactor);
    setFactor('tg-f-vwap', vwapFactor);
    setFactor('tg-f-tf', tfFactor);
    setFactor('tg-f-abs', data.markers?.absorption ? (data.markers?.absorptionType === 'BULLISH' ? 'ACTIVE' : 'DANGER') : 'WARN');
    setFactor('tg-f-struct', data.markers?.mss ? (data.markers?.mssType === 'BULLISH' ? 'ACTIVE' : 'DANGER') : 'WARN');
    
    // Clamp Conviction Magnitude
    const absConviction = Math.min(Math.abs(conviction), 100);
    const meterEl = document.getElementById('tg-conviction-pct');
    const barEl = document.getElementById('tg-conviction-bar');
    const badgeEl = document.getElementById('tg-alert-badge');
    const actionText = document.getElementById('tg-action-text');
    const actionIcon = document.getElementById('tg-action-icon');
    
    if (meterEl) meterEl.innerText = `${absConviction}%`;
    if (barEl) {
        barEl.style.width = `${absConviction}%`;
        barEl.style.background = conviction > 0 ? 'var(--bullish)' : (conviction < 0 ? 'var(--bearish)' : 'var(--gold)');
    }

    // Final Judgement Logic
    let signalText = "";
    if (conviction >= 75) {
        state = "HIGH CONVICTION LONG";
        stateDesc = "Structural and flow alignment confirmed.";
        badgeEl.innerText = "BUY";
        badgeEl.style.background = "var(--bullish)";
        actionText.innerText = "AGGRESSIVE LONG - TOP TIER SEARCH";
        actionIcon.innerText = "🟢";
        signalText = "High conviction long signal detected.";
    } else if (conviction >= 25) {
        state = "BUILD LONG SKEW";
        stateDesc = "Retail traps detected. Seeking buy dips.";
        badgeEl.innerText = "PREP";
        badgeEl.style.background = "var(--gold)";
        actionText.innerText = "ACCUMULATE ON DISCOUNTED VWAP";
        actionIcon.innerText = "🟡";
        signalText = "Bias shifting bullish. Accumulate.";
    } else if (conviction <= -75) {
        state = "HIGH CONVICTION SHORT";
        stateDesc = "Sever institutional dumping active.";
        badgeEl.innerText = "SHORT";
        badgeEl.style.background = "var(--bearish)";
        actionText.innerText = "AGGRESSIVE SHORT - DARK POOL SYNC";
        actionIcon.innerText = "🔴";
        signalText = "High conviction short signal. Distribution active.";
    } else if (conviction <= -25) {
        state = "BUILD SHORT SKEW";
        stateDesc = "Distribution building. Seek exit or short.";
        badgeEl.innerText = "PREP";
        badgeEl.style.background = "var(--gold)";
        actionText.innerText = "DISTRIBUTE ON VWAP PREMIUM";
        actionIcon.innerText = "🟡";
        signalText = "Bias shifting bearish. Look for exits.";
    } else {
        state = "TACTICAL STANDBY";
        stateDesc = "Mixed signals. Institutions are balancing.";
        badgeEl.innerText = "HOLD";
        badgeEl.style.background = "transparent";
        actionText.innerText = "AWAIT VOLATILITY EXPANSION";
        actionIcon.innerText = "⚪";
    }

    // VOX Update (Squawk only on state changes)
    if (_voiceEnabled && state !== _lastSquawkState) {
        squawk(`${currentSymbol.replace('=X', '')}: ${signalText}`);
        _lastSquawkState = state;
    }

    // Display updates
    setEl('tg-state-label', state);
    const stateEl = document.getElementById('tg-state-label');
    if (stateEl) stateEl.style.color = conviction > 0 ? 'var(--bullish)' : (conviction < 0 ? 'var(--bearish)' : 'var(--text-main)');
    setEl('tg-state-desc', stateDesc);
    
    const rationaleEl = document.getElementById('tg-rationale');
    if (rationaleEl) rationaleEl.innerText = rationale.length > 0 ? rationale.slice(0, 2).join(" ") : "Monitoring adaptive variances...";

    // Contextual Loulou Logic Stream (Top aside)
    const logicTicker = document.getElementById('loulou-logic-ticker');
    if (logicTicker) {
        let logicMsg = rationale.length > 0 ? rationale.join(" | ") : "SYNCHRONIZING WITH MARKET REGIME...";
        if (smtActive) logicMsg = "⚠️ SMT DIVERGENCE DETECTED | " + logicMsg;
        if (divergenceDetected) logicMsg = "⚡ MACRO DIVERGENCE ACTIVE | " + logicMsg;
        logicTicker.innerText = logicMsg.toUpperCase();
    }
}

// --- Tier 1 Institutional Edge Panel Logic ---
function updateTier1EdgePanel(m, sym) {
    if (!m) return;
    const prec = sym.includes('=X') ? 5 : 2;

    // A. VWAP Bands
    if (m.vwapBands) {
        setEl('t1-vwap-zone', m.vwapBands.zone);
        setEl('t1-vwap-b1', m.vwapBands.upper1, prec);
        setEl('t1-vwap-b2', m.vwapBands.upper2, prec);
        const zoneEl = document.getElementById('t1-vwap-zone');
        if (zoneEl) {
            const z = m.vwapBands.zone.toUpperCase();
            if (z.includes('DISCOUNT')) zoneEl.style.color = 'var(--bullish)';
            else if (z.includes('PREMIUM')) zoneEl.style.color = 'var(--bearish)';
            else zoneEl.style.color = 'var(--gold)';
        }
    }

    // B. RVOL
    if (m.rvol) {
        setEl('t1-rvol-val', m.rvol.rvol.toFixed(2) + '×');
        setEl('t1-rvol-label', m.rvol.label);
        const bar = document.getElementById('t1-rvol-bar');
        const rValEl = document.getElementById('t1-rvol-val');
        if (bar) {
            const pct = Math.min(100, (m.rvol.rvol / 2) * 100);
            bar.style.width = pct + '%';
            const color = m.rvol.rvol > 1.5 ? 'var(--gold)' : (m.rvol.rvol < 0.8 ? 'var(--bearish)' : 'var(--bullish)');
            bar.style.background = color;
            if (rValEl) rValEl.style.color = color;
        }
    }

    // C. ORB
    if (m.orb) {
        setEl('t1-orb-label', m.orb.label);
        setEl('t1-orb-high', m.orb.orbHigh, prec);
        setEl('t1-orb-low', m.orb.orbLow, prec);
        const orbEl = document.getElementById('t1-orb-label');
        if (orbEl) {
            orbEl.style.color = m.orb.breakout === 'BULLISH' ? 'var(--bullish)' : (m.orb.breakout === 'BEARISH' ? 'var(--bearish)' : 'var(--text-dim)');
        }
    }

    // D. Gap Fill
    if (m.gapFill) {
        setEl('t1-gap-label', m.gapFill.label);
        setEl('t1-gap-prob-val', (m.gapFill.fillProb || 0) + '%');
        setEl('t1-gap-target', 'FILL TARGET: ' + (m.gapFill.fillTarget || '--'));
        const gapEl = document.getElementById('t1-gap-label');
        if (gapEl) {
            gapEl.style.color = m.gapFill.hasGap ? 'var(--gold)' : 'var(--text-dim)';
        }
    }

    // E. Equal Highs/Lows
    if (m.equalLevels) {
        const eqh = m.equalLevels.equalHighs?.[0]?.level || '--';
        const eql = m.equalLevels.equalLows?.[0]?.level || '--';
        setEl('t1-eq-highs', 'EQH: ' + eqh);
        setEl('t1-eq-lows', 'EQL: ' + eql);
    }

    // F. Volatility Regime
    if (m.adr !== undefined) {
        const adrLabel = m.adr > 1.5 ? 'HIGH VOL' : (m.adr > 0.8 ? 'NORMAL' : 'LOW VOL');
        setEl('t1-vol-regime-label', adrLabel);
        setEl('t1-vol-ratio', 'ATR RATIO: ' + (m.adr || 0).toFixed(2));
        const vBar = document.getElementById('t1-vol-regime-bar');
        const vLabelEl = document.getElementById('t1-vol-regime-label');
        if (vBar) {
            const vPct = Math.min(100, (m.adr / 3) * 100);
            vBar.style.width = vPct + '%';
            const vColor = m.adr > 1.5 ? 'var(--bearish)' : (m.adr > 0.8 ? 'var(--gold)' : 'var(--bullish)');
            vBar.style.background = vColor;
            if (vLabelEl) vLabelEl.style.color = vColor;
        }
    }

    // G. VPOC
    if (m.vpoc) {
        setEl('t1-vpoc-val', m.vpoc.vpoc, prec);
        setEl('t1-vpoc-zone', m.vpoc.currentZone);
        setEl('t1-vpoc-vah', m.vpoc.vah, prec);
        setEl('t1-vpoc-val-span', m.vpoc.val, prec);
        const vpocEl = document.getElementById('t1-vpoc-zone');
        if (vpocEl) {
            vpocEl.style.color = m.vpoc.currentZone === 'VALUE AREA' ? 'var(--gold)' : (m.vpoc.currentZone === 'PREMIUM' ? 'var(--bearish)' : 'var(--bullish)');
        }
    }

    // H. Macro Divergence
    if (m.macroDivergence) {
        setEl('t1-macro-label', m.macroDivergence.label || 'ALIGNED');
        setEl('t1-macro-rat', m.macroDivergence.rationale || 'Yields pricing aligns with equities.');
        const macroEl = document.getElementById('t1-macro-label');
        if (macroEl) {
            macroEl.style.color = m.macroDivergence.active ? 'var(--bearish)' : 'var(--text-dim)';
        }
    }
}

// --- Global Guardian Radar (Overnight Pulse) ---
function updateGlobalOvernightPulse(over) {
    if (!over) return;

    setEl('overnight-global-status', over.global || 'NEUTRAL');
    setEl('overnight-asia-perf', (over.asia * 100).toFixed(2) + '%');
    setEl('overnight-london-perf', (over.london * 100).toFixed(2) + '%');
    setEl('overnight-ny-perf', (over.ny * 100).toFixed(2) + '%');
    setEl('overnight-narrative', over.narrative || `Analyzing institutional global flow for ${currentSymbol} anchor...`);

    // Judas Swing Detection
    const judasDot = document.getElementById('judas-indicator-dot');
    const judasText = document.getElementById('judas-status-text');
    const judasDetected = over.judasDetected || (over.asia > 0 && over.london < 0) || (over.asia < 0 && over.london > 0);
    
    if (judasDot && judasText) {
        if (judasDetected) {
            judasDot.style.borderColor = 'var(--gold)';
            judasDot.style.boxShadow = '0 0 10px var(--gold)';
            judasDot.children[0].style.background = 'var(--gold)';
            judasDot.classList.add('pulse');
            judasText.innerText = 'DETECTED';
            judasText.style.color = 'var(--gold)';
        } else {
            judasDot.style.borderColor = '#334155';
            judasDot.style.boxShadow = 'none';
            judasDot.children[0].style.background = '#334155';
            judasDot.classList.remove('pulse');
            judasText.innerText = 'INACTIVE';
            judasText.style.color = 'rgba(255,255,255,0.3)';
        }
    }

    const statusEl = document.getElementById('overnight-global-status');
    if (statusEl) {
        const g = over.global || 'NEUTRAL';
        if (g.includes('BULL')) {
            statusEl.style.color = 'var(--bullish)';
            statusEl.style.borderColor = 'var(--bullish)';
            statusEl.style.background = 'rgba(16, 185, 129, 0.1)';
        } else if (g.includes('BEAR')) {
            statusEl.style.color = 'var(--bearish)';
            statusEl.style.borderColor = 'var(--bearish)';
            statusEl.style.background = 'rgba(239, 68, 68, 0.1)';
        } else {
            statusEl.style.color = 'var(--gold)';
            statusEl.style.borderColor = 'var(--gold)';
            statusEl.style.background = 'rgba(245, 158, 11, 0.1)';
        }
    }

    // Performance colors & Session Highlighting
    const updateSessionBlock = (id, perf, isCurrent) => {
        const block = document.getElementById(`session-block-${id}`);
        const perfEl = document.getElementById(`overnight-${id}-perf`);
        if (perfEl) perfEl.style.color = perf > 0 ? 'var(--bullish)' : (perf < 0 ? 'var(--bearish)' : '#fff');
        
        if (block) {
            if (isCurrent) {
                block.style.background = 'rgba(56, 189, 248, 0.1)';
                block.style.borderColor = 'var(--cyan)';
                setEl('guardian-active-session', id.toUpperCase() + ' ACTIVE');
            } else {
                block.style.background = 'rgba(0,0,0,0.4)';
                block.style.borderColor = 'transparent';
            }
        }
    };

    // Determine current session (very rough heuristic, ideally server sends this)
    const hour = new Date().getUTCHours();
    const isAsia = hour >= 0 && hour < 8;
    const isLondon = hour >= 8 && hour < 16;
    const isNY = hour >= 13 && hour < 21; // Overlap logic simplified

    updateSessionBlock('asia', over.asia, isAsia);
    updateSessionBlock('london', over.london, isLondon);
    updateSessionBlock('ny', over.ny, isNY);

    // Sentiment Meter
    const fill = document.getElementById('sentiment-meter-fill');
    const marker = document.getElementById('sentiment-meter-marker');
    if (fill && marker) {
        let pct = 0;
        if (over.global?.includes('STRONGLY_BULLISH')) pct = 45;
        else if (over.global?.includes('BULLISH')) pct = 25;
        else if (over.global?.includes('STRONGLY_BEARISH')) pct = -45;
        else if (over.global?.includes('BEARISH')) pct = -25;
        
        fill.style.width = Math.abs(pct) + '%';
        fill.style.left = '50%';
        if (pct < 0) {
            fill.style.transform = 'translateX(-100%)';
            fill.style.background = 'var(--bearish)';
            fill.style.boxShadow = '0 0 10px var(--bearish)';
        } else {
            fill.style.transform = 'translateX(0)';
            fill.style.background = 'var(--bullish)';
            fill.style.boxShadow = '0 0 10px var(--bullish)';
        }
        marker.style.left = (50 + pct) + '%';
    }

    // Sweep Pulse Dots
    const updateSweep = (id, active) => {
        const node = document.getElementById(id);
        const dot = node?.querySelector('.pulse-dot');
        if (dot) {
            dot.style.background = active ? 'var(--gold)' : '#334155';
            active ? dot.classList.add('pulse') : dot.classList.remove('pulse');
            if (node) node.style.color = active ? 'var(--gold)' : 'var(--text-dim)';
        }
    };
    updateSweep('radar-sweep-asia', over.asiaSweep);
    updateSweep('radar-sweep-london', over.londonSweep);
    updateSweep('radar-sweep-ny', over.nySweep);
}

// --- Institutional Intelligence Radar ---
function updateInstitutionalRadar(r, score, fullData) {
    if (!r) return;

    setEl('radar-ir-score', (score || 50).toString().padStart(2, '0'));
    setEl('radar-precision-label', `PRECISION ${(score || 50).toFixed(0)}%`);
    
    // DXY Anchor
    const dxyBadge = document.getElementById('dxy-anchor-badge');
    if (dxyBadge) {
        dxyBadge.innerText = r.dxySync ? 'DXY ANCHOR: SYNCED' : 'DXY ANCHOR: DIVERTED';
        dxyBadge.style.color = r.dxySync ? 'var(--bullish)' : 'var(--bearish)';
    }

    // Whale Sync
    const whaleBadge = document.getElementById('tg-whale-sync');
    if (whaleBadge) {
        whaleBadge.style.display = r.whaleSync ? 'inline-block' : 'none';
    }

    // Precision Meter
    const precBar = document.getElementById('confidence-bar');
    if (precBar) precBar.style.width = (score || 50) + '%';

    // MTF Bias
    if (r.mtf) {
        Object.entries(r.mtf).forEach(([tf, bias]) => {
            const box = document.querySelector(`.mtf-box[data-tf="${tf}"] .tf-status`);
            if (box) {
                const b = (bias || 'NEUTRAL').toUpperCase();
                box.className = 'tf-status ' + b.toLowerCase();
                box.style.background = b.includes('BULL') ? 'var(--bullish)' : (b.includes('BEAR') ? 'var(--bearish)' : 'rgba(255,255,255,0.1)');
                box.innerText = b.includes('BULL') ? 'BULL' : (b.includes('BEAR') ? 'BEAR' : 'NEUT');
            }
            
            // Handle the tiny MTF dots in the recommendation card too
            const dot = document.getElementById(`mtf-dot-${tf}`);
            if (dot) {
                const b = (bias || 'NEUTRAL').toUpperCase();
                dot.style.background = b.includes('BULL') ? 'var(--bullish)' : (b.includes('BEAR') ? 'var(--bearish)' : 'rgba(255,255,255,0.1)');
                dot.style.boxShadow = b !== 'NEUTRAL' ? `0 0 5px ${dot.style.background}` : 'none';
            }
        });
    }

    // SMT
    const smtEl = document.getElementById('radar-smt-status');
    if (smtEl && r.smt) {
        smtEl.innerText = r.smt.active ? r.smt.label : 'STABLE';
        smtEl.style.color = r.smt.active ? (r.smt.label.includes('BULLH') || r.smt.label.includes('BULL') ? 'var(--bullish)' : 'var(--bearish)') : 'var(--text-bright)';
    }

    // Gamma
    const gammaEl = document.getElementById('radar-gamma-status');
    if (gammaEl && r.gex) {
        const totalGex = r.gex.reduce((s, g) => s + (g.type === 'CALL_WALL' ? g.gamma : -g.gamma), 0);
        gammaEl.innerText = totalGex > 50 ? 'HIGH GEAR' : (totalGex < -50 ? 'DISTRIBUTION' : 'NEUTRAL');
        gammaEl.style.color = totalGex > 50 ? 'var(--bullish)' : (totalGex < -50 ? 'var(--bearish)' : 'var(--text-bright)');
    }

    // Checklist
    const updateCheck = (key, active) => {
        const item = document.querySelector(`.conf-item[data-conf="${key}"] .conf-indicator`);
        if (item) {
            item.style.background = active ? 'var(--gold)' : '#1a1a1a';
            item.style.boxShadow = active ? '0 0 8px var(--gold)' : 'none';
        }
    };
    
    updateCheck('midnight', r.killzone?.midnightOpenSync || r.vwapAlign);
    updateCheck('vwap', r.vwapAlign);
    updateCheck('killzone', r.killzone?.active);
    updateCheck('smt', r.smt?.active);
    updateCheck('dxy', r.dxySync);
    updateCheck('sector', fullData?.isBasketAligned);

    // PO3 Cycle
    setEl('po3-phase-badge', r.amdPhase || 'ACCUMULATION');
    const po3Bar = document.getElementById('po3-progress-bar');
    if (po3Bar) {
        const prog = r.progress || 25;
        po3Bar.style.width = prog + '%';
        po3Bar.style.background = r.amdPhase === 'MANIPULATION' ? 'var(--bearish)' : (r.amdPhase === 'DISTRIBUTION' ? 'var(--bullish)' : 'var(--gold)');
    }

    // Aligned Pulse (Scalp Scan)
    if (fullData?.scalpScan) {
        setEl('pulse-status', fullData.scalpScan.signal);
        setEl('scalper-velocity-val', fullData.scalpScan.velocity);
        const pulseHud = document.getElementById('pulse-status');
        if (pulseHud) pulseHud.style.color = fullData.scalpScan.color;
        const scanOverlay = document.getElementById('scalper-scan-overlay');
        if (scanOverlay) scanOverlay.style.display = 'block';
    }

    // 0DTE Signal
    const sig = fullData?.signal0DTE;
    const sigPlaceholder = document.getElementById('0dte-placeholder');
    const sigMain = document.getElementById('0dte-signal-main');
    if (sig) {
        if (sigPlaceholder) sigPlaceholder.style.display = 'none';
        if (sigMain) sigMain.style.display = 'block';
        setEl('0dte-type', `${sig.type} ${sig.side}`);
        setEl('0dte-confidence', `${sig.confidence}% CONF`);
        setEl('0dte-strike', `$${sig.strike.toFixed(2)}`);
        setEl('0dte-rr', `${sig.rr} : 1`);
        setEl('0dte-trigger', `Trigger: ${sig.trigger}`);
        const typeEl = document.getElementById('0dte-type');
        if (typeEl) typeEl.style.color = sig.side === 'CALL' ? 'var(--bullish)' : 'var(--bearish)';
    } else {
        if (sigPlaceholder) sigPlaceholder.style.display = 'block';
        if (sigMain) sigMain.style.display = 'none';
    }

    // Macro Volatility Pulse
    const ev = fullData?.eventPulse;
    if (ev) {
        setEl('event-status', ev.status || 'STABLE');
        setEl('event-timer-min', ev.countdown || '--');
        setEl('event-name', ev.name || 'SCANNING EVENTS...');
        setEl('event-impact', 'IMPACT: ' + (ev.impact || 'UNKNOWN'));
        const statusEl = document.getElementById('event-status');
        if (statusEl) statusEl.style.background = ev.color || 'var(--gold)';
    }

    // --- UPGRADED: WHALE FLOW RADAR ---
    const tapeInner = document.getElementById('whale-tape-inner');
    if (tapeInner && fullData?.blockTrades) {
        const trades = fullData.blockTrades.slice(-8).reverse();
        let bullVol = 0;
        let bearVol = 0;

        tapeInner.innerHTML = trades.map(t => {
            const isBull = t.type === 'BULLISH';
            if (isBull) bullVol += t.value; else bearVol += t.value;
            
            const color = isBull ? 'var(--bullish)' : 'var(--bearish)';
            const icon = isBull ? '▲' : '▼';
            const valStr = t.value >= 1000000 ? (t.value/1000000).toFixed(1)+'M' : (t.value/1000).toFixed(0)+'K';

            return `
                <div style="display:flex; justify-content:space-between; align-items:center; padding:5px 0; border-bottom:1px solid rgba(255,255,255,0.03); animation: slideIn 0.3s ease-out;">
                    <div style="display:flex; align-items:center; gap:6px;">
                        <span style="color:${color}; font-weight:950;">${icon}</span>
                        <span style="color:#fff; font-weight:800;">${t.symbol}</span>
                    </div>
                    <span style="color:var(--gold); font-weight:900;">$${valStr}</span>
                    <span style="color:var(--text-dim); font-size:0.5rem;">${new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit', second:'2-digit'})}</span>
                </div>
            `;
        }).join('');

        // 1. Flow Velocity
        const velocityBadge = document.getElementById('whale-velocity-badge');
        if (velocityBadge) {
            const v = trades.length;
            const status = v > 6 ? 'EXTREME' : (v > 3 ? 'ACTIVE' : 'STABLE');
            velocityBadge.innerText = `FLOW: ${status}`;
            velocityBadge.style.color = v > 6 ? 'var(--bearish)' : (v > 3 ? 'var(--gold)' : 'var(--bullish)');
            velocityBadge.style.borderColor = velocityBadge.style.color;
        }

        // 2. Net Flow Delta Bar
        const deltaBar = document.getElementById('whale-flow-delta-bar');
        const ratioEl = document.getElementById('whale-flow-ratio');
        if (deltaBar && ratioEl) {
            const total = bullVol + bearVol;
            const bullPct = total > 0 ? (bullVol / total) * 100 : 50;
            const diff = bullPct - 50; // -50 to +50
            
            deltaBar.style.width = Math.abs(diff) + '%';
            deltaBar.style.left = diff >= 0 ? '50%' : (50 + diff) + '%';
            deltaBar.style.background = diff >= 0 ? 'var(--bullish)' : 'var(--bearish)';
            deltaBar.style.boxShadow = `0 0 10px ${deltaBar.style.background}`;
            
            ratioEl.innerText = `${bullPct.toFixed(0)}% BULLISH ACCUMULATION`;
            ratioEl.style.color = diff >= 0 ? 'var(--bullish)' : 'var(--bearish)';
        }

        // 3. Judas Sync Integration
        const judas = document.getElementById('judas-indicator');
        if (judas) judas.style.display = fullData.forexRadar?.judasDetected ? 'block' : 'none';
    }
}

    // Retail Sentiment
    setEl('retail-sentiment-val', (r.retailSentiment || 50).toFixed(0) + '% LONG');
    const rFill = document.getElementById('retail-sentiment-fill');
    if (rFill) rFill.style.width = (r.retailSentiment || 50) + '%';
    setEl('retail-strategy-text', (r.retailSentiment > 65 ? 'CONTRARIAN BIAS: BEARISH' : (r.retailSentiment < 35 ? 'CONTRARIAN BIAS: BULLISH' : 'CONTRARIAN BIAS: NEUTRAL')));
}

// --- UPGRADED: G7 CURRENCY POWER-GRID LOGIC ---
function updateG7SpiderMatrix(basket) {
    if (!basket) return;
    
    let currencies = Object.entries(basket).map(([cur, data]) => ({ cur, ...data }));
    
    // Sort for Alpha Rankings
    currencies.sort((a, b) => b.val - a.val);
    
    const strongest = currencies[0];
    const weakest = currencies[currencies.length - 1];
    
    // Update Leader Ribbon
    setEl('g7-top-cur', strongest.cur);
    setEl('g7-top-val', (strongest.val >= 0 ? '+' : '') + strongest.val.toFixed(2) + '%');
    setEl('g7-weak-cur', weakest.cur);
    setEl('g7-weak-val', weakest.val.toFixed(2) + '%');
    
    // Institutional Best Pair Strategy
    const pairText = `${strongest.cur}/${weakest.cur}`;
    setEl('g7-best-pair', pairText);
    setEl('g7-best-dir', `ESTABLISHED DIRECTION: LONG ${strongest.cur} / SHORT ${weakest.cur}`);
    const bestDirEl = document.getElementById('g7-best-dir');
    if (bestDirEl) bestDirEl.style.color = 'var(--gold)';

    // Update Individual Nodes
    currencies.forEach(data => {
        const node = document.querySelector(`.spider-node[data-cur="${data.cur}"]`);
        if (!node) return;

        // 1. Value & Bar
        const valEl = node.querySelector('.val');
        const fill = node.querySelector('.strength-bar-fill');
        if (valEl) {
            valEl.innerText = (data.val >= 0 ? '+' : '') + data.val.toFixed(2) + '%';
            valEl.style.color = data.val > 0 ? 'var(--bullish)' : (data.val < 0 ? 'var(--bearish)' : '#fff');
        }
        if (fill) {
            const pct = 50 + (data.val * 30); // Higher sensitivity for visualization
            fill.style.width = Math.max(5, Math.min(95, pct)) + '%';
            fill.style.background = data.val > 0 ? 'var(--bullish)' : (data.val < 0 ? 'var(--bearish)' : 'var(--gold)');
        }

        // 2. MTF Harmony Dots
        let alignedCount = 0;
        if (data.mtf) {
            Object.entries(data.mtf).forEach(([tf, strength]) => {
                const dot = node.querySelector(`.tf-dot[data-tf="${tf}"]`);
                if (dot) {
                    const isBull = strength > 0.005;
                    const isBear = strength < -0.005;
                    dot.style.background = isBull ? 'var(--bullish)' : (isBear ? 'var(--bearish)' : 'rgba(255,255,255,0.1)');
                    dot.style.boxShadow = (isBull || isBear) ? `0 0 5px ${dot.style.background}` : 'none';
                    if ((data.val > 0 && isBull) || (data.val < 0 && isBear)) alignedCount++;
                }
            });
        }

        // 3. Harmony Glow
        const nameEl = node.querySelector('div[style*="font-size: 0.65rem"]');
        if (nameEl) {
            if (alignedCount === 3) {
                nameEl.style.textShadow = `0 0 8px ${data.val > 0 ? 'var(--bullish)' : 'var(--bearish)'}`;
                nameEl.style.color = '#fff';
            } else {
                nameEl.style.textShadow = 'none';
                nameEl.style.color = data.cur === 'USD' ? '#00f2ff' : '#fff';
            }
        }

        // 4. Exhaustion Markers
        const isExhausted = Math.abs(data.val) > 0.6; // High standard for exhaustion
        if (isExhausted) {
            node.style.borderColor = data.val > 0 ? 'rgba(239, 68, 68, 0.4)' : 'rgba(16, 185, 129, 0.4)';
            node.style.background = data.val > 0 ? 'rgba(239, 68, 68, 0.05)' : 'rgba(16, 185, 129, 0.05)';
        } else {
            node.style.borderColor = data.cur === 'USD' ? 'rgba(0, 242, 255, 0.1)' : 'rgba(255, 255, 255, 0.05)';
            node.style.background = data.cur === 'USD' ? 'rgba(0, 242, 255, 0.03)' : 'rgba(255, 255, 255, 0.02)';
        }
    });

    // UNIFIED BASKET SYNC indicator
    const syncEl = document.getElementById('basket-alignment');
    if (syncEl) {
        const strongSideCount = currencies.filter(c => Math.abs(c.val) > 0.2).length;
        if (strongSideCount >= 4) {
            syncEl.innerText = 'HIGH VOL FLOW';
            syncEl.style.color = 'var(--gold)';
            syncEl.style.borderColor = 'var(--gold)';
        } else {
            syncEl.innerText = 'UNIFIED BASKET SYNC';
            syncEl.style.color = '#fff';
            syncEl.style.borderColor = 'rgba(0,242,255,0.2)';
        }
    }
}

// --- Multi-Utilities ---

function switchSymbol(symbol) {
    if (!symbol) return;
    const cleanSym = symbol.toUpperCase().trim();
    if (cleanSym === currentSymbol) return;

    console.log(`[SYSTEM] Switching to ${cleanSym}`);
    currentSymbol = cleanSym;
    window._chartLoaded = false;
    
    // ── CRITICAL: CLEAR OLD CHART DATA IMMEDIATELY ──
    // This prevents the "Crashed" look where old candles stay under new ones
    if (candleSeries) {
        candleSeries.setData([]);
        priceLines.forEach(l => candleSeries.removePriceLine(l));
        priceLines = [];
    }
    
    // UI Feedback
    const disp = document.getElementById('symbol-display');
    if (disp) disp.innerText = cleanSym.replace('=X', '');
    
    socket.emit('switch_symbol', cleanSym);
    loadChartHistory(cleanSym, currentTimeframe);
}

// Global hook for watchlist/ribbon clicks
window.switchSymbol = switchSymbol;

function updateSystemStatus(online) {
    const dot = document.getElementById('market-status-dot');
    const text = document.getElementById('market-session-text');
    if (dot) {
        dot.style.background = online ? 'var(--bullish)' : 'var(--bearish)';
        online ? dot.classList.add('pulse') : dot.classList.remove('pulse');
    }
    if (text) text.innerText = online ? 'FED FEED ACTIVE: INSTITUTIONAL SYNC' : 'CONNECTION LOST: RECONNECTING...';
}

function setEl(id, val, prec = 2) {
    const el = document.getElementById(id);
    if (!el) return;
    if (val === undefined || val === null) {
        el.innerText = '--';
        return;
    }
    el.innerText = typeof val === 'number' ? val.toFixed(prec) : val;
}

function startNYClock() {
    setInterval(() => {
        const ny = new Intl.DateTimeFormat('en-US', { 
            timeZone: 'America/New_York', 
            hour: '2-digit', minute: '2-digit', second: '2-digit', 
            hour12: false 
        }).format(new Date());
        setEl('ny-clock', ny + ' EST');
    }, 1000);
}

function restoreEntryTracker() {
    const saved = localStorage.getItem(TG_ENTRY_KEY);
    if (saved) window._tgEntryPrice = parseFloat(saved);
}

function setupUIControls() {
    // Search
    const search = document.getElementById('global-search');
    if (search) {
        search.onkeydown = (e) => {
            if (e.key === 'Enter') {
                switchSymbol(search.value);
                search.value = '';
            }
        };
    }

    // Timeframes
    document.querySelectorAll('.tf-btn[data-tf]').forEach(btn => {
        btn.onclick = () => {
            const tf = btn.getAttribute('data-tf');
            if (tf) {
                currentTimeframe = tf;
                document.querySelectorAll('.tf-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                loadChartHistory(currentSymbol, tf);
            }
        };
    });

    // Voice Squawk Toggle
    const voiceBtn = document.getElementById('btn-voice-toggle');
    const voiceIcon = document.getElementById('voice-icon');
    if (voiceBtn) {
        voiceBtn.onclick = () => {
            _voiceEnabled = !_voiceEnabled;
            if (voiceIcon) voiceIcon.innerText = _voiceEnabled ? '🔊' : '🔇';
            voiceBtn.style.color = _voiceEnabled ? 'var(--gold)' : 'var(--text-dim)';
            voiceBtn.style.borderColor = _voiceEnabled ? 'var(--gold)' : 'var(--border)';
            
            if (_voiceEnabled) {
                squawk("Voice Squawk Enabled. Institutional Narrative Synchronized.");
            }
        };
    }
}

function showToast(msg, type) {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const t = document.createElement('div');
    t.className = `toast ${type}`;
    t.innerText = msg;
    container.appendChild(t);
    setTimeout(() => {
        t.style.opacity = '0';
        setTimeout(() => t.remove(), 500);
    }, 4000);
}
