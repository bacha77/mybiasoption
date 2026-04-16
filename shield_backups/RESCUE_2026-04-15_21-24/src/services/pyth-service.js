
import axios from 'axios';

/**
 * PythService - Institutional Real-Time Oracle
 * Provides sub-second price updates for SPY, DXY, and watchlist assets via Hermes API.
 */
class PythService {
    constructor() {
        // Upgrade to Hermes V2 for sub-second price discovery
        this.baseUrl = 'https://hermes.pyth.network/v2';
        this.priceIds = {
            // VERIFIED HERMES V2 PRODUCTION IDS
            'SPY': '0xe1d957ba69188e68407c030af92e071d23821034f40d6c596395e8eb06cae137',
            'QQQ': '0xefde174f83556f8f53702167d53027b40d6d5257ef518c728e75cfca1078a635',
            'DIA': '0x57cff3a9a4d4c87b595a2d1bd1bac0240400a84677366d632ab838bbbe56f763',
            'IWM': '0xeff690a187797aa225723345d4612abec0bf0cec1ae62347c0e7b1905d730879',
            'SMH': '0x2487b620e66468404ba251bfaa6b8382774010cbb5d504ac48ec263e0b1934aa',
            'XLK': '0x343e151bf5a9055e075f84ec102186c5902ec4fd11db83cd4d8d8de5af756343',
            'NVDA': '0xb1073854ed24cbc755dc527418f52b7d271f6cc967bbf8d8129112b18860a593',
            'TSLA': '0x16dad506d7db8da01c87581c87ca897a012a153557d4d578c3b9c9e1bc0632f1',
            'AAPL': '0x49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688',
            'MSFT': '0xd0ca23c1cc005e004ccf1db5bf76aeb6a49218f43dac3d4b275e92de12ded4d1',
            'DXY': '0xf857f00d23aa3a6a9787ed971d0e515d48a1d74384d7202353a2efd02a06f30a', 
            'DX-Y.NYB': '0xf857f00d23aa3a6a9787ed971d0e515d48a1d74384d7202353a2efd02a06f30a',
            'BTC-USD': '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
            'ETH-USD': '0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
            'GOLD': '0x765d2ba906dbc32ca17cc11f5310a89e9ee1f6420508c63861f2f8ba4ee34bb2',
            'VIX': '0x6db82288cc5f3e1e2c6be0111fcd989ac93d161fb586a70651dccad2ac52c840',
            '^VIX': '0x6db82288cc5f3e1e2c6be0111fcd989ac93d161fb586a70651dccad2ac52c840'
        };
    }

    async getLatestPrice(symbol) {
        const results = await this.getLatestPrices([symbol]);
        return results[symbol] || null;
    }

    async getLatestPrices(symbols) {
        const validIds = [];
        const symMap = {}; 
        
        symbols.forEach(s => {
            const id = this.priceIds[s];
            if (id) {
                const formattedId = id.startsWith('0x') ? id.toLowerCase() : `0x${id.toLowerCase()}`;
                if (!validIds.includes(formattedId)) validIds.push(formattedId);
                
                if (!symMap[formattedId]) symMap[formattedId] = [];
                symMap[formattedId].push(s);

            }
        });

        if (validIds.length === 0) return {};

        // ── Helper to fetch a specific set of IDs ─────────────────────────────
        const fetchSubset = async (ids) => {
            const query = ids.map(id => `ids[]=${id}`).join('&');
            const url = `${this.baseUrl}/updates/price/latest?${query}&parsed=true`;
            try {
                const res = await axios.get(url, { timeout: 4000 });
                return res.data?.parsed || [];
            } catch (err) {
                if (err.response?.status === 404) {
                    // One of the IDs in this subset is bad. 
                    // If it's a single ID, we know which one it is.
                    if (ids.length === 1) {
                        console.warn(`[PYTH WARNING] Stale ID Found (404 Removed): ${ids[0]}`);
                        return null; // Signals this specific ID is dead
                    }
                    // Otherwise, split and try smaller chunks to find the culprit
                    const mid = Math.floor(ids.length / 2);
                    const left = await fetchSubset(ids.slice(0, mid));
                    const right = await fetchSubset(ids.slice(mid));
                    return [...(left || []), ...(right || [])];
                }
                throw err; // Real network error
            }
        };

        try {
            // Attempt full batch first for efficiency
            const results = await fetchSubset(validIds);
            const output = {};
            
            if (Array.isArray(results)) {
                results.forEach(item => {
                    const resId = item.id.startsWith('0x') ? item.id.toLowerCase() : `0x${item.id.toLowerCase()}`;

                    const targetSymbols = symMap[resId] || [];
                    
                    targetSymbols.forEach(sym => {
                        const feed = item.price;
                        const exponent = feed.expo; 
                        const price = Number(feed.price) * Math.pow(10, exponent);
                        if (!price || price <= 0) return;

                        output[sym] = {
                            price,
                            confidence: Number(feed.conf) * Math.pow(10, exponent),
                            timestamp: feed.publish_time,
                            source: 'PYTH-HERMES-V2'
                        };
                    });
                });
            }
            return output;
        } catch (err) {
            console.error(`[PYTH ERROR] Fatal Oracle Failure: ${err.message}`);
            return {};
        }
    }
}

export const pythService = new PythService();
