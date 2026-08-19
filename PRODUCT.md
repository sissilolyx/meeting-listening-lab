# 英语精听训练

register: product

## Product purpose

Turn real English meeting recordings into intensive English listening practice without replacing the original voices. The current release is a source-available, noncommercial, locally self-hosted macOS build for one learner per installation.

## Primary user

The learner imports an English work meeting from a Feishu/Lark Minutes link or a local audio/video file. They want to hear the real meeting again in manageable units, check what they heard, understand workplace expressions, and return to difficult moments later.

## Core loop

Import real material, listen without text, optionally type what was heard, reveal and compare the transcript, understand the meaning and useful expressions, then optionally add the unit to review. Completing playback records that it was heard; no separate mastery confirmation is required.

## Product principles

- Original sound is the source of truth. Never generate replacement speech.
- Local media can enter through the file picker, drag and drop, or a pasted Mac Voice Memos recording; all three use the same local-only import pipeline.
- Real work context matters more than textbook completeness.
- Listening comes before reading. Explanations stay hidden until the learner asks.
- Learning is learner-led after reveal. Any selected expression can become an in-context question for the learner's selected AI provider and, when useful, a review note bound to its exact natural sentence.
- The application has one global study mode. Intensive listening follows a single material from its saved natural segment; review draws only saved review targets and can span every material or stay within one remembered material scope. The last mode and review scope persist locally.
- Material completion is explicit but lightweight. Finishing the final natural segment through uninterrupted original-audio playback marks that material complete and acknowledges the milestone once. The learner can mark it incomplete again without losing listening progress, dictation, review notes, or question history.
- The only main practice unit is a natural segment: a coherent stretch grouped by speaker continuity, pauses, and complete sentence boundaries. Natural sentences remain available after reveal for sentence-by-sentence explanation and precise original-audio playback, not as a selectable practice mode.
- A standalone, high-confidence acknowledgement such as “Okay.” does not become its own practice unit. It remains a speaker-attributed trailing context turn on the preceding natural segment: playback includes it, while transcript, progress, and explanation stay focused on the substantive speech.
- A long-turn split must not make the original speech feel abruptly cut. When adjacent natural segments are the same uninterrupted speaker turn from the same source block, the later segment may replay a small amount of the previous segment as listening context while keeping its own transcript and learning state unchanged.
- Knowledge-point review remains bound to the exact sentence where it was learned. In the single practice flow, any segment containing a saved sentence-level knowledge point appears in review; saving or removing the whole natural segment remains a separate explicit choice.
- Long meetings must remain resumable: every material entry opens the whole unit map at the furthest listening position, while retaining heard states and an explicit return path when needed.
- Listening progress and review are separate: a unit is either unheard or heard, and review is an optional marker rather than a mastery state.
- Question threads follow a document-comment mental model at natural-segment scope. Each segment owns its own visible rail of independent cards; pending questions keep running when the learner changes segments, and reappear only when the learner returns to their source segment.
- Keep the data boundary explicit. Media, progress, and question history stay on the learner's computer and are never stored in the repository. Only the text context needed for requested analysis is sent to the learner's explicitly selected, locally authenticated Codex or Cursor account; original media is never sent.
- Fail visibly. Never switch to a separately billed API or request Feishu access automatically.

## Tone

Calm, exact, encouraging, and adult. Avoid gamified streak pressure, school-test language, and inflated AI claims.

## Non-goals for v0.1

Accounts, public hosting, mobile apps, AI voice generation, pronunciation scoring, speaker editing, social features, and a full spaced-repetition scheduler.
