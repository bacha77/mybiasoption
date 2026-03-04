const socket = io();

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
const vixEl = document.getElementById('vix-status');
const toastContainer = document.getElementById('toast-container');
const watchlistBody = document.getElementById('watchlist-body');
const recAction = document.getElementById('rec-action');
const recStrike = document.getElementById('rec-strike');
const recTarget = document.getElementById('rec-target');
const recRationale = document.getElementById('rec-rationale');
const recBox = document.getElementById('rec-box');
const simBalanceVal = document.getElementById('sim-balance-val');

let priceChart;
const alertSound = new Audio('https://assets.mixkit.co/sfx/preview/mixkit-notification-alert-2354.mp3');
let lastSignalAction = '';

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

// Timeframe Switchers
document.querySelectorAll('.tf-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.tf-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const tf = btn.dataset.tf;
        socket.emit('switch_timeframe', tf);
    });
});

// Initialize Chart
function initChart(initialCandles) {
    const ctx = document.getElementById('priceChart').getContext('2d');
    if (priceChart) priceChart.destroy();

    const gradient = ctx.createLinearGradient(0, 0, 0, 400);
    gradient.addColorStop(0, 'rgba(56, 189, 248, 0.2)');
    gradient.addColorStop(1, 'rgba(56, 189, 248, 0)');

    priceChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: initialCandles.map(c => new Date(c.timestamp).toLocaleTimeString()),
            datasets: [{
                label: 'Price',
                data: initialCandles.map(c => c.close),
                borderColor: '#38bdf8',
                borderWidth: 3,
                pointRadius: 0,
                fill: true,
                backgroundColor: gradient,
                tension: 0.4
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 0 },
            scales: {
                x: { display: false },
                y: {
                    grid: { color: 'rgba(255,255,255,0.03)' },
                    ticks: { color: '#64748b', font: { family: 'JetBrains Mono' } }
                }
            },
            plugins: { legend: { display: false } }
        }
    });
}

socket.on('init', (data) => {
    if (data.candles) initChart(data.candles);
    updateUI(data);
});

socket.on('update', (data) => {
    updateUI(data);
    if (priceChart && data.currentPrice && !data.loading) {
        priceChart.data.labels.push(new Date().toLocaleTimeString());
        priceChart.data.datasets[0].data.push(data.currentPrice);
        if (priceChart.data.labels.length > 60) {
            priceChart.data.labels.shift();
            priceChart.data.datasets[0].data.shift();
        }
        priceChart.update('none');
    }
});

socket.on('tf_updated', (data) => {
    if (priceChart) {
        priceChart.data.labels = [];
        priceChart.data.datasets[0].data = [];
        priceChart.update();
    }
    if (data.watchlist) updateWatchlist(data);
});

socket.on('symbol_updated', (data) => {
    const display = document.getElementById('symbol-display');
    if (display) display.innerText = data.symbol;
    if (priceChart) {
        priceChart.data.labels = [];
        priceChart.data.datasets[0].data = [];
        priceChart.update();
    }
});

