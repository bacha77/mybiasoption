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

// ============================================================
// BROWSER NOTIFICATION SYSTEM — GOLD SIGNAL + REVERSAL GUARD
// Request permission once on load, silently. No spam.
// ============================================================
window._notifLastGold = 0;
window._notifLastReversal = 0;

(function requestNotificationPermission() {
    if ('Notification' in window && Notification.permission === 'default') {
        // Request silently — only fires once, user sees OS prompt
        Notification.requestPermission().then(perm => {
            console.log(`[BIAS] Notification permission: ${perm}`);
        });
    }
})();

function fireGoldSignalNotification(symbol, score) {
    const now = Date.now();
    // Rate-limit to once per 5 minutes per symbol
    if (now - window._notifLastGold < 300000) return;
    window._notifLastGold = now;

    showToast(`🪥 GOLD SIGNAL: ${symbol} — ${score}% Confluence`, 'toast-gold');

    if ('Notification' in window && Notification.permission === 'granted') {
        new Notification('🪥 BIAS GOLD SIGNAL — HIGH CONVICTION', {
            body: `${symbol}: ${score}% institutional confluence detected. All engines aligned.`,
            icon: '/favicon.ico',
            tag: 'gold-signal-' + symbol,
            requireInteraction: false
        });
    }
}


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
        const isHighConviction = upd.isHighConviction || (upd.confluenceScore >= 80);
        const existing = document.getElementById('scan-' + upd.symbol);
        
        let rowClasses = 'scalper-row';
        if (isReload) rowClasses += ' reloading';
        if (isHighConviction) rowClasses += ' high-conviction';

        if (existing) {
            const velEl = existing.querySelector('.velocity-val');
            const sigEl = existing.querySelector('.signal-val');
            if (velEl) { 
                velEl.innerText = 'VEL: ' + upd.velocity; 
                velEl.style.color = upd.color; 
            }
            if (sigEl) { 
                sigEl.innerText = upd.signal; 
                sigEl.style.color = (isHighConviction || isReload) ? (isReload ? 'var(--bullish)' : 'var(--gold)') : '#94a3b8';
            }
            existing.className = rowClasses;
            return;
        }

        const row = document.createElement('div');
        row.id = 'scan-' + upd.symbol;
        row.className = rowClasses;
        row.onclick = () => { socket.emit('switch_symbol', upd.symbol); };
        
        row.innerHTML = `
            <div style="display: flex; flex-direction: column;">
                <div style="font-size: 0.75rem; font-weight: 950; color: #fff; letter-spacing: 0.5px; display: flex; align-items: center; gap: 6px;">
                    ${upd.symbol}
                    ${isHighConviction ? '<span style="color:var(--gold); font-size:0.6rem; text-shadow: 0 0 5px var(--gold);">⚡</span>' : ''}
                    ${isReload ? '<span style="color:var(--bullish); font-size:0.45rem; background:rgba(0,255,136,0.1); border: 1px solid var(--bullish); padding: 1px 4px; border-radius: 2px;">RELOADING</span>' : ''}
                </div>
                <div class="signal-val" style="font-size: 0.5rem; color: ${isHighConviction ? 'var(--gold)' : (isReload ? 'var(--bullish)' : '#94a3b8')}; font-weight: 800; text-transform: uppercase;">
                    ${upd.signal}
                </div>
            </div>
            <div style="text-align: right;">
                <div class="velocity-val" style="font-size: 0.7rem; font-weight: 950; color: ${upd.color}; font-family: var(--font-data);">
                    VEL: ${upd.velocity}
                </div>
                <div style="font-size: 0.45rem; color: #64748b; font-weight: 800; letter-spacing: 0.5px;">
                    ${isReload ? 'INSTITUTIONAL RELOAD' : 'ACTIVE PROBE'}
                </div>
            </div>
        `;

        if (list.firstChild && list.firstChild.innerText && list.firstChild.innerText.includes('INITIALIZING')) { 
            list.innerHTML = ''; 
        }
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
    playSilverBullet() {
        if (!this.enabled) return;
        this.play(880, 'sine', 0.1, 0.1);
        setTimeout(() => this.play(1320, 'sine', 0.15, 0.12), 150);
        setTimeout(() => this.play(1760, 'sine', 0.3, 0.15), 300);
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
let typeWriterTimeout = null;
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
    const isNewsImminent = data.newsArmor?.imminent;

    // Reset classes
    main.classList.remove('protocol-standby', 'protocol-monitoring');

    const narrativeEl = el.querySelector('.p-narrative');
    if (narrativeEl && rec?.tacticalNarrative) {
        narrativeEl.innerText = rec.tacticalNarrative;
    }

    if (rec && rec.action !== 'WAIT' && score >= 80 && rec.isStable && !isNewsImminent) {
        el.className = 'protocol-status-ribbon ready';
        if (text) text.innerText = `PROTOCOL: READY (${rec.action})`;
    } else if (data.markers?.radar?.killzone?.active || isNewsImminent) {
        el.className = 'protocol-status-ribbon warning';
        if (text) text.innerText = isNewsImminent ? 'PROTOCOL: CAUTION (NEWS ARMOR)' : 'PROTOCOL: MONITORING (KILLZONE)';
        if (narrativeEl && isNewsImminent) narrativeEl.innerText = "NEWS ARMOR ACTIVE: High-impact event detected within 30m window. Avoid new entries.";
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
    // Fire OS-level browser push notification for high-conviction Gold Signal
    if (typeof fireGoldSignalNotification === 'function') {
        fireGoldSignalNotification(a.symbol, a.score);
    }
});

