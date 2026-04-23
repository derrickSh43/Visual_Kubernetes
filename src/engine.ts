import type {
  ArchitectureModel,
  ArchitectureNode,
  CloudProvider,
  DeploymentPlan,
  EdgeType,
  EnvironmentVariable,
  EnvironmentName,
  ExportDocument,
  PatternType,
  ResourceConfig,
  ValidationIssue,
} from './types';

type ConnectionDecision =
  | { allowed: true; edgeType: EdgeType }
  | { allowed: false; reason: string };

const baseCostByType: Record<ArchitectureNode['type'], number> = {
  ingress: 75,
  frontend: 150,
  gateway: 170,
  service: 180,
  worker: 155,
  database: 320,
  cache: 190,
  queue: 110,
  job: 90,
  cronjob: 95,
};

const defaultStorageClasses = ['standard', 'gp3', 'standard-rwo', 'managed-csi'];
const defaultIngressClasses = ['nginx', 'alb', 'gce', 'azure/application-gateway'];

const providerProfiles: Record<
  CloudProvider,
  {
    storageClassName: string;
    ingressClassName: string;
    loadBalancerMode: string;
    readmeNotes: string[];
  }
> = {
  aws: {
    storageClassName: 'gp3',
    ingressClassName: 'alb',
    loadBalancerMode: 'AWS NLB for LoadBalancer services and AWS ALB for Ingress resources.',
    readmeNotes: [
      'AWS defaults target EKS-style clusters.',
      'Persistent storage defaults to the gp3 storage class.',
      'Ingress defaults to the alb ingress class and AWS Load Balancer Controller annotations.',
    ],
  },
  gcp: {
    storageClassName: 'standard-rwo',
    ingressClassName: 'gce',
    loadBalancerMode: 'GCP external load balancers and GCE ingress.',
    readmeNotes: [
      'GCP defaults target GKE-style clusters.',
      'Persistent storage defaults to the standard-rwo storage class.',
      'Ingress defaults to the gce ingress class.',
    ],
  },
  azure: {
    storageClassName: 'managed-csi',
    ingressClassName: 'azure/application-gateway',
    loadBalancerMode: 'Azure Load Balancer services and Application Gateway ingress.',
    readmeNotes: [
      'Azure defaults target AKS-style clusters.',
      'Persistent storage defaults to the managed-csi storage class.',
      'Ingress defaults to the azure/application-gateway ingress class.',
    ],
  },
  generic: {
    storageClassName: 'standard',
    ingressClassName: 'nginx',
    loadBalancerMode: 'Generic Kubernetes LoadBalancer services and nginx ingress.',
    readmeNotes: [
      'Generic defaults assume a standard Kubernetes cluster.',
      'Persistent storage defaults to the standard storage class.',
      'Ingress defaults to the nginx ingress class.',
    ],
  },
};

function getNode(model: ArchitectureModel, nodeId: string) {
  return model.nodes.find((node) => node.id === nodeId);
}

function countNodeType(model: ArchitectureModel, type: ArchitectureNode['type']) {
  return model.nodes.filter((node) => node.type === type).length;
}

