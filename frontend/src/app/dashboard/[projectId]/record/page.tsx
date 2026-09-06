"use client";

import { use } from "react";
import { CameraCapturePage } from "@/components/editor-v2/CameraCapturePage";

export default function RecordPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = use(params);
  return <CameraCapturePage projectId={projectId} />;
}
