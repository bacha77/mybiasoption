
import axios from 'axios';

async function debugPyth() {
    const ids = [
        '0x19e09bb805456ada3979a7d1cbb4b6d63babc3a0f8e8a9509f68afa5c4c11cd5', // SPY
        '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43'  // BTC
    ];
    const query = ids.map(id => `ids[]=${id}`).join('&');
    const url = `https://hermes.pyth.network/v2/updates/price/latest?${query}`;
    
    console.log(`[DEBUG] Fetching: ${url}`);
    try {
        const res = await axios.get(url);
        console.log(`[DEBUG] Status: ${res.status}`);
        console.log(`[DEBUG] Parsed length: ${res.data.parsed ? res.data.parsed.length : 'N/A'}`);
        if (res.data.parsed && res.data.parsed.length > 0) {
            console.log(`[DEBUG] First Item ID: ${res.data.parsed[0].id}`);
            console.log(`[DEBUG] Full Data:`, JSON.stringify(res.data.parsed[0], null, 2));
        } else {
            console.log(`[DEBUG] Raw Body:`, JSON.stringify(res.data, null, 2));
        }
    } catch (e) {
        console.error(`[DEBUG] Error:`, e.message);
    }
}

debugPyth();
