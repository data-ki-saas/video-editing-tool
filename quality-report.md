# Quality & Feature Parity Report

## Executive Summary

This reel-generator's editor, free local export, and paid cloud render currently behave as three subtly different products rather than one WYSIWYG pipeline: captions can shift position or wording, audio ducking is dropped entirely, clips can be stretched, and the live preview itself softens footage during zooms — all invisible until a creator pays for a cloud render. Seven issues rise to critical because they silently break the core promise (what you see is what you get) with no error shown: caption mispositioning, karaoke caption accuracy, audio mixing, clip-shape cropping, preview sharpness, cover-thumbnail fidelity, and frame-rate drift across the three render paths. A further critical sits outside the render-parity cluster entirely: finished renders are mirrored to a public, access-control-free CDN bucket with no content-moderation step on uploaded or generated media, a trust-and-safety exposure independent of every fidelity bug. Fortunately the cloud Render button is currently gated behind a "coming soon" popup, so none of the cloud-specific bugs are live for real users yet — but that also means there is no checklist tying its re-enablement to fixing them, so they are a landmine waiting to be shipped. On the feature-parity side, the most consequential gaps against competitors are a per-clip canvas background fill for mismatched aspect ratios (directly contradicts the app's own stated GoPro+phone persona), a persistent brand kit, custom/cloned AI avatars, voice cloning, and one-click multi-aspect-ratio re-export — all high-value and consistent with the app's existing architecture (Creatomate compositing, the LLM/TTS provider-abstraction pattern, niche-configuration jsonb). Widening the lens further, the app's own niche-configuration module is under-exploited: real estate, auto, hospitality, and product-selling niches each have a well-known overlay convention (floor plans, 360° spins, location/menu callouts, shoppable price tags) that nothing in the editor supports yet, and two of those niches carry real compliance exposure (Fair Housing disclosure, auto financing disclaimers) that the report must flag as risk, not just backlog. Accessibility is assessed today only as "does the render match the preview," never as "can a low-vision, deaf/HoH, or blind viewer — or a creator using assistive tech — actually use this," which is a blind spot across both the finished video and the editor UI itself. Platform-fit correctness also needs to extend past aspect ratio alone to safe-zone chrome overlap, per-platform duration/bitrate/codec expectations, and background-music copyright risk, since each can silently degrade or endanger a creator's post on a specific platform. The monetization section should evaluate the paywall as a persuasion moment (trial credit, comparison, watermark strategy) and not only as a metering mechanism, and reliability needs its own lens: the README already documents an ack-before-complete worker with no retry queue, and neither flaky-mobile-upload recovery nor cloud-render failure recovery has a defined creator-facing path. A deliberately-scoped set of items are marked as explicit skips (deep keyframe editors, chat-driven AI editing, full transcript-document editing, real-time co-editing, massive template libraries, virality scoring, long-form-to-shorts, trending-sound packages, live streaming avatars) because they conflict with the product's direct-manipulation, non-technical-creator philosophy or represent a different product entirely. The single highest-leverage near-term move is fixing the critical WYSIWYG bugs (fidelity and trust-and-safety alike) before cloud render ships and before the public bucket sees more traffic, since every one of them erodes trust or creates liability at the exact moment a creator has just paid or a stranger's browser hits a guessable URL; the single highest-leverage feature addition is the canvas background-fill control, since it is both cheap to build on the existing Creatomate layering model and directly named in the product's own driving vision. Caption and audio fidelity dominate the bug list and should be treated as one workstream, since font/outline/background mismatches, translation, and ASR-based captioning all touch the same rendering pipeline — and that pipeline is also where SDH-style non-speech captioning and contrast validation should eventually land. Brand Kit, custom avatars, and voice cloning form a natural "personalize your brand" release train that would meaningfully close the gap with CapCut/Canva/HeyGen without adding new architectural risk, and niche-specific overlays (floor plans, 360 spins, menu callouts, price tags, disclosure text) form an equally natural "niche depth" release train riding the same jsonb/attributes pattern. Finally, several tracked items (loop-duration definitions, thumbnail timestamp semantics, upload/render failure recovery) are low-risk today but are traps for future features or real users at scale, so they're worth fixing opportunistically rather than urgently — except upload and render recovery, which should be treated as urgent given the app's phone-first, spotty-connection persona.

## Captions & Text

### Critical -- Bold Pop / Bounce In caption templates land in the wrong spot after a real (cloud) render
A creator places a caption box exactly where they want it, but because the cloud compiler switches the "Bold Pop" and "Bounce In" styles to a center-based anchor (needed for the pop/bounce zoom to scale from the middle) without recalculating x/y to match, Creatomate centers the text on the box's old top-left corner instead of its middle. This silently shifts the caption up-and-left in every cloud render, for both manual and TTS "background" mode captions, with no warning shown anywhere. Fix by factoring the anchor-switch and position-recompute into one shared helper — the same pairing already done correctly for video-overlay flip-wrapping — so no future template can reintroduce this slip.

