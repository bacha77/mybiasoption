import yahooFinance from 'yahoo-finance2';
import natural from 'natural';

const analyzer = new natural.SentimentAnalyzer('English', natural.PorterStemmer, 'afinn');
const tokenizer = new natural.WordTokenizer();

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
                    const result = await yahooFinance.search(sym, { newsCount: 2 }, { validateResult: false });
                    return result.news || [];
                } catch (e) {
                    return [];
                }
            }));

            const newNews = results.flat()
                .filter((item, index, self) => 
                    item.title && index === self.findIndex((t) => t.title === item.title)
                )
                .map(item => {
                    const tokens = tokenizer.tokenize(item.title) || [];
                    const score = analyzer.getSentiment(tokens) || 0;
                    return {
                        title: item.title,
                        source: item.publisher || 'FINANCIAL TIMES',
                        time: item.providerPublishTime ? new Date(item.providerPublishTime * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'NOW',
                        nlpScore: score
                    };
                })
                .slice(0, 12);

            if (newNews.length > 0) {
                this.newsItems = newNews;
                const globalSentiment = this.getGlobalSentiment();
                this.io.emit('news_update', { news: this.newsItems, globalSentiment });
            }
        } catch (e) {
            console.error("[NEWS SERVICE ERROR]", e.message);
        } finally {
            this.isPolling = false;
        }
    }
    
    getGlobalSentiment() {
        if (!this.newsItems || this.newsItems.length === 0) return 0;
        const sum = this.newsItems.reduce((acc, curr) => acc + (curr.nlpScore || 0), 0);
        return parseFloat((sum / this.newsItems.length).toFixed(3));
    }

    getEventPulse() {
        const now = new Date();
        const hour = now.getHours();
        const min = now.getMinutes();
        
        const events = [
            { name: 'MIDNIGHT LONDON', h: 19, m: 0, impact: 'LOW' }, // Midnight London is usually low but starts the session context
            { name: 'LONDON OPEN', h: 3, m: 0, impact: 'HIGH' },
            { name: 'NY OPEN', h: 8, m: 0, impact: 'ELEVATED' },
            { name: 'U.S. CPI/NFP', h: 8, m: 30, impact: 'EXTREME' },
            { name: 'OPENING BELL', h: 9, m: 30, impact: 'HIGH' },
            { name: 'SILVER BULLET', h: 10, m: 0, impact: 'ELEVATED' },
            { name: 'FOMC / MINUTES', h: 14, m: 0, impact: 'EXTREME' },
            { name: 'NY MIDNIGHT', h: 0, m: 0, impact: 'ELEVATED' }
        ].sort((a, b) => (a.h * 60 + a.m) - (b.h * 60 + b.m));

        // Find the absolute closest upcoming event (or first event tomorrow if none left today)
        const currentMins = hour * 60 + min;
        let nextEvent = events.find(e => (e.h * 60 + e.m) > currentMins);
        
        if (!nextEvent) {
            nextEvent = events[0]; // Next one is early tomorrow
        }
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
