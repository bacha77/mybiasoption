/**
 * B.I.A.S Terminal | Institutional Positioning & Trading Intelligence Suite
 * (C) 2026 - Advanced Institutional Signal Engine
 * Version 3.5.0 - TOTAL CHART REBUILD
 */

// --- Global Terminals & State ---
const socket = io();
const TG_ENTRY_KEY = 'bias_tg_entry_price';
window._tgEntryPrice = parseFloat(localStorage.getItem(TG_ENTRY_KEY)) || 0;
window._tgLastData = null;
let currentSymbol = 'SPY';
let currentTimeframe = '1m';
let chart, candleSeries;
let priceLines = [];

// --- Initialization ---
document.addEventListener('DOMContentLoaded', () => {
    initChart();
    setupSocketListeners();
    setupUIControls();
    restoreEntryTracker();
    startClocks();
    showToast('B.I.A.S ELITE: ENGINE SYNCRONIZED', 'toast-gold');
});

function setupSocketListeners() {
    socket.on('connect', () => {
        const dot = document.getElementById('market-status-dot');
        if (dot) { dot.style.background = 'var(--bullish)'; dot.classList.add('pulse'); }
        const statusText = document.getElementById('market-session-text');
        if (statusText) statusText.innerText = 'FED FEED ACTIVE: INSTITUTIONAL SYNC';
    });

    socket.on('price_updated', (data) => {
        if (data.isBatch) {
            updateMarketTickerRibbon(data.updates);
            if (data.symbol === currentSymbol) updateTerminalBoard(data);
        } else {
            if (data.symbol === currentSymbol) updateTerminalBoard(data);
        }
    });

    socket.on('init', (data) => {
        console.log('[SYNC] Initializing Terminal Board...', data.symbol);
        if (data.symbol) currentSymbol = data.symbol;
        updateTerminalBoard(data);
        if (data.watchlist) updateWatchlistUI(data.watchlist);
    });

    socket.on('ticker_history', (data) => {
        if (!data || !candleSeries) return;
        const normalized = (data.symbol || '').toUpperCase().trim();
        if (normalized === currentSymbol.toUpperCase().trim() && data.history) {
            console.log(`[CHART] Direct history sync for ${normalized}`);
            candleSeries.setData(data.history);
            chart.timeScale().fitContent();
        }
    });
}

function updateTerminalBoard(data) {
    if (!data) return;

    // 1. Data Sanitization & Symbol Check
    if (data.symbol) {
        window._lastSymbol = currentSymbol;
        currentSymbol = data.symbol;
    }

    // 2. Chart Sync (Primary Priority)
    if (candleSeries && data.candles && Array.isArray(data.candles) && data.candles.length > 0) {
        console.log(`[CHART] Rendering ${data.candles.length} candles for ${currentSymbol}`);
        candleSeries.setData(data.candles);
        // Only fit content on first load or symbol change
        if (window._lastSymbol !== currentSymbol) {
            chart.timeScale().fitContent();
        }
    } else if (candleSeries && data.candle) {
        candleSeries.update(data.candle);
    }

    // 3. Ribbon & HUD Sync
    if (data.sectors) updateMarketTickerRibbon(data.sectors);
    _updateUI(data);
    
    // 4. Matrix & Indicator Sync
    if (data.equitySectors) updateEquitySpiderMatrix(data);
    if (data.g7Sectors) updateG7SpiderMatrix(data);
    if (data.institutionalSentiment) updateCotUI(data, data.symbol);
    if (data.watchlist) updateWatchlistUI(data.watchlist);
}