function sanitizeName(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function fileSafeName(name: string) {
  return sanitizeName(name) || 'resource';
}

function documentNamespace(document: ExportDocument) {
  if (document.kind === 'Namespace') {
    return fileSafeName(document.name);
  }
  const namespaceMatch = document.yaml.match(/\n\s{2}namespace: ([^\n]+)/);
  return fileSafeName(namespaceMatch?.[1] ?? 'cluster');
}

function isDefaultishTag(tag: string) {
  return ['latest', 'dev', 'stage', 'latest-dev', 'latest-rc'].includes(tag.trim().toLowerCase());
}

function parseStorageGi(size: string) {
  const match = size.trim().match(/^(\d+(?:\.\d+)?)(Mi|Gi|Ti)$/i);
  if (!match) {
    return undefined;
  }
  const value = Number(match[1]);
  const unit = match[2].toLowerCase();
  if (unit === 'mi') return value / 1024;
  if (unit === 'ti') return value * 1024;
  return value;
}

function namespaceValue(namespace: string) {
  return sanitizeName(namespace) || 'default';
}

function hasOverrideValue(node: ArchitectureNode, environment: EnvironmentName) {
  const override = node.environmentOverrides?.[environment];
  return Boolean(
    override &&
      (override.replicas !== undefined ||
        override.tag !== undefined ||
        override.resources !== undefined ||
        override.autoscaling !== undefined ||
        override.ingress !== undefined),
  );
}

function indent(lines: string[], spaces: number) {
  const prefix = ' '.repeat(spaces);
  return lines.map((line) => `${prefix}${line}`);
}

function httpProbeLines(label: string, path: string, port: number, initialDelaySeconds: number, periodSeconds: number, failureThreshold: number) {
  return [
    `${label}:`,
    '  httpGet:',
    `    path: ${path}`,
    `    port: ${port}`,
    `  initialDelaySeconds: ${initialDelaySeconds}`,
    `  periodSeconds: ${periodSeconds}`,
    `  failureThreshold: ${failureThreshold}`,
  ];
}

function tcpProbeLines(label: string, port: number, initialDelaySeconds: number, periodSeconds: number, failureThreshold: number) {
  return [
    `${label}:`,
    '  tcpSocket:',
    `    port: ${port}`,
    `  initialDelaySeconds: ${initialDelaySeconds}`,
    `  periodSeconds: ${periodSeconds}`,
    `  failureThreshold: ${failureThreshold}`,
  ];
}

function execProbeLines(label: string, command: string, initialDelaySeconds: number, periodSeconds: number, failureThreshold: number) {
  const commandParts = command.split(/\s+/).filter(Boolean);
  return [
    `${label}:`,
    '  exec:',
    '    command:',
    ...(commandParts.length > 0 ? commandParts.map((part) => `      - ${part}`) : ['      - /bin/sh', '      - -c', '      - "true"']),
    `  initialDelaySeconds: ${initialDelaySeconds}`,
    `  periodSeconds: ${periodSeconds}`,
    `  failureThreshold: ${failureThreshold}`,
  ];
}

function probeLinesForNode(node: ArchitectureNode, label: 'readinessProbe' | 'livenessProbe' | 'startupProbe') {
  const probe = label === 'readinessProbe' ? node.readinessProbe : label === 'livenessProbe' ? node.livenessProbe : node.startupProbe;
  if (!probe.enabled) {
    return [];
  }

  if (probe.type === 'exec') {
    return execProbeLines(label, probe.command, probe.initialDelaySeconds, probe.periodSeconds, probe.failureThreshold);
  }

  if (probe.type === 'tcp') {
    return tcpProbeLines(label, probe.port, probe.initialDelaySeconds, probe.periodSeconds, probe.failureThreshold);
  }

  return httpProbeLines(label, probe.path, probe.port, probe.initialDelaySeconds, probe.periodSeconds, probe.failureThreshold);
}

function envSecretName(node: ArchitectureNode) {
  return `${sanitizeName(node.name)}-secret`;
}

function envConfigMapName(node: ArchitectureNode) {
  return `${sanitizeName(node.name)}-config`;
}

function roleName(node: ArchitectureNode) {
  return `${sanitizeName(node.name)}-runtime`;
}

function inlineSecretEntries(node: ArchitectureNode) {
  return node.secretEnv.filter((entry) => entry.source === 'inline');
}

function referencedSecretEntries(node: ArchitectureNode) {
  return node.secretEnv.filter((entry) => entry.source === 'existingSecret');
}

function workloadKindForNode(node: ArchitectureNode) {
  return node.workload?.kind ?? (node.type === 'database' || node.type === 'queue' || node.type === 'cache' ? 'StatefulSet' : 'Deployment');
}

function shouldEmitService(node: ArchitectureNode) {
  return !['worker', 'job', 'cronjob'].includes(node.type);
}

function shouldEmitHpa(node: ArchitectureNode) {
  return node.autoscaling.enabled && workloadKindForNode(node) === 'Deployment';
}

function shouldUseVolumeClaimTemplate(node: ArchitectureNode) {
  return node.storage.enabled && workloadKindForNode(node) === 'StatefulSet';
}

function workloadApiVersion(kind: string) {
  return kind === 'Job' || kind === 'CronJob' ? 'batch/v1' : 'apps/v1';
}

function storageAnnotations(node: ArchitectureNode) {
  if (!node.storage.backupEnabled) {
    return [];
  }

  return [
    '  annotations:',
    '    visual-kubernetes.io/backup-enabled: "true"',
    `    visual-kubernetes.io/backup-schedule: "${node.storage.backupSchedule}"`,
  ];
}

function storageSpecLines(node: ArchitectureNode, spaces: number) {
  return indent(
    [
      'accessModes:',
      `  - ${node.storage.accessMode}`,
      `volumeMode: ${node.storage.volumeMode}`,
      `storageClassName: ${node.storage.storageClassName}`,
      'resources:',
      '  requests:',
      `    storage: ${node.storage.size}`,
    ],
    spaces,
  );
}

function providerLoadBalancerAnnotation(provider: CloudProvider, node: ArchitectureNode) {
  const isPrivate = node.service.loadBalancerScope === 'private';
  if (provider === 'aws') {
    return [
      '  annotations:',
      '    service.beta.kubernetes.io/aws-load-balancer-type: "nlb"',
      `    service.beta.kubernetes.io/aws-load-balancer-scheme: "${isPrivate ? 'internal' : 'internet-facing'}"`,
    ];
  }
  if (provider === 'gcp') {
    return [
      '  annotations:',
      `    cloud.google.com/load-balancer-type: "${isPrivate ? 'Internal' : 'External'}"`,
      `    networking.gke.io/load-balancer-type: "${isPrivate ? 'Internal' : 'External'}"`,
    ];
  }
  if (provider === 'azure') {
    return [
      '  annotations:',
      '    service.beta.kubernetes.io/azure-load-balancer-resource-group: "replace-me"',
      `    service.beta.kubernetes.io/azure-load-balancer-internal: "${isPrivate}"`,
    ];
  }
  return [];
}

function providerIngressAnnotations(provider: CloudProvider, node: ArchitectureNode) {
  const annotations: string[] = [];
  const isPrivate = node.ingress.loadBalancerScope === 'private';

  if (provider === 'aws') {
    annotations.push('    kubernetes.io/ingress.class: "alb"', `    alb.ingress.kubernetes.io/scheme: "${isPrivate ? 'internal' : 'internet-facing'}"`);
  } else if (provider === 'gcp') {
    annotations.push('    kubernetes.io/ingress.class: "gce"');
    if (isPrivate) {
      annotations.push('    networking.gke.io/internal-load-balancer: "true"');
    }
  } else if (provider === 'azure') {
    annotations.push('    kubernetes.io/ingress.class: "azure/application-gateway"');
    if (isPrivate) {
      annotations.push('    appgw.ingress.kubernetes.io/use-private-ip: "true"');
    }
  }

  if (node.ingress.tlsEnabled && node.ingress.tlsIssuer.trim()) {
    annotations.push(`    cert-manager.io/cluster-issuer: "${node.ingress.tlsIssuer}"`);
  }

  if (annotations.length === 0) {
    return [];
  }

  return ['  annotations:', ...annotations];
}

function envKeyBase(name: string) {
  return sanitizeName(name).toUpperCase().replace(/-/g, '_');
}

function qualifiedServiceHost(fromNode: ArchitectureNode, toNode: ArchitectureNode) {
  const serviceName = sanitizeName(toNode.name);
  const targetNamespace = sanitizeName(toNode.namespace) || 'default';
  const fromNamespace = sanitizeName(fromNode.namespace) || 'default';
  return fromNamespace === targetNamespace ? serviceName : `${serviceName}.${targetNamespace}.svc.cluster.local`;
}

function deriveEdgeEnvironmentVariables(fromNode: ArchitectureNode, toNode: ArchitectureNode, edgeType: EdgeType): EnvironmentVariable[] {
  const keyBase = envKeyBase(toNode.name);
  const host = qualifiedServiceHost(fromNode, toNode);

  if (edgeType === 'http') {
    return [
      { key: `${keyBase}_SERVICE_HOST`, value: host },
      { key: `${keyBase}_SERVICE_PORT`, value: String(toNode.service.port) },
      { key: `${keyBase}_SERVICE_URL`, value: `http://${host}:${toNode.service.port}` },
    ];
  }

  if (edgeType === 'async') {
    return [
      { key: `${keyBase}_QUEUE_HOST`, value: host },
      { key: `${keyBase}_QUEUE_PORT`, value: String(toNode.service.port) },
      { key: `${keyBase}_QUEUE_URL`, value: `amqp://${host}:${toNode.service.port}` },
    ];
  }

  const kindSuffix = toNode.type === 'cache' ? 'CACHE' : 'DATABASE';
  return [
    { key: `${keyBase}_${kindSuffix}_HOST`, value: host },
    { key: `${keyBase}_${kindSuffix}_PORT`, value: String(toNode.service.port) },
  ];
}

function mergeEnvironmentVariables(derived: EnvironmentVariable[], manual: EnvironmentVariable[]) {
  const merged = new Map<string, EnvironmentVariable>();
  for (const entry of derived) {
    merged.set(entry.key, entry);
  }
  for (const entry of manual) {
    merged.set(entry.key, entry);
  }
  return [...merged.values()];
}

export function getDerivedEnvironmentVariables(model: ArchitectureModel, nodeId: string): EnvironmentVariable[] {
  const resolvedModel = getResolvedModel(model);
  const fromNode = getNode(resolvedModel, nodeId);
  if (!fromNode) {
    return [];
  }

  return resolvedModel.edges.flatMap((edge) => {
    if (edge.from !== nodeId || edge.networkPolicy === 'deny') {
      return [];
    }
    const toNode = getNode(resolvedModel, edge.to);
    if (!toNode) {
      return [];
    }
    return deriveEdgeEnvironmentVariables(fromNode, toNode, edge.type);
  });
}

export function getMergedEnvironmentVariables(model: ArchitectureModel, nodeId: string): EnvironmentVariable[] {
  const resolvedModel = getResolvedModel(model);
  const node = getNode(resolvedModel, nodeId);
  if (!node) {
    return [];
  }

  return mergeEnvironmentVariables(getDerivedEnvironmentVariables(model, nodeId), node.env);
}

function mergeResources(base: ResourceConfig, override?: Partial<ResourceConfig>) {
  return override ? { ...base, ...override } : base;
}

export function resolveNodeForEnvironment(node: ArchitectureNode, environment: EnvironmentName): ArchitectureNode {
  const override = node.environmentOverrides?.[environment];
  if (!override) {
    return node;
  }

  return {
    ...node,
    replicas: override.replicas ?? node.replicas,
    tag: override.tag ?? node.tag,
    resources: mergeResources(node.resources, override.resources),
    autoscaling: override.autoscaling ? { ...node.autoscaling, ...override.autoscaling } : node.autoscaling,
    ingress: override.ingress ? { ...node.ingress, ...override.ingress } : node.ingress,
  };
}

export function resolveNodeForProvider(node: ArchitectureNode, provider: CloudProvider): ArchitectureNode {
  const profile = providerProfiles[provider];
  const nextStorage = node.storage.enabled && defaultStorageClasses.includes(node.storage.storageClassName)
    ? { ...node.storage, storageClassName: profile.storageClassName }
    : node.storage;
  const nextIngress = node.ingress.enabled && defaultIngressClasses.includes(node.ingress.ingressClassName)
    ? { ...node.ingress, ingressClassName: profile.ingressClassName }
    : node.ingress;
  const nextService = node.type === 'ingress' && node.service.type === 'ClusterIP'
    ? { ...node.service, type: 'LoadBalancer' as const }
    : node.service;
  const exposureService = nextService.exposure === 'external' && nextService.type === 'ClusterIP'
    ? { ...nextService, type: 'LoadBalancer' as const }
    : nextService.exposure === 'internal' && nextService.type === 'LoadBalancer'
      ? { ...nextService, type: 'ClusterIP' as const }
      : nextService;

  return {
    ...node,
    storage: nextStorage,
    ingress: nextIngress,
    service: exposureService,
  };
}

export function getProviderProfile(provider: CloudProvider) {
  return providerProfiles[provider];
}

export function getResolvedModel(model: ArchitectureModel): ArchitectureModel {
  return {
    ...model,
    nodes: model.nodes.map((node) => resolveNodeForProvider(resolveNodeForEnvironment(node, model.activeEnvironment), model.provider)),
  };
}

export function detectPattern(model: ArchitectureModel): PatternType {
  const resolvedModel = getResolvedModel(model);
  const serviceCount = resolvedModel.nodes.filter((node) => ['service', 'frontend', 'gateway', 'worker'].includes(node.type)).length;
  const queueCount = countNodeType(resolvedModel, 'queue');
  const databaseCount = countNodeType(resolvedModel, 'database');

  if (serviceCount <= 1 && databaseCount <= 1) {
    return 'monolith';
  }
  if (queueCount > 0 && serviceCount > 1) {
    return 'event-driven';
  }
  if (serviceCount > 1) {
    return 'microservices';
  }
  return 'hybrid';
}

export function inferEdgeType(_fromNode: ArchitectureNode, toNode: ArchitectureNode): EdgeType {
  if (toNode.type === 'database' || toNode.type === 'cache') {
    return 'data';
  }
  if (toNode.type === 'queue') {
    return 'async';
  }
  return 'http';
}

export function canConnectNodes(fromNode: ArchitectureNode, toNode: ArchitectureNode): ConnectionDecision {
  if (fromNode.id === toNode.id) {
    return { allowed: false, reason: 'A node cannot connect to itself.' };
  }

  const edgeType = inferEdgeType(fromNode, toNode);

  if (['worker', 'job', 'cronjob'].includes(toNode.type)) {
    return { allowed: false, reason: `${toNode.name} is a background workload and cannot receive runtime traffic.` };
  }

  if (edgeType === 'http' && ['database', 'cache'].includes(fromNode.type)) {
    return { allowed: false, reason: `${fromNode.name} cannot initiate HTTP traffic.` };
  }

  if (edgeType === 'http' && fromNode.type === 'queue') {
    return { allowed: false, reason: `${fromNode.name} cannot initiate HTTP traffic.` };
  }

  if (edgeType === 'data' && !['database', 'cache'].includes(toNode.type)) {
    return { allowed: false, reason: `${toNode.name} cannot receive data traffic.` };
  }

  if (edgeType === 'async' && toNode.type !== 'queue') {
    return { allowed: false, reason: `${toNode.name} must be a queue for async traffic.` };
  }

  if (fromNode.type === 'ingress' && !['service', 'frontend', 'gateway'].includes(toNode.type)) {
    return { allowed: false, reason: `${fromNode.name} can only point to a frontend, gateway, or service.` };
  }

  if (fromNode.ingress.enabled && toNode.namespace !== fromNode.namespace) {
    return { allowed: false, reason: 'Ingress backends must live in the same namespace as the ingress resource.' };
  }

  return { allowed: true, edgeType };
}

export function validateArchitecture(model: ArchitectureModel): ValidationIssue[] {
  const resolvedModel = getResolvedModel(model);
  const issues: ValidationIssue[] = [];
  const knownReferencedSecrets = new Set<string>();

  if (resolvedModel.nodes.length === 0) {
    issues.push({ level: 'error', message: 'Add at least one node before generating a deployment plan.' });
  }

  const duplicateNames = new Set<string>();
  const seenNames = new Set<string>();

  for (const node of resolvedModel.nodes) {
    if (seenNames.has(node.name.toLowerCase())) {
      duplicateNames.add(node.name);
    }
    seenNames.add(node.name.toLowerCase());

    if (!node.namespace.trim()) {
      issues.push({ level: 'error', message: `${node.name} must belong to a namespace.` });
    }
    if (node.namespace !== namespaceValue(node.namespace)) {
      issues.push({ level: 'warning', message: `${node.name} namespace will be normalized to ${namespaceValue(node.namespace)} in exports.` });
    }
    if (node.replicas < 1) {
      issues.push({ level: 'error', message: `${node.name} must have at least one replica.` });
    }
    if (model.activeEnvironment === 'prod' && ['service', 'frontend', 'gateway'].includes(node.type) && node.replicas < 2 && !node.autoscaling.enabled) {
      issues.push({ level: 'warning', message: `${node.name} is production-facing but has one replica and no autoscaling.` });
    }
    if (!node.image.trim()) {
      issues.push({ level: 'error', message: `${node.name} must define a container image.` });
    }
    if (model.activeEnvironment === 'prod' && isDefaultishTag(node.tag) && !['database', 'queue', 'cache', 'ingress'].includes(node.type)) {
      issues.push({ level: 'warning', message: `${node.name} uses a mutable image tag in prod.` });
    }
    if (!node.serviceAccountName.trim()) {
      issues.push({ level: 'error', message: `${node.name} must define a service account name.` });
    }
    for (const environment of ['dev', 'stage', 'prod'] as EnvironmentName[]) {
      if (!hasOverrideValue(node, environment)) {
        issues.push({ level: 'warning', message: `${node.name} has no ${environment} environment override.` });
      }
    }
    if (node.autoscaling.enabled && node.autoscaling.maxReplicas < node.autoscaling.minReplicas) {
      issues.push({ level: 'error', message: `${node.name} has autoscaling maxReplicas lower than minReplicas.` });
    }
    if (node.autoscaling.enabled && node.autoscaling.targetCPUUtilizationPercentage < 20) {
      issues.push({ level: 'warning', message: `${node.name} HPA target CPU is very low and may cause unnecessary scaling.` });
    }
    if (node.autoscaling.enabled && node.autoscaling.targetCPUUtilizationPercentage > 90) {
      issues.push({ level: 'warning', message: `${node.name} HPA target CPU is very high and may scale too late.` });
    }
    if (node.autoscaling.enabled && workloadKindForNode(node) !== 'Deployment') {
      issues.push({ level: 'warning', message: `${node.name} has HPA enabled, but autoscaling is only exported for Deployment workloads.` });
    }
    if (workloadKindForNode(node) === 'CronJob' && !node.workload.schedule.trim()) {
      issues.push({ level: 'error', message: `${node.name} is a CronJob but has no schedule.` });
    }
    if ((workloadKindForNode(node) === 'Job' || workloadKindForNode(node) === 'CronJob') && node.workload.restartPolicy === 'Always') {
      issues.push({ level: 'error', message: `${node.name} batch workloads must use OnFailure or Never restart policy.` });
    }
    if (workloadKindForNode(node) !== 'Job' && workloadKindForNode(node) !== 'CronJob' && node.workload.restartPolicy !== 'Always') {
      issues.push({ level: 'warning', message: `${node.name} is a controller workload; Kubernetes Deployments and StatefulSets normally restart pods with Always.` });
    }
    for (const [label, probe] of [
      ['readiness', node.readinessProbe],
      ['liveness', node.livenessProbe],
      ['startup', node.startupProbe],
    ] as const) {
      if (!probe.enabled) continue;
      if (probe.type === 'http' && !probe.path.trim()) {
        issues.push({ level: 'error', message: `${node.name} ${label} probe is HTTP but path is missing.` });
      }
      if (probe.type === 'exec' && !probe.command.trim()) {
        issues.push({ level: 'error', message: `${node.name} ${label} probe is exec but command is missing.` });
      }
      if (probe.failureThreshold < 1) {
        issues.push({ level: 'error', message: `${node.name} ${label} probe failure threshold must be at least 1.` });
      }
    }
    if (node.storage.enabled && !node.storage.size.trim()) {
      issues.push({ level: 'error', message: `${node.name} storage is enabled but size is missing.` });
    }
    if (node.storage.enabled && node.storage.size.trim() && parseStorageGi(node.storage.size) === undefined) {
      issues.push({ level: 'error', message: `${node.name} storage size must use Mi, Gi, or Ti units.` });
    }
    if (node.storage.enabled && !node.storage.storageClassName.trim()) {
      issues.push({ level: 'error', message: `${node.name} storage is enabled but storage class is missing.` });
    }
    if (node.storage.enabled && !node.storage.mountPath.trim()) {
      issues.push({ level: 'error', message: `${node.name} storage is enabled but mount path is missing.` });
    }
    if (node.storage.backupEnabled && !node.storage.backupSchedule.trim()) {
      issues.push({ level: 'error', message: `${node.name} has backup intent enabled but no backup schedule.` });
    }
    if (node.storage.enabled && workloadKindForNode(node) !== 'StatefulSet' && (node.type === 'database' || node.type === 'queue')) {
      issues.push({ level: 'warning', message: `${node.name} stores durable data but is not modeled as a StatefulSet.` });
    }
    const storageGi = node.storage.enabled ? parseStorageGi(node.storage.size) : undefined;
    if (node.type === 'database' && storageGi !== undefined && storageGi < 10) {
      issues.push({ level: 'warning', message: `${node.name} database storage is below 10Gi.` });
    }
    if ((node.type === 'database' || node.type === 'queue') && node.storage.enabled && node.storage.retainOnDelete !== 'Retain') {
      issues.push({ level: 'warning', message: `${node.name} durable storage is deleted when the StatefulSet is deleted.` });
    }
    if (node.ingress.enabled && !node.ingress.host.trim()) {
      issues.push({ level: 'error', message: `${node.name} ingress is enabled but host is missing.` });
    }
    if (node.ingress.tlsEnabled && !node.ingress.tlsSecretName.trim()) {
      issues.push({ level: 'error', message: `${node.name} ingress TLS is enabled but TLS secret is missing.` });
    }
    if (node.ingress.enabled && model.activeEnvironment === 'prod' && !node.ingress.tlsEnabled) {
      issues.push({ level: 'warning', message: `${node.name} exposes ingress in prod without TLS.` });
    }
    if (node.ingress.enabled && node.ingress.exposure === 'external' && node.ingress.loadBalancerScope === 'private') {
      issues.push({ level: 'warning', message: `${node.name} ingress is marked external but uses a private load balancer scope.` });
    }
    if (node.service.exposure === 'external' && node.service.loadBalancerScope === 'public' && node.type !== 'ingress') {
      issues.push({ level: 'warning', message: `${node.name} exposes a public service. Prefer ingress or a private load balancer unless this is intentional.` });
    }
    if (node.service.exposure === 'internal' && node.service.type === 'LoadBalancer') {
      issues.push({ level: 'warning', message: `${node.name} has internal exposure but uses LoadBalancer; export will normalize this to ClusterIP.` });
    }
    if (!node.security.runAsNonRoot) {
      issues.push({ level: 'warning', message: `${node.name} is allowed to run as root. Prefer runAsNonRoot for application workloads.` });
    }
    if (node.security.allowPrivilegeEscalation) {
      issues.push({ level: 'warning', message: `${node.name} allows privilege escalation. Disable it unless the workload requires it.` });
    }
    if (node.security.seccompProfile === 'Unconfined') {
      issues.push({ level: 'warning', message: `${node.name} uses an unconfined seccomp profile.` });
    }
    for (const secretEntry of node.secretEnv) {
      if (secretEntry.source === 'inline' && !secretEntry.value.trim()) {
        issues.push({ level: 'error', message: `${node.name} secret ${secretEntry.key} is inline but empty.` });
      }
      if (secretEntry.source === 'existingSecret' && (!secretEntry.secretName.trim() || !secretEntry.secretKey.trim())) {
        issues.push({ level: 'error', message: `${node.name} secret ${secretEntry.key} must reference both a secret name and key.` });
      }
      if (secretEntry.source === 'existingSecret' && secretEntry.secretName.trim() && secretEntry.secretKey.trim()) {
        knownReferencedSecrets.add(`${namespaceValue(node.namespace)}/${secretEntry.secretName}`);
      }
      if (!secretEntry.key.trim()) {
        issues.push({ level: 'error', message: `${node.name} has a secret entry with no environment variable key.` });
      }
    }
    for (const configEntry of node.env) {
      if (!configEntry.key.trim()) {
        issues.push({ level: 'error', message: `${node.name} has a config entry with no environment variable key.` });
      }
      if (configEntry.value.includes('SECRET') || configEntry.value.includes('PASSWORD') || configEntry.value.includes('TOKEN')) {
        issues.push({ level: 'warning', message: `${node.name} config ${configEntry.key} looks secret-like; move it to secrets.` });
      }
      if (configEntry.value.startsWith('secretRef:')) {
        const reference = configEntry.value.replace('secretRef:', '').trim();
        if (!reference.includes('#')) {
          issues.push({ level: 'error', message: `${node.name} config ${configEntry.key} has an unresolved secretRef. Use secret-name#key.` });
        }
      }
    }

    const derivedEnv = getDerivedEnvironmentVariables(resolvedModel, node.id);
    for (const derivedEntry of derivedEnv) {
      const manualEntry = node.env.find((entry) => entry.key === derivedEntry.key);
      if (manualEntry && manualEntry.value !== derivedEntry.value) {
        issues.push({
          level: 'warning',
          message: `${node.name} overrides ${derivedEntry.key}, but the graph implies ${derivedEntry.value}.`,
        });
      }
    }
  }

  for (const duplicateName of duplicateNames) {
    issues.push({ level: 'error', message: `Duplicate node name detected: ${duplicateName}.` });
  }

  for (const edge of resolvedModel.edges) {
    const fromNode = getNode(resolvedModel, edge.from);
    const toNode = getNode(resolvedModel, edge.to);

    if (!fromNode || !toNode) {
      issues.push({ level: 'error', message: `Connection ${edge.id} references a missing node.` });
      continue;
    }

    const connection = canConnectNodes(fromNode, toNode);
    if (!connection.allowed) {
      issues.push({ level: 'error', message: connection.reason });
    }
    if (edge.networkPolicy === 'deny') {
      issues.push({ level: 'warning', message: `${fromNode.name} to ${toNode.name} is modeled but network policy denies runtime traffic.` });
    }
    if (edge.networkPolicy === 'allow' && namespaceValue(fromNode.namespace) !== namespaceValue(toNode.namespace)) {
      issues.push({ level: 'warning', message: `${fromNode.name} to ${toNode.name} crosses namespaces; verify namespace labels exist for NetworkPolicy selection.` });
    }
    if (edge.type !== inferEdgeType(fromNode, toNode)) {
      issues.push({ level: 'warning', message: `${fromNode.name} to ${toNode.name} is typed ${edge.type}, but the target suggests ${inferEdgeType(fromNode, toNode)}.` });
    }
  }

  const ingressNodes = resolvedModel.nodes.filter((node) => node.type === 'ingress');
  if (ingressNodes.length === 0) {
    issues.push({ level: 'warning', message: 'No ingress node found. External traffic has no entry point.' });
  }

  const criticalDatabases = resolvedModel.nodes.filter((node) => node.type === 'database' && node.sla === 'critical');
  for (const database of criticalDatabases) {
    if (database.replicas < 2) {
      issues.push({
        level: 'warning',
        message: `${database.name} is critical but runs as a single replica. Consider high availability.`,
      });
    }
  }

  for (const secretReference of knownReferencedSecrets) {
    const [, secretName] = secretReference.split('/');
    const hasInlineSecretDocument = resolvedModel.nodes.some((node) => envSecretName(node) === secretName);
    if (!hasInlineSecretDocument) {
      issues.push({ level: 'warning', message: `External secret ${secretReference} is referenced but not generated by this model.` });
    }
  }

  return issues;
}

export function generateDeploymentPlan(model: ArchitectureModel): DeploymentPlan {
  const resolvedModel = getResolvedModel(model);
  const pattern = detectPattern(model);
  const estimatedMonthlyCost = resolvedModel.nodes.reduce((sum, node) => {
    const base = baseCostByType[node.type];
    const sizeFactor = node.cpu * 35 + node.memory * 18;
    const replicaFactor = Math.max(node.replicas, 1);
    return sum + (base + sizeFactor) * replicaFactor;
  }, 0);

  const namespaces = [...new Set(resolvedModel.nodes.map((node) => node.namespace))];
  const kubernetesObjects = [
    ...namespaces.map((namespace) => `Namespace/${namespace}`),
    ...resolvedModel.nodes.flatMap((node) => {
      const inlineSecrets = inlineSecretEntries(node);
      const referencedSecrets = referencedSecretEntries(node);
      const workloadKind = workloadKindForNode(node);
      const items = [
        `ServiceAccount/${node.serviceAccountName}`,
        `Role/${roleName(node)}`,
        `RoleBinding/${roleName(node)}`,
        `${workloadKind}/${node.name}`,
      ];
      if (shouldEmitService(node)) {
        items.push(`Service/${node.name}`);
      }
      node.imagePullSecrets.forEach((secret) => items.push(`ImagePullSecretRef/${secret}`));
      if (node.env.length > 0) {
        items.push(`ConfigMap/${envConfigMapName(node)}`);
      }
      if (inlineSecrets.length > 0) {
        items.push(`Secret/${envSecretName(node)}`);
      }
      referencedSecrets.forEach((secret) => items.push(`SecretRef/${secret.secretName}`));
      if (node.storage.enabled && !shouldUseVolumeClaimTemplate(node)) {
        items.push(`PersistentVolumeClaim/${node.name}`);
      }
      if (node.ingress.enabled) {
        items.push(`Ingress/${node.name}`);
      }
      if (shouldEmitHpa(node)) {
        items.push(`HorizontalPodAutoscaler/${node.name}`);
      }
      return items;
    }),
    ...namespaces.map((namespace) => `NetworkPolicy/${namespace}/default-deny`),
  ];

  return {
    pattern,
    nodeCount: model.nodes.length,
    estimatedMonthlyCost: Math.round(estimatedMonthlyCost),
    kubernetesObjects,
    strengths: [
      `${resolvedModel.nodes.length} components modeled with ${resolvedModel.edges.length} validated relationships for ${resolvedModel.activeEnvironment}.`,
      `Pattern detection suggests a ${pattern} architecture with environment-aware defaults.`,
      `${resolvedModel.provider} provider defaults apply ${providerProfiles[resolvedModel.provider].storageClassName} storage and ${providerProfiles[resolvedModel.provider].ingressClassName} ingress.`,
      'Namespaces, service accounts, graph-derived dependency config, storage, ingress, scaling, and environment overlays are carried into export output.',
    ],
    warnings: validateArchitecture(model)
      .filter((issue) => issue.level === 'warning')
      .map((issue) => issue.message),
  };
}

export function generateKubernetesDocuments(model: ArchitectureModel): ExportDocument[] {
  const resolvedModel = getResolvedModel(model);
  const namespaces = [...new Set(resolvedModel.nodes.map((node) => sanitizeName(node.namespace) || 'default'))];
  const documents: ExportDocument[] = namespaces.map((namespace) => ({
    kind: 'Namespace',
    name: namespace,
    yaml: ['apiVersion: v1', 'kind: Namespace', 'metadata:', `  name: ${namespace}`].join('\n'),
  }));

  for (const node of resolvedModel.nodes) {
    const namespace = sanitizeName(node.namespace) || 'default';
    const appName = sanitizeName(node.name);
    const labels = indent([`app: ${appName}`, `component: ${node.type}`], 8);

    const mergedEnv = getMergedEnvironmentVariables(resolvedModel, node.id);
    const inlineSecrets = inlineSecretEntries(node);
    const referencedSecrets = referencedSecretEntries(node);

    documents.push({
      kind: 'ServiceAccount',
      name: `${namespace}-${node.serviceAccountName}`,
      yaml: ['apiVersion: v1', 'kind: ServiceAccount', 'metadata:', `  name: ${node.serviceAccountName}`, `  namespace: ${namespace}`].join('\n'),
    });

    const rbacResources = ['"configmaps"', ...(inlineSecrets.length > 0 || referencedSecrets.length > 0 ? ['"secrets"'] : [])];
    documents.push({
      kind: 'Role',
      name: `${namespace}-${roleName(node)}`,
      yaml: [
        'apiVersion: rbac.authorization.k8s.io/v1',
        'kind: Role',
        'metadata:',
        `  name: ${roleName(node)}`,
        `  namespace: ${namespace}`,
        'rules:',
        '  - apiGroups:',
        '      - ""',
        '    resources:',
        ...rbacResources.map((resource) => `      - ${resource}`),
        '    verbs:',
        '      - get',
        '      - list',
        '      - watch',
      ].join('\n'),
    });

    documents.push({
      kind: 'RoleBinding',
      name: `${namespace}-${roleName(node)}`,
      yaml: [
        'apiVersion: rbac.authorization.k8s.io/v1',
        'kind: RoleBinding',
        'metadata:',
        `  name: ${roleName(node)}`,
        `  namespace: ${namespace}`,
        'subjects:',
        '  - kind: ServiceAccount',
        `    name: ${node.serviceAccountName}`,
        `    namespace: ${namespace}`,
        'roleRef:',
        '  apiGroup: rbac.authorization.k8s.io',
        '  kind: Role',
        `  name: ${roleName(node)}`,
      ].join('\n'),
    });

    if (mergedEnv.length > 0) {
      documents.push({
        kind: 'ConfigMap',
        name: `${namespace}-${envConfigMapName(node)}`,
        yaml: [
          'apiVersion: v1',
          'kind: ConfigMap',
          'metadata:',
          `  name: ${envConfigMapName(node)}`,
          `  namespace: ${namespace}`,
          'data:',
          ...mergedEnv.map((variable) => `  ${variable.key}: "${variable.value.replace(/"/g, '\\"')}"`),
        ].join('\n'),
      });
    }

    if (inlineSecrets.length > 0) {
      documents.push({
        kind: 'Secret',
        name: `${namespace}-${envSecretName(node)}`,
        yaml: [
          'apiVersion: v1',
          'kind: Secret',
          'metadata:',
          `  name: ${envSecretName(node)}`,
          `  namespace: ${namespace}`,
          'type: Opaque',
          'stringData:',
          ...inlineSecrets.map((variable) => `  ${variable.key}: "${variable.value.replace(/"/g, '\\"')}"`),
        ].join('\n'),
      });
    }

    const envFromLines: string[] = [];
    if (mergedEnv.length > 0) {
      envFromLines.push('  envFrom:', '    - configMapRef:', `        name: ${envConfigMapName(node)}`);
    }
    if (inlineSecrets.length > 0) {
      envFromLines.push('    - secretRef:', `        name: ${envSecretName(node)}`);
    }

    const directSecretEnvLines = referencedSecrets.flatMap((variable) => [
      `  - name: ${variable.key}`,
      '    valueFrom:',
      '      secretKeyRef:',
      `        name: ${variable.secretName}`,
      `        key: ${variable.secretKey}`,
    ]);

    const volumeMountLines = node.storage.enabled
      ? ['  volumeMounts:', '    - name: app-storage', `      mountPath: ${node.storage.mountPath}`]
      : [];

    const volumeLines =
      node.storage.enabled && !shouldUseVolumeClaimTemplate(node)
        ? ['      volumes:', '        - name: app-storage', '          persistentVolumeClaim:', `            claimName: ${appName}-pvc`]
        : [];

    const containerLines = [
      `- name: ${appName}`,
      `  image: ${node.image}:${node.tag}`,
      '  imagePullPolicy: IfNotPresent',
      ...(node.workload.command.length > 0 ? ['  command:', ...node.workload.command.map((entry) => `    - ${JSON.stringify(entry)}`)] : []),
      ...(node.workload.args.length > 0 ? ['  args:', ...node.workload.args.map((entry) => `    - ${JSON.stringify(entry)}`)] : []),
      '  securityContext:',
      `    allowPrivilegeEscalation: ${node.security.allowPrivilegeEscalation}`,
      `    readOnlyRootFilesystem: ${node.security.readOnlyRootFilesystem}`,
      '    capabilities:',
      '      drop:',
      '        - ALL',
      '  ports:',
      `    - containerPort: ${node.containerPort}`,
      '  resources:',
      '    requests:',
      `      cpu: "${node.resources.requestsCpu}"`,
      `      memory: "${node.resources.requestsMemory}"`,
      '    limits:',
      `      cpu: "${node.resources.limitsCpu}"`,
      `      memory: "${node.resources.limitsMemory}"`,
      ...(directSecretEnvLines.length > 0 ? ['  env:', ...directSecretEnvLines] : []),
      ...envFromLines,
      ...probeLinesForNode(node, 'startupProbe'),
      ...probeLinesForNode(node, 'readinessProbe'),
      ...probeLinesForNode(node, 'livenessProbe'),
      ...volumeMountLines,
    ];

    const workloadKind = workloadKindForNode(node);
    const podSpecLines = [
      `serviceAccountName: ${node.serviceAccountName}`,
      'securityContext:',
      `  runAsNonRoot: ${node.security.runAsNonRoot}`,
      `  runAsUser: ${node.security.runAsUser}`,
      '  seccompProfile:',
      `    type: ${node.security.seccompProfile}`,
      ...(node.imagePullSecrets.length > 0
        ? ['imagePullSecrets:', ...node.imagePullSecrets.map((secret) => `  - name: ${secret}`)]
        : []),
      ...(workloadKind === 'Job' || workloadKind === 'CronJob' ? [`restartPolicy: ${node.workload.restartPolicy}`] : []),
      `terminationGracePeriodSeconds: ${node.workload.terminationGracePeriodSeconds}`,
      'containers:',
      ...indent(containerLines, 2),
      ...volumeLines.map((line) => line.replace(/^\s{6}/, '')),
    ];

    const controllerWorkloadLines = [
      `apiVersion: ${workloadApiVersion(workloadKind)}`,
      `kind: ${workloadKind}`,
      'metadata:',
      `  name: ${appName}`,
      `  namespace: ${namespace}`,
      'spec:',
      ...(workloadKind === 'StatefulSet' ? [`  serviceName: ${appName}`] : []),
      `  replicas: ${node.replicas}`,
      '  selector:',
      '    matchLabels:',
      `      app: ${appName}`,
      '  template:',
      '    metadata:',
      '      labels:',
      ...labels,
      '    spec:',
      ...indent(podSpecLines, 6),
    ];

    if (shouldUseVolumeClaimTemplate(node)) {
      controllerWorkloadLines.push(
        '  persistentVolumeClaimRetentionPolicy:',
        `    whenDeleted: ${node.storage.retainOnDelete}`,
        `    whenScaled: ${node.storage.retainOnScaleDown}`,
        '  volumeClaimTemplates:',
        '    - metadata:',
        '        name: app-storage',
        ...(node.storage.backupEnabled
          ? [
              '        annotations:',
              '          visual-kubernetes.io/backup-enabled: "true"',
              `          visual-kubernetes.io/backup-schedule: "${node.storage.backupSchedule}"`,
            ]
          : []),
        '      spec:',
        ...storageSpecLines(node, 8),
      );
    }

    const jobWorkloadLines = [
      'apiVersion: batch/v1',
      `kind: ${workloadKind}`,
      'metadata:',
      `  name: ${appName}`,
      `  namespace: ${namespace}`,
      'spec:',
      ...(workloadKind === 'CronJob'
        ? [
            `  schedule: "${node.workload.schedule}"`,
            '  jobTemplate:',
            '    spec:',
            `      backoffLimit: ${node.workload.backoffLimit}`,
            '      template:',
            '        metadata:',
            '          labels:',
            ...indent([`app: ${appName}`, `component: ${node.type}`], 12),
            '        spec:',
            ...indent(podSpecLines, 10),
          ]
        : [
            `  completions: ${node.workload.completions}`,
            `  parallelism: ${node.workload.parallelism}`,
            `  backoffLimit: ${node.workload.backoffLimit}`,
            '  template:',
            '    metadata:',
            '      labels:',
            ...labels,
            '    spec:',
            ...indent(podSpecLines, 6),
          ]),
    ];

    const workloadLines = workloadKind === 'Job' || workloadKind === 'CronJob' ? jobWorkloadLines : controllerWorkloadLines;

    documents.push({ kind: workloadKind, name: `${namespace}-${appName}`, yaml: workloadLines.join('\n') });

    if (node.storage.enabled && !shouldUseVolumeClaimTemplate(node)) {
      documents.push({
        kind: 'PersistentVolumeClaim',
        name: `${namespace}-${appName}-pvc`,
        yaml: [
          'apiVersion: v1',
          'kind: PersistentVolumeClaim',
          'metadata:',
          `  name: ${appName}-pvc`,
          `  namespace: ${namespace}`,
          ...storageAnnotations(node),
          'spec:',
          ...storageSpecLines(node, 2),
        ].join('\n'),
      });
    }

    if (shouldEmitService(node)) {
      documents.push({
        kind: 'Service',
        name: `${namespace}-${appName}`,
        yaml: [
          'apiVersion: v1',
          'kind: Service',
          'metadata:',
          `  name: ${appName}`,
          `  namespace: ${namespace}`,
          ...(node.service.type === 'LoadBalancer' ? providerLoadBalancerAnnotation(resolvedModel.provider, node) : []),
          'spec:',
          `  type: ${node.service.type}`,
          ...(node.service.type === 'LoadBalancer' || node.service.type === 'NodePort'
            ? [`  externalTrafficPolicy: ${node.service.externalTrafficPolicy}`]
            : []),
          '  selector:',
          `    app: ${appName}`,
          '  ports:',
          `    - port: ${node.service.port}`,
          `      targetPort: ${node.containerPort}`,
        ].join('\n'),
      });
    }

    if (node.ingress.enabled) {
      const backend = resolvedModel.edges
        .map((edge) => (edge.from === node.id ? getNode(resolvedModel, edge.to) : undefined))
        .find((candidate) => candidate && ['service', 'frontend', 'gateway'].includes(candidate.type));
      const backendName = sanitizeName(backend?.name ?? node.name);

      const ingressLines = [
        'apiVersion: networking.k8s.io/v1',
        'kind: Ingress',
        'metadata:',
        `  name: ${appName}`,
        `  namespace: ${namespace}`,
        ...providerIngressAnnotations(resolvedModel.provider, node),
        'spec:',
        `  ingressClassName: ${node.ingress.ingressClassName}`,
      ];

      if (node.ingress.tlsEnabled) {
        ingressLines.push('  tls:', '    - hosts:', `        - ${node.ingress.host}`, `      secretName: ${node.ingress.tlsSecretName}`);
      }

      ingressLines.push(
        '  rules:',
        `    - host: ${node.ingress.host}`,
        '      http:',
        '        paths:',
        `          - path: ${node.ingress.path}`,
        '            pathType: Prefix',
        '            backend:',
        '              service:',
        `                name: ${backendName}`,
        '                port:',
        '                  number: 80',
      );

      documents.push({ kind: 'Ingress', name: `${namespace}-${appName}`, yaml: ingressLines.join('\n') });
    }

    if (shouldEmitHpa(node)) {
      documents.push({
        kind: 'HorizontalPodAutoscaler',
        name: `${namespace}-${appName}`,
        yaml: [
          'apiVersion: autoscaling/v2',
          'kind: HorizontalPodAutoscaler',
          'metadata:',
          `  name: ${appName}`,
          `  namespace: ${namespace}`,
          'spec:',
          '  scaleTargetRef:',
          '    apiVersion: apps/v1',
          `    kind: ${workloadKind}`,
          `    name: ${appName}`,
          `  minReplicas: ${node.autoscaling.minReplicas}`,
          `  maxReplicas: ${node.autoscaling.maxReplicas}`,
          '  metrics:',
          '    - type: Resource',
          '      resource:',
          '        name: cpu',
          '        target:',
          '          type: Utilization',
          `          averageUtilization: ${node.autoscaling.targetCPUUtilizationPercentage}`,
        ].join('\n'),
      });
    }
  }

  for (const namespace of namespaces) {
    documents.push({
      kind: 'NetworkPolicy',
      name: `${namespace}-default-deny`,
      yaml: [
        'apiVersion: networking.k8s.io/v1',
        'kind: NetworkPolicy',
        'metadata:',
        '  name: default-deny',
        `  namespace: ${namespace}`,
        'spec:',
        '  podSelector: {}',
        '  policyTypes:',
        '    - Ingress',
        '    - Egress',
      ].join('\n'),
    });
  }

  for (const edge of resolvedModel.edges) {
    if (edge.networkPolicy === 'deny') {
      continue;
    }

    const fromNode = getNode(resolvedModel, edge.from);
    const toNode = getNode(resolvedModel, edge.to);
    if (!fromNode || !toNode) continue;

    const fromApp = sanitizeName(fromNode.name);
    const toApp = sanitizeName(toNode.name);
    const fromNs = sanitizeName(fromNode.namespace) || 'default';
    const toNs = sanitizeName(toNode.namespace) || 'default';
    const policyName = `allow-${fromApp}-to-${toApp}`;

    const ingressFrom =
      fromNs !== toNs
        ? [
            '    - namespaceSelector:',
            '        matchLabels:',
            `          kubernetes.io/metadata.name: ${fromNs}`,
            '      podSelector:',
            '          matchLabels:',
            `            app: ${fromApp}`,
          ]
        : [
            '    - podSelector:',
            '        matchLabels:',
            `          app: ${fromApp}`,
          ];

    documents.push({
      kind: 'NetworkPolicy',
      name: `${toNs}-${policyName}`,
      yaml: [
        'apiVersion: networking.k8s.io/v1',
        'kind: NetworkPolicy',
        'metadata:',
        `  name: ${policyName}`,
        `  namespace: ${toNs}`,
        'spec:',
        '  podSelector:',
        '    matchLabels:',
        `      app: ${toApp}`,
        '  policyTypes:',
        '    - Ingress',
        '  ingress:',
        '    - from:',
        ...ingressFrom,
        '      ports:',
        '        - protocol: TCP',
        `          port: ${toNode.service.port}`,
      ].join('\n'),
    });
  }

  return documents;
}

export function generateKubernetesYaml(model: ArchitectureModel): string {
  return generateKubernetesDocuments(model)
    .map((document) => document.yaml)
    .join('\n---\n');
}

export function generateTerraform(model: ArchitectureModel): string {
  const documents = generateKubernetesDocuments(model);
  const resolvedModel = getResolvedModel(model);
  const resources = documents.map((document, index) => terraformResourceForDocument(document, index));

  return [
    'terraform {',
    '  required_version = ">= 1.6.0"',
    '  required_providers {',
    '    kubernetes = {',
    '      source  = "hashicorp/kubernetes"',
    '      version = "~> 2.31"',
    '    }',
    '  }',
    '}',
    '',
    'provider "kubernetes" {',
    '  config_path = "~/.kube/config"',
    '}',
    '',
    `# Target cloud provider: ${resolvedModel.provider}`,
    `# Active environment: ${resolvedModel.activeEnvironment}`,
    '# Cluster provisioning is not yet emitted here; this output assumes the cluster already exists.',
    '',
    ...resources,
  ].join('\n');
}

function terraformResourceForDocument(document: ExportDocument, index: number) {
  const resourceName = `${document.kind.toLowerCase()}_${fileSafeName(document.name) || index}`;
  return [
    `resource "kubernetes_manifest" "${resourceName}" {`,
    '  manifest = yamldecode(<<-YAML',
    document.yaml,
    '  YAML',
    '  )',
    '}',
  ].join('\n');
}

function terraformProviderFile(model: ArchitectureModel) {
  const resolvedModel = getResolvedModel(model);
  return [
    'terraform {',
    '  required_version = ">= 1.6.0"',
    '  required_providers {',
    '    kubernetes = {',
    '      source  = "hashicorp/kubernetes"',
    '      version = "~> 2.31"',
    '    }',
    '  }',
    '}',
    '',
    'provider "kubernetes" {',
    '  config_path = var.kubeconfig_path',
    '}',
    '',
    `# Target cloud provider: ${resolvedModel.provider}`,
    `# Active environment: ${resolvedModel.activeEnvironment}`,
    '# Cluster provisioning is not yet emitted here; this output assumes the cluster already exists.',
  ].join('\n');
}

function terraformVariablesFile() {
  return [
    'variable "kubeconfig_path" {',
    '  description = "Path to the kubeconfig used by the Kubernetes provider."',
    '  type        = string',
    '  default     = "~/.kube/config"',
    '}',
  ].join('\n');
}

export function generateProjectFiles(model: ArchitectureModel) {
  const resolvedModel = getResolvedModel(model);
  const documents = generateKubernetesDocuments(model);
  const namespaces = [...new Set(documents.map((document) => documentNamespace(document)))];
  const environment = resolvedModel.activeEnvironment;
  const manifestFiles = documents.map((document) => {
    const namespace = documentNamespace(document);
    const fileName = `${fileSafeName(document.kind)}-${fileSafeName(document.name)}.yaml`;
    return {
      path: `k8s/${environment}/namespaces/${namespace}/${fileName}`,
      content: `${document.yaml}\n`,
    };
  });
  const namespaceKustomizations = namespaces.map((namespace) => {
    const resources = manifestFiles
      .filter((file) => file.path.startsWith(`k8s/${environment}/namespaces/${namespace}/`))
      .map((file) => `  - ${file.path.split('/').at(-1)}`);

    return {
      path: `k8s/${environment}/namespaces/${namespace}/kustomization.yaml`,
      content: ['apiVersion: kustomize.config.k8s.io/v1beta1', 'kind: Kustomization', 'resources:', ...resources].join('\n'),
    };
  });
  const terraformManifestFiles = documents.map((document, index) => ({
    path: `terraform/${environment}/manifests/${String(index + 1).padStart(3, '0')}-${fileSafeName(document.kind)}-${fileSafeName(document.name)}.tf`,
    content: `${terraformResourceForDocument(document, index)}\n`,
  }));

  return [
    {
      path: `k8s/${environment}/kustomization.yaml`,
      content: ['apiVersion: kustomize.config.k8s.io/v1beta1', 'kind: Kustomization', 'resources:', ...namespaces.map((namespace) => `  - namespaces/${namespace}`)].join('\n'),
    },
    ...namespaceKustomizations,
    ...manifestFiles,
    ...namespaces.map((namespace) => ({
      path: `k8s/${environment}/namespaces/${namespace}/README.md`,
      content: [`# Namespace ${namespace}`, '', `Environment: ${environment}`, '', 'Apply this namespace group with:', '', '```sh', `kubectl apply -k k8s/${environment}/namespaces/${namespace}`, '```', ''].join('\n'),
    })),
    {
      path: `terraform/${environment}/main.tf`,
      content: `${terraformProviderFile(model)}\n`,
    },
    {
      path: `terraform/${environment}/variables.tf`,
      content: `${terraformVariablesFile()}\n`,
    },
    ...terraformManifestFiles,
    {
      path: 'README.md',
      content: [
        `# ${resolvedModel.name}`,
        '',
        `Provider: ${resolvedModel.provider}`,
        `Active environment: ${resolvedModel.activeEnvironment}`,
        `Default namespace: ${resolvedModel.defaultNamespace}`,
        `Storage class default: ${providerProfiles[resolvedModel.provider].storageClassName}`,
        `Ingress class default: ${providerProfiles[resolvedModel.provider].ingressClassName}`,
        `Service exposure: ${providerProfiles[resolvedModel.provider].loadBalancerMode}`,
        '',
        '## Kubernetes',
        `- Environment root: k8s/${environment}`,
        `- Apply all manifests: kubectl apply -k k8s/${environment}`,
        `- Namespace-specific manifests are grouped under k8s/${environment}/namespaces/<namespace>.`,
        '',
        '## Terraform',
        `- Terraform root: terraform/${environment}`,
        '- Kubernetes manifest resources are split under terraform/<environment>/manifests.',
        '- The Terraform and Kubernetes files are generated from the same manifest document set.',
        '',
        '## Notes',
        '- This package assumes an existing Kubernetes cluster.',
        '- Nodes can target separate namespaces for more realistic environment separation.',
        '- Environment overlays are applied before YAML and Terraform are generated.',
        '- The single-file preview in the app is for inspection; the ZIP bundle is intentionally modular.',
        ...providerProfiles[resolvedModel.provider].readmeNotes.map((note) => `- ${note}`),
      ].join('\n'),
    },
  ];
}
