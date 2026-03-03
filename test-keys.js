import axios from 'axios';

const key1 = 'cspolc9r01qj9q8n4pp0';
const key2 = 'cspolc9r01qj9q8n4ppg';
const symbol = 'AAPL';

async function test(key, label) {
    try {
        const url = `https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${key}`;
        const response = await axios.get(url);
        console.log(`${label} Success! Price:`, response.data.c);
        return true;
    } catch (e) {
        console.log(`${label} Failed:`, e.response ? e.response.status : e.message);
        return false;
    }
}

async function run() {
    await test(key1, 'Key 1');
    await test(key2, 'Key 2');
}

run();