### Critical -- Karaoke narration captions can show completely different words/timing than what the creator typed and previewed
For "Karaoke captions," the preview and free local export highlight words using the exact TTS-generated script and timing, but the cloud render discards that entirely and asks Creatomate to re-transcribe the audio via speech recognition — which can mis-hear brand names, addresses, or non-English words and produce different wording or pacing (or no captions at all if the mechanism doesn't work as assumed). This is discoverable only after a paid render. Build karaoke captions from the app's own known-exact per-word timings as keyframed text (mirroring the background-mode caption path), always send a plain fallback caption, and run one real test render to confirm the current mechanism's behavior before shipping it.

### High -- Bold, cartoon-style caption outlines render 4-8x thinner in the cloud render
Four styles (Bold Pop, Bounce In, Word Pop, Typewriter) rely on a thick outline for legibility over busy footage, correctly shown in preview/export, but the value sent to Creatomate is roughly a quarter to an eighth as thick — potentially making captions hard to read or invisible only in the cloud output. Confirm Creatomate's real stroke-width measurement basis with one test render, then derive the compiled value from the same font-size fraction the preview already uses.

### High -- Caption fonts in the live preview don't match the app's own fonts, and the cloud render's font is unverified for 6 of 7 styles
Every caption style draws with generic "sans-serif"/"monospace," which resolves to whatever font is installed on the creator's own OS rather than the app's actual font, and only one of seven styles tells Creatomate what font to use — the rest fall back to an unstated default. This means word-wrapping, line breaks, and the tuned look are not guaranteed to match either the creator's own screen twice or the real cloud render. Pick and load one verified web font per style, use it explicitly for canvas measurement, and pass that exact font name to Creatomate for all seven styles.

### High -- "Minimal Subtitle" and "Highlight Box" caption backgrounds are a different shape in the cloud render by design of the platform
These styles draw a fixed-size bar/box in the editor, but Creatomate's real caption-background feature only auto-hugs the text itself with no way to force a fixed size — so any caption shorter than full width (the normal case) renders a visibly narrower, differently-proportioned background, and no amount of number-tweaking closes this since the two platforms have genuinely different capabilities. Either disclose the difference to users for these two styles, or rebuild the fixed bar/box as a separate colored rectangle element instead of relying on Creatomate's auto-background.

### High -- Wider caption style presets, AI auto-emphasis, and brand-kit-bound styling
The existing karaoke/background/no-caption modes are a small fixed set next to VEED's independently-tunable animation/emphasis/branding axes or CapCut's animated-preset library, even though the caption pipeline (word-level TTS timing) already supports this. Add a few more named animated word-reveal presets (pop, bounce, typewriter), an "AI emphasize keywords" toggle reusing the existing script/LLM call, and bind caption font/color to the Brand Kit once it exists — all fitting the existing toggle-and-picker UX.

### High -- Caption/Subtitle translation to other languages
The app has zero multi-language capability today — the single largest competitive gap per VEED's own research — even though caption-only translation (no new audio) is comparatively cheap next to full dubbing. Run the existing TTS transcript through a translation API before re-timing captions in the target language, reusing the current caption pipeline, and ship this before any full voice-dubbing feature since it directly expands addressable niches (e.g. hospitality or gifts sold to non-English audiences).

### Medium -- "Word Pop" caption's signature zoom-in motion is likely missing entirely from the cloud render
The editor scales each word from small to full size on appearance, but Creatomate's built-in word-reveal animation this style maps to has no documented scale/zoom parameter, so the cloud version is likely a flat fade-in with no pop. Verify with a real test render, then build the pop-in manually via per-word scale keyframes — the same DIY approach already used for two other styles — instead of relying on a canned animation.

### Medium -- "Neon Glow" caption's glow is thinner, flatter, and doesn't scale with text size in the cloud render
The editor draws a two-layer glow sized relative to the actual chosen font size; the cloud render uses one single glow pass at a fixed size unrelated to Creatomate's own font-size decision, so the glow looks disproportionate on short vs. long captions and always flatter than the editor's look. Derive the cloud glow size from the same font-size-based fraction the preview uses, and treat the missing second layer as an accepted simplification unless exact matching is required.

### Medium -- Full AI dubbing (voice clone + lip-sync translation)
Beyond caption-only translation, VEED and HeyGen both offer full audio dubbing — cloning the speaker's voice and re-syncing lip movement into a target language — as an async job. Treat this as a phase-two extension of caption translation, wired into the existing async-job/webhook pattern already used for Creatomate render and HeyGen generation, and gate it hard behind the paid tier with a small credit allowance given real per-minute voice-clone + lip-sync cost.

### Low -- Caption word-wrapping and auto-shrink font size are calculated twice, independently, and can disagree
The editor measures wrapping/shrink decisions in the creator's own browser; the cloud render lets Creatomate decide independently with its own font engine, so near the wrap/shrink threshold the two can choose a different line count or font size (compounded by the font-mismatch bug). This is lower priority until fonts are fixed; once they match, consider passing the editor's own computed line breaks/font size to the cloud render as a hint.

## Audio & Voice

### Critical -- Cloud render plays avatar/overlay audio and background music at the wrong volume, with no ducking
The preview and free export faithfully reproduce a creator's carefully balanced overlay/voiceover mix, but the cloud render ignores the balance slider entirely (every overlay plays at Creatomate's default, often muted) and never ducks the base track under narration/overlay speech — so a HeyGen avatar's voice, music, and original clip audio can all play at full volume simultaneously. Port the app's own audio-mix formula into the cloud compiler (explicit volume per overlay/TTS element plus keyframed ducking automation matching the other two paths), and until it lands, treat any project with a video overlay or TTS narration as unsupported for cloud render.

