"use client";

/** Project-agnostic entry point into CameraCapturePage -- the Recordings
 * library's own Record button, unlike dashboard/[projectId]/record's
 * project-scoped one. Recordings are user-scoped, not tied to any project
 * (see CameraCapturePage's own module comment), so there's no projectId to
 * thread through here. */
import { CameraCapturePage } from "@/components/editor-v2/CameraCapturePage";

export default function RecordFromRecordingsLibraryPage() {
  return <CameraCapturePage projectId={null} />;
}
