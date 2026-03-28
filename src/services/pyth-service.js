
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
            'SPY': '0x19e09bb805456ada3979a7d1cbb4b6d63babc3a0f8e8a9509f68afa5c4c11cd5',
            'QQQ': '0x9695e2b96ea7b3859da9ed25b7a46a920a776e2fdae19a7bcfdf2b219230452d',
            'DIA': '0xe395155f30e7fc406981cfda9514e82b75a15a0c306b4d36e2f69f20e9803099',
            'DXY': '0x7179774619E4CD00854593E9E0CE06D9B5E914611664D36E2F69F20E9803099', 
            'DX-Y.NYB': '0x7179774619E4CD00854593E9E0CE06D9B5E914611664D36E2F69F20E9803099',
            'BTC-USD': '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
            'GOLD': '0x765d2ba906dbc32ca17cc11f5310a89e9ee1f6420508c63861f2f8ba4ee34bb2',
            'EURUSD=X': '0xa995d00bb36a63cef7fd2c287dc105fc8f3d93779f062f09551b0af3e81ec30b',
            'GBPUSD=X': '0x84c2dde9633d93ad11f502f74439fa45fa787cf351ca0da9cd31e336206d2d5b',
            'USDJPY=X': '0xef2c98c804ba503c6a707e38be4dfbb16683775f195b091252bf24693042fd52',
            'AUDUSD=X': '0x67a6f93030420c1c9e3fe37c1ab6b77966af82f995944a9fefce357a22854a80',
            'USDCAD=X': '0x3112b03a41c910ed446852aacf67118cb1bec67b2cd0b9a214c58cc0eaa2ecca',
            'NZDUSD=X': '0x92eea8ba1b00078cdc2ef6f64f091f262e8c7d0576ee4677572f314ebfafa4c7',
            'USDCHF=X': '0x0b1e3297e69f162877b577b0d6a47a0d63b2392bc8499e6540da4187a63e28f8'
        };
    }

    async getLatestPrice(symbol) {
        const results = await this.getLatestPrices([symbol]);
        return results[symbol] || null;
    }

    async getLatestPrices(symbols) {
        const validIds = [];
        const symMap = {}; // Key will be raw hex without 0x
        
        symbols.forEach(s => {
            const id = this.priceIds[s];
            if (id) {
                validIds.push(id);
                // Strip 0x for the map key to match Hermes V2 response
                const rawId = id.startsWith('0x') ? id.substring(2) : id;
                symMap[rawId.toLowerCase()] = s;
            }
        });

        if (validIds.length === 0) return {};

        try {
            const query = validIds.map(id => `ids[]=${id}`).join('&');
            const url = `${this.baseUrl}/updates/price/latest?${query}`;
            const res = await axios.get(url, { timeout: 3000 });
            
            const output = {};
            if (res.data && Array.isArray(res.data.parsed)) {
                res.data.parsed.forEach(item => {
                    const id = item.id.toLowerCase();
                    const sym = symMap[id];
                    
                    if (sym) {
                        const feed = item.price;
                        const exponent = feed.expo; 
                        const price = Number(feed.price) * Math.pow(10, exponent);
                        const confidence = Number(feed.conf) * Math.pow(10, exponent);
                        output[sym] = {
                            price,
                            confidence,
                            timestamp: feed.publish_time,
                            source: 'PYTH-HERMES-V2'
                        };
                    } else {
                        // console.log(`[PYTH] No match for ID: ${id}`);
                    }
                });
            } else {
                // console.log(`[PYTH] No data.parsed:`, res.data);
            }
            return output;
        } catch (err) {
            // console.error(`[PYTH ERROR]`, err.message);
            return {};
        }
    }
}

export const pythService = new PythService();
