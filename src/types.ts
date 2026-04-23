export type NodeType = 'ingress' | 'frontend' | 'gateway' | 'service' | 'worker' | 'database' | 'cache' | 'queue';
export type EdgeType = 'http' | 'async' | 'data';
export type PatternType = 'monolith' | 'microservices' | 'event-driven' | 'hybrid';
export type CloudProvider = 'aws' | 'gcp' | 'azure' | 'generic';
export type EnvironmentName = 'dev' | 'stage' | 'prod';

export interface ProbeConfig {
  enabled: boolean;
  path: string;
  port: number;
  initialDelaySeconds: number;
  periodSeconds: number;
}

export interface ResourceConfig {
  requestsCpu: string;
  requestsMemory: string;
  limitsCpu: string;
  limitsMemory: string;
}

export interface AutoscalingConfig {
  enabled: boolean;
  minReplicas: number;
  maxReplicas: number;
  targetCPUUtilizationPercentage: number;
}

export interface EnvironmentVariable {
  key: string;
  value: string;
}

export interface InlineSecretVariable {
  source: 'inline';
  key: string;
  value: string;
}

export interface ExistingSecretReference {
  source: 'existingSecret';
  key: string;
  secretName: string;
  secretKey: string;
}

export type SecretVariable = InlineSecretVariable | ExistingSecretReference;

export interface StorageConfig {
  enabled: boolean;
  size: string;
  storageClassName: string;
  mountPath: string;
}

export interface ServiceConfig {
  type: 'ClusterIP' | 'NodePort' | 'LoadBalancer';
  port: number;
}

export interface IngressConfig {
  enabled: boolean;
  host: string;
  path: string;
  tlsEnabled: boolean;
  tlsSecretName: string;
  ingressClassName: string;
}

export interface NodeEnvironmentOverride {
  replicas?: number;
  tag?: string;
  resources?: Partial<ResourceConfig>;
  autoscaling?: Partial<AutoscalingConfig>;
  ingress?: Partial<Pick<IngressConfig, 'host' | 'tlsSecretName'>>;
}

export interface ArchitectureNode {
  id: string;
  name: string;
  type: NodeType;
  namespace: string;
  replicas: number;
  cpu: number;
  memory: number;
  sla: 'standard' | 'critical';
  image: string;
  tag: string;
  containerPort: number;
  env: EnvironmentVariable[];
  secretEnv: SecretVariable[];
  resources: ResourceConfig;
  readinessProbe: ProbeConfig;
  livenessProbe: ProbeConfig;
  autoscaling: AutoscalingConfig;
  storage: StorageConfig;
  service: ServiceConfig;
  serviceAccountName: string;
  ingress: IngressConfig;
  environmentOverrides?: Partial<Record<EnvironmentName, NodeEnvironmentOverride>>;
}

export interface ArchitectureEdge {
  id: string;
  from: string;
  to: string;
  type: EdgeType;
  latencyBudgetMs: number;
}

export interface ArchitectureModel {
  name: string;
  defaultNamespace: string;
  provider: CloudProvider;
  activeEnvironment: EnvironmentName;
  nodes: ArchitectureNode[];
  edges: ArchitectureEdge[];
}

export interface NodePosition {
  x: number;
  y: number;
}

export type CanvasLayout = Record<string, NodePosition>;

export interface WorkspaceState {
  model: ArchitectureModel;
  layout: CanvasLayout;
}

export interface ValidationIssue {
  level: 'error' | 'warning';
  message: string;
}

export interface DeploymentPlan {
  pattern: PatternType;
  nodeCount: number;
  estimatedMonthlyCost: number;
  kubernetesObjects: string[];
  strengths: string[];
  warnings: string[];
}

export interface ExportDocument {
  kind: string;
  name: string;
  yaml: string;
}