function initChart() {
    console.log('[CHART] Initializing institutional lightweight-charts...');
    const container = document.getElementById('priceChart');
    if (!container) {
        console.error('[CHART] Critical Error: #priceChart container not found in DOM!');
        return;
    }

    if (chart) { chart.remove(); }

    chart = LightweightCharts.createChart(container, {
        width: container.clientWidth,
        height: 600,
        layout: { background: { type: 'solid', color: '#050505' }, textColor: '#71717a', fontSize: 10, fontFamily: 'JetBrains Mono' },
        grid: { vertLines: { color: 'rgba(255,157,0,0.03)' }, horzLines: { color: 'rgba(255,157,0,0.03)' } },
        crosshair: { mode: LightweightCharts.CrosshairMode.Normal, vertLine: { labelBackgroundColor: 'var(--gold)' }, horzLine: { labelBackgroundColor: 'var(--gold)' } },
        timeScale: { borderColor: 'rgba(255,255,255,0.08)', timeVisible: true, secondsVisible: false, fixLeftEdge: true }
    });

    candleSeries = chart.addCandlestickSeries({
        upColor: '#10b981', downColor: '#f43f5e',
        borderVisible: false, wickUpColor: '#10b981', wickDownColor: '#f43f5e',
        priceFormat: { type: 'price', precision: currentSymbol.includes('=X') ? 5 : 2, minMove: currentSymbol.includes('=X') ? 0.00001 : 0.01 }
    });

    chart.priceScale('right').applyOptions({ borderColor: 'rgba(255,255,255,0.08)', textColor: '#71717a' });
    
    // Initial history fetch
    loadChartHistory(currentSymbol, currentTimeframe);
    // Robust Chart Controls
    const zoomIn = document.getElementById('zoom-in-btn');
    const zoomOut = document.getElementById('zoom-out-btn');
    if (zoomIn) zoomIn.onclick = () => { if (chart) chart.timeScale().zoomIn(0.1); };
    if (zoomOut) zoomOut.onclick = () => { if (chart) chart.timeScale().zoomOut(0.1); };

    loadChartHistory(currentSymbol, currentTimeframe);

    window.addEventListener('resize', () => {
        if (chart && container) chart.applyOptions({ width: container.clientWidth });
    });
}

async function loadChartHistory(symbol, tf) {
    if (!candleSeries) return;
    let sym = (symbol || 'SPY').toUpperCase().trim();
    if (sym === 'BTCUSD') sym = 'BTC-USD';
    if (sym === 'EURUSD') sym = 'EURUSD=X';
    if (sym === 'GBPUSD') sym = 'GBPUSD=X';
    if (sym === 'USDJPY') sym = 'USDJPY=X';
    if (sym === 'DXY') sym = 'DX-Y.NYB';

    try {
        const res = await fetch(`/api/history?symbol=${sym}&tf=${tf}&t=${Date.now()}`);
        const data = await res.json();
        if (data && Array.isArray(data) && data.length > 0) {
            candleSeries.setData(data);
            chart.timeScale().fitContent();
        }
    } catch (err) { console.error('History Load Error:', err); }
}

function _updateUI(data) {
    const price = data.currentPrice || data.price || 0;
    const change = data.dailyChangePercent || 0;
    
    const priceEl = document.getElementById('current-price');
    const changeEl = document.getElementById('price-change');
    const symbolEl = document.getElementById('symbol-display');

    if (priceEl) {
        const isFX = data.symbol?.includes('=X');
        priceEl.innerText = isFX ? price.toFixed(5) : price.toFixed(2);
    }
    if (changeEl) {
        const sign = change >= 0 ? '+' : '';
        changeEl.innerText = `${sign}${change.toFixed(2)}%`;
        changeEl.className = change >= 0 ? 'main-change bullish-text' : 'main-change bearish-text';
    }
    if (symbolEl && data.symbol) {
        symbolEl.innerText = data.symbol;
        currentSymbol = data.symbol;
    }

    // UPDATE INSTITUTIONAL HUD (DXY & SMT)
    const dxyStatus = document.getElementById('hud-dxy-status');
    const smtStatus = document.getElementById('hud-smt-status');
    if (dxyStatus && data.markers?.dxy) {
        dxyStatus.querySelector('.val').innerText = 'ONLINE';
        dxyStatus.style.color = 'var(--accent)';
    }
    if (smtStatus && data.markers?.smt) {
        smtStatus.querySelector('.val').innerText = data.markers.smt.symbol || 'ACTIVE';
        smtStatus.style.color = 'var(--gold)';
    }

    if (data.candle && candleSeries) { candleSeries.update(data.candle); }
    if (data.markers) { 
        updateMarkersUI(data.markers, data.symbol); 
        updateChartPriceLines(data.markers, data.symbol); 
    }
    
    const confScore = data.analysis?.confluenceScore ?? data.confluenceScore;
    if (confScore !== undefined) { 
        updateConfluenceUI(confScore); 
    }
    
    if (data.roro !== undefined || data.internals) updateMacroCorrelation(data);
    
    updateRadar(data);
    updateBadges(data);
    // update0DTE(data);
    updateAIAnalyst(data);
}

