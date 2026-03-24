const socket = io();
let watchlistPrevPrices = {}; // Tracks previous prices to trigger pulses

// Supabase Auth Integration
let supabaseClient;
const loginOverlay = document.getElementById('login-overlay');
const logoutBtn = document.getElementById('logout-btn');
const googleLoginBtn = document.getElementById('google-login-btn');

async function initAuth() {
    try {
        const response = await fetch('/api/config');
        const config = await response.json();
        
        if (!config.supabaseUrl || !config.supabaseAnonKey || config.supabaseAnonKey.includes('your')) {
            console.warn("[AUTH] Supabase keys missing or invalid. Dashboard running in bypass mode.");
            return;
        }

        supabaseClient = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey);

        const { data: { session } } = await supabaseClient.auth.getSession();
        
        const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

        // If no session and not on landing page, show login (bypass for localhost)
        if (!session && !window.location.pathname.includes('landing') && !isLocalhost) {
            loginOverlay.style.display = 'flex';
            if (logoutBtn) logoutBtn.style.display = 'none';
            document.body.style.overflow = 'hidden';
        } else if (isLocalhost && !session) {
            console.log("[AUTH] Running locally, bypassing login screen.");
            loginOverlay.style.display = 'none';
            if (logoutBtn) logoutBtn.style.display = 'none';
            document.body.style.overflow = 'auto';
        } else if (session) {
            console.log("[AUTH] Verified Identity:", session.user.email);
            
            // Verify Subscription Tier (DISABLED TEMPORARILY)
            /*
            if (!window.location.pathname.includes('index')) {
                const { data: profile } = await supabaseClient.from('profiles').select('tier, subscription_status').eq('id', session.user.id).single();
                if(!profile || profile.subscription_status !== 'active') {
                    alert('You do not have an active institutional subscription. Please select a plan.');
                    window.location.href = '/index.html#pricing';
                    return;
                }
            }
            */

            loginOverlay.style.display = 'none';
            if (logoutBtn) logoutBtn.style.display = 'block';
            document.body.style.overflow = 'auto';
        }

        supabaseClient.auth.onAuthStateChange((event, session) => {
            if (event === 'SIGNED_IN') {
                loginOverlay.style.display = 'none';
                logoutBtn.style.display = 'block';
                document.body.style.overflow = 'auto';
            } else if (session === null && !isLocalhost) {
                loginOverlay.style.display = 'flex';
                logoutBtn.style.display = 'none';
                document.body.style.overflow = 'hidden';
            }
        });

        logoutBtn.onclick = async () => {
            await supabaseClient.auth.signOut();
            window.location.reload();
        };

        googleLoginBtn.onclick = async () => {
            console.log("[AUTH] Initiating Institutional Google Login...");
            // Ensure we return specifically to the terminal after login
            const redirectUrl = window.location.origin + '/terminal.html';
            await supabaseClient.auth.signInWithOAuth({
                provider: 'google',
                options: {
                    redirectTo: redirectUrl
                }
            });
        };

    } catch (e) {
        console.error("[AUTH] Error initializing identity service:", e);
    }
}
initAuth();

socket.on('whale_alert', (block) => {
    audioHooter.playWhale();
    showToast(`🐋 WHALE ALERT: ${block.symbol} | $${(block.value / 1000000).toFixed(2)}M Block!`);
    const card = document.querySelector('.sidebar section:nth-child(4)'); // Block Feed card
    if (card) {
        card.classList.add('whale-flash');
        setTimeout(() => card.classList.remove('whale-flash'), 5000);
    }
});
socket.on('holy_grail', (data) => {
    showToast(`🔥 HOLY GRAIL SIGNAL: ${data.symbol} 🔥`, 'toast-grail');
    if (typeof voiceNarrator !== 'undefined') voiceNarrator.speak(`Alert. Holy Grail signal detected on ${data.symbol}. All engines aligned.`);
});


