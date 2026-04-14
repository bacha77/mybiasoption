import axios from 'axios';

export class CotService {
    constructor() {
        this.url = 'https://www.cftc.gov/dea/newcot/FinFutWk.txt';
        this.data = {};
        this.lastUpdate = 0;
        this.forexMap = {
            'CANADIAN DOLLAR - CHICAGO MERCANTILE EXCHANGE': 'CAD',
            'SWISS FRANC - CHICAGO MERCANTILE EXCHANGE': 'CHF',
            'BRITISH POUND - CHICAGO MERCANTILE EXCHANGE': 'GBP',
            'JAPANESE YEN - CHICAGO MERCANTILE EXCHANGE': 'JPY',
            'EURO FX - CHICAGO MERCANTILE EXCHANGE': 'EUR',
            'AUSTRALIAN DOLLAR - CHICAGO MERCANTILE EXCHANGE': 'AUD',
            'NZ DOLLAR - CHICAGO MERCANTILE EXCHANGE': 'NZD',
            'USD INDEX - ICE FUTURES U.S.': 'DXY'
        };
    }

    async fetchAndParse() {
        try {
            console.log("[COT] Fetching Institutional Positioning Data...");
            const response = await axios.get(this.url, { timeout: 10000 });
            const lines = response.data.split('\n');
            
            const results = {};
            
            lines.forEach(line => {
                // Split by comma but handle quoted strings correctly
                const columns = line.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/);
                if (columns.length < 20) return;

                const rawName = columns[0].replace(/"/g, '').trim();
                const symbol = this.getSymbol(rawName);
                
                if (symbol) {
                    // TFF Report Columns (0-indexed):
                    // 10: Dealer Long, 11: Dealer Short
                    // 13: Asset Mgr Long, 14: Asset Mgr Short
                    // 16: Lev Funds Long, 17: Lev Funds Short
                    
                    const assetMgrLong = parseInt(columns[10]) || 0;
                    const assetMgrShort = parseInt(columns[11]) || 0;
                    const levFundsLong = parseInt(columns[13]) || 0;
                    const levFundsShort = parseInt(columns[14]) || 0;
                    
                    const totalLong = assetMgrLong + levFundsLong;
                    const totalShort = assetMgrShort + levFundsShort;
                    const net = totalLong - totalShort;
                    const sentiment = (totalLong + totalShort > 0)
                        ? (totalLong / (totalLong + totalShort) * 100).toFixed(1)
                        : 50;

                    results[symbol] = {
                        assetMgr: { long: assetMgrLong, short: assetMgrShort },
                        levFunds: { long: levFundsLong, short: levFundsShort },
                        net,
                        sentiment: parseFloat(sentiment),
                        bias: parseFloat(sentiment) > 60 ? 'BULLISH' : (parseFloat(sentiment) < 40 ? 'BEARISH' : 'NEUTRAL'),
                        date: columns[2] // Report Date
                    };
                }
            });

            this.data = results;
            this.lastUpdate = Date.now();
            return results;
        } catch (error) {
            console.error("[COT SERVICE ERROR]", error.message);
            return null;
        }
    }

    getSymbol(rawName) {
        for (const [key, sym] of Object.entries(this.forexMap)) {
            if (rawName.includes(key)) return sym;
        }
        return null;
    }

    getSentiment(symbol) {
        // Handle pair symbols like EURUSD=X
        let key = symbol;
        if (symbol.includes('EUR')) key = 'EUR';
        else if (symbol.includes('GBP')) key = 'GBP';
        else if (symbol.includes('JPY')) key = 'JPY';
        else if (symbol.includes('AUD')) key = 'AUD';
        else if (symbol.includes('CAD')) key = 'CAD';
        else if (symbol.includes('NZD')) key = 'NZD';
        else if (symbol.includes('CHF')) key = 'CHF';
        else if (symbol.includes('DX-Y') || symbol.includes('DXY')) key = 'DXY';
        
        return this.data[key] || { sentiment: 50, bias: 'NEUTRAL', net: 0 };
    }
}
