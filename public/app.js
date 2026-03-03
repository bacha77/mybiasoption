const socket = io();

// DOM elements
const priceEl = document.getElementById('current-price');
const changeEl = document.getElementById('price-change');
const biasLabel = document.getElementById('bias-label');
const biasNeedle = document.getElementById('bias-needle');
const drawsList = document.getElementById('draws-list');
const heatmapContainer = document.getElementById('heatmap');
const vwapEl = document.getElementById('vwap-val');
const pocEl = document.getElementById('poc-val');
const cvdEl = document.getElementById('cvd-val');
const sentimentEl = document.getElementById('sentiment-status');
const weiEl = document.getElementById('wei-status');
const omonEl = document.getElementById('omon-status');
const btmEl = document.getElementById('btm-status');
const pdhEl = document.getElementById('pdh-val');
const pdlEl = document.getElementById('pdl-val');
const toastContainer = document.getElementById('toast-container');
const watchlistBody = document.getElementById('watchlist-body');
const recSymbol = document.getElementById('rec-symbol');
const recAction = document.getElementById('rec-action');
const recStrike = document.getElementById('rec-strike');
const recTarget = document.getElementById('rec-target');
const recRationale = document.getElementById('rec-rationale');
const recBox = document.getElementById('rec-box');

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
        const tf = btn.dataset.tf;
        socket.emit('switch_timeframe', tf);
    });
});

