import { starterWorkspace } from './data';
import type {
  ArchitectureEdge,
  ArchitectureNode,
  AutoscalingConfig,
  IngressConfig,
  ProbeConfig,
  ResourceConfig,
  WorkloadConfig,
  SecurityConfig,
  ServiceConfig,
  StorageConfig,
  NetworkPolicyConfig,
  RoleConfig,
  WorkspaceState,
  Cluster,
  GraphTemplate,
  NodeLibraryItem,
  WorkspaceSnapshot,
} from './types';

export const WORKSPACE_STORAGE_KEY = 'visual-kubernetes/workspace';
export const NODE_LIBRARY_STORAGE_KEY = 'visual-kubernetes/node-library/custom';
export const GRAPH_TEMPLATE_STORAGE_KEY = 'visual-kubernetes/templates/custom';
export const SNAPSHOT_STORAGE_KEY = 'visual-kubernetes/snapshots/fallback';
const SNAPSHOT_DB_NAME = 'visual-kubernetes';
const SNAPSHOT_STORE_NAME = 'snapshots';

function defaultProbeForNode(node: ArchitectureNode, label: 'readiness' | 'liveness' | 'startup', port: number): ProbeConfig {
  const probeType = node.type === 'database' || node.type === 'queue' || node.type === 'cache' ? 'tcp' : 'http';
  const path = label === 'liveness' ? '/health' : '/ready';
  return {
    enabled: label === 'startup' ? node.type !== 'job' && node.type !== 'cronjob' : true,
    type: probeType,
    path,
    port,
    command: '',
    initialDelaySeconds: label === 'startup' ? 20 : 10,
    periodSeconds: label === 'startup' ? 5 : 10,
    failureThreshold: label === 'startup' ? 30 : 3,
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
    enabled: ['service', 'frontend', 'gateway'].includes(node.type),
    minReplicas: 2,
    maxReplicas: 6,
    targetCPUUtilizationPercentage: 70,
  };
}

function defaultWorkload(node: ArchitectureNode): WorkloadConfig {
  const kind =
    node.type === 'database' || node.type === 'queue' || node.type === 'cache'
      ? 'StatefulSet'
      : node.type === 'job'
        ? 'Job'
      : node.type === 'cronjob'
        ? 'CronJob'
        : 'Deployment';

  return {
    kind,
    schedule: '*/15 * * * *',
    completions: 1,
    parallelism: 1,
    backoffLimit: 3,
    restartPolicy: kind === 'Job' || kind === 'CronJob' ? 'OnFailure' : 'Always',
    command: [],
    args: [],
    terminationGracePeriodSeconds: node.type === 'database' || node.type === 'queue' ? 60 : kind === 'Job' || kind === 'CronJob' ? 30 : 45,
  };
}

function defaultNetworkPolicy(node: ArchitectureNode): NetworkPolicyConfig {
  return {
    targetLabels: [{ key: 'app', value: node.type === 'networkPolicy' ? 'replace-me' : '' }],
    ingressFromLabels: [],
    egressToCidrs: [],
    allowIngress: true,
    allowEgress: false,
  };
}

function defaultRole(node: ArchitectureNode): RoleConfig {
  return {
    serviceAccounts: node.type === 'role' ? [node.serviceAccountName ?? `${node.id}-sa`] : [],
    rules: [{ apiGroups: [''], resources: ['configmaps'], verbs: ['get', 'list', 'watch'] }],
  };
}

function defaultStorage(node: ArchitectureNode): StorageConfig {
  return {
    enabled: node.type === 'database' || node.type === 'queue' || node.type === 'cache',
    size: node.type === 'database' ? '20Gi' : node.type === 'queue' ? '8Gi' : node.type === 'cache' ? '4Gi' : '5Gi',
    storageClassName: 'standard',
    accessMode: 'ReadWriteOnce',
    volumeMode: 'Filesystem',
    mountPath:
      node.type === 'database'
        ? '/var/lib/postgresql/data'
        : node.type === 'queue'
          ? '/var/lib/rabbitmq'
          : '/data',
    retainOnDelete: node.type === 'database' || node.type === 'queue' ? 'Retain' : 'Delete',
    retainOnScaleDown: node.type === 'database' || node.type === 'queue' ? 'Retain' : 'Delete',
    backupEnabled: node.type === 'database' || node.type === 'queue',
    backupSchedule: '0 2 * * *',
  };
}

