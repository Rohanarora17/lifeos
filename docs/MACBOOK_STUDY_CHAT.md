# MacBook study conversation

The approved Endsem commitment is eight hours daily from **22 October through 13 November 2026**, in Asia/Kolkata. Probability is on **10 November** and ADSA on **13 November**. The Mac conversation and the web Study check-in share saved agreements and the same study ledger.

## Use

Open **LifeOS → Study Chat** from the Mac menu. The web equivalent is in **Study Plans**, or **Jarvis → Study check-in**. No active Guardian session or microphone is required to chat. Measuring computer study still requires the existing collector readiness and Screen Recording permission.

Start by stating today's waking and study-end times, for example `I wake at 08:00 and sleep at 23:00`. These are examples, not preset meal or sleep times. The app asks for missing constraints rather than assuming them.

| You say | LifeOS saves or asks |
| --- | --- |
| `I'm going for lunch` | Departure, then a return-time question |
| `Back in forty minutes` | Return forty minutes from this reply |
| `Another twenty minutes` | Extends the latest agreement, retaining the original departure |
| `I'm back` | Closes the absence and proposes the next study start |
| `Make it ADSA instead` then `yes` | Changes the pending subject, then requests the actual Guardian start |
| `My ADSA class is running late` | Resolves the class and asks for its revised end if missing |
| `I attended Probability from 11:00 to 11:30` | Confirms a known occurrence and actual past attendance interval |

An ordinary reply, a scheduled class, opening chat, or returning from lunch earns zero study time. Measured evidence, self-reported paper study and confirmed self-reported class attendance are distinguished. Overlap counts once. Anticipated future class minutes affect planning capacity but do not increase earned time.

Replanning changes future unstarted LifeOS study blocks around calendar commitments and declared breaks. Existing completed, active and other manually planned work is preserved. If a manual session conflicts, LifeOS asks for resolution. Internal replanning does not silently write to Google Calendar. An explicit Guardian start retains that existing workflow's session behavior.

## Follow-through

The native panel presents an agreed return at its deadline, permits five minutes of grace, then repeats overdue follow-up at most every ten minutes during the explicit waking window. It retains the original departure and latest agreement. Missing return time receives a follow-up rather than indefinite protection. Calendar commitments and agreed sleep suppress conflicting attention.

Existing presence checks have priority, followed by classification prompts, then queued study prompts. Proactive study presentation does not activate the application or steal typing focus. Click the composer or open Study Chat from the menu to type. Minimizing or closing hides the panel without resolving an agreement. Drafts, pending requests and saved conversation survive polling and reopening.

Network failures show an unconfirmed-save message. Retry uses the same immutable message, request ID, revision and IST date. A conflict requires reviewing current state and explicitly resending. The server rejects stale or duplicate mutations; the native client does not invent offline agreement changes.

Once conversational mode is activated by a message, the older fixed 12/16/20/22 checkpoint loop stops. Routine coaching consults the same protection state. Pause controls quiet accountability; they do not erase the goal or prevent chatting. Input closes after the campaign; historical results remain available through the Endsem daily record.

## Calendar certainty

Runtime reads the calendar configured in LifeOS, not a Codex connector. ICS sync records freshness even when a successful feed is empty. A complete paginated OAuth read can be used as fallback. Failed, stale, malformed or unsupported feeds do not establish a free day.

The shared ICS reader uses the existing configured feed and expands named time zones, recurring classes, excluded dates and moved/cancelled occurrences. Floating and all-day times retain LifeOS’s IST interpretation. Malformed dates, unknown time zones and unsupported RDATE/EXRULE/range-wide recurrence changes fail before any mirror updates; a failed read never establishes free time. No new Google authorization is needed for an already connected compatible ICS feed. Long ongoing commitments are imported by overlap. Linked focus mirrors are deduplicated only when they represent the same interval; external moves remain protected conflicts.

The eight-hour target never shrinks to fit available time. When a confirmed window is too small, LifeOS reports the shortfall and asks which future commitment or window can change. Unconfirmed calendar/day boundaries mean unknown capacity, not a fabricated shortfall.

## Activation and operation

Migration `053_endsem_lock_in.sql` adds the counter; `054_study_chat.sql` adds conversation state. Normal server initialization applies both. Back up the host database through the established deployment workflow before updating production. Deploy the verified source to the Mac Mini and restart its existing server service; a local development server does not update that host.

Then update the existing Mac client on the intended MacBook:

```sh
cd /Users/rohan/.gemini/antigravity/scratch/lifeos
bash scripts/install-native-copilot.sh --update
```

The client version is **0.4.0**, build **4**. It uses the existing scoped device credential from `~/.config/lifeos/client.env`; no administrator API token belongs in the client. Preserve the existing signing identity to retain its Screen Recording identity. The server and native binary must both be updated for Study Chat to work. No iPhone or OS-lock enforcement is part of this delivery.

## Verification commands

Use isolated databases for test mutations; do not run reset/fixture scripts against real study history.

```sh
node --test tests/unit/study-chat*.test.cjs tests/unit/study-day-planning.test.cjs tests/unit/endsem-*.test.cjs tests/unit/jarvis-study-chat.test.cjs
npm test
npx tsc --noEmit --pretty false
npx eslint src/lib/study-*.ts src/lib/endsem*.ts src/app/api/study-chat/route.ts src/app/api/chat/route.ts src/components/StudyChat.tsx src/components/EndsemLockIn.tsx src/app/chat/page.tsx

SWIFT_MODULECACHE_PATH=/tmp/lifeos-study-chat-modules CLANG_MODULE_CACHE_PATH=/tmp/lifeos-study-chat-clang \
  swift run --disable-sandbox --package-path macos/LifeOSCopilot \
  --scratch-path /tmp/lifeos-study-chat-build --cache-path /tmp/lifeos-study-chat-cache StudyChatCoreTests
```

The bounded `--study-chat-preview` diagnostic uses the actual AppKit panel with a loopback fixture, without the collectors, saved preferences or permission requests. Reproduction commands are in the implementation reports. It exercises window focus, prompt priority, polling, drafts and reopening; it does not prove real comprehension, attendance, or production capture quality.

Verified on 23 October 2026: **350/350 unit tests**, production build, TypeScript, scoped ESLint and **11 native core checks** passed. Earlier native release compilation and **9 AppKit checks** passed, including the panel against an isolated local LifeOS server. The final built server also accepted scoped-device lunch check-ins and an idempotent retry without Guardian or earned study credit.

The approved plan records the detailed evidence and limits. Production activation and a short acceptance check while another application is being typed in remain pending. The code is implemented locally; the Mac Mini server and installed MacBook client have not been updated.
