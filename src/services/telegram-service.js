import axios from 'axios';

export class TelegramService {
    constructor() {
        this.token = process.env.TELEGRAM_BOT_TOKEN;
        this.chatId = process.env.TELEGRAM_CHAT_ID;
        this.baseUrl = `https://api.telegram.org/bot${this.token}`;
    }

    async sendMessage(message) {
        try {
            await axios.post(`${this.baseUrl}/sendMessage`, {
                chat_id: this.chatId,
                text: message,
                parse_mode: 'Markdown'
            });
            console.log('--- TELEGRAM SIGNAL SENT ---');
            return true;
        } catch (error) {
            console.error('Telegram Error:', error.response?.data?.description || error.message);
            throw error; // Propagate error so callers know it failed
        }
    }

    async sendSignalAlert(symbol, bias, price, action, rationale, strike, trim, target, sl, duration, session) {
        const emoji = bias === 'BULLISH' ? '🚀' : bias === 'BEARISH' ? '🔻' : '⚖️';
        const sessionEmoji = session.includes('OPEN') ? '🔥' : '⏳';
        const message = `
${emoji} *BIAS SIGNAL ALERT: ${symbol}*
----------------------------
*Session:* ${sessionEmoji} ${session.replace('_', ' ')}
*Bias:* ${bias}
*Price:* $${price.toFixed(2)}
*Action:* ${action}
*Strike:* ${strike}
*Stop Loss:* ${sl}

*Expected Hold:* ${duration}
*Trim (VWAP):* ${trim}
*Final Target:* ${target}

*Rationale:*
_${rationale}_

[View Dashboard](http://localhost:3000)
        `.trim();

        await this.sendMessage(message);
    }

    async sendExitAlert(symbol, exitData) {
        const emoji = exitData.action === 'TAKE PROFIT' ? '💰' : '🛑';
        const message = `
${emoji} *BIAS EXIT ALERT: ${symbol}*
----------------------------
*Action:* ${exitData.action}
*Rationale:* ${exitData.rationale}

_Recommend scaling out or closing full position._
        `.trim();

        await this.sendMessage(message);
    }

    async sendMidnightOpenReport(data) {
        let content = `🌕 *NIGHTLY BIAS REPORT*\n`;
        content += `----------------------------\n`;
        data.forEach(item => {
            const biasEmoji = item.bias === 'BULLISH' ? '🚀' : item.bias === 'BEARISH' ? '🔻' : '⚖️';
            content += `*${item.symbol}* ${biasEmoji}\n`;
            content += `• Midnight: $${item.midnightOpen.toFixed(2)}\n`;
            content += `• PDH: $${item.pdh.toFixed(2)}\n`;
            content += `• PDL: $${item.pdl.toFixed(2)}\n`;
            content += `• Prediction: *${item.bias}*\n\n`;
        });
        content += `_Institutional levels anchored. Watch for liquidity sweeps at PDH/PDL._`;

        await this.sendMessage(content);
    }
}

export const telegram = new TelegramService();
