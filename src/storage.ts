import { starterWorkspace } from './data';
import type {
  ArchitectureNode,
  AutoscalingConfig,
  IngressConfig,
  ProbeConfig,
  ResourceConfig,
  ServiceConfig,
  StorageConfig,
  WorkspaceState,
} from './types';

export const WORKSPACE_STORAGE_KEY = 'visual-kubernetes/workspace';

function defaultProbe(port: number): ProbeConfig {
  return {
    enabled: true,
    path: '/health',
    port,
    initialDelaySeconds: 10,
    periodSeconds: 10,
  };
}

function defaultResources(): ResourceConfig {
  return {
    requestsCpu: '250m',
    requestsMemory: '256Mi',
    limitsCpu: '1000m',
    limitsMemory: '1Gi',
  };
}

function defaultAutoscaling(node: ArchitectureNode): AutoscalingConfig {
  return {
    enabled: ['service', 'frontend', 'gateway', 'worker'].includes(node.type),
    minReplicas: 2,
    maxReplicas: 6,
    targetCPUUtilizationPercentage: 70,
  };
}

function defaultStorage(node: ArchitectureNode): StorageConfig {
  return {
    enabled: node.type === 'database' || node.type === 'queue' || node.type === 'cache',
    size: node.type === 'database' ? '20Gi' : node.type === 'queue' ? '8Gi' : node.type === 'cache' ? '4Gi' : '5Gi',
    storageClassName: 'standard',
    mountPath:
      node.type === 'database'
        ? '/var/lib/postgresql/data'
        : node.type === 'queue'
          ? '/var/lib/rabbitmq'
          : '/data',
  };
}

function defaultService(node: ArchitectureNode): ServiceConfig {
  return {
    type: 'ClusterIP',
    port: node.type === 'database' ? 5432 : node.type === 'queue' ? 5672 : node.type === 'cache' ? 6379 : 80,
  };
}

function defaultIngress(node: ArchitectureNode): IngressConfig {
  return {
    enabled: node.type === 'ingress',
    host: `${node.id}.example.internal`,
    path: '/',
    tlsEnabled: false,
    tlsSecretName: `${node.id}-tls`,
    ingressClassName: 'nginx',
  };
}

function hydrateNode(node: ArchitectureNode, defaultNamespace: string): ArchitectureNode {
  const port =
    node.containerPort ?? (node.type === 'database' ? 5432 : node.type === 'queue' ? 5672 : node.type === 'cache' ? 6379 : node.type === 'ingress' ? 80 : 8080);

  return {
    ...node,
    namespace: node.namespace ?? defaultNamespace,
    image: node.image ?? 'ghcr.io/visual-kubernetes/service',
    tag: node.tag ?? 'latest',
    containerPort: port,
    env: node.env ?? [],
    secretEnv: node.secretEnv ?? [],
    resources: node.resources ?? defaultResources(),
    readinessProbe: node.readinessProbe ?? defaultProbe(port),
    livenessProbe: node.livenessProbe ?? defaultProbe(port),
    autoscaling: node.autoscaling ?? defaultAutoscaling(node),
    storage: node.storage ?? defaultStorage(node),
    service: node.service ?? defaultService(node),
    serviceAccountName: node.serviceAccountName ?? `${node.id}-sa`,
    ingress: node.ingress ?? defaultIngress(node),
  };
}

export function loadWorkspace(): WorkspaceState {
  if (typeof window === 'undefined') {
    return starterWorkspace;
  }

  const raw = window.localStorage.getItem(WORKSPACE_STORAGE_KEY);
  if (!raw) {
    return starterWorkspace;
  }

  try {
    const parsed = JSON.parse(raw) as WorkspaceState;
    if (!parsed?.model?.nodes || !parsed?.model?.edges || !parsed?.layout) {
      return starterWorkspace;
    }

    const defaultNamespace = parsed.model.defaultNamespace ?? 'visual-kubernetes';
    return {
      ...parsed,
      model: {
        ...parsed.model,
        defaultNamespace,
        provider: parsed.model.provider ?? 'generic',
        nodes: parsed.model.nodes.map((node) => hydrateNode(node as ArchitectureNode, defaultNamespace)),
      },
    };
  } catch {
    return starterWorkspace;
  }
}

export function saveWorkspace(workspace: WorkspaceState) {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(workspace));
}
