import { createNodeTemplate, starterArchitecture } from './data';
import {
  canConnectNodes,
  detectPattern,
  generateKubernetesDocuments,
  generateKubernetesYaml,
  generateProjectFiles,
  generateTerraform,
  getDerivedEnvironmentVariables,
  getResolvedModel,
  validateArchitecture,
} from './engine';

describe('architecture engine', () => {
  it('detects event-driven topologies when services publish to a queue', () => {
    expect(detectPattern(starterArchitecture)).toBe('event-driven');
  });

  it('blocks invalid ingress targets across the shared connection rules', () => {
    const fromNode = starterArchitecture.nodes.find((node) => node.id === 'ingress-web')!;
    const toNode = starterArchitecture.nodes.find((node) => node.id === 'db-orders')!;

    expect(canConnectNodes(fromNode, toNode)).toEqual(
      expect.objectContaining({
        allowed: false,
        reason: expect.stringContaining('frontend, gateway, or service'),
      }),
    );
  });

  it('exports kubernetes yaml with runnable deployment primitives', () => {
    const yaml = generateKubernetesYaml(starterArchitecture);

    expect(yaml).toContain('kind: Namespace');
    expect(yaml).toContain('namespace: checkout-platform');
    expect(yaml).toContain('namespace: data');
    expect(yaml).toContain('namespace: inventory');
    expect(yaml).toContain('kind: ServiceAccount');
    expect(yaml).toContain('kind: ConfigMap');
    expect(yaml).toContain('kind: Secret');
    expect(yaml).toContain('volumeClaimTemplates:');
    expect(yaml).toContain('persistentVolumeClaimRetentionPolicy:');
    expect(yaml).toContain('whenDeleted: Retain');
    expect(yaml).toContain('accessModes:');
    expect(yaml).toContain('- ReadWriteOnce');
    expect(yaml).toContain('volumeMode: Filesystem');
    expect(yaml).toContain('visual-kubernetes.io/backup-enabled: "true"');
    expect(yaml).toContain('secretName: checkout-api-tls');
    expect(yaml).toContain('cert-manager.io/cluster-issuer: "letsencrypt-prod"');
    expect(yaml).toContain('kind: HorizontalPodAutoscaler');
    expect(yaml).toContain('secretKeyRef:');
    expect(yaml).toContain('name: checkout-service-runtime');
    expect(yaml).toContain('kind: Role');
    expect(yaml).toContain('kind: RoleBinding');
    expect(yaml).toContain('kind: NetworkPolicy');
    expect(yaml).toContain('securityContext:');
    expect(yaml).toContain('runAsNonRoot: true');
    expect(yaml).toContain('allowPrivilegeEscalation: false');
    expect(yaml).toContain('seccompProfile:');
    expect(yaml).toContain('startupProbe:');
    expect(yaml).toContain('failureThreshold:');
    expect(yaml).toContain('terminationGracePeriodSeconds:');
    expect(yaml).toContain('imagePullSecrets:');
    expect(yaml).toContain('name: ghcr-pull-secret');
  });

  it('tags generated kubernetes documents with owning node ids for scoped previews', () => {
    const documents = generateKubernetesDocuments(starterArchitecture);
    const checkoutDocuments = documents.filter((document) => document.ownerNodeIds?.includes('service-checkout'));

    expect(checkoutDocuments.map((document) => document.kind)).toEqual(
      expect.arrayContaining(['ServiceAccount', 'Deployment', 'Service', 'HorizontalPodAutoscaler', 'NetworkPolicy']),
    );
    expect(checkoutDocuments.some((document) => document.name === 'inventory-inventory-service')).toBe(false);
    expect(documents.find((document) => document.kind === 'Namespace')?.ownerNodeIds).toBeUndefined();
  });

  it('exports terraform manifests for the kubernetes provider', () => {
    const terraform = generateTerraform(starterArchitecture);

    expect(terraform).toContain('provider "kubernetes"');
    expect(terraform).toContain('resource "kubernetes_manifest"');
    expect(terraform).toContain('kind: Secret');
    expect(terraform).toContain('kind: ServiceAccount');
    expect(terraform).toContain('kind: Ingress');
  });

  it('exports modular project files grouped by environment and namespace', () => {
    const files = generateProjectFiles(starterArchitecture);
    const paths = files.map((file) => file.path);

    expect(paths).toContain('k8s/prod/kustomization.yaml');
    expect(paths).toContain('k8s/prod/namespaces/checkout-platform/kustomization.yaml');
    expect(paths).toEqual(expect.arrayContaining([expect.stringMatching(/^k8s\/prod\/namespaces\/data\/.*statefulset.+\.yaml$/)]));
    expect(paths).toContain('terraform/prod/main.tf');
    expect(paths).toContain('terraform/prod/variables.tf');
    expect(paths).toEqual(expect.arrayContaining([expect.stringMatching(/^terraform\/prod\/manifests\/\d+-service-/)]));
    expect(paths).not.toContain('k8s/prod/manifests.yaml');

    const rootReadme = files.find((file) => file.path === 'README.md')?.content ?? '';
    expect(rootReadme).toContain('kubectl apply -k k8s/prod');
    expect(rootReadme).toContain('The Terraform and Kubernetes files are generated from the same manifest document set.');
  });

  it('applies active environment overrides before export', () => {
    const devModel = {
      ...starterArchitecture,
      activeEnvironment: 'dev' as const,
    };
    const resolvedCheckout = getResolvedModel(devModel).nodes.find((node) => node.id === 'service-checkout')!;
    const yaml = generateKubernetesYaml(devModel);

    expect(resolvedCheckout.replicas).toBe(1);
    expect(resolvedCheckout.tag).toBe('1.0.0-dev');
    expect(yaml).toContain('image: ghcr.io/visual-kubernetes/checkout-service:1.0.0-dev');
    expect(yaml).toContain('replicas: 1');
    expect(yaml).toContain('host: api.dev.checkout.internal');
  });

  it('applies provider-aware defaults to storage and ingress output', () => {
    const gcpModel = {
      ...starterArchitecture,
      provider: 'gcp' as const,
    };
    const resolvedDatabase = getResolvedModel(gcpModel).nodes.find((node) => node.id === 'db-orders')!;
    const resolvedQueue = getResolvedModel(gcpModel).nodes.find((node) => node.id === 'queue-events')!;
    const resolvedIngress = getResolvedModel(gcpModel).nodes.find((node) => node.id === 'ingress-web')!;
    const yaml = generateKubernetesYaml(gcpModel);

    expect(resolvedQueue.storage.storageClassName).toBe('standard-rwo');
    expect(resolvedDatabase.storage.storageClassName).toBe('premium-rwo');
    expect(resolvedIngress.ingress.ingressClassName).toBe('gce');
    expect(yaml).toContain('storageClassName: standard-rwo');
    expect(yaml).toContain('storageClassName: premium-rwo');
    expect(yaml).toContain('ingressClassName: gce');
    expect(yaml).toContain('kubernetes.io/ingress.class: "gce"');
  });

  it('exports provider-aware public and private networking intent', () => {
    const publicService = {
      ...createNodeTemplate('service'),
      name: 'Public Worker API',
      service: {
        ...createNodeTemplate('service').service,
        exposure: 'external' as const,
        loadBalancerScope: 'private' as const,
        externalTrafficPolicy: 'Local' as const,
      },
    };
    const model = {
      ...starterArchitecture,
      provider: 'aws' as const,
      nodes: [publicService],
      edges: [],
    };

    const resolved = getResolvedModel(model).nodes[0]!;
    const yaml = generateKubernetesYaml(model);

    expect(resolved.service.type).toBe('LoadBalancer');
    expect(yaml).toContain('service.beta.kubernetes.io/aws-load-balancer-scheme: "internal"');
    expect(yaml).toContain('externalTrafficPolicy: Local');
  });

  it('derives dependency config from graph edges for exports', () => {
    const derived = getDerivedEnvironmentVariables(starterArchitecture, 'service-checkout');
    const yaml = generateKubernetesYaml(starterArchitecture);

    expect(derived).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'INVENTORY_SERVICE_SERVICE_URL',
          value: 'http://inventory-service.inventory.svc.cluster.local:80',
        }),
        expect.objectContaining({
          key: 'DOMAIN_EVENTS_QUEUE_URL',
          value: 'amqp://domain-events.platform.svc.cluster.local:5672',
        }),
        expect.objectContaining({
          key: 'ORDERS_DB_DATABASE_HOST',
          value: 'orders-db.data.svc.cluster.local',
        }),
      ]),
    );
    expect(yaml).toContain('INVENTORY_SERVICE_SERVICE_URL: "http://inventory-service.inventory.svc.cluster.local:80"');
    expect(yaml).toContain('DOMAIN_EVENTS_QUEUE_URL: "amqp://domain-events.platform.svc.cluster.local:5672"');
    expect(yaml).toContain('ORDERS_DB_DATABASE_HOST: "orders-db.data.svc.cluster.local"');
  });

  it('does not generate dependency env or allow policies for denied edge intent', () => {
    const model = {
      ...starterArchitecture,
      edges: [{ ...starterArchitecture.edges[1]!, networkPolicy: 'deny' as const }],
    };
    const derived = getDerivedEnvironmentVariables(model, 'service-checkout');
    const yaml = generateKubernetesYaml(model);

    expect(derived).not.toEqual(expect.arrayContaining([expect.objectContaining({ key: 'INVENTORY_SERVICE_SERVICE_URL' })]));
    expect(yaml).not.toContain('allow-checkout-service-to-inventory-service');
  });

  it('only generates inline secret documents while preserving existing secret references', () => {
    const yaml = generateKubernetesYaml(starterArchitecture);

    expect(yaml).toContain('name: checkout-service-secret');
    expect(yaml).not.toContain('DATABASE_PASSWORD: "change-me"');
    expect(yaml).toContain('name: checkout-service-runtime');
    expect(yaml).toContain('key: database-password');
  });

  it('specializes workload kinds for workers, stateful services, jobs, and cronjobs', () => {
    const worker = createNodeTemplate('worker');
    const queue = createNodeTemplate('queue');
    const cache = createNodeTemplate('cache');
    const job = createNodeTemplate('job');
    const cronjob = createNodeTemplate('cronjob');
    const model = {
      ...starterArchitecture,
      nodes: [worker, queue, cache, job, cronjob],
      edges: [],
    };

    const documents = generateKubernetesDocuments(model);
    const yaml = documents.map((document) => document.yaml).join('\n---\n');

    expect(yaml).toContain('kind: Deployment');
    expect(yaml).toContain('kind: StatefulSet');
    expect(yaml).toContain('kind: Job');
    expect(yaml).toContain('kind: CronJob');
    expect(yaml).toContain('schedule: "*/15 * * * *"');
    expect(yaml).toContain('restartPolicy: OnFailure');
    expect(yaml).toContain('serviceName: queue-');
    expect(yaml).toContain('whenScaled: Retain');
    expect(documents).not.toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'Service', name: expect.stringContaining(worker.id) })]));
    expect(documents).not.toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'HorizontalPodAutoscaler' })]));
  });

  it('exports standalone persistent volume claims with storage depth settings', () => {
    const worker = createNodeTemplate('worker');
    const model = {
      ...starterArchitecture,
      nodes: [
        {
          ...worker,
          storage: {
            ...worker.storage,
            enabled: true,
            size: '12Gi',
            storageClassName: 'efs-sc',
            accessMode: 'ReadWriteMany' as const,
            backupEnabled: true,
            backupSchedule: '15 3 * * *',
          },
        },
      ],
      edges: [],
    };

    const yaml = generateKubernetesYaml(model);

    expect(yaml).toContain('kind: PersistentVolumeClaim');
    expect(yaml).toContain('- ReadWriteMany');
    expect(yaml).toContain('storageClassName: efs-sc');
    expect(yaml).toContain('storage: 12Gi');
    expect(yaml).toContain('visual-kubernetes.io/backup-schedule: "15 3 * * *"');
  });

  it('blocks runtime traffic into background workloads', () => {
    const service = createNodeTemplate('service');
    const worker = createNodeTemplate('worker');
    const job = createNodeTemplate('job');

    expect(canConnectNodes(service, worker)).toEqual(expect.objectContaining({ allowed: false }));
    expect(canConnectNodes(service, job)).toEqual(expect.objectContaining({ allowed: false }));
  });

  it('exports command args and exec startup probes', () => {
    const job = createNodeTemplate('job');
    const model = {
      ...starterArchitecture,
      nodes: [
        {
          ...job,
          workload: {
            ...job.workload,
            command: ['/bin/sh'],
            args: ['-c', 'node scripts/migrate.js'],
            terminationGracePeriodSeconds: 20,
          },
          startupProbe: {
            ...job.startupProbe,
            enabled: true,
            type: 'exec' as const,
            command: 'test -f /tmp/ready',
            failureThreshold: 5,
          },
        },
      ],
      edges: [],
    };

    const yaml = generateKubernetesYaml(model);

    expect(yaml).toContain('command:');
    expect(yaml).toContain('- "/bin/sh"');
    expect(yaml).toContain('args:');
    expect(yaml).toContain('- "node scripts/migrate.js"');
    expect(yaml).toContain('startupProbe:');
    expect(yaml).toContain('exec:');
    expect(yaml).toContain('- test');
    expect(yaml).toContain('terminationGracePeriodSeconds: 20');
  });

  it('exports explicit NetworkPolicy and Role nodes instead of only inferred policies', () => {
    const policy = {
      ...createNodeTemplate('networkPolicy', 'checkout-platform'),
      id: 'network-policy-checkout',
      name: 'Checkout ingress policy',
      networkPolicy: {
        targetLabels: [{ key: 'app', value: 'checkout-service' }],
        ingressFromLabels: [{ key: 'app', value: 'public-api' }],
        egressToCidrs: ['10.0.0.0/8'],
        allowIngress: true,
        allowEgress: true,
      },
    };
    const role = {
      ...createNodeTemplate('role', 'checkout-platform'),
      id: 'role-checkout',
      name: 'Checkout runtime role',
      role: {
        serviceAccounts: ['service-checkout-sa'],
        rules: [{ apiGroups: [''], resources: ['configmaps', 'secrets'], verbs: ['get'] }],
      },
    };
    const model = {
      ...starterArchitecture,
      nodes: [...starterArchitecture.nodes, policy, role],
      clusters: starterArchitecture.clusters.map((cluster) => ({
        ...cluster,
        nodeIds: [...cluster.nodeIds, policy.id, role.id],
      })),
    };
    const yaml = generateKubernetesYaml(model);
    const roleDocuments = generateKubernetesDocuments(model).filter((document) => document.kind === 'Role');

    expect(yaml).toContain('name: checkout-ingress-policy');
    expect(yaml).toContain('cidr: 10.0.0.0/8');
    expect(yaml).toContain('name: checkout-runtime-role');
    expect(yaml).toContain('name: service-checkout-sa');
    expect(roleDocuments.some((document) => document.name === 'checkout-platform-checkout-service-runtime')).toBe(false);
    expect(validateArchitecture(model).some((issue) => issue.message.includes('Checkout ingress policy'))).toBe(false);
  });

  it('exports cluster overlays and cross-cluster edge annotations', () => {
    const checkout = starterArchitecture.nodes.find((node) => node.id === 'service-checkout')!;
    const inventory = starterArchitecture.nodes.find((node) => node.id === 'service-inventory')!;
    const model = {
      ...starterArchitecture,
      clusters: [
        {
          id: 'cluster-east',
          name: 'East EKS',
          provider: 'aws' as const,
          region: 'us-east-1',
          workerCount: 3,
          nodeIds: [checkout.id],
        },
        {
          id: 'cluster-west',
          name: 'West EKS',
          provider: 'aws' as const,
          region: 'us-west-2',
          workerCount: 2,
          nodeIds: [inventory.id],
        },
      ],
      nodes: [checkout, inventory],
      edges: [{ id: 'cross', from: checkout.id, to: inventory.id, type: 'http' as const, latencyBudgetMs: 120, networkPolicy: 'allow' as const }],
    };

    const yaml = generateKubernetesYaml(model);
    const files = generateProjectFiles(model);
    const messages = validateArchitecture(model).map((issue) => issue.message);

    expect(yaml).toContain('visual-kubernetes.io/cross-cluster-edge: "true"');
    expect(files.map((file) => file.path)).toEqual(expect.arrayContaining([
      'k8s/prod/clusters/east-eks/kustomization.yaml',
      'k8s/prod/clusters/east-eks/kubeconfig-context.env',
      'k8s/prod/clusters/west-eks/kustomization.yaml',
    ]));
    expect(files.find((file) => file.path === 'k8s/prod/clusters/west-eks/kubeconfig-context.env')?.content).toContain('REGION=us-west-2');
    expect(messages).toEqual(expect.arrayContaining([expect.stringContaining('crosses clusters')]));
  });

  it('surfaces hardened validation for incomplete and risky runtime models', () => {
    const riskyService = createNodeTemplate('service');
    const riskyDatabase = createNodeTemplate('database');
    const model = {
      ...starterArchitecture,
      activeEnvironment: 'prod' as const,
      nodes: [
        {
          ...riskyService,
          name: 'Risky Service',
          namespace: 'Bad Namespace',
          replicas: 1,
          tag: 'latest',
          autoscaling: { ...riskyService.autoscaling, enabled: false },
          ingress: { ...riskyService.ingress, enabled: true, tlsEnabled: false, host: 'risky.example.com' },
          env: [{ key: 'API_TOKEN_HINT', value: 'SECRET_TOKEN_VALUE' }],
          secretEnv: [{ source: 'existingSecret' as const, key: 'API_TOKEN', secretName: 'runtime-secret', secretKey: 'token' }],
          environmentOverrides: {},
        },
        {
          ...riskyDatabase,
          name: 'Tiny DB',
          storage: { ...riskyDatabase.storage, size: '5Gi', retainOnDelete: 'Delete' as const },
          environmentOverrides: {},
        },
      ],
      edges: [
        {
          id: 'bad-edge',
          from: riskyService.id,
          to: riskyDatabase.id,
          type: 'http' as const,
          latencyBudgetMs: 10,
          networkPolicy: 'allow' as const,
        },
      ],
    };

    const messages = validateArchitecture(model).map((issue) => issue.message);

    expect(messages).toEqual(expect.arrayContaining([
      expect.stringContaining('namespace will be normalized'),
      expect.stringContaining('one replica and no autoscaling'),
      expect.stringContaining('uses a mutable image tag in prod'),
      expect.stringContaining('has no dev environment override'),
      expect.stringContaining('exposes ingress in prod without TLS'),
      expect.stringContaining('looks secret-like'),
      expect.stringContaining('External secret bad-namespace/runtime-secret is referenced but not generated'),
      expect.stringContaining('database storage is below 10Gi'),
      expect.stringContaining('durable storage is deleted'),
      expect.stringContaining('typed http, but the target suggests data'),
    ]));
  });
});
