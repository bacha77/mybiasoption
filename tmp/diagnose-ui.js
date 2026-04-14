/**
 * BIAS Terminal - Deep Data Diagnostic
 * Run with: node tmp/diagnose-ui.js
 */
import { io } from 'socket.io-client';

const socket = io('http://localhost:3000');

console.log('\n==================================================');
console.log('  BIAS TERMINAL - DEEP DATA DIAGNOSTIC v2');
console.log('==================================================\n');

socket.on('connect', () => {
    console.log('✅ SOCKET CONNECTED:', socket.id);
});

socket.on('connect_error', (err) => {
    console.error('❌ CONNECTION FAILED:', err.message);
    process.exit(1);
});

let received = false;
socket.on('price_updated', (data) => {
    if (received) return; // only show first event
    received = true;
    
    console.log('\n📡 RAW "price_updated" EVENT:');
    console.log('   Top-level keys:', Object.keys(data));
    
    if (data.sectors && data.sectors.length > 0) {
        console.log('\n   FIRST SECTOR ITEM (raw keys):');
        const first = data.sectors[0];
        console.log('   Keys:', Object.keys(first));
        console.log('   Full object:', JSON.stringify(first, null, 4));
    }
    
    if (data.updates && data.updates.length > 0) {
        console.log('\n   FIRST UPDATE ITEM (raw keys):');
        const first = data.updates[0];
        console.log('   Keys:', Object.keys(first));
        console.log('   Full object:', JSON.stringify(first, null, 4));
    }
    
    console.log('\n✅ Check: Does sectors[0] have a "price" field > 0?', 
        data.sectors?.[0]?.price > 0 ? 'YES ✅' : 'NO ❌');
    console.log('✅ Check: Does sectors[0] have a "symbol" field?', 
        data.sectors?.[0]?.symbol ? `YES (${data.sectors[0].symbol}) ✅` : 'NO ❌');
        
    process.exit(0);
});

setTimeout(() => {
    console.log('⚠️  No price_updated event in 10s');
    process.exit(0);
}, 10000);
