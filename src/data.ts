import type {
  ArchitectureEdge,
  ArchitectureModel,
  ArchitectureNode,
  CanvasLayout,
  EnvironmentName,
  GraphTemplate,
  NodeLibraryItem,
  NodeEnvironmentOverride,
  NodeType,
  WorkspaceState,
} from './types';

export const availableNodeTypes: Array<{ type: NodeType; label: string; description: string }> = [
  { type: 'frontend', label: 'Frontend', description: 'Browser-facing web app' },
  { type: 'gateway', label: 'Gateway', description: 'API gateway or edge service' },
  { type: 'service', label: 'Service', description: 'Core application workload' },
  { type: 'worker', label: 'Worker', description: 'Background processor or job consumer' },
  { type: 'job', label: 'Job', description: 'One-time batch task' },
  { type: 'cronjob', label: 'CronJob', description: 'Scheduled batch task' },
  { type: 'queue', label: 'Queue', description: 'Message broker or stream entry' },
  { type: 'cache', label: 'Cache', description: 'Low-latency in-memory store' },
  { type: 'database', label: 'Database', description: 'Persistent stateful storage' },
  { type: 'ingress', label: 'Ingress', description: 'External traffic entrypoint' },
  { type: 'networkPolicy', label: 'NetworkPolicy', description: 'Explicit namespace traffic policy' },
  { type: 'role', label: 'Role', description: 'Explicit RBAC role and service account binding' },
];

