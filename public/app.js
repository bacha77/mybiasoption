const socket = io();

socket.on('whale_alert', (block) => {
    showToast(`🐋 WHALE ALERT: ${block.symbol} | $${(block.value / 1000000).toFixed(2)}M Block!`);
    const card = document.querySelector('.sidebar section:nth-child(4)'); // Block Feed card
    if (card) {
        card.classList.add('whale-flash');
        setTimeout(() => card.classList.remove('whale-flash'), 5000);
    }
});

// DOM elements
const priceEl = document.getElementById('current-price');
const changeEl = document.getElementById('price-change');
const biasLabel = document.getElementById('bias-label');
const biasConfFill = document.getElementById('bias-conf-fill');
const heatmapContainer = document.getElementById('heatmap');
const vwapEl = document.getElementById('vwap-val');
const pocEl = document.getElementById('poc-val');
const cvdEl = document.getElementById('cvd-val');
const adrEl = document.getElementById('adr-val');
const pdhEl = document.getElementById('pdh-val');
const pdlEl = document.getElementById('pdl-val');
const midnightEl = document.getElementById('midnight-open-val');
const vixEl = document.getElementById('vix-val-regime');
const vixValEl = document.getElementById('vix-val-macro');
const vixNeedle = document.getElementById('vix-needle');
const latencyEl = document.getElementById('latency-val');
const nyClockEl = document.getElementById('ny-clock');
const globalSearch = document.getElementById('global-search');
const toastContainer = document.getElementById('toast-container');
const watchlistList = document.getElementById('watchlist-list');
const tradeHistoryBody = document.getElementById('trade-history-body');
const recAction = document.getElementById('rec-action');
const recStrike = document.getElementById('rec-strike');
const recTarget = document.getElementById('rec-target');
const recRationale = document.getElementById('rec-rationale');
const recBox = document.getElementById('rec-box');
const recRR = document.getElementById('rec-rr');
const trapBadge = document.getElementById('trap-badge');
const netWhaleVal = document.getElementById('net-whale-val');
const simBalanceVal = document.getElementById('sim-balance-val');
const dxyValEl = document.getElementById('dxy-val');
const dxyBarEl = document.getElementById('dxy-bar');
const vixBarEl = document.getElementById('vix-bar');
const eventTimerEl = document.getElementById('event-timer');
const confluenceScoreEl = document.getElementById('master-confluence-score');
const vixRegimeBadge = document.getElementById('vix-regime-badge');
const breadthValEl = document.getElementById('breadth-val');
const dxyHudEl = document.getElementById('dxy-val-hud');
const tnxHudEl = document.getElementById('tnx-val-hud');
const broadTickerEl = document.getElementById('breadth-val-ticker');
const vixTickerEl = document.getElementById('vix-val-ticker');
const confTickerEl = document.getElementById('confluence-val-ticker');
const bslMagnetPrice = document.getElementById('magnet-bsl-price');
const bslMagnetDist = document.getElementById('magnet-bsl-dist');
const sslMagnetPrice = document.getElementById('magnet-ssl-price');
const sslMagnetDist = document.getElementById('magnet-ssl-dist');
const whaleTickerScroll = document.querySelector('.ticker-scroll');
const smtBadge = document.getElementById('smt-badge');
const absorptionBadge = document.getElementById('absorption-badge');
const imbalanceBar = document.getElementById('imbalance-bar');
const imbalanceText = document.getElementById('imbalance-text');
const fvgBadge = document.getElementById('fvg-badge');
const bloombergBadge = document.getElementById('bloomberg-sentiment-badge');
const biasGaugeWrapper = document.querySelector('.bias-gauge-container');
const amdHud = document.getElementById('amd-hud');
const mssBadge = document.getElementById('mss-badge');
const intermarketBadge = document.getElementById('intermarket-badge');

// Trigger Checklist Elements
const btnUnlockSignal = document.getElementById('btn-unlock-signal');
const checklistModal = document.getElementById('checklist-modal');
const btnCloseChecklist = document.getElementById('btn-close-checklist');
const btnConfirmTrade = document.getElementById('btn-confirm-trade');
const triggerChecks = document.querySelectorAll('.trigger-check');

const alertSound = new Audio('https://assets.mixkit.co/sfx/preview/mixkit-notification-alert-2354.mp3');
let lastSignalAction = '';
let lastPrice = 0;
let signalUnlocked = false;
let pendingSignalData = null;

// Add Symbol Management
document.getElementById('btn-add-symbol')?.addEventListener('click', () => {
    const symbol = prompt("Enter Ticker Symbol (e.g. MSFT):");
    if (symbol) {
        fetch('/api/watchlist/add', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ symbol })
        }).then(r => r.json()).then(res => {
            showToast(`Added ${symbol} to watchlist`);
        });
    }
});

// Search Logic
globalSearch?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        const symbol = globalSearch.value.toUpperCase().trim();
        if (symbol) {
            console.log(`[UI] Searching for symbol: ${symbol}`);
            socket.emit('switch_symbol', symbol);
            globalSearch.value = '';
            showToast(`Switching to ${symbol}...`);
        }
    }
});

// Latency & Clock
setInterval(() => {
    const start = Date.now();
    socket.emit('ping_latency', () => {
        const latency = Date.now() - start;
        if (latencyEl) latencyEl.innerText = latency;
    });

    if (nyClockEl) {
        nyClockEl.innerText = new Date().toLocaleTimeString('en-US', {
            timeZone: 'America/New_York',
            hour12: false,
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        }) + ' EST';
    }
}, 1000);


// Timeframe Switchers
document.querySelectorAll('.tf-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const tf = btn.dataset.tf;
        console.log(`[UI] Timeframe button clicked: ${tf}`);
        document.querySelectorAll('.tf-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        socket.emit('switch_timeframe', tf);
    });
});

let tvChart;
let candleSeries;
let currentPriceLines = [];

