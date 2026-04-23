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

function indent(lines: string[], spaces: number) {
  const prefix = ' '.repeat(spaces);
  return lines.map((line) => `${prefix}${line}`);
}

function httpProbeLines(label: string, path: string, port: number, initialDelaySeconds: number, periodSeconds: number) {
  return [
    `${label}:`,
    '  httpGet:',
    `    path: ${path}`,
    `    port: ${port}`,
    `  initialDelaySeconds: ${initialDelaySeconds}`,
    `  periodSeconds: ${periodSeconds}`,
  ];
}

function tcpProbeLines(label: string, port: number, initialDelaySeconds: number, periodSeconds: number) {
  return [
    `${label}:`,
    '  tcpSocket:',
    `    port: ${port}`,
    `  initialDelaySeconds: ${initialDelaySeconds}`,
    `  periodSeconds: ${periodSeconds}`,
  ];
}

function probeLinesForNode(node: ArchitectureNode, label: 'readinessProbe' | 'livenessProbe') {
  const probe = label === 'readinessProbe' ? node.readinessProbe : node.livenessProbe;
  if (!probe.enabled) {
    return [];
  }

  if (node.type === 'database' || node.type === 'queue' || node.type === 'cache') {
    return tcpProbeLines(label, probe.port, probe.initialDelaySeconds, probe.periodSeconds);
  }

  return httpProbeLines(label, probe.path, probe.port, probe.initialDelaySeconds, probe.periodSeconds);
}

function envSecretName(node: ArchitectureNode) {
  return `${sanitizeName(node.name)}-secret`;
}

function envConfigMapName(node: ArchitectureNode) {
  return `${sanitizeName(node.name)}-config`;
}

function inlineSecretEntries(node: ArchitectureNode) {
  return node.secretEnv.filter((entry) => entry.source === 'inline');
}

function referencedSecretEntries(node: ArchitectureNode) {
  return node.secretEnv.filter((entry) => entry.source === 'existingSecret');
}

function providerLoadBalancerAnnotation(provider: CloudProvider) {
  if (provider === 'aws') {
    return ['  annotations:', '    service.beta.kubernetes.io/aws-load-balancer-type: "nlb"'];
  }
  if (provider === 'gcp') {
    return ['  annotations:', '    cloud.google.com/load-balancer-type: "External"'];
  }
  if (provider === 'azure') {
    return ['  annotations:', '    service.beta.kubernetes.io/azure-load-balancer-resource-group: "replace-me"'];
  }
  return [];
}