export const coreNodeLibrary: NodeLibraryItem[] = [
  {
    id: 'nginx-ingress',
    type: 'ingress',
    name: 'nginx ingress',
    description: 'External HTTP entrypoint',
    notes: 'Creates an ingress-style node with nginx defaults and public exposure.',
    icon: 'IG',
    overrides: { name: 'nginx ingress', image: 'nginx', tag: '1.27' },
  },
  {
    id: 'api-gateway',
    type: 'gateway',
    name: 'api gateway',
    description: 'North-south API router',
    notes: 'Gateway workload for routing service traffic behind an ingress.',
    icon: 'GW',
    overrides: { name: 'api gateway', image: 'ghcr.io/visual-kubernetes/gateway', tag: 'latest' },
  },
  {
    id: 'web-frontend',
    type: 'frontend',
    name: 'web frontend',
    description: 'Browser-facing app',
    notes: 'Frontend deployment with HPA enabled and standard HTTP probes.',
    icon: 'FE',
    overrides: { name: 'web frontend', image: 'ghcr.io/visual-kubernetes/frontend', tag: 'latest' },
  },
  {
    id: 'rest-service',
    type: 'service',
    name: 'rest service',
    description: 'Core HTTP service',
    notes: 'General service node for business logic and Kubernetes Service export.',
    icon: 'SV',
    overrides: { name: 'rest service', image: 'ghcr.io/visual-kubernetes/service', tag: 'latest' },
  },
  {
    id: 'generic-workload',
    type: 'service',
    name: 'generic workload',
    description: 'Fallback custom workload',
    notes: 'Escape hatch for anything not covered by the library. Starts as a runnable Deployment plus Service; refine image, ports, probes, resources, and kind in the inspector.',
    icon: 'GN',
    overrides: { name: 'generic workload', image: 'ghcr.io/visual-kubernetes/custom-workload', tag: 'latest' },
  },
  {
    id: 'worker',
    type: 'worker',
    name: 'queue worker',
    description: 'Background consumer',
    notes: 'Outbound-only worker that can consume queues, APIs, and data stores.',
    icon: 'WK',
    overrides: { name: 'queue worker', image: 'ghcr.io/visual-kubernetes/worker', tag: 'latest' },
  },
  {
    id: 'postgres-ha',
    type: 'database',
    name: 'postgres HA',
    description: 'Stateful relational DB',
    notes: 'Postgres StatefulSet with durable storage and backup intent enabled.',
    icon: 'PG',
    overrides: { name: 'postgres HA', image: 'postgres', tag: '16', replicas: 2 },
  },
  {
    id: 'redis-cache',
    type: 'cache',
    name: 'redis cache',
    description: 'Low-latency cache',
    notes: 'Redis StatefulSet with ClusterIP service and optional storage.',
    icon: 'RD',
    overrides: { name: 'redis cache', image: 'redis', tag: '7' },
  },
  {
    id: 'rabbitmq',
    type: 'queue',
    name: 'rabbitmq',
    description: 'AMQP event broker',
    notes: 'RabbitMQ queue node with durable storage and TCP service defaults.',
    icon: 'MQ',
    overrides: { name: 'rabbitmq', image: 'rabbitmq', tag: '3-management' },
  },
  {
    id: 'celery-worker',
    type: 'worker',
    name: 'celery worker',
    description: 'Python async worker',
    notes: 'Worker pattern for Celery-style background jobs.',
    icon: 'CY',
    overrides: { name: 'celery worker', image: 'ghcr.io/visual-kubernetes/celery-worker', tag: 'latest' },
  },
  {
    id: 'cron-maintenance',
    type: 'cronjob',
    name: 'maintenance cron',
    description: 'Scheduled maintenance',
    notes: 'CronJob pattern for recurring cleanup, reports, or sync tasks.',
    icon: 'CR',
    overrides: { name: 'maintenance cron', image: 'ghcr.io/visual-kubernetes/cronjob', tag: 'latest' },
  },
  {
    id: 'batch-job',
    type: 'job',
    name: 'batch job',
    description: 'One-time workload',
    notes: 'Kubernetes Job for migrations, imports, or one-shot processing.',
    icon: 'JB',
    overrides: { name: 'batch job', image: 'ghcr.io/visual-kubernetes/job', tag: 'latest' },
  },
  {
    id: 'envoy-proxy',
    type: 'gateway',
    name: 'envoy proxy',
    description: 'L7 proxy sidecar/front proxy',
    notes: 'Gateway-flavored proxy node for service mesh or edge proxy designs.',
    icon: 'EV',
    overrides: { name: 'envoy proxy', image: 'envoyproxy/envoy', tag: 'v1.31-latest' },
  },
  {
    id: 'network-policy',
    type: 'networkPolicy',
    name: 'network policy',
    description: 'Explicit traffic policy',
    notes: 'Selector-driven NetworkPolicy node for ingress and egress rules.',
    icon: 'NP',
    overrides: { name: 'network policy' },
  },
  {
    id: 'rbac-role',
    type: 'role',
    name: 'rbac role',
    description: 'Role and RoleBinding',
    notes: 'Explicit RBAC node for binding service accounts to rules.',
    icon: 'RB',
    overrides: { name: 'rbac role' },
  },
  {
    id: 'external-api',
    type: 'service',
    name: 'external api adapter',
    description: 'Outbound integration adapter',
    notes: 'Service pattern for wrapping external APIs and centralizing credentials.',
    icon: 'EA',
    overrides: { name: 'external api adapter', image: 'ghcr.io/visual-kubernetes/api-adapter', tag: 'latest' },
  },
  {
    id: 'ml-inference',
    type: 'service',
    name: 'ml inference',
    description: 'Model-serving endpoint',
    notes: 'HTTP service pattern for inference APIs with resource limits.',
    icon: 'ML',
    overrides: { name: 'ml inference', image: 'ghcr.io/visual-kubernetes/ml-inference', tag: 'latest' },
  },
];

export const supportedEnvironments: EnvironmentName[] = ['dev', 'stage', 'prod'];

function baseProbe(path: string, port: number, type: 'http' | 'tcp' | 'exec' = 'http') {
  return {
    enabled: true,
    type,
    path,
    port,
    command: '',
    initialDelaySeconds: 10,
    periodSeconds: 10,
    failureThreshold: 3,
  };
}

function disabledProbe(path: string, port: number, type: 'http' | 'tcp' | 'exec' = 'http') {
  return {
    ...baseProbe(path, port, type),
    enabled: false,
    initialDelaySeconds: 20,
    failureThreshold: 30,
  };
}

function defaultProbeType(type: NodeType) {
  return type === 'database' || type === 'queue' || type === 'cache' ? 'tcp' as const : 'http' as const;
}

