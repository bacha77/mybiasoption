import WebSocket from 'ws';

const apiKey = 'cspolc9r01qj9q8n4ppg'; // Try the 20-char key
const ws = new WebSocket(`wss://ws.finnhub.io?token=${apiKey}`);

ws.on('open', () => {
    console.log('Connected to Finnhub with 20-char key');
    ws.send(JSON.stringify({ type: 'subscribe', symbol: 'AAPL' }));
    ws.send(JSON.stringify({ type: 'subscribe', symbol: 'SPY' }));
});

ws.on('message', (data) => {
    console.log('Message received:', data.toString());
});

ws.on('error', (err) => {
    console.error('Error:', err.message);
});

setTimeout(() => {
    console.log('Closing connection...');
    ws.close();
    process.exit(0);
}, 10000);