function updateTier1Panel(data) {
    const m = data.markers || {};
    const price = data.currentPrice || data.price || 0;
    const isFX = data.symbol?.includes('=X');
    const prec = isFX ? 5 : 2;

    const vwapZone = document.getElementById('t1-vwap-zone');
    if (vwapZone && m.vwapBands?.vwap) {
        const dev = (price - m.vwapBands.vwap) / (m.vwapBands.stdev || 1);
        vwapZone.innerText = `${dev.toFixed(1)}σ ${Math.abs(dev) > 2 ? '⚠️ FADE' : 'STABLE'}`;
        vwapZone.style.color = Math.abs(dev) > 2 ? 'var(--bearish)' : 'var(--bullish)';
    }

    setEl('t1-vpoc-val', m.poc, prec);
}

function updateRadar(data) {
    const m = data.markers || {};
    const r = m.radar || {};
    const scoreEl = document.getElementById('radar-ir-score');
    if (scoreEl) {
        const scoreVal = typeof r.irScore === 'object' ? r.irScore.score : r.irScore || 0;
        scoreEl.innerText = scoreVal.toString().padStart(2, '0');
    }
    const sess = data.session || {};
    const sessionLabel = document.getElementById('radar-session-name');
    if (sessionLabel) {
        sessionLabel.innerText = sess.label || 'OFF-HOURS';
        sessionLabel.style.color = sess.isValid ? 'var(--gold)' : 'var(--text-dim)';
    }
}

function update0DTE(data) {
    const sig = data.signal0DTE;
    const placeholder = document.getElementById('0dte-placeholder');
    const main = document.getElementById('0dte-signal-main');
    if (!sig) {
        if (placeholder) placeholder.style.display = 'block';
        if (main) main.style.display = 'none';
        return;
    }
    if (placeholder) placeholder.style.display = 'none';
    if (main) {
        main.style.display = 'block';
        document.getElementById('0dte-type').innerText = sig.type;
        document.getElementById('0dte-strike').innerText = `$${sig.strike}`;
    }
}

function updateG7SpiderMatrix(data) {
    const sectors = data.g7Sectors;
    const g7 = data.g7; // The full basket object from backend
    if (!sectors) return;

    // 1. Update Individual Nodes
    sectors.forEach(c => {
        const curCode = c.symbol;
        const node = document.querySelector(`.spider-node[data-cur="${curCode}"]`);
        if (node) {
            const valEl = node.querySelector('.val');
            if (valEl) {
                valEl.innerText = `${c.perf >= 0 ? '+' : ''}${c.perf.toFixed(2)}%`;
                valEl.style.color = c.perf >= 0 ? 'var(--bullish)' : 'var(--bearish)';
            }
            // Update MTF dots if available
            if (c.mtf) {
                ['1m', '5m', '1h'].forEach(tf => {
                    const dot = node.querySelector(`.tf-dot[data-tf="${tf}"]`);
                    if (dot) {
                        const mtfVal = c.mtf[tf] || 0;
                        dot.style.background = mtfVal > 0 ? 'var(--bullish)' : (mtfVal < 0 ? 'var(--bearish)' : 'rgba(255,255,255,0.1)');
                        dot.style.boxShadow = mtfVal !== 0 ? `0 0 5px ${mtfVal > 0 ? 'var(--bullish)' : 'var(--bearish)'}` : 'none';
                    }
                });
            }
        }
    });

    // 2. Update Leader Row (Strongest/Weakest/Best Pair)
    const sorted = [...sectors].sort((a,b) => b.perf - a.perf);
    const strongest = sorted[0];
    const weakest = sorted[sorted.length - 1];

    if (strongest) {
        setEl('g7-top-cur', strongest.symbol);
        setEl('g7-top-val', `${strongest.perf >= 0 ? '+' : ''}${strongest.perf.toFixed(2)}%`);
    }
    if (weakest) {
        setEl('g7-weak-cur', weakest.symbol);
        setEl('g7-weak-val', `${weakest.perf >= 0 ? '+' : ''}${weakest.perf.toFixed(2)}%`);
    }
    if (g7 && g7.bestPair) {
        setEl('g7-best-pair', `${g7.bestPair.strong}/${g7.bestPair.weak}`);
        setEl('g7-best-dir', `LONG ${g7.bestPair.strong}`);
    }
}