function defaultStartupProbe(type: NodeType, port: number) {
  if (type === 'job' || type === 'cronjob' || type === 'networkPolicy' || type === 'role') {
    return disabledProbe('/ready', port);
  }

  const probeType = defaultProbeType(type);
  return {
    ...baseProbe(probeType === 'tcp' ? '' : '/ready', port, probeType),
    initialDelaySeconds: type === 'database' || type === 'queue' ? 20 : 10,
    periodSeconds: 5,
    failureThreshold: type === 'database' || type === 'queue' ? 30 : 12,
  };
}

function defaultRuntime(type: NodeType) {
  return {
    command: [] as string[],
    args: [] as string[],
    terminationGracePeriodSeconds: type === 'database' || type === 'queue' ? 60 : type === 'job' || type === 'cronjob' ? 30 : 45,
  };
}

function defaultWorkloadKind(type: NodeType) {
  if (type === 'database' || type === 'queue' || type === 'cache') {
    return 'StatefulSet' as const;
  }
  if (type === 'job') {
    return 'Job' as const;
  }
  if (type === 'cronjob') {
    return 'CronJob' as const;
  }
  return 'Deployment' as const;
}

function defaultNetworkPolicy(type: NodeType) {
  return {
    targetLabels: [{ key: 'app', value: type === 'networkPolicy' ? 'replace-me' : '' }],
    ingressFromLabels: [] as Array<{ key: string; value: string }>,
    egressToCidrs: [] as string[],
    allowIngress: true,
    allowEgress: false,
  };
}

function defaultRole(type: NodeType, id: string) {
  return {
    serviceAccounts: type === 'role' ? [`${id}-sa`] : [] as string[],
    rules: [
      {
        apiGroups: [''],
        resources: type === 'role' ? ['configmaps', 'secrets'] : ['configmaps'],
        verbs: ['get', 'list', 'watch'],
      },
    ],
  };
}

function storageDefaults(type: NodeType) {
  return {
    enabled: type === 'database' || type === 'queue' || type === 'cache',
    size: type === 'database' ? '20Gi' : type === 'queue' ? '8Gi' : type === 'cache' ? '4Gi' : '5Gi',
    storageClassName: 'standard',
    accessMode: 'ReadWriteOnce' as const,
    volumeMode: 'Filesystem' as const,
    mountPath:
      type === 'database'
        ? '/var/lib/postgresql/data'
        : type === 'queue'
          ? '/var/lib/rabbitmq'
          : '/data',
    retainOnDelete: type === 'database' || type === 'queue' ? 'Retain' as const : 'Delete' as const,
    retainOnScaleDown: type === 'database' || type === 'queue' ? 'Retain' as const : 'Delete' as const,
    backupEnabled: type === 'database' || type === 'queue',
    backupSchedule: '0 2 * * *',
  };
}

