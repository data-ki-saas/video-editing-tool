-- A peep's own definition (hair, face, colours, pose...), stored with the
-- rendered artwork so the asset can be reopened in the peep editor even when
-- no timeline overlay uses it. Null for every ordinary asset.
alter table public.assets add column if not exists peep jsonb;
