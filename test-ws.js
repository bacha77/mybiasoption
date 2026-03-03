import WebSocket from 'ws';

const apiKey = 'cspolc9r01qj9q8n4ppg'; // Testing with one part of the key
const socket = new WebSocket(`wss://ws.finnhub.io?token=${apiKey}`);

socket.addEventListener('open', () => {
    console.log('WebSocket Connected');
    socket.send(JSON.stringify({ 'type': 'subscribe', 'symbol': 'AAPL' }));
});

socket.addEventListener('message', (event) => {
    console.log('Message from server ', event.data);
});

socket.addEventListener('error', (err) => {
    console.log('WS Error:', err.message);
});

setTimeout(() => {
    console.log('Closing test...');
    socket.close();
}, 10000);