function createNode(id: string, name: string, type: NodeType, overrides: Partial<ArchitectureNode> = {}): ArchitectureNode {
  const defaultNamespace = 'checkout-platform';
  const defaultPort =
    type === 'database' ? 5432 : type === 'queue' ? 5672 : type === 'cache' ? 6379 : type === 'ingress' ? 80 : 8080;
  const defaultServicePort = type === 'database' ? 5432 : type === 'queue' ? 5672 : type === 'cache' ? 6379 : 80;

  return {
    id,
    name,
    type,
    namespace: defaultNamespace,
    replicas: type === 'database' || type === 'queue' || type === 'cache' || type === 'job' || type === 'cronjob' ? 1 : 2,
    cpu: type === 'database' ? 2 : 1,
    memory: type === 'database' ? 8 : 2,
    sla: type === 'database' ? 'critical' : 'standard',
    image:
      type === 'database'
        ? 'postgres'
        : type === 'queue'
          ? 'rabbitmq'
          : type === 'cache'
            ? 'redis'
            : type === 'frontend'
              ? 'ghcr.io/visual-kubernetes/frontend'
              : type === 'gateway'
                ? 'ghcr.io/visual-kubernetes/gateway'
                : type === 'worker'
                  ? 'ghcr.io/visual-kubernetes/worker'
                  : type === 'job'
                    ? 'ghcr.io/visual-kubernetes/job'
                  : type === 'cronjob'
                    ? 'ghcr.io/visual-kubernetes/cronjob'
                    : type === 'networkPolicy'
                      ? 'policy.visual-kubernetes.local/network-policy'
                      : type === 'role'
                        ? 'policy.visual-kubernetes.local/role'
                  : type === 'ingress'
                    ? 'nginx'
                    : 'ghcr.io/visual-kubernetes/service',
    tag:
      type === 'database'
        ? '16'
        : type === 'queue'
          ? '3-management'
          : type === 'cache'
            ? '7'
            : type === 'ingress'
              ? '1.27'
              : type === 'networkPolicy' || type === 'role'
                ? 'v1'
              : 'latest',
    containerPort: defaultPort,
    env: [],
    secretEnv: [],
    resources: {
      requestsCpu: type === 'database' ? '500m' : '250m',
      requestsMemory: type === 'database' ? '1Gi' : '256Mi',
      limitsCpu: type === 'database' ? '2000m' : '1000m',
      limitsMemory: type === 'database' ? '4Gi' : '1Gi',
    },
    readinessProbe: baseProbe('/ready', defaultPort, defaultProbeType(type)),
    livenessProbe: baseProbe('/health', defaultPort, defaultProbeType(type)),
    startupProbe: defaultStartupProbe(type, defaultPort),
    autoscaling: {
      enabled: type === 'service' || type === 'frontend' || type === 'gateway',
      minReplicas: 2,
      maxReplicas: 6,
      targetCPUUtilizationPercentage: 70,
    },
    workload: {
      kind: defaultWorkloadKind(type),
      schedule: '*/15 * * * *',
      completions: 1,
      parallelism: 1,
      backoffLimit: 3,
      restartPolicy: type === 'job' || type === 'cronjob' ? 'OnFailure' : 'Always',
      ...defaultRuntime(type),
    },
    storage: storageDefaults(type),
    service: {
      type: 'ClusterIP',
      port: defaultServicePort,
      exposure: type === 'ingress' ? 'external' : 'internal',
      loadBalancerScope: 'public',
      externalTrafficPolicy: 'Cluster',
    },
    serviceAccountName: `${id}-sa`,
    imagePullSecrets: [],
    security: {
      runAsNonRoot: type !== 'database' && type !== 'queue',
      runAsUser: type === 'database' ? 999 : type === 'queue' ? 999 : 1000,
      readOnlyRootFilesystem: type !== 'database' && type !== 'queue' && type !== 'cache',
      allowPrivilegeEscalation: false,
      seccompProfile: 'RuntimeDefault',
    },
    networkPolicy: defaultNetworkPolicy(type),
    role: defaultRole(type, id),
    ingress: {
      enabled: type === 'ingress',
      host: `${id}.example.internal`,
      path: '/',
      tlsEnabled: false,
      tlsSecretName: `${id}-tls`,
      tlsIssuer: '',
      ingressClassName: 'nginx',
      exposure: type === 'ingress' ? 'external' : 'internal',
      loadBalancerScope: 'public',
    },
    environmentOverrides: {},
    ...overrides,
  };
}

function envOverride(overrides: Partial<Record<EnvironmentName, NodeEnvironmentOverride>>) {
  return overrides;
}