function updateChartOverlays(data) {
    if (!candleSeries || !data.markers) return;

    // Clear old lines
    currentPriceLines.forEach(line => candleSeries.removePriceLine(line));
    currentPriceLines = [];

    const m = data.markers;
    const currentPrice = data.currentPrice;
    const isFX = data.symbol.includes('=X') || data.symbol.includes('USD');
    const labelThreshold = currentPrice * 0.0015; // 0.15% threshold for label collision

    const levels = [];

    // --- Institutional Priority System ---
    if (m.midnightOpen > 0) levels.push({ price: m.midnightOpen, color: '#38bdf8', style: 1, title: 'MID OPEN', weight: 10 });
    if (m.nyOpen > 0) levels.push({ price: m.nyOpen, color: '#10b981', style: 2, title: 'NY OPEN', weight: 9 });
    if (m.pdh > 0) levels.push({ price: m.pdh, color: 'rgba(255, 255, 255, 0.7)', style: 1, title: 'PDH', weight: 8 });
    if (m.pdl > 0) levels.push({ price: m.pdl, color: 'rgba(255, 255, 255, 0.7)', style: 1, title: 'PDL', weight: 8 });
    if (m.vwap > 0) levels.push({ price: m.vwap, color: '#f59e0b', style: 0, title: 'VWAP', weight: 7 });
    if (m.poc > 0) levels.push({ price: m.poc, color: '#8b5cf6', style: 1, title: 'POC', weight: 6 });

    // Equilibrium / Range
    if (m.todayHigh > 0 && m.todayLow > 0) {
        const equilibrium = (m.todayHigh + m.todayLow) / 2;
        levels.push({ price: equilibrium, color: 'rgba(245, 158, 11, 0.4)', style: 2, title: 'EQ', weight: 5 });
        levels.push({ price: m.todayHigh, color: 'rgba(148, 163, 184, 0.2)', style: 1, title: 'T-HIGH', weight: 3 });
        levels.push({ price: m.todayLow, color: 'rgba(148, 163, 184, 0.2)', style: 1, title: 'T-LOW', weight: 3 });
    }

    if (m.pdc > 0) levels.push({ price: m.pdc, color: 'rgba(148, 163, 184, 0.4)', style: 2, title: 'PDC', weight: 4 });

    // 1. ORDER BLOCKS (Zones)
    if (data.bias && data.bias.orderBlock) {
        const ob = data.bias.orderBlock;
        const obColor = ob.type.includes('BULLISH') ? 'rgba(16, 185, 129, 0.2)' : 'rgba(244, 63, 94, 0.2)';
        levels.push({ price: ob.top, color: obColor, style: 2, title: 'OB ZONE', weight: 2 });
        levels.push({ price: ob.bottom, color: obColor, style: 2, title: '', weight: 1 });
    }

    // 2. FVG
    if (data.bias && data.bias.fvg) {
        const fvg = data.bias.fvg;
        const fvgColor = fvg.type.includes('BULLISH') ? 'rgba(6, 182, 212, 0.15)' : 'rgba(244, 63, 94, 0.15)';
        levels.push({ price: fvg.top, color: fvgColor, style: 2, title: 'FVG Target', weight: 2 });
        levels.push({ price: fvg.bottom, color: fvgColor, style: 2, title: '', weight: 1 });
    }

    // Sort and allocate labels
    levels.sort((a, b) => b.weight - a.weight);
    const shownLabels = [];

    levels.forEach(lvl => {
        let showLabel = true;
        for (let shown of shownLabels) {
            if (Math.abs(lvl.price - shown) < labelThreshold) { showLabel = false; break; }
        }
        if (showLabel && lvl.title) shownLabels.push(lvl.price);

        const line = candleSeries.createPriceLine({
            price: lvl.price,
            color: lvl.color,
            lineWidth: 1,
            lineStyle: lvl.style,
            title: showLabel ? lvl.title : '',
            axisLabelVisible: showLabel,
        });
        currentPriceLines.push(line);
    });

    // 4. VERTICAL KILL ZONES (Timing) & 5. LIQUIDATION SWEEP MARKERS
    const now = new Date();
    const midnightTs = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0).getTime() / 1000;
    const londonTs = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 3, 0, 0).getTime() / 1000;
    const nyTs = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 30, 0).getTime() / 1000;

    const allMarkers = [];

    // --- Time Markers (Kill Zones) ---
    allMarkers.push({ time: midnightTs, position: 'belowBar', color: 'rgba(56, 189, 248, 0.4)', shape: 'arrowUp', text: 'MIDNIGHT' });
    allMarkers.push({ time: londonTs, position: 'belowBar', color: 'rgba(139, 92, 246, 0.4)', shape: 'arrowUp', text: 'LONDON' });
    allMarkers.push({ time: nyTs, position: 'belowBar', color: 'rgba(16, 185, 129, 0.4)', shape: 'arrowUp', text: 'NY OPEN' });

    // --- Sweep Markers ---
    if (data.sweeps && data.sweeps.length > 0) {
        data.sweeps.forEach(s => {
            allMarkers.push({
                time: Math.floor(s.timestamp / 1000),
                position: s.type.includes('BSL') ? 'aboveBar' : 'belowBar',
                color: s.type.includes('BSL') ? '#ef4444' : '#22c55e',
                shape: s.type.includes('BSL') ? 'arrowDown' : 'arrowUp',
                text: 'SWEEP'
            });
        });
    }

    // 5. MSS (Market Structure Shift)
    if (data.bias && data.bias.mss) {
        allMarkers.push({
            time: Math.floor(data.bias.mss.timestamp / 1000),
            position: data.bias.mss.type.includes('BULLISH') ? 'belowBar' : 'aboveBar',
            color: '#a855f7',
            shape: 'circle',
            text: 'MSS'
        });
    }

    // 6. FUNDING CANDLE (Institutional Injection)
    if (data.bias && data.bias.fundingCandle) {
        allMarkers.push({
            time: Math.floor(data.bias.fundingCandle.timestamp / 1000),
            position: 'inBar',
            color: '#f43f5e',
            shape: 'square',
            text: 'FUND'
        });
    }

    // Sort markers by time and apply
    allMarkers.sort((a, b) => a.time - b.time);
    candleSeries.setMarkers(allMarkers);
}