function updateEquitySpiderMatrix(data) {
    const sectors = data.equitySectors;
    if (!sectors) return;

    // 1. Update Grid
    const container = document.getElementById('equity-spider-grid');
    if (container) {
        container.innerHTML = sectors.sort((a,b) => b.perf - a.perf).map(s => `
            <div style="background:rgba(255,255,255,0.02); padding:6px; border:1px solid rgba(255,255,255,0.05); border-radius:4px; text-align:center;">
                <div style="font-size:0.55rem; color:var(--text-dim); font-weight:800;">${s.symbol}</div>
                <div style="font-size:0.75rem; font-weight:900; color:${s.perf >= 0 ? 'var(--bullish)' : 'var(--bearish)'};">
                    ${s.perf >= 0 ? '+' : ''}${s.perf.toFixed(2)}%
                </div>
            </div>
        `).join('');
    }

    // 2. Update Leader Row
    const sorted = [...sectors].sort((a,b) => b.perf - a.perf);
    const strongest = sorted[0];
    const weakest = sorted[sorted.length - 1];

    if (strongest) {
        setEl('eq-top-cur', strongest.symbol);
        setEl('eq-top-val', `${strongest.perf >= 0 ? '+' : ''}${strongest.perf.toFixed(2)}%`);
        setEl('eq-top-comps', `BUY: ${strongest.symbol}`);
    }
    if (weakest) {
        setEl('eq-weak-cur', weakest.symbol);
        setEl('eq-weak-val', `${weakest.perf >= 0 ? '+' : ''}${weakest.perf.toFixed(2)}%`);
        setEl('eq-weak-comps', `SHORT: ${weakest.symbol}`);
    }
    if (strongest && weakest) {
        setEl('eq-best-pair', `${strongest.symbol}/${weakest.symbol}`);
        setEl('eq-best-dir', `BASKET STRADDLE`);
    }
}

function _updateEntryTracker(data) {
    const entry = window._tgEntryPrice;
    if (!entry || entry <= 0) return;
    const price = data.currentPrice || data.price || 0;
    const pnl = price - entry;
    const pnlPct = (pnl / entry) * 100;
    const dolEl = document.getElementById('tg-pnl-dollar');
    const pctEl = document.getElementById('tg-pnl-pct');
    if (dolEl) dolEl.innerText = `$${pnl.toFixed(2)}`;
    if (pctEl) pctEl.innerText = `${pnlPct.toFixed(2)}%`;
}

function updateMarketTickerRibbon(sectors) {
    const container = document.getElementById('market-ticker-ribbon');
    if (!container || !sectors || !Array.isArray(sectors)) return;

    // Filter to show only major benchmark symbols
    const benchmarks = sectors.filter(s => ['SPY', 'QQQ', 'DIA', 'BTC-USD', 'DXY', 'EURUSD=X', 'VIX'].includes(s.symbol));
    
    // If container is empty, initialize cells
    if (container.children.length === 0) {
        benchmarks.forEach(s => {
            const cell = document.createElement('div');
            cell.className = 'benchmark-cell';
            cell.id = `bench-${s.symbol.replace(/[=^]/g, '')}`;
            cell.innerHTML = `
                <div class="benchmark-header">
                    <span class="benchmark-sym">${s.symbol.replace('=X', '')}</span>
                    <div class="benchmark-pulse"></div>
                </div>
                <div class="benchmark-price">0.00</div>
                <div class="benchmark-change">0.00%</div>
            `;
            container.appendChild(cell);
        });
    }

    // Update values
    sectors.forEach(s => {
        const id = `bench-${s.symbol.replace(/[=^]/g, '')}`;
        const cell = document.getElementById(id);
        if (cell) {
            const priceEl = cell.querySelector('.benchmark-price');
            const changeEl = cell.querySelector('.benchmark-change');
            const pulse = cell.querySelector('.benchmark-pulse');

            if (priceEl) priceEl.innerText = (s.price || 0).toFixed(s.symbol.includes('=X') ? 4 : 2);
            if (changeEl) {
                const change = s.change || 0;
                changeEl.innerText = (change >= 0 ? '+' : '') + change.toFixed(2) + '%';
                changeEl.className = 'benchmark-change ' + (change >= 0 ? 'bullish-text' : 'bearish-text');
            }
            if (pulse) {
                pulse.classList.remove('active');
                void pulse.offsetWidth; // Trigger reflow
                pulse.classList.add('active');
            }
        }
    });
}