export const starterNodes: ArchitectureNode[] = [
  createNode('ingress-web', 'Public API', 'ingress', {
    service: { type: 'LoadBalancer', port: 80, exposure: 'external', loadBalancerScope: 'public', externalTrafficPolicy: 'Cluster' },
    ingress: {
      enabled: true,
      host: 'api.checkout.internal',
      path: '/',
      tlsEnabled: true,
      tlsSecretName: 'checkout-api-tls',
      tlsIssuer: 'letsencrypt-prod',
      ingressClassName: 'nginx',
      exposure: 'external',
      loadBalancerScope: 'public',
    },
    environmentOverrides: envOverride({
      dev: {
        ingress: {
          host: 'api.dev.checkout.internal',
          tlsSecretName: 'checkout-api-dev-tls',
        },
      },
      stage: {
        ingress: {
          host: 'api.stage.checkout.internal',
          tlsSecretName: 'checkout-api-stage-tls',
        },
      },
    }),
  }),
  createNode('service-checkout', 'Checkout Service', 'service', {
    replicas: 3,
    cpu: 2,
    memory: 4,
    sla: 'critical',
    image: 'ghcr.io/visual-kubernetes/checkout-service',
    tag: '1.0.0',
    containerPort: 8080,
    imagePullSecrets: ['ghcr-pull-secret'],
    env: [
      { key: 'SPRING_PROFILES_ACTIVE', value: 'prod' },
      { key: 'DATABASE_HOST', value: 'orders-db.data' },
    ],
    secretEnv: [
      { source: 'existingSecret', key: 'DATABASE_PASSWORD', secretName: 'checkout-service-runtime', secretKey: 'database-password' },
      { source: 'inline', key: 'JWT_SECRET', value: 'replace-me' },
    ],
    environmentOverrides: envOverride({
      dev: {
        replicas: 1,
        tag: '1.0.0-dev',
        resources: {
          requestsCpu: '150m',
          requestsMemory: '192Mi',
          limitsCpu: '500m',
          limitsMemory: '512Mi',
        },
        autoscaling: {
          enabled: false,
          minReplicas: 1,
          maxReplicas: 1,
        },
      },
      stage: {
        replicas: 2,
        tag: '1.0.0-rc',
        ingress: {
          host: 'checkout.stage.internal',
        },
      },
    }),
  }),
  createNode('service-inventory', 'Inventory Service', 'service', {
    namespace: 'inventory',
    image: 'ghcr.io/visual-kubernetes/inventory-service',
    tag: '1.0.0',
    imagePullSecrets: ['ghcr-pull-secret'],
    env: [{ key: 'QUEUE_HOST', value: 'domain-events.platform' }],
    secretEnv: [{ source: 'existingSecret', key: 'QUEUE_PASSWORD', secretName: 'inventory-runtime', secretKey: 'queue-password' }],
    environmentOverrides: envOverride({
      dev: {
        replicas: 1,
        tag: '1.0.0-dev',
        resources: {
          requestsCpu: '150m',
          requestsMemory: '192Mi',
          limitsCpu: '500m',
          limitsMemory: '512Mi',
        },
      },
      stage: {
        tag: '1.0.0-rc',
      },
    }),
  }),
  createNode('queue-events', 'Domain Events', 'queue', {
    namespace: 'platform',
    image: 'rabbitmq',
    tag: '3-management',
    containerPort: 5672,
    service: { type: 'ClusterIP', port: 5672, exposure: 'internal', loadBalancerScope: 'private', externalTrafficPolicy: 'Cluster' },
    readinessProbe: baseProbe('/', 15672),
    livenessProbe: baseProbe('/', 15672),
    autoscaling: {
      enabled: false,
      minReplicas: 1,
      maxReplicas: 1,
      targetCPUUtilizationPercentage: 70,
    },
    storage: {
      enabled: true,
      size: '8Gi',
      storageClassName: 'standard',
      accessMode: 'ReadWriteOnce',
      volumeMode: 'Filesystem',
      mountPath: '/var/lib/rabbitmq',
      retainOnDelete: 'Retain',
      retainOnScaleDown: 'Retain',
      backupEnabled: true,
      backupSchedule: '0 2 * * *',
    },
    secretEnv: [{ source: 'inline', key: 'RABBITMQ_DEFAULT_PASS', value: 'change-me' }],
    environmentOverrides: envOverride({
      dev: {
        replicas: 1,
        tag: '3-management-alpine',
        resources: {
          requestsCpu: '150m',
          requestsMemory: '256Mi',
          limitsCpu: '500m',
          limitsMemory: '768Mi',
        },
      },
    }),
  }),
  createNode('db-orders', 'Orders DB', 'database', {
    namespace: 'data',
    image: 'postgres',
    tag: '16',
    containerPort: 5432,
    service: { type: 'ClusterIP', port: 5432, exposure: 'internal', loadBalancerScope: 'private', externalTrafficPolicy: 'Cluster' },
    env: [{ key: 'POSTGRES_DB', value: 'orders' }],
    secretEnv: [
      { source: 'inline', key: 'POSTGRES_USER', value: 'orders_app' },
      { source: 'existingSecret', key: 'POSTGRES_PASSWORD', secretName: 'orders-db-runtime', secretKey: 'postgres-password' },
    ],
    readinessProbe: {
      enabled: true,
      type: 'tcp',
      path: '/ready',
      port: 5432,
      command: '',
      initialDelaySeconds: 20,
      periodSeconds: 10,
      failureThreshold: 3,
    },
    livenessProbe: {
      enabled: true,
      type: 'tcp',
      path: '/live',
      port: 5432,
      command: '',
      initialDelaySeconds: 30,
      periodSeconds: 15,
      failureThreshold: 3,
    },
    autoscaling: {
      enabled: false,
      minReplicas: 1,
      maxReplicas: 1,
      targetCPUUtilizationPercentage: 70,
    },
    storage: {
      enabled: true,
      size: '50Gi',
      storageClassName: 'premium-rwo',
      accessMode: 'ReadWriteOnce',
      volumeMode: 'Filesystem',
      mountPath: '/var/lib/postgresql/data',
      retainOnDelete: 'Retain',
      retainOnScaleDown: 'Retain',
      backupEnabled: true,
      backupSchedule: '0 1 * * *',
    },
    environmentOverrides: envOverride({
      dev: {
        tag: '16-alpine',
        resources: {
          requestsCpu: '250m',
          requestsMemory: '512Mi',
          limitsCpu: '1000m',
          limitsMemory: '2Gi',
        },
      },
      stage: {
        resources: {
          requestsCpu: '350m',
          requestsMemory: '768Mi',
          limitsCpu: '1500m',
          limitsMemory: '3Gi',
        },
      },
    }),
  }),
];