// Initialize Chart
function initChart(initialCandles) {
    const ctx = document.getElementById('priceChart').getContext('2d');
    if (priceChart) priceChart.destroy();

    priceChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: initialCandles.map(c => new Date(c.timestamp).toLocaleTimeString()),
            datasets: [{
                label: 'Price',
                data: initialCandles.map(c => c.close),
                borderColor: '#00f2ff',
                borderWidth: 2,
                pointRadius: 0,
                fill: true,
                backgroundColor: 'rgba(0, 242, 255, 0.05)',
                tension: 0.4
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                x: { display: false },
                y: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#94a3b8' } }
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
        if (priceChart.data.labels.length > 50) {
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
    if (data.watchlist) updateWatchlist(data);
});

function updateUI(data) {
    if (!data) return;

    // Symbol Display
    const symbolDisplay = document.getElementById('symbol-display');
    if (symbolDisplay) symbolDisplay.innerText = data.symbol || 'SPY';

    if (data.loading) {
        if (priceEl) priceEl.innerText = 'LOADING...';
    } else {
        // Price & Change
        if (priceEl && data.currentPrice) {
            priceEl.innerText = data.currentPrice.toLocaleString(undefined, { minimumFractionDigits: 2 });
        }
        if (changeEl) {
            const dailyChange = typeof data.dailyChangePercent === 'number' ? data.dailyChangePercent : 0;
            changeEl.innerText = `${dailyChange >= 0 ? '+' : ''}${dailyChange.toFixed(2)}%`;
            changeEl.className = dailyChange >= 0 ? 'change-up' : 'change-down';
        }

        // Bloomberg Monitor
        if (data.bloomberg) {
            updateMonitor(weiEl, data.bloomberg.wei);
            updateMonitor(omonEl, data.bloomberg.omon);
            updateMonitor(btmEl, data.bloomberg.btm);
            if (sentimentEl && data.bloomberg.sentiment !== undefined) {
                sentimentEl.innerText = data.bloomberg.sentiment.toFixed(2);
                sentimentEl.className = 'm-value ' + (data.bloomberg.sentiment > 0 ? 'val-bullish' : data.bloomberg.sentiment < 0 ? 'val-bearish' : '');
            }
        }

        // Institutional Markers
        if (data.markers) {
            if (pdhEl) pdhEl.innerText = (data.markers.pdh || 0).toFixed(2);
            if (pdlEl) pdlEl.innerText = (data.markers.pdl || 0).toFixed(2);
            if (vwapEl && data.markers.vwap) vwapEl.innerText = data.markers.vwap.toFixed(2);
            if (pocEl && data.markers.poc) pocEl.innerText = data.markers.poc.toFixed(2);
            if (cvdEl && data.markers.cvd !== undefined) {
                cvdEl.innerText = (data.markers.cvd > 0 ? '+' : '') + data.markers.cvd;
                cvdEl.className = data.markers.cvd > 0 ? 'trade-pl-up' : data.markers.cvd < 0 ? 'trade-pl-down' : '';
            }
        }

        // Recommendation
        if (data.recommendation) {
            if (recSymbol) recSymbol.innerText = data.symbol;
            if (recStrike) recStrike.innerText = data.recommendation.strike || '-';
            const trimEl = document.getElementById('rec-trim');
            if (trimEl) trimEl.innerText = data.recommendation.trim || '-';
            if (recTarget) recTarget.innerText = data.recommendation.target || '-';
            const slEl = document.getElementById('rec-sl');
            const sizeEl = document.getElementById('rec-size');
            if (slEl) slEl.innerText = data.recommendation.sl || '-';
            if (sizeEl) sizeEl.innerText = data.recommendation.size || '-';

            const recActionEl = document.getElementById('rec-action');
            if (recActionEl) {
                const confPercent = (data.recommendation.confidence || 0);
                const confEl = document.getElementById('rec-confidence');
                if (confEl) {
                    confEl.innerText = `${confPercent}%`;
                    confEl.style.color = confPercent >= 80 ? '#00f2ff' : (confPercent >= 50 ? '#94a3b8' : '#ff4444');
                }

                recActionEl.innerText = data.recommendation.isStable ? data.recommendation.action : `${data.recommendation.action} (STABILIZING...)`;
                recActionEl.style.opacity = data.recommendation.isStable ? '1' : '0.7';
            }

            if (recRationale) {
                const durationHtml = data.recommendation.duration ? `<div class="rec-duration">⏱️ ${data.recommendation.duration}</div>` : '';
                recRationale.innerHTML = `${data.recommendation.rationale}${durationHtml}`;
            }

            if (recBox) {
                recBox.className = 'rec-box';
                if (data.recommendation.action.includes('BUY CALL')) recBox.classList.add('act-buy');
                if (data.recommendation.action.includes('BUY PUT')) recBox.classList.add('act-sell');
            }

            // Audio Signal
            if (data.recommendation.isStable && data.recommendation.action !== 'WAIT') {
                const signalKey = `${data.symbol}_${data.recommendation.action}`;
                if (lastSignalAction !== signalKey) {
                    alertSound.play().catch(() => { });
                    lastSignalAction = signalKey;
                    showToast(`SIGNAL: ${data.recommendation.action} on ${data.symbol}`);
                }
            }
        }

        // Institutional Markers
        if (data.bias && data.bias.markers) {
            const m = data.bias.markers;
            const pdhVal = document.getElementById('pdh-val');
            const pdlVal = document.getElementById('pdl-val');
            const moVal = document.getElementById('midnight-open-val');
            const loVal = document.getElementById('london-open-val');
            const nyVal = document.getElementById('ny-open-val');
            const dhVal = document.getElementById('dh-val');
            const dlVal = document.getElementById('dl-val');
            const vwapVal = document.getElementById('vwap-val');
            const pocVal = document.getElementById('poc-val');
            const cvdVal = document.getElementById('cvd-val');

            if (pdhVal) pdhVal.innerText = m.pdh.toFixed(2);
            if (pdlVal) pdlVal.innerText = m.pdl.toFixed(2);
            if (moVal) moVal.innerText = (m.midnightOpen || 0).toFixed(2);
            if (loVal) loVal.innerText = (m.londonOpen || 0).toFixed(2);
            if (nyVal) nyVal.innerText = (m.nyOpen || 0).toFixed(2);
            if (dhVal) dhVal.innerText = m.todayHigh.toFixed(2);
            if (dlVal) dlVal.innerText = m.todayLow.toFixed(2);
            if (vwapVal) vwapVal.innerText = m.vwap.toFixed(2);
            if (pocVal) pocVal.innerText = m.poc.toFixed(2);
            if (cvdVal) cvdVal.innerText = m.cvd.toLocaleString();
        }

        // Market Internals (Engine Room)
        if (data.bias && data.bias.internals) {
            const int = data.bias.internals;
            const vixEl = document.getElementById('vix-status');
            const dxyEl = document.getElementById('dxy-status');
            const newsEl = document.getElementById('news-impact-status');

            if (vixEl) {
                vixEl.innerText = int.vix.toFixed(2);
                vixEl.className = 'm-value ' + (int.vix > 20 ? 'val-bearish' : 'val-bullish');
            }
            if (dxyEl) {
                dxyEl.innerText = int.dxy.toFixed(2);
            }
            if (newsEl) {
                newsEl.innerText = int.newsImpact === 'HIGH' ? '⚠️ HIGH IMPACT' : 'SAFE / LOW';
                newsEl.className = 'm-value ' + (int.newsImpact === 'HIGH' ? 'val-bearish' : 'val-bullish');
            }
        }

        // Bias Gauge
        if (data.bias) {
            if (biasLabel) biasLabel.innerText = data.bias.bias;
            if (biasNeedle) {
                let rot = 0;
                if (data.bias.bias === 'BULLISH') rot = 60;
                else if (data.bias.bias === 'BEARISH') rot = -60;
                biasNeedle.style.transform = `translateX(-50%) rotate(${rot}deg)`;
            }
        }

        // List Updates
        if (data.draws) {
            drawsList.innerHTML = '';
            data.draws.highs.concat(data.draws.lows).slice(0, 10).forEach(d => {
                const li = document.createElement('li');
                li.className = 'list-item';
                li.innerHTML = `<span class="${d.type.toLowerCase()}">${d.type}</span> <span>${d.price.toFixed(2)}</span>`;
                drawsList.appendChild(li);
            });
        }

        if (data.heatmap) {
            heatmapContainer.innerHTML = '';
            data.heatmap.sort((a, b) => b.volume - a.volume).slice(0, 12).forEach(h => {
                const div = document.createElement('div');
                div.className = `heat-level ${h.type ? h.type.toLowerCase() : ''}`;
                div.style.width = `${Math.min(100, (h.volume / 6000) * 100)}%`;
                div.innerHTML = `<span class="heat-label">${h.type} | ${h.price.toFixed(0)} | ${h.volume}</span>`;
                heatmapContainer.appendChild(div);
            });
        }

        updateNews(data.news);
        updateMultiTfBias(data.multiTfBias);
        updateTradePl(data.currentPrice, data.symbol);
        updateChecklist(data);

        // Update Market Session Status
        if (data.session) {
            const sessionText = document.getElementById('market-session-text');
            const sessionDot = document.getElementById('market-status-dot');
            if (sessionText) sessionText.innerText = `${data.session.session}: ${data.session.status}`;
            if (sessionDot) {
                sessionDot.style.background = data.session.color;
                sessionDot.style.boxShadow = `0 0 10px ${data.session.color}`;
            }
        }
    }

    // Always update watchlist
    if (data.watchlist) updateWatchlist(data);
}

function updateWatchlist(data) {
    if (!watchlistBody) return;
    const tfLabel = document.getElementById('watchlist-tf');
    if (tfLabel) tfLabel.innerText = data.timeframe || '1m';

    watchlistBody.innerHTML = '';
    data.watchlist.forEach(stock => {
        const tr = document.createElement('tr');
        tr.className = 'clickable-row';
        const action = stock.recommendation ? stock.recommendation.action : 'WAIT';
        const actionClass = action.includes('WAIT') ? 'wait' : action.includes('CALL') ? 'buy' : 'sell';
        const change = stock.dailyChangePercent || 0;
        const changeClass = change >= 0 ? 'change-up' : 'change-down';
        const biasClass = stock.bias ? stock.bias.toLowerCase() : 'neutral';

        tr.innerHTML = `
            <td class="w-symbol">${stock.symbol}</td>
            <td class="w-price">${(stock.price || 0).toFixed(2)} <span class="${changeClass}">${change >= 0 ? '+' : ''}${change.toFixed(2)}%</span></td>
            <td class="w-bias ${biasClass}">${stock.bias || 'NEUTRAL'}</td>
            <td><span class="w-action ${actionClass}">${action}</span></td>
        `;
        tr.addEventListener('click', () => socket.emit('switch_symbol', stock.symbol));
        watchlistBody.appendChild(tr);
    });
}

function updateMonitor(el, val) {
    if (!el || !val) return;
    el.innerText = val.replace('_', ' ');
    el.className = 'm-value';
    if (val.includes('BULLISH') || val.includes('BUY')) el.classList.add('val-bullish');
    if (val.includes('BEARISH') || val.includes('SELL')) el.classList.add('val-bearish');
}

function updateChecklist(data) {
    const alignCheck = document.getElementById('check-tf-alignment');
    const trapCheck = document.getElementById('check-trap-detected');
    const stableCheck = document.getElementById('check-signal-stable');
    const rsCheck = document.getElementById('check-relative-strength');
    if (!alignCheck || !trapCheck || !stableCheck) return;

    alignCheck.classList.toggle('active', !!data.checklist?.trendAlign);
    trapCheck.classList.toggle('active', !!data.checklist?.sweepDetected);
    stableCheck.classList.toggle('active', !!data.checklist?.stableSignal);
    if (rsCheck) rsCheck.classList.toggle('active', !!data.checklist?.relativeStrength);
}

// Portfolio & Trades
let portfolio = [];
function executeTrade(type) {
    const symbol = document.getElementById('rec-symbol').innerText;
    const priceText = document.getElementById('current-price').innerText.replace(/,/g, '');
    const price = parseFloat(priceText);
    const size = parseInt(document.getElementById('rec-size').innerText) || 1;

    if (symbol === '-' || isNaN(price)) return;
    portfolio.push({ id: Date.now(), symbol, type, entryPrice: price, size, pl: 0 });
    renderPortfolio();
    showToast(`EXECUTED: ${size}x ${type} ${symbol} @ ${price.toFixed(2)}`, 'absorption');
}

function renderPortfolio() {
    const tradesEl = document.getElementById('active-trades');
    const totalPlEl = document.getElementById('total-pl');
    if (!tradesEl || !totalPlEl) return;
    if (portfolio.length === 0) {
        tradesEl.innerHTML = '<p class="no-trades">No active trades.</p>';
        totalPlEl.innerText = '$0.00';
        return;
    }
    tradesEl.innerHTML = '';
    let tot = 0;
    portfolio.forEach(t => {
        tot += t.pl;
        const div = document.createElement('div');
        div.className = 'active-trade-item';
        div.innerHTML = `
            <b>${t.symbol}</b> <span>${t.type}</span>
            <span class="${t.pl >= 0 ? 'trade-pl-up' : 'trade-pl-down'}">${t.pl.toFixed(2)}</span>
            <button class="close-btn" onclick="closeTrade(${t.id})">CLOSE</button>
        `;
        tradesEl.appendChild(div);
    });
    totalPlEl.innerText = `${tot >= 0 ? '+' : ''}$${tot.toFixed(2)}`;
}

window.closeTrade = (id) => {
    portfolio = portfolio.filter(t => t.id !== id);
    renderPortfolio();
};

function showToast(msg, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.innerText = msg;
    toastContainer?.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}

function updateNews(news) {
    const ticker = document.getElementById('ticker-content');
    if (!ticker || !news) return;
    ticker.innerText = news.map(n => ` • ${n.text}`).join(' ');
}

function updateMultiTfBias(biases) {
    if (!biases) return;
    document.querySelectorAll('.tf-dot').forEach(dot => {
        const tf = dot.dataset.tf;
        const b = biases[tf];
        dot.className = 'tf-dot ' + (b === 'BULLISH' ? 'bias-bullish' : b === 'BEARISH' ? 'bias-bearish' : 'bias-neutral');
    });
}

function updateTradePl(curr, sym) {
    portfolio.forEach(t => {
        if (t.symbol === sym) {
            const d = curr - t.entryPrice;
            t.pl = t.type.includes('CALL') ? d : -d;
        }
    });
    renderPortfolio();
}

document.getElementById('btn-buy')?.addEventListener('click', () => executeTrade('BUY CALL'));
document.getElementById('btn-sell')?.addEventListener('click', () => executeTrade('BUY PUT'));
