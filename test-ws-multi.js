import WebSocket from 'ws';

const apiKey = 'cspolc9r01qj9q8n4pp0cspolc9r01qj9q8n4ppg';
const socket = new WebSocket(`wss://ws.finnhub.io?token=${apiKey}`);

socket.on('open', () => {
    console.log('WS Connected');
    socket.send(JSON.stringify({ type: 'subscribe', symbol: 'AAPL' }));
    socket.send(JSON.stringify({ type: 'subscribe', symbol: 'SPY' }));
    socket.send(JSON.stringify({ type: 'subscribe', symbol: 'BINANCE:BTCUSDT' }));
});

socket.on('message', (data) => console.log('Data:', data.toString()));
socket.on('error', (err) => console.log('Error:', err.message));

setTimeout(() => {
    console.log('Closing...');
    socket.close();
}, 20000); // 20 seconds
