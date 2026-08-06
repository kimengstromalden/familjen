-- === Kör detta i Supabase SQL Editor ===

-- Skapa tabellen om den inte existerar
CREATE TABLE IF NOT EXISTS public.push_subscriptions (
  member_name text PRIMARY KEY,
  subscription jsonb NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Aktivera RLS
ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;

-- Rensa gamla policies (för att undvika duplicering)
DROP POLICY IF EXISTS "pub_read" ON public.push_subscriptions;
DROP POLICY IF EXISTS "pub_insert" ON public.push_subscriptions;
DROP POLICY IF EXISTS "pub_update" ON public.push_subscriptions;
DROP POLICY IF EXISTS "Allow public read push_subscriptions" ON public.push_subscriptions;
DROP POLICY IF EXISTS "Allow public insert push_subscriptions" ON public.push_subscriptions;
DROP POLICY IF EXISTS "Allow public update push_subscriptions" ON public.push_subscriptions;

-- Skapa policies
CREATE POLICY "pub_read" ON public.push_subscriptions FOR SELECT USING (true);
CREATE POLICY "pub_insert" ON public.push_subscriptions FOR INSERT WITH CHECK (true);
CREATE POLICY "pub_update" ON public.push_subscriptions FOR UPDATE USING (true) WITH CHECK (true);