function providerIngressAnnotations(provider: CloudProvider) {
  if (provider === 'aws') {
    return [
      '  annotations:',
      '    kubernetes.io/ingress.class: "alb"',
      '    alb.ingress.kubernetes.io/scheme: "internet-facing"',
    ];
  }
  if (provider === 'gcp') {
    return ['  annotations:', '    kubernetes.io/ingress.class: "gce"'];
  }
  if (provider === 'azure') {
    return ['  annotations:', '    kubernetes.io/ingress.class: "azure/application-gateway"'];
  }
  return [];
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
    if (edge.from !== nodeId) {
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

export function getResolvedModel(model: ArchitectureModel): ArchitectureModel {
  return {
    ...model,
    nodes: model.nodes.map((node) => resolveNodeForEnvironment(node, model.activeEnvironment)),
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

  if (edgeType === 'http' && ['database', 'cache'].includes(fromNode.type)) {
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
    if (node.replicas < 1) {
      issues.push({ level: 'error', message: `${node.name} must have at least one replica.` });
    }
    if (!node.image.trim()) {
      issues.push({ level: 'error', message: `${node.name} must define a container image.` });
    }
    if (!node.serviceAccountName.trim()) {
      issues.push({ level: 'error', message: `${node.name} must define a service account name.` });
    }
    if (node.autoscaling.enabled && node.autoscaling.maxReplicas < node.autoscaling.minReplicas) {
      issues.push({ level: 'error', message: `${node.name} has autoscaling maxReplicas lower than minReplicas.` });
    }
    if (node.storage.enabled && !node.storage.size.trim()) {
      issues.push({ level: 'error', message: `${node.name} storage is enabled but size is missing.` });
    }
    if (node.ingress.enabled && !node.ingress.host.trim()) {
      issues.push({ level: 'error', message: `${node.name} ingress is enabled but host is missing.` });
    }
    for (const secretEntry of node.secretEnv) {
      if (secretEntry.source === 'inline' && !secretEntry.value.trim()) {
        issues.push({ level: 'error', message: `${node.name} secret ${secretEntry.key} is inline but empty.` });
      }
      if (secretEntry.source === 'existingSecret' && (!secretEntry.secretName.trim() || !secretEntry.secretKey.trim())) {
        issues.push({ level: 'error', message: `${node.name} secret ${secretEntry.key} must reference both a secret name and key.` });
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
      const items = [
        `ServiceAccount/${node.serviceAccountName}`,
        node.type === 'database' ? `StatefulSet/${node.name}` : `Deployment/${node.name}`,
        `Service/${node.name}`,
      ];
      if (node.env.length > 0) {
        items.push(`ConfigMap/${envConfigMapName(node)}`);
      }
      if (inlineSecrets.length > 0) {
        items.push(`Secret/${envSecretName(node)}`);
      }
      referencedSecrets.forEach((secret) => items.push(`SecretRef/${secret.secretName}`));
      if (node.storage.enabled) {
        items.push(`PersistentVolumeClaim/${node.name}`);
      }
      if (node.ingress.enabled) {
        items.push(`Ingress/${node.name}`);
      }
      if (node.autoscaling.enabled) {
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
      node.storage.enabled && node.type !== 'database'
        ? ['      volumes:', '        - name: app-storage', '          persistentVolumeClaim:', `            claimName: ${appName}-pvc`]
        : [];

    const containerLines = [
      `- name: ${appName}`,
      `  image: ${node.image}:${node.tag}`,
      '  imagePullPolicy: IfNotPresent',
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
      ...probeLinesForNode(node, 'readinessProbe'),
      ...probeLinesForNode(node, 'livenessProbe'),
      ...volumeMountLines,
    ];

    const workloadKind = node.type === 'database' ? 'StatefulSet' : 'Deployment';
    const workloadLines = [
      'apiVersion: apps/v1',
      `kind: ${workloadKind}`,
      'metadata:',
      `  name: ${appName}`,
      `  namespace: ${namespace}`,
      'spec:',
      ...(node.type === 'database' ? [`  serviceName: ${appName}`] : []),
      `  replicas: ${node.replicas}`,
      '  selector:',
      '    matchLabels:',
      `      app: ${appName}`,
      '  template:',
      '    metadata:',
      '      labels:',
      ...labels,
      '    spec:',
      `      serviceAccountName: ${node.serviceAccountName}`,
      '      containers:',
      ...indent(containerLines, 8),
      ...volumeLines,
    ];

    if (node.storage.enabled && node.type === 'database') {
      workloadLines.push(
        '  volumeClaimTemplates:',
        '    - metadata:',
        '        name: app-storage',
        '      spec:',
        '        accessModes:',
        '          - ReadWriteOnce',
        `        storageClassName: ${node.storage.storageClassName}`,
        '        resources:',
        '          requests:',
        `            storage: ${node.storage.size}`,
      );
    }

    documents.push({ kind: workloadKind, name: `${namespace}-${appName}`, yaml: workloadLines.join('\n') });

    if (node.storage.enabled && node.type !== 'database') {
      documents.push({
        kind: 'PersistentVolumeClaim',
        name: `${namespace}-${appName}-pvc`,
        yaml: [
          'apiVersion: v1',
          'kind: PersistentVolumeClaim',
          'metadata:',
          `  name: ${appName}-pvc`,
          `  namespace: ${namespace}`,
          'spec:',
          '  accessModes:',
          '    - ReadWriteOnce',
          `  storageClassName: ${node.storage.storageClassName}`,
          '  resources:',
          '    requests:',
          `      storage: ${node.storage.size}`,
        ].join('\n'),
      });
    }

    documents.push({
      kind: 'Service',
      name: `${namespace}-${appName}`,
      yaml: [
        'apiVersion: v1',
        'kind: Service',
        'metadata:',
        `  name: ${appName}`,
        `  namespace: ${namespace}`,
        ...(node.service.type === 'LoadBalancer' ? providerLoadBalancerAnnotation(resolvedModel.provider) : []),
        'spec:',
        `  type: ${node.service.type}`,
        '  selector:',
        `    app: ${appName}`,
        '  ports:',
        `    - port: ${node.service.port}`,
        `      targetPort: ${node.containerPort}`,
      ].join('\n'),
    });

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
        ...providerIngressAnnotations(resolvedModel.provider),
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

    if (node.autoscaling.enabled) {
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
  const resources = documents.map((document, index) => {
    const resourceName = `${document.kind.toLowerCase()}_${sanitizeName(document.name) || index}`;
    return [
      `resource "kubernetes_manifest" "${resourceName}" {`,
      '  manifest = yamldecode(<<-YAML',
      document.yaml,
      '  YAML',
      '  )',
      '}',
    ].join('\n');
  });

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

export function generateProjectFiles(model: ArchitectureModel) {
  const resolvedModel = getResolvedModel(model);
  const namespaces = [...new Set(resolvedModel.nodes.map((node) => sanitizeName(node.namespace) || 'default'))];
  const environment = resolvedModel.activeEnvironment;
  return [
    {
      path: `k8s/${environment}/manifests.yaml`,
      content: generateKubernetesYaml(model),
    },
    ...namespaces.map((namespace) => ({
      path: `k8s/${environment}/namespaces/${namespace}/README.md`,
      content: `Namespace ${namespace} for ${environment}\n`,
    })),
    {
      path: `terraform/${environment}/main.tf`,
      content: generateTerraform(model),
    },
    {
      path: 'README.md',
      content: [
        `# ${resolvedModel.name}`,
        '',
        `Provider: ${resolvedModel.provider}`,
        `Active environment: ${resolvedModel.activeEnvironment}`,
        `Default namespace: ${resolvedModel.defaultNamespace}`,
        '',
        '## Notes',
        '- This package assumes an existing Kubernetes cluster.',
        '- Nodes can target separate namespaces for more realistic environment separation.',
        '- Environment overlays are applied before YAML and Terraform are generated.',
      ].join('\n'),
    },
  ];
}
