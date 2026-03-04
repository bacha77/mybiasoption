import { telegram } from './telegram-service.js';

export class SimulationTrader {
    constructor() {
        this.balance = parseFloat(process.env.SIM_BALANCE || 10000);
        this.startBalance = this.balance;
        this.activePositions = new Map(); // Map(symbol -> position)
        this.tradeHistory = [];
        this.totalTrades = 0;
        this.wins = 0;
        this.losses = 0;
        this.isInitialized = true;
    }

    async processSignal(symbol, recommendation, currentPrice) {
        // Only enter if no active position for this symbol
        if (this.activePositions.has(symbol)) return;

        if (recommendation.action !== 'WAIT' && recommendation.isStable) {
            const size = recommendation.size || 1;
            const cost = size * 100 * (currentPrice * 0.05); // Simplified option cost (5% of underlying)

            if (this.balance < cost) {
                console.log(`[SIM] Insufficient funds for ${symbol}. Cost: $${cost.toFixed(2)} | Balance: $${this.balance.toFixed(2)}`);
                return;
            }

            const position = {
                symbol,
                type: recommendation.action,
                entryPrice: currentPrice,
                strike: recommendation.strike,
                size: size,
                sl: parseFloat(recommendation.sl),
                tp: parseFloat(recommendation.tp),
                trim: parseFloat(recommendation.trim),
                cost: cost,
                trimmed: false,
                timestamp: Date.now()
            };

            this.activePositions.set(symbol, position);
            this.balance -= cost;

            console.log(`[SIM] ENTERED ${symbol} ${recommendation.action} @ $${currentPrice.toFixed(2)} | Size: ${size}`);

            await telegram.sendMessage(`
🎮 *SIMULATED ENTRY: ${symbol}*
----------------------------
*Action:* ${recommendation.action}
*Entry:* $${currentPrice.toFixed(2)}
*Size:* ${size} contracts
*SL:* $${position.sl}
*TP:* $${position.tp}

_Current Sim Balance: $${this.balance.toFixed(2)}_
            `.trim());
        }
    }

    async updatePositions(stocks) {
        for (const [symbol, pos] of this.activePositions.entries()) {
            const stock = stocks[symbol];
            if (!stock || stock.currentPrice === 0) continue;

            const currentPrice = stock.currentPrice;
            const isCall = pos.type.includes('CALL');

            // --- EXIT LOGIC ---
            let exitReason = null;
            let profit = 0;

            // TP or SL hit
            if (isCall) {
                if (currentPrice >= pos.tp) exitReason = 'TAKE PROFIT';
                else if (currentPrice <= pos.sl) exitReason = 'STOP LOSS';
            } else {
                if (currentPrice <= pos.tp) exitReason = 'TAKE PROFIT';
                else if (currentPrice >= pos.sl) exitReason = 'STOP LOSS';
            }

            // Trim logic
            if (!pos.trimmed) {
                const hitTrim = isCall ? (currentPrice >= pos.trim) : (currentPrice <= pos.trim);
                if (hitTrim) {
                    console.log(`[SIM] TRIMMED ${symbol} @ $${currentPrice.toFixed(2)}`);
                    pos.trimmed = true;
                    pos.sl = pos.entryPrice; // Move SL to BE
                    await telegram.sendMessage(`🎮 *SIMULATED TRIM: ${symbol}*\n_Reached $${pos.trim}. Scaling out 50%. SL moved to Break Even._`);
                }
            }

            if (exitReason) {
                const priceDiff = isCall ? (currentPrice - pos.entryPrice) : (pos.entryPrice - currentPrice);
                // Calculate simulated profit based on underlying move * size * option delta approximation (0.5)
                profit = (priceDiff * 100 * pos.size * 0.5);

                this.closePosition(symbol, currentPrice, profit, exitReason);
            }
        }
    }

    async closePosition(symbol, exitPrice, profit, reason) {
        const pos = this.activePositions.get(symbol);
        if (!pos) return;

        const totalReturn = pos.cost + profit;
        this.balance += totalReturn;

        this.totalTrades++;
        if (profit > 0) this.wins++; else this.losses++;

        const winRate = ((this.wins / this.totalTrades) * 100).toFixed(1);
        const totalProfit = (this.balance - this.startBalance).toFixed(2);

        this.tradeHistory.push({ ...pos, exitPrice, profit, reason, exitTime: Date.now() });
        this.activePositions.delete(symbol);

        console.log(`[SIM] CLOSED ${symbol} | ${reason} | Profit: $${profit.toFixed(2)} | New Balance: $${this.balance.toFixed(2)}`);

        await telegram.sendMessage(`
🏁 *SIMULATED EXIT: ${symbol}*
----------------------------
*Reason:* ${reason}
*Exit Price:* $${exitPrice.toFixed(2)}
*Profit/Loss:* $${profit.toFixed(2)}

*Session Stats:*
• Win Rate: ${winRate}%
• Total P/L: $${totalProfit}
• Current Balance: $${this.balance.toFixed(2)}
        `.trim());
    }
}

export const simTrader = new SimulationTrader();
