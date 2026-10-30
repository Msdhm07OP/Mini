# EventSync frontend polish — 3.1

## Direction

The frontend update takes selective inspiration from the public SeatSync frontend's design tokens and interaction conventions: a deep, violet-tinted dark surface; spotlight-violet as the main accent; magenta and amber for high-contrast emphasis; green for positive states; shared easing/duration values; and explicit reduced-motion support. SeatSync's ticket-specific layout was not copied because EventSync is an operations dashboard with dense workflows and tables.

Reference inspected: `https://github.com/mananmishra-git-99/seatsync-frontend`, especially `src/index.css` and `src/App.tsx`.

## What changed

- Replaced the horizontal tab strip with a responsive, grouped left navigation: Workspace, Operations, and Intelligence.
- Added a contextual top bar, quick-create action, operating-hours chip, and a destination command palette.
- Added keyboard navigation via `Ctrl+K` / `Cmd+K`; `Escape` closes the command palette or mobile drawer.
- Added a mobile drawer and backdrop instead of letting navigation overflow horizontally.
- Added a dashboard hero area with functional shortcuts to create a booking and view bookings.
- Redesigned dashboard metrics with semantic color tokens, compact icon tiles, soft elevation, and entrance motion.
- Replaced plain dashboard loading text with shimmer skeletons and added a retry state when statistics cannot be loaded.
- Animated utilization bars, page changes, icon tiles, navigation highlights, and button press/hover states.
- Added a polished auth-card entrance and low-contrast background geometry.
- Improved keyboard focus appearance and globally respects `prefers-reduced-motion`.
- Kept the existing page components and API services, including booking and resource allocation behavior, in place.

## Motion principles

- Small hover lifts (about 1–3 px), fast press feedback, and restrained shared easing.
- Page changes use a short fade + vertical settle, not large spatial transitions.
- Loading shimmer is only used while waiting for existing API data; it does not fabricate data.
- Utilization bars use the actual values already returned by the API and clamp rendered fill to 0–100%. Values over 100% remain visible as text and receive a warning color.
- The reduced-motion media query disables long/infinite animation and compresses transitions for users who request reduced motion.
- No animation library or new runtime dependency was added; CSS handles the lightweight micro-interactions to keep the React app lean.

## Validation notes

- The updated JS/JSX source was parsed using the installed TypeScript transpiler: no syntax errors were reported across the 14 frontend source files.
- `src/index.css` was parsed using PostCSS: no CSS syntax errors were reported.
- A fresh Vite production build could not be run in this environment because the frontend dependencies are not installed and the npm offline cache is missing at least one package (`yallist`). Install dependencies in a connected development environment and run `npm run build` before deployment.