// News Ticker Listener
socket.on('news_update', (data) => {

// GLOBAL SCALPER PULSE LISTENER
socket.on('scalper_pulse', (data) => {
    console.log('[CLIENT] Scalper pulse received:', data);
    const list = document.getElementById('scalper-scan-list');
    if (!list || !data.updates) return;
    data.updates.forEach(upd => {
        let existing = document.getElementById('scan-' + upd.symbol);
        const isHighConviction = upd.isHighConviction || upd.alignedCount >= 3;
        const alignFlare = isHighConviction ? 'border-right: 3px solid #ff9d00; box-shadow: inset 0 0 10px rgba(255,157,0,0.05);' : '';

        if (existing) {
            const velEl = existing.querySelector('.velocity-val');
            const sigEl = existing.querySelector('.signal-val');
            if (velEl) { velEl.innerText = 'VEL: ' + upd.velocity; velEl.style.color = upd.color; }
            if (sigEl) { 
                sigEl.innerText = upd.signal; 
                sigEl.style.color = isHighConviction ? 'var(--gold)' : '#94a3b8';
            }
            existing.style.borderLeftColor = upd.color;
            if (isHighConviction) existing.style.cssText += alignFlare;
            return;
        }
        const row = document.createElement('div');
        row.id = 'scan-' + upd.symbol;
        row.style.cssText = 'padding: 0.6rem; border-bottom: 1px solid rgba(255,255,255,0.03); display: flex; justify-content: space-between; align-items: center; cursor: pointer; border-left: 2px solid ' + upd.color + ';' + alignFlare;
        row.onclick = () => { socket.emit('switch_symbol', upd.symbol); };
        
        const leftDiv = document.createElement('div');
        const symDiv = document.createElement('div');
        symDiv.style.cssText = 'font-size: 0.75rem; font-weight: 900; color: #fff;';
        symDiv.innerText = upd.symbol;
        if (isHighConviction) symDiv.innerHTML += ' <span style="color:var(--gold); font-size:0.5rem;">🔥</span>';
        
        const sigDiv = document.createElement('div');
        sigDiv.className = 'signal-val';
        sigDiv.style.cssText = 'font-size: 0.5rem; color: ' + (isHighConviction ? 'var(--gold)' : '#94a3b8') + '; font-weight: 700;';
        sigDiv.innerText = upd.signal;
        leftDiv.appendChild(symDiv); leftDiv.appendChild(sigDiv);
        const rightDiv = document.createElement('div');
        rightDiv.style.textAlign = 'right';
        const velDiv = document.createElement('div');
        velDiv.className = 'velocity-val';
        velDiv.style.cssText = 'font-size: 0.6rem; font-weight: 900; color: ' + upd.color;
        velDiv.innerText = 'VEL: ' + upd.velocity;
        const liveDiv = document.createElement('div');
        liveDiv.style.cssText = 'font-size: 0.45rem; color: #94a3b8;';
        liveDiv.innerText = 'LIVE';
        rightDiv.appendChild(velDiv); rightDiv.appendChild(liveDiv);
        row.appendChild(leftDiv); row.appendChild(rightDiv);
        if (list.firstChild && list.firstChild.innerText && list.firstChild.innerText.includes('INITIALIZING')) { list.innerHTML = ''; }
        list.prepend(row);
        if (list.children.length > 8) list.removeChild(list.lastChild);
    });
});
    const newsEl = document.getElementById('news-ticker-render');
    if (newsEl && data.news && data.news.length > 0) {
        const newsString = data.news.map(n => `[${n.source}] ${n.title}`).join(' • ');
        newsEl.innerText = newsString;
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
const nyOpenEl = document.getElementById('ny-open-val');
const londonOpenEl = document.getElementById('london-open-val');
const callWallEl = document.getElementById('call-wall-val');
const putWallEl = document.getElementById('put-wall-val');
const vixEl = document.getElementById('vix-val-regime');
const vixValEl = document.getElementById('vix-val-macro');
const vixNeedle = document.getElementById('vix-needle');
const latencyEl = document.getElementById('latency-val');
const nyClockEl = document.getElementById('ny-clock');
const globalSearch = document.getElementById('global-search');
const toastContainer = document.getElementById('toast-container');
const watchlistList = document.getElementById('watchlist-list');
const recAction = document.getElementById('rec-action');
const recStrike = document.getElementById('rec-strike');
const recTarget = document.getElementById('rec-target');
const recRationale = document.getElementById('rec-rationale');
const recBox = document.getElementById('rec-box');
const recRR = document.getElementById('rec-rr');
const trapBadge = document.getElementById('trap-badge');
const netWhaleVal = document.getElementById('net-whale-val');
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
const asiaHighEl = document.getElementById('magnet-asia-high');
const asiaLowEl = document.getElementById('magnet-asia-low');
const cbdrSd1El = document.getElementById('magnet-cbdr-sd1');
const cbdrSd2El = document.getElementById('magnet-cbdr-sd2');
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
const squeezeBadge = document.getElementById('squeeze-badge');
const roroLabel = document.getElementById('roro-label');
const roroBar = document.getElementById('roro-bar');
const roroVal = document.getElementById('roro-val');
const displacementBadge = document.getElementById('displacement-badge');

// Radar Elements
const radarIrScore = document.getElementById('radar-ir-score');
const radarSessionName = document.getElementById('radar-session-name');
const radarSessionTimer = document.getElementById('radar-session-timer');
const radarSmtStatus = document.getElementById('radar-smt-status');
const radarGammaStatus = document.getElementById('radar-gamma-status');
const radarRealityText = document.getElementById('radar-reality-text');
const radarSessionBox = document.getElementById('radar-session-box');

// Trigger Checklist Elements
const btnUnlockSignal = document.getElementById('btn-unlock-signal');
const checklistModal = document.getElementById('checklist-modal');
const btnCloseChecklist = document.getElementById('btn-close-checklist');
const btnConfirmTrade = document.getElementById('btn-confirm-trade');
const triggerChecks = document.querySelectorAll('.trigger-check');

// Study Guide Elements
const studyGuideModal = document.getElementById('study-guide-modal');
const guideTitle = document.getElementById('guide-title');
const guideBody = document.getElementById('guide-body');
const btnCloseGuide = document.getElementById('btn-close-guide');
const btnCloseGuideFooter = document.getElementById('btn-close-guide-footer');

const STUDY_GUIDE_CONTENT = {
    'macro': {
        title: 'MACRO CORRELATION PULSE',
        steps: [
            { h: 'DXY (Dollar Index)', p: 'The global benchmark for US Dollar strength. Institutions use the Dollar as a safe haven. If DXY is RISING, it creates gravity for Stocks and Crypto, pulling them DOWN. If DXY is FALLING, it acts as fuel for a market rally.' },
            { h: 'VIX (Volatility Index)', p: 'Known as the "Fear Gauge". It measures the cost of option protection. VIX below 15 means extreme complacency (Safe to Bull). VIX spiking above 20 means institutions are hedging for a crash.' },
            { h: 'RORO INDEX', p: 'Risk-On / Risk-Off. This is a proprietary calculation of the relationship between yields, dollars, and volatility. High RORO means big money is aggressively buying risk assets.' }
        ]
    },
    'health': {
        title: 'INSTITUTIONAL HEALTH MATRIX',
        steps: [
            { h: 'The Engine Principle', p: 'No ticker moves alone. The Health Matrix tracks the "Sub-Sectors" (XLK, SMH, XLF) that power the index. If SPY is trying to rally but its health-matrix is Red, the move is a fakeout.' },
            { h: 'Forex Radar (SMT)', p: 'Smart Money Technique. We monitor the correlation between EUR and GBP. When they diverge (e.g., EUR makes a lower low but GBP doesn\'t), it reveals institutional manipulation and an impending reversal.' },
            { h: 'Inverse-DXY Realm', p: 'A specific market condition where all asset movement is being dictated strictly by Dollar manipulation. Trading outside this alignment is high-risk.' }
        ]
    },
    'heatmap': {
        title: 'INSTITUTIONAL HEATMAP',
        steps: [
            { h: 'Limit Order Clusters', p: 'This is the "Hidden Map" of the market. The bright zones indicate where massive buy/sell limit orders (Whale Blocks) are sitting. Price will often react violently at these levels.' },
            { h: 'GEX Walls', p: 'Call Walls and Put Walls represent Market Maker hedging levels. They act as "Magnets" or "Hard Ceilings" that the market struggles to penetrate.' }
        ]
    },
    'bias': {
        title: 'BIAS & MACRO NARRATIVE',
        steps: [
            { h: 'The B.I.A.S Machine', p: 'Aggregates 15+ institutional metrics (RORO, Tick, Breadth, Flows) to determine the Daily Program. Never trade against the Bias.' },
            { h: 'AMD (Accumulation/Manipulation/Distribution)', p: 'The three phases of the algorithmic day. Accumulation happens in Asia. Manipulation (Judas Swing) often occurs at London Open to trap retail. Distribution is the real move.' },
            { h: 'Midnight Open', p: 'The "True Daily Open". If price is above Midnight Open, institutions are leaning Bullish for the day. If below, the program is Bearish.' }
        ]
    },
    'strikezones': {
        title: 'INSTITUTIONAL STRIKEZONES',
        steps: [
            { h: 'Liquidity Draws (BSL/SSL)', p: 'Price is not random; it is a magnet to Liquidity. Buyside Liquidity (BSL) exists above old highs. Sellside Liquidity (SSL) exists below old lows. Algorithms move price to these areas to clear out stops.' },
            { h: 'CBDR Standard Deviations', p: 'Based on the Central Bank Dealers Range. These project the mathematical probability of high/low expansion for the day.' }
        ]
    },
    'recommendation': {
        title: 'GOLD STANDARD SIGNALS',
        steps: [
            { h: 'Algorithmic Confluence', p: 'A signal only appears when 5+ metrics (Trend, SMT, Flow, Macro, Walls) align perfectly. This is the 90%+ win-rate threshold.' },
            { h: 'Trims & Targets', p: 'Institutional trading is about scaling. "Trim" is where you take partial profits and move your stop to break even. "Target" is the final goal area.' }
        ]
    }
};

// --- INSTITUTIONAL AUDIO ENGINE ---
class InstitutionalAudio {
    constructor() {
        this.ctx = null;
        this.enabled = false;
        this.whaleFreq = 164.81; // E3
        this.signalFreq = 880.00; // A5
    }
    init() { if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)(); }
    play(freq, type = 'sine', duration = 0.2, volume = 0.1) {
        if (!this.enabled) return;
        try {
            this.init();
            if (this.ctx.state === 'suspended') this.ctx.resume();
            const osc = this.ctx.createOscillator();
            const gain = this.ctx.createGain();
            osc.type = type;
            osc.frequency.setValueAtTime(freq, this.ctx.currentTime);
            gain.gain.setValueAtTime(volume, this.ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + duration);
            osc.connect(gain);
            gain.connect(this.ctx.destination);
            osc.start();
            osc.stop(this.ctx.currentTime + duration);
        } catch (e) { }
    }
    playWhale() { this.play(this.whaleFreq, 'triangle', 0.6, 0.12); }
    playSignal() { this.play(this.signalFreq, 'sine', 0.4, 0.08); }
}

class VoiceNarrator {
    constructor() {
        this.enabled = false;
        this.synth = window.speechSynthesis;
    }
    toggle() {
        if (!this.synth) {
            showToast("SPEECH SYNTHESIS NOT SUPPORTED IN THIS BROWSER");
            return false;
        }
        this.enabled = !this.enabled;
        const btn = document.getElementById('btn-voice-toggle');
        const icon = document.getElementById('voice-icon');
        if (btn && icon) {
            btn.style.color = this.enabled ? '#38bdf8' : 'var(--text-dim)';
            btn.style.borderColor = this.enabled ? '#38bdf8' : 'var(--border)';
            icon.innerText = this.enabled ? '🔊' : '🔇';
        }
        if (this.enabled) {
            this.speak("SQUAWK ACTIVATED. MONITORING FOR ELITE SIGNALS.");
            showToast("VOICE SQUAWK: ARMED");
        } else {
            showToast("VOICE SQUAWK: SILENCED");
        }
        return this.enabled;
    }
    speak(text) {
        if (!this.enabled || !this.synth) return;
        try {
            this.synth.cancel();
            const utterance = new SpeechSynthesisUtterance(text);
            utterance.rate = 1.1; // Slightly faster for urgency
            utterance.pitch = 0.95;
            this.synth.speak(utterance);
        } catch (e) { }
    }
}

const audioHooter = new InstitutionalAudio();
const voiceNarrator = new VoiceNarrator();

document.getElementById('btn-audio-toggle')?.addEventListener('click', () => {
    audioHooter.enabled = !audioHooter.enabled;
    const btn = document.getElementById('btn-audio-toggle');
    const icon = document.getElementById('audio-icon');
    if (audioHooter.enabled) {
        audioHooter.init();
        icon.innerText = '🔔';
        btn.style.color = 'var(--gold)';
        btn.style.borderColor = 'var(--gold)';
        audioHooter.playSignal();
        showToast("INSTITUTIONAL HOOTER: ARMED");
    } else {
        icon.innerText = '🔇';
        btn.style.color = 'var(--text-dim)';
        btn.style.borderColor = 'var(--border)';
        showToast("INSTITUTIONAL HOOTER: SILENCED");
    }
});

document.getElementById('btn-voice-toggle')?.addEventListener('click', () => voiceNarrator.toggle());

let lastSignalAction = '';
let lastPrice = 0;
let signalUnlocked = false;
let pendingSignalData = null;

// --- Tactical Handbook Logic ---
const handbookModal = document.getElementById('handbook-modal');
const btnOpenHandbook = document.getElementById('btn-open-handbook');
const btnCloseHandbook = document.getElementById('btn-close-handbook');
const btnCloseHandbookFooter = document.getElementById('btn-close-handbook-footer');

const toggleHandbook = (show) => {
    if (handbookModal) {
        handbookModal.style.display = show ? 'flex' : 'none';
        document.body.style.overflow = show ? 'hidden' : 'auto';
    }
};

btnOpenHandbook?.addEventListener('click', () => toggleHandbook(true));
btnCloseHandbook?.addEventListener('click', () => toggleHandbook(false));
btnCloseHandbookFooter?.addEventListener('click', () => toggleHandbook(false));

// Auto-open for new sessions (can be tied to a 'first_visit' flag in DB/LocalStorage)
if (!localStorage.getItem('handbook_viewed')) {
    setTimeout(() => {
        toggleHandbook(true);
        localStorage.setItem('handbook_viewed', 'true');
    }, 2000);
}

// --- Card Info Trigger Logic ---
const cardInfoModal = document.getElementById('card-info-modal');
const cardInfoTitle = document.getElementById('card-info-title');
const cardInfoText = document.getElementById('card-info-text');
const cardInfoMoney = document.getElementById('card-info-money');
const btnCloseCardInfo = document.getElementById('btn-close-card-info');
const btnCloseCardInfoFooter = document.getElementById('btn-close-card-info-footer');

const cardInstructions = {
    bias: {
        title: "DAILY BIAS CONFIDENCE",
        text: "The high-speed algorithmic engine that measures 15+ real-time institutional data points to determine the market's true direction.",
        money: "Only trade in the direction of the bias. Green = Buy/Calls, Red = Sell/Puts. Never fight the system."
    },
    markers: {
        title: "INSTITUTIONAL MARKERS",
        text: "Key algorithmic anchor points like Midnight Open, PDH/PDL, and NY Open. These are the levels institutions use to set their daily range.",
        money: "Look for price to 'bounce' or 'reject' these levels. These are high-probability zones for entry and exit."
    },
    macro: {
        title: "MACRO CORRELATION PULSE",
        text: "Tracks the Dollar (DXY) and Fear Index (VIX). These are the 'Drivers' of the market.",
        money: "DXY falling usually means Stocks rally. Low VIX means stable trends. Use this to confirm your trade tailwinds."
    },
    health: {
        title: "INSTITUTIONAL HEALTH MATRIX",
        text: "Monitors the sectoral flows (Tech, Finance, Energy). It shows if the rally is broad or fake.",
        money: "If the top sectors (XLK, XLF) are all green, it confirms a powerful 'Risk-On' rally. High confidence."
    },
    heatmap: {
        title: "ORDER FLOW HEATMAP",
        text: "Visualizes where the largest institutional buy (SSL) and sell (BSL) orders are 'parking'.",
        money: "Price moves like a magnet toward these levels. Use them as your ultimate Take-Profit targets."
    },
    strikezones: {
        title: "INSTITUTIONAL STRIKEZONES",
        text: "Calculates the Asia Range and CBDR standard deviations to find the 'Mathematical' high and low of the day.",
        money: "Set your exits at SD1 or SD2 targets. Institutions frequently reverse the trend at these precise numbers."
    },
    recommendation: {
        title: "OPTION RECOMMENDATION",
        text: "The final AI execution signal. It calculates the exact Strike, Target, and Stop Loss based on institutional liquidity.",
        money: "Wait for a 'Gold Signal'. Follow the exact strike and exit levels. Do not deviate from the risk parameters."
    }
};

document.querySelectorAll('.card-info-trigger').forEach(btn => {
    btn.addEventListener('click', (e) => {
        const type = btn.getAttribute('data-card');
        const data = cardInstructions[type];
        if (data) {
            cardInfoTitle.innerText = data.title;
            cardInfoText.innerText = data.text;
            cardInfoMoney.innerText = data.money;
            cardInfoModal.style.display = 'flex';
            document.body.style.overflow = 'hidden';
        }
    });
});

const closeCardInfo = () => {
    cardInfoModal.style.display = 'none';
    document.body.style.overflow = 'auto';
};

btnCloseCardInfo?.addEventListener('click', closeCardInfo);
btnCloseCardInfoFooter?.addEventListener('click', closeCardInfo);
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

// Initialize Chart once
function initChartInstance() {
    const container = document.getElementById('priceChart');
    if (!container || tvChart) return;

    console.log("[CHART] Initializing permanent chart instance.");

    const width = container.clientWidth || 800;
    const height = 400;

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
            scaleMargins: { top: 0.1, bottom: 0.1 },
        },
        timeScale: {
            borderColor: '#1e293b',
            timeVisible: true,
            barSpacing: 10,
        }
    });

    candleSeries = tvChart.addCandlestickSeries({
        upColor: '#10b981',
        downColor: '#f43f5e',
        borderVisible: false,
        wickColor: '#10b981',
    });

    window.addEventListener('resize', () => {
        if (tvChart) tvChart.applyOptions({ width: container.clientWidth });
    });
}
initChartInstance();