function updateUI(data) {
    if (!data) return;
    window.latestInstitutionalData = data; 

    // --- INSTITUTIONAL ALERTS (Audio/Visual Pulse) ---
    const session = data.session || {};
    if (session.isSilverBullet && (!window._lastSBAlert || Date.now() - window._lastSBAlert > 1800000)) {
        window._lastSBAlert = Date.now();
        audioHooter.playSilverBullet();
        if (voiceNarrator.enabled) voiceNarrator.speak("Silver Bullet Algorithm Active. High-priority institutional liquidity hunting in progress.");
        showToast("🎯 SILVER BULLET ACTIVE: High-Priority Algo Window", "BULLISH");
    }

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

        const biasData = data.bias;
        const biasLabel = document.getElementById('bias-label');
        if (biasLabel && biasData) {
            const b = biasData.bias || 'NEUTRAL';
            biasLabel.innerText = b;
            biasLabel.className = 'bias-large ' + (b.includes('BULLISH') ? 'bullish-text' : b.includes('BEARISH') ? 'bearish-text' : '');
            
            // --- BIAS CONFIDENCE BAR ---
            const fillEl = document.getElementById('bias-conf-fill');
            if (fillEl && (data.confluenceScore !== undefined || data.confidence !== undefined)) {
                const score = Math.round(data.confluenceScore || data.confidence || 0);
                fillEl.style.width = `${score}%`;
                fillEl.style.background = score >= 70 ? 'var(--bullish)' : (score <= 30 ? 'var(--bearish)' : 'var(--gold)');
            }
        }

        // --- SILVER BULLET GLOW ---
        if (biasLabel && session.isSilverBullet !== undefined) {
            if (session.isSilverBullet) {
                biasLabel.classList.add('silver-bullet-pulse');
            } else {
                biasLabel.classList.remove('silver-bullet-pulse');
            }
        }

        const narrativePhase = document.getElementById('narrative-phase');
        const narrativeText = document.getElementById('narrative-text');
        const nextPhaseVal = document.getElementById('next-phase-forecast');
        const amdStatusDot = document.getElementById('current-amd-status');

        if (narrativePhase && biasData?.amdPhase) {
            narrativePhase.innerText = (biasData.amdPhase).replace('_', ' ');
            narrativePhase.style.color = (biasData.amdPhase === 'MANIPULATION') ? 'var(--bearish)' : 'var(--gold)';
        }
        if (narrativeText && biasData?.narrative) {
            narrativeText.innerText = biasData.narrative;
        }
        if (nextPhaseVal && biasData?.amdPhase) {
            const phases = ['ACCUMULATION', 'MANIPULATION', 'DISTRIBUTION'];
            const currentIndex = phases.indexOf(biasData.amdPhase);
            if (currentIndex !== -1) {
                nextPhaseVal.innerText = phases[(currentIndex + 1) % 3];
            }
        }
        if (amdStatusDot && data.institutionalRadar) {
            amdStatusDot.innerText = '🟢';
            amdStatusDot.style.animation = 'pulse-opacity 1s infinite alternate';
        }

        if (radarRealityText && biasData) {
            radarRealityText.innerText = biasData.narrative || 'Synchronizing institutional pulse...';
            const b = biasData.bias || '';
            radarRealityText.style.borderLeftColor = b.includes('BULLISH') ? 'var(--bullish)' : (b.includes('BEARISH') ? 'var(--bearish)' : '#94a3b8');
        }

        if (expectedRangeEl && data.expectedMove) {
            expectedRangeEl.innerText = `±$${data.expectedMove.range.toFixed(2)}`;
        }
        // Sync PO3 Expected Range display (separate ID to avoid duplicate conflict)
        const po3RangeEl = document.getElementById('po3-expected-range-val');
        if (po3RangeEl && data.expectedMove) {
            po3RangeEl.innerText = `±$${data.expectedMove.range.toFixed(2)}`;
        }

        // --- FIX 3: ELITE CONFLUENCE CHECKLIST WIRING ---
        if (data.markers && biasData) {
            const m = data.markers;
            const price = data.currentPrice || 0;
            const isAboveMidnight  = price > 0 && m.midnightOpen > 0 && price > m.midnightOpen;
            const isAboveVwap      = price > 0 && m.vwap > 0 && price > m.vwap;
            const killzoneActive   = !!(data.institutionalRadar?.killzone?.active);
            const smtDetected      = !!(data.institutionalRadar?.smt);
            const dxyNegCorr       = !!(data.forexRadar?.isInverseDxyRealm || (data.markers?.dxy && data.bias?.bias?.includes('BULLISH')));
            const sectorAligned    = (data.bias?.bias?.includes('BULLISH') ? 
                Object.values(data.multiTfBias || {}).filter(b => b.includes('BULLISH')).length >= 2 :
                Object.values(data.multiTfBias || {}).filter(b => b.includes('BEARISH')).length >= 2);

            const checkMap = {
                midnight: isAboveMidnight,
                vwap:     isAboveVwap,
                killzone: killzoneActive,
                smt:      smtDetected,
                dxy:      dxyNegCorr,
                sector:   sectorAligned
            };

            Object.entries(checkMap).forEach(([key, active]) => {
                const item = document.querySelector(`.conf-item[data-conf="${key}"]`);
                if (!item) return;
                const dot = item.querySelector('.conf-indicator');
                const label = item.querySelector('span');
                if (dot) {
                    dot.style.background = active ? 'var(--bullish)' : '#1a1a1a';
                    dot.style.borderColor = active ? 'var(--bullish)' : 'rgba(255,255,255,0.1)';
                    dot.style.boxShadow = active ? '0 0 6px var(--bullish)' : 'none';
                }
                if (label) {
                    label.style.color = active ? 'var(--text-bright)' : 'var(--text-dim)';
                }
            });
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

        // 5. --- RECOMMENDATION (GOLD STANDARD) ---
        const recBox = document.getElementById('rec-box');
        if (data.recommendation && recBox) {
            const rec = data.recommendation;
            const recAction    = document.getElementById('rec-action');
            const recConfidence = document.getElementById('rec-confidence');
            const recStrike    = document.getElementById('rec-strike');
            const recTarget    = document.getElementById('rec-target');
            const recTrim      = document.getElementById('rec-trim');
            const recSl        = document.getElementById('rec-sl');
            const recRr        = document.getElementById('rec-rr');
            const recSize      = document.getElementById('rec-size');
            const recRationale = document.getElementById('rec-rationale');

            const action = rec.action || 'WAIT';
            const isCall = action.includes('CALL');
            const isPut  = action.includes('PUT');
            const isWait = action === 'WAIT';

            if (recAction) {
                recAction.innerText = action;
                recAction.style.color = isCall ? 'var(--bullish)' : (isPut ? 'var(--bearish)' : 'var(--text-dim)');
            }

            const conf = Math.round(rec.confidence || data.confluenceScore || 0);
            if (recConfidence) {
                recConfidence.innerText = conf + '%';
                recConfidence.style.color = conf >= 70 ? 'var(--bullish)' : (conf >= 50 ? 'var(--gold)' : 'var(--text-dim)');
            }

            if (recStrike)  recStrike.innerText  = rec.strike  || '-';
            if (recTarget)  recTarget.innerText  = rec.target  || '-';
            if (recTrim)    recTrim.innerText     = rec.trim    || '-';
            if (recSl)      recSl.innerText       = rec.sl      || '-';

            if (recRr) {
                const rr = rec.rrRatio || '0.0';
                recRr.innerText = `1:${rr}`;
                recRr.style.color = parseFloat(rr) >= 2.0 ? 'var(--bullish)' : (parseFloat(rr) >= 1.5 ? 'var(--gold)' : 'var(--bearish)');
            }

            if (recSize) recSize.innerText = rec.size || '-';
            if (recRationale) recRationale.innerText = rec.rationale || 'SCANNING INSTITUTIONAL LIQUIDITY...';

            recBox.className = 'rec-box ' + (isCall ? 'rec-call' : (isPut ? 'rec-put' : ''));

            // --- MTF Alignment Dots ---
            const mtf = data.multiTfBias || {};
            const mtfMap = { '1m': 'mtf-dot-1m', '5m': 'mtf-dot-5m', '15m': 'mtf-dot-15m', '1h': 'mtf-dot-1h' };
            const primaryBias = (data.bias?.bias || '').includes('BULLISH') ? 'BULLISH' : 'BEARISH';
            Object.entries(mtfMap).forEach(([tf, dotId]) => {
                const dot = document.getElementById(dotId);
                if (!dot) return;
                const tfBias = mtf[tf] || '';
                const aligned = tfBias.includes(primaryBias);
                dot.style.background = aligned ? 'var(--bullish)' : (tfBias ? 'var(--bearish)' : 'rgba(255,255,255,0.15)');
                dot.style.boxShadow  = aligned ? '0 0 6px var(--bullish)' : 'none';
            });
        }

        // 6. --- EXTERNAL CALLS (HARDENED) ---
        const executeUpdate = (fn, name) => {
            if (typeof fn === 'function') {
                try { fn(data); } catch (e) { console.warn(`[UI] ${name} failed:`, e); }
            }
        };

        executeUpdate(updateMacroCorrelation, 'Macro Correlation');
        executeUpdate(updateTier1Panel, 'Tier1 Edge Panel');
        executeUpdate(updateInstitutionalRadar, 'Radar');
        executeUpdate(updateStrikeZones, 'StrikeZones');
        executeUpdate(updateBlockFeed, 'BlockFeed');
        executeUpdate(updateWatchlist, 'Watchlist');
        executeUpdate(updateIntelTicker, 'IntelTicker');
        executeUpdate(updateSpiderMatrix, 'SpiderMatrix');
        executeUpdate(updateProtocolStatus, 'ProtocolStatus');
        executeUpdate(updateChartOverlays, 'ChartOverlays');
        executeUpdate(updateChecklist, 'Checklist');
        executeUpdate(updateMarketTicker, 'Market Ticker');
        executeUpdate(updateForexRadar, 'ForexRadar');
        executeUpdate(updateOptionChainSnapshot, 'OptionChain');
        executeUpdate(updateCatalystCalendar, 'CatalystCalendar');
        executeUpdate(updateEventPulse, 'EventPulse');
        executeUpdate(updateTradeGuardian, 'TradeGuardian');

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
        
        // Update scanning status with active symbol to prove it's working
        const scanStatus = placeholder.querySelector('div:first-child');
        if (scanStatus) scanStatus.innerText = `SCANNING ${data.symbol || 'SPY'} OPTION CHAIN`;

        // Update scanning confluence
        if (confVal) {
            const hasRealData = (data.bias && data.bias.confluenceScore !== undefined);
            const realConf = hasRealData ? data.bias.confluenceScore : Math.floor(40 + Math.random() * 25);
            confVal.innerText = `CONFLUENCE: ${realConf}%`;
            confVal.style.color = hasRealData ? 'rgba(56, 189, 248, 0.8)' : 'rgba(255,255,255,0.4)';
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
    // Deprecated: UI Removed. G7 Spider Matrix remains as main Forex focus.
}

// =============================================================================
// TIER 1 INSTITUTIONAL EDGE PANEL — Live UI Renderer
// =============================================================================
function updateTier1Panel(data) {
    const rec = data.recommendation || {};
    const t1  = rec.tier1 || data.markers; // fallback: read from markers directly
    if (!t1) return;

    const price = data.currentPrice || 0;
    const isFX  = (data.symbol || '').includes('=X');
    const prec  = isFX ? 5 : 2;

    // ── T1-A: VWAP Deviation Bands ────────────────────────────────────────────
    const vb   = t1.vwapBands || data.markers?.vwapBands;
    const vwapZoneEl = document.getElementById('t1-vwap-zone');
    const vwapB1El   = document.getElementById('t1-vwap-b1');
    const vwapB2El   = document.getElementById('t1-vwap-b2');
    if (vb && vb.stdev > 0 && vwapZoneEl) {
        const deviation = (price - vb.vwap) / vb.stdev;
        const absD = Math.abs(deviation);
        let zoneLabel, zoneColor;
        if (absD >= 3)      { zoneLabel = `${deviation > 0 ? '+' : ''}${deviation.toFixed(1)}σ ⛔ EXTREME`; zoneColor = '#f43f5e'; }
        else if (absD >= 2) { zoneLabel = `${deviation > 0 ? '+' : ''}${deviation.toFixed(1)}σ ⚠️ FADE ZONE`; zoneColor = '#f97316'; }
        else if (absD >= 1) { zoneLabel = `${deviation > 0 ? '+' : ''}${deviation.toFixed(1)}σ EXTENDED`; zoneColor = 'var(--gold)'; }
        else                { zoneLabel = `${deviation > 0 ? '+' : ''}${deviation.toFixed(1)}σ NEAR VWAP`; zoneColor = 'var(--bullish)'; }
        vwapZoneEl.innerText = zoneLabel;
        vwapZoneEl.style.color = zoneColor;
        if (vwapB1El) vwapB1El.innerText = `${vb.b1Upper.toFixed(prec)} / ${vb.b1Lower.toFixed(prec)}`;
        if (vwapB2El) vwapB2El.innerText = `${vb.b2Upper.toFixed(prec)} / ${vb.b2Lower.toFixed(prec)}`;
    }

    // ── T1-B: RVOL ────────────────────────────────────────────────────────────
    const rvol     = t1.rvol || data.markers?.rvol;
    const rvolVal  = document.getElementById('t1-rvol-val');
    const rvolBar  = document.getElementById('t1-rvol-bar');
    const rvolLbl  = document.getElementById('t1-rvol-label');
    if (rvol && rvolVal) {
        const rColor = rvol.rvol >= 2.0 ? '#f43f5e' : rvol.rvol >= 1.5 ? 'var(--bullish)' : rvol.rvol >= 0.8 ? 'var(--gold)' : 'var(--bearish)';
        rvolVal.innerText = `${rvol.rvol.toFixed(2)}×`;
        rvolVal.style.color = rColor;
        if (rvolBar) { rvolBar.style.width = Math.min(100, rvol.rvol * 40) + '%'; rvolBar.style.background = rColor; }
        if (rvolLbl) { rvolLbl.innerText = rvol.label; rvolLbl.style.color = rColor; }
    }

    // ── T1-C: ORB ─────────────────────────────────────────────────────────────
    const orb      = t1.orb || data.markers?.orb;
    const orbLabel = document.getElementById('t1-orb-label');
    const orbHigh  = document.getElementById('t1-orb-high');
    const orbLow   = document.getElementById('t1-orb-low');
    if (orb && orbLabel) {
        const orbColor = orb.breakout === 'BULLISH' ? 'var(--bullish)' : orb.breakout === 'BEARISH' ? 'var(--bearish)' : 'var(--text-dim)';
        orbLabel.innerText   = orb.label || 'N/A';
        orbLabel.style.color = orbColor;
        if (orbHigh) orbHigh.innerText = orb.orbHigh ? `$${orb.orbHigh}` : '--';
        if (orbLow)  orbLow.innerText  = orb.orbLow  ? `$${orb.orbLow}`  : '--';
    }

    // ── T1-D: Gap Fill ────────────────────────────────────────────────────────
    const gap      = t1.gapFill || data.markers?.gapFill;
    const gapLbl   = document.getElementById('t1-gap-label');
    const gapProb  = document.getElementById('t1-gap-prob-val');
    const gapTgt   = document.getElementById('t1-gap-target');
    if (gapLbl) {
        if (gap && gap.hasGap) {
            const gapColor = gap.alreadyFilled ? 'var(--bullish)' : gap.isHighRisk ? '#f97316' : 'var(--gold)';
            gapLbl.innerText   = gap.label;
            gapLbl.style.color = gapColor;
            if (gapProb) { gapProb.innerText = `${gap.fillProb}%`; gapProb.style.color = gapColor; }
            if (gapTgt)  { gapTgt.innerText  = `FILL TARGET: $${gap.fillTarget}`; }
        } else {
            gapLbl.innerText   = 'NO SIGNIFICANT GAP';
            gapLbl.style.color = 'var(--text-dim)';
            if (gapProb) { gapProb.innerText = '--'; gapProb.style.color = 'var(--text-dim)'; }
        }
    }

    // ── T1-E: Equal Highs / Lows ──────────────────────────────────────────────
    const eq     = t1.equalLevels || data.markers?.equalLevels;
    const eqHighEl = document.getElementById('t1-eq-highs');
    const eqLowEl  = document.getElementById('t1-eq-lows');
    if (eq && eqHighEl && eqLowEl) {
        if (eq.equalHighs.length > 0) {
            const top = eq.equalHighs[0];
            const nearH = Math.abs(price - top.level) / price < 0.003;
            eqHighEl.innerText = `EQH: $${top.level} (${top.count}×)${nearH ? ' 🎯PROXIMITY' : ''}`;
            eqHighEl.style.color = nearH ? '#f97316' : 'var(--bullish)';
        } else {
            eqHighEl.innerText = 'EQH: NONE DETECTED'; eqHighEl.style.color = 'var(--text-dim)';
        }
        if (eq.equalLows.length > 0) {
            const bot = eq.equalLows[0];
            const nearL = Math.abs(price - bot.level) / price < 0.003;
            eqLowEl.innerText = `EQL: $${bot.level} (${bot.count}×)${nearL ? ' 🎯PROXIMITY' : ''}`;
            eqLowEl.style.color = nearL ? '#f97316' : 'var(--bearish)';
        } else {
            eqLowEl.innerText = 'EQL: NONE DETECTED'; eqLowEl.style.color = 'var(--text-dim)';
        }
    }

    // ── T1-F: Volatility Regime ───────────────────────────────────────────────
    const vr    = t1.volRegime || rec.volRegime;
    const vrLbl  = document.getElementById('t1-vol-regime-label');
    const vrBar  = document.getElementById('t1-vol-regime-bar');
    const vrRat  = document.getElementById('t1-vol-ratio');
    if (vr && vrLbl) {
        vrLbl.innerText   = vr.regime;
        vrLbl.style.color = vr.color;
        if (vrBar) { vrBar.style.width = Math.min(100, (vr.ratio || 1) * 40) + '%'; vrBar.style.background = vr.color; }
        if (vrRat) vrRat.innerText = `ATR RATIO: ${(vr.ratio || 1).toFixed(2)}×`;
    }

    // ── T1-G: Volume Point of Control (VPoC) 
    const vpoc = t1.vpoc || data.markers?.vpoc;
    const vpocVal = document.getElementById('t1-vpoc-val');
    const vpocZne = document.getElementById('t1-vpoc-zone');
    if (vpoc && vpocVal && vpocZne) {
        vpocVal.innerText = `$${vpoc.vpoc}`;
        vpocZne.innerText = vpoc.currentZone;
        vpocZne.style.color = vpoc.currentZone === 'PREMIUM' ? '#f43f5e' : (vpoc.currentZone === 'DISCOUNT' ? 'var(--bullish)' : 'var(--gold)');
        document.getElementById('t1-vpoc-vah').innerText = `$${vpoc.vah}`;
        document.getElementById('t1-vpoc-val-span').innerText = `$${vpoc.val}`;
    }

    // ── T1-H: Macro Divergence 
    const mac = t1.macroDivergence || data.markers?.macroDivergence;
    const macLabel = document.getElementById('t1-macro-label');
    const macRat   = document.getElementById('t1-macro-rat');
    if (mac && macLabel && macRat) {
        macLabel.innerText = mac.label;
        macRat.innerText = mac.rationale;
        macLabel.style.color = mac.type === 'BEARISH FAKEOUT' ? 'var(--bearish)' : (mac.type === 'BULLISH ACCUMULATION' ? 'var(--bullish)' : 'var(--text-dim)');
    }
}

// =============================================================================
// OPTION A: ENTRY POINT TRACKER — Position Conviction Monitor
// Persists your trade entry in localStorage. Computes live P&L, health & invalidation.
// =============================================================================
const TG_ENTRY_KEY = 'bias_tg_entry_price';
window._tgEntryPrice = parseFloat(localStorage.getItem(TG_ENTRY_KEY)) || 0;
window._tgLastData   = null; // Latest data snapshot for live updates

function setTradeGuardianEntry() {
    const input = document.getElementById('tg-entry-price-input');
    if (!input) return;
    const val = parseFloat(input.value);
    if (!val || val <= 0) { showToast('⚠️ Enter a valid entry price', 'toast-smt'); return; }
    window._tgEntryPrice = val;
    localStorage.setItem(TG_ENTRY_KEY, val);
    document.getElementById('tg-pnl-panel').style.display = 'block';
    showToast(`📍 Entry set at $${val.toFixed(2)} — monitoring conviction`, 'toast-gold');
    if (window._tgLastData) _updateEntryTracker(window._tgLastData);
}

function clearTradeGuardianEntry() {
    window._tgEntryPrice = 0;
    localStorage.removeItem(TG_ENTRY_KEY);
    const input = document.getElementById('tg-entry-price-input');
    if (input) input.value = '';
    const panel = document.getElementById('tg-pnl-panel');
    if (panel) panel.style.display = 'none';
    const badge = document.getElementById('tg-position-health-badge');
    if (badge) { badge.innerText = 'NO POSITION'; badge.style.color = 'var(--text-dim)'; badge.style.borderColor = 'rgba(255,255,255,0.1)'; badge.style.background = 'rgba(255,255,255,0.05)'; }
}

function _updateEntryTracker(data) {
    window._tgLastData = data;
    const entry = window._tgEntryPrice;
    if (!entry || entry <= 0) return;

    const price   = data.currentPrice || 0;
    const markers = data.markers || {};
    const bias    = data.bias || {};
    const isBull  = (bias.bias || '').includes('BULLISH');
    const isFX    = (data.symbol || '').includes('=X');
    const prec    = isFX ? 5 : 2;

    // ── 1. UNREALIZED P&L ────────────────────────────────────────────────────
    const rawPnl  = price - entry;
    const pnlPct  = entry > 0 ? (rawPnl / entry) * 100 : 0;
    const pnlSign = rawPnl >= 0 ? '+' : '';
    const pnlColor = rawPnl >= 0 ? 'var(--bullish)' : 'var(--bearish)';

    const dollarEl = document.getElementById('tg-pnl-dollar');
    const pctEl    = document.getElementById('tg-pnl-pct');
    if (dollarEl) { dollarEl.innerText = `${pnlSign}$${Math.abs(rawPnl).toFixed(prec)}`; dollarEl.style.color = pnlColor; }
    if (pctEl)    { pctEl.innerText    = `${pnlSign}${pnlPct.toFixed(2)}%`; pctEl.style.color = pnlColor; }

    // ── 2. INVALIDATION PRICE — nearest key structure below/above entry ───────
    // For a BULL trade: invalidation is below Midnight Open (lost premise)
    //   OR below VWAP if Midnight Open isn't available
    // For a BEAR trade: invalidation is above Midnight Open
    const midOpen  = markers.midnightOpen || 0;
    const vwap     = markers.vwap || 0;
    const pdh      = markers.pdh || 0;
    const pdl      = markers.pdl || 0;

    let invalidPrice  = 0;
    let invalidLabel  = '';

    if (isBull) {
        // Bull invalidation: price breaks below its key structural support
        if (midOpen > 0 && entry > midOpen)                { invalidPrice = midOpen; invalidLabel = 'BELOW MIDNIGHT OPEN'; }
        else if (vwap > 0 && entry > vwap)                 { invalidPrice = vwap;    invalidLabel = 'BELOW VWAP ANCHOR'; }
        else if (pdl > 0)                                  { invalidPrice = pdl;     invalidLabel = 'BELOW PREV DAY LOW'; }
        else                                               { invalidPrice = entry * 0.99; invalidLabel = 'ATR STOP ZONE'; }
    } else {
        // Bear invalidation: price breaks above its key structural resistance
        if (midOpen > 0 && entry < midOpen)                { invalidPrice = midOpen; invalidLabel = 'ABOVE MIDNIGHT OPEN'; }
        else if (vwap > 0 && entry < vwap)                 { invalidPrice = vwap;    invalidLabel = 'ABOVE VWAP ANCHOR'; }
        else if (pdh > 0)                                  { invalidPrice = pdh;     invalidLabel = 'ABOVE PREV DAY HIGH'; }
        else                                               { invalidPrice = entry * 1.01; invalidLabel = 'ATR STOP ZONE'; }
    }

    const invPriceEl = document.getElementById('tg-invalidation-price');
    const invLabelEl = document.getElementById('tg-invalidation-label');
    if (invPriceEl) invPriceEl.innerText = `$${invalidPrice.toFixed(prec)}`;
    if (invLabelEl) invLabelEl.innerText = invalidLabel;

    // ── 3. POSITION HEALTH SCORE (0→100) ─────────────────────────────────────
    // Based on: conviction score (from TG), P&L direction alignment, distance from invalidation
    const tgScore     = parseFloat(document.getElementById('tg-conviction-pct')?.innerText) || 50;
    const pnlAligned  = (isBull && rawPnl >= 0) || (!isBull && rawPnl <= 0);

    // Distance to invalidation as % of entry — how far are we from stopping out?
    const distToInvalidation = invalidPrice > 0 ? Math.abs(price - invalidPrice) / price : 0.01;
    const invalidProximity   = Math.min(100, distToInvalidation * 1000); // 0% = at invalidation, 100% = far away

    // Weight: 50% conviction, 25% P&L direction, 25% distance from invalidation
    let healthScore = (tgScore * 0.50) + (pnlAligned ? 25 : 0) + (invalidProximity * 0.25);
    healthScore = Math.max(0, Math.min(100, healthScore));

    // Health bucket
    let healthLabel, healthColor, badgeText, badgeBg, badgeBorder;
    if (healthScore >= 65) {
        healthLabel = 'STRONG — HOLD POSITION';     healthColor = 'var(--bullish)';
        badgeText = '🟢 HOLD';  badgeBg = 'rgba(16,185,129,0.15)'; badgeBorder = 'rgba(16,185,129,0.4)';
    } else if (healthScore >= 40) {
        healthLabel = 'WEAKENING — TIGHTEN STOP';   healthColor = 'var(--gold)';
        badgeText = '🟡 MANAGE'; badgeBg = 'rgba(245,158,11,0.15)'; badgeBorder = 'rgba(245,158,11,0.4)';
    } else {
        healthLabel = 'CRITICAL — REVIEW EXIT';     healthColor = 'var(--bearish)';
        badgeText = '🔴 EXIT';  badgeBg = 'rgba(239,68,68,0.15)';  badgeBorder = 'rgba(239,68,68,0.4)';
    }

    const healthBarEl   = document.getElementById('tg-health-bar');
    const healthLabelEl = document.getElementById('tg-health-label');
    const badgeEl       = document.getElementById('tg-position-health-badge');
    const contextEl     = document.getElementById('tg-position-context');

    if (healthBarEl)   { healthBarEl.style.width = healthScore + '%'; healthBarEl.style.background = healthColor; }
    if (healthLabelEl) { healthLabelEl.innerText = healthLabel.split(' — ')[0]; healthLabelEl.style.color = healthColor; }
    if (badgeEl)       { badgeEl.innerText = badgeText; badgeEl.style.background = badgeBg; badgeEl.style.borderColor = badgeBorder; badgeEl.style.color = '#fff'; }

    // ── 4. CONTEXT NARRATIVE ──────────────────────────────────────────────────
    const vwapSide   = price > vwap   ? 'above VWAP' : 'below VWAP';
    const midSide    = price > midOpen ? 'above Midnight Open' : 'below Midnight Open';
    const onSide     = (isBull && price > vwap) || (!isBull && price < vwap);
    let context;
    if (healthScore >= 65) {
        context = `Price ${vwapSide} and ${midSide}. Thesis intact. ${pnlAligned ? 'Moving in your direction.' : 'Consolidating — monitor closely.'}`;
    } else if (healthScore >= 40) {
        context = `Structure weakening. Price ${midSide}. Consider moving SL to break-even ($${entry.toFixed(prec)}).`;
    } else {
        context = `⚠️ CRITICAL: Price approaching invalidation at $${invalidPrice.toFixed(prec)}. Review position immediately.`;
    }
    if (contextEl) contextEl.innerText = context;

    // Show the panel
    const panel = document.getElementById('tg-pnl-panel');
    if (panel && panel.style.display === 'none') panel.style.display = 'block';
}

// Wire entry tracker into the updateTradeGuardian flow — called at end of each tick
// Restore entry price input from localStorage on page load
(function restoreEntryTracker() {
    const saved = parseFloat(localStorage.getItem(TG_ENTRY_KEY));
    if (saved && saved > 0) {
        const input = document.getElementById('tg-entry-price-input');
        if (input) input.value = saved.toFixed(2);
        const panel = document.getElementById('tg-pnl-panel');
        if (panel) panel.style.display = 'block';
    }
})();


// =============================================================================
// OPTION C: MACRO CORRELATION — Dynamic Live Feed
// Replaces hardcoded fallbacks. Reads live VIX, DXY, breadth, and RORO tone.
// =============================================================================
function updateMacroCorrelation(data) {
    if (!data) return;

    const internals = data.bias?.internals || {};
    const vix      = internals.vix    || 0;
    const dxy      = internals.dxy    || 0;
    const breadth  = internals.breadth || 50;
    const tnx      = internals.tnx    || 0;
    const roro     = data.roro || {};

    // ── VIX Regime ───────────────────────────────────────────────────────────
    const vixEl  = document.getElementById('vix-val-regime');
    const vixM   = document.getElementById('vix-val-macro');
    if (vixEl && vix > 0) {
        const vixRegime = vix < 15 ? 'COMPLACENCY' : vix < 20 ? 'LOW FEAR' : vix < 28 ? 'ELEVATED' : 'CRISIS MODE';
        const vixColor  = vix < 15 ? 'var(--bullish)' : vix < 20 ? 'var(--gold)' : vix < 28 ? '#f97316' : 'var(--bearish)';
        vixEl.innerText = vixRegime;
        vixEl.style.color = vixColor;
    }
    if (vixM && vix > 0) {
        vixM.innerText = vix.toFixed(1);
        vixM.style.color = vix > 20 ? 'var(--bearish)' : vix > 15 ? 'var(--gold)' : 'var(--bullish)';
    }

    // ── DXY Anchor ───────────────────────────────────────────────────────────
    const dxyBadge = document.getElementById('dxy-anchor-badge');
    if (dxyBadge && dxy > 0) {
        const dxyChange = internals.dxyChange || 0;
        const dxyTrend  = dxyChange > 0.1 ? '↑ RISING' : dxyChange < -0.1 ? '↓ FALLING' : '→ FLAT';
        const dxyColor  = dxyChange > 0.1 ? '#f87171' : dxyChange < -0.1 ? 'var(--bullish)' : 'var(--text-dim)';
        dxyBadge.innerText = `DXY: ${dxy.toFixed(2)} ${dxyTrend}`;
        dxyBadge.style.color = dxyColor;
        dxyBadge.style.borderColor = dxyColor;
    }

    // ── RORO Score ───────────────────────────────────────────────────────────
    if (roro.score !== undefined) {
        const roroLabelEl = document.getElementById('roro-label');
        const roroScoreEl = document.getElementById('roro-score');
        const roroPctEl   = document.getElementById('roro-pct');
        const roroBarEl   = document.getElementById('roro-bar');
        const roroBarColor = roro.score >= 60 ? 'var(--bullish)' : roro.score <= 40 ? 'var(--bearish)' : 'var(--gold)';
        if (roroLabelEl) { roroLabelEl.innerText = roro.label || 'NEUTRAL'; roroLabelEl.style.color = roroBarColor; }
        if (roroScoreEl) { roroScoreEl.innerText = Math.round(roro.score); roroScoreEl.style.color = roroBarColor; }
        if (roroPctEl)   { roroPctEl.innerText   = Math.round(roro.score) + '%'; }
        if (roroBarEl)   { roroBarEl.style.width  = roro.score + '%'; roroBarEl.style.background = roroBarColor; }
    }

    // ── Market Breadth ────────────────────────────────────────────────────────
    const breadthEl  = document.getElementById('breadth-val');
    const breadthBar = document.getElementById('breadth-bar');
    if (breadthEl && breadth > 0) {
        const breadthColor = breadth > 60 ? 'var(--bullish)' : breadth < 40 ? 'var(--bearish)' : 'var(--gold)';
        breadthEl.innerText = breadth.toFixed(0) + '%';
        breadthEl.style.color = breadthColor;
        if (breadthBar) { breadthBar.style.width = breadth + '%'; breadthBar.style.background = breadthColor; }
    }

    // ── 10Y Yield ─────────────────────────────────────────────────────────────
    const tnxEl = document.getElementById('tnx-val');
    if (tnxEl && tnx > 0) {
        tnxEl.innerText = tnx.toFixed(2) + '%';
        tnxEl.style.color = tnx > 4.3 ? 'var(--bearish)' : tnx < 4.0 ? 'var(--bullish)' : 'var(--text-dim)';
    }

    // ── Sectors Grid ─────────────────────────────────────────────────────────
    const sectors = internals.sectors || [];
    sectors.forEach(sec => {
        const el = document.getElementById('sector-' + (sec.symbol || '').replace('^','').toLowerCase());
        if (!el) return;
        const chg = sec.change || 0;
        el.innerText = (chg >= 0 ? '+' : '') + chg.toFixed(2) + '%';
        el.style.color = chg > 0 ? 'var(--bullish)' : chg < 0 ? 'var(--bearish)' : 'var(--text-dim)';
    });

    // ── Validate stale zero data ──────────────────────────────────────────────
    // If vix, dxy and breadth are ALL still zero (cold boot), show a subtle syncing state
    const allZero = (vix === 0 && dxy === 0);
    if (allZero) {
        if (dxyBadge) { dxyBadge.innerText = 'DXY ANCHOR: SYNCING...'; dxyBadge.style.color = 'var(--text-dim)'; }
        if (vixEl)    { vixEl.innerText = 'SYNCING'; vixEl.style.color = 'var(--text-dim)'; }
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
    const grid    = document.getElementById('spider-grid');
    const status  = document.getElementById('basket-alignment');
    if (!grid || !data.basket) return;

    const basket = data.basket;

    // Build sorted list (strongest → weakest) for leaders & best pair
    const sorted = Object.entries(basket).sort((a, b) => b[1].perf - a[1].perf);
    if (sorted.length === 0) return; // guard: basket arrived empty

    const strongest = sorted[0];
    const weakest   = sorted[sorted.length - 1];
    const divergence = strongest[1].perf - weakest[1].perf;

    // ── FIX #3: DYNAMIC BAR NORMALIZATION ─────────────────────────────────────
    // Scale to session's actual max spread so the full range is always visible.
    // Minimum anchor: ±0.15% to avoid wild bars in ultra-quiet markets.
    const allPerfs   = sorted.map(([, v]) => v.perf);
    const sessionMax = Math.max(0.15, Math.max(...allPerfs.map(Math.abs)));

    sorted.forEach(([cur, val]) => {
        const node = grid.querySelector('[data-cur="' + cur + '"]');
        if (!node) return;

        const valEl  = node.querySelector('.val');
        const fillEl = node.querySelector('.strength-bar-fill');
        const perf   = val.perf || 0;

        // Value text
        if (valEl) {
            valEl.innerText = (perf >= 0 ? '+' : '') + perf.toFixed(2) + '%';
        }

        // Dynamic strength bar: center at 50%, scale by session max
        const strengthNormalized = Math.max(5, Math.min(95, 50 + (perf / sessionMax) * 42));
        if (fillEl) {
            fillEl.style.width      = strengthNormalized + '%';
            // USD always cyan; others bullish/bearish/neutral
            if (cur === 'USD') {
                fillEl.style.background = '#00f2ff';
            } else {
                fillEl.style.background = perf > 0 ? 'var(--bullish)' : (perf < 0 ? 'var(--bearish)' : 'rgba(255,255,255,0.2)');
            }
        }

        // Leader / laggard glow classes
        node.classList.remove('node-leader', 'node-laggard');
        const rank = sorted.findIndex(([c]) => c === cur);
        if (rank < 2 && perf > 0.08) node.classList.add('node-leader');
        if (rank > sorted.length - 3 && perf < -0.08) node.classList.add('node-laggard');

        // Background color coding
        if (perf > 0.05) {
            valEl && (valEl.style.color = 'var(--bullish)');
            node.style.background = cur === 'USD' ? 'rgba(0,180,255,0.07)' : 'rgba(16,185,129,0.08)';
        } else if (perf < -0.05) {
            valEl && (valEl.style.color = 'var(--bearish)');
            node.style.background = cur === 'USD' ? 'rgba(0,180,255,0.04)' : 'rgba(244,63,94,0.08)';
        } else {
            valEl && (valEl.style.color = 'var(--text-dim)');
            node.style.background = cur === 'USD' ? 'rgba(0,180,255,0.03)' : 'rgba(255,255,255,0.02)';
        }

        const isMegaMove = Math.abs(perf) > 0.40;
        if (isMegaMove) {
            node.style.borderColor = 'var(--gold)';
            node.style.boxShadow   = '0 0 15px rgba(212,175,55,0.2)';
        } else if (cur === 'USD') {
            node.style.borderColor = 'rgba(0,180,255,0.2)';
            node.style.boxShadow   = 'none';
        } else {
            node.style.borderColor = 'rgba(255,255,255,0.05)';
            node.style.boxShadow   = 'none';
        }

        // MTF dots (unchanged logic, now using 4px dots with labels in HTML)
        if (val.mtf) {
            const dots = node.querySelectorAll('.tf-dot');
            ['1m', '5m', '1h'].forEach((tf, i) => {
                const tfVal = val.mtf[tf];
                if (dots[i]) {
                    dots[i].style.background = tfVal > 0.05 ? 'var(--bullish)' : (tfVal < -0.05 ? 'var(--bearish)' : 'rgba(255,255,255,0.1)');
                    dots[i].style.opacity    = Math.abs(tfVal) > 0.02 ? '1' : '0.3';
                }
            });
        }

        // ── FIX #4: EXHAUSTION BADGE — threshold lowered to ±0.6% ────────────
        const badge = node.querySelector('.exhaustion-badge');
        if (badge) {
            if (val.isSupplied || val.isDepleted) {
                badge.style.display    = 'block';
                badge.innerText        = val.isSupplied ? 'SUPPLY ZONE' : 'DEMAND ZONE';
                badge.style.background = val.isSupplied ? 'var(--bearish)' : 'var(--bullish)';
                badge.style.color      = '#fff';
            } else if (val.isOverextended) {
                badge.style.display    = 'block';
                badge.innerText        = 'EXTENDED';
                badge.style.background = 'var(--gold)';
                badge.style.color      = '#000';
            } else {
                badge.style.display = 'none';
            }
        }
    });

    // ── FIX #5: TOP / WEAK LEADER ROW ────────────────────────────────────────
    const topCurEl  = document.getElementById('g7-top-cur');
    const topValEl  = document.getElementById('g7-top-val');
    const weakCurEl = document.getElementById('g7-weak-cur');
    const weakValEl = document.getElementById('g7-weak-val');

    if (topCurEl)  topCurEl.innerText  = strongest[0];
    if (topValEl)  topValEl.innerText  = (strongest[1].perf >= 0 ? '+' : '') + strongest[1].perf.toFixed(2) + '%';
    if (weakCurEl) weakCurEl.innerText = weakest[0];
    if (weakValEl) weakValEl.innerText = (weakest[1].perf >= 0 ? '+' : '') + weakest[1].perf.toFixed(2) + '%';

    // ── FIX #1: BEST PAIR RECOMMENDATION ─────────────────────────────────────
    // Strongest vs Weakest = best institutional pair to trade.
    // Direction: If strongest is a base currency in the pair, we BUY; if it's quote, we SELL.
    const bestPairEl = document.getElementById('g7-best-pair');
    const bestDirEl  = document.getElementById('g7-best-dir');
    if (bestPairEl && bestDirEl && strongest && weakest) {
        const topCur  = strongest[0];
        const weakCur = weakest[0];
        // Build standard pair notation (base/quote): strongest first → always a BUY
        const pair    = topCur + '/' + weakCur;
        const spread  = divergence.toFixed(2);
        bestPairEl.innerText = pair;
        bestDirEl.innerText  = 'LONG ' + topCur + ' | Δ ' + spread + '%';

        // Color the pair and dir based on divergence strength
        const pairColor = divergence > 0.7 ? 'var(--gold)' : (divergence > 0.3 ? 'var(--bullish)' : 'var(--text-dim)');
        bestPairEl.style.color = pairColor;
        bestDirEl.style.color  = pairColor;
    }

    // ── BASKET ALIGNMENT HEADER (unchanged format, still shows GAP + realm) ──
    if (status) {
        const isAligned = data.isBasketAligned;
        status.innerHTML = 'GAP: ' + divergence.toFixed(2) + '% | ' + (isAligned
            ? '<span style="color:var(--gold)">TREND REALM</span>'
            : '<span style="color:var(--text-dim)">RANGING</span>');
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

    // Capture IDs of current items to avoid double-posting
    const existingIds = new Set(Array.from(feed.children).map(c => c.getAttribute('data-id')));

    data.blockTrades.slice(-10).forEach(block => {
        const blockId = block.symbol + '-' + block.time + '-' + block.size;
        if (existingIds.has(blockId)) return;

        const div = document.createElement('div');
        div.setAttribute('data-id', blockId);
        div.style.cssText = 'padding: 4px 8px; border-bottom: 1px solid rgba(255,255,255,0.05); font-size: 0.55rem; display: flex; justify-content: space-between; align-items: center;';

        const isBuy = block.type === 'BUY';
        const color = isBuy ? 'var(--bullish)' : 'var(--bearish)';

        div.innerHTML = '<span style="font-weight: 800; color: #fff;">' + block.symbol + '</span>'
            + '<span style="color: ' + color + '; font-weight: 900;">$' + (block.value / 1000).toFixed(0) + 'K ' + (isBuy ? '▲' : '▼') + '</span>'
            + '<span style="color: var(--text-dim); opacity: 0.7;">@ ' + block.price + '</span>';

        feed.prepend(div);
        if (feed.children.length > 15) feed.lastChild.remove();
    });
}

function updateAIAnalyst(insight) {
    if (!insight) return;

    // ----------------------------------------------------------------
    // 1. CONFIDENCE ARC GAUGE
    // Arc circumference ≈ 88 units. Fill proportionally to probability.
    // ----------------------------------------------------------------
    const pct  = Math.min(99, Math.max(0, insight.probability || 0));
    const arcEl = document.getElementById('ai-arc-fill');
    const convEl = document.getElementById('ai-conviction');

    if (arcEl) {
        const filled = (pct / 100) * 88;
        arcEl.setAttribute('stroke-dasharray', `${filled} ${88 - filled}`);
        const arcColor = pct >= 70 ? 'var(--bullish)' : pct >= 45 ? 'var(--gold)' : 'var(--bearish)';
        arcEl.style.stroke = arcColor;
    }
    if (convEl) {
        convEl.textContent = pct + '%';
        convEl.style.color = pct >= 70 ? 'var(--bullish)' : pct >= 45 ? 'var(--gold)' : 'var(--bearish)';
    }

    // ----------------------------------------------------------------
    // 2. STRATEGIC ACTION — color-coded with badge class
    // ----------------------------------------------------------------
    const actionEl = document.getElementById('ai-action');
    if (actionEl) {
        actionEl.textContent = insight.action;
        const act = insight.action || '';
        if (act.includes('CALL') || act.includes('BULLISH') || act.includes('ACCUMULATE')) {
            actionEl.className = 'ai-action-value bullish-text';
        } else if (act.includes('PUT') || act.includes('BEARISH') || act.includes('FLATTEN') || act.includes('PROTECT')) {
            actionEl.className = 'ai-action-value bearish-text';
        } else if (act.includes('WAIT') || act.includes('MONITORING') || act.includes('SWEEP')) {
            actionEl.className = 'ai-action-value gold-text';
        } else {
            actionEl.className = 'ai-action-value gold-text';
        }
    }

    // ----------------------------------------------------------------
    // 3. INTENSITY BADGE — pulse animation when HIGH
    // ----------------------------------------------------------------
    const intensityEl = document.getElementById('ai-intensity');
    if (intensityEl) {
        intensityEl.textContent = 'INTENSITY: ' + (insight.intensity || 'NORMAL');
        const isHigh = insight.intensity === 'HIGH';
        intensityEl.className = 'ai-intensity-badge' + (isHigh ? ' ai-intensity-high' : '');
    }

    // ----------------------------------------------------------------
    // 4. STRUCTURED NARRATIVE — split the text into 3 sections
    //    Parse the insight.text sentence by sentence and assign to sections.
    // ----------------------------------------------------------------
    const fullText = insight.text || '';
    const sentences = fullText.split('. ').filter(s => s.trim().length > 0);

    // SESSION section: first sentence (usually has MARKET OFF-HOURS / NY OPEN / LONDON)
    const sessionSentence  = sentences[0] || '';
    // STRUCTURE section: any sentence about confluence, phase, bias, manipulation
    const structureKeywords = ['Phase', 'bias', 'confluence', 'MANIPULATION', 'corrective', 'Developing', 'High-conviction', 'regime'];
    const structureSentence = sentences.find(s => structureKeywords.some(k => s.toLowerCase().includes(k.toLowerCase()))) || sentences[1] || '';
    // FLOW section: whale flow, news, breadth
    const flowSentence = sentences.find(s => s.includes('WHALE') || s.includes('URGENT') || s.includes('SYNC') || s.includes('PICK') || s.includes('Monitoring')) || sentences[sentences.length - 1] || '';

    const sessionEl   = document.getElementById('ai-section-session');
    const structureEl = document.getElementById('ai-section-structure');
    const flowEl      = document.getElementById('ai-section-flow');

    if (sessionEl   && lastAIInsight !== fullText) sessionEl.textContent   = sessionSentence.trim() || 'Scanning session...';
    if (structureEl && lastAIInsight !== fullText) structureEl.textContent = structureSentence.trim() || 'Analyzing structure...';
    if (flowEl      && lastAIInsight !== fullText) flowEl.textContent      = flowSentence.trim() || 'Monitoring flow...';

    // Keep legacy element updated (hidden, for any other listeners)
    const textEl = document.getElementById('ai-insight-text');
    if (textEl) textEl.textContent = fullText;

    // ----------------------------------------------------------------
    // 5. CONTEXT STRIP: Session label, AMD Phase, Next Killzone
    // ----------------------------------------------------------------
    const latestData = window.latestInstitutionalData;
    const sessionEl2 = document.getElementById('ai-session-tag');
    const phaseEl    = document.getElementById('ai-phase-tag');
    const kzEl       = document.getElementById('ai-kz-countdown');

    if (latestData) {
        const session = latestData.session || {};
        const sesName = (session.name || session.label || 'OFF-HOURS').replace('_', ' ');
        if (sessionEl2) {
            sessionEl2.textContent = sesName;
            const isOpen = session.active || session.isMarketOpen;
            sessionEl2.style.color = isOpen ? 'var(--bullish)' : 'var(--text-dim)';
        }

        const phase = latestData.bias?.amdPhase || latestData.amdPhase || '--';
        if (phaseEl) {
            phaseEl.textContent = phase;
            phaseEl.style.color = phase === 'MANIPULATION' ? 'var(--bearish)' :
                                  phase === 'DISTRIBUTION' ? '#ff9d00' : 'var(--bullish)';
        }

        // Next killzone countdown (reuse existing killzone logic from status bar)
        const kzCountdown = document.getElementById('killzone-countdown');
        if (kzEl && kzCountdown) {
            const kzText = kzCountdown.textContent.replace('NEXT:', '').trim();
            kzEl.textContent = kzText || '--:--';
        }
    }

    // ----------------------------------------------------------------
    // 6. PCR CONFLICT DETECTION
    //    Flag if AI says bullish but PCR shows excessive calls (contrarian bearish)
    //    or AI says bearish but PCR shows bearish protection (contrarian bullish)
    // ----------------------------------------------------------------
    const pcrConflict = document.getElementById('ai-pcr-conflict');
    if (pcrConflict && latestData?.optionChainSnapshot) {
        const pcr = latestData.optionChainSnapshot.pcr;
        const aiIsBullish  = insight.action?.includes('CALL') || insight.action?.includes('BULLISH');
        const aiIsBearish  = insight.action?.includes('PUT')  || insight.action?.includes('BEARISH') || insight.action?.includes('FLATTEN');
        const pcrContraBullish = pcr > 1.3;   // too many puts = contrarian bullish
        const pcrContraBearish = pcr < 0.75;  // too many calls = contrarian bearish
        const hasConflict  = (aiIsBullish && pcrContraBearish) || (aiIsBearish && pcrContraBullish);
        pcrConflict.style.display = hasConflict ? 'block' : 'none';
    }

    // ----------------------------------------------------------------
    // 7. PERFORMANCE STATS
    // ----------------------------------------------------------------
    if (latestData?.aiStats) {
        const stats = latestData.aiStats;
        const accEl = document.getElementById('ai-accuracy');
        const capEl = document.getElementById('ai-capture');
        if (accEl) accEl.textContent = 'ACCURACY: ' + stats.accuracy + '%';
        if (capEl) capEl.textContent = 'CAPTURE: ' + (parseFloat(stats.points) >= 0 ? '+' : '') + stats.points + ' PTS';
    }

    // Signal count (track how many unique AI insights we've received this session)
    const sigCountEl = document.getElementById('ai-signal-count');
    if (sigCountEl) {
        window._aiSignalCount = (window._aiSignalCount || 0);
        if (lastAIInsight !== fullText) window._aiSignalCount++;
        sigCountEl.textContent = 'SIGNALS: ' + window._aiSignalCount;
    }

    // ----------------------------------------------------------------
    // 8. PULSE the status dot when text changes
    // ----------------------------------------------------------------
    if (lastAIInsight !== fullText) {
        lastAIInsight = fullText;
        const pulse = document.getElementById('ai-status-pulse');
        if (pulse) {
            pulse.style.background = 'var(--gold)';
            pulse.style.boxShadow  = '0 0 12px var(--gold)';
            pulse.style.animationDuration = '0.3s';
            setTimeout(() => {
                pulse.style.background = 'var(--cyan)';
                pulse.style.boxShadow  = '0 0 8px var(--cyan)';
                pulse.style.animationDuration = '1.5s';
            }, 2000);
        }
    }
}

function typeWriter(element, text) {
    if (typeWriterTimeout) clearTimeout(typeWriterTimeout);
    let charIndex = 0;
    element.textContent = '';
    const speed = 15;
    function type() {
        if (charIndex < text.length) {
            element.textContent += text.charAt(charIndex);
            charIndex++;
            typeWriterTimeout = setTimeout(type, speed);
        } else {
            typeWriterTimeout = null;
        }
    }
    type();
}

// =============================================================================
// HOLY GRAIL #2 — OPTION CHAIN SNAPSHOT RENDERER
// Module-level cache — null ticks NEVER wipe existing rows.
// Strike table only rebuilds when the active symbol changes.
// =============================================================================
let _chainRenderedSymbol = null;
let _chainHasContent    = false;

function updateOptionChainSnapshot(data) {
    const chain     = data.optionChainSnapshot;
    const container = document.getElementById('chain-strikes-container');
    const pcrBadge  = document.getElementById('chain-pcr-badge');
    const ivBadge   = document.getElementById('chain-iv-badge');
    const pcrSignal = document.getElementById('chain-pcr-signal');
    const emFooter  = document.getElementById('chain-em-footer');
    const emLower   = document.getElementById('chain-em-lower');
    const emUpper   = document.getElementById('chain-em-upper');

    if (!container) return;

    // Hide card for FX pairs — options only exist on equities/indices
    const card = document.getElementById('option-chain-card');
    if (card) {
        const sym  = (data.symbol || '').toUpperCase();
        const isFX = sym.includes('=X') || sym.includes('USD') || sym.includes('EUR')
                  || sym.includes('GBP') || sym.includes('JPY') || sym.includes('AUD');
        card.style.display = isFX ? 'none' : 'block';
    }

    // -----------------------------------------------------------------------
    // DEFINITIVE FIX:
    // If chain data is null on THIS tick, silently exit.
    // DO NOT wipe existing rows — they stay visible until a real update arrives.
    // Only show placeholder on the very first load (nothing ever rendered).
    // -----------------------------------------------------------------------
    if (!chain || !chain.strikes || chain.strikes.length === 0) {
        if (!_chainHasContent) {
            container.innerHTML = '<div style="text-align:center;color:var(--text-dim);font-size:0.65rem;padding:24px 0;font-style:italic;opacity:0.6;">Initializing option chain...</div>';
        }
        return;  // existing rows stay untouched
    }

    // Live badge updates every tick — NO DOM wipe, pure text/style swaps
    if (pcrBadge) {
        pcrBadge.textContent  = 'PCR: ' + chain.pcr;
        const pcrColor         = chain.pcr > 1.2 ? 'var(--bullish)' : chain.pcr < 0.8 ? 'var(--bearish)' : 'var(--gold)';
        pcrBadge.style.color        = pcrColor;
        pcrBadge.style.borderColor  = pcrColor;
        pcrBadge.style.background   = chain.pcr > 1.2 ? 'rgba(0,255,136,0.08)' : chain.pcr < 0.8 ? 'rgba(255,62,62,0.08)' : 'rgba(255,157,0,0.08)';
    }
    if (ivBadge) ivBadge.textContent = 'IV: ' + chain.iv + '%';

    if (pcrSignal) {
        pcrSignal.textContent  = 'PCR SIGNAL: ' + chain.pcrSignal;
        const sc = chain.pcr > 1.2 ? 'var(--bullish)' : chain.pcr < 0.8 ? 'var(--bearish)' : 'var(--gold)';
        pcrSignal.style.borderLeftColor = sc;
        pcrSignal.style.color           = sc;
    }

    if (emFooter && chain.emUpper && chain.emLower) {
        emFooter.style.display = 'flex';
        if (emUpper) emUpper.textContent = '\u2193 $' + chain.emUpper.toFixed(2);
        if (emLower) emLower.textContent = '\u2191 $' + chain.emLower.toFixed(2);
    }

    // Strike rows: only rebuild when symbol changes (main anti-flash gate)
    if (chain.symbol === _chainRenderedSymbol && _chainHasContent) return;
    _chainRenderedSymbol = chain.symbol;

    const frag = document.createDocumentFragment();
    chain.strikes.forEach(function(st) {
        const row = document.createElement('div');
        row.setAttribute('data-strike-row', 'true');
        row.style.cssText = 'display:grid;grid-template-columns:2fr 1fr 2fr;gap:4px;align-items:center;padding:6px;border-radius:3px;transition:background 0.2s;';

        const isATM  = st.isATM;
        const isWall = st.isCallWall || st.isPutWall;
        row.style.background = isATM ? 'rgba(255,157,0,0.07)' : isWall ? 'rgba(255,255,255,0.04)' : 'transparent';
        if (isATM) row.style.border = '1px solid rgba(255,157,0,0.3)';

        const callCell = document.createElement('div');
        callCell.style.cssText = 'text-align:right;display:grid;grid-template-columns:1fr 1fr 1fr;gap:3px;align-items:center;';
        callCell.innerHTML = '<span style="font-size:0.62rem;color:var(--text-dim);font-family:JetBrains Mono,monospace;">' + st.call.iv + '%</span>'
            + '<span style="font-size:0.65rem;color:var(--bullish);font-family:JetBrains Mono,monospace;font-weight:900;">\u0394' + st.call.delta + '</span>'
            + '<span style="font-size:0.62rem;color:rgba(255,255,255,0.6);font-family:JetBrains Mono,monospace;">' + (st.call.oi/1000).toFixed(1) + 'K</span>';

        const strikeCell = document.createElement('div');
        strikeCell.style.cssText = 'text-align:center;font-size:' + (isATM ? '0.82' : '0.68') + 'rem;font-weight:' + (isATM ? 900 : 700) + ';color:' + (isATM ? 'var(--gold)' : isWall ? '#fff' : 'var(--text-dim)') + ';font-family:JetBrains Mono,monospace;line-height:1.4;';
        strikeCell.textContent = '$' + st.strike;
        if (isATM)         strikeCell.innerHTML += ' <span style="font-size:0.45rem;background:var(--gold);color:#000;padding:1px 5px;border-radius:2px;vertical-align:middle;font-weight:900;">ATM</span>';
        if (st.isCallWall) strikeCell.innerHTML += ' <span style="font-size:0.45rem;background:var(--bearish);color:#fff;padding:1px 5px;border-radius:2px;vertical-align:middle;font-weight:900;">WALL</span>';
        if (st.isPutWall)  strikeCell.innerHTML += ' <span style="font-size:0.45rem;background:var(--bullish);color:#000;padding:1px 5px;border-radius:2px;vertical-align:middle;font-weight:900;">FLOOR</span>';

        const putCell = document.createElement('div');
        putCell.style.cssText = 'text-align:left;display:grid;grid-template-columns:1fr 1fr 1fr;gap:3px;align-items:center;';
        putCell.innerHTML = '<span style="font-size:0.62rem;color:rgba(255,255,255,0.6);font-family:JetBrains Mono,monospace;">' + (st.put.oi/1000).toFixed(1) + 'K</span>'
            + '<span style="font-size:0.65rem;color:var(--bearish);font-family:JetBrains Mono,monospace;font-weight:900;">\u0394' + st.put.delta + '</span>'
            + '<span style="font-size:0.62rem;color:var(--text-dim);font-family:JetBrains Mono,monospace;">' + st.put.iv + '%</span>';

        row.appendChild(callCell);
        row.appendChild(strikeCell);
        row.appendChild(putCell);
        frag.appendChild(row);
    });

    container.innerHTML = '';       // only cleared on symbol change
    container.appendChild(frag);
    _chainHasContent = true;        // real content is now painted
}

// =============================================================================
// HOLY GRAIL #3 — CATALYST CALENDAR RENDERER
// Anti-flash: rebuilds rows only when event list content changes.
// =============================================================================
let _lastCatalystHash = '';

function updateCatalystCalendar(data) {
    const calendar  = data.catalystCalendar;
    const container = document.getElementById('catalyst-rows-container');
    const nextBadge = document.getElementById('catalyst-next-badge');

    if (!container || !calendar || calendar.length === 0) return;

    // Always update the next-event countdown badge (live, no DOM wipe)
    if (nextBadge && calendar[0]) {
        const first = calendar[0];
        nextBadge.innerText = 'NEXT: ' + first.timeLabel;
        nextBadge.style.color       = first.color;
        nextBadge.style.borderColor = first.color;
        nextBadge.style.background  = first.color + '18';
    }

    // Anti-flash: only rebuild rows when the event NAME list changes,
    // not every 2 seconds when just the countdown numbers tick.
    const currentHash = calendar.map(function(e) {
        return e.name + '|' + (e.minsAway < 0 ? 'LIVE' : Math.floor(e.minsAway / 30));
    }).join(',');

    if (currentHash === _lastCatalystHash && container.children.length > 0) {
        const rows = container.querySelectorAll('[data-event-timer]');
        rows.forEach(function(timerEl, i) {
            if (calendar[i]) {
                const ev = calendar[i];
                timerEl.innerText  = ev.minsAway < 0 ? '\u26a1 LIVE' : ev.timeLabel;
                timerEl.style.color = ev.color;
            }
        });
        return;
    }
    _lastCatalystHash = currentHash;

    const frag = document.createDocumentFragment();
    calendar.forEach(function(ev) {
        const row        = document.createElement('div');
        const isImminent = ev.minsAway < 60;
        const isLive     = ev.minsAway < 0;

        row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:4px;border-left:3px solid ' + ev.color + ';background:' + ev.color + '0d;' + (isImminent ? 'animation:pulse-opacity 1.5s infinite alternate;border:1px solid ' + ev.color + '44;' : 'border:1px solid transparent;') + 'transition:all 0.2s ease;margin-bottom:3px;';

        const impactDot = '<div style="width:8px;height:8px;border-radius:50%;background:' + ev.color + ';flex-shrink:0;' + (isImminent ? 'box-shadow:0 0 8px ' + ev.color + ';' : '') + '"></div>';

        const earnTag = ev.category === 'EARNINGS'
            ? '<span style="font-size:0.52rem;background:rgba(139,92,246,0.2);color:#a78bfa;border:1px solid #a78bfa44;padding:0 4px;border-radius:2px;margin-left:5px;font-weight:900;">' + ev.ticker + '</span>' : '';

        const emTag = ev.em
            ? '<span style="font-size:0.52rem;color:var(--text-dim);margin-left:5px;">EM ' + ev.em + '</span>' : '';

        const catLabel = '<span style="font-size:0.52rem;color:' + ev.color + ';background:' + ev.color + '22;border:1px solid ' + ev.color + '44;padding:1px 5px;border-radius:2px;font-weight:900;">' + ev.category + '</span>';

        row.innerHTML = impactDot
            + '<div style="flex:1;min-width:0;">'
            +   '<div style="font-size:0.7rem;font-weight:900;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.4;">' + ev.name + earnTag + emTag + '</div>'
            +   '<div style="font-size:0.52rem;color:var(--text-dim);margin-top:2px;display:flex;gap:6px;align-items:center;">' + catLabel + '<span>' + ev.impact + ' IMPACT</span></div>'
            + '</div>'
            + '<div style="text-align:right;flex-shrink:0;">'
            +   '<div data-event-timer style="font-size:' + (isLive ? '0.75' : '0.65') + 'rem;font-weight:900;color:' + ev.color + ';font-family:JetBrains Mono,monospace;">' + (isLive ? '\u26a1 LIVE' : ev.timeLabel) + '</div>'
            +   '<div style="font-size:0.48rem;color:var(--text-dim);margin-top:1px;">' + (ev.impact === 'EXTREME' ? '\u26a0\ufe0f AVOID' : ev.impact === 'HIGH' ? 'CAUTION' : 'LOW RISK') + '</div>'
            + '</div>';

        frag.appendChild(row);
    });

    container.innerHTML = '';
    container.appendChild(frag);
}

// =============================================================================
// TRADE GUARDIAN — CONVICTION ENGINE
// Classifies every market move as a PULLBACK or genuine REVERSAL.
// Runs on every institutional data tick. Drives Hold/Manage/Exit states.
// =============================================================================
let _tgLastState = null;

function updateTradeGuardian(data) {
    if (!data || !data.bias || !data.markers) return;

    const bias   = data.bias;
    const m      = data.markers;
    const price  = data.currentPrice || 0;
    const mtf    = data.multiTfBias || {};

    if (!price || !bias.bias) return;

    // ---- OFF-HOURS GUARD ----
    // During off-hours, CVD/VWAP signals are meaningless. Show closed state.
    const sessionInfo = data.session || {};
    const isMarketOpen = sessionInfo.active || sessionInfo.isMarketOpen || false;
    if (!isMarketOpen) {
        const stateLabel = document.getElementById('tg-state-label');
        const stateDescEl = document.getElementById('tg-state-desc');
        const badge = document.getElementById('tg-alert-badge');
        const rationale_ = document.getElementById('tg-rationale');
        const strip = document.getElementById('tg-action-strip');
        const convBar = document.getElementById('tg-conviction-bar');
        const convPct = document.getElementById('tg-conviction-pct');
        if (stateLabel)  { stateLabel.innerText = 'OFF-HOURS'; stateLabel.style.color = 'var(--text-dim)'; }
        if (stateDescEl) stateDescEl.innerText = 'Market closed — conviction monitoring paused';
        if (badge)       { badge.innerText = 'CLOSED'; badge.className = 'tg-badge'; badge.style.color = 'var(--text-dim)'; badge.style.borderColor = 'rgba(255,255,255,0.1)'; badge.style.background = 'rgba(255,255,255,0.03)'; }
        if (rationale_)  rationale_.innerText = 'Off-hours: no institutional order flow to monitor. Guardian activates at market open.';
        if (strip)       { strip.className = 'tg-action-strip tg-action-hold'; strip.style.opacity = '0.3'; }
        if (convBar)     { convBar.style.width = '0%'; }
        if (convPct)     { convPct.innerText = '--'; convPct.style.color = 'var(--text-dim)'; }
        return;
    }
    // Reset strip opacity when market is open
    const strip_ = document.getElementById('tg-action-strip');
    if (strip_) strip_.style.opacity = '1';


    const isBullish = bias.bias.includes('BULLISH');
    const isBearish = bias.bias.includes('BEARISH');
    if (!isBullish && !isBearish) return;

    // ---- FACTOR 1: CVD Alignment (0-25 pts) ----
    const cvd = m.cvd || 0;
    let cvdScore = 0;
    const cvdAligned   = isBullish ? cvd > 0   : cvd < 0;
    const cvdStrong    = isBullish ? cvd > 500  : cvd < -500;
    const cvdConflict  = isBullish ? cvd < -300 : cvd > 300;
    if (cvdStrong)   cvdScore = 25;
    else if (cvdAligned) cvdScore = 15;
    else if (cvdConflict) cvdScore = -15;

    // ---- FACTOR 2: VWAP Position (0-20 pts) ----
    const vwap      = m.vwap || 0;
    let vwapScore   = 0;
    const vwapAligned  = vwap > 0 && (isBullish ? price > vwap : price < vwap);
    const vwapConflict = vwap > 0 && (isBullish ? price < vwap * 0.999 : price > vwap * 1.001);
    if (vwapAligned)  vwapScore = 20;
    if (vwapConflict) vwapScore = -10;

    // ---- FACTOR 3: Multi-TF Alignment (0-30 pts) ----
    const tfValues   = Object.values(mtf).filter(Boolean);
    const bullTFs    = tfValues.filter(b => b.includes('BULLISH')).length;
    const bearTFs    = tfValues.filter(b => b.includes('BEARISH')).length;
    const alignedTFs = isBullish ? bullTFs : bearTFs;
    const flipTFs    = isBullish ? bearTFs : bullTFs;
    let tfScore      = alignedTFs * 6 - flipTFs * 8; // Each flipped TF is a bigger penalty
    tfScore = Math.max(-30, Math.min(30, tfScore));

    // ---- FACTOR 4: Absorption (negative signal) ----
    const absorption   = bias.absorption;
    let absScore       = 0;
    const absConflict  = absorption && (
        (isBullish && absorption.type === 'BEARISH_ABSORPTION') ||
        (isBearish && absorption.type === 'BULLISH_ABSORPTION')
    );
    if (absConflict) absScore = -20;

    // ---- FACTOR 5: Price Structure (0-15 pts) ----
    const midOpen      = m.midnightOpen || price;
    const structOk     = midOpen > 0 && (isBullish ? price > midOpen : price < midOpen);
    const structBroken = midOpen > 0 && (isBullish ? price < midOpen * 0.998 : price > midOpen * 1.002);
    let structScore    = structOk ? 15 : (structBroken ? -20 : 0);

    // ---- FINAL CONVICTION SCORE (0-100 clamp) ----
    const raw   = 50 + cvdScore + vwapScore + tfScore + absScore + structScore;
    const score = Math.max(0, Math.min(100, Math.round(raw)));

    // ---- CLASSIFICATION ----
    let state, stateDesc, alertLevel, actionText, actionIcon, rationale;

    if (score >= 65) {
        state       = 'PULLBACK';
        stateDesc   = 'Temporary noise — institutional bias intact';
        alertLevel  = 'hold';
        actionText  = 'HOLD POSITION — BIAS INTACT';
        actionIcon  = '✅';
        rationale   = `${alignedTFs}/${tfValues.length} TFs aligned. CVD ${cvdAligned ? 'confirms' : 'neutral'}. Price ${vwapAligned ? 'holding VWAP' : 'near VWAP'}. This is a controlled pullback.`;
    } else if (score >= 42) {
        state       = 'CAUTION';
        stateDesc   = 'Structure weakening — tighten your stop';
        alertLevel  = 'manage';
        actionText  = 'TIGHTEN STOP — MONITOR CLOSELY';
        actionIcon  = '⚠️';
        rationale   = `${flipTFs} TF(s) flipping against bias. ${absConflict ? 'Absorption detected — institutions may be unloading.' : 'CVD diverging.'} Consider scaling out 50%.`;
    } else {
        state       = 'REVERSAL';
        stateDesc   = 'Institutional direction has changed — exit zone';
        alertLevel  = 'exit';
        actionText  = 'EXIT CONFIRMED — REVERSAL IN PROGRESS';
        actionIcon  = '🚨';
        rationale   = `${flipTFs} of ${tfValues.length} TFs now ${isBullish ? 'bearish' : 'bullish'}. CVD ${cvdConflict ? 'strongly reversed.' : 'shifted.'} ${structBroken ? 'Price broke Midnight Open.' : ''} Bias has changed.`;
    }

    // ---- BROWSER PUSH NOTIFICATION (state change to REVERSAL) ----
    if (alertLevel === 'exit' && _tgLastState !== 'exit') {
        showToast(`🚨 TRADE GUARDIAN: REVERSAL CONFIRMED on ${data.symbol} — REVIEW POSITION`, 'toast-grail');
        // OS-level browser notification
        if ('Notification' in window && Notification.permission === 'granted') {
            new Notification('🚨 TRADE GUARDIAN — REVERSAL', {
                body: `${data.symbol}: Institutional direction has changed. Review your position immediately.`,
                icon: '/favicon.ico',
                tag: 'tg-reversal',
                requireInteraction: true
            });
        }
        if (typeof audioHooter !== 'undefined' && audioHooter.playAlert) {
            try { audioHooter.playAlert(); } catch(e) {}
        }
    }
    _tgLastState = alertLevel;

    // ---- DOM UPDATES ----
    const convBar    = document.getElementById('tg-conviction-bar');
    const convPct    = document.getElementById('tg-conviction-pct');
    const stateLabel = document.getElementById('tg-state-label');
    const stateDescEl = document.getElementById('tg-state-desc');
    const badge      = document.getElementById('tg-alert-badge');
    const rationale_ = document.getElementById('tg-rationale');
    const strip      = document.getElementById('tg-action-strip');
    const stripIcon  = document.getElementById('tg-action-icon');
    const stripText  = document.getElementById('tg-action-text');

    const barColor   = score >= 65 ? 'var(--bullish)' : score >= 42 ? 'var(--gold)' : 'var(--bearish)';
    const textColor  = score >= 65 ? 'var(--bullish)' : score >= 42 ? 'var(--gold)' : 'var(--bearish)';

    if (convBar) { convBar.style.width = score + '%'; convBar.style.background = barColor; }
    if (convPct) { convPct.innerText = score + '%'; convPct.style.color = textColor; }
    if (stateLabel) { stateLabel.innerText = state; stateLabel.style.color = textColor; }
    if (stateDescEl) { stateDescEl.innerText = stateDesc; }
    if (rationale_)  { rationale_.innerText = rationale; rationale_.style.borderLeftColor = barColor; }

    if (badge) {
        badge.innerText = state;
        badge.className = `tg-badge tg-badge-${alertLevel}`;
    }
    if (strip) {
        strip.className = `tg-action-strip tg-action-${alertLevel}`;
    }
    if (stripIcon) stripIcon.innerText = actionIcon;
    if (stripText) stripText.innerText = actionText;

    // ---- EVIDENCE FACTOR DOTS ----
    const setFactor = (id, status) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.className = 'tg-factor ' + (status === 'ok' ? 'tg-active' : status === 'warn' ? 'tg-warn' : 'tg-danger');
    };

    setFactor('tg-f-cvd',    cvdStrong ? 'ok' : cvdConflict ? 'danger' : 'warn');
    setFactor('tg-f-vwap',   vwapAligned ? 'ok' : vwapConflict ? 'danger' : 'warn');
    setFactor('tg-f-tf',     alignedTFs >= 3 ? 'ok' : flipTFs >= 3 ? 'danger' : 'warn');
    setFactor('tg-f-abs',    !absConflict ? 'ok' : 'danger');
    setFactor('tg-f-struct', structOk ? 'ok' : structBroken ? 'danger' : 'warn');

    // ---- ENTRY POINT TRACKER (live update on every tick) ----
    if (typeof _updateEntryTracker === 'function') {
        try { _updateEntryTracker(data); } catch(e) { /* silent — tracker is optional */ }
    }
}

