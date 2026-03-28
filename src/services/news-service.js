import YahooFinance from 'yahoo-finance2';

const yahooFinance = new YahooFinance();

export class NewsService {
    constructor(io) {
        this.io = io;
        this.newsItems = [];
        this.symbols = ['SPY', 'QQQ', 'DIA', 'BTC-USD', 'EURUSD=X', 'AAPL', 'NVDA', 'TSLA'];
        this.isPolling = false;
    }

    async start() {
        console.log("[NEWS] Starting Institutional Ticker Service...");
        this.poll();
        setInterval(() => this.poll(), 300000); // Poll every 5 minutes
    }

    async poll() {
        if (this.isPolling) return;
        this.isPolling = true;
        try {
            const results = await Promise.all(this.symbols.map(async (sym) => {
                try {
                    const result = await yahooFinance.search(sym, { newsCount: 2 }, { validate: false });
                    return result.news || [];
                } catch (e) {
                    return [];
                }
            }));

            const newNews = results.flat()
                .filter((item, index, self) => 
                    item.title && index === self.findIndex((t) => t.title === item.title)
                )
                .map(item => ({
                    title: item.title,
                    source: item.publisher || 'FINANCIAL TIMES',
                    time: item.providerPublishTime ? new Date(item.providerPublishTime * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'NOW'
                }))
                .slice(0, 12);

            if (newNews.length > 0) {
                this.newsItems = newNews;
                this.io.emit('news_update', { news: this.newsItems });
            }
        } catch (e) {
            console.error("[NEWS SERVICE ERROR]", e.message);
        } finally {
            this.isPolling = false;
        }
    }
    getEventPulse() {
        const now = new Date();
        const hour = now.getHours();
        const min = now.getMinutes();
        
        const events = [
            { name: 'CPI DATA', h: 8, m: 30, impact: 'HIGH' },
            { name: 'NFP JOBS', h: 8, m: 30, impact: 'EXTREME' },
            { name: 'OPENING BELL', h: 9, m: 30, impact: 'ELEVATED' },
            { name: 'FOMC MINUTES', h: 14, m: 0, impact: 'EXTREME' },
            { name: 'EARNINGS DRIVES', h: 16, m: 30, impact: 'HIGH' }
        ];

        // Find next event in cycle
        let nextEvent = events.find(e => (e.h > hour) || (e.h === hour && e.m > min));
        if (!nextEvent) nextEvent = events[0]; 

        let proximity;
        if (nextEvent.h < hour || (nextEvent.h === hour && nextEvent.m <= min)) {
            // Event is tomorrow
            proximity = (24 * 60) - (hour * 60 + min) + (nextEvent.h * 60 + nextEvent.m);
        } else {
            proximity = (nextEvent.h * 60 + nextEvent.m) - (hour * 60 + min);
        }

        let status = 'STABLE';
        if (proximity <= 15) status = 'EXTREME';
        else if (proximity <= 60) status = 'ELEVATED';
        else if (proximity <= 180) status = 'ACTIVE';

        return {
            name: nextEvent.name,
            countdown: proximity,
            status,
            impact: nextEvent.impact,
            color: status === 'EXTREME' ? '#ef4444' : (status === 'ELEVATED' ? '#f59e0b' : '#38bdf8')
        };
    }
}
