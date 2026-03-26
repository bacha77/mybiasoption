
import axios from 'axios';

/**
 * PythService - Institutional Real-Time Oracle
 * Provides sub-second price updates for SPY, DXY, and watchlist assets via Hermes API.
 */
class PythService {
    constructor() {
        // Corrected URL: Use the stable Hermes v1 API path
        this.baseUrl = 'https://hermes.pyth.network/api';
        this.priceIds = {
            'SPY': '0xe395155f30e7fc406981cfda9514e82b75a15a0c306b4d36e2f69f20e9803099', // S&P 500
            'DXY': '0x7179774619E4CD00A854593E9E0CE06D9B5E914611664D36E2F69F20E9803099', // DXY Proxy / SPX
            'BTC': '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
            'ETH': '0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
            'EURUSD=X': '0xa995d00bb36a63cef7809335ef00030f82dfba8229925c0da9ad6da92f915331',
            'GBPUSD=X': '0x84c2dde9633d93ad11f502f74439fa45fa787cf351ca0da9cd31e336206d2d5b',
            'USDJPY=X': '0x09da101df409c9523f1fd099d8540ae77997645089308eb9689f28522365451e'
        };
    }

    async getLatestPrice(symbol) {
        const pythId = this.priceIds[symbol];
        if (!pythId) return null;

        try {
            // Hermes v1 uses ids[] format
            const url = `${this.baseUrl}/latest_price_feeds?ids[]=${pythId}`;
            const res = await axios.get(url, { timeout: 3000 });
            
            if (res.data && res.data[0]) {
                const feed = res.data[0].price;
                // Exponent conversion (Pyth prices are integers with a negative exponent)
                const price = Number(feed.price) * Math.pow(10, feed.expo);
                const confidence = Number(feed.conf) * Math.pow(10, feed.expo);
                
                return {
                    price,
                    confidence,
                    timestamp: feed.publish_time,
                    source: 'PYTH-HERMES'
                };
            }
        } catch (err) {
            // Optional: log if needed (hidden for non-intrusive impl)
            return null;
        }
        return null;
    }
}

export const pythService = new PythService();