function updateMacroFeed(data) {
    const updates = data.isBatch ? data.updates : [data];
    updates.forEach(u => {
        if (u.symbol === 'DXY' || u.symbol.includes('DX-Y')) {
            const el = document.getElementById('dxy-val-hud');
            if (el) el.innerText = u.price.toFixed(2);
        }
        if (u.symbol === 'VIX' || u.symbol === '^VIX') {
            const el = document.getElementById('vix-val-ticker');
            if (el) el.innerText = u.price.toFixed(2);
        }
    });
}

function updateMarkersUI(m, sym) {
    if (!m) return;
    const prec = sym?.includes('=X') ? 5 : 2;
    setEl('midnight-open-val', m.midnightOpen, prec);
    setEl('pdh-val', m.pdh, prec);
    setEl('pdl-val', m.pdl, prec);
    setEl('vwap-val', m.vwap, prec);
    setEl('adr-val', m.adr, prec);
    setEl('call-wall-val', m.callWall, prec);
    setEl('put-wall-val', m.putWall, prec);
    setEl('t1-vpoc-val', m.poc, prec);

    // Update Imbalance Bar
    const imbBar = document.getElementById('imbalance-bar');
    const imbText = document.getElementById('imbalance-text');
    if (imbBar && m.whaleImbalance !== undefined) {
        const pct = 50 + (m.whaleImbalance / 2);
        imbBar.style.width = `${pct}%`;
        if (imbText) imbText.innerText = `${pct.toFixed(0)}% BULL / ${(100-pct).toFixed(0)}% BEAR`;
    }
}

function updateMacroCorrelation(data) {
    const roroBar = document.getElementById('roro-bar');
    if (roroBar && data.roro !== undefined) roroBar.style.width = `${data.roro}%`;
    
    // Update DXY/VIX HUDs
    if (data.internals) {
        setEl('dxy-val-hud', data.internals.dxy, 2);
        setEl('vix-val-ticker', data.internals.vix, 2);
    }
}

function updateChecklist(data) {
    const b = data.bias || {};
    const checklist = { 'tf-alignment': (data.confluenceScore || 0) > 65, 'signal-stable': b.bias !== 'NEUTRAL' };
    Object.entries(checklist).forEach(([key, active]) => {
        const item = document.getElementById(`check-${key}`);
        if (item) {
            const circle = item.querySelector('.check-circle');
            if (circle) circle.style.background = active ? 'var(--bullish)' : 'transparent';
        }
    });
}

function updateMagnets(data) {
    const m = data.markers || {};
    const d = m.draws || {};
    const prec = data.symbol?.includes('=X') ? 5 : 2;
    const bsl = document.getElementById('magnet-bsl-price');
    if (bsl && d.highs) bsl.innerText = d.highs[0]?.toFixed(prec);
}

function updateRecommendationUI(rec, symbol) {
    const action = document.getElementById('rec-action');
    if (action) {
        action.innerText = rec.action || 'WAIT';
        action.className = rec.action?.includes('CALL') ? 'bullish-text' : 'bearish-text';
    }
    const rationale = document.getElementById('rec-rationale');
    if (rationale) rationale.innerText = rec.rationale || 'SCANNING...';
}

function updateCotUI(data, sym) {
    const cot = data.institutionalSentiment;
    const el = document.getElementById('cot-bias-val');
    if (el && cot) el.innerText = cot.bias;
}