// Zoom Controls
document.getElementById('zoom-in-btn')?.addEventListener('click', () => {
    if (!tvChart) return;
    const timeScale = tvChart.timeScale();
    const range = timeScale.getVisibleLogicalRange();
    if (range) {
        const span = range.to - range.from;
        timeScale.setVisibleLogicalRange({
            from: range.from + span * 0.1,
            to: range.to - span * 0.1
        });
    }
});

document.getElementById('zoom-out-btn')?.addEventListener('click', () => {
    if (!tvChart) return;
    const timeScale = tvChart.timeScale();
    const range = timeScale.getVisibleLogicalRange();
    if (range) {
        const span = range.to - range.from;
        timeScale.setVisibleLogicalRange({
            from: range.from - span * 0.1,
            to: range.to + span * 0.1
        });
    }
});
function setChartData(candles) {
    if (!candleSeries || !candles) return;
    try {
        const formatted = candles
            .filter(c => c.open > 0 && c.high > 0 && c.low > 0 && c.close > 0) // Strict positive filter
            .map(c => ({
                time: Math.floor(Number(c.timestamp) / 1000),
                open: Number(c.open),
                high: Number(c.high),
                low: Number(c.low),
                close: Number(c.close)
            }))
            .sort((a, b) => a.time - b.time);

        if (formatted.length > 0) {
            candleSeries.setData(formatted);
            setTimeout(() => {
                if (tvChart) {
                    tvChart.timeScale().fitContent();
                    tvChart.timeScale().scrollToRealTime();
                }
            }, 300);
        } else {
            candleSeries.setData([]);
        }
    } catch (e) {
        console.error("[CHART] Error in setChartData:", e);
    }
}
function updateInstitutionalRadar(data) {
    // Heartbeat Sync Flash (Proof of Work)
    const pulseServerSync = document.getElementById('pulse-server-sync');
    if (pulseServerSync) {
        pulseServerSync.style.opacity = 1;
        setTimeout(() => { pulseServerSync.style.opacity = 0; }, 500);
    }

    const radar = data.institutionalRadar;
    const bias = data.bias;
    const po3 = data.po3;
    const watchlist = data.watchlist || [];
    if (!radar) return;

    // NEW: Populating the Fast-Switch Alignment Radar
    const pulseContainer = document.getElementById('radar-alignment-pulse');
    const pulseStatus = document.getElementById('pulse-status');
    if (pulseContainer) {
        // Calculate alignment count locally for the active symbol to ensure perfect sync with boxes
        const currentBulls = radar.multiTfBias ? Object.values(radar.multiTfBias).filter(b => b.includes('BULLISH')).length : 0;
        const currentBears = radar.multiTfBias ? Object.values(radar.multiTfBias).filter(b => b.includes('BEARISH')).length : 0;
        const currentAlignment = Math.max(currentBulls, currentBears);

        let candidates = [...watchlist];
        if (currentAlignment >= 3 && !candidates.find(c => c.symbol === data.symbol)) {
            candidates.push({
                symbol: data.symbol,
                alignedCount: currentAlignment,
                bias: currentBulls >= currentBears ? 'BULLISH' : 'BEARISH'
            });
        }

        // Debugging the scanner
        if (currentAlignment >= 3) {
            console.log(`[RADAR DEBUG] Active Symbol ${data.symbol} Aligned: ${currentAlignment}. Candidates: ${candidates.length}`);
        }

        const topAligned = candidates
            .filter(item => (item.alignedCount || 0) >= 3)
            .sort((a, b) => b.alignedCount - a.alignedCount)
            .slice(0, 4);

        if (topAligned.length > 0) {
            if (pulseStatus) pulseStatus.innerText = 'SETUP DETECTED';
            pulseContainer.innerHTML = '';
            topAligned.forEach(item => {
                const isBull = item.bias.includes('BULLISH');
                const color = isBull ? 'var(--bullish)' : (item.bias.includes('BEARISH') ? 'var(--bearish)' : 'var(--gold)');
                
                const pill = document.createElement('div');
                pill.className = 'pulse-pill';
                pill.style.cssText = `font-size: 0.5rem; font-weight: 900; background: ${color}22; border: 1px solid ${color}; color: #fff; padding: 2px 6px; border-radius: 4px; cursor: pointer; transition: all 0.2s; white-space: nowrap;`;
                pill.innerHTML = `${item.symbol} <span style="color:${color};">🔥 ${item.alignedCount}TF</span>`;
                pill.onclick = () => {
                    socket.emit('switch_symbol', item.symbol);
                    if (typeof showToast === 'function') showToast(`Switching to setup: ${item.symbol}`);
                };
                pill.onmouseover = () => pill.style.background = `${color}44`;
                pill.onmouseleave = () => pill.style.background = `${color}22`;
                pulseContainer.appendChild(pill);
            });
        } else {
            if (pulseStatus) pulseStatus.innerText = 'SEARCHING...';
            pulseContainer.innerHTML = '<div style="font-size: 0.45rem; color: var(--text-dim); font-style: italic;">No high-alignment setups yet. Monitoring...</div>';
        }
    }

    // 1. IR Score
    if (radarIrScore) {
        radarIrScore.innerText = Math.round(radar.irScore);
        radarIrScore.style.color = radar.irScore > 75 ? 'var(--bullish)' : (radar.irScore < 40 ? 'var(--bearish)' : '#fff');
    }

    // 2. Killzone
    if (radarSessionName && radar.killzone) {
        radarSessionName.innerText = radar.killzone.name.replace(/_/g, ' ');
        radarSessionName.style.color = radar.killzone.color;
        
        if (radarSessionTimer) {
            radarSessionTimer.innerText = radar.killzone.active ? `INSTITUTIONAL POWER: ${Math.round(radar.killzone.progress)}%` : 'NO VOLATILITY';
        }
        
        const sessionProgress = document.getElementById('radar-session-progress');
        if (sessionProgress) {
            sessionProgress.style.width = (radar.killzone.active ? radar.killzone.progress : 0) + '%';
            sessionProgress.style.background = radar.killzone.color;
        }

        if (radarSessionBox) {
            radarSessionBox.style.border = `1px solid ${radar.killzone.color}44`;
        }
    }

    // NEW: MTF Bias Consensus Update
    if (data.multiTfBias) {
        const mtfContainer = document.getElementById('mtf-bias-consensus');
        if (mtfContainer) {
            Object.entries(data.multiTfBias).forEach(([tf, tfBias]) => {
                const box = mtfContainer.querySelector(`.mtf-box[data-tf="${tf}"]`);
                if (box) {
                    const status = box.querySelector('.tf-status');
                    if (status) {
                        status.className = 'tf-status';
                        if (tfBias.includes('BULLISH')) status.classList.add('bullish');
                        else if (tfBias.includes('BEARISH')) status.classList.add('bearish');
                        else status.classList.add('neutral');
                    }
                    box.setAttribute('title', `Timeframe: ${tf} | Bias: ${tfBias}`);
                }
            });
        }
    }

    // 3. SMT Divergence
    if (radarSmtStatus) {
        if (radar.smt) {
            radarSmtStatus.innerText = radar.smt.type.replace('_', ' ');
            radarSmtStatus.style.color = radar.smt.type.includes('BULLISH') ? 'var(--bullish)' : 'var(--bearish)';
        } else {
            radarSmtStatus.innerText = 'STABLE';
            radarSmtStatus.style.color = 'var(--text-dim)';
        }
    }

    // 4. Dealer Gamma
    if (radarGammaStatus && radar.gex) {
        const topWall = radar.gex.reduce((a, b) => a.gamma > b.gamma ? a : b);
        radarGammaStatus.innerText = `${topWall.isMagnet ? 'MAGNET:' : 'WALL:'} ${topWall.strike.toFixed(2)}`;
        radarGammaStatus.style.color = topWall.strike > bias.vwap ? 'var(--bullish)' : 'var(--bearish)';
    }

    // 5. Reality Narrative
    if (radarRealityText) {
        radarRealityText.innerText = bias.narrative || "Synchronizing institutional pulse...";
        radarRealityText.style.borderLeftColor = bias.bias.includes('BULLISH') ? 'var(--bullish)' : (bias.bias.includes('BEARISH') ? 'var(--bearish)' : 'var(--gold)');
    }

    // 6. Retail Sentiment Gauge (Contrarian Indicator)
    const retailVal = document.getElementById('retail-sentiment-val');
    const retailFill = document.getElementById('retail-sentiment-fill');
    const retailStrategy = document.getElementById('retail-strategy-text');
    
    if (bias.retailSentiment !== undefined) {
        const sentiment = bias.retailSentiment; // 0-100
        if (retailVal) retailVal.innerText = `${sentiment.toFixed(0)}% LONG`;
        if (retailFill) {
            retailFill.style.width = `${sentiment}%`;
            // Color shift the bar based on extreme levels
            retailFill.style.background = sentiment >= 75 ? 'var(--bearish)' : (sentiment <= 25 ? 'var(--bullish)' : 'linear-gradient(90deg, var(--bearish) 0%, var(--bullish) 100%)');
        }
        
        if (retailStrategy) {
            if (sentiment >= 75) {
                retailStrategy.innerText = "CONTRARIAN BIAS: BEARISH (RETAIL TRAP)";
                retailStrategy.style.color = 'var(--bearish)';
            } else if (sentiment <= 25) {
                retailStrategy.innerText = "CONTRARIAN BIAS: BULLISH (RETAIL SQUEEZE)";
                retailStrategy.style.color = 'var(--bullish)';
            } else {
                retailStrategy.innerText = "CONTRARIAN BIAS: NEUTRAL";
                retailStrategy.style.color = 'var(--gold)';
            }
        }
    }

    // 7. Judas Swing Indicator
    const judasEl = document.getElementById('judas-indicator');
    if (judasEl) {
        if (bias.judas) {
            judasEl.style.display = 'block';
            judasEl.innerText = bias.judas.label;
            judasEl.title = `INSTITUTIONAL MANIPULATION DETECTED AT ${bias.judas.level}`;
        } else {
            judasEl.style.display = 'none';
        }
    }

    // 8. Institutional Whale Tape (Rolling Feed)
    const tapeList = document.getElementById('whale-tape-list');
    if (tapeList && data.whaleTape) {
        // Clear placeholder if it's the first real event
        if (tapeList.innerHTML.includes('Monitoring dark pool')) tapeList.innerHTML = '';

        const tape = data.whaleTape;
        const color = tape.type === 'BUY_BLOCK' ? 'var(--bullish)' : 'var(--bearish)';
        
        const row = document.createElement('div');
        row.style.display = 'flex';
        row.style.justifyContent = 'space-between';
        row.style.padding = '2px 4px';
        row.style.background = 'rgba(255,255,255,0.02)';
        row.style.borderLeft = `2px solid ${color}`;
        row.style.animation = 'slide-in-right 0.3s ease-out';
        
        row.innerHTML = `
            <span style="color: ${color}; font-weight: 900;">$${tape.size} ${tape.type === 'BUY_BLOCK' ? 'Gû¦' : 'Gû+'}</span>
            <span style="color: var(--text-dim); opacity: 0.8; font-size: 0.45rem;">@ ${tape.price.toFixed(data.symbol.includes('=X') ? 5 : 2)}</span>
            <span style="color: var(--gold); opacity: 0.6;">${tape.time}</span>
        `;
        
        tapeList.prepend(row);
        
        // Keep only last 8 rows to save memory and stay in container
        while (tapeList.children.length > 8) {
            tapeList.removeChild(tapeList.lastChild);
        }
    }

    // 9. PO3 Cycle Engine (Main Radar)
    const po3Badge = document.getElementById('po3-phase-badge');
    const po3Progress = document.getElementById('po3-progress-bar');
    const po3Desc = document.getElementById('po3-description');

    if (po3 && po3Badge && po3Progress && po3Desc) {
        po3Badge.innerText = po3.phase;
        po3Badge.style.background = po3.color;
        po3Progress.style.width = `${po3.progress}%`;
        po3Progress.style.background = po3.color;
        po3Desc.innerText = po3.label + ": " + po3.description;
    }

    // 10. ELITE CONFLUENCE CHECKLIST UPDATE
    const setConf = (id, active) => {
        const item = document.querySelector(`.conf-item[data-conf="${id}"]`);
        if (item) {
            const indicator = item.querySelector('.conf-indicator');
            const label = item.querySelector('span');
            if (active) {
                indicator.style.background = 'var(--bullish)';
                indicator.style.boxShadow = '0 0 8px var(--bullish)';
                indicator.style.borderColor = 'var(--bullish)';
                label.style.color = '#fff';
            } else {
                indicator.style.background = '#1a1a1a';
                indicator.style.boxShadow = 'none';
                indicator.style.borderColor = 'rgba(255,255,255,0.1)';
                label.style.color = 'var(--text-dim)';
            }
        }
    };

    if (data.markers && data.bias) {
        const m = data.markers;
        const b = data.bias;
        const price = data.currentPrice;

        // Midnight Open Alignment
        const midAlign = (b.bias === 'BULLISH' && price > m.midnightOpen) || (b.bias === 'BEARISH' && price < m.midnightOpen);
        setConf('midnight', midAlign);

        // VWAP Alignment
        const vwapAlign = (b.bias === 'BULLISH' && price > m.vwap) || (b.bias === 'BEARISH' && price < m.vwap);
        setConf('vwap', vwapAlign);

        // Killzone Status
        setConf('killzone', radar.killzone.active);

        // SMT Detection
        setConf('smt', radar.smt !== null);

        // DXY Correlation (Risk-On check)
        const dxyAlign = (b.bias === 'BULLISH' && data.markers.dxy < 105) || (b.bias === 'BEARISH' && data.markers.dxy > 100); 
        setConf('dxy', dxyAlign);

        // Sector Alignment
        setConf('sector', data.confluenceScore > 60);
    }

    // Scalper Scan Overlay (New)
    const scalperOverlay = document.getElementById('scalper-scan-overlay');
    const scalperVelocity = document.getElementById('scalper-velocity-val');
    const scalperResult = document.getElementById('scalper-scan-result');

    if (data.scalpScan && scalperOverlay) {
        scalperOverlay.style.display = 'block';
        if (scalperVelocity) scalperVelocity.innerText = data.scalpScan.velocity;
        if (scalperResult) {
            scalperResult.innerText = data.scalpScan.signal;
            scalperResult.style.color = data.scalpScan.color;
        }
    } else if (scalperOverlay) {
        scalperOverlay.style.display = 'none';
    }
}