### High -- Optional voice cloning for personal-brand narration
Edge TTS's stock voices are generic; for an influencer whose brand is their own on-camera persona, ElevenLabs' Instant Voice Cloning (from a ~1-minute sample) is the industry's most accessible cloning entry point and outperforms Descript's Overdub in naturalness. Add ElevenLabs as a second TTS provider behind the existing LLM/TTS provider-abstraction pattern, gated as a metered paid-tier perk via `usage_events` given its real per-minute COGS.

### Medium -- Adding a curated background-music track will silently disappear in the cloud render only, once such tracks exist
No curated music catalog exists yet, but the cloud compiler already filters out any background-music option not tied to a project-uploaded file — exactly how a future built-in catalog would be represented — so a creator picking a catalog track would hear it in preview/export and get silence in the cloud render with no error. Fix the cloud compiler to bake a catalog track's fixed URL directly into the render request before any catalog music is added.

### Medium -- Expressive TTS delivery tags
Edge TTS narration is uniformly even in tone, while ElevenLabs' v3 model reads bracketed cues like [excited], [whispers], [laughs] as performance direction for audible emotional inflection. If ElevenLabs ships, expose a small set of tappable emotion chips inline in the script editor (not raw bracket syntax) that insert the correct tag under the hood, preserving the tap-a-control philosophy.

## AI Avatar & Presenter

### High -- Custom/Personal AI avatar (train from creator's own photo or video)
Today's HeyGen integration only offers stock preset avatars; HeyGen itself already offers Digital Twin (from ~2 minutes of video) or a lighter photo-based custom avatar, and this app leaves a vendor capability completely unused. Expose HeyGen's custom/photo-avatar creation and consent-verification flow inside the existing avatar picker as an alternative to stock presets, gated to the paid tier given HeyGen's own credit metering.

### Medium -- Avatar gesture/expression preset chips
The HeyGen call today is a flat "generate one clip" with no performance direction, while HeyGen's own Avatar IV/V editor lets a creator assign gesture/expression per script segment via preset tabs. Expose a small set of preset gesture/expression chips (not free-text) attachable to script segments, passed through to the existing HeyGen API call — no new vendor integration required.

### Medium -- Avatar "Looks" -- variant outfits/backgrounds for a trained avatar
Once a custom avatar exists, HeyGen's "Looks" feature generates outfit/pose/background variants via text prompt without re-recording, letting one avatar cheaply cover many scenes. Ship only after custom avatars land, exposing a small set of niche-relevant prompt templates (storefront, outdoor, showroom) rather than a free-text box, consistent with the app's picker-based UX.

### Medium -- Multiple avatars in one scene (dialogue)
HeyGen recently added co-placing more than one avatar in a single scene, useful for a host+testimonial or two-presenter format relevant to hospitality and auto niches, though HeyGen's own natural turn-taking support is still immature. Track as a roadmap item: a simple two-avatar back-and-forth (alternating script lines rendered separately, then composited via Creatomate) could differentiate before HeyGen fully solves conversational turn-taking.

### Low -- Live/real-time streaming avatar -- SKIP
HeyGen's LiveAvatar offers sub-second-latency, two-way WebRTC-streamed conversational avatars, but this is a fundamentally different live/interactive product than this app's async reel-generation model. Explicitly name this as something HeyGen offers that this product does not need, to preempt scope-creep requests rather than silently ignoring it.

## Editing Fidelity & Compositing

### Critical -- Splicing clips of different shapes produces mis-cropped or stretched later clips only in the cloud render
The clip rectangle is computed once from the first clip added and silently reused for every later clip even if its shape differs (e.g. GoPro 16:9 after phone 9:16); preview and free export crop each clip's actual pixels correctly, but the cloud render stretches/squishes each later clip by a different, incorrect amount since it scales rather than crops. Recompute the crop for each clip against its own real width/height, and make the cloud compiler crop the same way (source-pixel crop) rather than stretch.

### Critical -- Live preview visibly softens or changes shape during zooms and photo cutaways, unlike either real render
The editor secretly shrinks its own working resolution as a Ken Burns zoom or clip-rectangle crop tightens, then stretches the smaller image back up with CSS, and a mismatched-aspect-ratio photo cutaway can briefly change the reel's own shape during preview only — a code comment even incorrectly claims this was already fixed. Fix the canvas to the project's real output width/height (the same helper both real renders already use) and only sample a smaller/larger source rectangle from it.

### Critical -- No canvas background fill for mismatched aspect ratios
Dropping 16:9 GoPro footage into a 9:16 canvas (or vice versa) forces black bars or a destructive crop with no fill option, directly contradicting the app's own stated persona of mixing phone and GoPro footage in one reel. Add a per-clip "Canvas fill" control (Blur / Solid Color / Gradient) implemented via Creatomate layering — a blurred full-bleed duplicate behind the cropped clip — with blur as the smart default, requiring no new render backend.