function renderWhaleTape(block) {
    const tape = document.getElementById('whale-tape-list');
    if (!tape) return;
    const row = document.createElement('div');
    row.style.padding = '4px';
    row.innerHTML = `<span style="color:var(--gold)">$${(block.value/1000000).toFixed(1)}M ${block.symbol}</span>`;
    tape.prepend(row);
    if (tape.children.length > 15) tape.lastElementChild.remove();
}

function showToast(msg, type) {
    const t = document.createElement('div');
    t.className = `toast ${type}`; t.innerText = msg;
    document.body.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 500); }, 3000);
}

function startClocks() {
    setInterval(() => {
        const ny = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
        const el = document.getElementById('ny-clock');
        if (el) el.innerText = ny + ' EST';
    }, 1000);
}

function setupUIControls() {
    const search = document.getElementById('global-search');
    if (search) {
        search.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                let val = search.value.toUpperCase().trim();
                if (val) {
                    currentSymbol = val;
                    socket.emit('switch_symbol', val);
                    loadChartHistory(val, currentTimeframe);
                }
            }
        });
    }

    document.querySelectorAll('.tf-btn[data-tf]').forEach(btn => {
        btn.onclick = () => {
            const tf = btn.getAttribute('data-tf');
            if (tf) {
                currentTimeframe = tf;
                document.querySelectorAll('.tf-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                socket.emit('switch_timeframe', tf);
                loadChartHistory(currentSymbol, tf);
            }
        };
    });
}

function updateG7SpiderMatrix(data) {
    const grid = document.getElementById('spider-grid');
    if (!grid || !data.g7Sectors) return;

    data.g7Sectors.forEach(curData => {
        const node = grid.querySelector(`[data-cur="${curData.symbol}"]`);
        if (!node) return;

        const valEl = node.querySelector('.val');
        const fillEl = node.querySelector('.strength-bar-fill');
        const badge = node.querySelector('.exhaustion-badge');

        if (valEl) {
            valEl.innerText = (curData.perf >= 0 ? '+' : '') + curData.perf.toFixed(2) + '%';
            valEl.style.color = curData.perf >= 0 ? 'var(--bullish)' : 'var(--bearish)';
        }

        if (fillEl) {
            const width = Math.min(100, 50 + (curData.perf * 50));
            fillEl.style.width = width + '%';
            fillEl.style.background = curData.perf >= 0 ? 'var(--bullish)' : 'var(--bearish)';
        }

        if (curData.mtf && node.querySelector('.mtf-dots')) {
            ['1m', '5m', '1h'].forEach(tf => {
                const dot = node.querySelector(`.tf-dot[data-tf="${tf}"]`);
                if (dot) {
                    const impulse = curData.mtf[tf] || 0;
                    dot.style.background = impulse > 0 ? 'var(--bullish)' : (impulse < 0 ? 'var(--bearish)' : 'rgba(255,255,255,0.1)');
                    if (Math.abs(impulse) > 0.05) dot.classList.add('pulse');
                    else dot.classList.remove('pulse');
                }
            });
        }

        // Exhaustion detection
        if (badge) {
            if (Math.abs(curData.perf) > 0.8) {
                badge.innerText = curData.perf > 0 ? 'OVERBOUGHT' : 'OVERSOLD';
                badge.style.display = 'block';
                badge.style.background = curData.perf > 0 ? 'var(--bearish)' : 'var(--bullish)';
            } else {
                badge.style.display = 'none';
            }
        }
    });

    // Update Header
    const topCur = data.g7Sectors.sort((a,b) => b.perf - a.perf)[0];
    const weakCur = data.g7Sectors.sort((a,b) => a.perf - b.perf)[0];
    
    setEl('g7-top-cur', topCur?.symbol);
    setEl('g7-top-val', (topCur?.perf >= 0 ? '+' : '') + topCur?.perf.toFixed(2) + '%');
    setEl('g7-weak-cur', weakCur?.symbol);
    setEl('g7-weak-val', (weakCur?.perf >= 0 ? '' : '') + weakCur?.perf.toFixed(2) + '%');

    if (data.g7?.bestPair) {
        setEl('g7-best-pair', data.g7.bestPair.symbol ? data.g7.bestPair.symbol.replace('=X', '') : `${data.g7.bestPair.strong}/${data.g7.bestPair.weak}`);
        setEl('g7-best-dir', `DIVERGENCE: ${data.g7.bestPair.divergence}%`);
    }
}

