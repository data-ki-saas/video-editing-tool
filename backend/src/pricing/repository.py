from src.core.supabase_client import get_supabase_client

_TABLE = "resource_prices"


def get_current_price(resource_key: str) -> float | None:
    """Newest price row for this item, read straight from the database on
    every call -- deliberately NOT cached, so an admin's change is what the
    very next consumption event is charged at. Raises on a read error; the
    caller (metering/repository.py's record_event) decides what an unknown
    price means. None = no price has ever been set (i.e. free)."""
    result = (
        get_supabase_client()
        .table(_TABLE)
        .select("unit_price_cents")
        .eq("resource_key", resource_key)
        .order("effective_from", desc=True)
        .limit(1)
        .execute()
    )
    if not result.data:
        return None
    return float(result.data[0]["unit_price_cents"])


def list_prices(limit: int = 1000) -> list[dict]:
    """Every price row, newest first -- the catalog is a handful of items, so
    current + recent history are both derived from this one read."""
    result = (
        get_supabase_client()
        .table(_TABLE)
        .select("resource_key, unit_price_cents, effective_from, created_by")
        .order("effective_from", desc=True)
        .limit(limit)
        .execute()
    )
    return result.data or []


def insert_price(*, resource_key: str, unit_price_cents: float, created_by: str | None) -> dict:
    """Not best-effort: this IS the admin's action, so a failure must surface.
    effective_from is left to the database default (now()) so the DB clock,
    not the app server's, decides the cut-over instant."""
    result = (
        get_supabase_client()
        .table(_TABLE)
        .insert({"resource_key": resource_key, "unit_price_cents": unit_price_cents, "created_by": created_by})
        .execute()
    )
    return result.data[0]


def fetch_user_ledger_rows(user_id: str, start_iso: str, end_iso: str) -> list[dict]:
    """Every succeeded, priced-or-not ledger row for one user in [start, end),
    paged -- PostgREST caps a single response at 1000 rows, and a month of
    LLM calls can exceed that, which would silently under-bill."""
    rows: list[dict] = []
    page_size = 1000
    offset = 0
    while True:
        result = (
            get_supabase_client()
            .table("usage_ledger")
            .select("resource_key, quantity, unit, unit_price_cents, charge_cents, created_at")
            .eq("user_id", user_id)
            .eq("status", "succeeded")
            .gte("created_at", start_iso)
            .lt("created_at", end_iso)
            .order("created_at")
            .range(offset, offset + page_size - 1)
            .execute()
        )
        batch = result.data or []
        rows.extend(batch)
        if len(batch) < page_size:
            return rows
        offset += page_size