### High -- Dragging an avatar or overlay clip to frame a shot is ignored by the cloud render
A creator can drag/zoom a PiP clip, avatar overlay, or split-screen half to compose an exact shot, faithfully shown in preview/export, but the cloud render always shows a plain centered crop instead — potentially cutting off a HeyGen avatar's face. Pass each overlay's real source dimensions into the cloud compiler and compute the same pan/zoom crop window server-side, extending the fix to the split-screen base clip's independent framing too.

### High -- Color-filter looks render noticeably different (flatter/less saturated) in the cloud render
One-tap looks like "Vivid" or "Warm" show richer saturation in preview/export, but Creatomate's real color-filter feature can't do saturation/hue adjustments, substituting a milder brightness/contrast/tint tweak that only really matches for black-and-white. Rebuild the editor's preview filters using only the primitives the cloud renderer actually supports, or warn users these looks will look milder once cloud-rendered until that's done.

### High -- Non-green-screen AI background removal for cutaways/compositing
The app's target user (mobile/GoPro creator) essentially never shoots on a real green screen, so if compositing today only supports chroma-key, that's a real gap against the stated persona; CapCut and Canva both do subject/background matting on ordinary footage. Integrate a matting API via the same provider-abstraction pattern used for LLM/TTS as a pre-processing step before Creatomate assembly, gated as a paid-tier feature.

### Medium -- The exact "speed feel" of zoom/pan easing is assumed, never confirmed, to match the cloud render
Preview and free export use one hand-built easing curve; the cloud render trusts Creatomate's same-named built-in curve without ever confirming it computes motion the same way, so every zoom/pan could feel subtly different once cloud-rendered. Compare actual positions at several timestamps between a real test render and the editor's computation, and switch to dense manual keyframes if they don't match closely.

### Medium -- Unverified assumption about nested clip timing could shift zoom/transition timing when a clip also has a flip toggle
Whenever any clip is flipped horizontally, the cloud compiler wraps clips in an extra nested container, with an untested assumption about whether nested timing is measured from the clip's own start or the whole video's start — if wrong, flip+zoom/transition combinations could play at the wrong moment only in the cloud render. Render one real test project combining these and fix the timing calculation if it's off; the code already flags exactly what to check.

### Medium -- A looping video overlay that's also been trimmed can play the wrong section of its loop, only in the cloud render
When a short looping overlay gets split by a trim cut, preview and free export correctly figure out where each remaining piece should resume, but the cloud compiler's own code comment admits its math is only correct for the first piece. Do a real test render of a trimmed, looping overlay and fix the loop-offset calculation to match the free export's simple modulo math.

### Medium -- Editing or deleting one clip can silently break sync of narration and overlays placed later in the timeline
Resizing, editing, or deleting a clip correctly shifts every later clip's position, but three of four editing actions forget to shift PiP/avatar overlays or narration clips placed after that point — a sibling reorder function already does this correctly, showing it's a bug, not a design choice — so overlays/narration silently drift out of sync. Add the same timing-shift logic to the other three actions, ideally via one shared function all four call.

### Medium -- Two-speaker split-screen layouts and speaker-ID captions
A realtor-and-client walkthrough or hospitality host-and-guest interview is common in this app's niches, but the single clip-rectangle model has no equivalent for two co-located subjects; CapCut auto-labels captions by speaker and Opus Clip auto-switches to split-screen for multi-person footage. Add a small library of two-speaker layout presets (stacked split-screen first) plus speaker-tagged caption coloring once ASR provides per-speaker segments, kept as a preset picker rather than a freeform compositor.

### Medium -- AI B-roll suggestion assist from transcript
Manual stock import and cutaway placement exist, but Kapwing's Smart B-Roll and Opus Clip's B-roll insertion read the transcript to suggest matching clips at the right position; fully automatic placement is reviewed as "hit or miss." Ship as a suggestion, not auto-place: surface 3-4 candidate stock clips per script segment in the existing stock-import panel for manual drag-in, preserving precision while cutting search time.

### Medium -- Pre-render video upscaling for low-quality source footage
Older phones, low-light GoPro clips, or sub-target-resolution footage are common for this app's actual users, with no upscale step today; Runway's Magnific upscaler does temporally-aware AI upscaling up to 4K. Add an optional pre-Creatomate upscale pass via Runway's per-second-billed API as a paid-tier render option, after confirming Creatomate can cleanly ingest a pre-upscaled asset.

### Low -- Eye-contact/gaze-redirection AI
Descript's Eye Contact AI subtly redirects a speaker's gaze toward the camera when reading off-screen notes/a teleprompter — a distinct but narrower capability than this app's core Ken Burns + B-roll assembly workflow. Not urgent; reconsider only if raw self-recorded talking-head footage becomes a heavily used input path with real off-camera-gaze complaints.

## Transitions & Motion

### High -- The "Slide" cut-transition likely only moves one clip in the cloud render, versus a one-sided push in preview/export
The editor and free export show only the incoming clip sliding over a still outgoing clip — the developers' own comments admit this isn't a "true" dual-slide — while Creatomate's real slide animation most likely moves both clips by default since the app never tells it otherwise. Do one real cloud test render, compare frame-by-frame to preview, then either pin the cloud renderer to move only one clip or rebuild preview/export to move both, so the two agree.