function defaultService(node: ArchitectureNode): ServiceConfig {
  return {
    type: 'ClusterIP',
    port: node.type === 'database' ? 5432 : node.type === 'queue' ? 5672 : node.type === 'cache' ? 6379 : 80,
    exposure: node.type === 'ingress' ? 'external' : 'internal',
    loadBalancerScope: node.type === 'ingress' ? 'public' : 'private',
    externalTrafficPolicy: 'Cluster',
  };
}

function defaultIngress(node: ArchitectureNode): IngressConfig {
  return {
    enabled: node.type === 'ingress',
    host: `${node.id}.example.internal`,
    path: '/',
    tlsEnabled: false,
    tlsSecretName: `${node.id}-tls`,
    tlsIssuer: '',
    ingressClassName: 'nginx',
    exposure: node.type === 'ingress' ? 'external' : 'internal',
    loadBalancerScope: node.type === 'ingress' ? 'public' : 'private',
  };
}

function defaultSecurity(node: ArchitectureNode): SecurityConfig {
  return {
    runAsNonRoot: node.type !== 'database' && node.type !== 'queue',
    runAsUser: node.type === 'database' || node.type === 'queue' ? 999 : 1000,
    readOnlyRootFilesystem: node.type !== 'database' && node.type !== 'queue' && node.type !== 'cache',
    allowPrivilegeEscalation: false,
    seccompProfile: 'RuntimeDefault',
  };
}

function hydrateSecretEnv(node: ArchitectureNode): ArchitectureNode['secretEnv'] {
  return (node.secretEnv ?? []).map((entry: ArchitectureNode['secretEnv'][number] | { key: string; value: string }) => {
    if ('source' in entry) {
      return entry;
    }
    return {
      source: 'inline' as const,
      key: entry.key,
      value: entry.value,
    };
  });
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
    secretEnv: hydrateSecretEnv(node),
    resources: node.resources ?? defaultResources(),
    readinessProbe: { ...defaultProbeForNode(node, 'readiness', port), ...node.readinessProbe },
    livenessProbe: { ...defaultProbeForNode(node, 'liveness', port), ...node.livenessProbe },
    startupProbe: { ...defaultProbeForNode(node, 'startup', port), ...node.startupProbe },
    autoscaling: node.autoscaling ?? defaultAutoscaling(node),
    workload: { ...defaultWorkload(node), ...node.workload },
    storage: { ...defaultStorage(node), ...node.storage },
    service: { ...defaultService(node), ...node.service },
    serviceAccountName: node.serviceAccountName ?? `${node.id}-sa`,
    imagePullSecrets: node.imagePullSecrets ?? [],
    security: node.security ?? defaultSecurity(node),
    networkPolicy: { ...defaultNetworkPolicy(node), ...node.networkPolicy },
    role: { ...defaultRole(node), ...node.role },
    ingress: { ...defaultIngress(node), ...node.ingress },
    environmentOverrides: node.environmentOverrides ?? {},
  };
}

function hydrateEdge(edge: ArchitectureEdge): ArchitectureEdge {
  return {
    ...edge,
    networkPolicy: edge.networkPolicy ?? 'allow',
  };
}