function updateProtocolStatus(data) {
    const el = document.getElementById('protocol-status-indicator');
    const main = document.querySelector('.dashboard-main');
    if (!el || !main) return;

    const text = el.querySelector('.p-text');
    const rec = data.recommendation;
    const score = data.confluenceScore || 0;

    // Reset classes
    main.classList.remove('protocol-standby', 'protocol-monitoring');

    const narrativeEl = el.querySelector('.p-narrative');
    if (narrativeEl && rec?.tacticalNarrative) {
        narrativeEl.innerText = rec.tacticalNarrative;
    }

    if (rec && rec.action !== 'WAIT' && score >= 80 && rec.isStable) {
        el.className = 'protocol-status-ribbon ready';
        if (text) text.innerText = `PROTOCOL: READY (${rec.action})`;
    } else if (data.markers?.radar?.killzone?.active) {
        el.className = 'protocol-status-ribbon warning';
        if (text) text.innerText = 'PROTOCOL: MONITORING (KILLZONE)';
        main.classList.add('protocol-monitoring');
    } else {
        el.className = 'protocol-status-ribbon';
        if (text) text.innerText = 'PROTOCOL: STANDBY (WAITING)';
        main.classList.add('protocol-standby');
    }
}
function updateChartOverlays(data) {
    if (!candleSeries || !data.markers || !data.currentPrice) return;

    // Clear old lines
    currentPriceLines.forEach(line => candleSeries.removePriceLine(line));
    currentPriceLines = [];

    const m = data.markers;
    const currentPrice = data.currentPrice || 0;
    const labelThreshold = currentPrice * 0.0015; // 0.15% threshold for label collision
    const outerThreshold = currentPrice * 0.15; // 15% outlier threshold to prevent scaling bugs

    const levels = [];

    const addLevel = (price, color, style, title, weight) => {
        if (price > 0 && Math.abs(price - currentPrice) < outerThreshold) {
            levels.push({ price: Number(price), color, style, title, weight });
        }
    };

    // --- Institutional Priority System ---
    addLevel(m.midnightOpen, '#38bdf8', 1, 'MID OPEN', 10);
    addLevel(m.nyOpen, '#10b981', 2, 'NY OPEN', 9);
    addLevel(m.pdh, 'rgba(255, 255, 255, 0.7)', 1, 'PDH', 8);
    addLevel(m.pdl, 'rgba(255, 255, 255, 0.7)', 1, 'PDL', 8);
    addLevel(m.vwap, '#f59e0b', 0, 'VWAP', 7);

    // Call / Put Walls (GEX Proxies)
    if (m.callWall > 0) addLevel(m.callWall, '#f43f5e', 0, 'CALL WALL', 15);
    if (m.putWall > 0) addLevel(m.putWall, '#10b981', 0, 'PUT WALL', 15);

    // VWAP Bands
    if (m.vwapStdev > 0) {
        addLevel(m.vwap + m.vwapStdev, 'rgba(245, 158, 11, 0.4)', 2, '+1 STDEV', 12);
        addLevel(m.vwap - m.vwapStdev, 'rgba(245, 158, 11, 0.4)', 2, '-1 STDEV', 12);
        addLevel(m.vwap + (m.vwapStdev * 2), 'rgba(245, 158, 11, 0.6)', 1, '+2 STDEV (REV)', 14);
        addLevel(m.vwap - (m.vwapStdev * 2), 'rgba(245, 158, 11, 0.6)', 1, '-2 STDEV (REV)', 14);
    }
    
    addLevel(m.poc, '#8b5cf6', 1, 'POC', 6);

    // Equilibrium / Range
    if (m.todayHigh > 0 && m.todayLow > 0) {
        const equilibrium = (m.todayHigh + m.todayLow) / 2;
        addLevel(equilibrium, 'rgba(245, 158, 11, 0.4)', 2, 'EQ', 5);
        addLevel(m.todayHigh, 'rgba(148, 163, 184, 0.2)', 1, 'T-HIGH', 3);
        addLevel(m.todayLow, 'rgba(148, 163, 184, 0.2)', 1, 'T-LOW', 3);
    }

    addLevel(m.pdc, 'rgba(148, 163, 184, 0.4)', 2, 'PDC', 4);

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

    // 3. Volume Imbalance (VI)
    if (data.bias && data.bias.volumeImbalance) {
        const vi = data.bias.volumeImbalance;
        const viColor = vi.type.includes('BULLISH') ? 'rgba(245, 158, 11, 0.25)' : 'rgba(244, 63, 94, 0.25)';
        levels.push({ price: vi.top, color: viColor, style: 2, title: 'IMBALANCE', weight: 2 });
        levels.push({ price: vi.bottom, color: viColor, style: 2, title: '', weight: 1 });
    }

    // --- NEW: ASIA RANGE & LIQUIDITY MAGNETS ---
    if (m.asiaRange) {
        addLevel(m.asiaRange.high, 'rgba(56, 189, 248, 0.4)', 1, 'ASIA HIGH', 1);
        addLevel(m.asiaRange.low, 'rgba(56, 189, 248, 0.4)', 1, 'ASIA LOW', 1);
    }

    // --- INSTITUTIONAL HEATMAP (GRAVITY ZONES) ---
    if (data.heatmap) {
        data.heatmap.slice(0, 5).forEach(zone => {
            // Only add lines for high-gravity targets (> 70)
            if (zone.gravity > 70) {
                addLevel(zone.price, zone.color, 1, `[HUNT] ${zone.type}`, 2);
            }
        });
    }

    // Finalize Levels
    levels.sort((a, b) => b.weight - a.weight);

    if (data.bias && data.bias.restingLiquidity) {
        const rl = data.bias.restingLiquidity;
        if (rl.eqh) addLevel(rl.eqh.price, 'rgba(245, 158, 11, 0.6)', 1, 'EQH DRAW', 15);
        if (rl.eql) addLevel(rl.eql.price, 'rgba(245, 158, 11, 0.6)', 1, 'EQL DRAW', 15);
    }

    if (data.bias && data.bias.cbdr) {
        const c = data.bias.cbdr;
        addLevel(c.sd1_high, 'rgba(139, 92, 246, 0.5)', 2, 'CBDR SD1 (TGT)', 10);
        addLevel(c.sd1_low, 'rgba(139, 92, 246, 0.5)', 2, 'CBDR SD1 (TGT)', 10);
        addLevel(c.sd2_high, 'rgba(244, 63, 94, 0.6)', 1, 'CBDR SD2 (MAX)', 14);
        addLevel(c.sd2_low, 'rgba(244, 63, 94, 0.6)', 1, 'CBDR SD2 (MAX)', 14);
    }

    if (data.bias && data.bias.ote) {
        const ote = data.bias.ote;
        const oteColor = ote.type.includes('BULLISH') ? 'rgba(245, 158, 11, 0.25)' : 'rgba(244, 63, 94, 0.25)';
        addLevel(ote.fib62, oteColor, 2, 'OTE 62%', 9);
        addLevel(ote.fib70, oteColor, 0, 'OTE SWEET SPOT', 15);
        addLevel(ote.fib79, oteColor, 2, 'OTE 79%', 9);
    }

    if (data.bias && data.bias.flout) {
        const f = data.bias.flout;
        addLevel(f.mid, 'rgba(148, 163, 184, 0.4)', 2, 'FLOUT MID', 3);
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

// Legacy initChart removed. Using initChartInstance and setChartData now.

socket.on('init', (data) => {
    console.log(`[SOCKET] Received init for ${data.symbol}`);
    setChartData(data.candles || []);
    updateUI(data);
    const btnManualScan = document.getElementById('btn-manual-scan');
    if (btnManualScan) {
        btnManualScan.onclick = (e) => {
            console.log('[CLIENT] EMITTING manual_scan_trigger');
            socket.emit('manual_scan_trigger');
            e.stopPropagation();
            btnManualScan.innerText = 'SCANNING...';
            socket.emit('manual_scan');
            setTimeout(() => { btnManualScan.innerText = 'SCAN NOW'; }, 2000);
        };
    }

    if ((!data.candles || data.candles.length === 0) && data.timeframe === '1m') {
        socket.emit('switch_timeframe', '5m');
    }
});

socket.on('update', (data) => {
    // console.log('[SOCKET] Update received:', data.symbol, data.institutionalRadar ? 'RADAR OK' : 'NO RADAR');
    updateUI(data);
    const btnManualScan = document.getElementById('btn-manual-scan');
    if (btnManualScan) {
        btnManualScan.onclick = (e) => {
            console.log('[CLIENT] EMITTING manual_scan_trigger');
            socket.emit('manual_scan_trigger');
            e.stopPropagation();
            btnManualScan.innerText = 'SCANNING...';
            socket.emit('manual_scan');
            setTimeout(() => { btnManualScan.innerText = 'SCAN NOW'; }, 2000);
        };
    }
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
    updateUI(data); // CRITICAL: Update the whole HUD and overlays when TF changes
    const btnManualScan = document.getElementById('btn-manual-scan');
    if (btnManualScan) {
        btnManualScan.onclick = (e) => {
            console.log('[CLIENT] EMITTING manual_scan_trigger');
            socket.emit('manual_scan_trigger');
            e.stopPropagation();
            btnManualScan.innerText = 'SCANNING...';
            socket.emit('manual_scan');
            setTimeout(() => { btnManualScan.innerText = 'SCAN NOW'; }, 2000);
        };
    }
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
        if (typeof updateIntelTicker === "function") updateIntelTicker(data);
});
socket.on('tf_updated', (data) => {
    console.log(`[SOCKET] Timeframe Updated: ${data.timeframe}`);
    if (data.candles) setChartData(data.candles);
    updateUI(data);
});
socket.on('symbol_updated', (data) => {
    console.log(`[SOCKET] Symbol Updated: ${data.symbol}`);
    setChartData(data.candles || []);
    updateUI(data);
    const btnManualScan = document.getElementById('btn-manual-scan');
    if (btnManualScan) {
        btnManualScan.onclick = (e) => {
            console.log('[CLIENT] EMITTING manual_scan_trigger');
            socket.emit('manual_scan_trigger');
            e.stopPropagation();
            btnManualScan.innerText = 'SCANNING...';
            socket.emit('manual_scan');
            setTimeout(() => { btnManualScan.innerText = 'SCAN NOW'; }, 2000);
        };
    }
});

socket.on('watchlist_updated', (data) => {
    console.log(`[SOCKET] Global Watchlist Updated: ${data.watchlist?.length || 0} symbols`);
    updateWatchlist(data);
});

socket.on('price_update', (data) => {
    if (data.symbol === document.getElementById('symbol-display')?.innerText) {
        // Update Main Price
        if (priceEl && data.price) {
            const isFX = data.symbol.includes('=X') || data.symbol.includes('USD');
            const newPrice = data.price;
            
            if (lastPrice > 0) {
                const priceContainer = priceEl.parentElement;
                priceContainer.classList.remove('flash-up', 'flash-down');
                void priceContainer.offsetWidth;
                if (newPrice > lastPrice) priceContainer.classList.add('flash-up');
                else if (newPrice < lastPrice) priceContainer.classList.add('flash-down');
            }
            lastPrice = newPrice;
            priceEl.innerText = newPrice.toLocaleString(undefined, {
                minimumFractionDigits: isFX ? 4 : 2,
                maximumFractionDigits: isFX ? 5 : 2
            });
        }
        
        // Update Change
        if (changeEl && data.change != null) {
            changeEl.innerText = `${data.change >= 0 ? '+' : ''}${data.change.toFixed(2)}%`;
            changeEl.className = 'main-change ' + (data.change >= 0 ? 'bullish-text' : 'bearish-text');
        }
        
        // Update Candle
        if (candleSeries && data.candle) {
            const c = data.candle;
            try {
                candleSeries.update({
                    time: Math.floor(c.timestamp / 1000),
                    open: Number(c.open),
                    high: Number(c.high),
                    low: Number(c.low),
                    close: Number(c.close)
                });
            } catch (e) {}
        }
    }

    // --- REAL-TIME WATCHLIST TICKER SYNC ---
    const tickerItem = document.querySelector(`.ticker-card[data-symbol="${data.symbol}"]`);
    if (tickerItem) {
        const pEl = tickerItem.querySelector('.ticker-price');
        const cEl = tickerItem.querySelector('.ticker-meta span:first-child');
        const isFX = data.symbol.includes('=X') || data.symbol.includes('USD');
        
        if (pEl && data.price) {
            const oldPriceText = pEl.innerText.replace('$', '').replace(',', '');
            const oldPrice = parseFloat(oldPriceText);
            pEl.innerText = `$${data.price.toFixed(isFX ? 4 : 2)}`;
            
            // Pulse effect
            tickerItem.classList.remove('pulse-up', 'pulse-down');
            void tickerItem.offsetWidth;
            if (data.price > oldPrice) tickerItem.classList.add('pulse-up');
            else if (data.price < oldPrice) tickerItem.classList.add('pulse-down');
            setTimeout(() => tickerItem.classList.remove('pulse-up', 'pulse-down'), 800);
        }
        
        if (cEl && data.change != null) {
            cEl.innerText = `${data.change >= 0 ? '+' : ''}${data.change.toFixed(2)}%`;
            cEl.style.color = data.change >= 0 ? 'var(--bullish)' : 'var(--bearish)';
        }
    }
});

// --- UI UPDATE CORE ---

function updateUI(data) {
    if (!data) return;
    try {
        // console.log('[UI] Updating components for', data.symbol);

        const isFX = data.symbol?.includes('=X') || data.symbol?.includes('USD');
        const precision = isFX ? 5 : 2;

        const btnManualScan = document.getElementById('btn-manual-scan');
        if (btnManualScan) {
            btnManualScan.onclick = (e) => {
                console.log('[CLIENT] EMITTING manual_scan_trigger');
                socket.emit('manual_scan_trigger');
                e.stopPropagation();
                btnManualScan.innerText = 'SCANNING...';
                socket.emit('manual_scan');
                setTimeout(() => { btnManualScan.innerText = 'SCAN NOW'; }, 2000);
            };
        }
        if (data.watchlist) updateWatchlist(data);

        // --- ELITE: DXY MASTER ANCHOR SYNC ---
        const dxyBadge = document.getElementById('dxy-anchor-badge');
        if (dxyBadge && data.bias && data.bias.dxyAnchor) {
            const anchor = data.bias.dxyAnchor;
            const al = anchor.alignment || 'NEUTRAL';
            dxyBadge.innerText = `DXY ANCHOR: ${al.replace('_', ' ')}`;
            dxyBadge.style.color = (al === 'INSTITUTIONAL_SYNC' || al === 'CONCORDANT') ? '#10b981' : (al === 'CORRELATION_TRAP' ? '#f43f5e' : '#94a3b8');
        }

        // Protocol Update
        updateProtocolStatus(data);

        // ELITE SCALPER SCAN UPDATE
        const scalperScanList = document.getElementById('scalper-scan-list');
        if (scalperScanList && data.scalpScan) {
            const row = document.createElement('div');
            row.style.cssText = 'padding: 0.6rem; border-bottom: 1px solid rgba(255,255,255,0.03); display: flex; justify-content: space-between; align-items: center; border-left: 2px solid ' + data.scalpScan.color;

            const left = document.createElement('div');
            const ticker = document.createElement('div');
            ticker.style.cssText = 'font-size: 0.75rem; font-weight: 900; color: #fff; font-family: var(--font-data);';
            ticker.innerText = data.symbol;
            const signal = document.createElement('div');
            signal.style.cssText = 'font-size: 0.5rem; color: #94a3b8; font-weight: 700;';
            signal.innerText = data.scalpScan.signal;
            left.appendChild(ticker); left.appendChild(signal);

            const right = document.createElement('div');
            const velocity = document.createElement('div');
            velocity.style.cssText = 'font-size: 0.6rem; text-align: right; font-weight: 900; color: ' + data.scalpScan.color;
            velocity.innerText = 'VEL: ' + data.scalpScan.velocity;
            const time = document.createElement('div');
            time.style.cssText = 'font-size: 0.45rem; text-align: right; color: #94a3b8;';
            time.innerText = new Date().toLocaleTimeString();
            right.appendChild(velocity); right.appendChild(time);

            row.appendChild(left); row.appendChild(right);

            if (scalperScanList.firstChild && scalperScanList.firstChild.innerText && scalperScanList.firstChild.innerText.includes('INITIALIZING')) { scalperScanList.innerHTML = ''; }
            scalperScanList.prepend(row);
            if (scalperScanList.children.length > 5) scalperScanList.removeChild(scalperScanList.lastChild);
        }

        // Refresh Institutional Chart Overlays
        updateChartOverlays(data);

        // Update Chart Precision based on Asset Class
        if (candleSeries) {
            const isFX = data.symbol.includes('=X') || data.symbol.includes('USD');
            candleSeries.applyOptions({
                priceFormat: {
                    type: 'price',
                    precision: isFX ? 5 : 2,
                    minMove: isFX ? 0.00001 : 0.01,
                }
            });
        }

        // --- INSTITUTIONAL HUD REFINEMENTS ---
        const hudDxy = document.getElementById('hud-dxy-status');
        const hudSmt = document.getElementById('hud-smt-status');
        const hud = document.getElementById('institutional-hud');
        if (hudDxy && data.forexRadar) {
            const valEl = hudDxy.querySelector('.val');
            if (valEl) {
                valEl.innerText = data.forexRadar.isInverseDxy ? 'MAX SYNC (INVERSE)' : 'UNSTABLE';
                valEl.style.color = data.forexRadar.isInverseDxy ? 'var(--bullish)' : 'var(--text-dim)';
            }
        }
        if (hudSmt && data.institutionalRadar) {
            const smt = data.institutionalRadar.smt;
            const valEl = hudSmt.querySelector('.val');
            if (valEl) {
                valEl.innerText = smt ? `${smt.symbol} (${smt.type})` : 'STABLE';
                valEl.style.color = smt ? 'var(--gold)' : 'var(--text-dim)';
            }
        }
        if (hud) {
            const isFX_HUD = data.symbol.includes('=X') || data.symbol.includes('USD');
            const hasSmt = data.institutionalRadar && data.institutionalRadar.smt;
            hud.style.display = (isFX_HUD || hasSmt) ? 'flex' : 'none';
        }

        const kzCountdown = document.getElementById('killzone-countdown');
        if (kzCountdown && data.session) {
            const now = new Date();
            const nyTime = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
            const currentMin = (nyTime.getHours() * 60) + nyTime.getMinutes();
            const targets = [ { name: 'LONDON', min: 180 }, { name: 'NY OPEN', min: 570 }, { name: 'SILVER', min: 600 }, { name: 'NY PM', min: 810 }, { name: 'ASIA', min: 1140 } ];
            let next = targets.find(t => t.min > currentMin);
            if (!next) next = targets[0];
            let diff = next.min - currentMin;
            if (diff < 0) diff += 1440;
            kzCountdown.innerText = `NEXT: ${next.name} (${Math.floor(diff / 60)}h ${diff % 60}m)`;
        }

        const btnFocus = document.getElementById('btn-focus-mode');
        if (btnFocus && !btnFocus.onclick) {
            btnFocus.onclick = () => {
                document.body.classList.toggle('focus-desk');
                const isF = document.body.classList.contains('focus-desk');
                btnFocus.innerText = isF ? 'FOCUS: ON' : 'FOCUS: OFF';
            };
        }

        if (typeof updateBlueprint === 'function') updateBlueprint(data);
        if (typeof updateSpiderMatrix === 'function') updateSpiderMatrix(data);
        const symbolDisplay = document.getElementById('symbol-display');
        if (symbolDisplay) symbolDisplay.innerText = data.symbol || 'SPY';

        // --- WHALE TAPE REAL-TIME FEED (RESTORED) ---
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
                `).join(' <span style="opacity:0.2;">GÇó</span> ');
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

                // Stale Data Check (visual only, alert if last update > 60s)
                const isStale = data.timestamp && (Date.now() - data.timestamp > 60000);
                priceEl.classList.toggle('stale-label', !!isStale);

                // Flash effect
                if (lastPrice > 0 && !isStale) {
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
                if (nyOpenEl) nyOpenEl.innerText = (data.markers.nyOpen || 0).toFixed(precision);
                if (londonOpenEl) londonOpenEl.innerText = (data.markers.londonOpen || 0).toFixed(precision);
                if (callWallEl) callWallEl.innerText = (data.markers.callWall || 0).toFixed(precision);
                if (putWallEl) putWallEl.innerText = (data.markers.putWall || 0).toFixed(precision);
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
                const dxyValue = data.markers.dxy || (data.bias && data.bias.internals ? data.bias.internals.dxy : 0);
                if (dxyHudEl) {
                    dxyHudEl.innerText = (dxyValue || 0).toFixed(2);
                    dxyHudEl.className = dxyValue > 103 ? 'bearish-text' : 'bullish-text';
                }
                if (dxyValEl) dxyValEl.innerText = (dxyValue || 0).toFixed(2);

                const tnxValue = data.markers.tnx || (data.bias && data.bias.internals ? data.bias.internals.tnx : 0);
                if (tnxHudEl) {
                    tnxHudEl.innerText = `${(tnxValue || 0).toFixed(2)}%`;
                    tnxHudEl.className = tnxValue > 4.2 ? 'bearish-text' : 'bullish-text';
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
                    trapBadge.innerText = `GÜán+Å ${data.bias.trap.type.replace('_', ' ')}`;
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

            // --- NEW: VOLATILITY SQUEEZE ---
            if (squeezeBadge) {
                if (data.bias && data.bias.squeeze && data.bias.squeeze.status === 'SQUEEZING') {
                    squeezeBadge.style.display = 'block';
                    squeezeBadge.title = `Squeeze Intensity: ${(data.bias.squeeze.intensity * 100).toFixed(0)}%`;
                } else {
                    squeezeBadge.style.display = 'none';
                }
            }

            // --- NEW: RORO INDEX ---
            if (data.bias && data.bias.roro) {
                const roro = data.bias.roro;
                if (roroLabel) {
                    roroLabel.innerText = roro.label;
                    roroLabel.style.color = roro.color;
                }
                if (roroBar) {
                    roroBar.style.width = `${roro.score}%`;
                    roroBar.style.background = roro.color;
                }
                if (roroVal) roroVal.innerText = `RORO: ${roro.score.toFixed(0)}`;
            }

            // --- =ƒªä UNICORN DETECTOR UI UPDATES ---
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

            if (displacementBadge) {
                displacementBadge.style.display = (data.bias && data.bias.isDisplacement) ? 'block' : 'none';
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

            // --- FOREX INTELLIGENCE RADAR ---
            const fxRadarContainer = document.getElementById('forex-radar-container');
            if (data.forexRadar && fxRadarContainer) {
                fxRadarContainer.style.display = 'block';
                const dxyCorrEl = document.getElementById('fx-dxy-corr');
                const smtSyncEl = document.getElementById('fx-smt-sync');
                const inverseBadge = document.getElementById('fx-inverse-dxy-badge');

                if (dxyCorrEl) {
                    const corr = data.forexRadar.dxyCorr || 0;
                    dxyCorrEl.innerText = `${corr.toFixed(0)}%`;
                    dxyCorrEl.style.color = corr < -80 ? 'var(--bullish)' : (corr > 80 ? 'var(--bearish)' : 'var(--text-bright)');
                }
                if (smtSyncEl) {
                    if (data.forexRadar.smt) {
                        smtSyncEl.innerText = `SMT ${data.forexRadar.smt.type}`;
                        smtSyncEl.style.color = data.forexRadar.smt.type === 'BULLISH' ? 'var(--bullish)' : 'var(--bearish)';
                    } else {
                        const sync = data.forexRadar.eurGbpCorr || 0;
                        smtSyncEl.innerText = sync > 90 ? 'SYNC' : 'ALIGNING';
                        smtSyncEl.style.color = sync > 90 ? 'var(--bullish)' : 'var(--gold)';
                    }
                }
                if (inverseBadge) {
                    inverseBadge.style.display = data.forexRadar.isInverseDxy ? 'block' : 'none';
                }

                // Global Session Matrix
                if (data.forexRadar.globalSessions) {
                    const sess = data.forexRadar.globalSessions;
                    Object.keys(sess).forEach(key => {
                        const el = document.getElementById(`gs-${key}`);
                        if (el) {
                            const status = el.querySelector('.gs-status');
                            if (status) {
                                status.innerText = sess[key].status;
                                status.style.color = sess[key].color;
                                el.style.borderColor = sess[key].status === 'OPEN' ? sess[key].color : 'transparent';
                                if (sess[key].status === 'OPEN') el.style.background = `rgba(255,255,255,0.05)`;
                                else el.style.background = `rgba(0,0,0,0.2)`;
                            }
                        }
                    });
                }

                // --- ELITE FOREX OVERLAYS ---
                const fxJudas = document.getElementById('fx-judas-alert');
                if (fxJudas) {
                    if (data.bias.judas) {
                        fxJudas.style.display = 'block';
                        fxJudas.innerText = data.bias.judas.label;
                    } else {
                        fxJudas.style.display = 'none';
                    }
                }

                const fxRetailVal = document.getElementById('fx-retail-val');
                const fxRetailFill = document.getElementById('fx-retail-fill');
                if (data.bias.retailSentiment !== undefined) {
                    const rs = data.bias.retailSentiment;
                    if (fxRetailVal) fxRetailVal.innerText = `${rs.toFixed(0)}% LONG`;
                    if (fxRetailFill) {
                        fxRetailFill.style.width = `${rs}%`;
                        fxRetailFill.style.background = rs >= 75 ? 'var(--bearish)' : (rs <= 25 ? 'var(--bullish)' : 'linear-gradient(90deg, var(--bearish) 0%, var(--bullish) 100%)');
                    }
                }

                const fxTapeList = document.getElementById('fx-whale-tape-list');
                if (fxTapeList && data.whaleTape) {
                    if (fxTapeList.innerHTML.includes('Tracking order flow')) fxTapeList.innerHTML = '';
                    const t = data.whaleTape;
                    const c = t.type === 'BUY_BLOCK' ? 'var(--bullish)' : 'var(--bearish)';
                    const row = document.createElement('div');
                    row.style.display = 'flex';
                    row.style.justifyContent = 'space-between';
                    row.style.animation = 'slide-in-right 0.3s ease-out';
                    row.innerHTML = `<span style="color:${c}; font-weight:900;">$${t.size} ${t.type === 'BUY_BLOCK' ? 'Gû¦' : 'Gû+'}</span> <span style="color:var(--text-dim); opacity:0.6;">${t.time}</span>`;
                    fxTapeList.prepend(row);
                    if (fxTapeList.children.length > 5) fxTapeList.removeChild(fxTapeList.lastChild);
                }

                // --- FX PO3 TRACKER ---
                const fxPo3Phase = document.getElementById('fx-po3-phase');
                const fxPo3Progress = document.getElementById('fx-po3-progress');
                if (data.po3 && fxPo3Phase && fxPo3Progress) {
                    fxPo3Phase.innerText = data.po3.phase;
                    fxPo3Phase.style.color = data.po3.color;
                    fxPo3Progress.style.width = `${data.po3.progress}%`;
                    fxPo3Progress.style.background = data.po3.color;
                }
            } else if (fxRadarContainer) {
                fxRadarContainer.style.display = 'none';
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

                // MTF Grid Sync
                if (data.multiTfBias) {
                    ['1m', '5m', '15m', '1h'].forEach(tf => {
                        const dot = document.getElementById(`mtf-dot-${tf}`);
                        if (dot) {
                            const b = data.multiTfBias[tf] || 'NEUTRAL';
                            dot.className = 'mtf-dot ' + (b === 'BULLISH' || b === 'STRONG BULLISH' ? 'bullish' : b === 'BEARISH' || b === 'STRONG BEARISH' ? 'bearish' : 'neutral');
                        }
                    });
                }

                // Audio & Voice Alert - Strictly for PROTOCOL READY signals
                const protocolReady = (data.recommendation.action !== 'WAIT' && (data.confluenceScore || 0) >= 75);
                if (data.recommendation.isStable && protocolReady) {
                    const signalKey = `${data.symbol}_${data.recommendation.action}`;
                    if (lastSignalAction !== signalKey) {
                        audioHooter.playSignal();
                        voiceNarrator.speak(`Protocol Ready. ${data.symbol} elite signal found. Action. ${data.recommendation.action}. Confluence high.`);
                        lastSignalAction = signalKey;
                        showToast(`PROTOCOL READY: ${data.recommendation.action} on ${data.symbol}`);
                    }
                }
            }

            // Institutional Heatmap (Gravity Engine)
            if (data.heatmap) {
                heatmapContainer.innerHTML = `
                    <div style="font-size: 0.6rem; color: var(--gold); margin-bottom: 5px; opacity: 0.8; letter-spacing: 1px;">
                        INSTITUTIONAL GRAVITY ENGINE
                    </div>
                `;
                const isFX = data.symbol.includes('=X') || data.symbol.includes('USD');
                const precision = isFX ? 4 : 2;
                
                data.heatmap.slice(0, 8).forEach(h => {
                    const div = document.createElement('div');
                    div.className = 'metric-item';
                    div.style.background = `linear-gradient(90deg, ${h.color} 0%, transparent ${h.gravity}%)`;
                    div.style.borderLeft = `3px solid ${h.color}`;
                    div.style.marginBottom = '6px';
                    div.style.padding = '4px 8px';
                    div.style.borderRadius = '2px';
                    
                    div.innerHTML = `
                        <div style="display:flex; justify-content:space-between; width:100%; align-items:center;">
                            <span style="font-weight:900; font-size:0.65rem; color:#fff;">${h.type}</span>
                            <span style="font-family:'JetBrains Mono'; font-weight:800; color:var(--gold);">$${h.price.toFixed(precision)}</span>
                            <div style="text-align:right;">
                                <span style="display:block; font-size:0.5rem; color:var(--text-dim);">GRAVITY</span>
                                <span style="font-weight:900; font-size:0.7rem; color:${h.gravity > 80 ? 'var(--bullish)' : '#fff'};">${h.gravity}%</span>
                            </div>
                        </div>
                    `;
                    heatmapContainer.appendChild(div);
                });
            }

            // Ticker
            if (data.news && data.news.length > 0) {
                const ticker = document.getElementById('ticker-content');
                if (ticker) ticker.innerText = data.news.map(n => ` GÇó ${n.text}`).join(' ');
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
                                <div style="display:flex; flex-direction:column;">
                                    <span class="sector-sym" style="font-size: ${displaySym.length > 4 ? '0.7rem' : '0.9rem'};">${displaySym}</span>
                                    <span class="sector-institutional-status" style="font-size: 0.45rem; font-weight: 800; color: var(--gold); margin-top: 2px;">NEUTRAL</span>
                                </div>
                                <div style="text-align:right;">
                                    <div class="sector-change" style="font-size: 0.7rem;">0.00%</div>
                                    <div class="sector-name" style="font-size: 0.5rem; color: var(--text-dim); opacity: 0.7;">${sObj.name}</div>
                                </div>
                            `;
                            grid.appendChild(div);
                        });
                    }

                    symbols.forEach(sym => {
                        const sData = data.sectors.find(s => s.symbol === sym) || (sym === 'UUP' ? { symbol: 'UUP', change: (data.bias?.internals?.dxyChange || 0) } : null);
                        const el = document.getElementById(`sector-${sym}-${suffix}`);
                        if (sData && el) {
                            const changeEl = el.querySelector('.sector-change');
                            const statusEl = el.querySelector('.sector-institutional-status');

                            if (changeEl) {
                                changeEl.innerText = `${sData.change >= 0 ? '+' : ''}${sData.change.toFixed(2)}%`;
                                changeEl.className = 'sector-change ' + (sData.change >= 0 ? 'bullish-text' : 'bearish-text');
                            }

                            if (statusEl) {
                                let status = "NEUTRAL";
                                let color = 'var(--text-dim)';

                                if (sData.judas) {
                                    status = "JUDAS TRAP";
                                    color = 'var(--bearish)';
                                } else if (sData.retail >= 75) {
                                    status = "RETAIL TRAP";
                                    color = 'var(--bearish)';
                                } else if (sData.retail <= 25 && sData.retail !== undefined) {
                                    status = "SHORT SQUEEZE";
                                    color = 'var(--bullish)';
                                } else if (sData.irScore >= 80) {
                                    status = "SMART MONEY";
                                    color = 'var(--bullish)';
                                } else if (sData.irScore <= 20) {
                                    status = "DISTRIBUTION";
                                    color = 'var(--bearish)';
                                } else {
                                    status = sData.bias || "NEUTRAL";
                                    color = status.includes('BULLISH') ? 'var(--bullish)' : (status.includes('BEARISH') ? 'var(--bearish)' : 'var(--text-dim)');
                                }

                                statusEl.innerText = status;
                                statusEl.style.color = color;
                            }

                            el.classList.remove('bullish', 'bearish');
                            if (sData.bias === 'BULLISH') el.classList.add('bullish');
                            else if (sData.bias === 'BEARISH') el.classList.add('bearish');
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

                    // Asia Range Display
                    if (data.bias && data.bias.asiaRange) {
                        const ar = data.bias.asiaRange;
                        if (asiaHighEl) asiaHighEl.innerText = ar.high.toFixed(precision);
                        if (asiaLowEl) asiaLowEl.innerText = ar.low.toFixed(precision);
                    }

                    if (data.bias && data.bias.cbdr) {
                        const c = data.bias.cbdr;
                        const bias = data.bias.bias;
                        // Projections depend on Bias
                        if (cbdrSd1El) cbdrSd1El.innerText = (bias === 'BULLISH' || bias === 'STRONG BULLISH') ? c.sd1_high.toFixed(precision) : c.sd1_low.toFixed(precision);
                        if (cbdrSd2El) cbdrSd2El.innerText = (bias === 'BULLISH' || bias === 'STRONG BULLISH') ? c.sd2_high.toFixed(precision) : c.sd2_low.toFixed(precision);
                    }
                }
            
                if (data.institutionalRadar) {
                    updateInstitutionalRadar(data);
                }
            }

            // --- MOBILE COMMANDER HUD SYNC ---
            const mobileSymbol = document.getElementById('mobile-hud-symbol');
            const mobilePrice = document.getElementById('mobile-hud-price');
            const mobileBias = document.getElementById('mobile-hud-bias');
            const mobileRec = document.getElementById('mobile-hud-rec');

            if (mobileSymbol) mobileSymbol.innerText = data.symbol || 'SPY';
            if (mobilePrice && data.currentPrice) {
                const isFX = data.symbol.includes('=X') || data.symbol.includes('USD');
                mobilePrice.innerText = `$${data.currentPrice.toFixed(isFX ? 4 : 2)}`;
            }
            if (mobileBias && data.bias) {
                mobileBias.innerText = data.bias.bias;
                mobileBias.className = 'hud-bias ' + (data.bias.bias === 'BULLISH' ? 'bullish-text' : data.bias.bias === 'BEARISH' ? 'bearish-text' : 'gold-text');
            }
            if (mobileRec && data.recommendation) {
                mobileRec.innerText = data.recommendation.action;
                mobileRec.className = 'hud-rec ' + (data.recommendation.action.includes('CALL') ? 'bullish-text' : data.recommendation.action.includes('PUT') ? 'bearish-text' : 'gold-text');
            }
        }
    } catch (err) {
        console.error("[UI] Error in updateUI:", err);
    }
}



