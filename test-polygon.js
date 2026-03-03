import axios from 'axios';

const apiKey = 'kdwcEPjkmQ1MX3FHDpkctJuh00T6efzg12Cw';
const symbol = 'SPY';

async function testPolygon() {
    try {
        const url = `https://api.polygon.io/v2/aggs/ticker/${symbol}/prev?adjusted=true&apiKey=${apiKey}`;
        const response = await axios.get(url);
        console.log('Polygon Test Success:', response.data);
    } catch (error) {
        console.error('Polygon Test Failed:', error.response ? error.response.status : error.message);
    }
}

testPolygon();