function hydrateClusters(parsed: WorkspaceState): Cluster[] {
  const nodes = parsed.model.nodes ?? [];
  if (parsed.model.clusters?.length) {
    const nodeIds = new Set(nodes.map((node) => node.id));
    return parsed.model.clusters.map((cluster) => ({
      id: cluster.id,
      name: cluster.name || 'Primary Cluster',
      provider: cluster.provider ?? parsed.model.provider ?? 'generic',
      region: cluster.region || 'us-east-1',
      workerCount: Math.max(1, cluster.workerCount ?? 3),
      nodeIds: (cluster.nodeIds ?? []).filter((nodeId) => nodeIds.has(nodeId)),
    }));
  }

  return [
    {
      id: 'cluster-primary',
      name: 'Primary Cluster',
      provider: parsed.model.provider ?? 'generic',
      region: parsed.model.provider === 'azure' ? 'eastus' : parsed.model.provider === 'gcp' ? 'us-central1' : 'us-east-1',
      workerCount: 3,
      nodeIds: nodes.map((node) => node.id),
    },
  ];
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
        activeEnvironment: parsed.model.activeEnvironment ?? 'prod',
        clusters: hydrateClusters(parsed),
        nodes: parsed.model.nodes.map((node) => hydrateNode(node as ArchitectureNode, defaultNamespace)),
        edges: parsed.model.edges.map((edge) => hydrateEdge(edge as ArchitectureEdge)),
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

export function loadCustomNodeLibrary(): NodeLibraryItem[] {
  if (typeof window === 'undefined') {
    return [];
  }

  const raw = window.localStorage.getItem(NODE_LIBRARY_STORAGE_KEY);
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as NodeLibraryItem[];
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((item) => item.id && item.type && item.name);
  } catch {
    return [];
  }
}

export function saveCustomNodeLibrary(items: NodeLibraryItem[]) {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.setItem(NODE_LIBRARY_STORAGE_KEY, JSON.stringify(items));
}

export function loadCustomGraphTemplates(): GraphTemplate[] {
  if (typeof window === 'undefined') {
    return [];
  }

  const raw = window.localStorage.getItem(GRAPH_TEMPLATE_STORAGE_KEY);
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as GraphTemplate[];
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((template) => template.id && template.name && template.workspace?.model?.nodes && template.workspace?.layout);
  } catch {
    return [];
  }
}

export function saveCustomGraphTemplates(templates: GraphTemplate[]) {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.setItem(GRAPH_TEMPLATE_STORAGE_KEY, JSON.stringify(templates));
}

function loadSnapshotFallback(): WorkspaceSnapshot[] {
  if (typeof window === 'undefined') {
    return [];
  }

  try {
    const parsed = JSON.parse(window.localStorage.getItem(SNAPSHOT_STORAGE_KEY) ?? '[]') as WorkspaceSnapshot[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveSnapshotFallback(snapshots: WorkspaceSnapshot[]) {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.setItem(SNAPSHOT_STORAGE_KEY, JSON.stringify(snapshots));
}

function openSnapshotDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not available.'));
      return;
    }

    const request = indexedDB.open(SNAPSHOT_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SNAPSHOT_STORE_NAME)) {
        db.createObjectStore(SNAPSHOT_STORE_NAME, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open snapshot database.'));
  });
}

async function withSnapshotStore<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openSnapshotDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(SNAPSHOT_STORE_NAME, mode);
    const request = operation(transaction.objectStore(SNAPSHOT_STORE_NAME));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Snapshot operation failed.'));
    transaction.oncomplete = () => db.close();
    transaction.onerror = () => {
      db.close();
      reject(transaction.error ?? new Error('Snapshot transaction failed.'));
    };
  });
}

export async function loadSnapshots(): Promise<WorkspaceSnapshot[]> {
  try {
    const snapshots = await withSnapshotStore<WorkspaceSnapshot[]>('readonly', (store) => store.getAll() as IDBRequest<WorkspaceSnapshot[]>);
    return snapshots.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } catch {
    return loadSnapshotFallback().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}

export async function saveSnapshot(snapshot: WorkspaceSnapshot): Promise<WorkspaceSnapshot[]> {
  const fallbackSnapshots = [snapshot, ...loadSnapshotFallback().filter((entry) => entry.id !== snapshot.id)].slice(0, 50);
  saveSnapshotFallback(fallbackSnapshots);

  try {
    await withSnapshotStore('readwrite', (store) => store.put(snapshot));
    return loadSnapshots();
  } catch {
    return fallbackSnapshots;
  }
}

export async function deleteSnapshot(snapshotId: string): Promise<WorkspaceSnapshot[]> {
  const fallbackSnapshots = loadSnapshotFallback().filter((snapshot) => snapshot.id !== snapshotId);
  saveSnapshotFallback(fallbackSnapshots);

  try {
    await withSnapshotStore('readwrite', (store) => store.delete(snapshotId));
    return loadSnapshots();
  } catch {
    return fallbackSnapshots;
  }
}
