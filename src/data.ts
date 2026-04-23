import type {
  ArchitectureEdge,
  ArchitectureModel,
  ArchitectureNode,
  CanvasLayout,
  EnvironmentName,
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
  if (type === 'job' || type === 'cronjob') {
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