export const starterEdges: ArchitectureEdge[] = [
  { id: 'e1', from: 'ingress-web', to: 'service-checkout', type: 'http', latencyBudgetMs: 150, networkPolicy: 'allow' },
  { id: 'e2', from: 'service-checkout', to: 'service-inventory', type: 'http', latencyBudgetMs: 200, networkPolicy: 'allow' },
  { id: 'e3', from: 'service-checkout', to: 'queue-events', type: 'async', latencyBudgetMs: 500, networkPolicy: 'allow' },
  { id: 'e4', from: 'service-checkout', to: 'db-orders', type: 'data', latencyBudgetMs: 40, networkPolicy: 'allow' },
];

export const starterArchitecture: ArchitectureModel = {
  name: 'Checkout Platform',
  defaultNamespace: 'checkout-platform',
  provider: 'aws',
  activeEnvironment: 'prod',
  clusters: [
    {
      id: 'cluster-primary',
      name: 'Primary EKS',
      provider: 'aws',
      region: 'us-east-1',
      workerCount: 3,
      nodeIds: starterNodes.map((node) => node.id),
    },
  ],
  nodes: starterNodes,
  edges: starterEdges,
};

export const starterLayout: CanvasLayout = {
  'ingress-web': { x: 80, y: 120 },
  'service-checkout': { x: 290, y: 90 },
  'service-inventory': { x: 290, y: 250 },
  'queue-events': { x: 560, y: 90 },
  'db-orders': { x: 560, y: 250 },
};

export const starterWorkspace: WorkspaceState = {
  model: starterArchitecture,
  layout: starterLayout,
};

const monolithNodes: ArchitectureNode[] = [
  createNode('ingress-monolith', 'Public Web', 'ingress', {
    namespace: 'monolith',
    service: { type: 'LoadBalancer', port: 80, exposure: 'external', loadBalancerScope: 'public', externalTrafficPolicy: 'Cluster' },
    ingress: {
      enabled: true,
      host: 'app.example.internal',
      path: '/',
      tlsEnabled: true,
      tlsSecretName: 'app-tls',
      tlsIssuer: 'letsencrypt-prod',
      ingressClassName: 'nginx',
      exposure: 'external',
      loadBalancerScope: 'public',
    },
  }),
  createNode('service-monolith', 'Monolith App', 'service', {
    namespace: 'monolith',
    image: 'ghcr.io/visual-kubernetes/monolith',
    tag: '1.0.0',
    replicas: 3,
    env: [{ key: 'DATABASE_HOST', value: 'postgres.monolith.svc.cluster.local' }],
  }),
  createNode('db-monolith', 'Postgres', 'database', {
    namespace: 'monolith',
    storage: {
      enabled: true,
      size: '30Gi',
      storageClassName: 'gp3',
      accessMode: 'ReadWriteOnce',
      volumeMode: 'Filesystem',
      mountPath: '/var/lib/postgresql/data',
      retainOnDelete: 'Retain',
      retainOnScaleDown: 'Retain',
      backupEnabled: true,
      backupSchedule: '0 2 * * *',
    },
  }),
];

