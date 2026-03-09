import { telegram } from './telegram-service.js';
import supabase from './supabase-client.js';
import fs from 'fs';
import path from 'path';

export class SimulationTrader {
    constructor() {
        this.balance = parseFloat(process.env.SIM_BALANCE || 10000);
        this.startBalance = this.balance;
        this.activePositions = new Map();
        this.historyPath = path.join(process.cwd(), 'trades.json');
        this.statePath = path.join(process.cwd(), 'sim-state.json');
        this.tradeHistory = [];
        this.totalTrades = 0;
        this.wins = 0;
        this.losses = 0;
        this.initialize();
    }

    async initialize() {
        await this.loadState();
        this.tradeHistory = await this.loadHistory();
        this.totalTrades = this.tradeHistory.length;
        this.wins = this.tradeHistory.filter(t => t.profit > 0).length;
        this.losses = this.tradeHistory.filter(t => t.profit <= 0).length;
        this.isInitialized = true;
    }

    async processSignal(symbol, recommendation, currentPrice) {
        // Only enter if no active position for this symbol
        if (this.activePositions.has(symbol)) return;

        if (recommendation.action !== 'WAIT' && recommendation.isStable) {
            const size = recommendation.size || 1;
            const isForex = symbol.includes('=X') || symbol === 'BTC-USD';
            const multiplier = isForex ? 10000 : 100;
            const cost = size * multiplier * (currentPrice * (isForex ? 0.01 : 0.05));

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
            await this.saveState();

            console.log(`[SIM] ENTERED ${symbol} ${recommendation.action} @ $${currentPrice.toFixed(2)} | Size: ${size}`);

            await telegram.sendMessage(`
🎮 *SIMULATED ENTRY: ${symbol}*
----------------------------
*Action:* ${recommendation.action}
*Entry:* $${currentPrice.toFixed(isForex ? 5 : 2)}
*Size:* ${size} units
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
                const isForex = symbol.includes('=X') || symbol === 'BTC-USD';
                const multiplier = isForex ? 10000 : 100;

                // Calculate simulated profit
                profit = (priceDiff * multiplier * pos.size * (isForex ? 1 : 0.5));
                await this.closePosition(symbol, currentPrice, profit, exitReason);
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
        await this.saveHistory(this.tradeHistory[this.tradeHistory.length - 1]);
        this.activePositions.delete(symbol);
        await this.saveState();

        const isForex = symbol.includes('=X') || symbol === 'BTC-USD';
        console.log(`[SIM] CLOSED ${symbol} | ${reason} | Profit: $${profit.toFixed(2)} | New Balance: $${this.balance.toFixed(2)}`);

        await telegram.sendMessage(`
🏁 *SIMULATED EXIT: ${symbol}*
----------------------------
*Reason:* ${reason}
*Exit Price:* $${exitPrice.toFixed(isForex ? 5 : 2)}
*Profit/Loss:* $${profit.toFixed(2)}

*Session Stats:*
• Win Rate: ${winRate}%
• Total P/L: $${totalProfit}
• Current Balance: $${this.balance.toFixed(2)}
        `.trim());
    }

    async saveHistory(trade = null) {
        try {
            fs.writeFileSync(this.historyPath, JSON.stringify(this.tradeHistory, null, 2));

            if (supabase && trade) {
                const { error } = await supabase.from('trades').insert([{
                    symbol: trade.symbol,
                    type: trade.type,
                    entry_price: trade.entryPrice,
                    strike: trade.strike,
                    size: trade.size,
                    sl: trade.sl,
                    tp: trade.tp,
                    trim: trade.trim,
                    cost: trade.cost,
                    trimmed: trade.trimmed,
                    timestamp: trade.timestamp,
                    exit_price: trade.exitPrice,
                    profit: trade.profit,
                    reason: trade.reason,
                    exit_time: trade.exitTime
                }]);
                if (error) console.error("Supabase Save Trade Error:", error.message);
            }
        } catch (e) { console.error("Save History Error:", e.message); }
    }

    async saveState() {
        try {
            const state = {
                balance: this.balance,
                activePositions: Array.from(this.activePositions.entries())
            };
            fs.writeFileSync(this.statePath, JSON.stringify(state, null, 2));

            if (supabase) {
                const { error } = await supabase.from('sim_state').upsert({
                    id: 'main',
                    balance: this.balance,
                    active_positions: state.activePositions,
                    updated_at: new Date().toISOString()
                });
                if (error) console.error("Supabase Save State Error:", error.message);
            }
        } catch (e) { console.error("Save State Error:", e.message); }
    }

    async loadHistory() {
        try {
            if (supabase) {
                const { data, error } = await supabase
                    .from('trades')
                    .select('*')
                    .order('timestamp', { ascending: true });

                if (!error && data && data.length > 0) {
                    return data.map(d => ({
                        ...d,
                        entryPrice: d.entry_price,
                        exitPrice: d.exit_price,
                        exitTime: d.exit_time
                    }));
                }
            }

            if (fs.existsSync(this.historyPath)) {
                return JSON.parse(fs.readFileSync(this.historyPath, 'utf8'));
            }
        } catch (e) { console.error("Load History Error:", e.message); }
        return [];
    }

    async loadState() {
        try {
            if (supabase) {
                const { data, error } = await supabase
                    .from('sim_state')
                    .select('*')
                    .eq('id', 'main')
                    .single();

                if (!error && data) {
                    this.balance = data.balance;
                    this.activePositions = new Map(data.active_positions);
                    console.log(`[SUPABASE] State Restored. Balance: $${this.balance.toFixed(2)}`);
                    return;
                }
            }

            if (fs.existsSync(this.statePath)) {
                const state = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
                this.balance = state.balance;
                this.activePositions = new Map(state.activePositions);
                console.log(`[SIM] State Restored from local. Balance: $${this.balance.toFixed(2)}`);
            }
        } catch (e) { console.error("Load State Error:", e.message); }
    }
}

export const simTrader = new SimulationTrader();