function updateWatchlist(data) {
    const stocksList = document.getElementById('stocks-list');
    const forexList = document.getElementById('forex-list');
    const stocksCountEl = document.getElementById('stocks-count');
    const forexCountEl = document.getElementById('forex-count');
    
    if (!stocksList || !forexList) return;

    const wl = data.watchlist || [];

    // --- ALPHA SORTING: Rank by "GO" status, then Confluence Score ---
    wl.sort((a, b) => {
        const aReady = (a.recommendation?.action !== 'WAIT' && (a.confluenceScore || 0) >= 80 && a.recommendation?.isStable);
        const bReady = (b.recommendation?.action !== 'WAIT' && (b.confluenceScore || 0) >= 80 && b.recommendation?.isStable);

        if (bReady !== aReady) return bReady ? 1 : -1;
        
        if ((b.confluenceScore || 0) !== (a.confluenceScore || 0)) {
            return (b.confluenceScore || 0) - (a.confluenceScore || 0);
        }
        return Math.abs(b.dailyChangePercent || 0) - Math.abs(a.dailyChangePercent || 0);
    });

    stocksList.innerHTML = '';
    forexList.innerHTML = '';

    let stockCount = 0;
    let forexCount = 0;

    wl.forEach(stock => {
        try {
            if (!stock || !stock.symbol) return;

            const isFX = stock.symbol.includes('=X') || stock.symbol.includes('-USD') || stock.symbol.includes('/USD') || stock.symbol.includes('EUR') || stock.symbol.includes('GBP') || stock.symbol.includes('JPY');
            const targetList = isFX ? forexList : stocksList;
            if (isFX) forexCount++; else stockCount++;

            const price = typeof stock.price === 'number' ? stock.price : 0;
            const prevPrice = watchlistPrevPrices[stock.symbol];
            
            let pulseClass = '';
            if (prevPrice !== undefined && price !== prevPrice) {
                pulseClass = price > prevPrice ? 'pulse-up' : 'pulse-down';
            }
            watchlistPrevPrices[stock.symbol] = price;

            const rec = stock.recommendation || { action: 'WAIT' };
            const action = rec.action || 'WAIT';
            const actionClass = action.includes('CALL') ? 'bullish-text' : action.includes('PUT') ? 'bearish-text' : 'text-dim';

            const isReady = (action !== 'WAIT' && (stock.confluenceScore || 0) >= 80 && rec.isStable);
            const readyBadge = isReady ? '<span class="go-badge">GO</span>' : '';
            
            let alignBadge = '';
            if (stock.alignedCount >= 3) {
                const alignColor = (stock.bias && stock.bias.includes('BULLISH')) ? 'var(--bullish)' : 'var(--bearish)';
                alignBadge = `<span class="align-badge" style="background:${alignColor}22; border:1px solid ${alignColor}; color:${alignColor}; font-size:0.45rem; padding:1px 4px; border-radius:3px; margin-left:4px; font-weight:900;">${stock.alignedCount}TF</span>`;
            }

            const card = document.createElement('div');
            card.className = `ticker-card ${pulseClass} ${data.symbol === stock.symbol ? 'active-symbol' : ''} ${isReady ? 'ready-signal' : ''}`;
            card.setAttribute('data-symbol', stock.symbol);
            card.style.cursor = 'pointer';
            card.onclick = () => {
                socket.emit('switch_symbol', stock.symbol);
                if (typeof showToast === 'function') showToast(`Switching to ${stock.symbol}...`);
                card.style.transform = 'scale(0.98)';
                setTimeout(() => { card.style.transform = 'scale(1)'; }, 100);
            };

            const precision = isFX ? 4 : 2;
            const biasText = (stock.bias && stock.bias.bias) ? stock.bias.bias : (stock.bias || 'NEUTRAL');
            const biasClass = biasText.includes('BULLISH') ? 'bullish-text' : biasText.includes('BEARISH') ? 'bearish-text' : '';
            const source = stock.dataSource || 'FHUB';

            card.innerHTML = `
                <div class="ticker-info">
                    <span class="ticker-sym">${stock.symbol} ${readyBadge} ${alignBadge} <span class="source-badge">${source}</span></span>
                    <span class="ticker-price">$${price.toFixed(precision)}</span>
                </div>
                <div class="ticker-metrics">
                    <div style="display:flex; flex-direction:column; align-items:flex-end; gap:2px;">
                        <span class="ticker-bias ${biasClass}">${biasText}</span>
                        <span style="font-size:0.55rem; font-weight:900; color:${stock.confluenceScore >= 75 ? 'var(--bullish)' : 'var(--text-dim)'};">${stock.confluenceScore || 0}% CONF</span>
                    </div>
                    <span class="ticker-signal ${actionClass} ${action !== 'WAIT' ? 'pulse-subtle' : ''}">${action}</span>
                </div>
                <div class="ticker-meta">
                    <span style="color:${(stock.dailyChangePercent || 0) >= 0 ? 'var(--bullish)' : 'var(--bearish)'};">${(stock.dailyChangePercent || 0) >= 0 ? '+' : ''}${(stock.dailyChangePercent || 0).toFixed(2)}%</span>
                    <span style="color:var(--text-dim); font-size: 0.5rem;">${stock.adr ? 'ADR: ' + stock.adr.toFixed(2) : ''}</span>
                </div>
            `;

            card.onclick = () => {
                socket.emit('switch_symbol', stock.symbol);
                document.querySelectorAll('.ticker-card').forEach(c => c.classList.remove('active-symbol'));
                card.classList.add('active-symbol');
            };

            targetList.appendChild(card);

            if (pulseClass) {
                setTimeout(() => card.classList.remove(pulseClass), 800);
            }
        } catch (err) {
            console.error(`[UI] Error rendering symbol ${stock?.symbol}:`, err);
        }
    });

    if (stocksCountEl) stocksCountEl.innerText = `${stockCount} TICKERS`;
    if (forexCountEl) forexCountEl.innerText = `${forexCount} TICKERS`;
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
    toast.className = 'toast-alert';
    toast.style.background = 'rgba(15, 23, 42, 0.9)';
    toast.style.color = '#fff';
    toast.style.padding = '12px 20px';
    toast.style.borderRadius = '12px';
    toast.style.borderLeft = '4px solid var(--accent)';
    toast.style.marginBottom = '10px';
    toast.style.fontSize = '0.8rem';
    toast.style.fontWeight = '700';
    toast.innerText = msg;
    const toastContainer = document.getElementById('toast-container');
    if (toastContainer) toastContainer.appendChild(toast);
    setTimeout(() => toast.remove(), 5000);
}

