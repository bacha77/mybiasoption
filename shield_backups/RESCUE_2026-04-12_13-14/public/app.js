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
let ema20Series, ema50Series;
let priceLines = [];
const TG_ENTRY_KEY = 'bias_tg_entry_price';
window._tgEntryPrice = parseFloat(localStorage.getItem(TG_ENTRY_KEY)) || 0;
window._chartLoaded = false;

// Helpers for technicals
const calculateEMA = (data, period) => {
    const k = 2 / (period + 1);
    let emaData = [];
    let prevEma = data[0].close;
    
    for (let i = 0; i < data.length; i++) {
        if (i < period) {
            prevEma = data[i].close; // Seed
        } else {
            prevEma = (data[i].close * k) + (prevEma * (1 - k));
            emaData.push({ time: data[i].time, value: prevEma });
        }
    }
    return emaData;
};

// ══════════════════════════════════════════════════════════════
// SENTINEL SOUNDBOARD ENGINE — Web Audio API Synthesizer
// Generates Bloomberg-style squawk tones with zero dependencies
// ══════════════════════════════════════════════════════════════
const SoundBoard = {
    _ctx: null,
    _enabled: false,
    _lastSentinelState: null,

    init() {
        // AudioContext must be created after a user gesture
        const toggleBtn = document.getElementById('btn-audio-toggle');
        const icon = document.getElementById('audio-icon');
        if (toggleBtn) {
            // Initial state: ensure it doesn't look active if not enabled
            toggleBtn.style.animation = 'none';
            toggleBtn.style.background = 'rgba(255,255,255,0.03)';
            toggleBtn.style.borderColor = 'rgba(255,255,255,0.1)';
            toggleBtn.style.color = 'var(--text-dim)';

            toggleBtn.addEventListener('click', () => {
                this._enabled = !this._enabled;
                if (this._enabled) {
                    // Lazily create AudioContext on first enable (browser requirement)
                    if (!this._ctx) this._ctx = new (window.AudioContext || window.webkitAudioContext)();
                    toggleBtn.style.color = 'var(--gold)';
                    toggleBtn.style.borderColor = 'var(--gold)';
                    toggleBtn.style.background = 'rgba(245,158,11,0.1)';
                    toggleBtn.style.animation = 'pulse-opacity 2.5s infinite alternate';
                    if (icon) icon.textContent = '🔊';
                    showToast('🔊 INSTITUTIONAL HOOTER: ARMED', 'toast-gold');
                    this._playStartup();
                } else {
                    toggleBtn.style.color = 'var(--text-dim)';
                    toggleBtn.style.borderColor = 'rgba(255,255,255,0.1)';
                    toggleBtn.style.background = 'rgba(255,255,255,0.03)';
                    toggleBtn.style.animation = 'none';
                    if (icon) icon.textContent = '🔇';
                    showToast('🔇 HOOTER: SILENCED', 'toast-info');
                }
            });
        }
    },

    _tone(freq, type = 'sine', duration = 0.15, vol = 0.3, delay = 0) {
        if (!this._ctx || !this._enabled) return;
        const osc = this._ctx.createOscillator();
        const gain = this._ctx.createGain();
        osc.connect(gain);
        gain.connect(this._ctx.destination);
        osc.type = type;
        osc.frequency.setValueAtTime(freq, this._ctx.currentTime + delay);
        gain.gain.setValueAtTime(0, this._ctx.currentTime + delay);
        gain.gain.linearRampToValueAtTime(vol, this._ctx.currentTime + delay + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.001, this._ctx.currentTime + delay + duration);
        osc.start(this._ctx.currentTime + delay);
        osc.stop(this._ctx.currentTime + delay + duration + 0.05);
    },

    _playStartup() {
        // Soft ascending chime to confirm audio is live
        [440, 550, 660].forEach((f, i) => this._tone(f, 'sine', 0.12, 0.15, i * 0.1));
    },

    // 🐋 MEGALODON BLOCK ($1M+ Whale Trade) — Deep institutional boom
    playMegalodon(isElite) {
        if (!this._enabled) return;
        if (isElite) {
            // Three-pulse deep boom for Elite blocks (>$5M)
            this._tone(80,  'sawtooth', 0.4, 0.5, 0.0);
            this._tone(100, 'sawtooth', 0.3, 0.4, 0.15);
            this._tone(120, 'sine',     0.25,0.5, 0.3);
            // Finishing accent ping
            this._tone(880, 'sine', 0.1, 0.25, 0.5);
            this._tone(1100,'sine', 0.1, 0.2,  0.62);
        } else {
            // Single double-pulse for standard blocks (>$1M)
            this._tone(150, 'square', 0.2, 0.35, 0.0);
            this._tone(200, 'square', 0.15,0.25, 0.18);
        }
    },

    // 🟢 HIGH CONVICTION LONG — Ascending fanfare
    playConvictionLong() {
        if (!this._enabled) return;
        [523, 659, 784, 1047].forEach((f, i) => this._tone(f, 'sine', 0.18, 0.3, i * 0.12));
    },

    // 🔴 HIGH CONVICTION SHORT — Descending alarm
    playConvictionShort() {
        if (!this._enabled) return;
        [880, 740, 587, 440].forEach((f, i) => this._tone(f, 'sawtooth', 0.18, 0.3, i * 0.12));
    },

    // 🟡 STANDBY — Neutral dual-beep
    playStandby() {
        if (!this._enabled) return;
        this._tone(440, 'sine', 0.1, 0.2, 0.0);
        this._tone(440, 'sine', 0.1, 0.2, 0.2);
    },

    // ⚡ RAPID TICK — Ultra-light blip for price updates
    playTick() {
        if (!this._enabled) return;
        this._tone(1800, 'sine', 0.04, 0.05, 0);
    },

    // Check if Sentinel state changed and fire appropriate chime
    checkSentinelStateChange(newState) {
        if (newState === this._lastSentinelState) return;
        const prev = this._lastSentinelState;
        this._lastSentinelState = newState;
        if (!prev) return; // Skip on first load

        if (newState === 'HIGH CONVICTION LONG') {
            this.playConvictionLong();
            showToast('🟢 SENTINEL: LONG SIGNAL ARMED', 'toast-gold');
        } else if (newState === 'HIGH CONVICTION SHORT') {
            this.playConvictionShort();
            showToast('🔴 SENTINEL: SHORT SIGNAL ARMED', 'toast-alert');
        } else if (newState === 'TACTICAL STANDBY') {
            this.playStandby();
        }
    }
};

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

    // 6. Initialize SoundBoard
    SoundBoard.init();
    
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
            background: { type: 'solid', color: '#050505' }, 
            textColor: '#71717a', 
            fontSize: 10, 
            fontFamily: 'JetBrains Mono' 
        },
        grid: { 
            vertLines: { color: 'rgba(255,157,0,0.03)' }, 
            horzLines: { color: 'rgba(255,157,0,0.03)' } 
        },
        crosshair: { 
            mode: LightweightCharts.CrosshairMode.Normal, 
            vertLine: { labelBackgroundColor: 'var(--gold)' }, 
            horzLine: { labelBackgroundColor: 'var(--gold)' } 
        },
        timeScale: { 
            borderColor: 'rgba(255,255,255,0.08)', 
            timeVisible: true, 
            secondsVisible: false, 
            fixLeftEdge: true 
        }
    });

    candleSeries = chart.addCandlestickSeries({
        upColor: '#10b981', downColor: '#f43f5e',
        borderVisible: false, wickUpColor: '#10b981', wickDownColor: '#f43f5e',
        priceFormat: { 
            type: 'price', 
            precision: 2, 
            minMove: 0.01 
        }
    });

    ema20Series = chart.addLineSeries({ color: 'rgba(56, 189, 248, 0.4)', lineWidth: 1, crosshairMarkerVisible: false, priceLineVisible: false });
    ema50Series = chart.addLineSeries({ color: 'rgba(245, 158, 11, 0.4)', lineWidth: 1, crosshairMarkerVisible: false, priceLineVisible: false });

    // HUD Subscriber
    chart.subscribeCrosshairMove(param => {
        const hudOpen = document.getElementById('hud-open');
        const hudHigh = document.getElementById('hud-high');
        const hudLow = document.getElementById('hud-low');
        const hudClose = document.getElementById('hud-close');
        const hudVol = document.getElementById('hud-vol');

        if (!param.time || param.point.x < 0 || param.point.y < 0) {
            // Restore current price if out of bounds (optional)
            return;
        }

        const data = param.seriesData.get(candleSeries);
        if (data) {
            if (hudOpen) hudOpen.innerText = data.open.toFixed(2);
            if (hudHigh) hudHigh.innerText = data.high.toFixed(2);
            if (hudLow) hudLow.innerText = data.low.toFixed(2);
            if (hudClose) hudClose.innerText = data.close.toFixed(2);
            // LightweightCharts 4.x doesn't expose volume directly in candle data unless part of the object
            // We'll rely on our data source having the 'volume' property
        }
    });

    chart.priceScale('right').applyOptions({ 
        borderColor: 'rgba(255,255,255,0.08)', 
        textColor: '#71717a' 
    });

    window.addEventListener('resize', () => {
        if (chart && container) chart.applyOptions({ width: container.clientWidth });
    });

    // Zoom buttons
    const zoomIn = document.getElementById('zoom-in-btn');
    const zoomOut = document.getElementById('zoom-out-btn');
    if (zoomIn) zoomIn.onclick = () => chart.timeScale().zoomIn(0.1);
    if (zoomOut) zoomOut.onclick = () => chart.timeScale().zoomOut(0.1);
}