function updateEquitySpiderMatrix(data) {
    const grid = document.getElementById('equity-spider-grid');
    if (!grid || !data.equitySectors) return;

    data.equitySectors.forEach(sector => {
        let node = grid.querySelector(`[data-sector="${sector.symbol}"]`);
        if (!node) {
            node = document.createElement('div');
            node.className = 'spider-node';
            node.setAttribute('data-sector', sector.symbol);
            node.style.textAlign = 'center';
            node.style.background = 'rgba(255,255,255,0.03)';
            node.style.padding = '5px';
            node.style.borderRadius = '4px';
            node.style.border = '1px solid rgba(255,255,255,0.05)';
            node.innerHTML = `
                <div style="font-size: 0.6rem; font-weight: 900; color: var(--text-dim);">${sector.symbol}</div>
                <div class="val" style="font-size: 0.7rem; font-family: 'JetBrains Mono'; font-weight: 800;">0.00%</div>
            `;
            grid.appendChild(node);
        }

        const valEl = node.querySelector('.val');
        if (valEl) {
            valEl.innerText = (sector.perf >= 0 ? '+' : '') + sector.perf.toFixed(2) + '%';
            valEl.style.color = sector.perf >= 0 ? 'var(--bullish)' : 'var(--bearish)';
        }
    });
}

function updateChartPriceLines(m, symbol) {
    if (!chart || !candleSeries || !m) return;
    
    // Clear old lines
    priceLines.forEach(l => candleSeries.removePriceLine(l));
    priceLines = [];

    const prec = symbol?.includes('=X') ? 5 : 2;
    const addLine = (price, label, color, style = LightweightCharts.LineStyle.Dashed) => {
        if (!price || price <= 0) return;
        const line = candleSeries.createPriceLine({
            price: price,
            color: color,
            lineWidth: 1,
            lineStyle: style,
            axisLabelVisible: true,
            title: label,
        });
        priceLines.push(line);
    };

    if (m.midnightOpen) addLine(m.midnightOpen, 'MIDNIGHT OPEN', 'var(--cyan)', LightweightCharts.LineStyle.Solid);
    if (m.pdh) addLine(m.pdh, 'PREV DAY HIGH', 'var(--gold)');
    if (m.pdl) addLine(m.pdl, 'PREV DAY LOW', 'var(--gold)');
    if (m.vwap) addLine(m.vwap, 'VWAP', 'rgba(255,255,255,0.4)');

    // OTE Zones
    if (m.ote?.entry705) {
        addLine(m.ote.entry705, 'OTE 70.5%', 'var(--bullish)', LightweightCharts.LineStyle.Dotted);
    }
}

