# Visual Kubernetes — Next Features Plan

Ordered for minimum rework and natural dependency flow.

---

## 1. Left-rail layout cleanup (quick win) [done]
- Audit overlapping `section-card` spacing, reduce padding, tighten `field-grid` minmax values, add overflow guards.
- Pure CSS pass, no architectural change.
- **Why first:** cheap and unblocks clean screenshots for everything below.

## 2. Canvas zoom + pan + dynamic sizing [done]
- Wrap SVG content in a `<g transform="translate(tx,ty) scale(s)">` transform layer.
- Mouse-wheel zoom (cursor-anchored), middle-mouse or space+drag pan, pinch zoom on trackpad.
- Drop the fixed 1600×900 viewBox; let node extents define a virtual canvas that grows.
- Add toolbar: zoom %, "fit to content", "reset view".
- Update `handlePointerMove` hit-test math + `updateNodePosition` clamp to work under transform.
- **Why second:** foundational — every later feature (clusters, large templates, node-library drop targets) assumes we can view/place things at any scale.

## 3. Menubar + actionbar spec (design doc, no code yet) [done]
- **File:** New / Open / Save / Save As / Import YAML / Export ZIP / Recent
- **Edit:** Undo / Redo / Copy / Paste / Duplicate / Select All / Find
- **Asset:** Node Library / Templates / Import asset
- **View:** Fit to content / Zoom 100% / Toggle palette/inspector/dock / Grid
- **Graph:** Validate / Auto-layout / Detect pattern / Edge filters
- **Tools:** Compile / Simulate / Diff / Generate docs
- **Help:** Shortcuts / Docs / About
- **Actionbar:** Compile (validate+YAML), Save (snapshot), Browse (templates), Diff (vs snapshot), Find (fuzzy node search), Blueprint Settings (stack-wide), Cluster Defaults (per-cluster), Simulate (traffic/failure), Play (live preview)
- Deliverable: spec + updated labels/icons only.
- **Why third:** locks scope before we build so the menu isn't redesigned twice.

## 4. NetworkPolicy + RBAC as first-class nodes [done]
- Extend `NodeType` with `networkPolicy` and `role`.
- Inspector panels: selector labels, ingress/egress rules (NP); verbs/resources/apiGroups + SA binding (Role).
- Refactor engine to prefer explicit policy/role nodes when present, fall back to current edge inference.
- Add validation (Role must bind to ≥1 SA, NP must target a namespace).
- **Why fourth:** pure data-model + render work; benefits from zoom but doesn't block it.

## 5. Cluster grouping primitive [done]
- New `Cluster { id, name, provider, region, workerCount, nodeIds[] }`.
- Render as translucent rounded-rect backdrops behind assigned nodes; drag-into to assign.
- Left-rail "Clusters" card + inspector for worker count/region.
- Engine: emit per-cluster kubeconfig context + kustomize overlays; mark cross-cluster edges dashed with annotation.
- **Why fifth:** establishes the container model that templates/snapshots must serialize.

## 6. Node library palette with drag-from-tile [done]
- Replace "Add node" dropdown with a scrollable tile grid (icon + name + short note + hover-expanded notes).
- HTML5 drag-drop onto canvas (zoom/pan-aware drop coords).
- Tabs: **Core** (seeded ~15-20 common patterns — nginx-ingress, redis, postgres-HA, rabbitmq, celery-worker, cronjob, envoy, etc.) and **Custom** (user-saved).
- Right-click custom tile → edit notes / delete.
- Persist to localStorage under a separate key from workspace.
- **Why sixth:** needs zoom/pan math; feeds templates system.

## 7. Templates (full-graph) system [done]
- Template = full `{ model, layout, clusters }` snapshot with name + notes + thumbnail.
- Modal browser: **Out-of-box** (monolith, microservices starter, event-driven, 3-tier, ML pipeline, etc.) + **Custom**.
- Save-current-as-template and load-template (replace or merge-with-offset).
- **Why seventh:** reuses library storage pattern + needs clusters to serialize correctly.

## 8. Snapshots + versioning [done]
- IndexedDB-backed timestamped snapshots (localStorage too small for many full graphs).
- Auto-snapshot on Save / template load / bulk ops; manual "Save" in action bar.
- History panel (right rail tab): timeline, restore, delete, diff-vs-current.
- Lightweight in-memory undo/redo stack separate from snapshots.
- **Why eighth:** sits on top of stabilized model (clusters + templates now captured).

## 9. Per-node YAML pane in bottom dock [done]
- Split YAML tab into **Selected node** + **Full stack** (or pane toggle).
- Live-filter `generateKubernetesDocuments` by resources owned by the selected node (Deploy, Service, ConfigMap, Secret, Role, etc.).
- Copy-selected / download-selected buttons.
- Placeholder when nothing is selected.
- **Why ninth:** small, self-contained — lands whenever.

## 10. Wire up the action-bar buttons [done]
- Compile → validate + YAML preview
- Save → snapshot (step 8)
- Browse → templates modal (step 7)
- Diff → snapshot diff (step 8)
- Find → Cmd/Ctrl+F fuzzy node search
- Blueprint Settings → stack-wide modal
- Cluster Defaults → per-cluster modal (step 5)
- Simulate → animate request flow across edges, highlight SLA violations (minimal first pass)
- Play → read-only live-preview YAML with diff markers
- **Why tenth:** all underlying systems exist; this is glue.

## 11. Review pass + golden E2E
- Golden path test (Playwright or vitest+jsdom): load "microservices starter" template → zoom out → add NetworkPolicy node → connect to a service → save snapshot → export ZIP.
- Re-audit left-rail overlap after all new sections land.
- Keyboard-shortcut consistency + accessibility (ARIA, focus order).
- Performance with 50+ nodes (memoization, library virtualization).
- Engine unit coverage: clusters, NP/Role nodes, template round-trip, snapshot diff.
- **Why last:** earlier review is wasted work since the surface keeps changing.
