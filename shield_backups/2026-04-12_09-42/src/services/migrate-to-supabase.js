import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import supabase from './supabase-client.js';

async function migrate() {
    console.log('🚀 Starting migration to Supabase...');

    if (!supabase) {
        console.error('❌ Supabase not configured. Check your .env file.');
        return;
    }

    // 1. Migrate sim-state
    const statePath = path.join(process.cwd(), 'sim-state.json');
    if (fs.existsSync(statePath)) {
        console.log('📦 Migrating simulation state...');
        const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        const { error } = await supabase.from('sim_state').upsert({
            id: 'main',
            balance: state.balance,
            active_positions: state.activePositions,
            updated_at: new Date().toISOString()
        });
        if (error) console.error('❌ State migration error:', error.message);
        else console.log('✅ State migrated successfully.');
    }

    // 2. Migrate trades history
    const historyPath = path.join(process.cwd(), 'trades.json');
    if (fs.existsSync(historyPath)) {
        console.log('📦 Migrating trade history...');
        const history = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
        
        // Chunk trades to avoid payload size limits
        const chunkSize = 100;
        for (let i = 0; i < history.length; i += chunkSize) {
            const chunk = history.slice(i, i + chunkSize).map(trade => ({
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
            }));

            const { error } = await supabase.from('trades').insert(chunk);
            if (error) {
                console.error(`❌ Trade migration error (chunk ${i}):`, error.message);
                break;
            }
            console.log(`✅ Migrated trades ${i} to ${Math.min(i + chunkSize, history.length)}`);
        }
    }

    console.log('✨ Migration finished.');
    process.exit(0);
}

migrate();
