-- Every consumption can be priced by an admin (see backend/src/pricing/
-- catalog.py), including consumption that costs us no provider money:
-- uploads, stock imports, saved recordings and saved library reels are now
-- recorded on the ledger (quantity in megabytes / items) so they have a
-- usage_ledger row the price can be snapshotted onto. Same drop-and-recreate
-- pattern as 0030/0037.
alter table public.usage_ledger drop constraint usage_ledger_event_type_check;
alter table public.usage_ledger add constraint usage_ledger_event_type_check
    check (event_type in (
        'render', 'voiceover', 'avatar_video', 'llm_completion', 'background_removal', 'avatar_generate',
        'upload', 'stock_import', 'recording_upload', 'library_save'
    ));

alter table public.usage_ledger drop constraint usage_ledger_unit_check;
alter table public.usage_ledger add constraint usage_ledger_unit_check
    check (unit in ('seconds', 'tokens', 'images', 'megabytes', 'items'));
