"use client";

/**
 * Shared thread view for both /support/[ticketId] (the filer's own view)
 * and /admin/tickets/[ticketId] (isAdminView) -- message list + a reply
 * composer. The backend never sends an internal note to a non-admin caller
 * (see backend/src/tickets/service.py's list_messages_with_attachments), so
 * the plain filer view needs no special-casing here: it just renders
 * whatever `ticket.messages` it was given.
 */
import { useState } from "react";
import {
  addTicketMessage,
  updateTicketTriage,
  type AssignableAdmin,
  type TicketDetail,
  type TicketLayer,
  type TicketPriority,
  type TicketState,
} from "@/lib/api";
import { AttachmentPicker, hasOversizedAttachment } from "./AttachmentPicker";
import { AttachmentThumbnail } from "./AttachmentThumbnail";

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

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString();
}

export function TicketThread({
  ticket,
  onTicketChange,
  isAdminView = false,
  assignableAdmins = [],
}: {
  ticket: TicketDetail;
  onTicketChange: (ticket: TicketDetail) => void;
  isAdminView?: boolean;
  assignableAdmins?: AssignableAdmin[];
}) {
  const [replyBody, setReplyBody] = useState("");
  const [replyFiles, setReplyFiles] = useState<File[]>([]);
  const [sending, setSending] = useState<"reply" | "note" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savingTriage, setSavingTriage] = useState(false);

  const canSend = (replyBody.trim().length > 0 || replyFiles.length > 0) && !hasOversizedAttachment(replyFiles) && !sending;

  async function handleSend(isInternal: boolean) {
    if (!canSend) return;
    setSending(isInternal ? "note" : "reply");
    setError(null);
    try {
      const updated = await addTicketMessage(ticket.id, { body: replyBody.trim(), files: replyFiles, isInternal });
      onTicketChange(updated);
      setReplyBody("");
      setReplyFiles([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send");
    } finally {
      setSending(null);
    }
  }

  async function handleTriageChange(field: "state" | "priority" | "layer" | "assignedTo", value: string) {
    setSavingTriage(true);
    setError(null);
    try {
      const params =
        field === "assignedTo"
          ? { assignedTo: value === "" ? null : value }
          : field === "layer"
            ? { layer: value === "" ? undefined : (value as TicketLayer) }
            : { [field]: value as TicketState | TicketPriority };
      const updated = await updateTicketTriage(ticket.id, params);
      onTicketChange(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update");
    } finally {
      setSavingTriage(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2 border-b border-border pb-3">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-lg font-semibold">{ticket.subject}</h1>
          <Badge label={PRIORITY_LABELS[ticket.priority]} color={PRIORITY_COLORS[ticket.priority]} />
          <Badge label={STATE_LABELS[ticket.state]} color={STATE_COLORS[ticket.state]} />
          {ticket.layer && <Badge label={LAYER_LABELS[ticket.layer]} color="#0ea5e9" />}
        </div>
        <p className="text-xs text-muted">
          Opened {formatDate(ticket.createdAt)} · Updated {formatDate(ticket.updatedAt)}
        </p>

        {isAdminView && (
          <div className="flex flex-wrap items-center gap-3 rounded-md bg-surface p-2 text-xs">
            <label className="flex items-center gap-1.5">
              State
              <select
                value={ticket.state}
                disabled={savingTriage}
                onChange={(e) => void handleTriageChange("state", e.target.value)}
                className="rounded-md border border-border bg-background px-1.5 py-1 text-xs disabled:opacity-50"
              >
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
                value={ticket.priority}
                disabled={savingTriage}
                onChange={(e) => void handleTriageChange("priority", e.target.value)}
                className="rounded-md border border-border bg-background px-1.5 py-1 text-xs disabled:opacity-50"
              >
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
                value={ticket.layer ?? ""}
                disabled={savingTriage}
                onChange={(e) => void handleTriageChange("layer", e.target.value)}
                className="rounded-md border border-border bg-background px-1.5 py-1 text-xs disabled:opacity-50"
              >
                <option value="">Unset</option>
                {(Object.keys(LAYER_LABELS) as TicketLayer[]).map((l) => (
                  <option key={l} value={l}>
                    {LAYER_LABELS[l]}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1.5">
              Assignee
              <select
                value={ticket.assignedTo ?? ""}
                disabled={savingTriage}
                onChange={(e) => void handleTriageChange("assignedTo", e.target.value)}
                className="rounded-md border border-border bg-background px-1.5 py-1 text-xs disabled:opacity-50"
              >
                <option value="">Unassigned</option>
                {assignableAdmins.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.displayName ?? a.email ?? a.id}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}

        {isAdminView && (ticket.contextProjectName || ticket.contextUserAgent) && (
          <p className="text-[11px] text-muted">
            Filed from: {ticket.contextProjectName ?? "no project"} · {ticket.contextUserAgent ?? "unknown browser"}
          </p>
        )}
        {isAdminView && ticket.submitterEmail && (
          <p className="text-[11px] text-muted">Filed by {ticket.submitterDisplayName ?? ticket.submitterEmail}</p>
        )}
      </div>

      <div className="flex flex-col gap-3">
        {ticket.messages.map((message) => (
          <div
            key={message.id}
            className={
              "flex flex-col gap-1.5 rounded-md border p-3 " +
              (message.isInternal ? "border-amber-400 bg-amber-50" : "border-border bg-surface")
            }
          >
            <div className="flex items-center gap-2 text-xs text-muted">
              <span className="font-medium text-foreground">{message.isAdminReply ? "Support team" : "You"}</span>
              {message.isInternal && (
                <span className="rounded-full bg-amber-500 px-1.5 py-0.5 text-[10px] font-medium text-white">Internal note</span>
              )}
              <span>{formatDate(message.createdAt)}</span>
            </div>
            {message.body && <p className="whitespace-pre-wrap text-sm">{message.body}</p>}
            {message.attachments.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {message.attachments.map((a) => (
                  <AttachmentThumbnail key={a.id} attachment={a} />
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="flex flex-col gap-2 border-t border-border pt-3">
        <textarea
          value={replyBody}
          onChange={(e) => setReplyBody(e.target.value)}
          placeholder={isAdminView ? "Write a reply or internal note…" : "Write a reply…"}
          rows={3}
          className="rounded-md border border-border bg-background p-2 text-sm text-foreground"
        />
        <AttachmentPicker files={replyFiles} onChange={setReplyFiles} disabled={sending !== null} />
        {error && <p className="text-sm text-red-600">{error}</p>}
        <div className="flex justify-end gap-2">
          {isAdminView && (
            <button
              type="button"
              onClick={() => void handleSend(true)}
              disabled={!canSend}
              className="rounded-md border border-amber-500 px-3 py-1.5 text-sm font-medium text-amber-600 disabled:opacity-50"
            >
              {sending === "note" ? "Saving…" : "Add internal note"}
            </button>
          )}
          <button
            type="button"
            onClick={() => void handleSend(false)}
            disabled={!canSend}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground disabled:opacity-50"
          >
            {sending === "reply" ? "Sending…" : isAdminView ? "Reply to customer" : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}
