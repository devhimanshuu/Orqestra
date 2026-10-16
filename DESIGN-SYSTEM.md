# Orqestra Design System

The landing page is the source of truth for Orqestra's visual identity. The
authenticated application translates that identity into a focused, efficient
engineering workspace.

---

## 1. Brand & Visual Principles

- **Dark-first.** The landing page's black canvas sets the brand. The app
  defaults to dark; a light theme is available via toggle.
- **Violet primary.** `oklch(0.62 0.19 289)` in dark, `oklch(0.55 0.21 289)`
  in light. Supporting accents: magenta, cyan, amber, green.
- **Restrained color.** Semantic status colors only. No arbitrary gradients
  outside the landing page.
- **Clarity over decoration.** Dense data pages use small type, tight spacing,
  and minimal chrome.
- **One product, one system.** Every screen uses the same tokens, components,
  and layout patterns.

## 2. Design Tokens

All tokens are CSS custom properties in `src/app/globals.css`, consumed via
Tailwind's `@theme inline` block.

| Token | Dark | Light |
|---|---|---|
| `--background` | `oklch(0.145 0.008 289)` | `oklch(0.984 0.002 289)` |
| `--foreground` | `oklch(0.985 0 0)` | `oklch(0.18 0.02 289)` |
| `--card` | `oklch(0.185 0.011 289)` | `oklch(1 0 0)` |
| `--primary` | `oklch(0.62 0.19 289)` | `oklch(0.55 0.21 289)` |
| `--muted` | `oklch(0.235 0.015 289)` | `oklch(0.965 0.006 289)` |
| `--muted-foreground` | `oklch(0.71 0.016 289)` | `oklch(0.52 0.02 289)` |
| `--border` | `oklch(1 0 0 / 9%)` | `oklch(0.915 0.006 289)` |
| `--destructive` | `oklch(0.704 0.191 22.216)` | `oklch(0.577 0.245 27.325)` |
| `--ring` | `oklch(0.62 0.19 289)` | `oklch(0.6 0.17 289)` |

Sidebar tokens (`--sidebar`, `--sidebar-accent`, etc.) follow the same pattern
with a slightly darker background.

## 3. Typography

- **Sans:** Geist (`--font-geist-sans`)
- **Mono:** Geist Mono (`--font-geist-mono`)
- **Display (landing only):** Space Grotesk (`--font-display`)

Dashboard pages use Geist exclusively. Landing page uses Space Grotesk for
headings and Geist Mono for code/labels.

## 4. Shared Components

All shared primitives live in `src/components/ui/`. Feature-specific components
live in their module directory (`src/components/evaluation/`, etc.).

| Component | File | Purpose |
|---|---|---|
| Button | `ui/button.tsx` | Primary, outline, secondary, ghost, destructive, link |
| Badge | `ui/badge.tsx` | Status indicators |
| Card | `ui/card.tsx` | Content containers |
| Dialog | `ui/dialog.tsx` | Modals and confirmations |
| Input | `ui/input.tsx` | Text fields |
| Label | `ui/label.tsx` | Form labels |
| Select | `ui/select.tsx` | Dropdowns |
| Tabs | `ui/tabs.tsx` | Tabbed content |
| Textarea | `ui/textarea.tsx` | Multi-line text |
| Tooltip | `ui/tooltip.tsx` | Contextual hints |
| Skeleton | `ui/skeleton.tsx` | Loading placeholders |
| PageHeader | `ui/page-header.tsx` | Page title + description + actions |
| EmptyState | `ui/empty-state.tsx` | Empty list placeholder |
| ThemeToggle | `theme-toggle.tsx` | Dark/light switch |

## 5. Application Shell

`src/components/app-shell.tsx` provides:

- **Grouped sidebar** with Workspace / Observability / Experimentation sections.
- **Collapsible** via a toggle button; state is per-session (not persisted).
- **Mobile drawer** with hamburger toggle.
- **Command palette** (⌘K / Ctrl+K) for quick navigation.
- **Top bar** with search trigger, theme toggle, and user menu.
- **Builder opt-out:** routes containing `/builder` render without shell chrome.

The shell is applied via `src/app/dashboard/layout.tsx`, which resolves user
and workspace data server-side.

## 6. Page Layout Patterns

- **List pages:** `max-w-6xl` or `max-w-7xl`, `px-6 py-10`, PageHeader at top.
- **Detail pages:** Same container, breadcrumb nav, then content sections.
- **Builder:** Full-screen (`h-dvh`), no shell chrome.
- **Landing:** Full-width, scoped under `.landing` class.

## 7. Loading, Empty, and Error States

- **Loading:** `loading.tsx` files with Skeleton components at each route level.
- **Empty:** `EmptyState` component with icon, title, description, action.
- **Error:** `error.tsx` with error digest, retry button, and dashboard link.
- **Not found:** `not-found.tsx` with icon, message, and back link.

## 8. Responsive Behavior

- Sidebar collapses to icon-only at `md` breakpoint.
- Mobile gets a hamburger-triggered drawer.
- Builder shows an honest message on small screens instead of a broken canvas.
- Tables and data grids use `overflow-x-auto` for horizontal scroll.

## 9. Accessibility

- Semantic HTML throughout.
- `aria-label` on icon-only buttons.
- Visible focus rings via `--ring` token.
- Status communicated with text + color, never color alone.
- `prefers-reduced-motion` respected on landing page animations.
- Keyboard navigation for sidebar, command palette, and dialogs.

## 10. Adding New Screens

1. Create the page under `src/app/dashboard/...`.
2. Use `PageHeader` for the title.
3. Use shared `ui/` components for all primitives.
4. Add a `loading.tsx` skeleton.
5. Use `EmptyState` for empty lists.
6. Do not add new color tokens — use existing semantic tokens.
7. Do not create new navigation items without a working route.

</content>