import React from 'react'

// Totem's "working" mark. Two ideas from the AI products that do this best,
// combined and drawn in CSS only (chat.css › .vc-spark):
//   - Gemini's loader: a four-point star that morphs (clip-path) as it turns —
//     css-tricks.com/recreating-gmails-google-gemini-animation
//   - Apple Intelligence's glow: a rotating conic gradient with a blurred halo
//     breathing behind it — artofstyleframe.com/blog/designing-for-apple-intelligence-ui-2026
// It sits beside shimmering status text (AI Elements' Shimmer pattern).
export default function Spark({ size = 16, label }: { size?: number; label?: string }) {
  return (
    <span className="vc-spark" style={{ ['--s' as any]: `${size}px` }} role={label ? 'status' : undefined} aria-label={label}>
      <span className="vc-spark-glow" aria-hidden />
      <span className="vc-spark-core" aria-hidden />
    </span>
  )
}

/** Spark + shimmering text: "Thinking", "Working", or the current step. */
export function WorkingLine({ text }: { text: string }) {
  return (
    <div className="vc-working" aria-live="polite">
      <Spark size={16} />
      <span className="vc-shimmer">{text}</span>
    </div>
  )
}
