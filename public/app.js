const socket = io();
let watchlistPrevPrices = {}; // Tracks previous prices to trigger pulses

// Supabase Auth Integration
let supabaseClient;
const loginOverlay = document.getElementById('login-overlay');
const logoutBtn = document.getElementById('logout-btn');
const googleLoginBtn = document.getElementById('google-login-btn');

async function initAuth() {
    // SUPPRESS: Clock Sync for Institutional Terminal
    setInterval(() => {
        const nyClock = document.getElementById('ny-clock');
        if (nyClock) {
            nyClock.innerText = new Date().toLocaleTimeString('en-US', { 
                timeZone: 'America/New_York', 
                hour12: false, 
                hour: '2-digit', 
                minute: '2-digit', 
                second: '2-digit' 
            }) + ' EST';
        }
    }, 1000);

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

        if (!session && !window.location.pathname.includes('landing') && !isLocalhost) {
            if (loginOverlay) loginOverlay.style.display = 'flex';
            if (logoutBtn) logoutBtn.style.display = 'none';
        } else if (session) {
            if (loginOverlay) loginOverlay.style.display = 'none';
            if (logoutBtn) logoutBtn.style.display = 'block';
        }

        supabaseClient.auth.onAuthStateChange((event, session) => {
            if (event === 'SIGNED_IN') {
                if (loginOverlay) loginOverlay.style.display = 'none';
                if (logoutBtn) logoutBtn.style.display = 'block';
            } else if (session === null && !isLocalhost) {
                if (loginOverlay) loginOverlay.style.display = 'flex';
                if (logoutBtn) logoutBtn.style.display = 'none';
            }
        });

        if (logoutBtn) {
            logoutBtn.onclick = async () => {
                await supabaseClient.auth.signOut();
                window.location.reload();
            };
        }

        if (googleLoginBtn) {
            googleLoginBtn.onclick = async () => {
                const redirectUrl = window.location.origin + '/terminal.html';
                await supabaseClient.auth.signInWithOAuth({
                    provider: 'google',
                    options: { redirectTo: redirectUrl }
                });
            };
        }
    } catch (e) {
        console.error("[AUTH] Error initializing identity service:", e);
    }
}
initAuth();

// Real-time Event Listeners
socket.on('whale_alert', (block) => {
    if (typeof audioHooter !== 'undefined' && audioHooter.playWhale) audioHooter.playWhale();
    showToast(`🐋 WHALE ALERT: ${block.symbol} | $${(block.value / 1000000).toFixed(2)}M Block!`);
    const card = document.querySelector('.sidebar section:nth-child(4)');
    if (card) {
        card.classList.add('whale-flash');
        setTimeout(() => card.classList.remove('whale-flash'), 5000);
    }
});

socket.on('holy_grail', (data) => {
    showToast(`🔥 HOLY GRAIL SIGNAL: ${data.symbol} 🔥`, 'toast-grail');
    if (typeof voiceNarrator !== 'undefined' && voiceNarrator.speak) voiceNarrator.speak(`Alert. Holy Grail signal detected on ${data.symbol}. All engines aligned.`);
});

socket.on('news_update', (data) => {
    const newsEl = document.getElementById('news-ticker-render');
    if (newsEl && data.news && data.news.length > 0) {
        newsEl.innerText = data.news.map(n => `[${n.source}] ${n.title}`).join(' • ');
    }
});

socket.on('smt_alert', (data) => {
    data.alerts.forEach(alert => {
        showToast(`⚖️ SMT DIVERGENCE: ${alert.symbols[0]}/${alert.symbols[1]} | ${alert.message}`, 'toast-smt');
        if (typeof voiceNarrator !== 'undefined' && voiceNarrator.speak) {
            voiceNarrator.speak(`Caution. SMT Divergence detected between ${alert.symbols[0]} and ${alert.symbols[1]}. Institutional divergence confirmed.`);
        }
    });
});

socket.on('scalper_pulse', (updData) => {
    const list = document.getElementById('scalper-scan-list');
    if (!list || !updData.updates) return;
    updData.updates.forEach(upd => {
        const isReload = upd.isReload;
        const isHighConviction = upd.isHighConviction || upd.alignedCount >= 3;
        let styleStr = `padding: 0.6rem; border-bottom: 2px solid rgba(255,255,255,0.03); display: flex; justify-content: space-between; align-items: center; border-left: 3px solid ${upd.color}; transition: all 0.3s ease;`;
        
        if (isReload) styleStr += ' background: rgba(16, 185, 129, 0.12); border: 1px solid rgba(16, 185, 129, 0.4); animation: pulse-opacity 1s infinite alternate;';
        if (isHighConviction) styleStr += ' border-right: 3px solid #ff9d00; box-shadow: inset 0 0 10px rgba(255,157,0,0.1);';

        if (existing) {
            const velEl = existing.querySelector('.velocity-val');
            const sigEl = existing.querySelector('.signal-val');
            if (velEl) { velEl.innerText = 'VEL: ' + upd.velocity; velEl.style.color = upd.color; }
            if (sigEl) { 
                sigEl.innerText = upd.signal; 
                sigEl.style.color = (isHighConviction || isReload) ? (isReload ? 'var(--bullish)' : 'var(--gold)') : '#94a3b8';
            }
            existing.style.cssText = styleStr;
            return;
        }
        const row = document.createElement('div');
        row.id = 'scan-' + upd.symbol;
        row.style.cssText = styleStr;
        row.onclick = () => { socket.emit('switch_symbol', upd.symbol); };
        
        const leftDiv = document.createElement('div');
        const symDiv = document.createElement('div');
        symDiv.style.cssText = 'font-size: 0.75rem; font-weight: 950; color: #fff; letter-spacing: 0.5px;';
        symDiv.innerText = upd.symbol;
        if (isHighConviction) symDiv.innerHTML += ' <span style="color:var(--gold); font-size:0.55rem;">⚡</span>';
        if (isReload) symDiv.innerHTML += ' <span style="color:var(--bullish); font-size:0.45rem; background:rgba(0,0,0,0.4); padding: 1px 4px; border-radius: 2px;">RELOADING</span>';
        
        const sigDiv = document.createElement('div');
        sigDiv.className = 'signal-val';
        sigDiv.style.cssText = 'font-size: 0.5rem; color: ' + (isHighConviction ? 'var(--gold)' : (isReload ? 'var(--bullish)' : '#94a3b8')) + '; font-weight: 700;';
        sigDiv.innerText = upd.signal;
        leftDiv.appendChild(symDiv); leftDiv.appendChild(sigDiv);
        const rightDiv = document.createElement('div');
        rightDiv.style.textAlign = 'right';
        const velDiv = document.createElement('div');
        velDiv.className = 'velocity-val';
        velDiv.style.cssText = 'font-size: 0.6rem; font-weight: 950; color: ' + upd.color;
        velDiv.innerText = 'VEL: ' + upd.velocity;
        const liveDiv = document.createElement('div');
        liveDiv.style.cssText = 'font-size: 0.45rem; color: #94a3b8; font-weight: 800;';
        liveDiv.innerText = isReload ? 'RELOADING...' : 'LIVE';
        rightDiv.appendChild(velDiv); rightDiv.appendChild(liveDiv);
        row.appendChild(leftDiv); row.appendChild(rightDiv);
        if (list.firstChild && list.firstChild.innerText && list.firstChild.innerText.includes('INITIALIZING')) { list.innerHTML = ''; }
        list.prepend(row);
        if (list.children.length > 8) list.removeChild(list.lastChild);
    });
});

