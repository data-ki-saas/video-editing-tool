"use client";

/**
 * User's own support ticket list -- subject, priority/state badges, dates
 * -- plus an inline "New ticket" compose panel (subject + priority picker +
 * body + attachments), reachable from the Support icon in GlobalTopNav.tsx.
 * No `layer` control here: that's an admin/triage-only concept (see
 * admin/tickets/[ticketId]/page.tsx), never something the target
 * casual-creator filer is asked to classify.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createTicket, listMyTickets, type TicketPriority, type TicketState, type TicketSummary } from "@/lib/api";
import { AttachmentPicker, hasOversizedAttachment } from "@/components/support/AttachmentPicker";

const PRIORITY_LABELS: Record<TicketPriority, string> = { critical: "Critical", high: "High", low: "Low" };
const PRIORITY_COLORS: Record<TicketPriority, string> = { critical: "#dc2626", high: "#f59e0b", low: "#64748b" };
const STATE_LABELS: Record<TicketState, string> = { new: "New", seen: "Seen", assigned: "Assigned", resolved: "Resolved" };
const STATE_COLORS: Record<TicketState, string> = { new: "#2563eb", seen: "#64748b", assigned: "#7c3aed", resolved: "#16a34a" };

function Badge({ label, color }: { label: string; color: string }) {
  return (
    <span className="rounded-full px-2 py-0.5 text-xs font-medium text-white" style={{ backgroundColor: color }}>
      {label}
    </span>
  );
}

function TicketRow({ ticket }: { ticket: TicketSummary }) {
  return (
    <Link
      href={`/support/${ticket.id}`}
      className="flex items-center justify-between gap-3 rounded-md border border-border p-3 hover:bg-surface"
    >
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex items-center gap-2">
          <p className="truncate text-sm font-medium">{ticket.subject}</p>
          {ticket.hasUnread && <span className="h-2 w-2 shrink-0 rounded-full bg-red-500" aria-label="Unread" />}
        </div>
        <p className="text-xs text-muted">
          {ticket.messageCount} message{ticket.messageCount === 1 ? "" : "s"} · Updated {new Date(ticket.updatedAt).toLocaleString()}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Badge label={PRIORITY_LABELS[ticket.priority]} color={PRIORITY_COLORS[ticket.priority]} />
        <Badge label={STATE_LABELS[ticket.state]} color={STATE_COLORS[ticket.state]} />
      </div>
    </Link>
  );
}

function NewTicketPanel({ onCreated }: { onCreated: (ticketId: string) => void }) {
  const [subject, setSubject] = useState("");
  const [priority, setPriority] = useState<TicketPriority>("low");
  const [body, setBody] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = subject.trim().length > 0 && body.trim().length > 0 && !hasOversizedAttachment(files) && !submitting;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const ticket = await createTicket({ subject: subject.trim(), body: body.trim(), priority, files });
      onCreated(ticket.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to file this ticket");
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3 rounded-md border border-dashed border-border p-4">
      <h2 className="text-sm font-semibold">New ticket</h2>
      <input
        value={subject}
        onChange={(e) => setSubject(e.target.value)}
        placeholder="What's the issue about?"
        maxLength={200}
        className="rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
      />
      <div className="flex items-center gap-2">
        {(Object.keys(PRIORITY_LABELS) as TicketPriority[]).map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => setPriority(p)}
            className={
              "rounded-full px-3 py-1 text-xs font-medium " +
              (priority === p ? "text-white" : "border border-border text-muted hover:bg-surface")
            }
            style={priority === p ? { backgroundColor: PRIORITY_COLORS[p] } : undefined}
          >
            {PRIORITY_LABELS[p]}
          </button>
        ))}
      </div>
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Describe what's happening…"
        rows={4}
        className="rounded-md border border-border bg-background p-2 text-sm text-foreground"
      />
      <AttachmentPicker files={files} onChange={setFiles} disabled={submitting} />
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button
        type="submit"
        disabled={!canSubmit}
        className="self-end rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground disabled:opacity-50"
      >
        {submitting ? "Filing…" : "File ticket"}
      </button>
    </form>
  );
}

export default function SupportPage() {
  const router = useRouter();
  const [tickets, setTickets] = useState<TicketSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showNewTicket, setShowNewTicket] = useState(false);

  useEffect(() => {
    listMyTickets()
      .then(setTickets)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load your tickets"));
  }, []);

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-12">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Support</h1>
        {!showNewTicket && (
          <button
            type="button"
            onClick={() => setShowNewTicket(true)}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground"
          >
            + New ticket
          </button>
        )}
      </div>

      {showNewTicket && <NewTicketPanel onCreated={(ticketId) => router.push(`/support/${ticketId}`)} />}

      {error && <p className="text-sm text-red-600">{error}</p>}
      {!error && !tickets && <p className="text-sm text-muted">Loading…</p>}
      {tickets && tickets.length === 0 && !showNewTicket && (
        <p className="text-sm text-muted">You haven&apos;t filed any support tickets yet.</p>
      )}

      {tickets && tickets.length > 0 && (
        <div className="flex flex-col gap-2">
          {tickets.map((ticket) => (
            <TicketRow key={ticket.id} ticket={ticket} />
          ))}
        </div>
      )}
    </main>
  );
}