function loadChartHistory(symbol, tf) {
    if (!candleSeries) return;
    const sym = symbol.toUpperCase().trim();
    const ts = Date.now();
    
    fetch(`/api/history?symbol=${encodeURIComponent(sym)}&tf=${encodeURIComponent(tf)}&t=${ts}`)
        .then(r => r.json())
        .then(data => {
            if (Array.isArray(data) && data.length > 0) {
                console.log(`[CHART] Successfully loaded ${data.length} candles for ${sym}`);
                candleSeries.setData(data);
                
                // Add EMA الدراسات
                if (data.length > 50) {
                    ema20Series.setData(calculateEMA(data, 20));
                    ema50Series.setData(calculateEMA(data, 50));
                }

                chart.timeScale().fitContent();
                window._chartLoaded = true;
                
                // Update precision for FX
                const isFX = sym.includes('=X') || sym.includes('USD') || sym === 'DXY';
                candleSeries.applyOptions({
                    priceFormat: {
                        precision: isFX ? 5 : 2,
                        minMove: isFX ? 0.00001 : 0.01
                    }
                });
            } else {
                console.warn(`[CHART] Received empty history for ${sym}. Backend may be warming up. Retrying in 5s...`);
                // Auto-retry if empty, helpful for initial boot
                setTimeout(() => loadChartHistory(symbol, tf), 5000);
            }
        })
        .catch(err => {
            console.error('[CHART] History Load Error:', err);
            // Retry on network errors too
            setTimeout(() => loadChartHistory(symbol, tf), 10000);
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
        if (data.symbol === currentSymbol) {
            if (candleSeries && data.candle) candleSeries.update(data.candle);
            updateHUD(data);
        }
    });

    socket.on('sectors_update', (data) => {
        if (data.sectors) updateMarketTickerRibbon(data.sectors);
        if (data.basket) updateG7SpiderMatrix(data.basket);
        if (data.watchlist) updateWatchlistUI(data.watchlist);
    });

    // 🐋 WHALE / MEGALODON BLOCK ALERT
    socket.on('whale_alert', (block) => {
        if (!block) return;
        const value   = block.value || 0;
        const sym     = block.symbol || '??';
        const dir     = block.type  || 'UNKNOWN';
        const isElite = block.isElite || (value >= 5000000);

        // Fire the sound
        SoundBoard.playMegalodon(isElite);

        // Visual Toast
        const emoji   = dir === 'BULLISH' ? '🟢' : '🔴';
        const tier    = isElite ? '🐋 MEGALODON' : '🦈 BLOCK TRADE';
        const valStr  = value >= 1000000
            ? `$${(value / 1000000).toFixed(2)}M`
            : `$${(value / 1000).toFixed(0)}K`;
        showToast(`${emoji} ${tier}: ${sym} ${dir} ${valStr}`, isElite ? 'toast-alert' : 'toast-gold');

        // Update the Intel Ticker
        const ticker = document.getElementById('intel-ticker');
        if (ticker) {
            const span = document.createElement('span');
            span.style.cssText = `color:${dir === 'BULLISH' ? 'var(--bullish)' : 'var(--bearish)'}; font-weight:900; margin-right:30px;`;
            span.textContent = `${tier}: ${sym} ${valStr} ${dir} @ ${block.price?.toFixed(2) || '--'} | `;
            ticker.insertBefore(span, ticker.firstChild);
        }
    });
}

