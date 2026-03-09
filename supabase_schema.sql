-- Create trades table
CREATE TABLE IF NOT EXISTS trades (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    symbol TEXT NOT NULL,
    type TEXT NOT NULL,
    entry_price DOUBLE PRECISION NOT NULL,
    strike DOUBLE PRECISION,
    size INTEGER NOT NULL,
    sl DOUBLE PRECISION,
    tp DOUBLE PRECISION,
    trim DOUBLE PRECISION,
    cost DOUBLE PRECISION NOT NULL,
    trimmed BOOLEAN DEFAULT FALSE,
    timestamp BIGINT NOT NULL,
    exit_price DOUBLE PRECISION,
    profit DOUBLE PRECISION,
    reason TEXT,
    exit_time BIGINT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create simulation state table
CREATE TABLE IF NOT EXISTS sim_state (
    id TEXT PRIMARY KEY DEFAULT 'main',
    balance DOUBLE PRECISION NOT NULL DEFAULT 10000,
    active_positions JSONB DEFAULT '[]'::jsonb,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Enable Realtime
ALTER PUBLICATION supabase_realtime ADD TABLE trades;
ALTER PUBLICATION supabase_realtime ADD TABLE sim_state;
