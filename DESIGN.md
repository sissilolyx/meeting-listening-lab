# Design direction

## Physical scene

The user studies a real work meeting on a MacBook during a quiet break in a bright office. The interface should reduce glare, keep the original recording visually present, and make repeated listening feel deliberate rather than clinical.

## Color strategy

Restrained, warm-tinted neutrals with a persimmon accent reserved for the current listening action. Moss confirms saved learning notes; muted plum indicates review. All colors are expressed in OKLCH.

## Typography

Use the native Apple sans-serif stack. English transcript text is larger and more open than supporting Chinese explanations. Body text stays below 72 characters per line where possible.

## Layout

- Desktop: compact material rail, media stage, and focused training column.
- Narrow screens: media stacks above training; the library becomes a top-level view.
- Avoid nested cards. Use planes, rules, spacing, and typography to establish hierarchy.
- The current natural segment is the visual center. Its sentences become the explanation structure only after reveal.

## Motion

Use short opacity and transform transitions with ease-out-quint. Never animate layout dimensions. Respect reduced-motion preferences.

## Interaction principles

- Space toggles playback when focus is not inside a text field.
- R replays the current unit; left and right arrows navigate.
- Clicking or pressing left/right restarts and automatically plays the target natural segment.
- After the learner reaches the bottom of a revealed segment, provide an in-flow next-segment action. It returns to the top of the listening workspace and immediately plays the next natural segment; the final segment shows a completion state instead of a false next action.
- Opening any material uses one practice flow based on natural segments. There is no playback-granularity switch; natural sentences appear only inside the revealed explanation and through their original-audio buttons.
- The local-file panel accepts picker selection, drag and drop, and Command-V paste. Voice Memos paste receives the audio file when macOS exposes one, names the accepted file visibly, and explains the browser boundary when the clipboard contains only text or an unsupported reference.
- Show current-unit playback progress and elapsed/total time separately from overall study progress.
- When a long uninterrupted source turn needs more than one natural segment, start the later segment with a small overlap from the preceding segment. Show the overlap in the playback label and mark where the target segment begins on the local progress track. Speaker changes, source-block changes, and pauses do not receive this lead-in; heard progress still measures only the target segment.
- Do not give a standalone “OK/Okay” acknowledgement its own directory row. Keep it as a compact, correctly attributed trailing response under the preceding segment, include its real audio at the end of that segment, and exclude it from the target transcript, explanation count, and heard-progress requirement.
- Sentence playback is coverage-first but concise. Preserve Lark wording and speaker turns, then use local Whisper only to align a minimal playback envelope around the complete displayed sentence. A small safety margin is allowed; whole adjacent sentences are not. If high-confidence alignment is unavailable, fall back visibly and conservatively rather than presenting an estimated boundary as exact.
- The current-unit progress track supports click, pointer drag, touch, and keyboard seeking. Seeking alone never marks a unit heard; only an uninterrupted pass from the beginning may qualify.
- Stop playback whenever the training view is hidden or unloaded; stale loading callbacks must never restart an earlier unit.
- A quiet side directory shows every unit by number, speaker, time, and learning state without revealing transcript text. Selecting a unit jumps to it and plays the original sound.
- On wide desktop screens, the directory sits inline between the material rail and the recording, without a dimming scrim, and remains open while units are selected. On narrower screens it becomes a right-side overlay.
- Every material entry opens its directory by default and centers the latest listening position, using whichever is later between the saved position and heard progress. The learner can still collapse it for the current visit.
- Each library item shows natural-segment listening coverage as both a percentage and heard/total segment count. A segment counts only when all of its natural sentences have been heard.
- Library items can be pinned and reordered locally. Pinned items stay above unpinned items; each group supports drag ordering and Option + arrow keyboard ordering. New unpinned materials start ahead of older unpinned materials until the learner adjusts them.
- Double-clicking a material title turns that title into an inline editor. Enter or blur saves the local title, Escape cancels, and an empty value never overwrites the existing name. Renaming the open material updates both the library entry and the training heading.
- Material-management actions belong to the library rail. The trash entry stays at the bottom of the left rail on desktop, never floats over the learning area, and remains available in the compact top rail on narrow screens.
- On desktop, the material rail can collapse into a narrow icon rail for focused study. The compact rail keeps a clear expand control, the home mark, local-status indicator, and trash access; the saved preference survives reloads. At 760 px and below, the existing compact top rail takes precedence and the desktop collapse control is hidden.
- Mark a natural segment heard only after at least 90% has played. The single natural-segment position is saved and exposed through an explicit resume action.
- On desktop, the media and practice columns can be resized with a persistent separator; keep both panes usable and return to a single column on narrow screens.
- Transcript and analysis are hidden before reveal.
- When the learner entered a dictation, the reveal flow prioritizes the dictation-difference block before the full transcript. Without a dictation, the full transcript remains the first revealed content.
- After reveal, selecting text in either the source transcript or the dictation-difference block exposes the same small anchored “问问这处” action. Its default question asks both how the selection is pronounced and what it means in context. Difference text remains grouped by natural sentence so every follow-up and saved summary keeps the exact sentence context.
- Opening “问问这处” creates a persistent comment thread rather than a disposable popover. Scrolling and outside clicks never close it; the thread follows its source while visible, docks at the viewport edge when the source leaves view, and offers “回到原文”. A pending Codex answer remains attached to that thread until it resolves, and only explicit close, Escape, or leaving the material dismisses it.
- Multiple follow-up requests may finish out of order, but each answer is saved to its own source expression and never replaces another open thread or overwrites newer learning state.
- Saved question histories can collapse as a whole and can be deleted one record at a time with inline confirmation. Deleting history never silently deletes a review item that was already saved from it.
- Pronunciation controls beside IPA use the system English voice for the exact nearby word or phrase. They are teaching aids only and never replace, pause, or synthesize the meeting recording.
- Existing phrase rows offer both “加入复习” and “深入问问”. Saved follow-up summaries stay attached to the exact sentence, while the containing natural segment becomes reachable through “只听需复习”; segment review remains an explicit separate action.
- Completing playback marks a natural segment heard automatically. The only explicit unit-state action is “加入本段复习”, which explains that the segment will appear under “只听需复习”; there is no separate mastery state. Segment review creates one segment item instead of silently turning every sentence into a separate review item.
- When “只听需复习” is active, playback, looping, replay, seeking, and the local progress bar continue to use complete natural segments. A saved sentence-level phrase or question makes its containing segment eligible without changing the explicit whole-segment review button.
- For Lark Minutes, preserve the official transcript as the source of truth; local ASR must not replace its wording or speaker turns.
- Every async stage names what is happening and preserves completed work after failure.
- Focus states and button labels remain visible and keyboard accessible.
