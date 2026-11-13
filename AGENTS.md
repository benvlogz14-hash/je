# Euclidean: handoff for a new coding agent

You are picking up **Euclidean**, the desktop app of Euclidean Media (founders Ryan Rosario and Ben Gingold), a
short-form video agency for creators and political campaigns. **Read `CLAUDE.md` first**: it is the full map of the app
(every module, API route, setting, and what was tested). This file adds what a new agent needs to work on the
**political ad machine** well: the craft (hooks, cuts, transitions, sound), the code path, the hard rules, and how to test.

The ads are sent to **real elected officials** as free samples. They have to stand next to work from paid graphics teams.

---

## 1. Rules that are never broken

1. **Only the politician's own recorded words.** No synthetic voice, no invented quotes, no rewording. Taking out a
   pause, a stutter or a leading "And," is allowed. Re-ordering words into a new sentence is not. Headlines on screen
   are copied word for word from the line being spoken (`adengine.findRun` enforces it).
2. **Every claim on screen is grounded**: said in that line, in the office title, or in the researched facts
   (`footage.groundGfx`, `codeGfx`). A number not in the material is never shown.
3. **Never fake a face or voice.** Small "Concept by Euclidean Media" tag on the end card (`political.conceptTag`).
4. **Nothing is sent, posted or changed in a CRM without a person approving it.** Political emails are always sent by
   hand. The ad machine only makes files and drafts.
5. **Do not touch the clip machine** built for Stringer (creators): `server/video/montage.js`, `align.js`,
   `intelligence.js`, `pipeline.js`, `render.js`, `captions.js`, `styles.js`, `taste.js`, the music cue code, and the
   `discover` / `render.short` jobs. It was reverted once after "improvements" that passed synthetic tests and ruined
   real clips. The political machine has its own files (below) and its own cutting code (`server/political/edit.js`).
   Shared helpers (`ffmpeg.js`, `facetrack.js`, `vision.js`, `music.js`) may be *called*, not changed.
6. **Write for beginners.** Plain-English errors, setup through buttons, no terminal or JSON for the user. No em dashes
   in anything the app writes. `.bat` files keep CRLF.
7. Commit and push finished work to the working branch. No pull requests unless asked. No new dependencies without a
   reason (an update must not need `npm install` if it can be avoided).

## 2. The machine, end to end

```
footage (uploads, pasted links, Google video search)
  └─ server/political/footage.js   prepare(): transcribe → look through shots → sentences → pickStory()
        story = hook → who → proof → place → story → rally   (shapeStory checks the hook and the closing line)
  └─ server/political/adengine.js  make():
        plan      basePlan (code) + aiPlan (optional) → mergePlan (only keeps what passes the checks)
        cut       edit.snapLine → edit.cutLine   (cuts in the quiet between words, pauses closed, one level)
        spec      buildSpec: sections on the voice's timeline (headline, footage, captions, graphics, end card)
        render    Remotion (remotion/PoliticalAd.jsx + Flair.jsx) in a worker process
        sound     sfx.plan → mixSound → edit.master (-14 LUFS)   then  edit.qa measures the finished file
  └─ server/political/package.js   the package steps (research → footage → video_v / video_h / video_hl / video_s →
                                   sheet → email); results on prospect.pkg; any step can be re-run
  └─ server/political/autoads.js   hands-off, many leads at once (25 at a time)
```

| File | What it owns |
|---|---|
| `server/political/footage.js` | finding/downloading footage, transcripts, sentences, the story picker, topics, B-roll lists |
| `server/political/edit.js` | natural cut points from the audio, pause tightening, per-line level, master, after-render check, face position |
| `server/political/sfx.js` | interface sounds synthesized in code, the sound plan, FFmpeg mix arguments |
| `server/political/adengine.js` | the plan, the spec, maps, the Remotion bundle/browser/worker, the final mix |
| `server/political/looks.js` | styles as plain data: presets, validation (`normalize`), from a typed prompt, graphics level |
| `remotion/PoliticalAd.jsx` | one generic composition that draws any spec in any look |
| `remotion/Flair.jsx` | each style's signature moving extras (under / with the card / over / end card) |
| `server/political/package.js` | steps, versions, restyle, what is saved on the lead |
| `renderer/js/modules/political.js` | the Ad machine panel (candidate, footage bank, style, graphics level, story, finished ads) |