// Initialize Chart
function initChart(initialCandles) {
    try {
        console.log(`[CHART] initChart starting with ${initialCandles?.length || 0} candles.`);
        const container = document.getElementById('priceChart');
        if (!container) {
            console.error("[CHART] Container #priceChart not found!");
            return;
        }

        container.innerHTML = '';
        const width = container.clientWidth || (window.innerWidth < 768 ? 300 : 800);
        const height = window.innerWidth < 768 ? 300 : 400;
        console.log(`[CHART] Initializing chart with size: ${width}x${height}`);

        if (typeof LightweightCharts === 'undefined') {
            console.error("[CHART] LightweightCharts library is NOT loaded!");
            return;
        }

        // --- Responsive Resizer ---
        window.addEventListener('resize', () => {
            if (tvChart && container) {
                const newWidth = container.clientWidth;
                const newHeight = window.innerWidth < 768 ? 300 : 400;
                tvChart.applyOptions({ width: newWidth, height: newHeight });
            }
        });

        tvChart = LightweightCharts.createChart(container, {
            width: width,
            height: height,
            layout: {
                background: { color: '#0b1120' },
                textColor: '#94a3b8',
                fontFamily: "'Inter', sans-serif",
            },
            grid: {
                vertLines: { color: 'rgba(255, 255, 255, 0.03)', style: 1 },
                horzLines: { color: 'rgba(255, 255, 255, 0.03)', style: 1 },
            },
            rightPriceScale: {
                borderColor: '#1e293b',
                visible: true,
                autoScale: true,
                scaleMargins: {
                    top: 0.15,
                    bottom: 0.15,
                },
            },
            watermark: {
                visible: true,
                fontSize: 24,
                horzAlign: 'center',
                vertAlign: 'center',
                color: 'rgba(56, 189, 248, 0.05)',
                text: 'B.I.A.S ELITE',
            },
            localization: {
                locale: 'en-US',
                timeFormatter: (timestamp) => {
                    return new Date(timestamp * 1000).toLocaleString('en-US', {
                        hour: '2-digit',
                        minute: '2-digit',
                        hour12: false,
                        timeZone: 'America/New_York'
                    });
                },
            },
            timeScale: {
                borderColor: '#1e293b',
                timeVisible: true,
                secondsVisible: false,
                barSpacing: 10,
                rightOffset: 5,
                tickMarkFormatter: (time, tickMarkType, locale) => {
                    const date = new Date(time * 1000);
                    const options = { timeZone: 'America/New_York', hour12: false };

                    let result;
                    if (tickMarkType < 2) {
                        options.month = 'short';
                        options.day = 'numeric';
                        result = date.toLocaleString('en-US', options);
                    } else {
                        options.hour = '2-digit';
                        options.minute = '2-digit';
                        result = date.toLocaleString('en-US', options);
                    }
                    return result;
                },
            },
            crosshair: {
                mode: LightweightCharts.CrosshairMode.Normal,
                vertLine: { color: '#38bdf8', width: 1, style: 2, labelBackgroundColor: '#38bdf8' },
                horzLine: { color: '#38bdf8', width: 1, style: 2, labelBackgroundColor: '#38bdf8' },
            }
        });

        candleSeries = tvChart.addCandlestickSeries({
            upColor: '#10b981',
            downColor: '#f43f5e',
            borderVisible: true,
            borderColor: '#10b981',
            wickColor: '#10b981',
            borderUpColor: '#10b981',
            borderDownColor: '#f43f5e',
            wickUpColor: '#10b981',
            wickDownColor: '#f43f5e',
        });

        if (initialCandles && initialCandles.length > 0) {
            const seenTs = new Set();
            const formattedData = initialCandles
                .filter(c => c.open != null && c.open > 0 && c.high != null && c.low != null && c.close != null)
                .map(c => ({
                    time: Math.floor(c.timestamp / 1000),
                    open: c.open,
                    high: c.high,
                    low: c.low,
                    close: c.close
                }))
                .filter(c => {
                    if (seenTs.has(c.time)) return false;
                    seenTs.add(c.time);
                    return true;
                })
                .sort((a, b) => a.time - b.time);

            console.log(`[CHART] Formatted ${formattedData.length} unique candles. First: ${formattedData[0]?.time}, Last: ${formattedData[formattedData.length - 1]?.time}`);

            if (formattedData.length > 0) {
                candleSeries.setData(formattedData);
                console.log("[CHART] setData executed.");
                setTimeout(() => {
                    if (tvChart) {
                        tvChart.timeScale().fitContent();
                        tvChart.timeScale().applyOptions({ barSpacing: 12 });
                    }
                    console.log("[CHART] fitContent + barSpacing applied.");
                }, 200);
            }
        }

        const resizeObserver = new ResizeObserver(entries => {
            if (tvChart && entries.length > 0) {
                const { width } = entries[0].contentRect;
                tvChart.applyOptions({ width });
            }
        });
        resizeObserver.observe(container);
    } catch (err) {
        console.error("[CHART] ERROR in initChart:", err);
    }
}

socket.on('init', (data) => {
    console.log(`[SOCKET] Received init for ${data.symbol}`);
    initChart(data.candles || []);
    updateUI(data);

    // If no candles were returned (weekend/holiday/market closed), auto-request 5m data
    if (!data.candles || data.candles.length === 0) {
        console.log('[UI] No 1m candles received on init — market may be closed. Auto-switching to 5m...');
        const btn5m = document.querySelector('.tf-btn[data-tf="5m"]');
        if (btn5m) {
            document.querySelectorAll('.tf-btn').forEach(b => b.classList.remove('active'));
            btn5m.classList.add('active');
        }
        socket.emit('switch_timeframe', '5m');
    }
});

socket.on('update', (data) => {
    updateUI(data);
    if (candleSeries && data.candles && data.candles.length > 0) {
        const lastCandle = data.candles[data.candles.length - 1];
        if (lastCandle.timestamp && lastCandle.open != null) {
            const timeInSeconds = Math.floor(Number(lastCandle.timestamp) / 1000);
            try {
                candleSeries.update({
                    time: timeInSeconds,
                    open: Number(lastCandle.open),
                    high: Number(lastCandle.high),
                    low: Number(lastCandle.low),
                    close: Number(lastCandle.close)
                });
            } catch (e) {
                console.warn("[CHART] Update skipped (likely older/duplicate timestamp):", timeInSeconds);
            }
        }
    }
});

socket.on('tf_updated', (data) => {
    console.log(`[SOCKET] TF Updated: ${data.timeframe}, candles: ${data.candles?.length}`);
    if (data.candles && candleSeries) {
        const seenTs = new Set();
        const formattedData = data.candles
            .filter(c => c.open != null && c.open > 0 && c.high != null && c.low != null && c.close != null)
            .map(c => ({
                time: Math.floor(c.timestamp / 1000),
                open: c.open,
                high: c.high,
                low: c.low,
                close: c.close
            }))
            .filter(c => {
                if (seenTs.has(c.time)) return false;
                seenTs.add(c.time);
                return true;
            })
            .sort((a, b) => a.time - b.time);

        if (formattedData.length > 0) {
            candleSeries.setData(formattedData);
            setTimeout(() => {
                if (tvChart) tvChart.timeScale().fitContent();
            }, 100);
        }
    }
    if (data.watchlist) updateWatchlist(data);
});

socket.on('symbol_updated', (data) => {
    console.log(`[SOCKET] Symbol Updated: ${data.symbol}`);
    initChart(data.candles || []);
    updateUI(data);
});

