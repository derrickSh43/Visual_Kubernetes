# Visual Kubernetes Feature Report

Date: 2026-04-25

This report describes what the current local-only MVP can do and how each feature is achieved in the codebase. It includes both visible UI features and lower-level product behaviors that matter when reviewing the tool.

## Product Positioning

Visual Kubernetes is a local visual infrastructure builder for modeling Kubernetes-oriented systems and exporting runnable starter configuration. It is designed for architecture review, learning, and bootstrap generation before a platform engineer hardens the output for production.

## Core Graph Builder

- Visual architecture canvas: The app renders a typed graph of infrastructure nodes and edges in an SVG canvas, with Kubernetes-oriented node cards, ports, edge labels, clusters, and environment/provider status.

- Unreal-style node presentation: Nodes use compact headers, typed labels, colored connection handles, metadata lines, and graph-grid styling to make the canvas feel more like a tool than a static web page.

- Canvas zoom and pan: The graph viewport supports zoom, fit-to-content, reset-to-100%, and background panning so larger systems can be navigated without losing off-screen nodes.

- Drag-to-position nodes: Nodes can be moved on the canvas and their layout is kept separate from the infrastructure model, which lets the visual arrangement change without changing generated YAML semantics.

- Keyboard-accessible canvas nodes: Canvas nodes are focusable button-like SVG groups and can be selected with keyboard actions, improving accessibility and making graph review less mouse-only.

## Node Library and Modeling

- Node library palette: The left rail provides searchable, categorized node tiles for common Kubernetes patterns such as ingress, services, workers, queues, databases, caches, jobs, cronjobs, NetworkPolicy, and RBAC roles.

- Generic workload escape hatch: A generic workload tile exists for cases that do not fit the predefined library, starting from a runnable Deployment/Service shape that can be refined in the inspector.

- Drag-from-palette node creation: Library tiles can be dragged onto the zoom-aware canvas, double-clicked, or added with a button, which gives multiple workflows for creating model objects.

- Custom node tiles: Users can save selected nodes as reusable custom tiles, and those custom tiles are persisted separately from the active workspace.

- Node type specialization: The engine treats node types differently instead of exporting every compute object as the same shape. Services produce Deployments and Services, stateful systems produce StatefulSets/storage, and batch nodes produce Job/CronJob output.

## Kubernetes-Aware Connections

- Valid connection rules: The app blocks invalid relationships such as ingress-to-database or runtime traffic into background jobs, using shared engine rules so the UI and validation agree.

- Edge type inference: Connections infer `http`, `async`, or `data` relationships from the target node type, reducing manual configuration and making generated dependency settings more consistent.

- Graph-derived dependency config: Edges generate service URLs, queue URLs, and data host environment variables so exported workloads reflect what is drawn on the canvas.

- Network policy intent on edges: Edges can be marked as allowed or denied. Allowed traffic can drive generated NetworkPolicy resources, while denied traffic remains visible as a modeled but blocked dependency.

- Cross-namespace and cross-cluster warnings: Validation calls out edges that cross namespace or cluster boundaries so reviewers know where routing, labels, and policy behavior need attention.

## Inspector and Fast Editing

- Right-side inspector: Selecting a node exposes runtime, service, workload, resource, health check, storage, networking, security, config, secret, NetworkPolicy, and RBAC fields as applicable.

- Responsive inspector wrapping: The inspector uses width-aware layout so related fields can share rows when the panel is expanded, reducing scrolling on wide screens.

- Quick action buttons: Common changes such as prod-ready defaults, public TLS ingress, and durable storage can be applied from quick actions instead of editing each field manually.

- Cluster editor: Clusters have provider, region, worker count, and node assignment controls, letting the graph represent infrastructure placement rather than only application topology.

- Environment switcher: Dev, stage, and prod can be switched from the top workflow bar, and environment-specific overrides change the generated output.

## Deployment Model

- Environment overlays: Nodes support environment overrides for replicas, tags, resources, autoscaling, and ingress settings, so one graph can represent dev/stage/prod differences.

- Provider-aware defaults: AWS, GCP, Azure, and generic providers affect storage class, ingress class, load balancer annotations, and generated guidance.

- Resource requests and limits: Workloads include editable CPU and memory requests/limits and export those values into Kubernetes manifests.

- Health checks: Readiness, liveness, and startup probes are modeled with HTTP, TCP, or exec behavior depending on workload type.

- Autoscaling: Deployment-like workloads can emit HorizontalPodAutoscaler resources with min/max replica and CPU utilization settings.

- Runtime behavior: Commands, args, restart policy, completions, parallelism, backoff limit, and termination grace periods are captured for workload types that need them.

- Storage model depth: Persistent storage includes size, storage class, access mode, volume mode, mount path, retain-on-delete, retain-on-scale-down, backup intent, and backup schedule.