// --- Board Orchestrator ---
function updateTerminalBoard(data) {
    if (!data) return;

    // 1. Global Price/Chart Sync
    if (data.symbol) {
        if (data.symbol !== currentSymbol) {
            currentSymbol = data.symbol;
            window._chartLoaded = false;
        }
    }

    if (candleSeries) {
        if (data.candles && Array.isArray(data.candles) && data.candles.length > 0) {
            candleSeries.setData(data.candles);
            if (!window._chartLoaded) {
                chart.timeScale().fitContent();
                window._chartLoaded = true;
            }
        } else if (data.candle) {
            candleSeries.update(data.candle);
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

function updateEquitySpiderMatrix(sectors) {
    if (!sectors) return;
    const grid = document.getElementById('equity-spider-grid');
    if (!grid) return;

    const data = Array.isArray(sectors) ? sectors : Object.values(sectors);
    
    data.sort((a,b) => b.perf - a.perf).forEach(s => {
        let node = grid.querySelector(`[data-sector="${s.symbol}"]`);
        if (!node) {
            node = document.createElement('div');
            node.className = 'spider-node';
            node.setAttribute('data-sector', s.symbol);
            node.style.background = 'rgba(255,255,255,0.03)';
            node.style.padding = '6px';
            node.style.borderRadius = '4px';
            node.style.textAlign = 'center';
            node.style.border = '1px solid rgba(255,255,255,0.05)';
            grid.appendChild(node);
        }
        node.innerHTML = `
            <div style="font-size:0.55rem; color:var(--text-dim); font-weight:800;">${s.symbol}</div>
            <div style="font-size:0.75rem; font-weight:900; color:${s.perf >= 0 ? 'var(--bullish)' : 'var(--bearish)'};">
                ${s.perf >= 0 ? '+' : ''}${s.perf.toFixed(2)}%
            </div>
        `;
    });

    // Update Top/Weak
    const sorted = [...data].sort((a,b) => b.perf - a.perf);
    if (sorted.length > 0) {
        setEl('eq-top-cur', sorted[0].symbol);
        setEl('eq-top-val', `${sorted[0].perf >= 0 ? '+' : ''}${sorted[0].perf.toFixed(2)}%`);
        setEl('eq-weak-cur', sorted[sorted.length-1].symbol);
        setEl('eq-weak-val', `${sorted[sorted.length-1].perf >= 0 ? '+' : ''}${sorted[sorted.length-1].perf.toFixed(2)}%`);
    }
}

function updateWatchlistUI(watchlist) {
    if (!watchlist || !Array.isArray(watchlist)) return;
    
    const stocksList = document.getElementById('stocks-list');
    const forexList = document.getElementById('forex-list');
    
    const equities = watchlist.filter(item => !item.symbol.includes('=X') && !item.symbol.includes('-USD') && !item.symbol.includes('^') && item.symbol !== 'DXY');
    const forexCrypto = watchlist.filter(item => item.symbol.includes('=X') || item.symbol.includes('-USD') || item.symbol === 'BTC-USD' || item.symbol === 'ETH-USD' || item.symbol === 'DXY');

    const renderItem = (item) => `
        <div class="watchlist-item" onclick="switchSymbol('${item.symbol}')">
            <div class="sym">${item.symbol.replace('=X', '')}</div>
            <div class="val-box">
                <div class="price ${(item.dailyChangePercent || 0) >= 0 ? 'bullish-text' : 'bearish-text'}">
                    ${(item.price || 0).toFixed(item.symbol.includes('=X') ? 5 : 2)}
                </div>
                <div class="bias">${item.bias || 'NEUTRAL'}</div>
            </div>
        </div>
    `;

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
            price: price, color: color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title: label,
        });
        priceLines.push(line);
    };

    if (m.midnightOpen) addLine(m.midnightOpen, 'MIDNIGHT OPEN', 'var(--cyan)', LightweightCharts.LineStyle.Solid);
    if (m.pdh) addLine(m.pdh, 'PREV DAY HIGH', 'var(--gold)');
    if (m.pdl) addLine(m.pdl, 'PREV DAY LOW', 'var(--gold)');
    if (m.vwap) addLine(m.vwap, 'VWAP', 'rgba(255,157,0,0.4)');
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

// --- Sentinel Core Expert System ---
function updateSentinelCore(data) {
    if (!data) return;
    
    let conviction = 0;
    let rationale = [];
    let state = "EVALUATING";
    let stateDesc = "Scanning multidimensional flow...";
    
    const price = data.currentPrice || data.price || 0;
    const vwap = data.markers?.vwap || 0;
    const cvd = data.hybridCVD || 0;
    const flow = data.netWhaleFlow || 0;
    const score = data.confluenceScore || 0; // 0 to 100
    
    // 1. VWAP Relation (±25)
    let vwapFactor = '';
    if (vwap > 0) {
        if (price > vwap) { conviction += 25; vwapFactor = 'ACTIVE'; rationale.push("Price > VWAP (Systematic bid support)."); }
        else { conviction -= 25; vwapFactor = 'DANGER'; rationale.push("Price < VWAP (Systematic distribution)."); }
    }
    
    // 2. Hybrid CVD (±25)
    let cvdFactor = '';
    if (cvd > 500) { conviction += 25; cvdFactor = 'ACTIVE'; rationale.push("Tick accumulation is deeply positive."); }
    else if (cvd < -500) { conviction -= 25; cvdFactor = 'DANGER'; rationale.push("Aggressive tick distribution active."); }
    else { cvdFactor = 'WARN'; }
    
    // 3. Net Whale Flow (±25)
    if (flow > 100000) { conviction += 25; rationale.push("Smart Money block flows are bullish."); }
    else if (flow < -100000) { conviction -= 25; rationale.push("Macro institutional outflows detected."); }
    
    // 4. Timeframe Alignment (±25 calculated from score)
    let tfFactor = 'WARN';
    if (score > 65) { conviction += 25; tfFactor = 'ACTIVE'; rationale.push("Global macros are highly synchronized."); }
    else if (score < 35) { conviction -= 25; tfFactor = 'DANGER'; rationale.push("Global macros dragging against trend."); }

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
    const actionEl = document.getElementById('tg-action-strip');
    const actionText = document.getElementById('tg-action-text');
    const actionIcon = document.getElementById('tg-action-icon');
    
    if (meterEl) meterEl.innerText = `${absConviction}%`;
    if (barEl) barEl.style.width = `${absConviction}%`;
    
    let actionStyle = '';
    
    // Final Judgement Logic
    if (conviction >= 75) {
        state = "HIGH CONVICTION LONG";
        stateDesc = "Massive structural and flow alignment to the upside.";
        badgeEl.innerText = "BUY";
        badgeEl.className = "tg-badge tg-badge-buy"; // assume tg-badge-buy exists or inline style
        badgeEl.style.background = "var(--bullish)";
        actionText.innerText = `AGGRESSIVE LONG: ${data.symbol || 'ASSET'}`;
        actionStyle = 'tg-action-hold';
        actionIcon.innerText = "🟢";
        if (barEl) barEl.style.background = "var(--bullish)";
    } else if (conviction >= 25 && conviction < 75) {
        state = "BUILD LONG SKEW";
        stateDesc = "Accumulation detected. Preparing for bullish breakout.";
        badgeEl.innerText = "PREP";
        badgeEl.style.background = "var(--gold)";
        actionText.innerText = "SEEK LONGS ON DIPS";
        actionStyle = 'tg-action-manage';
        actionIcon.innerText = "🟡";
        if (barEl) barEl.style.background = "var(--gold)";
    } else if (conviction <= -75) {
        state = "HIGH CONVICTION SHORT";
        stateDesc = "Severe institutional dumping and bearish structure.";
        badgeEl.innerText = "SHORT";
        badgeEl.style.background = "var(--bearish)";
        actionText.innerText = `AGGRESSIVE SHORT: ${data.symbol || 'ASSET'}`;
        actionStyle = 'tg-action-exit';
        actionIcon.innerText = "🔴";
        if (barEl) barEl.style.background = "var(--bearish)";
    } else if (conviction <= -25 && conviction > -75) {
        state = "BUILD SHORT SKEW";
        stateDesc = "Momentum is breaking down. Heavy distribution.";
        badgeEl.innerText = "PREP";
        badgeEl.style.background = "var(--gold)";
        actionText.innerText = "SEEK SHORTS ON RIPS";
        actionStyle = 'tg-action-manage';
        actionIcon.innerText = "🟡";
        if (barEl) barEl.style.background = "var(--gold)";
    } else {
        state = "TACTICAL STANDBY";
        stateDesc = "Mixed signals. Order flow is fighting macro structure.";
        badgeEl.innerText = "HOLD";
        badgeEl.style.background = "transparent";
        badgeEl.style.border = "1px solid var(--text-main)";
        actionText.innerText = "AWAIT CLEAR SIGNAL";
        actionStyle = 'tg-action-manage';
        actionIcon.innerText = "⚪";
        if (barEl) barEl.style.background = "var(--text-main)";
    }
    
    // Append Badge Update
    document.getElementById('tg-state-label').innerText = state;
    document.getElementById('tg-state-label').style.color = conviction > 0 ? 'var(--bullish)' : (conviction < 0 ? 'var(--bearish)' : 'var(--text-main)');
    document.getElementById('tg-state-desc').innerText = stateDesc;
    
    if (actionEl) {
        actionEl.className = `tg-action-strip ${actionStyle}`;
    }
    
    // Compile Rationale
    const rationaleEl = document.getElementById('tg-rationale');
    if (rationaleEl) {
        if (rationale.length === 0) {
            rationaleEl.innerText = "Waiting for decisive institutional variance...";
        } else {
            // Take top 2 reasons
            rationaleEl.innerText = rationale.slice(0, 2).join(" ");
        }
    }

    // 🔊 SoundBoard: Fire chime if state changed
    SoundBoard.checkSentinelStateChange(state);
}

// --- Multi-Utilities ---

function switchSymbol(symbol) {
    if (!symbol) return;
    const cleanSym = symbol.toUpperCase().trim();
    if (cleanSym === currentSymbol) return;

    console.log(`[SYSTEM] Switching to ${cleanSym}`);
    currentSymbol = cleanSym;
    window._chartLoaded = false;
    
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