### Medium -- "Wipe" cut-transition's exact look is an admitted, never-verified guess at Creatomate's actual output
The editor draws a simple straight-edged reveal, explicitly documented in code as "an approximation, not a literal match," never setting or checking Creatomate's real angle/softness options. Do one real test render, screenshot-compare against preview, and adjust the preview's shape (or pin explicit angle/edge settings) until they visibly match.

### Medium -- A transition shown smoothly in the live preview can silently become a hard cut in both real renders
If a creator trims the start off a clip with an incoming cut-transition, the editor still shows a smooth blend while scrubbing, but both real renders deliberately hard-cut instead in this specific situation — discoverable only after watching the finished video. Make the live preview aware of the same trim condition the render paths check, or better, fix the render paths to recompute and keep the transition using surviving footage.

### Medium -- Draggable speed-curve for speed ramping
CapCut and InShot expose speed ramping via a draggable curve with named viral-rhythm presets and optical-flow smoothing, which fits squarely inside this app's own direct-manipulation philosophy alongside the existing Ken Burns easing curve. Add a speed-curve control using the same drag-handle pattern, first checking Creatomate's schema for a time-remapping primitive per the standing feature-check rule.

### Medium -- Retroactive slow-motion via frame interpolation
Mobile/GoPro creators rarely shoot in dedicated high-fps slow-mo mode; Runway's frame interpolation generates in-between frames for smooth after-the-fact slow motion without requiring pre-planned high frame rates. Position as a premium filter option via Runway's API, triggered from the speed-curve control once it ships, making slow-mo another point on the same interaction.

### Medium -- Image-to-video animation as a "Ken Burns v2" option
Several niches (garments, gifts, hardware, real-estate listings) frequently supply only stock/product stills, and today's only motion option is mechanical Ken Burns pan/zoom; Runway's Gen-4.5 image-to-video animates a still with simulated camera movement and environmental motion while keeping the subject consistent. Offer as an alternate "AI motion" toggle next to Ken Burns on photo scenes, gated to paid tier, keeping Ken Burns as the zero-marginal-cost free default.

## Templates & Branding

### High -- Persistent per-account brand kit
Every niche business reuses the same logo, colors, and font across reels, yet text-overlay templates must be re-styled per project with no saved identity, unlike CapCut, Canva, Kapwing, Adobe Express, and HeyGen's own AI Studio which all ship a persistent brand-asset library. Add one Brand Kit per account (logo, 2-4 colors, one font pairing) stored alongside the existing niche `attributes` jsonb, threaded as defaults into text-overlay templates and caption styling at project creation — one kit per account is sufficient for a single-business-per-project POC.

## Niche-Specific Feature Needs

### High -- No niche-driven legal/regulatory disclosure overlay (Fair Housing Act text, auto financing APR disclaimer)
Real-estate marketing in the US is subject to Fair Housing Act equal-opportunity disclosure requirements, and auto financing offers typically require an on-screen APR/terms disclaimer — neither is addressed anywhere in the app today despite explicitly targeting these niches, and this is a compliance risk for creators, not just a feature gap. Since the niche-configuration module already generates per-niche fields, extend it to flag the applicable disclosure and offer a one-tap insert of the required text as a bound overlay, so shipping without it stops being the silent default.

### Medium -- No floor-plan or virtual-staging overlay for real-estate reels
Real estate is a named niche, yet there's no way to insert a floor-plan graphic, a "virtually staged" before/after toggle, or a lot-boundary/property-line overlay — table stakes for Zillow/Matterport-adjacent listing videos. A floor-plan image is just another per-project asset with its own overlay element type, making this a natural, low-risk extension of the existing niche `attributes` jsonb and overlay system.

### Medium -- No 360-degree spin/turntable capture or playback support for auto listings
Auto dealership reels are a named niche, but nothing in the editor or Creatomate compositing handles a 360-degree exterior/interior spin (a sequence of stills stitched into a draggable or auto-rotating turntable), which is now a standard expectation for online vehicle listings (CarGurus, Cars.com, dealer DMS tools all support it). This needs its own capture/stitch UX distinct from Ken Burns and should be scoped as a dedicated niche feature rather than folded into existing photo-cutaway handling.

### Medium -- No multi-location or menu/amenity callout overlay for hospitality reels
A hospitality business (hotel chain, restaurant group) often wants one reel to call out multiple locations, room types, or menu items with a label/pin overlay tied to a timestamp — the current single clip-rectangle + one text-template model has no equivalent. This is distinct from the two-speaker split-screen gap since it's about labeling places/items, not people, and fits the existing timestamp-anchored overlay pattern once generalized beyond captions.

### Medium -- No shoppable product-tag or price-sticker overlay for e-commerce-adjacent niches
Garments, gifts, and hardware niches sell discrete products with a price/SKU, but there's no visual product-tag/price-callout element (a small label pinned to a product in frame) comparable to Instagram/TikTok shopping tags or CapCut's sticker-price overlays. This is a cheap use of the same `attributes` jsonb (price, product name) already collected per niche, and should ship as a simple pinned-label overlay rather than a full shopping-cart integration.

## Aspect Ratio & Platform Fit

