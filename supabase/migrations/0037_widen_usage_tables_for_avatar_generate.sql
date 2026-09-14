-- avatar_gen/repository.py's record_generate_event (usage_events, backs the
-- daily-cap check in count_recent_generate_events) and avatar_gen/
-- service.py's metering_repository.record_event (usage_ledger, the cost/
-- usage dashboard) both write event_type='avatar_generate' -- unlike Phase
-- 4/7's avatar_direct/avatar_edit, which meter under the already-allowed
-- generic 'llm_completion' type, Phase 6 introduced this as its own new
-- value and nobody widened either constraint for it (unlike 0013/0019/0029/
-- 0030, which each did for their own new feature). Both inserts have been
-- silently failing since Phase 6 shipped (caught by each call site's own
-- try/except, so generation itself never broke) -- which means the daily
-- avatar-generate abuse cap has never actually been enforced, and the usage
-- dashboard has undercounted this feature entirely. Same drop-and-recreate
-- pattern as every prior widening of these two constraints.
alter table public.usage_events drop constraint usage_events_event_type_check;
alter table public.usage_events add constraint usage_events_event_type_check
    check (event_type in ('render', 'voiceover', 'upload', 'avatar_video', 'background_removal', 'ticket_filed', 'avatar_generate'));

alter table public.usage_ledger drop constraint usage_ledger_event_type_check;
alter table public.usage_ledger add constraint usage_ledger_event_type_check
    check (event_type in ('render', 'voiceover', 'avatar_video', 'llm_completion', 'background_removal', 'avatar_generate'));
