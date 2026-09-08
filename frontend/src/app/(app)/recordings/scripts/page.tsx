"use client";

/**
 * This user's saved teleprompter scripts -- reachable from the "Script"
 * button on /recordings, backed by backend/src/scripts/* (up to
 * MAX_SCRIPTS_PER_USER, mirrored client-side below purely for the "hide the
 * Add Script card once full" check -- the backend's own 429 is still what
 * actually enforces the cap). A blank library renders as a single "Add
 * Script" card (the grid below just happens to have nothing else in it);
 * saving a script adds a text-preview card with its own Record/Delete
 * actions, and the Add Script card keeps trailing the list until the cap is
 * hit.
 *
 * "Record" doesn't call the backend at all -- it writes the script's text
 * into CameraCapturePage's own TELEPROMPTER_SCRIPT_STORAGE_KEY localStorage
 * key and navigates to the project-agnostic /recordings/record, the same
 * entry point the Recordings page's own Record button uses. That page's
 * mount effect already restores whatever's in that key, so a saved script
 * shows up pre-loaded in the live teleprompter with no extra plumbing.
 */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { deleteScript, listScripts, type Script } from "@/lib/api";
import { TELEPROMPTER_SCRIPT_STORAGE_KEY } from "@/components/editor-v2/CameraCapturePage";
import { AddScriptDialog } from "@/components/recordings/AddScriptDialog";
import { RecordIcon } from "@/components/editor-v2/icons/PlayerIcons";
import { TrashIcon } from "@/components/icons/UIIcons";

const MAX_SCRIPTS_PER_USER = 5;

function ScriptCard({
  script,
  onRecord,
  onDelete,
}: {
  script: Script;
  onRecord: (script: Script) => void;
  onDelete: (script: Script) => void;
}) {
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDelete() {
    if (!window.confirm(`Delete "${script.name}"? This can't be undone.`)) return;
    setIsDeleting(true);
    setError(null);
    try {
      await deleteScript(script.id);
      onDelete(script);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete this script");
      setIsDeleting(false);
    }
  }

  return (
    <div className="flex min-h-[150px] flex-col gap-1.5 rounded-md border border-border p-2">
      <p className="truncate text-xs font-medium text-foreground">{script.name}</p>
      <p className="line-clamp-3 flex-1 whitespace-pre-wrap text-[11px] text-muted">{script.text}</p>
      <div className="mt-1 flex items-center gap-1">
        <button
          type="button"
          onClick={() => onRecord(script)}
          title="Record with this script"
          aria-label="Record with this script"
          disabled={isDeleting}
          className="flex items-center gap-1 rounded-full px-2 py-1 text-[11px] text-muted hover:bg-background hover:text-foreground disabled:opacity-40"
        >
          <RecordIcon className="h-3.5 w-3.5" />
          Record
        </button>
        <button
          type="button"
          onClick={() => void handleDelete()}
          title="Delete"
          aria-label="Delete"
          disabled={isDeleting}
          className="rounded-full p-1.5 text-muted hover:bg-background hover:text-red-600 disabled:opacity-40"
        >
          <TrashIcon className="h-4 w-4" />
        </button>
      </div>
      {error && <p className="text-[10px] text-red-600">{error}</p>}
    </div>
  );
}

function AddScriptCard({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-[150px] flex-col items-center justify-center gap-1.5 rounded-md border-2 border-dashed border-border text-sm text-muted hover:bg-surface hover:text-foreground"
    >
      <span className="text-xl leading-none">+</span>
      Add Script
    </button>
  );
}

export default function ScriptsPage() {
  const router = useRouter();
  const [scripts, setScripts] = useState<Script[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);

  useEffect(() => {
    listScripts()
      .then(setScripts)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load your scripts"));
  }, []);

  function handleRecord(script: Script) {
    try {
      localStorage.setItem(TELEPROMPTER_SCRIPT_STORAGE_KEY, script.text);
    } catch {
      // Ignored -- best-effort; worst case the Record page opens with
      // whatever script text (if any) was already there.
    }
    router.push("/recordings/record");
  }

  function handleDeleted(script: Script) {
    setScripts((prev) => prev?.filter((s) => s.id !== script.id) ?? prev);
  }

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-12">
      <div>
        <Link href="/recordings" className="text-sm text-muted hover:underline">
          ← Recordings
        </Link>
        <h1 className="text-2xl font-semibold">Scripts</h1>
        <p className="text-sm text-muted">
          Save up to {MAX_SCRIPTS_PER_USER} scripts and jump straight into recording with one loaded into the
          teleprompter.
        </p>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}
      {!error && !scripts && <p className="text-sm text-muted">Loading…</p>}

      {scripts && (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4">
          {scripts.map((script) => (
            <ScriptCard key={script.id} script={script} onRecord={handleRecord} onDelete={handleDeleted} />
          ))}
          {scripts.length < MAX_SCRIPTS_PER_USER && <AddScriptCard onClick={() => setIsAddDialogOpen(true)} />}
        </div>
      )}

      {isAddDialogOpen && (
        <AddScriptDialog
          onSaved={(script) => setScripts((prev) => (prev ? [script, ...prev] : [script]))}
          onClose={() => setIsAddDialogOpen(false)}
        />
      )}
    </main>
  );
}