const threeTierNodes: ArchitectureNode[] = [
  createNode('ingress-three-tier', 'Public Edge', 'ingress', { namespace: 'web' }),
  createNode('frontend-three-tier', 'Web Frontend', 'frontend', { namespace: 'web', image: 'ghcr.io/visual-kubernetes/web-frontend' }),
  createNode('api-three-tier', 'API Service', 'service', { namespace: 'app', image: 'ghcr.io/visual-kubernetes/api' }),
  createNode('db-three-tier', 'Application DB', 'database', { namespace: 'data', storage: { ...storageDefaults('database'), size: '40Gi', backupEnabled: true } }),
];

const mlPipelineNodes: ArchitectureNode[] = [
  createNode('ingress-ml', 'Inference API', 'ingress', { namespace: 'ml' }),
  createNode('service-inference', 'Model Inference', 'service', {
    namespace: 'ml',
    image: 'ghcr.io/visual-kubernetes/ml-inference',
    replicas: 3,
    resources: { requestsCpu: '1000m', requestsMemory: '2Gi', limitsCpu: '4000m', limitsMemory: '8Gi' },
  }),
  createNode('queue-features', 'Feature Jobs', 'queue', { namespace: 'ml', image: 'rabbitmq', tag: '3-management' }),
  createNode('worker-training', 'Training Worker', 'worker', {
    namespace: 'ml',
    image: 'ghcr.io/visual-kubernetes/training-worker',
    resources: { requestsCpu: '2000m', requestsMemory: '4Gi', limitsCpu: '8000m', limitsMemory: '16Gi' },
  }),
  createNode('cache-features', 'Feature Cache', 'cache', { namespace: 'ml', image: 'redis', tag: '7' }),
];

function workspaceTemplate(
  id: string,
  name: string,
  notes: string,
  thumbnail: string,
  workspace: WorkspaceState,
): GraphTemplate {
  return { id, name, notes, thumbnail, workspace };
}

function templateWorkspace(
  name: string,
  provider: ArchitectureModel['provider'],
  nodes: ArchitectureNode[],
  edges: ArchitectureEdge[],
  layout: CanvasLayout,
): WorkspaceState {
  return {
    model: {
      name,
      defaultNamespace: nodes[0]?.namespace ?? 'default',
      provider,
      activeEnvironment: 'prod',
      clusters: [
        {
          id: 'cluster-primary',
          name: provider === 'aws' ? 'Primary EKS' : provider === 'gcp' ? 'Primary GKE' : provider === 'azure' ? 'Primary AKS' : 'Primary Cluster',
          provider,
          region: provider === 'gcp' ? 'us-central1' : provider === 'azure' ? 'eastus' : 'us-east-1',
          workerCount: Math.max(3, Math.ceil(nodes.length / 2)),
          nodeIds: nodes.map((node) => node.id),
        },
      ],
      nodes,
      edges,
    },
    layout,
  };
}

