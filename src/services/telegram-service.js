import axios from 'axios';

export class TelegramService {
    constructor() {
        this.token = process.env.TELEGRAM_BOT_TOKEN;
        this.chatId = process.env.TELEGRAM_CHAT_ID;
        this.baseUrl = `https://api.telegram.org/bot${this.token}`;

        if (this.token) {
            console.log(`[Telegram] Service initialized. Token: ${this.token.substring(0, 5)}...`);
        } else {
            console.error(`[Telegram] ❌ CRITICAL: No BOT_TOKEN found in environment!`);
        }
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
${emoji} *INSTITUTIONAL HEALTH SIGNAL: ${symbol}*
----------------------------
*Alignment Score:* ${bias === 'BULLISH' ? '🟢' : '🔴'} *${price > 0 ? 'HIGH' : 'MAX'} CONFLUENCE*
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
            const isFX = item.symbol.includes('=X') || item.symbol.includes('USD');
            const prec = isFX ? 4 : 2;
            const biasEmoji = item.bias === 'BULLISH' ? '🚀' : item.bias === 'BEARISH' ? '🔻' : '⚖️';
            content += `*${item.symbol}* ${biasEmoji}\n`;
            content += `• Midnight: $${item.midnightOpen.toFixed(prec)}\n`;
            content += `• PDH: $${item.pdh.toFixed(prec)}\n`;
            content += `• PDL: $${item.pdl.toFixed(prec)}\n`;
            content += `• Prediction: *${item.bias}*\n\n`;
        });
        content += `_Institutional levels anchored. Watch for liquidity sweeps at PDH/PDL._`;

        await this.sendMessage(content);
    }

    async sendEngineConfluenceAlert(engineName, bias, symbols) {
        const emoji = bias === 'BULLISH' ? '🏦🔥' : '📉🛑';
        const message = `
${emoji} *INSTITUTIONAL MATRIX ALIGNMENT*
----------------------------
*Engine:* ${engineName.replace('_', ' ')}
*Status:* FULL ${bias} CONFLUENCE
*Drivers:* ${symbols.join(', ')}

_The entire Health Matrix for this index has reached maximum alignment. Institutional momentum is peaked._

[View Matrix](http://localhost:3000)
        `.trim();

        await this.sendMessage(message);
    }

    async sendConfluenceAlert(symbol, price, bias, count, total, criteria) {
        const emoji = bias === 'BULLISH' ? '⚡️🟢' : bias === 'BEARISH' ? '⚡️🔴' : '⚖️';
        const isFX = symbol.includes('=X') || symbol.includes('USD');
        const prec = isFX ? 4 : 2;

        let message = `
${emoji} *HIGH CONFLUENCE: ${symbol}*
----------------------------
*Score:* ${count} / ${total} Indicators
*Bias:* ${bias}
*Price:* $${price.toFixed(prec)}

*Active Confluence:*
${criteria.map(c => `✅ ${c}`).join('\n')}

_Market is aligning for a high-probability move._
        `.trim();

        await this.sendMessage(message);
    }

    async sendWhaleAlert(symbol, price, value, type) {
        const emoji = type === 'BULLISH' ? '🐋🟢' : '🐋🔴';
        const formattedValue = (value / 1000000).toFixed(2);
        const message = `
${emoji} *ELITE WHALE DETECTED: ${symbol}*
----------------------------
*Value:* $${formattedValue}M
*Price:* $${price.toFixed(2)}
*Sentiment:* ${type}

_Institutional block order detected. Watch for liquidity support/resistance at this level._
        `.trim();

        await this.sendMessage(message);
    }

    async sendWallAlert(symbol, price, wallName, wallValue, type) {
        const emoji = type === 'BULLISH' ? '🧱🟢' : '🧱🔴';
        const isFX = symbol.includes('=X') || symbol.includes('USD');
        const prec = isFX ? 4 : 2;
        
        const message = `
${emoji} *INSTITUTIONAL LEVEL CONTACT: ${symbol}*
----------------------------
*Level:* ${wallName}
*Value:* $${wallValue.toFixed(prec)}
*Current Price:* $${price.toFixed(prec)}
*Sentiment:* ${type === 'BULLISH' ? 'SUPPORT / MAGNET' : 'RESISTANCE / CEILING'}

_Price is currently interacting with a major institutional level. Watch for rejection or breakout with high volume._

[View Dashboard](http://localhost:3000)
        `.trim();

        await this.sendMessage(message);
    }

    async sendMacroAlert(title, message, impact = 'HIGH') {
        const emoji = impact === 'HIGH' ? '🚨' : '⚠️';
        const content = `
${emoji} *MACRO RISK ALERT*
----------------------------
*Event:* ${title}
*Status:* ${impact} IMPACT

_${message}_

[View Macro HUD](http://localhost:3000)
        `.trim();

        await this.sendMessage(content);
    }

    async sendSmtAlert(symbol, otherSymbol, type, message) {
        const emoji = type === 'BULLISH' ? '💎🔥' : '🥀🛑';
        const content = `
${emoji} *SMT DIVERGENCE DETECTED: ${symbol}*
----------------------------
*Correlation Partner:* ${otherSymbol}
*Type:* ${type} DIVERGENCE
*Status:* INSTITUTIONAL UNFAIRNESS

_${message}_

_One asset made a new extreme while the other failed, indicating hidden institutional strength/weakness._
        `.trim();

        await this.sendMessage(content);
    }
}

export const telegram = new TelegramService();