function updateWatchlistUI(watchlist) {
    if (!watchlist || !Array.isArray(watchlist)) return;
    
    const stocksList = document.getElementById('stocks-list');
    const forexList = document.getElementById('forex-list');
    
    const equities = watchlist.filter(item => !item.symbol.includes('=X') && !item.symbol.includes('-USD') && !item.symbol.includes('^') && item.symbol !== 'DXY');
    const forexCrypto = watchlist.filter(item => item.symbol.includes('=X') || item.symbol.includes('-USD') || item.symbol === 'BTC-USD' || item.symbol === 'ETH-USD' || item.symbol === 'DXY');

    const renderItem = (item) => `
        <div class="watchlist-item" style="padding: 8px 12px; cursor: pointer; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid rgba(255,255,255,0.03); transition: background 0.2s;" onclick="switchSymbol('${item.symbol}')" onmouseover="this.style.background='rgba(255,255,255,0.03)'" onmouseout="this.style.background='transparent'">
            <div style="font-weight: 800; font-size: 0.7rem; color: #fff;">${item.symbol.replace('=X', '')}</div>
            <div style="display: flex; flex-direction: column; align-items: flex-end;">
                <div style="font-family: 'JetBrains Mono'; font-size: 0.65rem; color: ${(item.dailyChangePercent || 0) >= 0 ? 'var(--bullish)' : 'var(--bearish)'}; font-weight: 900;">${(item.price || 0).toFixed(item.symbol.includes('=X') ? 5 : 2)}</div>
                <div style="font-size: 0.5rem; color: var(--text-dim);">${item.bias || 'NEUTRAL'}</div>
            </div>
        </div>
    `;

    if (stocksList) {
        stocksList.innerHTML = equities.length > 0 ? equities.map(renderItem).join('') : '<div style="text-align:center; color:var(--text-dim); padding:20px 0; font-size:0.5rem; font-style:italic;">Scanning Equities...</div>';
        const countEl = document.getElementById('stocks-count');
        if (countEl) countEl.innerText = `${equities.length} TICKERS`;
    }
    
    if (forexList) {
        forexList.innerHTML = forexCrypto.length > 0 ? forexCrypto.map(renderItem).join('') : '<div style="text-align:center; color:var(--text-dim); padding:20px 0; font-size:0.5rem; font-style:italic;">Scanning Forex...</div>';
        const countEl = document.getElementById('forex-count');
        if (countEl) countEl.innerText = `${forexCrypto.length} TICKERS`;
    }
}

function updateConfluenceUI(score) {
    const el = document.getElementById('radar-ir-score');
    if (el) {
        el.innerText = score.toString().padStart(2, '0');
        el.style.color = score >= 70 ? 'var(--bullish)' : (score <= 30 ? 'var(--bearish)' : 'var(--gold)');
    }
    const bar = document.getElementById('confidence-bar');
    if (bar) {
        bar.style.width = score + '%';
        bar.style.background = score >= 70 ? 'var(--bullish)' : (score <= 30 ? 'var(--bearish)' : 'var(--gold)');
    }
}

window.switchSymbol = function(sym) {
    currentSymbol = sym;
    socket.emit('switch_symbol', sym);
    loadChartHistory(sym, currentTimeframe);
}

function setEl(id, val, prec = 2) {
    const el = document.getElementById(id);
    if (el && val != null) el.innerText = typeof val === 'number' ? val.toFixed(prec) : val;
}

function restoreEntryTracker() {
    const saved = localStorage.getItem(TG_ENTRY_KEY);
    if (saved) window._tgEntryPrice = parseFloat(saved);
}

function updateBadges(data) {
    const m = data.markers || {};
    const b = data.institutionalSentiment || data.bias || {};

    // 1. AMD Phase
    const amdHud = document.getElementById('amd-hud');
    if (amdHud) {
        const phase = m.radar?.amdPhase || b.amdPhase || 'ACCUMULATION';
        amdHud.innerText = phase;
        amdHud.className = 'amd-hud ' + phase.toLowerCase();
    }

    // 2. Logic Badges (Show/Hide)
    const toggleBadge = (id, active) => {
        const el = document.getElementById(id);
        if (el) el.style.display = active ? 'block' : 'none';
    };

    toggleBadge('mss-badge', m.mss || b.mss);
    toggleBadge('smt-badge', m.smt || b.smt);
    toggleBadge('fvg-badge', m.fvg || b.fvg);
    toggleBadge('trap-badge', b.dxyAnchor?.alignment === 'CORRELATION_TRAP');
    toggleBadge('absorption-badge', m.absorption || b.absorption);
    toggleBadge('squeeze-badge', m.squeeze || b.squeeze);
    toggleBadge('displacement-badge', m.isDisplacement || b.isDisplacement);
}

function updateAIAnalyst(data) {
    const aiEl = document.getElementById('ai-analyst-feed');
    if (!aiEl || !data.analysis) return;
    // Append or update narrative
    if (data.analysis.narrative) {
        // Simple implementation for now
        aiEl.innerHTML = `<div class="ai-msg"><b>ANALYST:</b> ${data.analysis.narrative}</div>`;
    }
}

// RESTORED INSTITUTIONAL BOARD SYNC
function startClocks() {
    setInterval(() => {
        const ny = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date());
        const el = document.getElementById('ny-clock');
        if (el) el.innerText = ny + ' EST';
    }, 1000);
}
