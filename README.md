# Plexii

Task-scoped digital work environment for people with ADHD and high distractibility.

The core mechanic: create a task, attach the exact tools and sites you need, and that becomes a locked focus workspace. No tab drift, no context loss.

## Stack

- **Electron 33** desktop app (Mac + Windows)
- **React 18** + TypeScript renderer
- **electron-vite** dev tooling
- **better-sqlite3** local-first persistence
- **Tailwind CSS** with custom desk + sticky-note palette
- **Zustand** state

## Phase status

- [x] Phase 1 — Foundation: scaffold + task CRUD + three-axis tag capture
- [ ] Phase 2 — Focus Workspace: multi-webview, sticky notes overlay
- [ ] Phase 3 — Templates
- [ ] Phase 4 — Calendar + scheduling + three-axis sort
- [ ] Phase 5 — Gamification (dopamine slots, special-interest research)
- [ ] Phase 6 — Haptics

## Scripts

```bash
npm install        # install + rebuild native modules for Electron
npm run dev        # start with HMR
npm run build      # production build
npm run typecheck  # main + web type checks
```

## Structure

```
src/
  shared/     # types shared between main and renderer
  main/       # Electron main process (DB, IPC)
    db/
    ipc/
  preload/    # contextBridge to expose api to renderer
  renderer/   # React app
    src/
      components/
      stores/
      styles/
```

Database lives at the OS userData dir as `focusbuddy.db`.
