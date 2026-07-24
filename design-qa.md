# SendToFigma Design QA

## Evidence

- Source visual truth:
  - `assets/send-to-figma-ui/receive-reference-idle.png`
  - `assets/send-to-figma-ui/receive-reference-lab.png`
  - ReceiveFromMasterGo UI source in `ReceiveFromMasterGo/ui-src/`
- Implementation screenshots:
  - `assets/send-to-figma-ui/ready.png`
  - `assets/send-to-figma-ui/settings.png`
  - `assets/send-to-figma-ui/exporting.png`
  - `assets/send-to-figma-ui/success.png`
  - `assets/send-to-figma-ui/error.png`
- Full-view comparison: `assets/send-to-figma-ui/qa-comparison.png`
- Viewport: 400 × 620 CSS px
- Source and implementation pixels: 400 × 620 PNG at device scale factor 1; no density normalization required
- States: ready/page selection, settings, exporting, success, and error
- Primary interactions tested: page selection count, opening and leaving settings, starting export, retrying after failure, and continuing after success
- Browser console: no errors or warnings across the five implementation states

## Findings

No actionable P0, P1, or P2 differences remain.

- Fonts and typography: both plugins use the same system sans-serif stack, 14 px primary UI text, 12 px supporting text, matching weights, line heights, truncation, and hierarchy.
- Spacing and layout rhythm: both use a 400 × 620 frame, 16 px page padding, 8 px panel radii, 12 px vertical rhythm, 40 px footer, and matching card borders.
- Colors and visual tokens: neutral white, zinc foreground, muted gray surfaces, black primary actions, green success, and red error states match the ReceiveFromMasterGo token language.
- Image and icon fidelity: interface icons use Lucide paths, matching the ReceiveFromMasterGo icon family. No raster placeholders or improvised glyphs are present.
- Copy and content: SendToFigma uses export-specific copy while preserving the receiving plugin's concise status and action patterns.
- Interaction states: disabled, selected, indeterminate, progress, success, error, retry, and settings states are visually distinct and functional.

## Focused Comparison

The experiments/settings screens were compared directly because they share the same information architecture. Header placement, intro copy, bordered setting cards, switch control, helper text, input/button sizing, and empty-space rhythm align. The ready screen was compared to the ReceiveFromMasterGo idle shell for shared frame, footer, border, type, and control treatment; its denser page-selection content is intentional workflow-specific content.

## Comparison History

1. Initial capture showed the ready-state primary button during its 150 ms disabled-to-enabled opacity transition.
2. The implementation state was confirmed as enabled with the correct primary token. Screenshots were recaptured after the transition completed.
3. The revised full-view comparison shows the correct black primary action and no remaining P0/P1/P2 findings.

## Follow-up Polish

- P3: If the receiving plugin later adds a document identity row, the sender and receiver can share that component rather than only sharing its visual tokens.

final result: passed
