export type NodeType = 'ingress' | 'frontend' | 'gateway' | 'service' | 'worker' | 'database' | 'cache' | 'queue' | 'job' | 'cronjob';
export type EdgeType = 'http' | 'async' | 'data';
export type PatternType = 'monolith' | 'microservices' | 'event-driven' | 'hybrid';
export type CloudProvider = 'aws' | 'gcp' | 'azure' | 'generic';
export type EnvironmentName = 'dev' | 'stage' | 'prod';
export type WorkloadKind = 'Deployment' | 'StatefulSet' | 'Job' | 'CronJob';
export type RestartPolicy = 'Always' | 'OnFailure' | 'Never';
export type StorageAccessMode = 'ReadWriteOnce' | 'ReadOnlyMany' | 'ReadWriteMany' | 'ReadWriteOncePod';
export type VolumeMode = 'Filesystem' | 'Block';
export type StatefulStorageRetention = 'Retain' | 'Delete';
export type ServiceExposure = 'internal' | 'external';
export type LoadBalancerScope = 'public' | 'private';
export type ExternalTrafficPolicy = 'Cluster' | 'Local';
export type NetworkPolicyIntent = 'allow' | 'deny';
export type ProbeType = 'http' | 'tcp' | 'exec';

export interface ProbeConfig {
  enabled: boolean;
  type: ProbeType;
  path: string;
  port: number;
  command: string;
  initialDelaySeconds: number;
  periodSeconds: number;
  failureThreshold: number;
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

export interface WorkloadConfig {
  kind: WorkloadKind;
  schedule: string;
  completions: number;
  parallelism: number;
  backoffLimit: number;
  restartPolicy: RestartPolicy;
  command: string[];
  args: string[];
  terminationGracePeriodSeconds: number;
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
  accessMode: StorageAccessMode;
  volumeMode: VolumeMode;
  mountPath: string;
  retainOnDelete: StatefulStorageRetention;
  retainOnScaleDown: StatefulStorageRetention;
  backupEnabled: boolean;
  backupSchedule: string;
}

export interface ServiceConfig {
  type: 'ClusterIP' | 'NodePort' | 'LoadBalancer';
  port: number;
  exposure: ServiceExposure;
  loadBalancerScope: LoadBalancerScope;
  externalTrafficPolicy: ExternalTrafficPolicy;
}

export interface IngressConfig {
  enabled: boolean;
  host: string;
  path: string;
  tlsEnabled: boolean;
  tlsSecretName: string;
  tlsIssuer: string;
  ingressClassName: string;
  exposure: ServiceExposure;
  loadBalancerScope: LoadBalancerScope;
}

export interface SecurityConfig {
  runAsNonRoot: boolean;
  runAsUser: number;
  readOnlyRootFilesystem: boolean;
  allowPrivilegeEscalation: boolean;
  seccompProfile: 'RuntimeDefault' | 'Localhost' | 'Unconfined';
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
  startupProbe: ProbeConfig;
  autoscaling: AutoscalingConfig;
  workload: WorkloadConfig;
  storage: StorageConfig;
  service: ServiceConfig;
  serviceAccountName: string;
  imagePullSecrets: string[];
  security: SecurityConfig;
  ingress: IngressConfig;
  environmentOverrides?: Partial<Record<EnvironmentName, NodeEnvironmentOverride>>;
}

export interface ArchitectureEdge {
  id: string;
  from: string;
  to: string;
  type: EdgeType;
  latencyBudgetMs: number;
  networkPolicy: NetworkPolicyIntent;
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