- Security context baseline: The model captures run-as-non-root, run-as-user, read-only-root-filesystem, privilege escalation, and seccomp profile settings.

- Secrets and config separation: Plain config and secret values are modeled separately, and existing Kubernetes Secret references are handled differently from inline secret values.

## Templates, Snapshots, and History

- Built-in graph templates: The app includes out-of-box templates such as microservices starter, monolith/database, three-tier app, and ML pipeline.

- Custom graph templates: Users can save the current full graph as a reusable template and later replace or merge it with an offset.

- Workspace snapshots: Manual save and template actions can create timestamped snapshots that capture graph, layout, clusters, and generated config state.

- History panel: The right rail has a history tab for timeline review, restore, delete, and diff-vs-current summaries.

- Undo and redo: A lightweight in-memory undo/redo stack supports reverting bulk graph operations separately from persisted snapshots.

- Local persistence: Workspace state, custom node library data, and custom templates are stored in browser local storage; snapshots use IndexedDB with a localStorage fallback.

## Export System

- Full-stack Kubernetes YAML export: The bottom dock can preview the complete generated Kubernetes YAML for the active model and environment.

- Selected-node YAML export: The bottom dock can switch to a selected-node view that only includes resources owned by the active node, which helps review one component at a time.

- Terraform export: The app generates Terraform `kubernetes_manifest` resources from the same internal document set used for YAML, keeping Terraform and YAML aligned.

- ZIP bundle download: The export bundle downloads a modular project folder instead of one monolithic file, making the generated output easier to review, commit, and modify.

- Modular Kubernetes folder layout: Exported Kubernetes files are grouped by environment and namespace under `k8s/<environment>/namespaces/<namespace>/`.

- Per-cluster overlays: Cluster-specific kustomize overlays are generated under `k8s/<environment>/clusters/<cluster>/` with a context file and README.

- Kustomize roots: Environment and namespace folders include `kustomization.yaml` files so generated manifests can be applied with `kubectl apply -k`.

- Deterministic Kubernetes file naming: Each generated manifest file uses the pattern `<kind>-<resource-name>.yaml` after safe-name normalization, giving reviewers predictable file names and stable diffs.

- Deterministic Terraform manifest naming: Terraform manifest files use a numbered pattern like `001-<kind>-<resource-name>.tf`, preserving document order while keeping each resource modular.

- Generated README in exports: The ZIP includes a README that records provider, environment, namespace, storage class, ingress class, service exposure defaults, cluster count, and apply guidance.

- Safe download naming: Downloaded ZIP and selected-node YAML names are slugged from model or node names so file names stay filesystem-friendly.

## Validation and Review Signals

- Architecture pattern detection: The engine detects monolith, microservices, event-driven, or hybrid patterns based on the graph.

- Compile action: The Compile command validates the graph and refreshes the YAML preview while reporting error/warning counts.

- Risk validation: The engine warns or errors on missing images/tags, mutable prod tags, invalid namespaces, public exposure, missing TLS data, low database storage, root/privileged workloads, unresolved secret refs, invalid edges, and missing clusters.

- Deployment summary: The toolbar and engine produce node count, pattern, estimated monthly cost, Kubernetes object inventory, strengths, and warnings.

- Simulation pass: The Simulate action animates request flow across edges and helps visualize graph relationships, even though it is still a minimal first pass.

- Live preview: The Play action opens a read-only YAML preview for reviewing generated output without editing the graph.

## Tooling and Quality

- TypeScript domain model: Nodes, edges, clusters, environments, probes, storage, security, RBAC, NetworkPolicy, exports, and snapshots are represented with explicit TypeScript types.

- Shared engine rules: Connection checks, validation, pattern detection, deployment planning, YAML generation, Terraform generation, and project-file export live in the engine layer instead of being scattered across the UI.

- Automated tests: The current suite covers engine behavior, UI smoke flows, graph editing, templates, snapshots, selected-node YAML, ZIP export, keyboard behavior, and a 55-node generation sanity check.

- Golden workflow test: A high-value test loads the microservices template, zooms, adds a NetworkPolicy, saves a snapshot, verifies YAML, and triggers ZIP export.

- CI pipeline: GitHub Actions runs install, lint, tests, and production build on pushes to `main` and pull requests.

- Security review artifacts: The repo includes a public security-check summary, including npm audit results and Snyk follow-up remediation notes.

## Current Boundaries

- Local-only MVP: The app is intentionally documented as local-only and not production-hardened.

- No direct deploy/apply: The app generates configuration but does not apply it to a cluster.

- No public auth model: There is no authentication or authorization layer yet, so public hosting is out of scope.

- Generated output needs review: YAML and Terraform are credible starter output, but production use still requires human review and environment-specific hardening.
