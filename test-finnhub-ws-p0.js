import WebSocket from 'ws';

const apiKey = 'cspolc9r01qj9q8n4pp0'; // Try the other 20-char key
const ws = new WebSocket(`wss://ws.finnhub.io?token=${apiKey}`);

ws.on('open', () => {
    console.log('Connected to Finnhub with p0 key');
    ws.send(JSON.stringify({ type: 'subscribe', symbol: 'AAPL' }));
});

ws.on('message', (data) => {
    console.log('Data:', data.toString());
});

ws.on('error', (err) => {
    console.error('Error:', err.message);
});

setTimeout(() => {
    ws.close();
    process.exit(0);
}, 5000);
