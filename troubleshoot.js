import dotenv from 'dotenv';
import { telegram } from './src/services/telegram-service.js';
import { RealDataManager } from './src/services/real-data-manager.js';

dotenv.config();

async function runDiagnostic() {
    console.log('--- BIAS DIAGNOSTIC TOOL ---');
    console.log('Testing Telegram Token:', process.env.TELEGRAM_BOT_TOKEN ? 'EXISTS (Check length: ' + process.env.TELEGRAM_BOT_TOKEN.length + ')' : 'MISSING');
    console.log('Testing Chat ID:', process.env.TELEGRAM_CHAT_ID ? 'EXISTS' : 'MISSING');

    console.log('\n1. Testing Telegram Connection...');
    try {
        await telegram.sendMessage('🌕 BIAS Diagnostic: Testing communication...');
        console.log('✅ Telegram test message sent successfully!');
    } catch (e) {
        console.error('❌ Telegram Failed:', e.message);
    }

    console.log('\n2. Testing Data Fetching (SPY)...');
    const simulator = new RealDataManager();
    try {
        await simulator.refreshHistoricalData('SPY');
        const m = simulator.getInstitutionalMarkers('SPY');
        console.log('✅ Data Fetch Success!');
        console.log('SPY Midnight Open:', m.midnightOpen);
        console.log('SPY PDH:', m.pdh);
        console.log('SPY PDL:', m.pdl);

        if (m.midnightOpen === 0) {
            console.warn('⚠️ Warning: Midnight Open is 0. This is why the report is not sending.');
            console.warn('Reason: The 1m candle data does not contain the 00:00 candle yet.');
        } else {
            console.log('✅ Midnight Open found! The report should trigger.');
        }
    } catch (e) {
        console.error('❌ Data Fetch Failed:', e.message);
    }

    process.exit();
}

runDiagnostic();
