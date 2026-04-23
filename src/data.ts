import type { ArchitectureEdge, ArchitectureModel, ArchitectureNode, CanvasLayout, NodeType, WorkspaceState } from './types';

export const availableNodeTypes: Array<{ type: NodeType; label: string; description: string }> = [
  { type: 'frontend', label: 'Frontend', description: 'Browser-facing web app' },
  { type: 'gateway', label: 'Gateway', description: 'API gateway or edge service' },
  { type: 'service', label: 'Service', description: 'Core application workload' },
  { type: 'worker', label: 'Worker', description: 'Background processor or job consumer' },
  { type: 'queue', label: 'Queue', description: 'Message broker or stream entry' },
  { type: 'cache', label: 'Cache', description: 'Low-latency in-memory store' },
  { type: 'database', label: 'Database', description: 'Persistent stateful storage' },
  { type: 'ingress', label: 'Ingress', description: 'External traffic entrypoint' },
];

function baseProbe(path: string, port: number) {
  return {
    enabled: true,
    path,
    port,
    initialDelaySeconds: 10,
    periodSeconds: 10,
  };
}

function createNode(id: string, name: string, type: NodeType, overrides: Partial<ArchitectureNode> = {}): ArchitectureNode {
  const defaultNamespace = 'checkout-platform';
  const defaultPort =
    type === 'database' ? 5432 : type === 'queue' ? 5672 : type === 'cache' ? 6379 : type === 'ingress' ? 80 : 8080;
  const defaultServicePort = type === 'database' ? 5432 : type === 'queue' ? 5672 : type === 'cache' ? 6379 : 80;
  const defaultStorageEnabled = type === 'database' || type === 'queue' || type === 'cache';

  return {
    id,
    name,
    type,
    namespace: defaultNamespace,
    replicas: type === 'database' ? 1 : 2,
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
    readinessProbe: baseProbe('/ready', defaultPort),
    livenessProbe: baseProbe('/health', defaultPort),
    autoscaling: {
      enabled: type === 'service' || type === 'frontend' || type === 'gateway' || type === 'worker',
      minReplicas: 2,
      maxReplicas: 6,
      targetCPUUtilizationPercentage: 70,
    },
    storage: {
      enabled: defaultStorageEnabled,
      size: type === 'database' ? '20Gi' : type === 'queue' ? '8Gi' : type === 'cache' ? '4Gi' : '5Gi',
      storageClassName: 'standard',
      mountPath:
        type === 'database'
          ? '/var/lib/postgresql/data'
          : type === 'queue'
            ? '/var/lib/rabbitmq'
            : '/data',
    },
    service: {
      type: 'ClusterIP',
      port: defaultServicePort,
    },
    serviceAccountName: `${id}-sa`,
    ingress: {
      enabled: type === 'ingress',
      host: `${id}.example.internal`,
      path: '/',
      tlsEnabled: false,
      tlsSecretName: `${id}-tls`,
      ingressClassName: 'nginx',
    },
    ...overrides,
  };
}

export const starterNodes: ArchitectureNode[] = [
  createNode('ingress-web', 'Public API', 'ingress', {
    service: { type: 'LoadBalancer', port: 80 },
    ingress: {
      enabled: true,
      host: 'api.checkout.internal',
      path: '/',
      tlsEnabled: true,
      tlsSecretName: 'checkout-api-tls',
      ingressClassName: 'nginx',
    },
  }),
  createNode('service-checkout', 'Checkout Service', 'service', {
    replicas: 3,
    cpu: 2,
    memory: 4,
    sla: 'critical',
    image: 'ghcr.io/visual-kubernetes/checkout-service',
    tag: '1.0.0',
    containerPort: 8080,
    env: [
      { key: 'SPRING_PROFILES_ACTIVE', value: 'prod' },
      { key: 'DATABASE_HOST', value: 'orders-db.data' },
    ],
    secretEnv: [
      { key: 'DATABASE_PASSWORD', value: 'change-me' },
      { key: 'JWT_SECRET', value: 'replace-me' },
    ],
  }),
  createNode('service-inventory', 'Inventory Service', 'service', {
    namespace: 'inventory',
    image: 'ghcr.io/visual-kubernetes/inventory-service',
    tag: '1.0.0',
    env: [{ key: 'QUEUE_HOST', value: 'domain-events.platform' }],
    secretEnv: [{ key: 'QUEUE_PASSWORD', value: 'change-me' }],
  }),
  createNode('queue-events', 'Domain Events', 'queue', {
    namespace: 'platform',
    image: 'rabbitmq',
    tag: '3-management',
    containerPort: 5672,
    service: { type: 'ClusterIP', port: 5672 },
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
      mountPath: '/var/lib/rabbitmq',
    },
    secretEnv: [{ key: 'RABBITMQ_DEFAULT_PASS', value: 'change-me' }],
  }),
  createNode('db-orders', 'Orders DB', 'database', {
    namespace: 'data',
    image: 'postgres',
    tag: '16',
    containerPort: 5432,
    service: { type: 'ClusterIP', port: 5432 },
    env: [{ key: 'POSTGRES_DB', value: 'orders' }],
    secretEnv: [
      { key: 'POSTGRES_USER', value: 'orders_app' },
      { key: 'POSTGRES_PASSWORD', value: 'change-me' },
    ],
    readinessProbe: {
      enabled: true,
      path: '/ready',
      port: 5432,
      initialDelaySeconds: 20,
      periodSeconds: 10,
    },
    livenessProbe: {
      enabled: true,
      path: '/live',
      port: 5432,
      initialDelaySeconds: 30,
      periodSeconds: 15,
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
      mountPath: '/var/lib/postgresql/data',
    },
  }),
];

export const starterEdges: ArchitectureEdge[] = [
  { id: 'e1', from: 'ingress-web', to: 'service-checkout', type: 'http', latencyBudgetMs: 150 },
  { id: 'e2', from: 'service-checkout', to: 'service-inventory', type: 'http', latencyBudgetMs: 200 },
  { id: 'e3', from: 'service-checkout', to: 'queue-events', type: 'async', latencyBudgetMs: 500 },
  { id: 'e4', from: 'service-checkout', to: 'db-orders', type: 'data', latencyBudgetMs: 40 },
];

export const starterArchitecture: ArchitectureModel = {
  name: 'Checkout Platform',
  defaultNamespace: 'checkout-platform',
  provider: 'aws',
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
            : type === 'database'
              ? 'Database'
              : type === 'cache'
                ? 'Cache'
                : type === 'queue'
                  ? 'Queue'
                  : 'Ingress';
  return createNode(`${type}-${sequence}`, `${labelBase} ${sequence}`, type, { namespace: defaultNamespace });
}