A **spec** is plain JSON: `{ w, h, fps, total, voiceEnd, segs[], words[], voice[], end, look, fonts }`. Each `seg` is a
stretch of the timeline: `{ line, at, dur, bg, head: { words: [{ w, key, t }] }, card: { kind: video|photo|map|stat,
src, from, fx, face, jumps }, tilt, plate, tag, icons, pill, badge, hook, rally }`. If you want a new graphic, add a
field to the seg in `buildSpec`, draw it in `PoliticalAd.jsx`, and ground it in `footage.js`.

A **look** is plain data with a fixed set of options (see `OPTIONS` in `looks.js`). The AI may only choose from those
options, real hex colours and bundled fonts, so any prompt gives a look that renders. `normalize` fixes anything else
and computes readable text colours per section.

## 3. Styles

Ten main styles (shown first; eight more under "More styles", Clean and Grassroots among them), each in 9:16 and 16:9:

| id | Name | What it is |
|---|---|---|
| `bold` | Bold blocks | the house reference: navy / yellow / red sections, tilted footage card, Anton caps headline built word by word, boxed key words, diagonal 3-band wipes, captions on the card's lower edge |
| `pastel` | Pastel blocks | the same build in soft colours, orange headlines with a dark outline, yellow-on-navy key boxes |
| `street` | Street vlog | full-screen footage, a white flash and a punch-in that settles on **every** cut, big outlined captions under the face, sticker words, transit-style tags |
| `field` | On location | to-camera on the street: full-screen, **hard cuts**, small bold serif captions a phrase at a time with a soft shadow, an orange place title, a plain brand end card. Captions only |
| `direct` | To camera | one take cut like three cameras: wide / medium / close punch-ins on every sentence and clause (`look.angles`), small clean sans captions a phrase at a time, hard cuts, plain end card. For announcements and explainers |
| `tiktok` | Full-screen TikTok | giant centre captions, zoom punches on key words |
| `cinematic` | Cinematic | black bars, serif, slow fades, film grade, grain |
| `news` | Breaking news | red/black bars, ticker, flashes, corner bug |
| `patriotic` | Red, white and blue | classic campaign, flag-stripe end card |
| `dark` | Dark and urgent | black and red, black-and-white footage (contrast energy; contrast ads always need a person) |

