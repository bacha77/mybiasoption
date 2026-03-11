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

-- Create profiles table for multitenancy
CREATE TABLE IF NOT EXISTS profiles (
    id UUID PRIMARY KEY REFERENCES auth.users ON DELETE CASCADE,
    email TEXT,
    tier TEXT DEFAULT 'free',
    subscription_status TEXT DEFAULT 'inactive',
    paypal_sub_id TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Ensure RLS is active
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can read own profile" ON profiles;
CREATE POLICY "Users can read own profile" ON profiles FOR SELECT USING (auth.uid() = id);
DROP POLICY IF EXISTS "Service role can update profiles" ON profiles;
CREATE POLICY "Service role can update profiles" ON profiles FOR ALL USING (true); -- Requires service role key in node to bypass

-- Set up triggered creation
CREATE OR REPLACE FUNCTION public.handle_new_user() 
RETURNS trigger AS $$
BEGIN
  INSERT INTO public.profiles (id, email, tier, subscription_status)
  VALUES (new.id, new.email, 'free', 'inactive');
  RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE PROCEDURE public.handle_new_user();

-- Enable Realtime safely
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables 
    WHERE pubname = 'supabase_realtime' AND tablename = 'trades'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE trades;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables 
    WHERE pubname = 'supabase_realtime' AND tablename = 'sim_state'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE sim_state;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables 
    WHERE pubname = 'supabase_realtime' AND tablename = 'profiles'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE profiles;
  END IF;
END
$$;