socket.on('watchlist_updated', (data) => {
    console.log(`[SOCKET] Global Watchlist Updated: ${data.watchlist?.length || 0} symbols`);
    updateWatchlist(data);
});

async function updateHistory() {
    if (!tradeHistoryBody) return;
    try {
        const res = await fetch('/api/trades');
        const trades = await res.json();
        tradeHistoryBody.innerHTML = trades.map(t => `
            <tr>
                <td class="w-sym">${t.symbol}</td>
                <td class="${t.profit > 0 ? 'bullish-text' : 'bearish-text'}">$${t.profit.toFixed(0)}</td>
                <td style="font-size: 0.65rem; color: var(--text-dim); text-align:right;">${t.reason}</td>
            </tr>
        `).join('') || '<tr><td colspan="3" style="text-align:center;">No history yet.</td></tr>';
    } catch (e) { }
}
setInterval(updateHistory, 30000);
updateHistory();

function updateUI(data) {
    if (!data) return;

    // Refresh Institutional Chart Overlays
    updateChartOverlays(data);

    // Symbol Display
    const symbolDisplay = document.getElementById('symbol-display');
    if (symbolDisplay) symbolDisplay.innerText = data.symbol || 'SPY';

    if (data.simBalance && simBalanceVal) {
        simBalanceVal.innerText = `$${data.simBalance.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
    }

    // Active Positions
    const activeTradesContainer = document.getElementById('active-trades-container');
    if (activeTradesContainer && data.activeTrades) {
        if (data.activeTrades.length === 0) {
            activeTradesContainer.innerHTML = '<p style="color:var(--text-dim); text-align:center;">No active positions.</p>';
        } else {
            activeTradesContainer.innerHTML = data.activeTrades.map(trade => `
                <div style="padding: 10px; border-bottom: 1px solid var(--border); margin-bottom: 5px;">
                    <div style="display:flex; justify-content:space-between; font-weight:800;">
                        <span class="${trade.type.includes('CALL') ? 'bullish-text' : 'bearish-text'}">${trade.symbol}</span>
                        <span>$${trade.entryPrice.toFixed(trade.symbol.includes('=X') ? 4 : 2)}</span>
                    </div>
                    <div style="display:flex; justify-content:space-between; font-size:0.75rem; color:var(--text-dim); margin-top:5px;">
                        <span>Cost: $${trade.cost.toFixed(2)}</span>
                        <span>Contracts: ${trade.size}</span>
                    </div>
                    <div style="font-size:0.7rem; color: #fbbf24; margin-top:5px;">
                        TP: $${trade.tp.toFixed(trade.symbol.includes('=X') ? 4 : 2)} | SL: $${trade.sl.toFixed(trade.symbol.includes('=X') ? 4 : 2)}
                    </div>
                </div>
            `).join('');
        }
    }

    // --- WHALE TAPE REAL-TIME FEED ---
    if (whaleTickerScroll && data.blockTrades && data.blockTrades.length > 0) {
        const newestBlock = data.blockTrades[0];
        const newestId = `${newestBlock.symbol}_${newestBlock.value}_${newestBlock.time}`;
        if (whaleTickerScroll.dataset.lastId !== newestId) {
            whaleTickerScroll.dataset.lastId = newestId;
            whaleTickerScroll.innerHTML = data.blockTrades.map(b => `
                <div class="ticker-item">
                    <span class="ticker-sym" style="font-size: 0.75rem;">${b.symbol}</span>
                    <span class="${b.isElite ? 'ticker-val-gold' : b.type === 'BULLISH' ? 'ticker-val-bull' : 'ticker-val-bear'}" style="font-weight: 800; font-family: 'JetBrains Mono', monospace;">
                        $${(b.value / 1000).toFixed(0)}k @ ${b.price.toFixed(b.symbol.includes('=X') ? 4 : 2)}
                    </span>
                    <span style="opacity: 0.4; font-size: 0.55rem; font-family: 'JetBrains Mono', monospace;">[${b.time}]</span>
                </div>
            `).join(' <span style="opacity:0.2;">•</span> ');
        }
    }

    // Market Status
    if (data.session) {
        const sessionText = document.getElementById('market-session-text');
        const sessionDot = document.getElementById('market-status-dot');
        if (sessionText) sessionText.innerText = `${data.session.session} SESSION: ${data.session.status}`;
        if (sessionDot) sessionDot.style.background = data.session.color;
    }

    if (data.loading) {
        if (priceEl) priceEl.innerText = 'FETCHING...';
    } else {
        // Price & Change
        if (priceEl && data.currentPrice) {
            const isFX = data.symbol.includes('=X') || data.symbol.includes('USD');
            const newPrice = data.currentPrice;

            // Flash effect
            if (lastPrice > 0) {
                const priceContainer = priceEl.parentElement;
                priceContainer.classList.remove('flash-up', 'flash-down');
                void priceContainer.offsetWidth; // Trigger reflow
                if (newPrice > lastPrice) priceContainer.classList.add('flash-up');
                else if (newPrice < lastPrice) priceContainer.classList.add('flash-down');
            }
            lastPrice = newPrice;

            priceEl.innerText = newPrice.toLocaleString(undefined, {
                minimumFractionDigits: isFX ? 4 : 2,
                maximumFractionDigits: isFX ? 5 : 2
            });
        }
        if (changeEl) {
            const dailyChange = typeof data.dailyChangePercent === 'number' ? data.dailyChangePercent : 0;
            changeEl.innerText = `${dailyChange >= 0 ? '+' : ''}${dailyChange.toFixed(2)}%`;
            changeEl.className = 'main-change ' + (dailyChange >= 0 ? 'bullish-text' : 'bearish-text');
        }

        // Institutional Markers
        if (data.markers) {
            const isFX = data.symbol.includes('=X') || data.symbol.includes('USD');
            const precision = isFX ? 4 : 2;
            if (pdhEl) pdhEl.innerText = (data.markers.pdh || 0).toFixed(precision);
            if (pdlEl) pdlEl.innerText = (data.markers.pdl || 0).toFixed(precision);
            if (midnightEl) midnightEl.innerText = (data.markers.midnightOpen || 0).toFixed(precision);
            if (vwapEl) vwapEl.innerText = (data.markers.vwap || 0).toFixed(precision);
            if (pocEl) pocEl.innerText = (data.markers.poc || 0).toFixed(precision);
            if (adrEl) adrEl.innerText = (data.markers.adr || 0).toFixed(precision);
            if (cvdEl) {
                cvdEl.innerText = (data.markers.cvd || 0).toLocaleString();
                cvdEl.className = 'm-value ' + (data.markers.cvd >= 0 ? 'bullish-text' : 'bearish-text');
            }

            if (netWhaleVal) {
                const val = (data.markers.netWhaleFlow || 0) / 1000000;
                netWhaleVal.innerText = `$${val.toFixed(2)}M`;
                netWhaleVal.className = 'm-value ' + (val >= 0 ? 'bullish-text' : 'bearish-text');
            }

            // Update Whale Imbalance Bar
            if (imbalanceBar && imbalanceText) {
                const imb = data.markers.whaleImbalance || 0;
                const buyPct = Math.round(50 + (imb / 2));
                const sellPct = 100 - buyPct;
                imbalanceBar.style.width = `${buyPct}%`;
                imbalanceText.innerText = `${buyPct}% BULL / ${sellPct}% BEAR`;
            }

            // Update SMT Badge
            if (smtBadge) {
                if (data.markers.smt) {
                    smtBadge.style.display = 'inline-block';
                    smtBadge.innerText = `SMT: ${data.markers.smt.symbol} ${data.markers.smt.type}`;
                    smtBadge.className = 'smt-badge ' + (data.markers.smt.type === 'BULLISH' ? 'success' : 'danger');
                } else {
                    smtBadge.style.display = 'none';
                }
            }

            // Update Absorption Badge
            if (absorptionBadge) {
                if (data.bias && data.bias.absorption) {
                    absorptionBadge.style.display = 'inline-block';
                    absorptionBadge.innerText = data.bias.absorption.type.replace('_', ' ');
                } else {
                    absorptionBadge.style.display = 'none';
                }
            }

            // Update Market Breadth
            if (breadthValEl && data.bias && data.bias.internals) {
                const breadth = data.bias.internals.breadth || 50;
                breadthValEl.innerText = `${breadth.toFixed(0)}%`;
                breadthValEl.className = 'm-value ' + (breadth > 60 ? 'bullish-text' : breadth < 40 ? 'bearish-text' : 'gold-text');
                if (broadTickerEl) broadTickerEl.innerText = `${breadth.toFixed(0)}%`;
            }

            // Update Macro HUD
            if (dxyHudEl && data.bias && data.bias.internals) {
                const dxy = data.bias.internals.dxy || 0;
                dxyHudEl.innerText = dxy.toFixed(2);
                dxyHudEl.className = dxy > 103 ? 'bearish-text' : 'bullish-text';
            }
            if (tnxHudEl && data.bias && data.bias.internals) {
                const tnx = data.bias.internals.tnx || 0;
                tnxHudEl.innerText = `${tnx.toFixed(2)}%`;
                tnxHudEl.className = tnx > 4.2 ? 'bearish-text' : 'bullish-text';
            }
        }

        // Market Internals (VIX)
        if (data.bias && data.bias.internals && vixEl) {
            const vix = data.bias.internals.vix;
            vixEl.innerText = vix.toFixed(2);
            vixEl.className = 'm-value ' + (vix > 20 ? 'bearish-text' : 'bullish-text');
            if (vixTickerEl) vixTickerEl.innerText = vix.toFixed(2);
            updateVixGauge(vix);

            // Update VIX Regime Badge
            if (vixRegimeBadge) {
                if (vix > 30) {
                    vixRegimeBadge.innerText = 'CRISIS';
                    vixRegimeBadge.className = 'regime-badge crisis';
                } else if (vix > 20) {
                    vixRegimeBadge.innerText = 'VOLATILE';
                    vixRegimeBadge.className = 'regime-badge volatile';
                } else {
                    vixRegimeBadge.innerText = 'STABLE';
                    vixRegimeBadge.className = 'regime-badge';
                }
            }
        }

        // Global Confluence Score
        if (data.confluenceScore !== undefined && confluenceScoreEl) {
            confluenceScoreEl.innerText = `${data.confluenceScore}%`;
            confluenceScoreEl.style.color = data.confluenceScore >= 80 ? 'var(--bullish)' :
                data.confluenceScore <= 20 ? 'var(--bearish)' : 'var(--gold)';
        }

        // Trap Detector
        if (trapBadge) {
            if (data.bias && data.bias.trap) {
                trapBadge.style.display = 'block';
                trapBadge.innerText = `⚠️ ${data.bias.trap.type.replace('_', ' ')}`;
            } else {
                trapBadge.style.display = 'none';
            }
        }

        // FVG Detector
        if (fvgBadge) {
            if (data.bias && data.bias.fvg) {
                fvgBadge.style.display = 'block';
                fvgBadge.innerText = data.bias.fvg.type.replace('_', ' ');
                fvgBadge.className = 'fvg-badge ' + (data.bias.fvg.type.includes('BULLISH') ? 'success' : 'danger');
            } else {
                fvgBadge.style.display = 'none';
            }
        }

        // --- 🦄 UNICORN DETECTOR UI UPDATES ---
        if (amdHud && data.bias && data.bias.amdPhase) {
            amdHud.innerText = data.bias.amdPhase.label;
            amdHud.style.borderColor = data.bias.amdPhase.color;
            amdHud.style.color = data.bias.amdPhase.color;
            amdHud.setAttribute('title', data.bias.amdPhase.desc);

            // Update Macro Narrative Card
            const nPhase = document.getElementById('narrative-phase');
            const nText = document.getElementById('narrative-text');
            const nNext = document.getElementById('next-phase-forecast');
            const nStatus = document.getElementById('current-amd-status');

            if (nPhase) nPhase.innerText = data.bias.amdPhase.label;
            if (nText) nText.innerText = data.bias.amdPhase.description || data.bias.amdPhase.narrative;
            if (nNext) nNext.innerText = data.bias.amdPhase.next;
            if (nStatus) {
                nStatus.style.color = data.bias.amdPhase.color;
                nStatus.classList.toggle('status-manipulation', data.bias.amdPhase.label === 'MANIPULATION');
            }
        }

        if (mssBadge) {
            if (data.bias && data.bias.mss) {
                mssBadge.style.display = 'block';
                mssBadge.innerText = `MSS ${data.bias.mss.type === 'BULLISH_MSS' ? 'BULL' : 'BEAR'}`;
            } else {
                mssBadge.style.display = 'none';
            }
        }

        if (intermarketBadge) {
            if (data.bias && data.bias.intermarketCorrelation) {
                intermarketBadge.style.display = 'block';
                intermarketBadge.innerText = `CORR: ${data.bias.intermarketCorrelation.strength}%`;
            } else {
                intermarketBadge.style.display = 'none';
            }
        }

        // Bloomberg Sentiment Badge
        if (bloombergBadge) {
            if (data.bias && data.bias.bloombergSentiment) {
                bloombergBadge.style.display = 'block';
                bloombergBadge.innerText = data.bias.bloombergSentiment.label;
                bloombergBadge.style.color = data.bias.bloombergSentiment.color;
            } else {
                bloombergBadge.style.display = 'none';
            }
        }

        // Bias Gauge
        if (data.bias) {
            if (biasLabel) {
                biasLabel.innerText = data.bias.bias;
                biasLabel.className = 'bias-large ' + (data.bias.bias === 'BULLISH' ? 'bullish-text' : data.bias.bias === 'BEARISH' ? 'bearish-text' : '');
            }
            if (biasConfFill) {
                let score = data.bias.score || 0;
                let percent = 50 + (score * 5);
                biasConfFill.style.width = `${Math.max(5, Math.min(95, percent))}%`;
                biasConfFill.style.backgroundColor = score > 2 ? 'var(--bullish)' : score < -2 ? 'var(--bearish)' : 'var(--accent)';
            }

            // Neon Pulse Activation
            if (biasGaugeWrapper) {
                if (data.bias.confidence >= 80) {
                    biasGaugeWrapper.classList.add('bias-gauge-pulse');
                } else {
                    biasGaugeWrapper.classList.remove('bias-gauge-pulse');
                }
            }
        }

        // Recommendation
        if (data.recommendation) {
            const action = data.recommendation.action;
            const isTrade = action.includes('CALL') || action.includes('PUT');

            // Check if this is a new signal to trigger locking
            const signalKey = `${data.symbol}_${action}`;
            if (isTrade && lastSignalAction !== signalKey && action !== 'WAIT') {
                signalUnlocked = false; // Relock for new signal
                pendingSignalData = data;
            }

            if (recAction) {
                if (isTrade && !signalUnlocked) {
                    recAction.innerText = "LOCKED (AUDIT REQ)";
                    recAction.className = 'rec-action-text accent-text pulse-subtle';
                    if (btnUnlockSignal) btnUnlockSignal.style.display = 'block';
                } else {
                    recAction.innerText = action;
                    recAction.className = 'rec-action-text ' + (action.includes('CALL') ? 'bullish-text' : action.includes('PUT') ? 'bearish-text' : '');
                    if (btnUnlockSignal && !isTrade) btnUnlockSignal.style.display = 'none';
                }
            }
            if (recStrike) recStrike.innerText = data.recommendation.strike || '-';
            if (recTarget) recTarget.innerText = data.recommendation.target || '-';
            if (recRR) {
                const rr = data.recommendation.rrRatio || '0.0';
                recRR.innerText = `1:${rr}`;
                recRR.className = parseFloat(rr) >= 2 ? 'bullish-text' : 'bearish-text';
            }

            const trimEl = document.getElementById('rec-trim');
            const targetElItem = document.getElementById('rec-target');
            const slEl = document.getElementById('rec-sl');
            const sizeEl = document.getElementById('rec-size');
            const durEl = document.getElementById('rec-duration');
            const confEl = document.getElementById('rec-confidence');

            if (trimEl) trimEl.innerText = data.recommendation.trim || '-';
            if (targetElItem) targetElItem.innerText = data.recommendation.target || '-';
            if (slEl) slEl.innerText = data.recommendation.sl || '-';
            if (sizeEl) sizeEl.innerText = data.recommendation.size || '-';
            if (durEl) durEl.innerText = data.recommendation.duration || '-';
            if (confEl) confEl.innerText = `${data.recommendation.confidence || 0}%`;

            if (recRationale) recRationale.innerText = data.recommendation.rationale;

            if (recBox) {
                recBox.className = 'rec-box ' + (data.recommendation.action.includes('CALL') ? 'rec-call' : data.recommendation.action.includes('PUT') ? 'rec-put' : '');
            }

            // Audio Alert
            if (data.recommendation.isStable && data.recommendation.action !== 'WAIT') {
                const signalKey = `${data.symbol}_${data.recommendation.action}`;
                if (lastSignalAction !== signalKey) {
                    alertSound.play().catch(() => { });
                    lastSignalAction = signalKey;
                    showToast(`ELITE SIGNAL: ${data.recommendation.action} on ${data.symbol}`);
                }
            }
        }

        // Heatmap
        if (data.heatmap) {
            heatmapContainer.innerHTML = '';
            const isFX = data.symbol.includes('=X') || data.symbol.includes('USD');
            const precision = isFX ? 4 : 2;
            data.heatmap.sort((a, b) => b.volume - a.volume).slice(0, 10).forEach(h => {
                const div = document.createElement('div');
                div.className = 'metric-item';
                div.style.flexDirection = 'row';
                div.style.justifyContent = 'space-between';
                div.innerHTML = `
                    <span class="m-label">${h.type}</span>
                    <span class="m-value ${h.type === 'BSL' ? 'bullish-text' : 'bearish-text'}">$${h.price.toFixed(precision)}</span>
                    <span class="m-label">${h.volume} VOL</span>
                `;
                heatmapContainer.appendChild(div);
            });
        }

        // Ticker
        if (data.news && data.news.length > 0) {
            const ticker = document.getElementById('ticker-content');
            if (ticker) ticker.innerText = data.news.map(n => ` • ${n.text}`).join(' ');
        }

        // Sync Timeframe Buttons
        document.querySelectorAll('.tf-btn').forEach(btn => {
            if (btn.dataset.tf === data.timeframe) {
                btn.classList.add('active');
            } else {
                btn.classList.remove('active');
            }
        });

        updateChecklist(data);

        // --- Dual Sector Health Matrix (SPY & QQQ) ---
        const spyGrid = document.getElementById('spy-sector-grid');
        const qqqGrid = document.getElementById('qqq-sector-grid');

        if (data.sectors && spyGrid && qqqGrid) {
            const sectorNames = {
                'XLK': { name: 'TECHNOLOGY', tip: 'Growth Leader. If XLK is green, SPY/QQQ have a tailwind.' },
                'XLY': { name: 'CONSUMER', tip: 'Discretionary Spending. Shows if consumers are confident.' },
                'XLF': { name: 'FINANCE', tip: 'Market Fuel. Bulls need banks to participate for a real move.' },
                'XLC': { name: 'COMMS', tip: 'Meta/Google/Netflix. Core QQQ driver for growth.' },
                'SMH': { name: 'CHIPS', tip: 'The Brain. Market cannot lead without Semiconductors.' },
                'META': { name: 'META', tip: 'Big Tech Driver. High correlation to QQQ.' },
                'GOOGL': { name: 'GOOGLE', tip: 'Ad Revenue Leader. Essential for growth stability.' },
                'NVDA': { name: 'NVIDIA', tip: 'The AI Anchor. Most critical sentiment driver in current market.' },
                'AMD': { name: 'AMD', tip: 'Chip Sentiment. Confirms SMH strength.' },
                'KRE': { name: 'REG. BANKS', tip: 'Risk-On/Off indicator. Red KRE = Market Fear.' },
                'XBI': { name: 'BIOTECH', tip: 'Speculative Growth. Institutions buying XBI = Risk is ON.' },
                'IYT': { name: 'TRANSPORTS', tip: 'Economic Reality. If goods aren\'t moving, the rally is fake.' },
                'UUP': { name: 'USD STRENGTH', tip: 'Inverse to Stocks. Strong Dollar = Bearish for SPY.' },
                'EURUSD=X': { name: 'EURO', tip: 'Global Liquidity. Strong Euro = Weak Dollar = Bullish Stocks.' },
                'GBPUSD=X': { name: 'POUND', tip: 'Currency Pulse. Aligned with European liquidity flow.' },
                'USDJPY=X': { name: 'YEN', tip: 'The Carry Trade. Falling Yen often forces market deleveraging.' },
                '^TNX': { name: '10Y YIELD', tip: 'Borrowing Costs. High yields kill tech valuations.' }
            };

            const spyDrivers = ['XLK', 'XLY', 'XLF'];
            const qqqDrivers = ['XLK', 'XLC', 'SMH', 'AMD'];
            const iwmDrivers = ['KRE', 'XBI', 'IYT'];
            const fxDrivers = ['UUP', 'EURUSD=X', 'GBPUSD=X', 'USDJPY=X', '^TNX'];

            const renderGrid = (grid, symbols, suffix) => {
                if (!grid) return;
                const currentCount = grid.querySelectorAll('.sector-item').length;
                if (currentCount !== symbols.length || grid.querySelector('div[style*="grid-column"]')) {
                    grid.innerHTML = '';
                    symbols.forEach(sym => {
                        const div = document.createElement('div');
                        const sObj = sectorNames[sym] || { name: sym, tip: 'Market Driver' };
                        div.className = 'sector-item';
                        div.id = `sector-${sym}-${suffix}`;
                        div.setAttribute('data-tooltip', sObj.tip); // Use custom data-tooltip for CSS
                        const displaySym = sym.replace('=X', '').replace('^TNX', '10Y-YLD');
                        div.innerHTML = `
                            <span class="sector-sym" style="font-size: ${displaySym.length > 4 ? '0.7rem' : '0.9rem'};">${displaySym}</span>
                            <span class="sector-name" style="font-size: 0.55rem; color: var(--text-dim);">${sObj.name}</span>
                            <span class="sector-change" style="font-size: 0.75rem;">0.00%</span>
                        `;
                        grid.appendChild(div);
                    });
                }

                symbols.forEach(sym => {
                    const sData = data.sectors.find(s => s.symbol === sym) || (sym === 'UUP' ? { symbol: 'UUP', change: (data.bias?.internals?.dxyChange || 0) } : null);
                    // Handle UUP specifically if it's missing from sectors payload but in internals
                    const el = document.getElementById(`sector-${sym}-${suffix}`);
                    if (sData && el) {
                        const changeEl = el.querySelector('.sector-change');
                        if (changeEl) {
                            changeEl.innerText = `${sData.change >= 0 ? '+' : ''}${sData.change.toFixed(2)}%`;
                            changeEl.className = 'sector-change ' + (sData.change >= 0 ? 'bullish-text' : 'bearish-text');
                        }
                        el.classList.remove('bullish', 'bearish');
                        if (Math.abs(sData.change) > 0.1) {
                            if (sData.change > 0) el.classList.add('bullish');
                            else el.classList.add('bearish');
                        }
                    }
                });
            };

            const iwmGrid = document.getElementById('iwm-sector-grid');
            const fxGrid = document.getElementById('fx-sector-grid');
            renderGrid(spyGrid, spyDrivers, 'spy');
            renderGrid(qqqGrid, qqqDrivers, 'qqq');
            renderGrid(iwmGrid, iwmDrivers, 'iwm');
            renderGrid(fxGrid, fxDrivers, 'fx');
        }

        // --- Holy Grail Macro Updates ---
        if (data.bias && data.bias.internals) {
            const internals = data.bias.internals;

            // DXY Pulse
            if (dxyValEl) {
                const dxyVal = internals.dxy || 0;
                dxyValEl.innerText = dxyVal > 0 ? dxyVal.toFixed(2) : '--';
                const dxyPercent = dxyVal > 50 ? ((dxyVal - 100) / (110 - 100)) * 100 : ((dxyVal - 24) / (30 - 24)) * 100;
                dxyBarEl.style.width = `${Math.max(5, Math.min(95, dxyPercent))}%`;
            }

            // VIX Pulse
            if (vixBarEl) {
                const vixVal = internals.vix || 0;
                const vixPercent = ((vixVal - 10) / (40 - 10)) * 100;
                vixBarEl.style.width = `${Math.max(5, Math.min(95, vixPercent))}%`;
                vixBarEl.style.backgroundColor = vixVal > 20 ? 'var(--bearish)' : 'var(--bullish)';
                if (vixValEl) {
                    vixValEl.innerText = vixVal > 0 ? vixVal.toFixed(2) : '--';
                }
            }

            // News Timer (Fake for demo if no real time available, but using status)
            if (eventTimerEl) {
                if (internals.newsImpact === 'HIGH') {
                    eventTimerEl.innerText = 'IMPACTING NOW';
                    eventTimerEl.parentElement.classList.add('flash-down');
                } else {
                    eventTimerEl.innerText = '34:12'; // Placeholder for next scheduled event
                    eventTimerEl.parentElement.classList.remove('flash-down');
                }
            }

            // Confluence Ticker Sync
            if (confTickerEl && data.confluenceScore != null) {
                confTickerEl.innerText = `${data.confluenceScore}%`;
                confTickerEl.className = data.confluenceScore >= 70 ? 'bullish-text' : 'bearish-text';
            }

            // Magnet StrikeZones
            if (data.markers && data.currentPrice) {
                const price = data.currentPrice;
                const pdh = data.markers.pdh || 0;
                const pdl = data.markers.pdl || 0;

                if (bslMagnetPrice && pdh > 0) {
                    bslMagnetPrice.innerText = pdh.toFixed(2);
                    const distLine = ((pdh - price) / price) * 100;
                    bslMagnetDist.innerText = `${distLine > 0 ? '+' : ''}${distLine.toFixed(2)}%`;
                    bslMagnetDist.className = Math.abs(distLine) < 0.2 ? 'magnet-dist sweep-ready' : 'magnet-dist';
                }
                if (sslMagnetPrice && pdl > 0) {
                    sslMagnetPrice.innerText = pdl.toFixed(2);
                    const distLine = ((pdl - price) / price) * 100;
                    sslMagnetDist.innerText = `${distLine > 0 ? '+' : ''}${distLine.toFixed(2)}%`;
                    sslMagnetDist.className = Math.abs(distLine) < 0.2 ? 'magnet-dist sweep-ready' : 'magnet-dist';
                }
            }
        }
        if (data.watchlist) updateWatchlist(data);
    }
}

function updateWatchlist(data) {
    const listContainer = document.getElementById('watchlist-list');
    const countEl = document.getElementById('watchlist-count');
    if (!listContainer) return;

    const wl = data.watchlist || [];
    if (countEl) countEl.innerText = `${wl.length} Tickers`;

    if (wl.length === 0) {
        if (!listContainer.innerHTML || listContainer.innerHTML.includes('Initializing')) {
            listContainer.innerHTML = '<div style="text-align:center; padding: 2rem; color:var(--text-dim);">Initializing Watchlist Feed...</div>';
        }
        return;
    }

    listContainer.innerHTML = '';

    wl.forEach(stock => {
        try {
            if (!stock || !stock.symbol) return;

            const card = document.createElement('div');
            card.className = 'ticker-card' + (data.symbol === stock.symbol ? ' active-symbol' : '');

            const rec = stock.recommendation || { action: 'WAIT' };
            const action = rec.action || 'WAIT';
            const actionClass = action.includes('CALL') ? 'bullish-text' : action.includes('PUT') ? 'bearish-text' : 'text-dim';

            const isFX = stock.symbol.includes('=X') || stock.symbol.includes('USD');
            const precision = isFX ? 4 : 2;
            const biasText = stock.bias || 'NEUTRAL';
            const biasClass = biasText === 'BULLISH' ? 'bullish-text' : biasText === 'BEARISH' ? 'bearish-text' : '';
            const price = typeof stock.price === 'number' ? stock.price : 0;

            card.innerHTML = `
                <div class="ticker-info">
                    <span class="ticker-sym">${stock.symbol} ${stock.hasRS ? '<span class="rs-badge">RS</span>' : ''}</span>
                    <span class="ticker-price">$${price.toFixed(precision)}</span>
                </div>
                <div class="ticker-metrics">
                    <div style="display:flex; flex-direction:column; align-items:flex-end; gap:2px;">
                        <span class="ticker-bias ${biasClass}">${biasText}</span>
                        <span style="font-size:0.55rem; font-weight:900; color:${stock.confluenceScore >= 75 ? 'var(--bullish)' : 'var(--text-dim)'};">${stock.confluenceScore || 0}% CONF</span>
                    </div>
                    <span class="ticker-signal ${actionClass} ${action !== 'WAIT' ? 'pulse-subtle' : ''}">${action}</span>
                </div>
            `;

            card.onclick = () => {
                console.log(`[UI] Switching focus to: ${stock.symbol}`);
                socket.emit('switch_symbol', stock.symbol);
                // Instant UI feedback
                document.querySelectorAll('.ticker-card').forEach(c => c.classList.remove('active-symbol'));
                card.classList.add('active-symbol');
            };

            listContainer.appendChild(card);
        } catch (err) {
            console.error(`[UI] Error rendering symbol ${stock?.symbol}:`, err);
        }
    });
}

function updateChecklist(data) {
    const list = data.checklist;
    if (!list) return;
    document.getElementById('check-tf-alignment')?.classList.toggle('active', !!list.trendAlign);
    document.getElementById('check-trap-detected')?.classList.toggle('active', !!list.sweepDetected);
    document.getElementById('check-signal-stable')?.classList.toggle('active', !!list.stableSignal);
    document.getElementById('check-relative-strength')?.classList.toggle('active', !!list.relativeStrength);
    document.getElementById('check-gamma-wall')?.classList.toggle('active', !!list.gammaCheck);
}

function showToast(msg) {
    const toast = document.createElement('div');
    toast.style.background = 'rgba(15, 23, 42, 0.9)';
    toast.style.color = '#fff';
    toast.style.padding = '12px 20px';
    toast.style.borderRadius = '12px';
    toast.style.borderLeft = '4px solid var(--accent)';
    toast.style.marginBottom = '10px';
    toast.style.fontSize = '0.8rem';
    toast.style.fontWeight = '700';
    toast.innerText = msg;
    toastContainer.appendChild(toast);
    setTimeout(() => toast.remove(), 5000);
}

function updateVixGauge(vix) {
    if (!vixNeedle) return;
    // Map VIX 10-40+ to -90deg to +90deg
    const minVix = 10;
    const maxVix = 40;
    const clampedVix = Math.max(minVix, Math.min(maxVix, vix));
    const rotation = ((clampedVix - minVix) / (maxVix - minVix) * 180) - 90;
    vixNeedle.style.transform = `translateX(-50%) rotate(${rotation}deg)`;
}

// --- TRIGGER CHECKLIST LOGIC ---
btnUnlockSignal?.addEventListener('click', () => {
    checklistModal.style.display = 'flex';
    // Reset checks
    triggerChecks.forEach(c => c.checked = false);
    if (btnConfirmTrade) btnConfirmTrade.disabled = true;
});

btnCloseChecklist?.addEventListener('click', () => {
    checklistModal.style.display = 'none';
});

triggerChecks.forEach(check => {
    check.addEventListener('change', () => {
        const allChecked = Array.from(triggerChecks).every(c => c.checked);
        if (btnConfirmTrade) btnConfirmTrade.disabled = !allChecked;
    });
});

btnConfirmTrade?.addEventListener('click', () => {
    signalUnlocked = true;
    checklistModal.style.display = 'none';
    if (btnUnlockSignal) btnUnlockSignal.style.display = 'none';

    // Flash unlock success
    showToast("🔥 SIGNAL UNLOCKED: TRIGGERS CONFIRMED");

    if (pendingSignalData) {
        updateUI(pendingSignalData);
    }
});
