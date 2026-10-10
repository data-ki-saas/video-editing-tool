"use client";

import type { TtsVoiceOption } from "@/lib/api";

export type VoiceQuality = TtsVoiceOption["provider"];

export function voiceQualityForVoiceId(voiceId: string | null | undefined): VoiceQuality {
  return voiceId?.startsWith("sarvam:") ? "sarvam" : "edge";
}

/** Free vs. premium (Sarvam) voice switch, with the caller's remaining
 * premium credits. Renders nothing when the backend has no premium voices
 * (`credits` null). */
export function VoiceQualityToggle({
  value,
  onChange,
  credits,
  unlimited = false,
}: {
  value: VoiceQuality;
  onChange: (next: VoiceQuality) => void;
  credits: number | null;
  unlimited?: boolean;
}) {
  if (credits === null) return null;
  const option = (key: VoiceQuality, label: string) => (
    <button
      type="button"
      onClick={() => onChange(key)}
      className={`flex-1 rounded px-2 py-1 text-xs ${
        value === key ? "bg-foreground text-background" : "text-muted hover:text-foreground"
      }`}
    >
      {label}
    </button>
  );
  return (
    <div className="mb-2">
      <div className="flex rounded-md border border-border p-0.5">
        {option("edge", "Free voices")}
        {option("sarvam", "Premium (Sarvam)")}
      </div>
      {value === "sarvam" && (
        <p className="mt-1 text-[11px] text-muted">
          Natural Indian-language voices.{" "}
          {unlimited
            ? "Unlimited for your account."
            : `${credits.toLocaleString()} characters of credit left${credits === 0 ? " — switch to free voices or top up." : "."}`}
        </p>
      )}
    </div>
  );
}
