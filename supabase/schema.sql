-- ═══════════════════════════════════════════════════════════════════════════
-- FindBus 找巴 — Supabase Schema
-- ═══════════════════════════════════════════════════════════════════════════
-- 使用方式：
--   1. Supabase Dashboard → SQL Editor → New query
--   2. 整份貼上，按 Run
--   3. 完成後到 Project Settings → API 複製：
--        - Project URL    （貼到前端 SUPABASE_URL）
--        - anon public key（貼到前端 SUPABASE_ANON_KEY）
--   4. 灌水：Table Editor → events → 改 signup_padding
--   5. 看目前報名狀況：SQL Editor → select * from admin_event_stats;
--
-- 重要：anon key 會暴露在前端 JavaScript（瀏覽器可見），所以所有防護
-- 都靠 RLS (Row Level Security) 規則把關。詳見下方註解。
-- ═══════════════════════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────────────────────
-- Extensions
-- ───────────────────────────────────────────────────────────────
create extension if not exists "pgcrypto";  -- gen_random_uuid()

-- ───────────────────────────────────────────────────────────────
-- events：每一場演唱會接駁是一列
-- ───────────────────────────────────────────────────────────────
create table if not exists public.events (
  id                  text primary key,                    -- 'laufey' / 'sunyenzi-0517' / 'mayday'
  artist              text not null,
  event_date          date not null,
  venue               text not null,                       -- '林口體育館' / '台北大巨蛋'
  destination         text not null default '台中',
  capacity            int  not null default 34,
  min_to_run          int  not null default 20,            -- 未達此數不開車
  price_return        int  not null default 550,
  price_oneway_addon  int  not null default 279,           -- 去程加購
  signup_padding      int  not null default 0 check (signup_padding >= 0),  -- ← 灌水欄位
  status              text not null default 'open'
                        check (status in ('open','full','closed','cancelled')),
  sort_order          int  not null default 0,             -- 列表排序
  meta                jsonb not null default '{}'::jsonb,  -- 集合地點、發車說明等彈性欄位
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- ───────────────────────────────────────────────────────────────
-- signups：每一位報名的使用者是一列
-- ───────────────────────────────────────────────────────────────
create table if not exists public.signups (
  id          uuid primary key default gen_random_uuid(),
  event_id    text not null references public.events(id) on delete restrict,
  name        text not null check (length(trim(name))  between 1 and 40),
  phone       text not null check (length(trim(phone)) between 1 and 20),   -- 必填，主要聯絡方式 + unique 鍵
  line_id     text          check (line_id is null or length(trim(line_id)) between 1 and 40),  -- 選填
  plan        text not null check (plan in ('return','roundtrip')),
  pickup      text,                                         -- 去程上車點（roundtrip 才填）
  amount      int  not null check (amount >= 0),            -- 凍結當時價格
  status      text not null default 'pending'
                check (status in ('pending','confirmed','paid','cancelled','noshow')),
  note        text,
  user_agent  text,                                         -- 濫用排查用
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists idx_signups_event  on public.signups(event_id);
create index if not exists idx_signups_status on public.signups(status);

-- 擋同一場次同一電話重複報名（cancelled 不算，取消後還能重報）
create unique index if not exists signups_unique_active
  on public.signups (event_id, phone)
  where status in ('pending', 'confirmed', 'paid');

-- ───────────────────────────────────────────────────────────────
-- updated_at trigger
-- ───────────────────────────────────────────────────────────────
create or replace function public.tg_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists events_touch  on public.events;
create trigger events_touch  before update on public.events
for each row execute function public.tg_touch_updated_at();

drop trigger if exists signups_touch on public.signups;
create trigger signups_touch before update on public.signups
for each row execute function public.tg_touch_updated_at();

-- ───────────────────────────────────────────────────────────────
-- View：event_counts
-- 前端只讀這個 view，不直接讀 signups 原表（避免 LINE ID 外流）。
-- display_count = 灌水 + 真實報名數，且不會超過 capacity。
-- 真實報名只算尚未取消的（pending / confirmed / paid）。
-- ───────────────────────────────────────────────────────────────
drop view if exists public.event_counts;
-- 注意：這個 view 刻意用 owner 權限執行（預設 security_invoker=false），
-- 才能在內部 count(*) signups 做統計。view 只吐 display_count 一個整數，
-- 不會讓 anon 透過它讀到任何個資。
create view public.event_counts as
select
  e.id,
  e.artist,
  e.event_date,
  e.venue,
  e.destination,
  e.capacity,
  e.min_to_run,
  e.price_return,
  e.price_oneway_addon,
  e.status,
  e.sort_order,
  e.meta,
  least(
    e.capacity,
    e.signup_padding + coalesce((
      select count(*) from public.signups s
      where s.event_id = e.id
        and s.status in ('pending','confirmed','paid')
    ), 0)
  )::int as display_count
from public.events e;

grant select on public.event_counts to anon, authenticated;

-- ───────────────────────────────────────────────────────────────
-- Admin view：看真實 vs 灌水數（Dashboard 用，不對前端開放）
-- ───────────────────────────────────────────────────────────────
drop view if exists public.admin_event_stats;
create view public.admin_event_stats as
select
  e.id, e.artist, e.event_date, e.venue, e.status,
  e.signup_padding,
  (select count(*) from public.signups s where s.event_id = e.id and s.status = 'pending')   as pending,
  (select count(*) from public.signups s where s.event_id = e.id and s.status = 'confirmed') as confirmed,
  (select count(*) from public.signups s where s.event_id = e.id and s.status = 'paid')      as paid,
  (select count(*) from public.signups s where s.event_id = e.id and s.status = 'cancelled') as cancelled,
  (select count(*) from public.signups s where s.event_id = e.id and s.status in ('pending','confirmed','paid')) as real_active,
  e.signup_padding + (select count(*) from public.signups s where s.event_id = e.id and s.status in ('pending','confirmed','paid')) as displayed
from public.events e
order by e.event_date;

revoke all on public.admin_event_stats from anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- Row Level Security
-- 開啟 RLS 之後，預設「全部禁止」，必須明確寫 policy 放行。
-- ═══════════════════════════════════════════════════════════════════════════
alter table public.events  enable row level security;
alter table public.signups enable row level security;

-- events：開放任何人 SELECT（前端列表、詳情頁要讀）
drop policy if exists events_public_read on public.events;
create policy events_public_read
on public.events
for select
to anon, authenticated
using (true);
-- 注意：沒寫 INSERT / UPDATE / DELETE policy，所以前端無法新增或改動場次。
-- 你自己要改資料請用 Dashboard（service_role 自動繞過 RLS）。

-- signups：開放任何人 INSERT，但禁止讀、禁止改、禁止刪
drop policy if exists signups_public_insert on public.signups;
create policy signups_public_insert
on public.signups
for insert
to anon, authenticated
with check (
  -- 不讓前端偽造狀態成 paid
  status = 'pending'
  -- 只能報名 open 狀態的場次（closed/cancelled/full 會被擋下）
  and exists (
    select 1 from public.events e
    where e.id = signups.event_id
      and e.status = 'open'
  )
);
-- 沒有 SELECT / UPDATE / DELETE policy = 前端完全讀不到、改不到、刪不掉。
-- 要看報名名單請用 Dashboard 的 Table Editor。

-- ═══════════════════════════════════════════════════════════════════════════
-- Seed：初始場次資料
-- （日期先填 2026 年的 5–7 月，對照真實檔期再自行修改）
-- ═══════════════════════════════════════════════════════════════════════════
insert into public.events
  (id, artist, event_date, venue, capacity, min_to_run, price_return, price_oneway_addon, signup_padding, sort_order, meta)
values
  ('laufey', 'Laufey', '2026-05-15', '林口體育館', 34, 20, 550, 279, 3, 10, jsonb_build_object(
      'pickup_venues', jsonb_build_array('逢甲大學','台中市政府'),
      'meeting',       '林口體育館（國立體育大學）正門停車場',
      'depart',        '散場後 30 分鐘',
      'duration',      '約 2.5 小時'
  )),
  ('sunyenzi-0515', '孫燕姿', '2026-05-15', '台北大巨蛋', 34, 20, 550, 279, 3, 20, jsonb_build_object(
      'pickup_venues', jsonb_build_array('逢甲大學','台中市政府'),
      'meeting',       '台北大巨蛋周邊指定集合點',
      'depart',        '散場後 30 分鐘',
      'duration',      '約 2.5 小時'
  )),
  ('sunyenzi-0517', '孫燕姿', '2026-05-17', '台北大巨蛋', 34, 20, 550, 279, 3, 21, jsonb_build_object(
      'pickup_venues', jsonb_build_array('逢甲大學','台中市政府'),
      'meeting',       '台北大巨蛋周邊指定集合點',
      'depart',        '散場後 30 分鐘',
      'duration',      '約 2.5 小時'
  )),
  ('kinggnu-0606', 'King Gnu', '2026-06-06', '台北小巨蛋', 34, 20, 550, 279, 0, 30, jsonb_build_object(
      'pickup_venues', jsonb_build_array('逢甲大學','台中市政府'),
      'meeting',       '台北小巨蛋指定集合點',
      'depart',        '散場後 30 分鐘',
      'duration',      '約 2.5 小時'
  )),
  ('kinggnu-0607', 'King Gnu', '2026-06-07', '台北小巨蛋', 34, 20, 550, 279, 0, 31, jsonb_build_object(
      'pickup_venues', jsonb_build_array('逢甲大學','台中市政府'),
      'meeting',       '台北小巨蛋指定集合點',
      'depart',        '散場後 30 分鐘',
      'duration',      '約 2.5 小時'
  ))
on conflict (id) do nothing;

-- 若曾跑過舊版 seed（含 mayday），清掉這一筆：
delete from public.events where id = 'mayday';

-- ═══════════════════════════════════════════════════════════════════════════
-- 驗證：應該能看到 6 筆、真實 0 人、灌水 3+3+3+0+0+0 = 9
-- ═══════════════════════════════════════════════════════════════════════════
-- select * from event_counts order by sort_order;
-- select * from admin_event_stats;
