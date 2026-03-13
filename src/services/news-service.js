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
                    const result = await yahooFinance.search(sym, { newsCount: 2 });
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
}
