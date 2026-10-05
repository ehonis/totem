# TypeScript + Tailwind migration

The dashboard was migrated from JSX/plain-CSS to **TypeScript** and **Tailwind CSS v4**.
TypeScript is fully converted; Tailwind is wired up and being adopted **incrementally**,
component by component, while the original `src/styles.css` keeps everything that hasn't
been ported yet visually intact.

## TypeScript

- Every `src/**/*.jsx` → `.tsx` and `src/**/*.js` → `.ts`. No `.jsx`/`.js` left in `src`.
- Config: `tsconfig.json` (app, `noEmit` — Vite/esbuild does the transpile) and
  `tsconfig.node.json` (for `vite.config.ts`).
- Strictness is intentionally pragmatic to start: `strict: false`, `noImplicitAny: false`.
  Loosely-shaped bridge JSON payloads are typed `any`; props, refs, and obvious params are
  typed. Tighten `strict` once interfaces cover the `/api` responses.
- Relative imports are **extensionless** (`./api`, `../icons`) so Vite/TS resolve `.ts`/`.tsx`.
- `npm run typecheck` runs `tsc --noEmit`. `npm run build` runs `tsc --noEmit && vite build`.

## Tailwind CSS v4

- Plugin: `@tailwindcss/vite` in `vite.config.ts`. Entry: `src/tailwind.css`, imported from
  `src/main.tsx` **before** `src/styles.css`.
- **Preflight is intentionally disabled** (we import `tailwindcss/theme.css` + `tailwindcss/utilities.css`
  explicitly instead of `@import "tailwindcss"`). This is what keeps the hand-written
  `styles.css` fully intact during the transition.
- Design tokens from `styles.css :root` are mirrored into `@theme` in `tailwind.css`, so
  utilities resolve against them: `bg-bg-2`, `text-muted`, `border-line`, `text-accent`,
  `text-red/green/amber`, `rounded` (12px), `font-sans`, `animate-toast-in`.

### Gotcha: borders need `border-solid`

Because Preflight is off, Tailwind's `border` utilities set width/color but **not**
`border-style`, and the browser default is `none`. Always pair border widths with
`border-solid`, e.g. `border border-solid border-line`. (This is removed once Preflight
is re-enabled — see below.)

### Migrating a component

1. Replace `className` values with Tailwind utilities (use the `@theme` token names).
2. Match exact pixel values with arbitrary values when needed: `px-3.5`, `rounded-[10px]`,
   `gap-2.5`, `shadow-[0_8px_28px_rgba(0,0,0,0.45)]`.
3. Remove the now-dead rules from `styles.css` — **but only rules used by that component
   alone**. Confirm with a grep before deleting. Leave shared atoms in place.
4. `npm run build` and eyeball the view.

### Shared atoms (not yet migrated)

`.btn` / `.btn.primary`, `.view`, `.view-head`, `.muted`, `.empty`, `.spinner`, `.error`,
`.ico` are used across ~10–14 files. Migrate these last (or convert them to a Tailwind
`@layer components` block with `@apply`) so individual component migrations don't have to
touch every file at once.

### Migrated so far

- `components/SecretGate.tsx`
- `components/ToastHost.tsx` (+ `toast-in` keyframes moved to `tailwind.css`)

### Remaining (still on `styles.css`)

App shell (`App.tsx`, incl. the responsive sidebar — note the CSS is desktop-first
`@media (max-width: 720px)`; in Tailwind use `max-[720px]:` variants), `OverviewView`,
`InboxView`, `ProductivityView`, `BrainView`/`BrainMiniMap`, `ChatView`, `CalendarView`,
`TodosView`, `ProvidersView`, `McpSettingsView`/`DataConnectionsPanel`, `UsageView`,
`SettingsView`, `StudioView`, `SkillsView`, `WorkflowsView`, `Markdown`.

### Finishing the migration

Once every component is on utilities and `styles.css` is empty, switch `tailwind.css` to a
single `@import "tailwindcss";` to re-enable Preflight, drop the per-element `border-solid`
classes, and delete `styles.css`.
