# Design Guide — Universal Craft Rules

Actionable design rules for coding agents building UI. Read this when implementing frontend changes. These rules apply to ANY project regardless of brand or theme.

> Adapted from Open Design craft modules (typography, color, animation-discipline, anti-ai-slop, state-coverage, accessibility-baseline).

---

## Spacing

Use a 4px base grid. All spacing values should be multiples of 4.

| Use | Size |
|-----|------|
| Tight inline gap | 4px |
| Icon-to-label gap | 8px |
| Inside buttons/chips | 8px vertical, 12–16px horizontal |
| Inside cards/panels | 16px |
| Between cards/sections | 12–16px |
| Section vertical padding | 24–48px |

Never mix arbitrary values. If the existing codebase uses Tailwind, stick to its spacing scale: `1`=4px, `2`=8px, `3`=12px, `4`=16px, `6`=24px, `8`=32px, `12`=48px.

---

## Typography

### Scale (cap at 6–8 sizes per project)

| Role | Size | Line height | Letter-spacing |
|------|------|-------------|----------------|
| Display/Title | 24–48px | 1.0–1.2 | -0.02em |
| H1/H2 | 18–24px | 1.2–1.3 | -0.01em |
| Body | 14–16px | 1.5–1.6 | 0 (default) |
| Small/Caption | 11–13px | 1.4–1.5 | +0.01em |
| UI labels | 10–12px | 1.3 | +0.02em |
| ALL CAPS | any | — | +0.06em to +0.1em (required) |

**Critical:** ALL CAPS without positive letter-spacing looks cramped and amateur — the most reliable AI-slop tell. Always add `tracking-wider` or equivalent.

### Font discipline
- Maximum 2 typefaces (display + body, or one variable-weight face)
- Use exactly 3 weights: regular (400), medium (500), semibold (600). Weight 700+ is rarely needed.
- Body line length: 50–75 characters. Use `max-w-prose` or `max-w-[65ch]`.

---

## Color

### Palette structure

| Layer | Share of screen | Purpose |
|-------|----------------|---------|
| Neutrals | 70–90% | Background, surfaces, text, borders |
| Accent | 5–10% | Primary actions, active states — ONE accent color |
| Semantic | 0–5% | Success (green), warning (yellow), error (red) |

### Rules
- **Max 2 visible accent uses per screen.** Typical: one CTA button + one active tab/indicator.
- Name tokens by purpose, not hue: `--accent` not `--blue-500`.
- **Dark themes:** avoid pure `#000` and `#fff`. Use `#0a0a0a`/`#0f0f0f` for background, `#e0e0e0`/`#f0f0f0` for text.
- Prefer semi-transparent white borders on dark surfaces: `border-white/10` reads as structure without noise.

### Contrast minimums
| Pair | Minimum ratio |
|------|--------------|
| Body text on background | 4.5:1 |
| Large text (18px+ or 14px bold) | 3:1 |
| UI components against surfaces | 3:1 |

---

## Components

### Buttons
- **Primary:** filled with accent color, white/dark text. ONE per screen section.
- **Secondary:** border-only, muted text, accent on hover.
- **States:** default → hover (border/bg shift) → active (slight press) → disabled (50% opacity). All four required.
- Padding: 8px vertical, 16px horizontal minimum. Text 12–14px.

### Inputs
- Clear border in default state. Accent border on focus.
- Error state: red border + error message below (not just red border).
- Placeholder text in muted color, not the same as input text.

### Cards
- Consistent border treatment within a section (all bordered OR all borderless, never mixed).
- Don't combine rounded corners with a colored left-border accent — that's the canonical "AI dashboard tile."

---

## Layout

- Align everything to a grid. If left edges don't align, it looks broken.
- Create visual hierarchy with size and weight, not just color.
- Alternate density: one tight section, one breathing section — reads as intentional.
- Don't center-align text blocks longer than 2 lines. Left-align body copy.

---

## Animation

### When to animate
Animate for spatial/state transitions ONLY: navigation, modals opening, toggles, progress. Don't animate to decorate, signal "premium," or fill silence.

### Duration
| Use | Duration |
|-----|----------|
| Hover, toggle, button press | 50–150ms |
| State confirmation | 150ms |
| Modals, dropdowns entering | 200–300ms |
| Page transitions | 300–500ms |

### Rules
- Only animate `color`, `opacity`, `transform`, `box-shadow`. Never animate `width`, `height`, `margin`, `padding` (causes layout reflow).
- Use `ease-out` for entering, `ease-in` for exiting.
- Respect `prefers-reduced-motion`: wrap animations in `@media (prefers-reduced-motion: no-preference)`.

---

## State Coverage

Every surface that fetches or displays data must handle ALL FIVE states:

| State | What to show |
|-------|-------------|
| **Loading** | Skeleton or spinner. Add "taking longer than expected" after 15s. |
| **Empty** | Headline + explanation + primary CTA. Empty is an onboarding moment, not a blank page. |
| **Error** | Plain-language cause + recovery action + preserve user input. |
| **Populated** | The primary design (what you probably designed first). |
| **Edge** | Long strings, missing fields, 1000+ items, RTL — layout must not break. |

Missing states are the most common silent failure of AI-generated UI. If you only built the populated state, the work is not done.

---

## Anti-AI-Slop Patterns (what NOT to do)

1. **Default indigo as accent** (#6366f1, #4f46e5) — use the project's actual accent color.
2. **Two-stop hero gradient** (purple→blue, indigo→pink) — a flat surface + good typography beats this.
3. **Emoji as feature icons** (✨🚀🎯⚡) — use SVG icons with `currentColor`.
4. **Generic metrics** ("10× faster", "99.9% uptime") — use real data or labeled placeholders.
5. **Filler copy** ("Lorem ipsum", "Feature One") — empty is better than fake content.
6. **Rounded card with colored left-border** — the "AI dashboard tile." Drop the radius or the border.
7. **`font-family: system-ui` alone on headings** — always specify an intentional first-choice font.

---

## Existing Patterns First

Before writing new styles, **read the existing components in the project**. Match what's already there:
- Check existing color tokens, spacing, and typography — don't introduce new values
- If the project uses `text-[11px]` for labels, use that — don't invent `text-[10px]`
- If the project has a card component pattern, reuse it — don't create a new card style
- When in doubt, grep the codebase for similar UI to what you're building

---

## Responsive Design

- Design mobile-first or at minimum handle narrow screens
- Use framework breakpoints (Tailwind: `sm:640px`, `md:768px`, `lg:1024px`)
- Stack vertically on mobile, side-by-side on desktop: `flex-col lg:flex-row`
- Hide non-essential content on mobile: `hidden lg:block`
- Touch targets: minimum 44×44px on mobile
- Test at 375px width (iPhone SE) as the minimum

---

## Accessibility Baseline

- All interactive elements must be keyboard-reachable (Tab/Enter/Escape).
- Focus indicators: visible, 3:1 contrast against adjacent colors.
- Images: meaningful `alt` text or `aria-hidden` for decorative.
- Form errors: associate error text with the field via `aria-describedby`.
- Don't rely on color alone to convey meaning (add text labels or icons).
