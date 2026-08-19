import { VideoEditor } from "@/components/VideoEditor";

// TODO: replace with a real project selector once project creation exists --
// there's no projects UI yet, so this hardcodes a placeholder id.
const DEMO_PROJECT_ID = "demo-project";

export default function Home() {
  return (
    <main>
      <VideoEditor projectId={DEMO_PROJECT_ID} />
    </main>
  );
}
