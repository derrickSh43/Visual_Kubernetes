# Config Builder Roadmap

This file defines the ordered implementation list for the current product version: a visual config builder that produces realistic Kubernetes YAML and Terraform from the graph model.

## Goal

Make the graph produce deployment configuration that is credible, modular, and adaptation-ready for real engineering use, without trying to become a full deployment platform yet.

## Ordered implementation list

1. Environment overlays
Add `dev`, `stage`, and `prod` environments with override support for replicas, image tags, domains, resources, and autoscaling so the model matches real deployment workflows.

2. Edge-driven config wiring
Make graph connections drive generated configuration directly:
- `http` edges should define service dependency and routing relationships.
- `async` edges should define queue dependency and broker connection settings.
- `data` edges should define database/cache connection settings.
- inspector and export output should stay in sync with the graph.

3. Secrets and config model cleanup
Separate plain config from secrets more realistically:
- support `ConfigMap` values
- support inline secrets for MVP
- support secret references/placeholders for later external secret systems
- avoid treating every secret as raw text only

4. Provider-aware defaults
Make `aws`, `gcp`, `azure`, and `generic` materially affect defaults and exports:
- ingress/load balancer annotations
- storage class defaults
- service exposure defaults
- generated README guidance

5. Security baseline
Add the minimum security settings needed for credible exports:
- RBAC placeholders
- security context defaults
- image pull secret support
- graph-aware network policy generation

6. Workload type specialization
Stop treating all compute nodes as the same deployment shape:
- `service` and `frontend` -> deployment defaults
- `worker` -> background workload defaults
- `database`, `cache`, `queue` -> stronger stateful defaults
- add `job` and `cronjob` support if needed for workload coverage

7. Storage model depth
Expand persistent storage beyond a single size field:
- access mode
- storage class choice
- storage behavior by workload type
- better defaults for databases, caches, and queues

8. Networking depth
Strengthen runtime traffic and exposure modeling:
- internal vs external service exposure
- ingress class and TLS behavior
- public/private load balancer intent
- service-to-service policy intent

9. Runtime behavior depth
Expand workload execution settings where real deployments need them:
- startup probes
- command and args
- restart behavior where relevant
- stronger health-check modeling per workload type

10. Export structure hardening
Improve output quality and project structure:
- keep generated files modular
- group output by environment and namespace
- produce cleaner package layout for download bundles
- make YAML and Terraform exports stay aligned from the same internal model

11. Validation hardening
Catch incomplete or risky models before export:
- missing environment overrides
- invalid dependency patterns
- unresolved secret/config references
- namespace, ingress, storage, and scaling issues

12. UX pass for config-builder workflows
Refine the editor around the deployment model instead of around presentation:
- better edge feedback
- environment switching in the top bar
- clearer node-type behaviors
- faster editing for common deployment fields

## Minimum bar for this version

This version is successful when a user can:

- model a system visually
- choose provider and environment
- define realistic workload settings
- wire dependencies through graph edges
- export modular YAML and Terraform
- receive validation before export

## Not part of this version

These are important later, but should not drive this phase:

- full Helm import/export
- full cloud-cluster Terraform for EKS, GKE, or AKS
- multi-user collaboration
- direct deploy/apply from the UI
- observability platform generation
- advanced cost modeling
