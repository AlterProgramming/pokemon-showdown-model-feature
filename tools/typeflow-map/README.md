# typeflow-map

Minimal repo-native typeflow utility for structural TypeScript questions.

Commands:

```bash
node tools/typeflow-map/index.mjs field-sites --type ChoiceRequest --field active
node tools/typeflow-map/index.mjs narrowing-sites --from SideID --to PlayerID
node tools/typeflow-map/index.mjs seams --from SideRequestData --to RLChoiceTarget
```

Optional flags:

- `--json` for machine-readable output
- `--save` to persist a branch-local artifact under `tools/typeflow-map/artifacts/<branch>/`
- `--root <path>` to override repo-root discovery

Current first-slice focus:

- union-field access sites
- narrowing/assumption sites from one type into a narrower type
- seam candidates where parameter types mention a raw type and return types mention a normalized type
