import logging

from fastapi import HTTPException

from src.core.supabase_client import get_supabase_client

logger = logging.getLogger(__name__)

SARVAM_TTS_CHARS = "sarvam_tts_chars"


def ensure_and_get_balance(user_id: str, resource: str, trial_grant: int) -> int:
    """Grants the one-time trial credits on first call (idempotent, enforced by
    a unique index) and returns the current balance."""
    result = (
        get_supabase_client()
        .rpc("ensure_trial_credits", {"p_user_id": user_id, "p_resource": resource, "p_amount": trial_grant})
        .execute()
    )
    return int(result.data)


def spend(user_id: str, resource: str, amount: int, trial_grant: int, noun: str) -> int:
    """Atomically deducts `amount`, or raises 402 when the balance is too low.
    Returns the balance after. Fails closed (503) if the ledger is unreachable."""
    try:
        ensure_and_get_balance(user_id, resource, trial_grant)
        result = (
            get_supabase_client()
            .rpc("spend_credits", {"p_user_id": user_id, "p_resource": resource, "p_amount": amount})
            .execute()
        )
        outcome = result.data
    except Exception as exc:
        logger.exception("credit spend failed user=%s resource=%s", user_id, resource)
        raise HTTPException(
            status_code=503, detail="Credits are temporarily unavailable -- please try again in a minute."
        ) from exc
    if outcome["status"] != "ok":
        raise HTTPException(
            status_code=402,
            detail=f"Not enough {noun} credits ({outcome['balance']} left, {amount} needed). Switch to the free voices or top up.",
        )
    return int(outcome["balance"])


def refund(user_id: str, resource: str, amount: int) -> None:
    """Best-effort give-back after the provider definitively failed."""
    try:
        get_supabase_client().table("user_credit_ledger").insert(
            {"user_id": user_id, "resource": resource, "delta": amount, "reason": "refund"}
        ).execute()
    except Exception:
        logger.exception("credit refund failed user=%s resource=%s amount=%s", user_id, resource, amount)
