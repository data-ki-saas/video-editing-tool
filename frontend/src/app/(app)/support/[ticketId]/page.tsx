"use client";

/** A user's own ticket thread -- see TicketThread.tsx for the shared
 * message-list-plus-composer UI this just fetches data for. */
import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { getTicket, type TicketDetail } from "@/lib/api";
import { TicketThread } from "@/components/support/TicketThread";

export default function SupportTicketPage() {
  const params = useParams<{ ticketId: string }>();
  const ticketId = params.ticketId;

  const [ticket, setTicket] = useState<TicketDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getTicket(ticketId)
      .then(setTicket)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load this ticket"));
  }, [ticketId]);

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-12">
      <Link href="/support" className="text-sm text-muted hover:underline">
        ← Support
      </Link>

      {error && <p className="text-sm text-red-600">{error}</p>}
      {!error && !ticket && <p className="text-sm text-muted">Loading…</p>}
      {ticket && <TicketThread ticket={ticket} onTicketChange={setTicket} />}
    </main>
  );
}
