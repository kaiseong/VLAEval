# VLAEval interface contract

## 0. Research Log
- Read frontend design architecture, layout mechanics, perfection, designpowers review, visual QA, and TypeScript guidance.
- Embedded shortlist: Linear (precise hierarchy), Sentry (dense metrics), Supabase (restrained accent). The packaged taste-skill and Linear files are unavailable; no brand-specific tokens are claimed.
- Spatial reference: [StyleGallery fixed-sidenav-shell](https://github.com/changeroa/StyleGallery/blob/main/patterns/viewport-shell/fixed-sidenav-shell.md). Stable navigation and a fluid content column; main owns desktop scrolling.
- Concept/image and real-product screen lanes are outside this independent source-only unit. The brief specifies a research instrument, not marketing artwork. Parent owns browser integration and visual QA; no competing server or added tooling.

## 1. Atmosphere & Identity
A Korean evaluation workbench: quiet neutral chrome, numbered preparation steps, readable numerical evidence, restrained teal actions. Its signature is a wide paired action trace above compact, explicitly scoped metric tables. No promotional content, invented results, uploads, training, configuration editing, or robot controls.

## 2. Color
| Token | Light | Dark | Purpose |
|---|---|---|---|
| canvas | #f5f7f8 | #101719 | Page |
| surface | #ffffff | #182124 | Panels |
| secondary | #edf1f2 | #202c30 | Rail, hover |
| ink | #17282d | #ecf2f3 | Main text |
| muted | #52666d | #a8bac0 | Secondary text |
| line | #ccd6d9 | #405258 | Dividers, fields |
| accent | #08796e | #50d5bd | Primary action, prediction |
| accent-ink | #ffffff | #102521 | Text on action |
| wash | #e0f1ec | #263d39 | Selected state |
| target | #94560f | #e6b66c | Dashed ground truth |
| danger | #ac303b | #ff9aa3 | Errors, cancellation |
| danger-wash | #fff0f1 | #3a2529 | Error background |

## 3. Typography
Local system sans stack with Korean fallbacks: system-ui, Apple SD Gothic Neo, Malgun Gothic, sans-serif. Paths/numbers use ui-monospace, SFMono-Regular, Consolas, monospace. Scale: caption/body 14px, mobile body 16px, section 18px, title 28px, metric 24px; line-height 1.55. Tabular numbers. No external font request. Korean prose uses keep-all; machine paths wrap anywhere.

## 4. Spacing & Layout
4px base; spaces 4, 8, 12, 16, 20, 24, 32px. No permanent sidebar: a compact wrapping `workspace-header` (brand, title, preparation/analysis nav, native run-history select, refresh, theme select) sits above one main region, and each child of main is capped at 1320px. On desktop the app shell is 100dvh and main owns vertical scrolling. Preparation uses two balanced columns, results span full width. At 1100px preparation stacks; at 760px the document owns scrolling. Episode list has a named bounded scroll region for potentially thousands of episodes; metric tables own horizontal scrolling only. Primary content never horizontally scrolls. Mobile safe-area insets are preserved.

## 5. Components
- **Section**: semantic section, numbered/title heading, description, body. Neutral 1px border, 8px radius, 24px desktop/16px mobile padding.
- **Field**: visible label, native input/select/textarea, help. 44px minimum control height. Default, focus-visible, disabled, and validation states; label wraps rather than truncates.
- **Button**: inline icon + text; primary, neutral, danger. Minimum 44px hit area; hover wash, active opacity, focus ring, disabled opacity, loading text. No decorative animation.
- **Notice**: labeled status/error and recovery guidance. Error role alert; loading role status; no blank catch. Extensive discovery warnings live in a collapsed disclosure with a named, bounded scroll region.
- **Episode row**: native checkbox, episode index, length, tasks. Full-row target; selected wash plus check. Select-all and clear are explicit.
- **Run history**: native `select` labeled 실행 기록 in the header; each option shows config, status and creation time. Choosing one opens analysis. Persisted backend jobs only; loading, error and empty states are text.
- **Metric**: text label, numerical value, scope; unavailable values use an em dash, never zero.
- **Trace chart**: responsive SVG with measured width; prediction solid teal, GT dashed amber, labeled axes/ticks. Two modes. Compact overview panels use a 160-unit viewBox whose width is the measured full panel width, so the time axis gets the whole horizontal allocation. They share one grid legend and keep the caption visually hidden. Rendered height follows selector precedence: above 1100px, `workspace.css` sets the SVG to 160px with `zoom: 3/5` (about 96px physical) and enlarges tick text by 5/3 so ticks read about 14px; from 761 to 1100px, `overview.css` sets 128px with 1.25x caption text; at 760px and below it sets 160px with 14px text. When a compact panel measures under 240px wide, TracePlot stacks the time ticks and adds 64 units, and its inline height (224 units) overrides the stylesheet height. Detail and future-chunk charts use a 340-unit viewBox with their own legend and visible point inspection. Overview and detail plot the complete scored first-step series; future-chunk plots instead show one retained chunk over `(origin + horizon) / FPS`. Accessible title/description, individual point inspection, CSV equivalent.
- **Metric table**: native table with caption and scoped headers; chunk metrics explicitly labeled. Bounded horizontal scroll, keyboard reachable.

## 6. Motion & Interaction
No looping or ornamental motion. Native controls respond immediately. Async actions disable their own submit control and show textual progress. Reduced-motion preference requires no alternate behavior because this unit has no animation. Active jobs lock all request-editing controls; history, chart selection, exports, theme, and cancellation remain usable. Host/repo/dataset changes invalidate dependent selections and abort stale requests. Episode reads are explicit, use the selected repo's Python environment, and include host/repo/dataset; typing a path does not launch SSH requests.

## 7. Depth & Surface
Borders and tonal layering; no shadows, gradients or glass. Radius 4px badges, 8px panels and controls. Selected state uses a wash, not an accent border. Only focus-visible gets a 2px accent outline.

## 8. Accessibility Constraints & Accepted Debt
Target WCAG 2.2 AA: visible labels, keyboard reachability, 44px actions, color-independent trace styles/status text, system/light/dark modes, polite progress, error alerts, path wrapping, honest empty states. Persona: researcher with pre-provisioned RTX6000 artifacts, keyboard user selecting many episodes, mobile user checking a saved run.

| Item | Location | Owner / Exit |
|---|---|---|
| Post-redesign real 3-frame inference and final integrated verification not yet receipted | Live evaluation, whole app | Final verification wave. The offline SDK geometry gate is already confirmed (task 22, landed 4bf2fb05): installed rby1-sdk 0.10.0, all four offered A/M v1.1/v1.2 geometries, 376 absolute-pose comparisons, worst 9.376900992053149e-10 m and 1.485247943310658e-9 rad, deliberate joint/arm/tool corruptions fail. It proves URDF chain math only, not robot calibration or closed-loop performance. |
| React performance tooling and browser audits not installed or run | Tooling | Parent may add optional dev tools; this unit cannot edit package/tooling |

## 9. Result Workspace
Top-level `WorkspaceNav` switches between preparation (평가 준비) and analysis (결과 분석); a saved run opens analysis. The result toolbar holds the run summary, the episode select and the two native exports. Below it sit the coverage line, five run scores and five view tabs: Overview, Detail, Future chunks, Metrics, Optional FK. Tabs are native buttons with `aria-pressed` and a check glyph, so selection is not color-only.

- **Grid**: Overview uses `repeat(4, minmax(0, 1fr))` with an 8px gap. RBY1 16D fits right arm in columns 1-2 and left arm in 3-4 (J0/J1, J2/J3, J4/J5, J6/gripper) at 1440x1000 without page scroll. Unrecognized channel names fall back to generic panels in action order. At 760px and below the grid is two columns and the document scrolls.
- **Panels**: one legend for the grid; each compact header shows first-step MAE/RMSE over the complete scored first-step trace of the selected episode, never run-level chunk perDimension. That equals the full original episode only when every frame was scored; on legacy or quick-subset runs it covers the scored frames only. Axis unit reads `native / unknown`. Prediction solid accent, ground truth dashed target.
- **Cursor and window**: one controlled `(jobId, episode, sourceFrame)` cursor and inclusive `[startFrame, endFrame]` window owned by `ResultWorkspace`; no global store. Overview and FK share them through the Source frame / Window start / Window end fields and chart clicks. Values snap to an existing source frame; time is `frame / FPS`. Episode or run change remounts the workspace and resets once.
- **Chunks**: separate episode/origin/horizon identity; x axis is `(origin + horizon) / FPS`. An origin missing from the retained examples renders unavailable, never a substitute sample.
- **Coverage line**: first-step scope (scored anchors / original frames, last frame, warm-up excluded) and future-chunk scope (H, geometric full/tail, fully valid chunks, valid rows) are separate spans. Legacy runs print `unknown` for every unrecorded field. A `Quick subset` tag appears when stride is not 1 or maxSamples is not 0.
- **FK**: settings form with profile, unit, representation and a sign/zero confirmation checkbox, then provenance `dl`. Six panels per arm (x/y/z mm, roll/pitch/yaw deg); Euler singularity shows a status note and gaps. Derived FK export buttons stay disabled until a matching completed derivation exists.
- **Focus**: opening Detail moves focus to `Close detail`; Escape or the Overview tab closes it and returns focus to the panel that opened it. Focus-visible keeps the 2px accent outline.
- **Modes**: light, dark and system share the token table above; the workspace adds no colors of its own.

Parent QA must also cover refresh/resume of active jobs, disconnect/reconnect snapshot, terminal stream closure, failed/cancelled jobs, history selection while another job runs, stale discovery responses, explicit episode validation, full trace/export correctness, and chunk sample horizon validity.
