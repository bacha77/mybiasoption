
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
            'IWM': '0xeff690a187797aa225723345d4612abec0bf0cec1ae62347c0e7b1905d730879',
            'SMH': '0x2487b620e66468404ba251bfaa6b8382774010cbb5d504ac48ec263e0b1934aa',
            'XLK': '0x343e151bf5a9055e075f84ec102186c5902ec4fd11db83cd4d8d8de5af756343',
            'XLY': '0x37efa438e252fc5f37536294ea307db140ad4146fea5e552daaed24ab0ef2f39',
            'XLF': '0x06b884220ac5ac16fedfb03f84ec62b6e311241bc0af40ebfe4aedf462c18825',
            'NVDA': '0xb1073854ed24cbc755dc527418f52b7d271f6cc967bbf8d8129112b18860a593',
            'TSLA': '0x16dad506d7db8da01c87581c87ca897a012a153557d4d578c3b9c9e1bc0632f1',
            'AAPL': '0x49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688',
            'MSFT': '0xd0ca23c1cc005e004ccf1db5bf76aeb6a49218f43dac3d4b275e92de12ded4d1',
            'META': '0x78a3e3b8e676a8f73c439f5d749737034b139bbbe899ba5775216fba596607fe',
            'AMZN': '0xb5d0e0fa58a1f8b81498ae670ce93c872d14434b72c364885d4fa1b257cbb07a',
            'GOOGL': '0x5a48c03e9b9cb337801073ed9d166817473697efff0d138874e0f6a33d6d5aa6',
            'AMD': '0x3622e381dbca2efd1859253763b1adc63f7f9abb8e76da1aa8e638a57ccde93e',
            'NFLX': '0x8376cfd7ca8bcdf372ced05307b24dced1f15b1afafdeff715664598f15a3dd2',
            'DXY': '0x7179774619E4CD00854593E9E0CE06D9B5E914611664D36E2F69F20E9803099', 
            'DX-Y.NYB': '0x7179774619E4CD00854593E9E0CE06D9B5E914611664D36E2F69F20E9803099',
            'BTC-USD': '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
            'ETH-USD': '0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
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