### High -- One-click multi-aspect-ratio re-export
The app renders only one 9:16 vertical reel per project, forcing a manual rebuild for a square Instagram post or 16:9 YouTube upload — one of the most repeated gaps across CapCut, Canva, Kapwing, Adobe Express, and Opus Clip. Start with a low-risk "duplicate project at new aspect ratio" action reusing the existing clip-rectangle crop system (extended to store a crop-per-ratio) and re-render via Creatomate at 1:1/16:9 with fit-to-center as default; defer true AI subject-tracking auto-reframe as a phase-two layer since it needs a CV tracking pass Creatomate doesn't provide natively.

## Platform-Specific Export Correctness

### High -- No safe-zone awareness for TikTok/Reels/Shorts UI chrome overlap
Each platform's own UI (username/caption/like-share-comment icons on the right edge and bottom third) covers different, well-documented regions of a 9:16 video, but nothing in the caption or overlay placement logic accounts for this. A caption or brand-kit logo placed at the bottom or right edge (both common defaults) may be permanently obscured by the host app's own chrome depending on where the creator posts, which is a different bug class from the render-path-parity issues above and worth a simple platform-toggle safe-zone guide overlay in the editor.

### High -- No screening for copyrighted background-audio/trending-sound licensing risk
The report explicitly skips building trending-sound template packages, but doesn't address the adjacent, unavoidable risk: once creators add their own background music or a future curated catalog exists, there's no check for content-ID/copyright risk before a video reaches TikTok/IG/YouTube, where an unlicensed track can get a reel muted, taken down, or demonetized after the creator already paid for a cloud render. Add a lightweight pre-flight check (a licensed-catalog allowlist, or a third-party content-ID API call on upload) before this becomes a real product-trust issue at scale.

### Medium -- No per-platform spec validation (duration/bitrate/codec) before or after export
The "one-click multi-aspect-ratio re-export" gap covers aspect ratio only; it doesn't address that TikTok, Reels, and Shorts also differ in recommended/maximum duration, bitrate, and codec/container expectations, so a single "export" output may be technically accepted but suboptimal (recompressed, re-encoded, or trimmed) on one or more target platforms without the creator ever being told. Surface a simple per-platform checklist/warning at export time, reusing the same Creatomate render-request parameters already being tuned for frame rate.

## Export, Rendering & Thumbnail Consistency

### Critical -- Captions, cut points, and transitions can land on a slightly different frame in every one of the three outputs
Preview, free export, and cloud render each round the same timeline into frames using three uncoordinated schemes — preview's frame rate gets coarser on longer clips, local export always bakes at a fixed 30fps, and the cloud render never tells Creatomate what frame rate to use at all. Captions, cuts, and transitions can visibly shift by a frame or two between what was previewed and what renders, worsening on longer reels — exactly the reels this product targets. Pick one fixed output frame rate (e.g. 30fps matching local export) and explicitly set it on the Creatomate render request too, so both real render paths work from the same frame grid.

### Critical -- Saved cover thumbnail is a blurry, slightly-wrong-moment snapshot, not the real frame the creator picked
Clicking "Use current frame" saves whatever is on the preview canvas, permanently capped at ~480px wide with soft resampling and (for anything but very short clips) up to a fifth of a second off the exact timestamp shown, since preview only samples 5-15 frames per second and gets coarser on longer clips. Capture the cover by seeking the original source video to the exact requested timestamp and drawing it at full/output resolution, using the seek mechanism already built for local export, instead of reading back the low-res preview canvas.

### Medium -- The editor gives almost no warning that its two render buttons can produce different-looking videos
Only one gap (auto-captions unsupported locally) is actually disclosed via a disabled button and tooltip; every other gap — overlay framing, audio ducking, caption fonts/outlines/backgrounds, color filters, karaoke accuracy — is completely invisible, making the two render buttons look like interchangeable siblings differing only by color. Extend the same disable-and-explain pattern to the other known gaps (e.g. warn when a project has overlay audio balance set or non-default overlay framing) so creators aren't surprised after paying for a cloud render.

### Medium -- The cloud Render button is currently disabled, so all cloud-specific bugs above are dormant -- but nothing stops them shipping the moment it's turned back on
The cloud-rendering code path is fully built and reachable, just not wired to the UI, meaning every critical/high cloud-render finding in this report is a live landmine for whoever removes the "coming soon" popup, with no checklist tying re-enablement to fixing them. Add an explicit release checklist (or feature flag) that ties re-enabling the cloud Render button to closing the specific gaps already flagged in this report and in the code's own comments.

### Low -- Saved cover thumbnail can permanently capture an in-editor-only visual glitch
The color filters and transition blends shown live in the editor are known, accepted approximations of the real render; if a cover thumbnail is saved during one of these approximations, the permanently-saved image reflects a look Creatomate would never actually produce at that timestamp. Once full-resolution, exact-timestamp capture is implemented, render that frame's color filter using the same primitives as the real render and avoid capturing during an active transition window.

### Low -- The saved cover-thumbnail timestamp doesn't reflect the exact instant the saved image actually came from
The stored timestamp is the raw continuous playhead position, not the specific coarser preview frame the saved pixels actually came from — harmless today since nothing re-uses this timestamp, but a trap for any future "regenerate this cover in higher quality" feature. Either store a timestamp matching the actual sampled frame, or clearly document that this field isn't frame-accurate re-seekable.

