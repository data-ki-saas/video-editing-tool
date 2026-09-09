"use client";

/**
 * Admin ticket queue -- every user's tickets (require_feature
 * "tickets_manage_all" on the backend; useIsAdmin() here is a UI
 * convenience only, same disclaimer as every other admin page). Same
 * badge/row shape as /support's own list, plus a layer badge, the
 * submitter's email, the assignee, and filter controls -- see
 * TicketThread.tsx's own triage panel for changing any of these on a
 * single ticket.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import {
  listAllTicketsAdmin,
  type TicketLayer,
  type TicketPriority,
  type TicketState,
  type TicketSummary,
} from "@/lib/api";

const PRIORITY_LABELS: Record<TicketPriority, string> = { critical: "Critical", high: "High", low: "Low" };
const PRIORITY_COLORS: Record<TicketPriority, string> = { critical: "#dc2626", high: "#f59e0b", low: "#64748b" };
const STATE_LABELS: Record<TicketState, string> = { new: "New", seen: "Seen", assigned: "Assigned", resolved: "Resolved" };
const STATE_COLORS: Record<TicketState, string> = { new: "#2563eb", seen: "#64748b", assigned: "#7c3aed", resolved: "#16a34a" };
const LAYER_LABELS: Record<TicketLayer, string> = {
  frontend: "Frontend",
  backend: "Backend",
  database: "Database",
  storage: "Storage",
};

function Badge({ label, color }: { label: string; color: string }) {
  return (
    <span className="rounded-full px-2 py-0.5 text-xs font-medium text-white" style={{ backgroundColor: color }}>
      {label}
    </span>
  );
}

export default function AdminTicketsPage() {
  const [tickets, setTickets] = useState<TicketSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [myUserId, setMyUserId] = useState<string | null>(null);
  const [assignedToMe, setAssignedToMe] = useState(false);
  const [stateFilter, setStateFilter] = useState<TicketState | "">("");
  const [priorityFilter, setPriorityFilter] = useState<TicketPriority | "">("");
  const [layerFilter, setLayerFilter] = useState<TicketLayer | "">("");

  useEffect(() => {
    createClient()
      .auth.getUser()
      .then(({ data }) => setMyUserId(data.user?.id ?? null))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    listAllTicketsAdmin({
      state: stateFilter || undefined,
      priority: priorityFilter || undefined,
      layer: layerFilter || undefined,
    })
      .then(setTickets)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load tickets"));
  }, [stateFilter, priorityFilter, layerFilter]);

  const visibleTickets = tickets?.filter((t) => !assignedToMe || t.assignedTo === myUserId) ?? null;

  return (
    <div className="flex w-full max-w-4xl flex-col gap-6">
      <h1 className="text-2xl font-semibold">Support tickets</h1>

      <div className="flex flex-wrap items-center gap-3 text-xs">
        <label className="flex items-center gap-1.5">
          State
          <select
            value={stateFilter}
            onChange={(e) => setStateFilter(e.target.value as TicketState | "")}
            className="rounded-md border border-border bg-background px-1.5 py-1 text-xs"
          >
            <option value="">All</option>
            {(Object.keys(STATE_LABELS) as TicketState[]).map((s) => (
              <option key={s} value={s}>
                {STATE_LABELS[s]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5">
          Priority
          <select
            value={priorityFilter}
            onChange={(e) => setPriorityFilter(e.target.value as TicketPriority | "")}
            className="rounded-md border border-border bg-background px-1.5 py-1 text-xs"
          >
            <option value="">All</option>
            {(Object.keys(PRIORITY_LABELS) as TicketPriority[]).map((p) => (
              <option key={p} value={p}>
                {PRIORITY_LABELS[p]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5">
          Layer
          <select
            value={layerFilter}
            onChange={(e) => setLayerFilter(e.target.value as TicketLayer | "")}
            className="rounded-md border border-border bg-background px-1.5 py-1 text-xs"
          >
            <option value="">All</option>
            {(Object.keys(LAYER_LABELS) as TicketLayer[]).map((l) => (
              <option key={l} value={l}>
                {LAYER_LABELS[l]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={assignedToMe} onChange={(e) => setAssignedToMe(e.target.checked)} />
          Assigned to me
        </label>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}
      {!error && !visibleTickets && <p className="text-sm text-muted">Loading…</p>}
      {visibleTickets && visibleTickets.length === 0 && <p className="text-sm text-muted">No tickets match these filters.</p>}

      {visibleTickets && visibleTickets.length > 0 && (
        <div className="flex flex-col gap-2">
          {visibleTickets.map((ticket) => (
            <Link
              key={ticket.id}
              href={`/admin/tickets/${ticket.id}`}
              className="flex items-center justify-between gap-3 rounded-md border border-border p-3 hover:bg-surface"
            >
              <div className="flex min-w-0 flex-col gap-1">
                <p className="truncate text-sm font-medium">{ticket.subject}</p>
                <p className="text-xs text-muted">
                  {ticket.submitterDisplayName ?? ticket.submitterEmail ?? "Unknown filer"} · Updated{" "}
                  {new Date(ticket.updatedAt).toLocaleString()}
                </p>
                <p className="text-[11px] text-muted">
                  {ticket.assignedTo
                    ? `Assigned to ${ticket.assigneeDisplayName ?? ticket.assigneeEmail ?? ticket.assignedTo}`
                    : "Unassigned"}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {ticket.layer && <Badge label={LAYER_LABELS[ticket.layer]} color="#0ea5e9" />}
                <Badge label={PRIORITY_LABELS[ticket.priority]} color={PRIORITY_COLORS[ticket.priority]} />
                <Badge label={STATE_LABELS[ticket.state]} color={STATE_COLORS[ticket.state]} />
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