function updateVixGauge(vix) {
    const vixNeedle = document.getElementById('vix-needle');
    if (!vixNeedle) return;
    const minVix = 10;
    const maxVix = 40;
    const clampedVix = Math.max(minVix, Math.min(maxVix, vix));
    const rotation = ((clampedVix - minVix) / (maxVix - minVix) * 180) - 90;
    vixNeedle.style.transform = `translateX(-50%) rotate(${rotation}deg)`;
}

const mobileTriggerBtn = document.getElementById('mobile-trigger-btn');
const openChecklist = () => {
    const checklistModal = document.getElementById('checklist-modal');
    if (!checklistModal) return;
    checklistModal.style.display = 'flex';
    document.querySelectorAll('.trigger-check').forEach(c => c.checked = false);
    const btnConfirmTrade = document.getElementById('btn-confirm-trade');
    if (btnConfirmTrade) btnConfirmTrade.disabled = true;
};

document.getElementById('btn-unlock-signal')?.addEventListener('click', openChecklist);
mobileTriggerBtn?.addEventListener('click', openChecklist);
document.getElementById('btn-close-checklist')?.addEventListener('click', () => { 
    const checklistModal = document.getElementById('checklist-modal');
    if (checklistModal) checklistModal.style.display = 'none'; 
});