### Low -- Live preview and free export use two subtly different definitions of "one loop" for a looping overlay clip
Preview deliberately uses the audio track's own exact length to decide the loop point (avoiding a real audio/video drift bug it already fixes for), while free export just uses the video file's reported length — almost always equivalent but capable of disagreeing by a fraction of a frame. Move the preview's loop-duration logic into the shared math library so free export calls the identical function, removing the possibility of disagreement.

## Accessibility

### Medium -- No caption contrast/color-blind-safe validation for low-vision viewers
The caption findings elsewhere in this report are all about matching preview to render, but none check whether any caption style/color combination actually meets WCAG-style contrast minimums against arbitrary busy footage. A creator picking a stylish-but-low-contrast preset (e.g. light gray text with a thin outline) currently has no warning that the result may be unreadable for low-vision viewers regardless of which render path produced it; add a simple contrast estimate against sampled frame luminance and flag risky combinations in the style picker.

### Medium -- No accessibility review of the editor UI for the creator using it
Every accessibility angle assessed elsewhere is about the finished video's viewers; none address whether the direct-manipulation editor itself (drag handles, timeline scrubbing, color pickers) is usable via keyboard alone or with a screen reader. This is relevant since the product's own stated persona (an on-site agent, dealership floor staff) plausibly includes creators who need this, and drag-only interactions are a common accessibility blind spot worth at least flagging as unassessed and auditing before it compounds across more drag-based features.

### Low -- Captions cover spoken words only, with no non-speech sound captioning (SDH-style)
Every caption mode transcribes or renders spoken TTS/narration text, but none capture non-speech audio cues (background music mood, a doorbell, applause, a car engine revving) the way proper SDH (subtitles for the deaf and hard-of-hearing) does. For a deaf/HoH viewer this means all non-verbal audio information in a reel is simply lost — a materially different gap from the caption-fidelity bugs already listed, and one to revisit once ASR-based captioning (below) gives the pipeline a transcript to annotate against.

### Low -- No audio-description track option for blind/low-vision viewers
Audio description (a narrated track describing key visual content — a product's appearance, an on-screen price, a room layout) for blind or low-vision viewers is absent from both the current feature set and any near-term plan. Even a lightweight version — auto-generating a spoken description of on-screen text/attributes via the existing TTS pipeline — would close real ground here without a new vendor integration; treat as a later-phase extension of the existing TTS/script pattern rather than urgent now.

## Raw-Footage Editing Automation

### Medium -- Automatic silence & filler-word removal for raw talking-head footage
Creators who film themselves talking to camera (real-estate walkthroughs, auto reviews) rather than using TTS/HeyGen avatars have no automated trim step today, only manual clip trimming, unlike Kapwing's Smart Cut and Descript's filler-word removal. Add an optional ASR pass (needed anyway for auto-captions below) that proposes cut points on the existing timeline with an adjustable aggressiveness slider, letting the user approve/reject rather than auto-committing.

### Medium -- ASR-based auto-captions from live-recorded narration
The caption pipeline only works from a typed TTS script with known word timing; a creator who narrates live on-camera has no caption path at all, unlike InShot, CapCut, and Descript's one-tap speech-to-text auto-captions. Add a speech-to-text step as an alternate caption-track source alongside the existing TTS-script path, feeding the same downstream karaoke/background caption rendering so the style system works unchanged regardless of transcript source.

## Collaboration & Sharing

### Medium -- Lightweight shareable review link with approve/needs-changes flag
An agency editor plus a client (e.g. the real-estate agent or dealer owner) is a realistic workflow this solo-editor product doesn't serve today; Kapwing's lighter pattern — timestamp-pinned comments plus a shareable review link with a status flag — closes much of this gap without full real-time co-editing's sync complexity. Ship only the lightweight slice: a read-only shareable preview link, a single approve/needs-changes toggle, and threaded comments pinned to a timeline position.

### Low -- Full real-time multi-user co-editing -- SKIP
Kapwing and Canva support simultaneous multi-cursor live editing with presence indicators, which architecturally requires a CRDT/OT sync layer that doesn't exist in this codebase and isn't justified for a solo-creator SaaS POC with no team/account-sharing model. Ship the lightweight review-link alternative instead, and revisit full co-editing only if a team/multi-seat account model is actually on the roadmap.

## Monetization & Paywall Strategy

### Medium -- Finer-grained paywall metering beyond binary free/paid
The app's role gate is a single free/paid flag blocking render/TTS/avatar outright, while nearly every competitor (CapCut's tiers, Canva's per-feature caps, Descript's credit metering, VEED's per-feature credit pools, Adobe's capacity gating) meters specific expensive actions instead of an all-or-nothing switch. Layer feature-specific caps onto the existing `usage_events`/fixed-daily-cap mechanism (separate counters for avatar generation, voice cloning, dubbing, upscaling, etc.), still consistent with the repo's "no billing during POC, but abuse-rate-limiting is in scope" stance.

