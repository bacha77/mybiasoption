import { telegram } from './src/services/telegram-service.js';

async function test() {
    console.log("Sending test message...");
    try {
        await telegram.sendMessage("🔔 *BIAS BOT TEST*: Connection check.");
        console.log("Test message sent successfully (check your telegram).");
    } catch (e) {
        console.error("Failed to send telegram message:", e);
    }
}

test();
