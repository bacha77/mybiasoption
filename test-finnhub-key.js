import axios from 'axios';

const apiKey = 'cspolc9r01qj9q8n4ppg'; // Using the latter part as it looks like a standard Finnhub key
const symbol = 'AAPL';

async function testFinnhub() {
    try {
        const url = `https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${apiKey}`;
        const response = await axios.get(url);
        console.log('Finnhub Validated! Current Price:', response.data.c);
    } catch (error) {
        console.error('Validation Failed:', error.response ? error.response.status : error.message);
    }
}

testFinnhub();
