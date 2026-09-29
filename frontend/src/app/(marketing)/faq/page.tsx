import type { Metadata } from "next";
import { SITE_URL } from "@/lib/siteUrl";

const TITLE = "Frequently Asked Questions";
const DESCRIPTION =
  "Answers to common questions about Reel Creator: pricing, the free browser-based Edge Render, supported business niches, posting, and limits.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/faq" },
  openGraph: { title: TITLE, description: DESCRIPTION, url: `${SITE_URL}/faq`, siteName: "Reel Creator", type: "website" },
  twitter: { card: "summary", title: TITLE, description: DESCRIPTION },
};

// One source of truth for both the visible Q&A below AND the FAQPage
// JSON-LD -- an AI/search engine that lifts the schema's own answer text
// should never see something the visible page itself doesn't also say.
// Every answer here is a plain factual restatement of something already
// documented on /docs, /pricing, or /about -- nothing new is being claimed
// here that isn't backed by an existing page, on purpose (this page's whole
// point is to be a safe, quotable source, not a marketing stretch).
const FAQ_ENTRIES: { question: string; answer: string }[] = [
  {
    question: "What is Reel Creator?",
    answer:
      "Reel Creator turns the photos and video clips you already have into a finished, share-ready vertical video reel for Instagram, YouTube Shorts, or Facebook — no video editing experience required. Pick your business type, add a few photos or clips, and get a rendered reel with captions and music in minutes.",
  },
  {
    question: "Is Reel Creator free to use?",
    answer:
      "Yes. Reel Creator is currently free to use while it's in early access — no credit card required. Paid plans are planned for later as the product matures, with a generous free tier expected to remain.",
  },
  {
    question: "What is Edge Render, and is it really free with no upload?",
    answer:
      "Edge Render generates your reel right in your browser, on your own device — no upload to a rendering service, no cost, and no daily limit. It plays and downloads as soon as it's done. It needs a Chromium browser (Chrome or Microsoft Edge) and doesn't yet support auto-captions. A separate cloud-based high-quality render with full effects support, including auto-captions, is coming soon.",
  },
  {
    question: "What business types or niches does it support?",
    answer:
      "Any business type, not just one. Reel Creator adapts its own form and generated script to whatever niche you tell it about — real estate, hotels and short-term rentals, auto dealerships, garment and gift shops, hardware stores, or anything else.",
  },
  {
    question: "Do I need video editing experience?",
    answer:
      "No. You pick your business type, add a few photos or video clips (or search the built-in free stock photos and music), and let the app auto-arrange and render the reel. You can still directly drag, trim, zoom, and edit each clip yourself if you want more control.",
  },
  {
    question: "Can I use it on my phone, or do I need a desktop?",
    answer:
      "Both. The editor works on desktop for full control, and you can also record and generate a reel entirely from your phone in the browser — no separate app to install.",
  },
  {
    question: "Can I post my reel somewhere directly, or do I have to download it first?",
    answer:
      "You can connect your YouTube account once from Settings and post any saved reel with a single click, right from your Library or straight after a render. Otherwise, download the finished reel and post it anywhere yourself.",
  },
  {
    question: "What effects can I add to my reel?",
    answer:
      "Zoom & pan, Make it 3D (real camera depth on a photo cutaway, not a flat zoom), ambient effects (light sweep, sparkle, drifting leaves, rain, mist, sun rays, crackers), face effects (a glowing halo or torus locked to a detected head), Pulse with music, color filters, and flip/mirror — each applied per clip.",
  },
  {
    question: "Is there a limit on how many reels I can create?",
    answer:
      "Edge Render, the free browser-based render, has no daily limit. The separate high-quality cloud render has a daily cap per account during early access, shown clearly if you hit it.",
  },
  {
    question: "Can I undo a mistake while editing?",
    answer: "Yes — every change you make while editing can be undone or redone at any time, so it's safe to experiment.",
  },
];

const faqJsonLd = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: FAQ_ENTRIES.map(({ question, answer }) => ({
    "@type": "Question",
    name: question,
    acceptedAnswer: { "@type": "Answer", text: answer },
  })),
};

export default function FaqPage() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-16">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }} />

      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold">Frequently Asked Questions</h1>
        <p className="text-muted">
          See <a href="/docs" className="underline">Documentation</a> for the full feature list.
        </p>
      </div>

      <div className="flex flex-col gap-8">
        {FAQ_ENTRIES.map(({ question, answer }) => (
          <section key={question} className="flex flex-col gap-2">
            <h2 className="text-lg font-medium">{question}</h2>
            <p className="text-muted">{answer}</p>
          </section>
        ))}
      </div>
    </main>
  );
}
