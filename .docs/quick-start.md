# Quick start

```bash
# Development (with hot reload)
bun run dev

# Desktop development (works on Windows too)
bun run dev:desktop

# Desktop development on an isolated port set
T3CODE_DEV_INSTANCE=feature-xyz bun run dev:desktop

# Production
bun run build
bun run start

# Build a shareable macOS .dmg (arm64 by default)
bun run dist:desktop:dmg

# Build a shareable Windows installer (.exe via NSIS)
bun run dist:desktop:win

# Or from any project directory after publishing:
npx t3
```