export const builtinGraphTemplates: GraphTemplate[] = [
  workspaceTemplate(
    'template-microservices-starter',
    'Microservices Starter',
    'Checkout-style event-driven starter with ingress, services, queue, database, namespaces, storage, and environment overrides.',
    'IG -> API -> SVC + MQ + DB',
    starterWorkspace,
  ),
  workspaceTemplate(
    'template-monolith',
    'Monolith + Database',
    'Simple production web app with one service and one stateful database behind a public ingress.',
    'WEB -> APP -> DB',
    templateWorkspace(
      'Monolith Platform',
      'aws',
      monolithNodes,
      [
        { id: 'mono-e1', from: 'ingress-monolith', to: 'service-monolith', type: 'http', latencyBudgetMs: 120, networkPolicy: 'allow' },
        { id: 'mono-e2', from: 'service-monolith', to: 'db-monolith', type: 'data', latencyBudgetMs: 40, networkPolicy: 'allow' },
      ],
      {
        'ingress-monolith': { x: 100, y: 150 },
        'service-monolith': { x: 390, y: 150 },
        'db-monolith': { x: 680, y: 150 },
      },
    ),
  ),
  workspaceTemplate(
    'template-three-tier',
    'Three Tier Web App',
    'Web, API, and data namespaces split into a classic three-tier topology with explicit tier boundaries.',
    'EDGE -> WEB -> API -> DATA',
    templateWorkspace(
      'Three Tier Platform',
      'gcp',
      threeTierNodes,
      [
        { id: 'tier-e1', from: 'ingress-three-tier', to: 'frontend-three-tier', type: 'http', latencyBudgetMs: 100, networkPolicy: 'allow' },
        { id: 'tier-e2', from: 'frontend-three-tier', to: 'api-three-tier', type: 'http', latencyBudgetMs: 150, networkPolicy: 'allow' },
        { id: 'tier-e3', from: 'api-three-tier', to: 'db-three-tier', type: 'data', latencyBudgetMs: 35, networkPolicy: 'allow' },
      ],
      {
        'ingress-three-tier': { x: 80, y: 120 },
        'frontend-three-tier': { x: 360, y: 120 },
        'api-three-tier': { x: 640, y: 120 },
        'db-three-tier': { x: 920, y: 120 },
      },
    ),
  ),
  workspaceTemplate(
    'template-ml-pipeline',
    'ML Pipeline',
    'Inference API, async training worker, feature queue, and cache grouped into a single ML cluster.',
    'API + MQ -> WORKER -> CACHE',
    templateWorkspace(
      'ML Pipeline',
      'azure',
      mlPipelineNodes,
      [
        { id: 'ml-e1', from: 'ingress-ml', to: 'service-inference', type: 'http', latencyBudgetMs: 120, networkPolicy: 'allow' },
        { id: 'ml-e2', from: 'service-inference', to: 'queue-features', type: 'async', latencyBudgetMs: 350, networkPolicy: 'allow' },
        { id: 'ml-e3', from: 'worker-training', to: 'queue-features', type: 'async', latencyBudgetMs: 500, networkPolicy: 'allow' },
        { id: 'ml-e4', from: 'service-inference', to: 'cache-features', type: 'data', latencyBudgetMs: 20, networkPolicy: 'allow' },
      ],
      {
        'ingress-ml': { x: 80, y: 120 },
        'service-inference': { x: 360, y: 120 },
        'queue-features': { x: 640, y: 120 },
        'worker-training': { x: 640, y: 310 },
        'cache-features': { x: 920, y: 120 },
      },
    ),
  ),
];

let sequence = 0;

export function createNodeTemplate(type: NodeType, defaultNamespace = 'visual-kubernetes'): ArchitectureNode {
  sequence += 1;
  const labelBase =
    type === 'frontend'
      ? 'Frontend'
      : type === 'gateway'
        ? 'Gateway'
        : type === 'service'
          ? 'Service'
          : type === 'worker'
            ? 'Worker'
            : type === 'job'
              ? 'Job'
            : type === 'cronjob'
              ? 'CronJob'
              : type === 'networkPolicy'
                ? 'NetworkPolicy'
                : type === 'role'
                  ? 'Role'
            : type === 'database'
              ? 'Database'
              : type === 'cache'
                ? 'Cache'
                : type === 'queue'
                  ? 'Queue'
                  : 'Ingress';
  return createNode(`${type}-${sequence}`, `${labelBase} ${sequence}`, type, {
    namespace: defaultNamespace,
    environmentOverrides: {
      dev: {
        replicas: 1,
        tag: type === 'ingress' ? 'dev' : 'latest-dev',
      },
      stage: {
        replicas: type === 'database' || type === 'queue' || type === 'cache' || type === 'job' || type === 'cronjob' ? 1 : 2,
        tag: type === 'ingress' ? 'stage' : 'latest-rc',
      },
    },
  });
}