**Graphics level** (`look.density`, the "How much graphics" control): `full` = everything; `light` = headline,
captions, name and proven facts (no icons, stickers, map, badge or the style's extras); `minimal` = captions, the name
and small fact tags only. On card layouts `minimal` enlarges the footage to take the headline's room. `field` is
`minimal` by default; any style can be set to any level.

References the founders sent, and what was learned from each:

- **The house reel** (Kelles / Hooks / Alvarez / Lavine, the `bold` look): one idea per colour section; the headline is
  the spoken phrase and finishes building just as the phrase ends; one boxed key word per headline; the map appears on
  the line about the place and zooms state → district → pin → label; grounded tags ("PhD, nutritional epidemiology",
  "Serving since 2019", "$250,000 for UCP") sit under the card; a B-roll cut-in every 4-6 s while the voice carries on;
  end card = portrait in a ring, name, office.
- **The Mamdani polar-plunge explainer** (the `field` look): no motion graphics at all. What makes it work is the
  *edit*: a visual hook in the first second (a man in a suit on a winter beach, "I'm freezing... your rent"), a cut
  every 2-4 s to a new framing or location while the argument continues without a breath, captions that are a full
  phrase in a bold serif, one paper-cut-out news clipping as proof, a joke beat in the middle, and a plain brand card.
  Lesson: when the footage is strong, do less. Use `field` or `street` at `minimal`.
- **Five more Mamdani videos** (the 16:9 launch ad, the Hochul / Blakeman explainer, the night pied-a-terre
  announcement, the helmet skit, the desk message with Chinese subtitles). The technique they all share is the
  **punch-in jump cut**: one take is cut as if by three cameras, wide → close → medium, changing on each sentence and
  often on a clause, always centred on the face, with no transition at all. That is now `look.angles` (`buildSpec`
  `anglesFor`: a new framing at each line and at clause breaks at least 1.6 s apart; zooms 1.0 / 1.5 / 1.18 / 1.75 /
  1.08 / 1.4; drawn in `CardContent` as a scale about the face that never shows the picture's edge). On by default in
  `street`, `field` and `direct`. Other things in them, in order of value: a two-tone serif title (white line, yellow
  line) for the thesis ("The cost of living / is the real crisis."), policy lines as plain serif lower thirds, voters'
  words in small yellow captions, opponent clips full-screen with a source bug, press clippings as paper cut-outs,
  social comments stacked over the shot, and a brand or seal end card. The first three can be made today with `field`
  at `light` (serif headlines with the key words in the accent colour); the rest are in section 10.

## 4. Craft: hooks

The first 2 seconds decide whether the ad is watched. In this machine the hook is **a line they actually said**, chosen
and checked in `footage.js` (`asOpening`, `hookScore`, `shapeStory`):

- It plays from frame 0: voice, picture and the first headline word are all there on the first frame (the card is
  already on its way in; frame 0 is the cover image on TikTok and Reels, so it must never be an empty background).
- It stands alone: never a greeting or thank-you, never a line that leans on an earlier one ("it", "that", "they").
  A leading "And," / "But" / "So" is trimmed off.
- It names a stake, a contrast or a surprising claim ("Most people in Albany are politicians."), under ~5 s.
- Hook patterns that work for officials, all from their own words: **stake** ("They're trying to erase our history"),
  **contrast** ("not hatred, not discrimination"), **identity twist** ("I'm a public health scientist"), **number**
  ("$1,000 for every child"), **call-out** ("He called out Trump").
- The hook gets the biggest headline (`seg.hook`, +10%) and a soft impact sound.

**The outro hook** (the closing line, `role: 'rally'`, `outroScore`): short, complete, quotable, in "we" / "our", and
it lands the theme ("Our history will never be erased."). It is always last, its key word gets a punch-in, a riser
leads into the end card, the music comes up, and the line stays on the end card in quotes under the name
(`spec.end.line`). End card: portrait, the ask (Vote / Follow), name, office, site.

Story order: hook → who → proof → place → story → rally, 5-7 lines, ~26 s of talk (52 s for the long ad), one theme.
Each line should answer the one before it. The founders can pick 1 of 3 topics or write a brief (`prospect.story`).

## 5. Craft: cuts

- **Cut in the quiet, not on the transcript.** Transcript word times drift 0.1-0.5 s. `edit.snapLine` reads the voice
  band's loudness every 10 ms around each line and puts the in-point at the end of the quiet before the first word
  (40 ms of breath kept) and the out-point in the first real quiet after the last word (110 ms of natural decay kept;
  a stop consonant's 50-70 ms gap is not treated as the end). Never end mid-word.
- **Close long pauses** inside a line (over 0.55 s → 0.2 s). The join is a jump cut, so the picture is punched in 8% on
  alternate pieces (`card.jumps`), the way an editor hides it. Word times are remapped (`edit.mapper`).
- **Every line at one level** (speech RMS measured, static gain, light compression, +2.5 dB at 3 kHz). No per-line
  loudness normaliser: on 3-second lines it pumps.
- **B-roll and maps cut in between words** (`buildSpec` snaps cut-ins to word gaps), last 1.2-3 s, never on the hook,
  and the voice never stops.
- Whole sentences or whole clauses only (`clauseTrim`: starts and ends on a comma or sentence break, never on "and /
  but / that"). "Dr.", "Mr.", "U.S." do not end a sentence.
- Pace: a new picture, colour or graphic every 2-4 s. A talking head held longer than ~5 s needs a cut-in or a punch.

## 6. Craft: transitions and motion

Transitions (`look.transition`, drawn in `Background`, `TransitionFX`, `Card`):

| Name | What happens | Use |
|---|---|---|
| `wipe` | three diagonal colour bands sweep across (11 frames, ease-in-out); the card settles with a 3% punch | colour-block looks; a new topic |
| `cut` | nothing | calm looks; `field` |
| flash + punch | 5-frame white flash (50% → 0) and a 1.13 → 1.0 scale that settles with a critically damped spring | every cut in full-screen fast looks (`cutFlash`) |
| `zoom` | 1.12 → 1 punch on the incoming shot | energy without colour change |
| `slide` | the card springs in from the side | clean / explainer looks |
| `fade` | dip through the dark colour (9 frames) | cinematic, documentary |
| `mix` | cycles wipe / zoom / flash / slide / cut per line | street, poster, zine |

Motion rules (they are why it reads as designed, not templated):

- **Hold → travel → hold.** Things arrive fast, sit still while they are read, leave fast. Nothing drifts aimlessly.
- `spring()` and `interpolate()` only, driven by the frame number. No CSS transitions or animations (they do not render).
- Headline words enter at 120% and settle to 100% with a small overshoot as each is spoken; key words get their box.
- Fewer, bigger things. One headline, one footage, one caption line, at most one extra graphic at a time.
- No glows, no gradients on text, no drop shadows that are not solid. Flat colour, hard offset shadows.
- **Text never covers a face.** In full-screen vertical the shot is lifted so the face sits at ~40% of the height
  (`faceTarget`, from `edit.faceBox`); captions go under the chin, tags in the strip below them.
- 9:16 safe zones: keep text out of the top ~210 px and the bottom ~320 px.
- Text is always fitted by measuring it in the real font (`fitWords`); fonts load before the first frame (`useFonts`).

## 7. Craft: sound design

Everything is made in code (`sfx.js`), so nothing needs a licence:

| Sound | Where |
|---|---|
| soft impact | the opening frame; the end card landing |
| swipe (filtered-noise whoosh) | colour wipes and slides, starting 0.1 s before the cut; the map |
| thud (low sine drop) | a new line cutting in on flash / zoom / cut looks |
| pop | a tag or icon landing; the map pin |
| tick | boxed key words; a B-roll cut inside a line |
| riser | the last 0.6 s before the end card |
| shimmer | the name on the end card |

Rules: sounds are **felt, not noticed** (10-30% of full scale against the voice); never two inside 0.12 s (the bigger
one wins); nothing pops on the end card itself; `light` level keeps only cuts and the end; `minimal` graphics uses the
light sound plan. Music sits ~13 dB under the voice and ducks a further few dB on each word (sidechain), swells to the
front in 0.5 s when the voice ends, and fades over the last 1.1 s. The whole mix is mastered in two passes to
**-14 LUFS, -1.5 dBTP** (`edit.master`). Setting: `political.adSound` = full | light | off.

## 8. After every render: the check

`edit.qa` measures the finished file and saves it on `pkg.pro[kind].qa`: integrated loudness, true peak, black frames,
dead air before the end card, file length against the plan, and how many cut points landed in real quiet. The finished
view shows "Checked: -14.0 LUFS, clean cuts, no black frames" or the first problem in plain words.

## 9. How to test

```bash
npm install
```

```bash
npm run engine -- --data /tmp/eu-data --port 4599
```

- The login link with its token is printed in the log. Drive the web UI with Playwright (Chromium is pre-installed in
  cloud sessions at `/opt/pw-browsers/chromium`).
- The ad engine can be run without the app: set `EUCLIDEAN_DATA`, `paths.setRoot(dir)`, build `bites` with
  `footage.sentences` + `footage.pickStory`, then `adengine.make({ bites, footage: { clips, broll }, vertical, out,
  work, look: looks.preset('street', 'minimal'), ... })`. A 25 s ad takes about 60-90 s on 4 cores.
- **Look at the result.** Grab frames with FFmpeg at every section start, at frame 0 and on the end card, and read
  them. Listen to the levels with `ebur128`. A render that "succeeded" proves nothing about how it looks.
- Whisper, Hugging Face, yt-dlp downloads, the Census map service and live search are usually blocked in cloud
  sessions. Say plainly what could not be tested there; do not claim it.
- Do not run `npm run selftest` unless asked.

## 10. Good next steps (not built yet)

0. **More of the Mamdani kit**: voter testimonial lines (a second speaker's words in a different caption colour), an
   opponent clip with a network / source bug, stacked social comments, a two-line thesis title held in the centre
   with captions paused, and subtitles in another language (a translated caption track).
1. **Paper cut-out citations** (the news clipping in the `field` reference): a card kind that shows a source's name
   and one sentence from the research, only when the research has that exact sentence and link.
2. **On-screen text reading** (chyrons) at intake, for the title and district.
3. **Fact sheet per politician** that every graphic must reference, with a flag on anything unsourced.
4. **Text-over-face check** in `qa` (render stills, run the face detector, intersect with the text boxes).
5. **Sample videos** for the two new styles in `renderer/assets/looks/` (`pastel`, `field`); until then the style
   cards show a still drawn by the engine.
6. District shapes for more states' local offices (county and city council) in `adengine.mapFor`.
