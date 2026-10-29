# pick-ui-library reference — Emil Kowalski skills

> Adapted from `emilkowalski/skills` at `a81dbca07f2217b7103e510c0f13f8d5b017afc9`. Informational reference only: the package SKILL.md mode rules and frozen frontend spec control actions. Do not fetch or install dependencies from this reference.

# Picking The Right Library

A lookup skill. When invoked with a task ("I need toasts", "what should I use for drag and drop?"), match the task to the curated list below and recommend the library. These are deliberate, taste-driven picks — don't substitute alternatives outside this list unless the user asks for one or the task genuinely isn't covered.

## How to use this

1. **Identify the task**, not the library the user named. "I need to show a dropdown" is a UI-primitives task (base-ui), even if they asked about something else.
2. **Check what's already installed.** Look at `package.json` first. If the project already uses a listed library, use it. If it uses a competitor (e.g. react-window instead of Virtuoso), flag the recommendation but don't churn the dependency without being asked.
3. **Recommend one library**, state what it's for in one sentence, and wire it up only when it is already available or explicitly approved by the frozen plan. Don't present a menu of options when the list has a clear answer.
4. If the task isn't covered by the list, say so explicitly and recommend from your own knowledge — but be clear you've left the curated list.

## The list

### UI components & primitives

| Task | Library |
| --- | --- |
| Unstyled, accessible UI components (dialogs, popovers, menus, selects…) | base-ui |
| Command menus (⌘K palettes) | cmdk |
| Toasts / notifications | Sonner |
| One-time password / verification code inputs | input-otp |
| Customizable GUIs / control panels | Leva — dialkit is an alternative |

### Motion & visuals

| Task | Library |
| --- | --- |
| General-purpose animation (springs, layout animations, enter/exit) | motion (Framer Motion) |
| Animating numbers (counters, prices, stats) | NumberFlow |
| Animated text components | torph |
| 3D globes | Cobe |
| Dynamic OG images (HTML/CSS → SVG/PNG) | Satori |
| Syntax highlighting | shiki |

Reach for motion when you need springs, layout animations, exit animations, or gesture-driven values. A simple hover or fade doesn't need it — plain CSS transitions are the right tool there.

### Charts

| Task | Library |
| --- | --- |
| Real-time / streaming charts | Liveline |
| General charts (static or interactive dashboards) | recharts |

The split: if data points arrive live and the chart scrolls with time, use Liveline. Everything else is recharts.

### Interaction & performance

| Task | Library |
| --- | --- |
| Drag and drop | dnd kit |
| Virtualization (long lists, large tables) | Virtuoso |

### State & styling

| Task | Library |
| --- | --- |
| State management | zustand |
| Constructing `className` strings conditionally | clsx |
| Type-safe, variant-driven styling for Tailwind | cva |
| Theme switching / dark mode (no flash on load) | next-themes |

The styling split: clsx for ad-hoc conditional classes; cva when a component has real variants (size, intent, state) that deserve a typed API. They compose — cva uses clsx-style inputs internally.

## Common mismatches to catch

- **Toasts built by hand or with a modal library** → Sonner exists for exactly this.
- **A `<div>`-based dropdown/dialog with manual focus handling** → base-ui, which handles accessibility, focus trapping, and dismissal.
- **Animating a number by re-rendering text** → NumberFlow handles digit transitions properly.
- **Rendering a 1,000+ row list directly** → Virtuoso before reaching for pagination hacks.
- **A `useState`-per-component web of props for shared state** → zustand.
- **Template-literal className ternaries three conditions deep** → clsx (or cva if it's variant-shaped).
