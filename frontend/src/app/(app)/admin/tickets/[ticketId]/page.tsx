"use client";

/** Admin's view of a single ticket thread -- TicketThread.tsx's isAdminView
 * mode (triage panel, internal notes) plus the assignable-admins list its
 * Assignee picker needs. */
import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { getTicket, listAssignableAdmins, type AssignableAdmin, type TicketDetail } from "@/lib/api";
import { TicketThread } from "@/components/support/TicketThread";

export default function AdminTicketPage() {
  const params = useParams<{ ticketId: string }>();
  const ticketId = params.ticketId;

  const [ticket, setTicket] = useState<TicketDetail | null>(null);
  const [assignableAdmins, setAssignableAdmins] = useState<AssignableAdmin[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getTicket(ticketId)
      .then(setTicket)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load this ticket"));
    listAssignableAdmins()
      .then(setAssignableAdmins)
      .catch(() => undefined);
  }, [ticketId]);

  return (
    <div className="flex w-full max-w-3xl flex-col gap-4">
      <Link href="/admin/tickets" className="text-sm text-muted hover:underline">
        ← Support tickets
      </Link>

      {error && <p className="text-sm text-red-600">{error}</p>}
      {!error && !ticket && <p className="text-sm text-muted">Loading…</p>}
      {ticket && (
        <TicketThread ticket={ticket} onTicketChange={setTicket} isAdminView assignableAdmins={assignableAdmins} />
      )}
    </div>
  );
}