document.querySelectorAll('.trigger-check').forEach(check => {
    check.addEventListener('change', () => {
        const allChecked = Array.from(document.querySelectorAll('.trigger-check')).every(c => c.checked);
        const btnConfirmTrade = document.getElementById('btn-confirm-trade');
        if (btnConfirmTrade) btnConfirmTrade.disabled = !allChecked;
    });
});

document.getElementById('btn-confirm-trade')?.addEventListener('click', () => {
    signalUnlocked = true;
    const checklistModal = document.getElementById('checklist-modal');
    if (checklistModal) checklistModal.style.display = 'none';
    const btnUnlockSignal = document.getElementById('btn-unlock-signal');
    if (btnUnlockSignal) btnUnlockSignal.style.display = 'none';
    showToast("PROTOCOL READY: TRIGGERS CONFIRMED");
    if (pendingSignalData) updateUI(pendingSignalData);
});

function openStudyGuide(cardType) {
    const data = STUDY_GUIDE_CONTENT[cardType];
    const studyGuideModal = document.getElementById('study-guide-modal');
    const guideTitle = document.getElementById('guide-title');
    const guideBody = document.getElementById('guide-body');
    if (!data || !studyGuideModal || !guideTitle || !guideBody) return;
    guideTitle.innerText = data.title;
    guideBody.innerHTML = data.steps.map((step, idx) => `
        <section class="handbook-step">
            <h3><span class="step-num">${idx + 1}</span> ${step.h}</h3>
            <p>${step.p}</p>
        </section>
    `).join('');
    studyGuideModal.style.display = 'flex';
    document.body.style.overflow = 'hidden';
}