### Medium -- The "upgrade required" moment is unassessed as a persuasive product experience, not just a functional gate
The existing metering entry treats the paywall as a technical mechanism, but never evaluates the actual UX of the block itself — does it show a preview of the gated feature's output, a clear price/value proposition, a trial credit, or a comparison against what the creator is missing, the way CapCut/Canva/Descript/VEED all invest heavily in upsell craft at the exact moment of highest intent. Design the upgrade prompt as a persuasive moment (preview thumbnail of the locked feature, one clear call to action) rather than the current all-or-nothing message, which may just read as a wall with no case behind it.

### Medium -- No mention of whether free-tier local exports carry a watermark
Nearly every competitor (CapCut, Canva, Kapwing) uses a visible watermark on free-tier output as both a growth loop and a paywall incentive; it is currently unstated whether this app's free local export is watermarked. If it isn't, that's a missed low-effort monetization lever worth a deliberate decision rather than an accidental default — flag it explicitly rather than leaving it implicit.

## Reliability & Operational Resilience

### High -- No upload retry/resume for large clips on flaky mobile connections
The project's own README documents that the render-transfer worker acknowledges a transfer before it completes with "no retry and no durable queue," so a crash or redeploy mid-transfer silently loses the job. Separately, asset uploads from a phone-first creator (the app's stated primary persona, and the exact audience the in-progress mobile Quick-Create flow targets) over real mobile data have no visible chunked-upload, retry-on-drop, or resume-after-interruption behavior — a multi-hundred-MB GoPro clip failing partway through a spotty connection currently just fails, with no partial-progress recovery, which directly undermines the app's core persona.

### High -- No creator-facing recovery path when a cloud render fails or silently stalls
Many findings in this report cover ways a cloud render can look wrong, but none address what happens when Creatomate's render or the R2 transfer step fails outright (network error, Creatomate-side failure, or the worker crash the README already flags as a known silent-loss scenario). It's unclear whether the creator is notified, can retry without re-uploading assets or losing their place in the daily render-cap count, or whether any dead-letter/support-visible record of a failed job exists for debugging — all of which should be defined before the cloud Render button ships.

## Trust & Safety

### Critical -- No content-moderation step for user-uploaded photos/video before public CDN hosting
Finished renders are mirrored to a public, custom-domain R2 bucket served globally with no access control, but nothing addresses whether uploaded source assets or generated output are screened for prohibited content (nudity, violence, illegal material) before being hosted at a public, guessable-or-indexable URL. This is a real trust-and-safety and potential legal-liability gap for any product accepting arbitrary user media, independent of and unaddressed by every quality/fidelity finding in this report, and should be treated with the same urgency as the WYSIWYG critical bugs since it's live today, not gated behind an unreleased button.

## Scope Exclusions (Philosophy)

### Low -- Deep manual keyframe animation editor -- SKIP
InShot's generic keyframe editor and Runway's Motion Brush (paint per-region motion vectors, tune multiple parameters) are exactly the "pro NLE" pattern this app's driving vision explicitly avoids defaulting to. Do not build a generic keyframe UI or motion painting; if finer motion control is ever needed, wrap it into an extension of the existing Ken Burns drag-handle instead.

### Low -- Conversational/chat-driven AI editing sidebar -- SKIP
Descript's "Underlord" lets a user type an instruction and have AI run filler-removal, sound cleanup, and clip selection as one chat-driven action — a meaningful divergence from this app's direct-manipulation philosophy. Name this explicitly as a road not taken; keep any AI automation expressed as a proposed-then-approved timeline action, never a freeform chat command.

### Low -- Full transcript-document-style editing paradigm -- SKIP
Descript's defining feature (delete a word in a transcript to cut the corresponding audio/video) assumes long raw takes needing trimming, but this app's flow starts from a written script generating TTS + Ken Burns B-roll from scratch, leaving little raw footage to trim. Only reconsider if the roadmap adds raw voiceover/on-camera footage as a first-class input, and even then prefer approve/reject cut suggestions over a full document-editing interface.

### Low -- Chasing massive template-library scale -- SKIP
Canva (1.6M+ free templates) and Adobe Express (100,000+ templates, 200M+ stock assets) compete on raw catalog breadth that a niche-generic reel generator cannot realistically match. Compete on curation-for-niche relevance via the existing LLM-driven niche-configuration module instead of template count — the more defensible, on-thesis differentiator.

### Low -- AI virality/engagement prediction score -- SKIP
Opus Clip's 0-99 Virality Score is a plausible upsell hook, but Opus's own docs describe it only as directional "insight," and independent reviews report frequent inaccuracy. If pursued later, frame strictly as soft creative feedback (e.g. "consider a stronger hook") rather than a numeric score this app's smaller usage base can't back up.

### Low -- Long-form-to-shorts auto-clip selection (ClipAnything-style) -- SKIP
Opus Clip's core product ingests an entire long recording and auto-identifies reel-worthy moments — a fundamentally different starting point than this app's assemble-and-polish workflow from footage the creator already selected. Do not build this unless the roadmap explicitly pivots toward "upload your raw roll, we'll find the best 30 seconds," a significant scope expansion distinct from the current product.

### Low -- Trending-sound template packages -- SKIP
CapCut's weekly templates bundle a specific licensed trending sound with matching cuts — a legally heavier growth-loop mechanic (music licensing) than this app's current niche-focused text-overlay templates, and a mismatch with a niche-business (not trend-chasing) positioning. Revisit only if a specific music-licensing arrangement becomes feasible.