function updateUI(data) {
    if (!data) return;

    // Symbol Display
    const symbolDisplay = document.getElementById('symbol-display');
    if (symbolDisplay) symbolDisplay.innerText = data.symbol || 'SPY';

    if (data.loading) {
        if (priceEl) priceEl.innerText = 'FETCHING...';
    } else {
        // Price & Change
        if (priceEl && data.currentPrice) {
            priceEl.innerText = data.currentPrice.toLocaleString(undefined, { minimumFractionDigits: 2 });
        }
        if (changeEl) {
            const dailyChange = typeof data.dailyChangePercent === 'number' ? data.dailyChangePercent : 0;
            changeEl.innerText = `${dailyChange >= 0 ? '+' : ''}${dailyChange.toFixed(2)}%`;
            changeEl.className = 'main-change ' + (dailyChange >= 0 ? 'bullish-text' : 'bearish-text');
        }

        if (data.simBalance && simBalanceVal) {
            simBalanceVal.innerText = `$${data.simBalance.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
        }

        // Institutional Markers
        if (data.markers) {
            if (pdhEl) pdhEl.innerText = (data.markers.pdh || 0).toFixed(2);
            if (pdlEl) pdlEl.innerText = (data.markers.pdl || 0).toFixed(2);
            if (midnightEl) midnightEl.innerText = (data.markers.midnightOpen || 0).toFixed(2);
            if (vwapEl) vwapEl.innerText = (data.markers.vwap || 0).toFixed(2);
            if (pocEl) pocEl.innerText = (data.markers.poc || 0).toFixed(2);
            if (adrEl) adrEl.innerText = (data.markers.adr || 0).toFixed(2);
            if (cvdEl) {
                cvdEl.innerText = (data.markers.cvd > 0 ? '+' : '') + data.markers.cvd;
                cvdEl.className = 'm-value ' + (data.markers.cvd > 0 ? 'bullish-text' : data.markers.cvd < 0 ? 'bearish-text' : '');
            }
        }

        // Market Internals
        if (data.bias && data.bias.internals && vixEl) {
            vixEl.innerText = data.bias.internals.vix.toFixed(2);
            vixEl.className = 'm-value ' + (data.bias.internals.vix > 20 ? 'bearish-text' : 'bullish-text');
        }

        // Bias Gauge
        if (data.bias) {
            if (biasLabel) {
                biasLabel.innerText = data.bias.bias;
                biasLabel.className = 'bias-large ' + (data.bias.bias === 'BULLISH' ? 'bullish-text' : data.bias.bias === 'BEARISH' ? 'bearish-text' : '');
            }
            if (biasConfFill) {
                // Approximate position for the single bias bar
                let score = data.bias.score || 0;
                let percent = 50 + (score * 5); // Scored -10 to +10 maps to 0% to 100%
                biasConfFill.style.width = `${Math.max(5, Math.min(95, percent))}%`;
                biasConfFill.style.backgroundColor = score > 2 ? 'var(--bullish)' : score < -2 ? 'var(--bearish)' : 'var(--accent)';
            }
        }

        // Recommendation
        if (data.recommendation) {
            if (recAction) {
                recAction.innerText = data.recommendation.action;
                recAction.className = 'rec-action-text ' + (data.recommendation.action.includes('CALL') ? 'bullish-text' : data.recommendation.action.includes('PUT') ? 'bearish-text' : '');
            }
            if (recStrike) recStrike.innerText = data.recommendation.strike || '-';
            if (recTarget) recTarget.innerText = data.recommendation.target || '-';

            const trimEl = document.getElementById('rec-trim');
            const targetEl = document.getElementById('rec-target');
            const slEl = document.getElementById('rec-sl');
            const sizeEl = document.getElementById('rec-size');
            const durEl = document.getElementById('rec-duration');
            const confEl = document.getElementById('rec-confidence');

            if (trimEl) trimEl.innerText = data.recommendation.trim || '-';
            if (targetEl) targetEl.innerText = data.recommendation.target || '-';
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
            data.heatmap.sort((a, b) => b.volume - a.volume).slice(0, 10).forEach(h => {
                const div = document.createElement('div');
                div.className = 'metric-item';
                div.style.flexDirection = 'row';
                div.style.justifyContent = 'space-between';
                div.innerHTML = `
                    <span class="m-label">${h.type}</span>
                    <span class="m-value ${h.type === 'BSL' ? 'bullish-text' : 'bearish-text'}">$${h.price.toFixed(2)}</span>
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

        // Market Status
        if (data.session) {
            const sessionText = document.getElementById('market-session-text');
            const sessionDot = document.getElementById('market-status-dot');
            if (sessionText) sessionText.innerText = `${data.session.session} SESSION: ${data.session.status}`;
            if (sessionDot) sessionDot.style.background = data.session.color;
        }

        updateChecklist(data);
    }

    if (data.watchlist) updateWatchlist(data);
}

function updateWatchlist(data) {
    if (!watchlistBody) return;
    watchlistBody.innerHTML = '';
    data.watchlist.forEach(stock => {
        const tr = document.createElement('tr');
        const action = stock.recommendation ? stock.recommendation.action : 'WAIT';
        const actionClass = action.includes('CALL') ? 'bullish-text' : action.includes('PUT') ? 'bearish-text' : 'text-dim';

        tr.innerHTML = `
            <td class="w-sym">${stock.symbol}</td>
            <td>$${(stock.price || 0).toFixed(2)}</td>
            <td class="${stock.bias === 'BULLISH' ? 'bullish-text' : stock.bias === 'BEARISH' ? 'bearish-text' : ''}">${stock.bias}</td>
            <td class="${actionClass}">${action}</td>
        `;
        tr.onclick = () => socket.emit('switch_symbol', stock.symbol);
        watchlistBody.appendChild(tr);
    });
}

function updateChecklist(data) {
    const list = data.checklist;
    if (!list) return;
    document.getElementById('check-tf-alignment')?.classList.toggle('active', !!list.trendAlign);
    document.getElementById('check-trap-detected')?.classList.toggle('active', !!list.sweepDetected);
    document.getElementById('check-signal-stable')?.classList.toggle('active', !!list.stableSignal);
    document.getElementById('check-relative-strength')?.classList.toggle('active', !!list.relativeStrength);
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