// DOM pointers
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
const expectedRangeEl = document.getElementById('expected-range-val');

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
    playTrap() {
        this.play(220, 'square', 0.2, 0.1);
        setTimeout(() => this.play(110, 'square', 0.4, 0.15), 200);
    }
    playFireSignal() {
        this.play(660, 'sawtooth', 0.1, 0.1);
        setTimeout(() => this.play(880, 'sawtooth', 0.15, 0.12), 100);
        setTimeout(() => this.play(1100, 'sawtooth', 0.2, 0.15), 200);
    }
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
    speakTrap(symbol, type) {
        this.speak(`CAUTION. ${type.replace('_',' ')} DETECTED ON ${symbol.replace('=X','')}. INSTITUTIONAL TRAP IN PROGRESS.`);
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
let lastInstitutionalData = null;
let lastAIInsight = "";
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
        localization: {
            timeZone: 'America/New_York', // Institutional Standard: NY Time
            priceFormatter: p => p > 1000 ? p.toFixed(2) : p.toFixed(4)
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
            rightOffset: 25, // Institutional Buffer: Give the price room to breathe
            minBarSpacing: 0.5,
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
    if (!candleSeries || !candles || candles.length === 0) return;
    try {
        const formatted = candles.map(c => {
            // Support both raw server candles and pre-enriched client candles
            const time = c.time || Math.floor(Number(c.timestamp) / 1000);
            if (!time || isNaN(time)) return null;

            return {
                time: time,
                open: Number(c.open),
                high: Number(c.high),
                low: Number(c.low),
                close: Number(c.close),
                // Preserve institutional shading from server
                color: c.color,
                wickColor: c.wickColor || c.color,
                borderColor: c.borderColor || c.color
            };
        }).filter(c => c !== null && c.open > 0)
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

let expectedMoveLines = [];
function updateExpectedMoveLines(expectedMove) {
    if (!candleSeries || !expectedMove || !expectedMove.upper) return;

    // Clear existing
    expectedMoveLines.forEach(l => candleSeries.removePriceLine(l));
    expectedMoveLines = [];

    const upperLine = candleSeries.createPriceLine({
        price: expectedMove.upper,
        color: 'rgba(244, 63, 94, 0.6)',
        lineWidth: 2,
        lineStyle: 1, // Dashed
        axisLabelVisible: true,
        title: 'EXPECTED HIGH (68%)',
    });

    const lowerLine = candleSeries.createPriceLine({
        price: expectedMove.lower,
        color: 'rgba(16, 185, 129, 0.6)',
        lineWidth: 2,
        lineStyle: 1, // Dashed
        axisLabelVisible: true,
        title: 'EXPECTED LOW (68%)',
    });

    expectedMoveLines.push(upperLine, lowerLine);
}
function updateInstitutionalRadar(data) {
    // Heartbeat Sync Flash (Proof of Work)
    const pulseServerSync = document.getElementById('pulse-server-sync');
    if (pulseServerSync) {
        pulseServerSync.style.opacity = 1;
        setTimeout(() => { pulseServerSync.style.opacity = 0; }, 500);
    }

    const dxyAnchorBadge = document.getElementById('dxy-anchor-badge');
    if (dxyAnchorBadge && data.markers?.dxy) {
        try {
            dxyAnchorBadge.innerText = `DXY ANCHOR: ${data.markers.dxy.toFixed(2)}`;
            dxyAnchorBadge.style.color = data.markers.dxy > 103.5 ? 'var(--bearish)' : 'var(--bullish)';
        } catch(e) {}
    }

    const hudDxy = document.getElementById('hud-dxy-status');
    const hudSmt = document.getElementById('hud-smt-status');
    if (hudDxy) hudDxy.querySelector('.val').innerText = (data.markers?.dxy || 0).toFixed(2);
    if (hudSmt) hudSmt.querySelector('.val').innerText = data.institutionalRadar?.smt ? data.institutionalRadar.smt.type : 'STABLE';
    
    const radar = data.markers?.radar || data.institutionalRadar || {};
    const bias = data.bias || {};

    const radarIrScore = document.getElementById('radar-ir-score');
    const radarSessionName = document.getElementById('radar-session-name');
    const radarSessionTimer = document.getElementById('radar-session-timer');
    const radarRealityText = document.getElementById('radar-reality-text');
    const radarSmtStatus = document.getElementById('radar-smt-status');
    const radarGammaStatus = document.getElementById('radar-gamma-status');

    // 0. Pyth Precision Meter (Improvement 1)
    const confBar = document.getElementById('confidence-bar');
    const confGlow = document.getElementById('confidence-glow');
    if (confBar && data.priceDiscordance !== undefined) {
        const disc = data.priceDiscordance; // BPS
        const precision = Math.max(5, 100 - (disc * 2.5)); // 0 bps = 100%, 40 bps = 0%
        confBar.style.width = `${precision}%`;
        
        if (precision < 50) {
            confBar.style.background = 'var(--bearish)';
            confBar.style.boxShadow = '0 0 15px var(--bearish)';
            confGlow?.classList.add('confidence-glow-red');
        } else {
            confBar.style.background = 'var(--bullish)';
            confBar.style.boxShadow = '0 0 10px var(--bullish)';
            confGlow?.classList.remove('confidence-glow-red');
        }
    }

    const radarSessionBox = document.getElementById('radar-session-box');
    const po3 = data.po3 || data.markers?.radar?.po3;
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
    if (radarIrScore && radar) {
        try {
            const score = Math.round(radar.irScore || 0);
            radarIrScore.innerText = score.toString().padStart(2, '0');
            radarIrScore.style.color = score > 75 ? 'var(--bullish)' : (score < 40 ? 'var(--bearish)' : '#fff');
        } catch(e) {}
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
        const currentBias = bias.bias || 'NEUTRAL';
        radarRealityText.style.borderLeftColor = currentBias.includes('BULLISH') ? 'var(--bullish)' : (currentBias.includes('BEARISH') ? 'var(--bearish)' : 'var(--gold)');
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
            const oldSignal = scalperResult.innerText;
            const newSignal = data.scalpScan.signal;
            scalperResult.innerText = newSignal;
            scalperResult.style.color = data.scalpScan.color;

            // --- ELITE ALARMS ---
            if (newSignal !== oldSignal && newSignal !== 'SEARCHING...') {
                if (data.scalpScan.isFire) {
                    audioHooter.playFireSignal();
                    if (voiceNarrator.enabled) voiceNarrator.speak(`${data.symbol.replace('=X','')} FIRE BREAKOUT DETECTED. HIGH VELOCITY.`);
                    scalperOverlay.classList.add('fire-pulse');
                    showToast(`🔥 FIRE DETECTED: ${data.symbol.replace('=X','')}`, "BULLISH");
                } else if (data.scalpScan.isReload) {
                    audioHooter.playSignal();
                    if (voiceNarrator.enabled) voiceNarrator.speak(`${data.symbol.replace('=X','')} INSTITUTIONAL RELOAD.`);
                    scalperOverlay.classList.add('reload-glow');
                    showToast(`♻️ RELOAD DETECTED: ${data.symbol.replace('=X','')}`, "BULLISH");
                }
                setTimeout(() => {
                    scalperOverlay.classList.remove('fire-pulse', 'reload-glow');
                }, 3000);
            }
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
    // Weights: 100 = Thickest/Most Important
    addLevel(m.midnightOpen, '#38bdf8', 1, 'MID OPEN', 100);
    addLevel(m.nyOpen, '#10b981', 1, 'NY OPEN', 90);
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

    // --- INSTITUTIONAL HEATMAP & DARK POOL POC ---
    if (data.heatmap) {
        data.heatmap.forEach(zone => {
            if (zone.strength > 60) {
                addLevel(zone.price, zone.color, zone.type === 'VOLUME_POC' ? 0 : 1, zone.label, zone.strength);
            }
        });
    }

    // --- DARK POOL VOLUME PROFILE (HIGH ACCUMULATION ZONES) ---
    if (data.volumeProfile) {
        data.volumeProfile.forEach(p => {
            if (p.intensity > 70 && !p.isPOC) {
                addLevel(p.price, 'rgba(255, 255, 255, 0.03)', 2, '', 5);
            }
        });
    }

    // --- 0DTE EXPECTED MOVE OVERLAY (INSTITUTIONAL RANGE) ---
    if (data.expectedMove) {
        addLevel(data.expectedMove.upper, 'rgba(245, 158, 11, 0.6)', 1, '0DTE EXPECTED UPPER', 25);
        addLevel(data.expectedMove.lower, 'rgba(245, 158, 11, 0.6)', 1, '0DTE EXPECTED LOWER', 25);
    }

    // --- INSTITUTIONAL DARK POOL FOOTPRINTS (PERSISTENT CLUSTERS) ---
    if (data.darkPoolFootprints) {
        data.darkPoolFootprints.forEach(fp => {
            addLevel(fp.price, fp.color, 0, fp.label, fp.weight);
        });
    }

    // --- INSTITUTIONAL ORDER FLOW HEATMAP (DOM) ---
    if (data.orderFlowDOM) {
        data.orderFlowDOM.forEach(dom => {
            addLevel(dom.price, dom.color, 0, '', 5);
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
            lineWidth: (lvl.weight && lvl.weight >= 90) ? 2 : 1,
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

    // 5. LIQUIDATION SWEEP MARKERS
    if (data.markers && data.markers.sweeps) {
        data.markers.sweeps.forEach(s => {
            allMarkers.push({
                time: Math.floor(s.timestamp / 1000),
                position: s.type === 'BULLISH' ? 'belowBar' : 'aboveBar',
                color: s.type === 'BULLISH' ? 'var(--bullish)' : 'var(--bearish)',
                shape: s.type === 'BULLISH' ? 'arrowUp' : 'arrowDown',
                text: s.type === 'BULLISH' ? 'SWEEP (L)' : 'SWEEP (S)',
                size: 2
            });
        });
    }

    if (allMarkers.length > 0) {
        candleSeries.setMarkers(allMarkers.sort((a,b) => a.time - b.time));
    }
}


socket.on('init', (data) => {
    console.log(`[SOCKET] Received init for ${data.symbol}`);
    if (candleSeries) candleSeries.setData([]);
    setChartData(data.candles || []);
    updateUI(data);
    if (data.watchlist) updateWatchlist(data);

    if ((!data.candles || data.candles.length === 0) && data.timeframe === '1m') {
        socket.emit('switch_timeframe', '5m');
    }
});

socket.on('symbol_updated', (data) => {
    console.log(`[SOCKET] Symbol Updated: ${data.symbol}`);
    if (data.candles && data.candles.length > 0) {
        if (candleSeries) candleSeries.setData([]); 
        setChartData(data.candles);
    }
    updateUI(data);
    if (data.watchlist) updateWatchlist(data);
});

socket.on('update', (data) => {
    updateUI(data);
    if (data.watchlist) updateWatchlist(data);
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
        if (lastCandle.time != null && lastCandle.open != null) {
            try {
                candleSeries.update({
                    time: lastCandle.time,
                    open: Number(lastCandle.open),
                    high: Number(lastCandle.high),
                    low: Number(lastCandle.low),
                    close: Number(lastCandle.close),
                    color: lastCandle.color,
                    wickColor: lastCandle.wickColor,
                    borderColor: lastCandle.borderColor
                });
            } catch (e) {
                console.warn("[CHART] Update skipped:", lastCandle.time);
            }
        }

        // --- INSTITUTIONAL SMT MARKERS ---
        const radar = data.institutionalRadar || {};
        if (radar.smt) {
            const markers = [{
                time: lastCandle.time,
                position: radar.smt.type.includes('BEARISH') ? 'aboveBar' : 'belowBar',
                color: 'var(--gold)',
                shape: radar.smt.type.includes('BEARISH') ? 'arrowDown' : 'arrowUp',
                text: 'SMT'
            }];
            candleSeries.setMarkers(markers);
        } else {
            candleSeries.setMarkers([]);
        }
    }
});

socket.on('price_updated', (data) => {
    if (data.isBatch && Array.isArray(data.updates)) {
        data.updates.forEach(upd => {
            if (typeof updateMarketTicker === 'function') updateMarketTicker(upd);
        });
    } else {
        if (typeof updateMarketTicker === 'function') updateMarketTicker(data);
    }
});

socket.on('price_update', (data) => {
    if (typeof updateUI === 'function') updateUI(data);
});

socket.on('tf_updated', (data) => {
    console.log(`[SOCKET] TF Updated: ${data.timeframe}, candles: ${data.candles?.length}`);
    if (candleSeries && data.candles && data.candles.length > 0) {
        // Only clear and reset if we have new data to show
        candleSeries.setData([]);
        setChartData(data.candles);
        
        setTimeout(() => { 
            if (tvChart) {
                tvChart.timeScale().fitContent();
                tvChart.timeScale().scrollToRealTime();
            }
        }, 200);
    } else {
        // If no data yet, don't clear the chart, just show a notification
        if (typeof showToast === 'function') showToast(`Syncing ${data.timeframe} data...`, 'warning');
    }
    updateUI(data);
    if (data.watchlist) updateWatchlist(data);
});

socket.on('gold_alert', (a) => {
    if (typeof showToast === 'function') {
        showToast(`🥇 GOLD STANDARD: ${a.symbol} ${a.bias} SET-UP (${a.score}%)`, 'toast-gold');
    }
});

function updateUI(data) {
    if (!data) return;
    window.latestInstitutionalData = data; // Global store for execution guard (Improvement 3)
    try {
        const symbol = data.symbol || 'SPY';
        const isFX = symbol.includes('=X') || symbol.includes('USD');
        const precision = isFX ? 4 : 2;

        // 1. --- MAIN HUD UPDATES ---
        const priceEl = document.getElementById('current-price');
        const changeEl = document.getElementById('price-change');
        const confluenceScoreEl = document.getElementById('master-confluence-score');
        const symbolDisplay = document.getElementById('symbol-display');
        const expectedRangeEl = document.getElementById('expected-range-val');

        if (priceEl) {
            const price = data.currentPrice || data.price || 0;
            priceEl.innerText = price > 0 ? price.toFixed(precision) : 'SYNCING...';
            
            // 1a. --- SUB-SECOND TICK FLASH ---
            if (typeof lastPrice !== 'undefined' && lastPrice !== price && price > 0) {
                const container = priceEl.parentElement;
                container.classList.remove('flash-up', 'flash-down');
                void container.offsetWidth; 
                container.classList.add(price > lastPrice ? 'flash-up' : 'flash-down');
            }

            // 1b. --- DXY CORRELATION GLOW ---
            const dxyFlash = (data.markers?.dxy || 0) - (data.markers?.dxyPrev || data.markers?.dxy || 0);
            const priceContainer = priceEl.parentElement;
            if (priceContainer && Math.abs(dxyFlash) > 0.001) {
                priceContainer.classList.remove('dxy-glow-bull', 'dxy-glow-bear');
                void priceContainer.offsetWidth; 
                const glowClass = dxyFlash > 0 ? 'dxy-glow-bear' : 'dxy-glow-bull';
                priceContainer.classList.add(glowClass);
            }
            
            window.lastPrice = price;
        }

        if (changeEl) {
            const dc = data.dailyChangePercent !== undefined ? data.dailyChangePercent : (data.priceChange || 0);
            changeEl.innerText = `${dc >= 0 ? '+' : ''}${dc.toFixed(2)}%`;
            changeEl.className = 'main-change ' + (dc >= 0 ? 'bullish-text' : 'bearish-text');
        }

        if (confluenceScoreEl) {
            const score = Math.round(data.confluenceScore || 0);
            confluenceScoreEl.innerText = `${score}%`;
            confluenceScoreEl.style.color = score >= 70 ? 'var(--bullish)' : (score <= 30 ? 'var(--bearish)' : 'var(--gold)');
        }
        if (symbolDisplay) symbolDisplay.innerText = symbol;

        // --- INSTITUTIONAL EXPECTED MOVE OVERLAY ---
        if (data.expectedMove) {
             updateExpectedMoveLines(data.expectedMove);
             if (expectedRangeEl) {
                 expectedRangeEl.innerText = `$${data.expectedMove.lower.toFixed(2)} - $${data.expectedMove.upper.toFixed(2)}`;
             }
        }

        // --- SUB-SECOND CANDLE SYNC (TOS-STYLE PERFORMANCE) ---
        // Ensure the active candle breathes with the market in real-time
        if (data.candle && candleSeries) {
            try {
                const c = data.candle;
                const time = c.time || Math.floor(Number(c.timestamp) / 1000);
                if (time && !isNaN(time)) {
                    // UNIFIED: Candle updates are now handled in a single high-precision pass below.
                }
            } catch (e) {
                console.warn("[CHART] Failed to identify live tick context:", e);
            }
        }

        // 2. --- INSTITUTIONAL RADAR & BIAS ---
        const radar = data.markers?.radar || data.institutionalRadar || {};
        const radarIrScore = document.getElementById('radar-ir-score');
        const radarSessionName = document.getElementById('radar-session-name');
        const radarSessionTimer = document.getElementById('radar-session-timer');
        const radarRealityText = document.getElementById('radar-reality-text');

        // --- NEW: AI ANALYST (STRATEGIST FEED) SYNC ---
        if (data.aiInsight) updateAIAnalyst(data.aiInsight);

        if (radarIrScore) {
            const score = Math.round(radar.irScore || 0);
            radarIrScore.innerText = score.toString().padStart(2, '0');
            radarIrScore.style.color = score >= 60 ? 'var(--bullish)' : (score <= 40 ? 'var(--bearish)' : '#fff');
        }

        if (radarSessionName) {
            const kz = radar.killzone || { active: false, name: 'OFF-HOURS' };
            radarSessionName.innerText = (kz.name || 'OFF-HOURS').replace('_', ' ');
            radarSessionName.style.color = kz.active ? 'var(--gold)' : 'var(--text-dim)';
            if (radarSessionTimer) radarSessionTimer.innerText = kz.active ? 'VOLATILITY ACTIVE' : 'NO VOLATILITY';
        }

        const biasData = data.bias || {};
        const biasLabel = document.getElementById('bias-label');
        if (biasLabel) {
            const b = biasData.bias || 'NEUTRAL';
            biasLabel.innerText = b;
            biasLabel.className = 'bias-large ' + (b.includes('BULLISH') ? 'bullish-text' : b.includes('BEARISH') ? 'bearish-text' : '');
        }

        if (radarRealityText) {
            radarRealityText.innerText = biasData.narrative || 'Synchronizing institutional pulse...';
            const b = biasData.bias || '';
            radarRealityText.style.borderLeftColor = b.includes('BULLISH') ? 'var(--bullish)' : (b.includes('BEARISH') ? 'var(--bearish)' : '#94a3b8');
        }

        if (expectedRangeEl && data.expectedMove) {
            expectedRangeEl.innerText = `±$${data.expectedMove.range.toFixed(2)}`;
        }

        const b = biasData;
        const m = data.markers || {};
        const radar_active = m.radar || data.institutionalRadar || {};
        
        const toggleBadge = (id, show, text) => {
            const el = document.getElementById(id);
            if (el) {
                el.style.display = show ? 'block' : 'none';
                if (show && text) el.innerText = text;
            }
        };

        toggleBadge('amd-hud', true, radar_active.po3?.phase || b.amdPhase || 'ACCUMULATION');
        toggleBadge('mss-badge', b.mss, 'MSS SHIFT');
        toggleBadge('trap-badge', b.sweepDetected || b.trap || b.judas, '🔥 BEAR TRAP');
        toggleBadge('smt-badge', m.radar?.smt || radar_active.smt, 'SMT DIVERGENCE');
        toggleBadge('fvg-badge', b.fvg, 'BEARISH FVG');
        toggleBadge('absorption-badge', data.absorption?.detected, 'ABSORPTION');
        toggleBadge('squeeze-badge', m.vixStdev > 1.2, 'VOLATILITY SQUEEZE');
        
        const intermarket = document.getElementById('intermarket-badge');
        if (intermarket) {
            intermarket.style.display = 'block';
            intermarket.innerText = `CORR: ${Math.round((data.confluenceScore || 0) * 0.8)}%`;
        }


        // 3. --- INSTITUTIONAL MARKERS ---
        if (data.markers) {
            const m = data.markers;
            const pdhEl = document.getElementById('pdh-val');
            const pdlEl = document.getElementById('pdl-val');
            const midnightEl = document.getElementById('midnight-open-val');
            const nyOpenEl = document.getElementById('ny-open-val');
            const londonOpenEl = document.getElementById('london-open-val');
            const vwapEl = document.getElementById('vwap-val');
            const adrEl = document.getElementById('adr-val');
            const callWallEl = document.getElementById('call-wall-val');
            const putWallEl = document.getElementById('put-wall-val');
            const cvdEl = document.getElementById('cvd-val');
            const netWhaleVal = document.getElementById('net-whale-val');

            if (pdhEl) pdhEl.innerText = (m.pdh || 0).toFixed(precision);
            if (pdlEl) pdlEl.innerText = (m.pdl || 0).toFixed(precision);
            if (midnightEl) midnightEl.innerText = (m.midnightOpen || 0).toFixed(precision);
            if (nyOpenEl) nyOpenEl.innerText = (m.nyOpen || 0).toFixed(precision);
            if (londonOpenEl) londonOpenEl.innerText = (m.londonOpen || 0).toFixed(precision);
            if (vwapEl) vwapEl.innerText = (m.vwap || 0).toFixed(precision);
            if (adrEl) adrEl.innerText = (m.adr || 0).toFixed(2);
            if (callWallEl) callWallEl.innerText = (m.callWall || 0).toFixed(precision);
            if (putWallEl) putWallEl.innerText = (m.putWall || 0).toFixed(precision);
            if (cvdEl) {
                const cvd = data.hybridCVD !== undefined ? data.hybridCVD : (m.cvd || 0);
                cvdEl.innerText = Math.round(cvd).toLocaleString();
                cvdEl.className = 'm-value ' + (cvd >= 0 ? 'bullish-text' : 'bearish-text');
                
                // --- INSTITUTIONAL FLOW GAUGE (Synergy Shift) ---
                const netWhaleVal = document.getElementById('net-whale-val');
                if (netWhaleVal) {
                    const whaleFlow = data.netWhaleFlow || m.netWhaleFlow || 0;
                    const valM = whaleFlow / 1000000;
                    netWhaleVal.innerText = `$${valM.toFixed(2)}M`;
                    netWhaleVal.className = 'm-value ' + (whaleFlow >= 0 ? 'bullish-text' : 'bearish-text');
                    
                    const whaleBar = document.getElementById('whale-intensity-bar');
                    if (whaleBar) {
                        const intensity = Math.min(100, (Math.abs(valM) / 5) * 100); // Max at $5M flow
                        whaleBar.style.width = `${intensity}%`;
                        whaleBar.style.background = whaleFlow >= 0 ? 'var(--bullish)' : 'var(--bearish)';
                        whaleBar.style.boxShadow = `0 0 10px ${whaleBar.style.background}`;
                    }
                }
            }
        }

        // 4. --- SECTOR HEALTH MATRIX ---
        if (data.sectors) {
            const spyGrid = document.getElementById('spy-sector-grid');
            const qqqGrid = document.getElementById('qqq-sector-grid');
            const iwmGrid = document.getElementById('iwm-sector-grid');
            const fxGrid = document.getElementById('fx-sector-grid');

            const renderSectorGrid = (grid, symbols, suffix) => {
                if (!grid) return;
                if (grid.children.length === 0) {
                    symbols.forEach(sym => {
                        const div = document.createElement('div');
                        div.className = 'sector-item';
                        div.id = `sector-${sym}-${suffix}`;
                        div.innerHTML = `
                            <div style="display:flex; flex-direction:column;">
                                <span class="sector-sym">${sym.replace('=X','').replace('^TNX','10Y')}</span>
                                <span class="sector-status" style="font-size:0.45rem; font-weight:800; color:var(--text-dim);">LOADING</span>
                            </div>
                            <div style="text-align:right;">
                                <div class="sector-change" style="font-size:0.7rem;">0.00%</div>
                            </div>
                        `;
                        grid.appendChild(div);
                    });
                }
                symbols.forEach(sym => {
                    const sData = data.sectors.find(s => s.symbol === sym);
                    const el = document.getElementById(`sector-${sym}-${suffix}`);
                    if (sData && el) {
                        const cEl = el.querySelector('.sector-change');
                        const stEl = el.querySelector('.sector-status');
                        if (cEl) {
                            cEl.innerText = `${sData.change >= 0 ? '+' : ''}${sData.change.toFixed(2)}%`;
                            cEl.className = 'sector-change ' + (sData.change >= 0 ? 'bullish-text' : 'bearish-text');
                        }
                        if (stEl) {
                            stEl.innerText = sData.bias || 'NEUTRAL';
                            stEl.style.color = (sData.bias?.includes('BULLISH')) ? 'var(--bullish)' : (sData.bias?.includes('BEARISH') ? 'var(--bearish)' : 'var(--text-dim)');
                        }
                    }
                });
            };
            renderSectorGrid(spyGrid, ['XLK', 'XLY', 'XLF'], 'spy');
            renderSectorGrid(qqqGrid, ['XLK', 'XLC', 'SMH', 'AMD'], 'qqq');
            renderSectorGrid(iwmGrid, ['KRE', 'XBI', 'IYT'], 'iwm');
            renderSectorGrid(fxGrid, ['UUP', 'EURUSD=X', 'GBPUSD=X', 'USDJPY=X', '^TNX'], 'fx');
        }

        // 5. --- RECOMMENDATION ---
        const recBox = document.getElementById('rec-box');
        if (data.recommendation && recBox) {
            const rec = data.recommendation;
            const recAction = document.getElementById('rec-action');
            const recStrike = document.getElementById('rec-strike');
            const recTarget = document.getElementById('rec-target');
            const recRationale = document.getElementById('rec-rationale');
            if (recAction) recAction.innerText = rec.action || 'WAIT';
            if (recStrike) recStrike.innerText = rec.strike || '-';
            if (recTarget) recTarget.innerText = rec.target || '-';
            if (recRationale) recRationale.innerText = rec.rationale || 'SCANNING...';
            recBox.className = 'rec-box ' + (rec.action?.includes('CALL') ? 'rec-call' : (rec.action?.includes('PUT') ? 'rec-put' : ''));
        }

        // 6. --- EXTERNAL CALLS (HARDENED) ---
        const executeUpdate = (fn, name) => {
            if (typeof fn === 'function') {
                try { fn(data); } catch (e) { console.warn(`[UI] ${name} failed:`, e); }
            }
        };

        executeUpdate(updateMacroCorrelation, 'Macro Correlation');
        executeUpdate(updateInstitutionalRadar, 'Radar');
        executeUpdate(updateStrikeZones, 'StrikeZones');
        executeUpdate(updateBlockFeed, 'BlockFeed');
        executeUpdate(updateWatchlist, 'Watchlist');
        executeUpdate(updateIntelTicker, 'IntelTicker');
        executeUpdate(updateSpiderMatrix, 'SpiderMatrix');
        executeUpdate(updateProtocolStatus, 'ProtocolStatus');
        executeUpdate(updateChartOverlays, 'ChartOverlays');
        executeUpdate(update0DTESignal, '0DTE Signal');
        executeUpdate(updateChecklist, 'Checklist');
        executeUpdate(updateMarketTicker, 'Market Ticker');
        executeUpdate(updateG7Correlation, 'G7 Correlation');
        executeUpdate(updateEventPulse, 'Event Pulse');
        executeUpdate(updateForexRadar, 'ForexRadar');

        // --- PYTH SUB-SECOND TICK (Improvement 4) ---
        if (candleSeries && data.currentPrice > 0) {
            const tf = data.timeframe || '5m';
            let tfMs = 300000;
            if (tf === '1m') tfMs = 60000;
            if (tf === '15m') tfMs = 900000;
            if (tf === '1h') tfMs = 3600000;
            if (tf === '1d') tfMs = 86400000;
            
            const now = Date.now();
            const candleTs = Math.floor(now / tfMs) * tfMs;
            const timeInSeconds = Math.floor(candleTs / 1000);

            // Apply institutional high-velocity shading to the real-time tick
            const lastEnriched = data.candles ? data.candles[data.candles.length - 1] : null;
            const liveColor = (lastEnriched && lastEnriched.time === timeInSeconds) ? lastEnriched.color : (data.currentPrice >= (data.prevOpen || data.currentPrice) ? '#10b981' : '#f43f5e');

            // UNIFIED INSTITUTIONAL HEARTBEAT: Single-pass candle render
            const c = data.candle || {};
            try {
                candleSeries.update({
                    time: timeInSeconds,
                    open: Number(c.open || data.currentPrice),
                    high: Number(c.high || data.currentPrice),
                    low: Number(c.low || data.currentPrice),
                    close: Number(data.currentPrice || data.price || 0),
                    color: liveColor,
                    wickColor: liveColor,
                    borderColor: liveColor
                });
            } catch (err) {
                // If local time is out of sync with history, we skip the real-time update to keep the HUD alive
                if (err.message.includes('oldest data')) {
                    // SILENT SKIP: Prevent time-drift from crashing the whole UI
                } else {
                    console.error("[UI] Critical Update Failure:", err);
                }
            }

            // --- INSTITUTIONAL EDGE-LOCK (SMART SCROLLING) ---
            // Only auto-scroll to the live price if the trader is already near the edge.
            // This prevents the 'squashing' bug and allows for free historical review.
            if (tvChart) {
                const ts = tvChart.timeScale();
                const visible = ts.getVisibleRange();
                if (visible && visible.to) {
                    const isAtEdge = timeInSeconds >= (visible.to - (tfMs / 500)); // Within half a bar of edge
                    if (isAtEdge) ts.scrollToRealTime();
                }
            }
        }
        // 7. --- GLOBAL OVERNIGHT PULSE ---
        if (data.overnightSentiment) {
            const os = data.overnightSentiment;
            const asiaEl = document.getElementById('overnight-asia-perf');
            const londonEl = document.getElementById('overnight-london-perf');
            const nyEl = document.getElementById('overnight-ny-perf');
            const prevEl = document.getElementById('overnight-prev-perf');
            const statusEl = document.getElementById('overnight-global-status');
            const narrEl = document.getElementById('overnight-narrative');

            if (asiaEl) {
                asiaEl.innerText = `${os.asia >= 0 ? '+' : ''}${os.asia.toFixed(2)}%`;
                asiaEl.className = os.asia >= 0 ? 'bullish-text' : 'bearish-text';
            }
            if (londonEl) {
                londonEl.innerText = `${os.london >= 0 ? '+' : ''}${os.london.toFixed(2)}%`;
                londonEl.className = os.london >= 0 ? 'bullish-text' : 'bearish-text';
            }
            if (nyEl) {
                nyEl.innerText = `${os.nyMidnight >= 0 ? '+' : ''}${os.nyMidnight.toFixed(2)}%`;
                nyEl.className = os.nyMidnight >= 0 ? 'bullish-text' : 'bearish-text';
            }
            if (prevEl) {
                const p = os.previousSession || 0;
                prevEl.innerText = `${p >= 0 ? '+' : ''}${p.toFixed(2)}%`;
                prevEl.className = p >= 0 ? 'bullish-text' : 'bearish-text';
            }
            if (statusEl) {
                statusEl.innerText = os.global.replace(/_/g, ' ');
                statusEl.style.color = os.global.includes('BULLISH') ? 'var(--bullish)' : (os.global.includes('BEARISH') ? 'var(--bearish)' : 'var(--gold)');
            }

            if (narrEl) {
                if (os.global === 'STRONGLY_BULLISH') narrEl.innerText = "Institutional Accumulation detected across Global sessions. Bullish bias confirmed.";
                else if (os.global === 'BULLISH') narrEl.innerText = "Positive overnight drift. Monitoring for NY Open liquidity sweep.";
                else if (os.global === 'STRONGLY_BEARISH') narrEl.innerText = "Global liquidation in progress. High probability Bearish expansion.";
                else if (os.global === 'BEARISH') narrEl.innerText = "Overnight weakness detected. Institutional distribution likely.";
                else narrEl.innerText = "Mixed global sentiment. Session range bound.";
            }
        }
    } catch (err) {
        console.error("[UI] Critical Update Failure:", err);
    }
}
function updateWatchlist(data) {
    const stocksList = document.getElementById('stocks-list');
    const forexList = document.getElementById('forex-list');
    const stocksCountEl = document.getElementById('stocks-count');
    const forexCountEl = document.getElementById('forex-count');
    
    // Critical: Only update if the payload contains watchlist data
    if (!data.watchlist || !stocksList || !forexList) return;

    const wl = (data.watchlist || []).sort((a,b) => (b.confluenceScore || 0) - (a.confluenceScore || 0));
    const stocks = wl.filter(s => !s.symbol.includes('=X') && !s.symbol.includes('USD') && !s.symbol.includes('DX-Y'));
    const forex = wl.filter(s => s.symbol.includes('=X') || s.symbol.includes('USD') || s.symbol.includes('DX-Y'));

    if (stocksCountEl) stocksCountEl.innerText = stocks.length;
    if (forexCountEl) forexCountEl.innerText = forex.length;

    const renderInto = (list, targetList) => {
        if (!targetList) return;
        const frag = document.createDocumentFragment();
        list.forEach(stock => {
            try {
                const price = stock.price || 0;
                const isFX = (stock.symbol || '').includes('=X') || (stock.symbol || '').includes('USD');
                const precision = isFX ? 4 : 2;
                const action = stock.recommendation?.action || 'WAIT';
                const actionClass = action.includes('CALL') ? 'bullish-text' : action.includes('PUT') ? 'bearish-text' : 'text-dim';
                const isReady = (action !== 'WAIT' && (stock.confluenceScore || 0) >= 75);

                const card = document.createElement('div');
                card.className = `ticker-card ${data.symbol === stock.symbol ? 'active-symbol' : ''} ${isReady ? 'ready-signal' : ''}`;
                card.draggable = true;
                
                card.innerHTML = `
                    <div class="ticker-info">
                        <span class="ticker-sym">${stock.symbol} ${isReady ? '<span class="go-badge">GO</span>' : ''}</span>
                        <span class="ticker-price">$${price.toFixed(precision)}</span>
                    </div>
                    <div class="ticker-metrics">
                         <span class="ticker-bias ${stock.bias?.includes('BULLISH') ? 'bullish-text' : stock.bias?.includes('BEARISH') ? 'bearish-text' : ''}">${stock.bias || 'NEUTRAL'}</span>
                         <span class="ticker-signal ${actionClass}">${action}</span>
                    </div>
                `;
                card.onclick = () => socket.emit('switch_symbol', stock.symbol);
                frag.appendChild(card);
            } catch (err) {
                console.error("[UI] Watchlist error for " + stock.symbol, err);
            }
        });
        targetList.innerHTML = ''; 
        targetList.appendChild(frag);
    };

    renderInto(stocks, stocksList);
    renderInto(forex, forexList);
}

function updateMarketTicker(data) {
    if (!document.getElementById('market-ticker-ribbon')) return;
    
    // Support both full watchlist refreshes, single-stock updates, and the new 'updates' batch format
    const itemsToUpdate = data.updates || data.watchlist || (data.symbol ? [data] : []);
    if (itemsToUpdate.length === 0) return;
    
    // Friendly Name Mapping
    const targets = ['SPY', 'QQQ', 'DIA', 'BTC-USD', 'DXY', 'VIX', 'GOLD', 'NVDA', 'TSLA', 'AAPL', 'MSFT', 'META', 'AMZN', 'GOOGL', 'AMD', 'NFLX', 'IWM', 'SMH', 'XLK', 'XLY', 'XLF'];
    
    itemsToUpdate.forEach(stock => {
        let sym = stock.symbol;
        if (sym === 'DX-Y.NYB' || sym === 'DX-Y') sym = 'DXY';
        if (sym === '^VIX') sym = 'VIX';
        if (sym === 'GC=F' || sym === 'GLD') sym = 'GOLD';
        
        if (!targets.includes(sym)) return;

        const item = document.querySelector(`.ticker-item[data-symbol="${sym}"]`);
        if (!item) return;
        
        const priceEl = item.querySelector('.t-price');
        const pointsEl = item.querySelector('.t-points');
        const changeEl = item.querySelector('.t-change');
        
        const prec = (sym === 'BTC-USD' || sym === 'GOLD' || sym === 'VIX') ? 2 : 2;
        const chg = stock.dailyChangePercent || 0;
        const pts = stock.dailyChangePoints || 0;
        const color = chg >= 0 ? 'var(--bullish)' : 'var(--bearish)';

        if (priceEl) {
            const price = stock.price || stock.currentPrice || 0;
            if (price > 0) {
                const rawOld = priceEl.innerText.replace(/[^0-9.]/g, '');
                const oldPrice = parseFloat(rawOld) || 0;
                const newPriceStr = price.toFixed(prec);
                
                // --- PYTH ALPHA INDICATOR (Synergy Glow) ---
                if (stock.pythConfidence !== undefined) {
                    const bps = (stock.pythConfidence / price) * 10000;
                    const precision = Math.max(0, 100 - (bps / 5)); // 5 bps = 0% sync, 0 bps = 100%
                    priceEl.style.textShadow = precision > 95 ? `0 0 ${Math.min(10, (precision-90)*2)}px var(--cyan)` : 'none';
                    priceEl.title = `Institutional Synergy: ${precision.toFixed(2)}% (Pyth Confidence: ±$${stock.pythConfidence.toFixed(4)})`;
                }

                // Institutional Flow: Move as soon as the price deviates by more than 0.0001
                if (Math.abs(oldPrice - price) > 0.0001 || rawOld === '') {
                    priceEl.innerText = newPriceStr;
                    
                    const pulse = item.querySelector('.benchmark-pulse');
                    if (pulse) {
                        pulse.classList.remove('active');
                        void pulse.offsetWidth; 
                        pulse.classList.add('active');
                    }
                    
                    priceEl.style.transition = 'none';
                    priceEl.style.opacity = '0.5';
                    setTimeout(() => { 
                        if (priceEl) {
                            priceEl.style.transition = 'opacity 0.2s'; 
                            priceEl.style.opacity = '1'; 
                        }
                    }, 50);
                }
            }
        }
        
        if (pointsEl) {
            pointsEl.innerText = (pts >= 0 ? '+' : '') + pts.toFixed(2);
            pointsEl.className = 't-points ' + (pts >= 0 ? 'bullish-text' : 'bearish-text');
        }
        
        if (changeEl) {
            changeEl.innerText = (chg >= 0 ? '+' : '') + chg.toFixed(2) + '%';
            changeEl.className = 't-change ' + (chg >= 0 ? 'bullish-text' : 'bearish-text');
        }

        if (changeEl) {
            changeEl.innerText = (chg >= 0 ? '+' : '') + chg.toFixed(2) + '%';
            changeEl.style.color = color;
        }

        // --- NEW: Global Macro Overnight Pulse (REBUILT) ---
        const os = stock.benchmarkSentiment || stock.overnightSentiment;
        if (os) {
            const asiaEl = document.getElementById('overnight-asia-perf');
            const londonEl = document.getElementById('overnight-london-perf');
            const nyEl = document.getElementById('overnight-ny-perf');
            const statusEl = document.getElementById('overnight-global-status');
            const narrEl = document.getElementById('overnight-narrative');
            
            // 1. Performance Matrix
            if (asiaEl) { asiaEl.innerText = `${os.asia >= 0 ? '+' : ''}${os.asia.toFixed(2)}%`; asiaEl.style.color = os.asia >= 0 ? 'var(--bullish)' : 'var(--bearish)'; }
            if (londonEl) { londonEl.innerText = `${os.london >= 0 ? '+' : ''}${os.london.toFixed(2)}%`; londonEl.style.color = os.london >= 0 ? 'var(--bullish)' : 'var(--bearish)'; }
            if (nyEl) { nyEl.innerText = `${os.nyMidnight >= 0 ? '+' : ''}${os.nyMidnight.toFixed(2)}%`; nyEl.style.color = os.nyMidnight >= 0 ? 'var(--bullish)' : 'var(--bearish)'; }
            
            if (statusEl) {
                statusEl.innerText = os.global.replace(/_/g, ' ');
                statusEl.style.color = os.global.includes('BULLISH') ? 'var(--bullish)' : (os.global.includes('BEARISH') ? 'var(--bearish)' : 'var(--gold)');
                statusEl.style.borderColor = statusEl.style.color;
            }

            // 2. Institutional Sentiment Meter (Visual Flow)
            const meterFill = document.getElementById('sentiment-meter-fill');
            const meterMarker = document.getElementById('sentiment-meter-marker');
            if (meterFill && meterMarker) {
                const biasMap = { 'STRONGLY_BULLISH': 40, 'BULLISH': 20, 'NEUTRAL': 0, 'BEARISH': -20, 'STRONGLY_BEARISH': -40 };
                const offset = biasMap[os.global] || 0;
                meterFill.style.width = `${Math.abs(offset)}%`;
                meterFill.style.left = offset >= 0 ? '50%' : `${50 + offset}%`;
                meterFill.style.background = offset >= 0 ? 'var(--bullish)' : 'var(--bearish)';
                meterFill.style.boxShadow = `0 0 10px ${meterFill.style.background}`;
                meterMarker.style.left = `${50 + offset}%`;
            }

            // 3. Liquidity Sweep Radar (Institutional Confirmation)
            const updateRadar = (id, val) => {
                const el = document.getElementById(id);
                if (el) {
                    const dot = el.querySelector('.pulse-dot');
                    const isSweep = Math.abs(val) > 0.05; // 0.05% deviation threshold for a "sweep" phase
                    if (dot) {
                        dot.style.background = isSweep ? 'var(--gold)' : '#334155';
                        dot.style.boxShadow = isSweep ? '0 0 8px var(--gold)' : 'none';
                    }
                    el.style.color = isSweep ? 'var(--text-bright)' : 'var(--text-dim)';
                }
            };
            updateRadar('radar-sweep-asia', os.asia);
            updateRadar('radar-sweep-london', os.london);
            updateRadar('radar-sweep-ny', os.nyMidnight);

            if (narrEl) {
                const narrMap = {
                    'STRONGLY_BULLISH': "Institutional Accumulation across Global sessions. Extreme Bullish Flow.",
                    'STRONGLY_BEARISH': "Global session liquidation. Heavy distribution in progress.",
                    'BULLISH': "Price holding above midnight open. Bullish bias confirmed.",
                    'BEARISH': "Price trading below midnight open. Bearish distribution active.",
                    'NEUTRAL': "Consolidation phase. Waiting for institutional expansion."
                };
                narrEl.innerText = narrMap[os.global] || "Syncing macro context...";
            }
        }
        
        // Institutional expansion glow
        if (Math.abs(chg) > 1.0) {
            const rbgColor = chg >= 0 ? '16, 185, 129' : '244, 63, 100';
            item.style.background = `rgba(${rbgColor}, 0.08)`;
            item.style.borderRadius = '4px';
        } else {
            item.style.background = 'transparent';
        }

        // --- INSTITUTIONAL LIQUIDITY SHIELD (Pyth V2) ---
        if (stock.liquidityStatus) {
            if (stock.liquidityStatus === 'DANGEROUS') {
                item.style.borderLeft = '4px solid #ff3366';
                item.style.backgroundColor = 'rgba(255, 51, 102, 0.05)';
            } else if (stock.liquidityStatus === 'THIN') {
                item.style.borderLeft = '4px solid var(--gold)';
                item.style.backgroundColor = 'transparent';
            } else {
                item.style.borderLeft = 'none';
                item.style.backgroundColor = 'transparent';
            }
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

function showToast(msg, customClass = '') {
    const toast = document.createElement('div');
    toast.className = 'toast-alert ' + customClass;
    toast.style.background = 'rgba(15, 23, 42, 0.95)';
    toast.style.color = '#fff';
    toast.style.padding = '12px 20px';
    toast.style.borderRadius = '12px';
    toast.style.borderLeft = '4px solid var(--accent)';
    
    if (customClass === 'toast-smt') {
        toast.style.borderLeft = '4px solid var(--gold)';
        toast.style.boxShadow = '0 0 15px rgba(255, 215, 0, 0.3)';
    } else if (customClass === 'toast-grail') {
        toast.style.borderLeft = '4px solid #ff3366';
        toast.style.boxShadow = '0 0 20px rgba(255, 51, 102, 0.4)';
    } else if (customClass === 'toast-gold') {
        toast.style.borderLeft = '4px solid var(--gold)';
        toast.style.background = 'linear-gradient(90deg, rgba(255, 215, 0, 0.1) 0%, rgba(15, 23, 42, 0.95) 100%)';
        toast.style.boxShadow = '0 0 25px rgba(255, 215, 0, 0.5)';
    }

    toast.style.marginBottom = '10px';
    toast.style.fontSize = '0.9rem';
    toast.style.fontWeight = '700';
    toast.style.zIndex = '9999';
    toast.innerText = msg;
    const toastContainer = document.getElementById('toast-container');
    if (toastContainer) {
        toastContainer.appendChild(toast);
        setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transition = 'opacity 0.5s';
            setTimeout(() => toast.remove(), 500);
        }, 5000);
    }
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
    
    // --- SLIPPAGE GUARD LOGIC (Improvement 3) ---
    const data = window.latestInstitutionalData;
    const slippageWarning = document.getElementById('slippage-warning-box');
    const slippageStatus = document.getElementById('slippage-status');
    
    if (data && slippageWarning && slippageStatus) {
        // Threshold: 15 bps of discordance is "High Risk" for institutional execution
        const discordance = data.priceDiscordance || 0;
        const isHighRisk = discordance > 15;
        
        slippageWarning.style.display = isHighRisk ? 'block' : 'none';
        slippageStatus.innerText = isHighRisk ? 'CAUTION: LOW LIQUIDITY' : 'OPTIMAL LIQUIDITY';
        slippageStatus.style.color = isHighRisk ? 'var(--bearish)' : 'var(--bullish)';
        
        const slippageOuter = document.getElementById('slippage-guard-item');
        if (slippageOuter) {
            slippageOuter.style.borderColor = isHighRisk ? 'var(--bearish)' : 'rgba(255,255,255,0.1)';
            slippageOuter.style.background = isHighRisk ? 'rgba(244, 63, 94, 0.05)' : 'rgba(0,0,0,0.4)';
        }
    }

    checklistModal.style.display = 'flex';
    document.querySelectorAll('.trigger-check').forEach(c => c.checked = false);
    const btnConfirmTrade = document.getElementById('btn-confirm-trade');
    if (btnConfirmTrade) btnConfirmTrade.disabled = true;
};

document.getElementById('btn-unlock-signal')?.addEventListener('click', openChecklist);
mobileTriggerBtn?.addEventListener('click', openChecklist);
document.getElementById('btn-manual-scan')?.addEventListener('click', () => {
    socket.emit('manual_scan_trigger');
    showToast("MANUAL SCALPER SCAN INITIATED...");
});
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

function update0DTESignal(data) {
    const card = document.getElementById('0dte-radar-card');
    const placeholder = document.getElementById('0dte-placeholder');
    const signalMain = document.getElementById('0dte-signal-main');
    const confVal = document.getElementById('0dte-conf-val');

    if (!card) return;

    if (!data.signal0DTE) {
        if (placeholder) placeholder.style.display = 'block';
        if (signalMain) signalMain.style.display = 'none';
        
        // Update scanning confluence
        if (confVal) {
            const tempConf = Math.floor(40 + Math.random() * 25);
            confVal.innerText = `CONFLUENCE: ${tempConf}%`;
        }
        return;
    }

    const signal = data.signal0DTE;
    
    // Show Signal
    if (placeholder) placeholder.style.display = 'none';
    if (signalMain) signalMain.style.display = 'block';

    // Update Values
    const typeEl = document.getElementById('0dte-type');
    const confEl = document.getElementById('0dte-confidence');
    const strikeEl = document.getElementById('0dte-strike');
    const rrEl = document.getElementById('0dte-rr');
    const triggerEl = document.getElementById('0dte-trigger');

    if (typeEl) {
        typeEl.innerText = `${data.symbol} ${signal.type}`;
        typeEl.style.color = signal.type === 'CALL' ? '#22c55e' : 'var(--bearish)';
    }
    if (confEl) confEl.innerText = `${signal.confidence}% CONF`;
    if (strikeEl) strikeEl.innerText = `$${signal.strike}`;
    if (rrEl) rrEl.innerText = `${signal.rr} : 1`;
    if (triggerEl) triggerEl.innerText = `Trigger: ${signal.trigger}`;

    // Intensity Effect
    card.style.borderColor = signal.type === 'CALL' ? 'rgba(34,197,94,0.8)' : 'rgba(239,68,68,0.8)';
    card.style.boxShadow = `0 0 25px ${signal.type === 'CALL' ? 'rgba(34,197,94,0.2)' : 'rgba(239,68,68,0.2)'}`;
}

function updateG7Correlation(data) {
    const grid = document.getElementById('correlation-matrix');
    const status = document.getElementById('decoupling-status');
    if (!grid || !data.correlationMatrix) return;

    const matrix = data.correlationMatrix;
    const currencies = ['USD', 'EUR', 'GBP', 'JPY', 'AUD', 'CAD', 'CHF', 'NZD'];
    
    let html = '<div style="background:transparent;"></div>';
    currencies.forEach(c => html += `<div style="font-size: 0.35rem; font-weight: 900; color: var(--text-dim); text-align: center; padding: 2px 0;">${c}</div>`);
    
    currencies.forEach(c1 => {
        // Row Header
        html += `<div style="font-size: 0.35rem; font-weight: 900; color: var(--text-dim); display:flex; align-items:center; height: 12px;">${c1}</div>`;
        
        currencies.forEach(c2 => {
            const val = matrix[c1][c2];
            let bg = 'rgba(255,255,255,0.03)';
            let color = 'rgba(255,255,255,0.2)';
            
            if (c1 === c2) {
                bg = 'rgba(0,242,255,0.05)';
                color = '#00f2ff';
                return html += `<div style="aspect-ratio: 1; display:flex; align-items:center; justify-content:center; font-size:0.25rem; background:${bg}; color:${color}; border-radius:1px;">--</div>`;
            } else if (val > 0.8) {
                bg = 'rgba(0,242,255,0.3)';
                color = '#fff';
            } else if (val < 0.3) {
                bg = 'rgba(212,175,55,0.4)';
                color = '#fff';
            }
            
            html += `<div style="aspect-ratio: 1; display:flex; align-items:center; justify-content:center; font-size:0.28rem; font-weight:800; border-radius:1px; background:${bg}; color:${color}; transition: all 0.3s ease;">${val}</div>`;
        });
    });
    
    grid.innerHTML = html;
    
    // Alert logic
    const alerts = [];
    if (matrix['USD']['JPY'] < 0.4) alerts.push("YEN DECOUPLING");
    if (matrix['EUR']['GBP'] < 0.5) alerts.push("EUROPEAN DISCORDANCE");
    
    if (status) {
        status.innerText = alerts.length > 0 ? alerts.join(" | ") : "FLOW SYNCED";
        status.style.color = alerts.length > 0 ? 'var(--gold)' : '#00f2ff';
    }
}

function updateEventPulse(data) {
    const pulse = data.eventPulse;
    if (!pulse) return;
    
    const timerEl = document.getElementById('event-timer-min');
    const nameEl = document.getElementById('event-name');
    const statusEl = document.getElementById('event-status');
    const impactEl = document.getElementById('event-impact');
    const boxEl = document.getElementById('event-countdown-box');

    if (timerEl) timerEl.innerText = pulse.countdown;
    if (nameEl) nameEl.innerText = pulse.name;
    if (impactEl) impactEl.innerText = `IMPACT: ${pulse.impact}`;
    
    if (statusEl) {
        statusEl.innerText = pulse.status;
        statusEl.style.background = pulse.color;
    }
    
    if (boxEl) {
        boxEl.style.borderColor = pulse.color;
        if (pulse.status === 'EXTREME') boxEl.style.animation = 'pulse-red 1s infinite';
        else boxEl.style.animation = 'none';
    }
}

function updateSpiderMatrix(data) {
    const grid = document.getElementById('spider-grid');
    const status = document.getElementById('basket-alignment');
    if (!grid || !data.basket) return;

    const basket = data.basket;
    const sorted = Object.entries(basket)
        .sort((a, b) => b[1].perf - a[1].perf);

    const strongest = sorted[0];
    const weakest = sorted[sorted.length - 1];
    const divergence = (strongest[1].perf - weakest[1].perf);
    
    sorted.forEach(([cur, val], index) => {
        const node = grid.querySelector(`[data-cur="${cur}"]`);
        if (node) {
            const valEl = node.querySelector('.val');
            const fillEl = node.querySelector('.strength-bar-fill');
            const perf = val.perf || 0;
            
            valEl.innerText = (perf >= 0 ? '+' : '') + perf.toFixed(2) + '%';
            
            // Visual Bar Logic (Normalized to 2.0% as full range)
            const strengthNormalized = Math.max(5, Math.min(95, 50 + (perf * 40))); 
            if (fillEl) {
                fillEl.style.width = `${strengthNormalized}%`;
                fillEl.style.background = perf > 0 ? 'var(--bullish)' : (perf < 0 ? 'var(--bearish)' : 'var(--gold)');
            }

            // Highlighting Leaders & Laggards
            node.classList.remove('node-leader', 'node-laggard');
            if (index < 2 && perf > 0.15) node.classList.add('node-leader');
            if (index > sorted.length - 3 && perf < -0.15) node.classList.add('node-laggard');

            // Color Coding Logic
            if (perf > 0.05) {
                valEl.style.color = 'var(--bullish)';
                node.style.background = 'rgba(16, 185, 129, 0.08)';
            } else if (perf < -0.05) {
                valEl.style.color = 'var(--bearish)';
                node.style.background = 'rgba(244, 63, 94, 0.08)';
            } else {
                valEl.style.color = 'var(--text-dim)';
                node.style.background = 'rgba(255, 255, 255, 0.02)';
            }
            
            // Institutional Shift Highlight
            const isMegaMove = Math.abs(perf) > 0.40;
            node.style.borderColor = isMegaMove ? 'var(--gold)' : 'rgba(255, 255, 255, 0.05)';
            node.style.boxShadow = isMegaMove ? '0 0 15px rgba(212, 175, 55, 0.2)' : 'none';

            // --- NEW: MTF DOTS ---
            if (val.mtf) {
                const dots = node.querySelectorAll('.tf-dot');
                ['1m', '5m', '1h'].forEach((tf, i) => {
                    const tfVal = val.mtf[tf];
                    if (dots[i]) {
                        dots[i].style.background = tfVal > 0.05 ? 'var(--bullish)' : (tfVal < -0.05 ? 'var(--bearish)' : 'rgba(255,255,255,0.1)');
                        dots[i].style.opacity = Math.abs(tfVal) > 0.02 ? '1' : '0.3';
                    }
                });
            }

            // --- NEW: EXHAUSTION BADGE ---
            const badge = node.querySelector('.exhaustion-badge');
            if (badge) {
                if (val.isSupplied || val.isDepleted) {
                    badge.style.display = 'block';
                    badge.innerText = val.isSupplied ? 'SUPPLY ZONE' : 'DEMAND ZONE';
                    badge.style.background = val.isSupplied ? 'var(--bearish)' : 'var(--bullish)';
                } else if (val.isOverextended) {
                    badge.style.display = 'block';
                    badge.innerText = 'EXTENDED';
                    badge.style.background = 'var(--gold)';
                    badge.style.color = '#000';
                } else {
                    badge.style.display = 'none';
                }
            }
        }
    });

    if (status) {
        const isAligned = data.isBasketAligned;
        status.innerHTML = `GAP: ${divergence.toFixed(2)}% | ${isAligned ? '<span style="color:var(--gold)">TREND REALM</span>' : '<span style="color:var(--text-dim)">RANGING</span>'}`;
    }
}

function updateForexRadar(data) {
    const container = document.getElementById('forex-radar-container');
    if (!container) return;

    if (!data.forexRadar) {
        container.style.display = 'none';
        return;
    }

    container.style.display = 'block';
    const fr = data.forexRadar;

    // 1. DXY Correlation
    const dxyCorrEl = document.getElementById('fx-dxy-corr');
    if (dxyCorrEl) {
        const corr = fr.dxyCorrelation || 0;
        dxyCorrEl.innerText = `${corr.toFixed(1)}%`;
        dxyCorrEl.style.color = Math.abs(corr) > 75 ? 'var(--bullish)' : (Math.abs(corr) < 40 ? 'var(--bearish)' : 'var(--text-bright)');
    }

    // 2. SMT Sync
    const smtEl = document.getElementById('fx-smt-sync');
    if (smtEl && data.markers?.smt) {
        smtEl.innerText = data.markers.smt.type;
        smtEl.style.color = data.markers.smt.type.includes('BULLISH') ? 'var(--bullish)' : 'var(--bearish)';
    } else if (smtEl) {
        smtEl.innerText = 'STABLE';
        smtEl.style.color = 'var(--text-dim)';
    }

    // 3. Inverse-DXY Realm Badge
    const dxyRealmEl = document.getElementById('fx-inverse-dxy-badge');
    if (dxyRealmEl) {
        dxyRealmEl.style.display = fr.isInverseDxyRealm ? 'block' : 'none';
    }

    // 4. Global Session Matrix
    if (fr.sessions) {
        const updateSession = (id, session) => {
            const el = document.getElementById(id);
            if (el) {
                const status = el.querySelector('.gs-status');
                if (status) {
                    status.innerText = session.status;
                    status.style.color = session.color;
                }
                el.style.borderColor = session.status === 'OPEN' ? session.color : 'rgba(255,255,255,0.05)';
                el.style.background = session.status === 'OPEN' ? `${session.color}11` : 'rgba(0,0,0,0.2)';
            }
        };
        updateSession('gs-london', fr.sessions.london);
        updateSession('gs-ny', fr.sessions.ny);
        updateSession('gs-tokyo', fr.sessions.tokyo);
    }

    // 5. PO3 Cycle Tracker
    const po3PhaseEl = document.getElementById('fx-po3-phase');
    const po3ProgEl = document.getElementById('fx-po3-progress');
    if (po3PhaseEl) po3PhaseEl.innerText = fr.po3Phase || 'ACCUMULATION';
    if (po3ProgEl) po3ProgEl.style.width = `${fr.po3Progress || 0}%`;

    // 6. Judas Swing Alert & Audio Pulse
    const judasEl = document.getElementById('fx-judas-alert');
    if (judasEl) {
        const isTrapActive = fr.judasDetected;
        judasEl.style.display = isTrapActive ? 'block' : 'none';
        
        if (isTrapActive && (!this.lastJudasTime || Date.now() - this.lastJudasTime > 300000)) { // 5m Cooldown
            this.lastJudasTime = Date.now();
            audioHooter.playTrap();
            if (voiceNarrator.enabled) voiceNarrator.speakTrap(data.symbol, fr.judasDetected.type);
            showToast(`🔥 ${data.symbol.replace('=X','')} JUDAS DETECTED: AWAIT REVERSAL`, "BEARISH");
        }
    }

    // 7. Retail Sentiment
    const retailValEl = document.getElementById('fx-retail-val');
    const retailFillEl = document.getElementById('fx-retail-fill');
    if (retailValEl) {
        const sent = fr.retailSentiment || 50;
        retailValEl.innerText = `${sent.toFixed(0)}% ${sent >= 60 ? 'BULLISH' : (sent <= 40 ? 'BEARISH' : 'NEUTRAL')}`;
    }
    if (retailFillEl) retailFillEl.style.width = `${fr.retailSentiment || 50}%`;

    // 8. Forex Whale Tape (Live)
    const tapeList = document.getElementById('fx-whale-tape-list');
    if (tapeList && data.blockTrades) {
        const fxBlocks = data.blockTrades.filter(b => b.symbol.includes('=X') || b.symbol.includes('USD'));
        if (fxBlocks.length > 0) {
            tapeList.innerHTML = fxBlocks.slice(-5).reverse().map(b => `
                <div style="display:flex; justify-content:space-between; border-left: 2px solid ${b.value > 1000000 ? 'var(--gold)' : (b.symbol.includes('USD') ? 'var(--accent)' : 'var(--text-dim)')}; padding-left: 5px; margin-bottom: 2px; background: rgba(255,255,255,0.02);">
                    <span style="font-weight:800;">${b.symbol.replace('=X','')}</span>
                    <span style="color:var(--text-bright); font-weight:900;">$${(b.value / 1000000).toFixed(1)}M</span>
                </div>
            `).join('');
        }
    }
}

function updateMacroCorrelation(data) {
    const dxyVal = document.getElementById('dxy-val');
    const dxyBar = document.getElementById('dxy-bar');
    const vixVal = document.getElementById('vix-val-macro');
    const vixBar = document.getElementById('vix-bar');
    const roroLabel = document.getElementById('roro-label');
    const roroBar = document.getElementById('roro-bar');
    const roroVal = document.getElementById('roro-val');

    if (!dxyVal || !vixVal || !roroLabel) return;

    // Direct extraction with strict fallbacks
    const m = data.markers || {};
    const dxy = Number(m.dxy) || 103.55;
    const vix = Number(m.vix) || 16.50;

    // Update DXY
    dxyVal.innerText = dxy.toFixed(2);
    if (dxyBar) {
        const dxyPercent = Math.max(0, Math.min(100, (dxy - 98) / 8 * 100)); // 98-106 scale
        dxyBar.style.width = `${dxyPercent}%`;
        dxyBar.style.background = dxy > 103.5 ? 'var(--bearish)' : 'var(--bullish)';
    }

    // Update VIX
    vixVal.innerText = vix.toFixed(2);
    if (vixBar) {
        const vixPercent = Math.max(0, Math.min(100, (vix - 10) / 30 * 100)); // 10-40 scale
        vixBar.style.width = `${vixPercent}%`;
        vixBar.style.background = vix > 20 ? 'var(--bearish)' : 'var(--bullish)';
    }

    // RORO Sentiment (Risk-On / Risk-Off)
    const dxyImpact = (103.5 - dxy) / 3; 
    const vixImpact = (18 - vix) / 8; 
    const rawRoro = 50 + ((dxyImpact + vixImpact) * 25);
    const roro = Math.max(0, Math.min(100, Math.round(rawRoro)));

    if (roroLabel) {
        roroLabel.innerText = roro > 60 ? 'RISK-ON' : roro < 40 ? 'RISK-OFF' : 'NEUTRAL';
        roroLabel.style.color = roro > 60 ? 'var(--bullish)' : roro < 40 ? 'var(--bearish)' : 'var(--gold)';
    }
    if (roroBar) {
        roroBar.style.width = `${roro}%`;
        roroBar.style.background = roro > 60 ? 'var(--bullish)' : roro < 40 ? 'var(--bearish)' : 'var(--gold)';
    }
    // --- RORO FLASH DETECTION (Improvement 2) ---
    const roroFlash = document.getElementById('roro-flash');
    if (roroFlash) {
        if (data.isRoroFlash) {
            roroFlash.style.opacity = '1';
            roroFlash.style.color = data.roroDirection === 'ON' ? 'var(--bullish)' : 'var(--bearish)';
            roroFlash.innerText = `⚡ FLASH ${data.roroDirection}`;
            roroFlash.classList.add('pulse-glow');
            
            // Revert back after 4 seconds of stability
            setTimeout(() => { 
                roroFlash.style.opacity = '0.8';
                roroFlash.style.color = 'var(--gold)';
                roroFlash.innerText = '⚡ PULSE: SCANNING';
                roroFlash.classList.remove('pulse-glow');
            }, 4000);
        } else if (!roroFlash.innerText.includes('FLASH')) {
            // Constant state if not currently flashing
            roroFlash.style.opacity = '0.8';
            roroFlash.style.color = 'var(--gold)';
            roroFlash.innerText = '⚡ PULSE: SCANNING';
        }
    }
}

function updateStrikeZones(data) {
    const m = data.markers;
    if (!m) return;

    const bslPrice = document.getElementById('magnet-bsl-price');
    const bslDist = document.getElementById('magnet-bsl-dist');
    const sslPrice = document.getElementById('magnet-ssl-price');
    const sslDist = document.getElementById('magnet-ssl-dist');
    const asiaHigh = document.getElementById('magnet-asia-high');
    const asiaLow = document.getElementById('magnet-asia-low');
    const sd1 = document.getElementById('magnet-cbdr-sd1');
    const sd2 = document.getElementById('magnet-cbdr-sd2');

    const price = data.currentPrice || 0;
    
    // Robust mapping for draws and asiaRange (supporting multiple backend versions)
    const draws = m.draws || data.draws || (data.bias ? data.bias.draws : null);
    const asiaRange = m.asiaRange || data.asiaRange || (data.bias ? data.bias.asiaRange : null);

    if (bslPrice && draws && draws.highs && draws.highs.length > 0) {
        const topBsl = draws.highs[0];
        bslPrice.innerText = topBsl.price.toFixed(2);
        if (bslDist && price > 0) bslDist.innerText = (((topBsl.price / price) - 1) * 100).toFixed(2) + '%';
    }

    if (sslPrice && draws && draws.lows && draws.lows.length > 0) {
        const bottomSsl = draws.lows[0];
        sslPrice.innerText = bottomSsl.price.toFixed(2);
        if (sslDist && price > 0) sslDist.innerText = (((bottomSsl.price / price) - 1) * 100).toFixed(2) + '%';
    }

    if (asiaHigh && asiaRange && asiaRange.high > 0) asiaHigh.innerText = asiaRange.high.toFixed(2);
    if (asiaLow && asiaRange && asiaRange.low > 0) asiaLow.innerText = asiaRange.low.toFixed(2);

    const cbdr = data.bias?.cbdr;
    if (cbdr) {
        if (sd1) sd1.innerText = cbdr.sd1?.toFixed(2) || '--';
        if (sd2) sd2.innerText = cbdr.sd2?.toFixed(2) || '--';
    }
}

function updateBlockFeed(data) {
    const feed = document.getElementById('block-trades-feed');
    if (!feed || !data.blockTrades) return;

    // Clear placeholder only if we have data
    if (data.blockTrades.length > 0 && feed.innerHTML.includes('Listening for whales')) {
        feed.innerHTML = '';
    }

    // Capture IDs of current items to avoid double-posting if updateBlockFeed is called multiple times with same data
    const existingIds = new Set(Array.from(feed.children).map(c => c.getAttribute('data-id')));
    
    data.blockTrades.slice(-10).forEach(block => {
        const blockId = `${block.symbol}-${block.time}-${block.size}`;
        if (existingIds.has(blockId)) return;

        const div = document.createElement('div');
        div.setAttribute('data-id', blockId);
        div.style.cssText = 'padding: 4px 8px; border-bottom: 1px solid rgba(255,255,255,0.05); font-size: 0.55rem; display: flex; justify-content: space-between; align-items: center;';
        
        const isBuy = block.type === 'BUY';
        const color = isBuy ? 'var(--bullish)' : 'var(--bearish)';
        
        div.innerHTML = `
            <span style="font-weight: 800; color: #fff;">${block.symbol}</span>
            <span style="color: ${color}; font-weight: 900;">$${(block.value / 1000).toFixed(0)}K ${isBuy ? 'Γû¦' : 'Γû+'}</span>
            <span style="color: var(--text-dim); opacity: 0.7;">@ ${block.price}</span>
        `;
        
        feed.prepend(div);
        if (feed.children.length > 15) feed.lastChild.remove();
    });
}

function updateAIAnalyst(insight) {
    if (!insight) return;
    
    const textEl = document.getElementById('ai-insight-text');
    const convEl = document.getElementById('ai-conviction');
    const actionEl = document.getElementById('ai-action');
    const intensityEl = document.getElementById('ai-intensity');

    if (convEl) {
        convEl.innerText = `CONF: ${insight.probability}%`;
        convEl.style.color = insight.probability >= 70 ? 'var(--bullish)' : (insight.probability <= 35 ? 'var(--bearish)' : 'var(--cyan)');
    }
    
    if (actionEl) {
        actionEl.innerText = insight.action;
        actionEl.className = (insight.action.includes('CALL') || insight.action.includes('BULLISH')) ? 'bullish-text' : 
                          ((insight.action.includes('PUT') || insight.action.includes('SHORT') || insight.action.includes('BEARISH')) ? 'bearish-text' : 'gold-text');
    }

    if (intensityEl) {
        intensityEl.innerText = `INTENSITY: ${insight.intensity}`;
        intensityEl.style.borderColor = insight.intensity === 'HIGH' ? 'var(--cyan)' : 'rgba(255,255,255,0.1)';
        intensityEl.style.color = insight.intensity === 'HIGH' ? 'var(--cyan)' : 'var(--text-dim)';
    }

    if (window.latestInstitutionalData?.aiStats) {
        const stats = window.latestInstitutionalData.aiStats;
        const accEl = document.getElementById('ai-accuracy');
        const capEl = document.getElementById('ai-capture');
        if (accEl) accEl.innerText = `ACCURACY: ${stats.accuracy}%`;
        if (capEl) capEl.innerText = `CAPTURE: ${parseFloat(stats.points) >= 0 ? '+' : ''}${stats.points} PTS`;
    }

    // Typewriter effect if text changed
    if (textEl && lastAIInsight !== insight.text) {
        lastAIInsight = insight.text;
        const pulse = document.getElementById('ai-status-pulse');
        if (pulse) {
            pulse.style.background = 'var(--gold)';
            pulse.style.animationDuration = '0.3s';
            setTimeout(() => {
                pulse.style.background = 'var(--cyan)';
                pulse.style.animationDuration = '1.5s';
            }, 2000);
        }
        typeWriter(textEl, insight.text);
    }
}

function typeWriter(element, text) {
    let charIndex = 0;
    element.innerHTML = '';
    const speed = 15; // Fast tactical speed
    
    function type() {
        if (charIndex < text.length) {
            element.innerHTML += text.charAt(charIndex);
            charIndex++;
            setTimeout(type, speed);
        }
    }
    type();
}