function closeStudyGuide() {
    const studyGuideModal = document.getElementById('study-guide-modal');
    if (studyGuideModal) {
        studyGuideModal.style.display = 'none';
        document.body.style.overflow = 'auto';
    }
}

document.getElementById('btn-close-guide')?.addEventListener('click', closeStudyGuide);
document.getElementById('btn-close-guide-footer')?.addEventListener('click', closeStudyGuide);
document.getElementById('study-guide-modal')?.addEventListener('click', (e) => { 
    const studyGuideModal = document.getElementById('study-guide-modal');
    if (e.target === studyGuideModal) closeStudyGuide(); 
});

document.getElementById('btn-open-handbook')?.addEventListener('click', () => { openStudyGuide('bias'); });

// --- INSTITUTIONAL INTELLIGENCE TICKER LOGIC ---
const intelTicker = document.getElementById('intel-ticker');
let intelHistory = ["SYSTEM STABLE: MONITORING DARK POOL FLOW", "ALGO READY: IR-REALITY ENGINE LOADED"];

function updateIntelTicker(data) {
    if (!intelTicker) return;

    const insights = [];
    const v = data.bias?.internals?.vix || 15;
    const d = data.bias?.internals?.dxy || 104;

    // Macro Logic
    if (v > 20) insights.push("<span class='highlight'>VOLATILITY ELEVATED:</span> INSTITUTIONAL LAYERING DETECTED");
    if (d > 104.5) insights.push("<span class='highlight'>DXY STRENGTH:</span> EQUITIES PRESSURED BY DOLLAR DYNAMICS");
    
    // IR Reality Check
    const bullCount = Object.values(data.multiTfBias || {}).filter(b => b.includes('BULLISH')).length;
    const bearCount = Object.values(data.multiTfBias || {}).filter(b => b.includes('BEARISH')).length;
    if (Math.max(bullCount, bearCount) >= 3) {
        insights.push(`<span class='critical'>IR-ALIGNMENT:</span> ${data.symbol} TRIGGERING MULTI-TIMEFRAME CONFLUENCE`);
    }

    // Whale Tape
    if (data.markers?.netWhaleFlow > 5000000) insights.push("<span class='critical'>WHALE BLOCK:</span> SIGNIFICANT INSTITUTIONAL ACCUMULATION IN PROGRESS");

    if (insights.length > 0) {
        // Add new unique insight
        insights.forEach(msg => {
            if (!intelHistory.includes(msg)) {
                intelHistory.unshift(msg);
                if (intelHistory.length > 5) intelHistory.pop();
            }
        });
        
        intelTicker.innerHTML = intelHistory.map(msg => `<span>${msg}</span>`).join(' &nbsp; | &nbsp; ');
    }
}

function updateSpiderMatrix(data) {
    const grid = document.getElementById('spider-grid');
    const status = document.getElementById('basket-alignment');
    if (!grid || !data.basket) return;

    const basket = data.basket;
    
    Object.keys(basket).forEach(cur => {
        const node = grid.querySelector(`[data-cur="${cur}"]`);
        if (node) {
            const valEl = node.querySelector('.val');
            const perf = basket[cur].perf || 0;
            
            valEl.innerText = (perf >= 0 ? '+' : '') + perf.toFixed(2) + '%';
            
            // Color Coding Logic
            if (perf > 0) {
                valEl.style.color = 'var(--bullish)';
                node.style.background = 'rgba(16, 185, 129, 0.05)';
            } else if (perf < 0) {
                valEl.style.color = 'var(--bearish)';
                node.style.background = 'rgba(244, 63, 94, 0.05)';
            } else {
                valEl.style.color = 'var(--text-dim)';
                node.style.background = 'rgba(255, 255, 255, 0.02)';
            }
            
            // Institutional Shift Highlight
            const isMegaMove = Math.abs(perf) > 0.45;
            node.style.borderColor = isMegaMove ? 'var(--gold)' : 'rgba(255, 255, 255, 0.05)';
            node.style.boxShadow = isMegaMove ? '0 0 15px rgba(212, 175, 55, 0.15)' : 'none';
        }
    });

    if (status) {
        const isAligned = data.isBasketAligned;
        status.innerText = isAligned ? 'BASKET: ALIGNED' : 'BASKET: DISCORDANT';
        status.style.color = isAligned ? 'var(--gold)' : 'var(--bearish)';
    }
}
