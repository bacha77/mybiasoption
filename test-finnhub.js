import axios from 'axios';

const apiKey = 'kdwcEPjkmQ1MX3FHDpkctJuh00T6efzg12Cw';
const symbol = 'AAPL';

async function testFinnhub() {
    try {
        const url = `https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${apiKey}`;
        const response = await axios.get(url);
        console.log('Finnhub Test Success:', response.data);
    } catch (error) {
        console.error('Finnhub Test Failed:', error.response ? error.response.status : error.message);
    }
}

testFinnhub();
