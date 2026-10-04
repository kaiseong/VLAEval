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
4px base; spaces 4, 8, 12, 16, 20, 24, 32px. Desktop rail 248px, content maximum 1320px. Preparation uses two balanced columns, results span full width. At 1100px preparation stacks; at 760px rail becomes a document-flow header and the document owns scrolling. Desktop main and sidebar are independent bounded shell regions. Episode list has a named bounded scroll region for potentially thousands of episodes; metric tables own horizontal scrolling only. Primary content never horizontally scrolls. Mobile safe-area insets are preserved.

## 5. Components
- **Section**: semantic section, numbered/title heading, description, body. Neutral 1px border, 8px radius, 24px desktop/16px mobile padding.
- **Field**: visible label, native input/select/textarea, help. 44px minimum control height. Default, focus-visible, disabled, and validation states; label wraps rather than truncates.
- **Button**: inline icon + text; primary, neutral, danger. Minimum 44px hit area; hover wash, active opacity, focus ring, disabled opacity, loading text. No decorative animation.
- **Notice**: labeled status/error and recovery guidance. Error role alert; loading role status; no blank catch. Extensive discovery warnings live in a collapsed disclosure with a named, bounded scroll region.
- **Episode row**: native checkbox, episode index, length, tasks. Full-row target; selected wash plus check. Select-all and clear are explicit.
- **History row**: native button with date, config, episodes and status. Selected wash; persisted backend jobs only.
- **Metric**: text label, numerical value, scope; unavailable values use an em dash, never zero.
- **Trace chart**: responsive SVG, measured width and 340px height so axis labels remain 14px even on mobile; prediction solid teal, GT dashed amber, labeled axes/ticks and legend. Full sampled-frame first-step trace. Accessible title/description, individual point inspection, CSV equivalent.
- **Metric table**: native table with caption and scoped headers; chunk metrics explicitly labeled. Bounded horizontal scroll, keyboard reachable.

## 6. Motion & Interaction
No looping or ornamental motion. Native controls respond immediately. Async actions disable their own submit control and show textual progress. Reduced-motion preference requires no alternate behavior because this unit has no animation. Active jobs lock all request-editing controls; history, chart selection, exports, theme, and cancellation remain usable. Host/repo/dataset changes invalidate dependent selections and abort stale requests. Episode reads are explicit, use the selected repo's Python environment, and include host/repo/dataset; typing a path does not launch SSH requests.

## 7. Depth & Surface
Borders and tonal layering; no shadows, gradients or glass. Radius 4px badges, 8px panels and controls. Selected state uses a wash, not an accent border. Only focus-visible gets a 2px accent outline.

## 8. Accessibility Constraints & Accepted Debt
Target WCAG 2.2 AA: visible labels, keyboard reachability, 44px actions, color-independent trace styles/status text, system/light/dark modes, polite progress, error alerts, path wrapping, honest empty states. Persona: researcher with pre-provisioned RTX6000 artifacts, keyboard user selecting many episodes, mobile user checking a saved run.

| Item | Location | Owner / Exit |
|---|---|---|
| Rendered visual, contrast, keyboard, and mobile verification not performed in this unit | All client surfaces | Parent integration QA: 390/1440 light+dark, long paths, empty/error/loading/active/terminal states |
| React performance tooling and browser audits not installed or run | Tooling | Parent may add optional dev tools; this unit cannot edit package/tooling |

Parent QA must also cover refresh/resume of active jobs, disconnect/reconnect snapshot, terminal stream closure, failed/cancelled jobs, history selection while another job runs, stale discovery responses, explicit episode validation, full trace/export correctness, and chunk sample horizon validity.
