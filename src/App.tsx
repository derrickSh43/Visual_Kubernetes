import { useEffect, useMemo, useRef, useState } from 'react';
import JSZip from 'jszip';
import { builtinGraphTemplates, coreNodeLibrary, createNodeTemplate, starterWorkspace, supportedEnvironments } from './data';
import {
  canConnectNodes,
  detectPattern,
  generateDeploymentPlan,
  getDerivedEnvironmentVariables,
  generateKubernetesDocuments,
  generateKubernetesYaml,
  generateProjectFiles,
  generateTerraform,
  getResolvedModel,
  getProviderProfile,
  inferEdgeType,
  validateArchitecture,
} from './engine';
import {
  loadCustomGraphTemplates,
  loadCustomNodeLibrary,
  loadWorkspace,
  deleteSnapshot,
  loadSnapshots,
  saveCustomGraphTemplates,
  saveCustomNodeLibrary,
  saveSnapshot,
  saveWorkspace,
} from './storage';
import type { ArchitectureEdge, ArchitectureNode, CloudProvider, Cluster, EdgeType, EnvironmentName, GraphTemplate, NetworkPolicyIntent, NodeLibraryItem, NodeType, WorkspaceSnapshot, WorkspaceState } from './types';

function LeftSection({ title, children, noPadding = false, defaultOpen = true }: { title: string; children: React.ReactNode; noPadding?: boolean; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="left-section">
      <button type="button" className="left-section-header" onClick={() => setOpen((v) => !v)}>
        <span className={`section-chevron${open ? '' : ' collapsed'}`}>&#9660;</span>
        <span className="left-section-title">{title}</span>
      </button>
      {open && <div className={noPadding ? 'left-section-body no-padding' : 'left-section-body'}>{children}</div>}
    </div>
  );
}

const nodeColors: Record<NodeType, string> = {
  ingress: '#4dabf7',
  frontend: '#ff6b6b',
  gateway: '#74c0fc',
  service: '#f59f00',
  worker: '#ffd43b',
  database: '#845ef7',
  cache: '#51cf66',
  queue: '#12b886',
  job: '#ffa94d',
  cronjob: '#ff922b',
  networkPolicy: '#15aabf',
  role: '#d9480f',
};

const canvasBounds = {
  width: 1600,
  height: 900,
  nodeWidth: 248,
  nodeHeight: 154,
  maxNodeWidth: 372,
  maxNodeHeight: 231,
  padding: 240,
  minZoom: 0.35,
  maxZoom: 2.25,
};

const nodePortOffsetY = 56;
const nodePortInset = 12;
type NodeSize = { width: number; height: number };
const clusterPadding = 58;
const actionBarItems = [
  { label: 'Compile', icon: 'CHK', intent: 'Validate graph and refresh YAML preview' },
  { label: 'Save', icon: 'SAV', intent: 'Create a local snapshot' },
  { label: 'Browse', icon: 'LIB', intent: 'Open templates and node library browsing' },
  { label: 'Diff', icon: 'DIF', intent: 'Compare current graph against a saved snapshot' },
  { label: 'Find', icon: 'FND', intent: 'Fuzzy-search nodes, edges, and generated resources' },
  { label: 'Blueprint Settings', icon: 'SET', intent: 'Edit stack-wide defaults' },
];

const nodeBehaviorCopy: Record<NodeType, string> = {
  ingress: 'Ingress entrypoint: routes external traffic to frontend, gateway, or service nodes in the same namespace.',
  frontend: 'Frontend deployment: emits Service, optional Ingress, probes, HPA, and dependency environment wiring.',
  gateway: 'Gateway deployment: emits Service, optional Ingress, probes, HPA, and HTTP routing dependencies.',
  service: 'Service deployment: emits Service, probes, HPA, config, secrets, and graph-derived dependency variables.',
  worker: 'Worker deployment: does not emit a Service; connects out to queues, data stores, and APIs.',
  database: 'Stateful database: emits StatefulSet, headless-style storage claims, Service, retention, and backup annotations.',
  cache: 'Stateful cache: emits StatefulSet, Service, storage if enabled, and data dependency endpoints.',
  queue: 'Stateful queue: emits StatefulSet, Service, durable storage, and async dependency endpoints.',
  job: 'One-time batch workload: emits Job only; it can consume dependencies but cannot receive runtime traffic.',
  cronjob: 'Scheduled batch workload: emits CronJob only; it can consume dependencies but cannot receive runtime traffic.',
  networkPolicy: 'Explicit traffic policy: emits a NetworkPolicy from selector labels instead of edge-inferred policy.',
  role: 'Explicit RBAC policy: emits Role and RoleBinding for selected service accounts.',
};

function environmentLabel(environment: EnvironmentName) {
  return environment === 'prod' ? 'Prod' : environment === 'stage' ? 'Stage' : 'Dev';
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function nextLayoutPosition(count: number) {
  const column = count % 4;
  const row = Math.floor(count / 4);
  return {
    x: 80 + column * 280,
    y: 100 + row * 180,
  };
}

function providerRegionDefault(provider: CloudProvider) {
  if (provider === 'gcp') return 'us-central1';
  if (provider === 'azure') return 'eastus';
  if (provider === 'generic') return 'local';
  return 'us-east-1';
}

function nodeRuntimeLabel(node: ArchitectureNode) {
  return `${node.image}:${node.tag}`;
}

function nodeMetaLabels(node: ArchitectureNode) {
  return [
    node.name,
    node.type.toUpperCase(),
    nodeRuntimeLabel(node),
    `ns ${node.namespace} | ${node.workload.kind}`,
    `sa ${node.serviceAccountName}`,
    `rep ${node.replicas} | port ${node.containerPort}`,
  ];
}

function estimateTextWidth(text: string, charWidth = 6.6) {
  return text.length * charWidth;
}

function nodeSizeFor(node: ArchitectureNode): NodeSize {
  const [name, kind, ...bodyLabels] = nodeMetaLabels(node);
  const headerWidth = estimateTextWidth(name, 7.2) + estimateTextWidth(kind, 6.4) + 54;
  const bodyWidth = Math.max(...bodyLabels.map((label) => estimateTextWidth(label, 6.2))) + 34;
  const width = Math.ceil(clamp(Math.max(canvasBounds.nodeWidth, headerWidth, bodyWidth), canvasBounds.nodeWidth, canvasBounds.maxNodeWidth));
  const extraBodyLines = bodyLabels.filter((label) => estimateTextWidth(label, 6.2) + 34 > width).length;
  const height = Math.ceil(clamp(canvasBounds.nodeHeight + extraBodyLines * 16, canvasBounds.nodeHeight, canvasBounds.maxNodeHeight));

  return { width, height };
}

function fitTextLength(text: string, availableWidth: number, charWidth = 6.4) {
  return estimateTextWidth(text, charWidth) > availableWidth ? availableWidth : undefined;
}

function clusterBounds(cluster: Cluster, layout: WorkspaceState['layout'], nodeSizes: Map<string, NodeSize>, excludeNodeId?: string) {
  const positions = cluster.nodeIds
    .filter((nodeId) => nodeId !== excludeNodeId)
    .map((nodeId) => ({ position: layout[nodeId], size: nodeSizes.get(nodeId) ?? { width: canvasBounds.nodeWidth, height: canvasBounds.nodeHeight } }))
    .filter((entry) => entry.position);

  if (positions.length === 0) {
    return null;
  }

  const minX = Math.min(...positions.map(({ position }) => position.x));
  const minY = Math.min(...positions.map(({ position }) => position.y));
  const maxX = Math.max(...positions.map(({ position, size }) => position.x + size.width));
  const maxY = Math.max(...positions.map(({ position, size }) => position.y + size.height));

  return {
    x: minX - clusterPadding,
    y: minY - clusterPadding,
    width: maxX - minX + clusterPadding * 2,
    height: maxY - minY + clusterPadding * 2,
  };
}

function pointInsideRect(point: { x: number; y: number }, rect: { x: number; y: number; width: number; height: number }) {
  return point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height;
}

function cloneWorkspace(workspace: WorkspaceState): WorkspaceState {
  return JSON.parse(JSON.stringify(workspace)) as WorkspaceState;
}

function workspaceSummary(workspace: WorkspaceState) {
  return `${workspace.model.nodes.length} nodes / ${workspace.model.edges.length} edges / ${workspace.model.clusters.length} clusters`;
}

function snapshotTimestamp() {
  return new Date().toISOString();
}

function formatSecretEntry(entry: ArchitectureNode['secretEnv'][number]) {
  if (entry.source === 'existingSecret') {
    return `${entry.key}@${entry.secretName}#${entry.secretKey}`;
  }
  return `${entry.key}=${entry.value}`;
}

function parseSecretEntries(input: string): ArchitectureNode['secretEnv'] {
  return input
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const referenceMatch = line.match(/^([^@=#]+)@([^#=]+)#(.+)$/);
      if (referenceMatch) {
        const [, key, secretName, secretKey] = referenceMatch;
        return {
          source: 'existingSecret' as const,
          key: key.trim(),
          secretName: secretName.trim(),
          secretKey: secretKey.trim(),
        };
      }

      const [key, ...rest] = line.split('=');
      return {
        source: 'inline' as const,
        key: key.trim(),
        value: rest.join('=').trim(),
      };
    });
}

function parseListInput(input: string) {
  return input
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function formatKeyValueEntries(entries: Array<{ key: string; value: string }>) {
  return entries.map((entry) => `${entry.key}=${entry.value}`).join('\n');
}

function parseKeyValueEntries(input: string) {
  return input
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [key, ...rest] = line.split('=');
      return { key: key.trim(), value: rest.join('=').trim() };
    });
}

function formatRoleRules(rules: ArchitectureNode['role']['rules']) {
  return rules.map((rule) => `${rule.apiGroups.join(',')}|${rule.resources.join(',')}|${rule.verbs.join(',')}`).join('\n');
}

function parseRoleRules(input: string): ArchitectureNode['role']['rules'] {
  return input
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [apiGroups = '', resources = '', verbs = ''] = line.split('|');
      return {
        apiGroups: apiGroups.split(',').map((entry) => entry.trim()),
        resources: resources.split(',').map((entry) => entry.trim()).filter(Boolean),
        verbs: verbs.split(',').map((entry) => entry.trim()).filter(Boolean),
      };
    });
}

export function App() {
  const [workspace, setWorkspace] = useState<WorkspaceState>(() => loadWorkspace());
  const [selectedNodeId, setSelectedNodeId] = useState(workspace.model.nodes[0]?.id ?? '');
  const [leftRailOpen, setLeftRailOpen] = useState(true);
  const [rightRailOpen, setRightRailOpen] = useState(true);
  const [rightPanelTab, setRightPanelTab] = useState<'inspector' | 'history'>('inspector');
  const [leftRailWidth, setLeftRailWidth] = useState(380);
  const [rightRailWidth, setRightRailWidth] = useState(420);
  const [exportMode, setExportMode] = useState<'selected-yaml' | 'yaml' | 'terraform'>('yaml');
  const [dockHeight, setDockHeight] = useState(320);
  const [selectedClusterId, setSelectedClusterId] = useState(workspace.model.clusters[0]?.id ?? '');
  const [libraryTab, setLibraryTab] = useState<'core' | 'custom'>('core');
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set());
  const [libraryQuery, setLibraryQuery] = useState('');
  const [selectedLibraryItemId, setSelectedLibraryItemId] = useState(coreNodeLibrary[0]?.id ?? '');
  const [customNodeLibrary, setCustomNodeLibrary] = useState<NodeLibraryItem[]>(() => loadCustomNodeLibrary());
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [templateTab, setTemplateTab] = useState<'builtin' | 'custom'>('builtin');
  const [customGraphTemplates, setCustomGraphTemplates] = useState<GraphTemplate[]>(() => loadCustomGraphTemplates());
  const [selectedTemplateId, setSelectedTemplateId] = useState(builtinGraphTemplates[0]?.id ?? '');
  const [templateSaveName, setTemplateSaveName] = useState('Current graph');
  const [templateSaveNotes, setTemplateSaveNotes] = useState('Saved from the current workspace.');
  const [snapshots, setSnapshots] = useState<WorkspaceSnapshot[]>([]);
  const [selectedSnapshotId, setSelectedSnapshotId] = useState('');
  const [snapshotMessage, setSnapshotMessage] = useState('Snapshots capture the full graph, layout, clusters, and generated config state.');
  const [actionStatus, setActionStatus] = useState('Graph editor ready');
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [blueprintSettingsOpen, setBlueprintSettingsOpen] = useState(false);
  const [clusterDefaultsOpen, setClusterDefaultsOpen] = useState(false);
  const [simulationActive, setSimulationActive] = useState(false);
  const [playPreviewOpen, setPlayPreviewOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [canvasConnectMode, setCanvasConnectMode] = useState(false);
  const [canvasViewport, setCanvasViewport] = useState({ x: 0, y: 0, scale: 1 });
  const [spacePressed, setSpacePressed] = useState(false);
  const [canvasPanning, setCanvasPanning] = useState(false);
  const [dragConnection, setDragConnection] = useState<{ fromId: string; x: number; y: number; hoveredNodeId: string | null } | null>(null);
  const [connectionMessage, setConnectionMessage] = useState<{ tone: 'neutral' | 'success' | 'error'; text: string }>({
    tone: 'neutral',
    text: 'Select a source and target, or use Connect on stage from the selected node.',
  });
  const [edgeDraft, setEdgeDraft] = useState<{ from: string; to: string; type: EdgeType; latencyBudgetMs: number; networkPolicy: NetworkPolicyIntent }>({
    from: workspace.model.nodes[0]?.id ?? '',
    to: workspace.model.nodes[1]?.id ?? '',
    type: 'http',
    latencyBudgetMs: 100,
    networkPolicy: 'allow',
  });

  const dragRef = useRef<{ nodeId: string; offsetX: number; offsetY: number } | null>(null);
  const dockResizeRef = useRef<{ startY: number; startHeight: number } | null>(null);
  const leftRailResizeRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const rightRailResizeRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const canvasPanRef = useRef<{ pointerId: number; startX: number; startY: number; viewportX: number; viewportY: number } | null>(null);
  const canvasSvgRef = useRef<SVGSVGElement | null>(null);
  const edgeSequenceRef = useRef(0);
  const librarySequenceRef = useRef(0);
  const templateSequenceRef = useRef(0);
  const snapshotSequenceRef = useRef(0);
  const undoStackRef = useRef<WorkspaceState[]>([]);
  const redoStackRef = useRef<WorkspaceState[]>([]);

  const model = workspace.model;
  const resolvedModel = useMemo(() => getResolvedModel(model), [model]);
  const layout = workspace.layout;
  const nodeSizes = useMemo(() => new Map(resolvedModel.nodes.map((node) => [node.id, nodeSizeFor(node)])), [resolvedModel.nodes]);
  const virtualCanvas = useMemo(() => {
    const nodeExtents = resolvedModel.nodes
      .map((node) => ({ position: layout[node.id], size: nodeSizes.get(node.id) ?? { width: canvasBounds.nodeWidth, height: canvasBounds.nodeHeight } }))
      .filter((entry) => entry.position);
    if (nodeExtents.length === 0) {
      return { width: canvasBounds.width, height: canvasBounds.height };
    }

    const maxX = Math.max(...nodeExtents.map(({ position, size }) => position.x + size.width + canvasBounds.padding));
    const maxY = Math.max(...nodeExtents.map(({ position, size }) => position.y + size.height + canvasBounds.padding));
    return {
      width: Math.max(canvasBounds.width, Math.ceil(maxX)),
      height: Math.max(canvasBounds.height, Math.ceil(maxY)),
    };
  }, [layout, nodeSizes, resolvedModel.nodes]);
  const validationIssues = useMemo(() => validateArchitecture(model), [model]);
  const deploymentPlan = useMemo(() => generateDeploymentPlan(model), [model]);
  const kubernetesDocuments = useMemo(() => generateKubernetesDocuments(model), [model]);
  const yamlOutput = useMemo(() => generateKubernetesYaml(model), [model]);
  const terraformOutput = useMemo(() => generateTerraform(model), [model]);
  const selectedNode = model.nodes.find((node) => node.id === selectedNodeId) ?? model.nodes[0];
  const selectedCluster = model.clusters.find((cluster) => cluster.id === selectedClusterId) ?? model.clusters[0];
  const selectedNodeResolved = selectedNode ? resolvedModel.nodes.find((node) => node.id === selectedNode.id) : undefined;
  const derivedSelectedNodeEnv = useMemo(() => (selectedNode ? getDerivedEnvironmentVariables(model, selectedNode.id) : []), [model, selectedNode]);
  const providerProfile = useMemo(() => getProviderProfile(model.provider), [model.provider]);
  const validEdgeTargets = useMemo(() => {
    const fromNode = model.nodes.find((node) => node.id === edgeDraft.from);
    if (!fromNode) {
      return [];
    }

    return model.nodes
      .filter((node) => node.id !== fromNode.id)
      .map((node) => ({ node, decision: canConnectNodes(fromNode, node), inferredType: inferEdgeType(fromNode, node) }))
      .filter((entry) => entry.decision.allowed);
  }, [edgeDraft.from, model.nodes]);
  const selectedNodeBehavior = selectedNode ? nodeBehaviorCopy[selectedNode.type] : '';
  const selectedNodeDocuments = useMemo(
    () => (selectedNode ? kubernetesDocuments.filter((document) => document.ownerNodeIds?.includes(selectedNode.id)) : []),
    [kubernetesDocuments, selectedNode],
  );
  const selectedNodeYamlOutput = selectedNodeDocuments.map((document) => document.yaml).join('\n---\n');
  const findResults = useMemo(() => {
    const query = findQuery.trim().toLowerCase();
    if (!query) {
      return model.nodes.slice(0, 8);
    }

    return model.nodes
      .filter((node) => [node.name, node.type, node.namespace, node.image, node.serviceAccountName].some((value) => value.toLowerCase().includes(query)))
      .slice(0, 12);
  }, [findQuery, model.nodes]);
  const activeLibraryItems = libraryTab === 'core' ? coreNodeLibrary : customNodeLibrary;
  const filteredLibraryItems = useMemo(() => {
    const query = libraryQuery.trim().toLowerCase();
    if (!query) {
      return activeLibraryItems;
    }

    return activeLibraryItems.filter((item) =>
      [item.name, item.type, item.description, item.notes].some((value) => value.toLowerCase().includes(query)),
    );
  }, [activeLibraryItems, libraryQuery]);
  const librarySections = useMemo(() => {
    const categoryOrder = ['Entry', 'Workload', 'Data', 'Security', 'Custom'];
    const categoryForItem = (item: NodeLibraryItem) => {
      if (libraryTab === 'custom') return 'Custom';
      if (['ingress', 'gateway', 'frontend'].includes(item.type)) return 'Entry';
      if (['database', 'cache', 'queue'].includes(item.type)) return 'Data';
      if (['networkPolicy', 'role'].includes(item.type)) return 'Security';
      return 'Workload';
    };

    return categoryOrder
      .map((category) => ({ category, items: filteredLibraryItems.filter((item) => categoryForItem(item) === category) }))
      .filter((section) => section.items.length > 0);
  }, [filteredLibraryItems, libraryTab]);
  const selectedLibraryItem = activeLibraryItems.find((item) => item.id === selectedLibraryItemId) ?? activeLibraryItems[0] ?? coreNodeLibrary[0];
  const activeGraphTemplates = templateTab === 'builtin' ? builtinGraphTemplates : customGraphTemplates;
  const selectedGraphTemplate = activeGraphTemplates.find((template) => template.id === selectedTemplateId) ?? activeGraphTemplates[0] ?? builtinGraphTemplates[0];
  const selectedSnapshot = snapshots.find((snapshot) => snapshot.id === selectedSnapshotId) ?? snapshots[0];

  const clusterSummaries = useMemo(
    () =>
      model.clusters.map((cluster) => ({
        cluster,
        bounds: clusterBounds(cluster, layout, nodeSizes),
        nodes: model.nodes.filter((node) => cluster.nodeIds.includes(node.id)),
      })),
    [layout, model.clusters, model.nodes, nodeSizes],
  );

  useEffect(() => {
    saveWorkspace(workspace);
  }, [workspace]);

  useEffect(() => {
    saveCustomNodeLibrary(customNodeLibrary);
  }, [customNodeLibrary]);

  useEffect(() => {
    saveCustomGraphTemplates(customGraphTemplates);
  }, [customGraphTemplates]);

  useEffect(() => {
    let cancelled = false;
    loadSnapshots().then((loadedSnapshots) => {
      if (cancelled) {
        return;
      }
      if (loadedSnapshots.length === 0) {
        return;
      }
      setSnapshots(loadedSnapshots);
      setSelectedSnapshotId(loadedSnapshots[0]?.id ?? '');
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    function handleWindowPointerMove(event: PointerEvent) {
      if (dockResizeRef.current) {
        const delta = dockResizeRef.current.startY - event.clientY;
        setDockHeight(Math.min(620, Math.max(180, dockResizeRef.current.startHeight + delta)));
      }

      if (leftRailResizeRef.current) {
        const delta = event.clientX - leftRailResizeRef.current.startX;
        setLeftRailWidth(Math.min(560, Math.max(360, leftRailResizeRef.current.startWidth + delta)));
      }

      if (rightRailResizeRef.current) {
        const delta = rightRailResizeRef.current.startX - event.clientX;
        setRightRailWidth(Math.min(620, Math.max(340, rightRailResizeRef.current.startWidth + delta)));
      }
    }

    function handleWindowPointerUp() {
      dockResizeRef.current = null;
      leftRailResizeRef.current = null;
      rightRailResizeRef.current = null;
    }

    window.addEventListener('pointermove', handleWindowPointerMove);
    window.addEventListener('pointerup', handleWindowPointerUp);

    return () => {
      window.removeEventListener('pointermove', handleWindowPointerMove);
      window.removeEventListener('pointerup', handleWindowPointerUp);
    };
  }, []);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.code === 'Space') {
        setSpacePressed(true);
      }
    }

    function handleKeyUp(event: KeyboardEvent) {
      if (event.code === 'Space') {
        setSpacePressed(false);
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, []);

  function updateModel(patch: Partial<WorkspaceState['model']>) {
    setWorkspace((current) => ({
      ...current,
      model: {
        ...current.model,
        ...patch,
      },
    }));
  }

  function pushUndoState(previousWorkspace = workspace) {
    undoStackRef.current = [...undoStackRef.current.slice(-24), cloneWorkspace(previousWorkspace)];
    redoStackRef.current = [];
  }

  function replaceWorkspace(nextWorkspace: WorkspaceState, options: { trackUndo?: boolean; message?: string } = {}) {
    if (options.trackUndo ?? true) {
      pushUndoState(workspace);
    }
    setWorkspace(nextWorkspace);
    setSelectedNodeId(nextWorkspace.model.nodes[0]?.id ?? '');
    setSelectedClusterId(nextWorkspace.model.clusters[0]?.id ?? '');
    setSnapshotMessage(options.message ?? `Loaded ${workspaceSummary(nextWorkspace)}.`);
  }

  function undoWorkspaceChange() {
    const previous = undoStackRef.current.at(-1);
    if (!previous) {
      setSnapshotMessage('Nothing to undo.');
      return;
    }
    undoStackRef.current = undoStackRef.current.slice(0, -1);
    redoStackRef.current = [...redoStackRef.current.slice(-24), cloneWorkspace(workspace)];
    setWorkspace(previous);
    setSelectedNodeId(previous.model.nodes[0]?.id ?? '');
    setSelectedClusterId(previous.model.clusters[0]?.id ?? '');
    setSnapshotMessage('Restored previous workspace state from undo stack.');
  }

  function redoWorkspaceChange() {
    const next = redoStackRef.current.at(-1);
    if (!next) {
      setSnapshotMessage('Nothing to redo.');
      return;
    }
    redoStackRef.current = redoStackRef.current.slice(0, -1);
    undoStackRef.current = [...undoStackRef.current.slice(-24), cloneWorkspace(workspace)];
    setWorkspace(next);
    setSelectedNodeId(next.model.nodes[0]?.id ?? '');
    setSelectedClusterId(next.model.clusters[0]?.id ?? '');
    setSnapshotMessage('Reapplied workspace state from redo stack.');
  }

  function createWorkspaceSnapshot(name = `Snapshot ${snapshots.length + 1}`) {
    const createdAt = snapshotTimestamp();
    const snapshotId = `snapshot-${createdAt.replace(/[^0-9]/g, '')}-${snapshotSequenceRef.current++}`;
    const snapshot: WorkspaceSnapshot = {
      id: snapshotId,
      name,
      createdAt,
      summary: workspaceSummary(workspace),
      workspace: cloneWorkspace(workspace),
    };
    const optimisticSnapshots = [snapshot, ...snapshots.filter((entry) => entry.id !== snapshot.id)].slice(0, 50);
    setSnapshots(optimisticSnapshots);
    setSelectedSnapshotId(snapshot.id);
    setRightPanelTab('history');
    setSnapshotMessage(`Saved ${snapshot.name}: ${snapshot.summary}.`);
    void saveSnapshot(snapshot);
  }

  function restoreSelectedSnapshot() {
    if (!selectedSnapshot) {
      setSnapshotMessage('No snapshot selected.');
      return;
    }
    replaceWorkspace(cloneWorkspace(selectedSnapshot.workspace), {
      trackUndo: true,
      message: `Restored ${selectedSnapshot.name}.`,
    });
    setRightPanelTab('history');
  }

  async function removeSelectedSnapshot() {
    if (!selectedSnapshot) {
      setSnapshotMessage('No snapshot selected.');
      return;
    }
    const nextSnapshots = await deleteSnapshot(selectedSnapshot.id);
    setSnapshots(nextSnapshots);
    setSelectedSnapshotId(nextSnapshots[0]?.id ?? '');
    setSnapshotMessage(`Deleted ${selectedSnapshot.name}.`);
  }

  function snapshotDiffSummary(snapshot?: WorkspaceSnapshot) {
    if (!snapshot) {
      return 'Select a snapshot to compare.';
    }
    const current = workspace;
    const previous = snapshot.workspace;
    return [
      `Nodes ${previous.model.nodes.length} -> ${current.model.nodes.length}`,
      `Edges ${previous.model.edges.length} -> ${current.model.edges.length}`,
      `Clusters ${previous.model.clusters.length} -> ${current.model.clusters.length}`,
      `Provider ${previous.model.provider} -> ${current.model.provider}`,
      `Environment ${previous.model.activeEnvironment} -> ${current.model.activeEnvironment}`,
    ].join(' | ');
  }

  function compileGraph() {
    const errorCount = validationIssues.filter((issue) => issue.level === 'error').length;
    const warningCount = validationIssues.filter((issue) => issue.level === 'warning').length;
    setExportMode('yaml');
    setDockHeight((height) => Math.max(height, 360));
    setActionStatus(`Compile complete: ${errorCount} errors / ${warningCount} warnings. YAML preview refreshed.`);
  }

  function openFindCommand() {
    setFindOpen(true);
    setFindQuery(selectedNode?.name ?? '');
    setActionStatus('Find ready: search nodes by name, type, namespace, image, or service account.');
  }

  function selectFoundNode(nodeId: string) {
    setSelectedNodeId(nodeId);
    setRightPanelTab('inspector');
    setRightRailOpen(true);
    setFindOpen(false);
    setActionStatus(`Selected ${model.nodes.find((node) => node.id === nodeId)?.name ?? 'node'} from Find.`);
  }

  function handleActionBarCommand(label: string) {
    switch (label) {
      case 'Compile':
        compileGraph();
        break;
      case 'Save':
        createWorkspaceSnapshot('Manual save');
        setActionStatus('Saved local workspace snapshot.');
        break;
      case 'Browse':
        setTemplatesOpen(true);
        setActionStatus('Template browser opened.');
        break;
      case 'Diff':
        setRightPanelTab('history');
        setRightRailOpen(true);
        setSnapshotMessage(snapshotDiffSummary(selectedSnapshot));
        setActionStatus('Diff compared current graph against the selected snapshot.');
        break;
      case 'Find':
        openFindCommand();
        break;
      case 'Blueprint Settings':
        setBlueprintSettingsOpen(true);
        setActionStatus('Blueprint settings opened.');
        break;
      case 'Cluster Defaults':
        setClusterDefaultsOpen(true);
        setActionStatus('Cluster defaults opened.');
        break;
      case 'Simulate':
        setSimulationActive((active) => !active);
        setActionStatus(`${simulationActive ? 'Stopped' : 'Started'} request-flow simulation across ${model.edges.length} edges.`);
        break;
      case 'Play':
        setPlayPreviewOpen(true);
        setActionStatus('Live preview opened.');
        break;
      default:
        break;
    }
  }

  function updateCluster(clusterId: string, patch: Partial<Cluster>) {
    setWorkspace((current) => ({
      ...current,
      model: {
        ...current.model,
        clusters: current.model.clusters.map((cluster) => (cluster.id === clusterId ? { ...cluster, ...patch } : cluster)),
      },
    }));
  }

  function addCluster() {
    const id = `cluster-${model.clusters.length + 1}`;
    const cluster: Cluster = {
      id,
      name: `Cluster ${model.clusters.length + 1}`,
      provider: model.provider,
      region: providerRegionDefault(model.provider),
      workerCount: 3,
      nodeIds: [],
    };

    setWorkspace((current) => ({
      ...current,
      model: {
        ...current.model,
        clusters: [...current.model.clusters, cluster],
      },
    }));
    setSelectedClusterId(id);
  }

  function assignNodeToCluster(nodeId: string, clusterId: string) {
    setWorkspace((current) => ({
      ...current,
      model: {
        ...current.model,
        clusters: current.model.clusters.map((cluster) => ({
          ...cluster,
          nodeIds:
            cluster.id === clusterId
              ? Array.from(new Set([...cluster.nodeIds, nodeId]))
              : cluster.nodeIds.filter((candidateId) => candidateId !== nodeId),
        })),
      },
    }));
    setSelectedClusterId(clusterId);
  }

  function updateNode(patch: Partial<ArchitectureNode>) {
    if (!selectedNode) {
      return;
    }

    setWorkspace((current) => ({
      ...current,
      model: {
        ...current.model,
        nodes: current.model.nodes.map((node) => (node.id === selectedNode.id ? { ...node, ...patch } : node)),
      },
    }));
  }

  function updateNodeEnvironmentOverride(
    environment: EnvironmentName,
    patch: NonNullable<ArchitectureNode['environmentOverrides']>[EnvironmentName],
  ) {
    if (!selectedNode) {
      return;
    }

    const currentOverride = selectedNode.environmentOverrides?.[environment] ?? {};
    const nextOverride = {
      ...currentOverride,
      ...patch,
      resources: patch?.resources ? { ...currentOverride.resources, ...patch.resources } : currentOverride.resources,
      autoscaling: patch?.autoscaling ? { ...currentOverride.autoscaling, ...patch.autoscaling } : currentOverride.autoscaling,
      ingress: patch?.ingress ? { ...currentOverride.ingress, ...patch.ingress } : currentOverride.ingress,
    };

    updateNode({
      environmentOverrides: {
        ...selectedNode.environmentOverrides,
        [environment]: nextOverride,
      },
    });
  }

  function clientPointToCanvas(svgElement: SVGSVGElement, clientX: number, clientY: number) {
    const svgRect = svgElement.getBoundingClientRect();
    const viewBoxX = (clientX - svgRect.left) * (virtualCanvas.width / svgRect.width);
    const viewBoxY = (clientY - svgRect.top) * (virtualCanvas.height / svgRect.height);

    return {
      x: (viewBoxX - canvasViewport.x) / canvasViewport.scale,
      y: (viewBoxY - canvasViewport.y) / canvasViewport.scale,
      viewBoxX,
      viewBoxY,
    };
  }

  function updateNodePosition(nodeId: string, x: number, y: number) {
    const nodeSize = nodeSizes.get(nodeId) ?? { width: canvasBounds.nodeWidth, height: canvasBounds.nodeHeight };
    const clampedX = clamp(x, 24, virtualCanvas.width - nodeSize.width - 24);
    const clampedY = clamp(y, 24, virtualCanvas.height - nodeSize.height - 24);

    setWorkspace((current) => {
      const nextLayout = {
        ...current.layout,
        [nodeId]: { x: clampedX, y: clampedY },
      };
      const center = {
        x: clampedX + nodeSize.width / 2,
        y: clampedY + nodeSize.height / 2,
      };
      const targetCluster = current.model.clusters.find((cluster) => {
        const bounds = clusterBounds(cluster, nextLayout, nodeSizes, nodeId);
        return bounds ? pointInsideRect(center, bounds) : false;
      });

      return {
        ...current,
        layout: nextLayout,
        model: targetCluster
          ? {
              ...current.model,
              clusters: current.model.clusters.map((cluster) => ({
                ...cluster,
                nodeIds:
                  cluster.id === targetCluster.id
                    ? Array.from(new Set([...cluster.nodeIds, nodeId]))
                    : cluster.nodeIds.filter((candidateId) => candidateId !== nodeId),
              })),
            }
          : current.model,
      };
    });
  }

  function handlePointerMove(event: React.PointerEvent<SVGSVGElement>) {
    if (canvasPanRef.current) {
      const svgRect = event.currentTarget.getBoundingClientRect();
      const deltaX = (event.clientX - canvasPanRef.current.startX) * (virtualCanvas.width / svgRect.width);
      const deltaY = (event.clientY - canvasPanRef.current.startY) * (virtualCanvas.height / svgRect.height);
      setCanvasViewport((current) => ({
        ...current,
        x: canvasPanRef.current ? canvasPanRef.current.viewportX + deltaX : current.x,
        y: canvasPanRef.current ? canvasPanRef.current.viewportY + deltaY : current.y,
      }));
      return;
    }

    const { x: svgX, y: svgY } = clientPointToCanvas(event.currentTarget, event.clientX, event.clientY);

    if (dragRef.current) {
      const x = svgX - dragRef.current.offsetX;
      const y = svgY - dragRef.current.offsetY;
      updateNodePosition(dragRef.current.nodeId, x, y);
    }

    if (dragConnection) {
      let hoveredNodeId: string | null = null;
      for (const node of resolvedModel.nodes) {
        if (node.id === dragConnection.fromId) continue;
        const pos = layout[node.id];
        const size = nodeSizes.get(node.id) ?? { width: canvasBounds.nodeWidth, height: canvasBounds.nodeHeight };
        if (!pos) continue;
        if (
          svgX >= pos.x &&
          svgX <= pos.x + size.width &&
          svgY >= pos.y &&
          svgY <= pos.y + size.height
        ) {
          hoveredNodeId = node.id;
          break;
        }
      }
      setDragConnection((current) => (current ? { ...current, x: svgX, y: svgY, hoveredNodeId } : current));
    }
  }

  function handleSVGPointerUp() {
    if (dragConnection) {
      if (dragConnection.hoveredNodeId) {
        const fromNode = resolvedModel.nodes.find((n) => n.id === dragConnection.fromId);
        const toNode = resolvedModel.nodes.find((n) => n.id === dragConnection.hoveredNodeId);
        if (fromNode && toNode) {
          const decision = canConnectNodes(fromNode, toNode);
          if (decision.allowed) {
            addEdge(dragConnection.fromId, dragConnection.hoveredNodeId);
            setSelectedNodeId(dragConnection.hoveredNodeId);
          } else {
            setConnectionMessage({ tone: 'error', text: decision.reason });
          }
        }
      }
      setDragConnection(null);
    }
    canvasPanRef.current = null;
    setCanvasPanning(false);
    dragRef.current = null;
  }

  function handleSVGPointerLeave() {
    canvasPanRef.current = null;
    setCanvasPanning(false);
    dragRef.current = null;
  }

  function addNodeFromLibrary(item: NodeLibraryItem, positionOverride?: { x: number; y: number }) {
    const previousSelectedNodeId = selectedNode?.id ?? model.nodes[0]?.id ?? '';
    const template = createNodeTemplate(item.type, model.defaultNamespace);
    const node = {
      ...template,
      ...item.overrides,
      id: template.id,
      namespace: item.overrides?.namespace ?? template.namespace,
      serviceAccountName: item.overrides?.serviceAccountName ?? template.serviceAccountName,
      environmentOverrides: {
        ...template.environmentOverrides,
        ...item.overrides?.environmentOverrides,
      },
    };
    const position = positionOverride ?? nextLayoutPosition(model.nodes.length);
    const sourceNode = model.nodes.find((candidate) => candidate.id === previousSelectedNodeId);
    const suggestedType = sourceNode ? inferEdgeType(sourceNode, node) : 'http';

    setWorkspace((current) => ({
      model: {
        ...current.model,
        nodes: [...current.model.nodes, node],
        clusters: current.model.clusters.map((cluster, index) =>
          cluster.id === (selectedCluster?.id ?? current.model.clusters[0]?.id) || (!selectedCluster && index === 0)
            ? { ...cluster, nodeIds: Array.from(new Set([...cluster.nodeIds, node.id])) }
            : cluster,
        ),
        edges: current.model.edges,
      },
      layout: {
        ...current.layout,
        [node.id]: position,
      },
    }));

    setSelectedNodeId(node.id);
    setEdgeDraft((current) => ({
      ...current,
      from: previousSelectedNodeId || node.id,
      to: node.id,
      type: suggestedType,
    }));
    setConnectionMessage({
      tone: 'neutral',
      text: `${node.name} added from ${item.name}. Connect it from the stage or use the connection form.`,
    });
  }

  function saveSelectedNodeAsCustomTile() {
    if (!selectedNode) {
      return;
    }

    const item: NodeLibraryItem = {
      id: `custom-${librarySequenceRef.current++}`,
      type: selectedNode.type,
      name: selectedNode.name,
      description: `${selectedNode.type} template`,
      notes: `Saved from ${selectedNode.name}. Reuses image, tag, probes, resources, storage, ingress, and policy settings.`,
      icon: selectedNode.type.slice(0, 2).toUpperCase(),
      overrides: {
        ...selectedNode,
        id: undefined,
        name: selectedNode.name,
      } as Partial<ArchitectureNode>,
    };

    setCustomNodeLibrary((current) => [...current, item]);
    setLibraryTab('custom');
    setSelectedLibraryItemId(item.id);
  }

  function updateCustomLibraryItem(itemId: string, patch: Partial<NodeLibraryItem>) {
    setCustomNodeLibrary((current) => current.map((item) => (item.id === itemId ? { ...item, ...patch } : item)));
  }

  function deleteCustomLibraryItem(itemId: string) {
    setCustomNodeLibrary((current) => current.filter((item) => item.id !== itemId));
    if (selectedLibraryItemId === itemId) {
      setSelectedLibraryItemId(customNodeLibrary.find((item) => item.id !== itemId)?.id ?? coreNodeLibrary[0]?.id ?? '');
    }
  }

  function templateWorkspaceForMerge(template: GraphTemplate): WorkspaceState {
    const source = cloneWorkspace(template.workspace);
    const suffix = `tpl-${templateSequenceRef.current++}`;
    const nodeIdMap = new Map(source.model.nodes.map((node) => [node.id, `${node.id}-${suffix}`]));
    const clusterIdMap = new Map(source.model.clusters.map((cluster) => [cluster.id, `${cluster.id}-${suffix}`]));
    const existingPositions = Object.values(layout);
    const existingNodesByPosition = model.nodes
      .map((node) => ({ position: layout[node.id], size: nodeSizes.get(node.id) ?? { width: canvasBounds.nodeWidth, height: canvasBounds.nodeHeight } }))
      .filter((entry) => entry.position);
    const offsetX = existingPositions.length > 0
      ? Math.max(...existingNodesByPosition.map(({ position, size }) => position.x + size.width)) + 180
      : 120;
    const offsetY = 80;

    return {
      model: {
        ...source.model,
        nodes: source.model.nodes.map((node) => ({
          ...node,
          id: nodeIdMap.get(node.id) ?? node.id,
          name: `${node.name} copy`,
          serviceAccountName: `${node.serviceAccountName}-${suffix}`,
        })),
        edges: source.model.edges.map((edge) => ({
          ...edge,
          id: `${edge.id}-${suffix}`,
          from: nodeIdMap.get(edge.from) ?? edge.from,
          to: nodeIdMap.get(edge.to) ?? edge.to,
        })),
        clusters: source.model.clusters.map((cluster) => ({
          ...cluster,
          id: clusterIdMap.get(cluster.id) ?? cluster.id,
          name: `${cluster.name} copy`,
          nodeIds: cluster.nodeIds.map((nodeId) => nodeIdMap.get(nodeId) ?? nodeId),
        })),
      },
      layout: Object.fromEntries(
        Object.entries(source.layout).map(([nodeId, position]) => [
          nodeIdMap.get(nodeId) ?? nodeId,
          {
            x: position.x + offsetX,
            y: position.y + offsetY,
          },
        ]),
      ),
    };
  }

  function loadGraphTemplate(template: GraphTemplate, mode: 'replace' | 'merge') {
    void createWorkspaceSnapshot(`Before template ${mode}`);
    if (mode === 'replace') {
      const nextWorkspace = cloneWorkspace(template.workspace);
      replaceWorkspace(nextWorkspace, { trackUndo: true, message: `Loaded template ${template.name}.` });
      setCanvasViewport({ x: 0, y: 0, scale: 1 });
      setTemplatesOpen(false);
      return;
    }

    const incoming = templateWorkspaceForMerge(template);
    pushUndoState(workspace);
    setWorkspace((current) => ({
      model: {
        ...current.model,
        nodes: [...current.model.nodes, ...incoming.model.nodes],
        edges: [...current.model.edges, ...incoming.model.edges],
        clusters: [...current.model.clusters, ...incoming.model.clusters],
      },
      layout: {
        ...current.layout,
        ...incoming.layout,
      },
    }));
    setSelectedNodeId(incoming.model.nodes[0]?.id ?? selectedNodeId);
    setSelectedClusterId(incoming.model.clusters[0]?.id ?? selectedClusterId);
    setSnapshotMessage(`Merged template ${template.name} with offset.`);
    setTemplatesOpen(false);
  }

  function saveCurrentGraphTemplate() {
    const id = `template-custom-${templateSequenceRef.current++}`;
    const template: GraphTemplate = {
      id,
      name: templateSaveName.trim() || workspace.model.name,
      notes: templateSaveNotes.trim() || 'Saved from the current workspace.',
      thumbnail: `${workspace.model.nodes.length} nodes / ${workspace.model.edges.length} edges / ${workspace.model.clusters.length} clusters`,
      workspace: cloneWorkspace(workspace),
      createdAt: `session-${templateSequenceRef.current}`,
    };
    setCustomGraphTemplates((current) => [...current, template]);
    setTemplateTab('custom');
    setSelectedTemplateId(id);
  }

  function deleteCustomGraphTemplate(templateId: string) {
    setCustomGraphTemplates((current) => current.filter((template) => template.id !== templateId));
    if (selectedTemplateId === templateId) {
      setSelectedTemplateId(customGraphTemplates.find((template) => template.id !== templateId)?.id ?? builtinGraphTemplates[0]?.id ?? '');
    }
  }

  function addEdge(fromId = edgeDraft.from, toId = edgeDraft.to, explicitType?: EdgeType) {
    let outcome:
      | { tone: 'success'; text: string; edgeType: EdgeType }
      | { tone: 'error'; text: string }
      | undefined;

    setWorkspace((current) => {
      const fromNode = current.model.nodes.find((node) => node.id === fromId);
      const toNode = current.model.nodes.find((node) => node.id === toId);
      if (!fromNode || !toNode) {
        outcome = { tone: 'error', text: 'Pick both nodes before adding a connection.' };
        return current;
      }

      const decision = canConnectNodes(fromNode, toNode);
      if (!decision.allowed) {
        outcome = { tone: 'error', text: decision.reason };
        return current;
      }

      const type = explicitType ?? decision.edgeType ?? inferEdgeType(fromNode, toNode);
      const duplicate = current.model.edges.some((edge) => edge.from === fromId && edge.to === toId && edge.type === type);
      if (duplicate) {
        outcome = { tone: 'error', text: `${fromNode.name} is already connected to ${toNode.name}.` };
        return current;
      }

      const newEdge: ArchitectureEdge = {
        id: `edge-${edgeSequenceRef.current++}`,
        from: fromId,
        to: toId,
        type,
        latencyBudgetMs: edgeDraft.latencyBudgetMs,
        networkPolicy: edgeDraft.networkPolicy,
      };

      outcome = {
        tone: 'success',
        text: `Connected ${fromNode.name} to ${toNode.name} using ${type}.`,
        edgeType: type,
      };

      return {
        ...current,
        model: {
          ...current.model,
          edges: [...current.model.edges, newEdge],
        },
      };
    });

    if (!outcome) {
      return;
    }

    setConnectionMessage({ tone: outcome.tone, text: outcome.text });

    if (outcome.tone === 'success') {
      const edgeType = outcome.edgeType;
      setEdgeDraft((current) => ({
        ...current,
        from: toId,
        type: edgeType,
      }));
    }
  }

  function handleCanvasNodeClick(nodeId: string) {
    if (dragConnection) {
      return;
    }

    if (!canvasConnectMode || !selectedNode || selectedNode.id === nodeId) {
      setSelectedNodeId(nodeId);
      return;
    }

    addEdge(selectedNode.id, nodeId);
    setSelectedNodeId(nodeId);
    if (canConnectNodes(selectedNode, model.nodes.find((node) => node.id === nodeId) ?? selectedNode).allowed) {
      setCanvasConnectMode(false);
    }
  }

  function deleteSelectedNode() {
    if (!selectedNode) {
      return;
    }

    setWorkspace((current) => {
      const nextNodes = current.model.nodes.filter((node) => node.id !== selectedNode.id);
      const nextEdges = current.model.edges.filter((edge) => edge.from !== selectedNode.id && edge.to !== selectedNode.id);
      const nextLayout = { ...current.layout };
      delete nextLayout[selectedNode.id];

      return {
        model: {
          ...current.model,
          nodes: nextNodes,
          edges: nextEdges,
          clusters: current.model.clusters.map((cluster) => ({
            ...cluster,
            nodeIds: cluster.nodeIds.filter((nodeId) => nodeId !== selectedNode.id),
          })),
        },
        layout: nextLayout,
      };
    });

    setSelectedNodeId(model.nodes.find((node) => node.id !== selectedNode.id)?.id ?? '');
    setCanvasConnectMode(false);
  }

  function resetWorkspace() {
    setWorkspace(starterWorkspace);
    setSelectedNodeId(starterWorkspace.model.nodes[0]?.id ?? '');
    setSelectedClusterId(starterWorkspace.model.clusters[0]?.id ?? '');
    setCanvasConnectMode(false);
    setEdgeDraft({
      from: starterWorkspace.model.nodes[0]?.id ?? '',
      to: starterWorkspace.model.nodes[1]?.id ?? '',
      type: 'http',
      latencyBudgetMs: 100,
      networkPolicy: 'allow',
    });
  }

  function applyProdReadyProfile() {
    if (!selectedNode) {
      return;
    }

    updateNode({
      replicas: Math.max(selectedNode.replicas, 3),
      tag: selectedNode.tag === 'latest' ? '1.0.0' : selectedNode.tag,
      resources: {
        ...selectedNode.resources,
        requestsCpu: selectedNode.resources.requestsCpu || '250m',
        requestsMemory: selectedNode.resources.requestsMemory || '256Mi',
        limitsCpu: selectedNode.resources.limitsCpu || '1000m',
        limitsMemory: selectedNode.resources.limitsMemory || '1Gi',
      },
      autoscaling:
        selectedNode.workload.kind === 'Deployment'
          ? {
              ...selectedNode.autoscaling,
              enabled: true,
              minReplicas: Math.max(selectedNode.autoscaling.minReplicas, 2),
              maxReplicas: Math.max(selectedNode.autoscaling.maxReplicas, 6),
            }
          : selectedNode.autoscaling,
      environmentOverrides: {
        ...selectedNode.environmentOverrides,
        prod: {
          ...selectedNode.environmentOverrides?.prod,
          replicas: Math.max(selectedNode.environmentOverrides?.prod?.replicas ?? selectedNode.replicas, 3),
          tag: selectedNode.environmentOverrides?.prod?.tag ?? (selectedNode.tag === 'latest' ? '1.0.0' : selectedNode.tag),
        },
      },
    });
  }

  function applyPublicTlsIngress() {
    if (!selectedNode) {
      return;
    }

    updateNode({
      ingress: {
        ...selectedNode.ingress,
        enabled: true,
        exposure: 'external',
        loadBalancerScope: 'public',
        tlsEnabled: true,
        tlsIssuer: selectedNode.ingress.tlsIssuer || 'letsencrypt-prod',
        tlsSecretName: selectedNode.ingress.tlsSecretName || `${selectedNode.id}-tls`,
      },
    });
  }

  function applyDurableStorageProfile() {
    if (!selectedNode) {
      return;
    }

    updateNode({
      storage: {
        ...selectedNode.storage,
        enabled: true,
        retainOnDelete: 'Retain',
        retainOnScaleDown: 'Retain',
        backupEnabled: true,
        size: selectedNode.type === 'database' && parseInt(selectedNode.storage.size, 10) < 20 ? '20Gi' : selectedNode.storage.size,
      },
    });
  }

  async function downloadBundle() {
    const zip = new JSZip();
    for (const file of generateProjectFiles(model)) {
      zip.file(file.path, file.content);
    }
    const blob = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${model.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'visual-kubernetes'}-infra.zip`;
    link.click();
    URL.revokeObjectURL(url);
  }

  function downloadSingleFile(filename: string, content: string) {
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  }

  async function copyText(content: string) {
    if (!content) {
      return;
    }
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(content);
      return;
    }

    const textarea = document.createElement('textarea');
    textarea.value = content;
    textarea.setAttribute('readonly', 'true');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
  }

  const selectedNodeExportFilename = selectedNode ? `${selectedNode.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') || selectedNode.id}.yaml` : 'selected-node.yaml';
  const exportText = exportMode === 'terraform' ? terraformOutput : exportMode === 'selected-yaml' ? selectedNodeYamlOutput : yamlOutput;
  const exportLabel = exportMode === 'terraform' ? 'terraform export' : exportMode === 'selected-yaml' ? 'selected node yaml export' : 'yaml export';

  function handleCanvasWheel(event: React.WheelEvent<SVGSVGElement>) {
    event.preventDefault();
    const point = clientPointToCanvas(event.currentTarget, event.clientX, event.clientY);
    const zoomDelta = event.deltaY > 0 ? 0.9 : 1.1;
    const nextScale = clamp(canvasViewport.scale * zoomDelta, canvasBounds.minZoom, canvasBounds.maxZoom);

    setCanvasViewport({
      scale: nextScale,
      x: point.viewBoxX - point.x * nextScale,
      y: point.viewBoxY - point.y * nextScale,
    });
  }

  function handleCanvasPointerDown(event: React.PointerEvent<SVGSVGElement>) {
    const isCanvasBackground =
      event.target === event.currentTarget ||
      (event.target instanceof SVGElement && event.target.classList.contains('canvas-hit-area'));
    const shouldPan = isCanvasBackground && (event.button === 0 || event.button === 1 || spacePressed);
    if (!shouldPan) {
      return;
    }

    canvasPanRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      viewportX: canvasViewport.x,
      viewportY: canvasViewport.y,
    };
    setCanvasPanning(true);
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  }

  function handleCanvasDrop(event: React.DragEvent<HTMLElement>) {
    event.preventDefault();
    const raw = event.dataTransfer.getData('application/visual-kubernetes-node');
    if (!raw || !canvasSvgRef.current) {
      return;
    }

    try {
      const parsed = JSON.parse(raw) as { source: 'core' | 'custom'; id: string };
      const sourceItems = parsed.source === 'custom' ? customNodeLibrary : coreNodeLibrary;
      const item = sourceItems.find((candidate) => candidate.id === parsed.id);
      if (!item) {
        return;
      }

      const point = clientPointToCanvas(canvasSvgRef.current, event.clientX, event.clientY);
      const previewNode = createNodeTemplate(item.type, model.defaultNamespace);
      const previewSize = nodeSizeFor({ ...previewNode, ...item.overrides });
      const position = Number.isFinite(point.x) && Number.isFinite(point.y)
        ? {
            x: clamp(point.x - previewSize.width / 2, 24, virtualCanvas.width - previewSize.width - 24),
            y: clamp(point.y - 36, 24, virtualCanvas.height - previewSize.height - 24),
          }
        : undefined;
      addNodeFromLibrary(item, position);
    } catch {
      setConnectionMessage({ tone: 'error', text: 'Could not read the dragged node tile.' });
    }
  }

  function resetCanvasView() {
    setCanvasViewport({ x: 0, y: 0, scale: 1 });
  }

  function fitCanvasToContent() {
    const extents = resolvedModel.nodes
      .map((node) => ({ position: layout[node.id], size: nodeSizes.get(node.id) ?? { width: canvasBounds.nodeWidth, height: canvasBounds.nodeHeight } }))
      .filter((entry) => entry.position);
    if (extents.length === 0) {
      resetCanvasView();
      return;
    }

    const minX = Math.min(...extents.map(({ position }) => position.x));
    const minY = Math.min(...extents.map(({ position }) => position.y));
    const maxX = Math.max(...extents.map(({ position, size }) => position.x + size.width));
    const maxY = Math.max(...extents.map(({ position, size }) => position.y + size.height));
    const contentWidth = Math.max(maxX - minX, canvasBounds.nodeWidth);
    const contentHeight = Math.max(maxY - minY, canvasBounds.nodeHeight);
    const margin = 96;
    const fitScale = clamp(
      Math.min((virtualCanvas.width - margin * 2) / contentWidth, (virtualCanvas.height - margin * 2) / contentHeight),
      canvasBounds.minZoom,
      1.4,
    );

    setCanvasViewport({
      scale: fitScale,
      x: margin - minX * fitScale,
      y: margin - minY * fitScale,
    });
  }

  function autoLayoutGraph() {
    const nextLayout = model.nodes.reduce<WorkspaceState['layout']>((next, node, index) => {
      const column = index % 4;
      const row = Math.floor(index / 4);
      next[node.id] = {
        x: 120 + column * (canvasBounds.maxNodeWidth + 90),
        y: 120 + row * (canvasBounds.maxNodeHeight + 90),
      };
      return next;
    }, {});

    setWorkspace((current) => ({ ...current, layout: nextLayout }));
    setActionStatus(`Auto-layout arranged ${model.nodes.length} nodes.`);
  }

  function handleMenuCommand(command: string) {
    setOpenMenu(null);
    switch (command) {
      case 'new':
        resetWorkspace();
        setActionStatus('Started a new starter workspace.');
        break;
      case 'save':
        handleActionBarCommand('Save');
        break;
      case 'import-yaml':
        setActionStatus('Import YAML is queued for a future parser pass.');
        break;
      case 'export-zip':
        void downloadBundle();
        setActionStatus('Export ZIP started.');
        break;
      case 'undo':
        undoWorkspaceChange();
        break;
      case 'redo':
        redoWorkspaceChange();
        break;
      case 'find':
        handleActionBarCommand('Find');
        break;
      case 'node-library':
        setLeftRailOpen(true);
        setLibraryTab('core');
        setActionStatus('Node library focused in the Components rail.');
        break;
      case 'templates':
        handleActionBarCommand('Browse');
        break;
      case 'fit':
        fitCanvasToContent();
        setActionStatus('Canvas fit to current graph content.');
        break;
      case 'zoom-100':
        resetCanvasView();
        setActionStatus('Canvas zoom reset to 100%.');
        break;
      case 'toggle-palette':
        setLeftRailOpen((value) => !value);
        setActionStatus(`${leftRailOpen ? 'Hid' : 'Showed'} Components palette.`);
        break;
      case 'toggle-inspector':
        setRightRailOpen((value) => !value);
        setActionStatus(`${rightRailOpen ? 'Hid' : 'Showed'} Inspector.`);
        break;
      case 'toggle-dock':
        setDockHeight((height) => (height <= 64 ? 320 : 48));
        setActionStatus('Toggled output dock height.');
        break;
      case 'validate':
      case 'compile':
        handleActionBarCommand('Compile');
        break;
      case 'auto-layout':
        autoLayoutGraph();
        break;
      case 'detect-pattern':
        setActionStatus(`Detected graph pattern: ${detectPattern(model)}.`);
        break;
      case 'edge-filters':
        setActionStatus('Edge filters are queued for a later graph filtering pass.');
        break;
      case 'simulate':
        handleActionBarCommand('Simulate');
        break;
      case 'diff':
        handleActionBarCommand('Diff');
        break;
      case 'docs':
        setActionStatus('Generate docs is queued for a later documentation export pass.');
        break;
      case 'shortcuts':
      case 'about':
        setHelpOpen(true);
        break;
      default:
        break;
    }
  }

  const menuGroups = [
    {
      label: 'File',
      commands: [
        { label: 'New', command: 'new' },
        { label: 'Save Snapshot', command: 'save' },
        { label: 'Import YAML', command: 'import-yaml' },
        { label: 'Export ZIP', command: 'export-zip' },
      ],
    },
    {
      label: 'Edit',
      commands: [
        { label: 'Undo', command: 'undo' },
        { label: 'Redo', command: 'redo' },
        { label: 'Find', command: 'find' },
      ],
    },
    {
      label: 'Asset',
      commands: [
        { label: 'Node Library', command: 'node-library' },
        { label: 'Templates', command: 'templates' },
      ],
    },
    {
      label: 'View',
      commands: [
        { label: 'Fit to Content', command: 'fit' },
        { label: 'Zoom 100%', command: 'zoom-100' },
        { label: leftRailOpen ? 'Hide Palette' : 'Show Palette', command: 'toggle-palette' },
        { label: rightRailOpen ? 'Hide Inspector' : 'Show Inspector', command: 'toggle-inspector' },
        { label: 'Toggle Dock', command: 'toggle-dock' },
      ],
    },
    {
      label: 'Graph',
      commands: [
        { label: 'Validate', command: 'validate' },
        { label: 'Auto-layout', command: 'auto-layout' },
        { label: 'Detect Pattern', command: 'detect-pattern' },
        { label: 'Edge Filters', command: 'edge-filters' },
      ],
    },
    {
      label: 'Tools',
      commands: [
        { label: 'Compile', command: 'compile' },
        { label: 'Simulate', command: 'simulate' },
        { label: 'Diff', command: 'diff' },
        { label: 'Generate Docs', command: 'docs' },
      ],
    },
    {
      label: 'Help',
      commands: [
        { label: 'Shortcuts', command: 'shortcuts' },
        { label: 'About', command: 'about' },
      ],
    },
  ];

  function startHandleConnection(nodeId: string, event: React.PointerEvent<SVGCircleElement>) {
    const svgEl = event.currentTarget.ownerSVGElement;
    if (!svgEl) {
      return;
    }

    const { x: svgX, y: svgY } = clientPointToCanvas(svgEl, event.clientX, event.clientY);

    setSelectedNodeId(nodeId);
    setCanvasConnectMode(false);
    setDragConnection({ fromId: nodeId, x: svgX, y: svgY, hoveredNodeId: null });
    setEdgeDraft((current) => ({ ...current, from: nodeId }));
    setConnectionMessage({
      tone: 'neutral',
      text: 'Drag to a target node to create a connection.',
    });
    // Capture on the SVG so pointermove/pointerup fire there regardless of what element is under the cursor
    svgEl.setPointerCapture(event.pointerId);
    event.stopPropagation();
  }

  return (
    <div className="app-frame">
      <header className="editor-chrome">
        <div className="editor-menubar">
          <div className="editor-brand">
            <span className="editor-brand-mark">VK</span>
            <span className="editor-brand-text">Visual Kubernetes</span>
          </div>
          <nav className="editor-menu-items" aria-label="Editor menu">
            {menuGroups.map((item) => (
              <div key={item.label} className="menu-group">
                <button
                  type="button"
                  className={openMenu === item.label ? 'menu-button active' : 'menu-button'}
                  aria-haspopup="menu"
                  aria-expanded={openMenu === item.label}
                  onClick={() => setOpenMenu((current) => (current === item.label ? null : item.label))}
                >
                  {item.label}
                </button>
                {openMenu === item.label && (
                  <div className="menu-dropdown" role="menu" aria-label={`${item.label} menu`}>
                    {item.commands.map((command) => (
                      <button key={command.command} type="button" role="menuitem" onClick={() => handleMenuCommand(command.command)}>
                        {command.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </nav>
          <div className="editor-context">
            {model.activeEnvironment.toUpperCase()} | Provider {model.provider.toUpperCase()}
          </div>
        </div>

        <div className="editor-actionbar">
          <div className="editor-action-group">
            {actionBarItems.map((item) => (
              <button
                key={item.label}
                type="button"
                className="chrome-button command-button"
                title={item.intent}
                aria-label={item.label}
                onClick={() => handleActionBarCommand(item.label)}
              >
                <span className="command-icon" aria-hidden="true">{item.icon}</span>
                <span>{item.label}</span>
              </button>
            ))}
          </div>
          <div className="editor-action-group environment-switcher" aria-label="Environment switcher">
            {supportedEnvironments.map((environment) => (
              <button
                key={environment}
                type="button"
                className={model.activeEnvironment === environment ? 'chrome-button active' : 'chrome-button'}
                onClick={() => updateModel({ activeEnvironment: environment })}
                aria-pressed={model.activeEnvironment === environment}
              >
                {environmentLabel(environment)}
              </button>
            ))}
          </div>
          <div className="editor-action-group">
            <button
              type="button"
              className={clusterDefaultsOpen ? 'chrome-button command-button active' : 'chrome-button command-button'}
              title="Edit per-cluster defaults once clusters exist"
              aria-label="Cluster Defaults"
              onClick={() => handleActionBarCommand('Cluster Defaults')}
            >
              <span className="command-icon" aria-hidden="true">CL</span>
              <span>Cluster Defaults</span>
            </button>
            <button
              type="button"
              className={simulationActive ? 'chrome-button command-button active' : 'chrome-button command-button'}
              title="Animate traffic and failure behavior across graph edges"
              aria-label="Simulate"
              onClick={() => handleActionBarCommand('Simulate')}
            >
              <span className="command-icon" aria-hidden="true">SIM</span>
              <span>Simulate</span>
            </button>
            <button
              type="button"
              className={playPreviewOpen ? 'chrome-button command-button active' : 'chrome-button command-button'}
              title="Open read-only live preview output with diff markers"
              aria-label="Play"
              onClick={() => handleActionBarCommand('Play')}
            >
              <span className="command-icon" aria-hidden="true">RUN</span>
              <span>Play</span>
            </button>
          </div>
          <div className="editor-top-status">{actionStatus}</div>
        </div>
      </header>

      <div className="tool-shell">
      <aside className={`rail left-rail ${leftRailOpen ? 'open' : 'collapsed'}`} style={leftRailOpen ? { width: `${leftRailWidth}px` } : undefined}>
        <div className="rail-header">
          <strong>Components</strong>
          <button type="button" className="icon-button" onClick={() => setLeftRailOpen((value) => !value)}>
            {leftRailOpen ? 'Hide' : 'Show'}
          </button>
        </div>
        {leftRailOpen && (
          <div className="rail-content">
            <LeftSection title="Project">
              <div className="field-grid">
                <label>
                  Stack name
                  <input value={model.name} onChange={(event) => updateModel({ name: event.target.value })} />
                </label>
                <label>
                  Default namespace
                  <input value={model.defaultNamespace} onChange={(event) => updateModel({ defaultNamespace: event.target.value })} />
                </label>
                <label>
                  Provider
                  <select
                    value={model.provider}
                    onChange={(event) => updateModel({ provider: event.target.value as WorkspaceState['model']['provider'] })}
                  >
                    <option value="aws">AWS</option>
                    <option value="gcp">GCP</option>
                    <option value="azure">Azure</option>
                    <option value="generic">Generic</option>
                  </select>
                </label>
                <label>
                  Environment
                  <select
                    value={model.activeEnvironment}
                    onChange={(event) => updateModel({ activeEnvironment: event.target.value as EnvironmentName })}
                  >
                    {supportedEnvironments.map((environment) => (
                      <option key={environment} value={environment}>
                        {environment}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="node-type-description span-two">
                  {providerProfile.storageClassName} storage | {providerProfile.ingressClassName} ingress | {providerProfile.loadBalancerMode}
                </div>
              </div>
            </LeftSection>

            <LeftSection title="Node Library" noPadding>
              <div className="node-library-search-row">
                <label className="node-library-search">
                  <span className="sr-only">Search node library</span>
                  <span className="node-library-search-icon">&#9906;</span>
                  <input
                    aria-label="Search node library"
                    placeholder="Search..."
                    value={libraryQuery}
                    onChange={(event) => setLibraryQuery(event.target.value)}
                  />
                </label>
                <div className="node-library-tab-pills" role="tablist" aria-label="Node library tabs">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={libraryTab === 'core'}
                    className={libraryTab === 'core' ? 'lib-pill active' : 'lib-pill'}
                    onClick={() => { setLibraryTab('core'); setCollapsedSections(new Set()); }}
                  >
                    Core
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={libraryTab === 'custom'}
                    className={libraryTab === 'custom' ? 'lib-pill active' : 'lib-pill'}
                    onClick={() => { setLibraryTab('custom'); setCollapsedSections(new Set()); }}
                  >
                    Custom
                  </button>
                </div>
              </div>

              <div className="node-library-grid" aria-label="Node library">
                {librarySections.length > 0 ? (
                  librarySections.map((section) => {
                    const isCollapsed = collapsedSections.has(section.category);
                    return (
                      <div key={section.category} className="node-library-section">
                        <button
                          type="button"
                          className="node-library-section-title"
                          aria-expanded={!isCollapsed}
                          onClick={() =>
                            setCollapsedSections((prev) => {
                              const next = new Set(prev);
                              if (next.has(section.category)) next.delete(section.category);
                              else next.add(section.category);
                              return next;
                            })
                          }
                        >
                          <span className={`section-chevron${isCollapsed ? ' collapsed' : ''}`}>&#9660;</span>
                          <span>{section.category}</span>
                          <span className="section-count">{section.items.length}</span>
                        </button>
                        {!isCollapsed && (
                          <div className="node-library-section-grid">
                            {section.items.map((item) => (
                              <button
                                key={item.id}
                                type="button"
                                className={item.id === selectedLibraryItem?.id ? 'node-library-tile active' : 'node-library-tile'}
                                data-node-type={item.type}
                                data-category={section.category.toLowerCase()}
                                draggable
                                onClick={() => setSelectedLibraryItemId(item.id)}
                                onDoubleClick={() => addNodeFromLibrary(item)}
                                onDragStart={(event) => {
                                  event.dataTransfer.setData(
                                    'application/visual-kubernetes-node',
                                    JSON.stringify({ source: libraryTab, id: item.id }),
                                  );
                                  event.dataTransfer.effectAllowed = 'copy';
                                }}
                                onContextMenu={(event) => {
                                  if (libraryTab === 'custom') {
                                    event.preventDefault();
                                    deleteCustomLibraryItem(item.id);
                                  }
                                }}
                                title={item.notes}
                                aria-label={`Add ${item.name}`}
                              >
                                <span className="tile-icon">{item.icon}</span>
                                <span className="tile-name">{item.name}</span>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })
                ) : (
                  <div className="node-type-description">
                    {libraryTab === 'custom'
                      ? 'No custom tiles yet. Select a node on the canvas and use Save as custom.'
                      : 'No tiles match your search.'}
                  </div>
                )}
              </div>

              {selectedLibraryItem && (
                <div className="lib-info-card">
                  <span className="tile-icon">{selectedLibraryItem.icon}</span>
                  <div className="lib-info-text">
                    <strong>{selectedLibraryItem.name}</strong>
                    <span>{selectedLibraryItem.notes}</span>
                  </div>
                </div>
              )}
              {libraryTab === 'custom' && selectedLibraryItem && (
                <textarea
                  className="code-input compact-input"
                  aria-label="Custom tile notes"
                  value={selectedLibraryItem.notes}
                  onChange={(event) => updateCustomLibraryItem(selectedLibraryItem.id, { notes: event.target.value })}
                />
              )}
              <div className="lib-action-row">
                <button type="button" className="primary-button" onClick={() => selectedLibraryItem && addNodeFromLibrary(selectedLibraryItem)}>
                  Add node
                </button>
                <button type="button" className="ghost-button" onClick={saveSelectedNodeAsCustomTile}>
                  Save as custom
                </button>
                <button type="button" className="ghost-button" onClick={() => setTemplatesOpen(true)}>
                  Templates
                </button>
              </div>
              <div className="node-type-description">Drag a tile onto the canvas, double-click, or use Add node.</div>
            </LeftSection>

            <LeftSection title="Clusters">
              <div className="cluster-list" aria-label="Clusters">
                {clusterSummaries.map(({ cluster, nodes }) => (
                  <button
                    key={cluster.id}
                    type="button"
                    className={cluster.id === selectedCluster?.id ? 'cluster-list-item active' : 'cluster-list-item'}
                    onClick={() => setSelectedClusterId(cluster.id)}
                  >
                    <span>{cluster.name}</span>
                    <strong>{nodes.length} nodes</strong>
                    <small>
                      {cluster.provider} / {cluster.region} / {cluster.workerCount} workers
                    </small>
                  </button>
                ))}
              </div>
              <button type="button" className="ghost-button wide" onClick={addCluster}>
                Add cluster
              </button>
              {selectedNode && selectedCluster && (
                <button type="button" className="ghost-button wide" onClick={() => assignNodeToCluster(selectedNode.id, selectedCluster.id)}>
                  Assign selected node
                </button>
              )}
            </LeftSection>

            <LeftSection title="Connections">
              <div className="field-grid">
                <label>
                  From
                  <select
                    value={edgeDraft.from}
                    onChange={(event) => {
                      const nextFromId = event.target.value;
                      const nextFrom = model.nodes.find((node) => node.id === nextFromId);
                      const currentTo = model.nodes.find((node) => node.id === edgeDraft.to);
                      const canKeepTarget = nextFrom && currentTo ? canConnectNodes(nextFrom, currentTo).allowed : false;
                      const fallbackTarget = nextFrom
                        ? model.nodes.find((node) => node.id !== nextFrom.id && canConnectNodes(nextFrom, node).allowed)
                        : undefined;
                      const nextTo = canKeepTarget ? edgeDraft.to : fallbackTarget?.id ?? edgeDraft.to;
                      const nextToNode = model.nodes.find((node) => node.id === nextTo);
                      setEdgeDraft((current) => ({
                        ...current,
                        from: nextFromId,
                        to: nextTo,
                        type: nextFrom && nextToNode ? inferEdgeType(nextFrom, nextToNode) : current.type,
                      }));
                    }}
                  >
                    {model.nodes.map((node) => (
                      <option key={node.id} value={node.id}>
                        {node.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  To
                  <select
                    value={edgeDraft.to}
                    onChange={(event) => {
                      const nextToId = event.target.value;
                      const fromNode = model.nodes.find((node) => node.id === edgeDraft.from);
                      const toNode = model.nodes.find((node) => node.id === nextToId);
                      setEdgeDraft((current) => ({
                        ...current,
                        to: nextToId,
                        type: fromNode && toNode ? inferEdgeType(fromNode, toNode) : current.type,
                      }));
                    }}
                  >
                    {model.nodes.map((node) => (
                      <option key={node.id} value={node.id}>
                        {node.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Type
                  <select
                    value={edgeDraft.type}
                    onChange={(event) => setEdgeDraft((current) => ({ ...current, type: event.target.value as EdgeType }))}
                  >
                    <option value="http">http</option>
                    <option value="async">async</option>
                    <option value="data">data</option>
                  </select>
                </label>
                <label>
                  Latency budget
                  <input
                    type="number"
                    min="1"
                    value={edgeDraft.latencyBudgetMs}
                    onChange={(event) => setEdgeDraft((current) => ({ ...current, latencyBudgetMs: Number(event.target.value) }))}
                  />
                </label>
                <label className="span-two">
                  Network policy
                  <select
                    value={edgeDraft.networkPolicy}
                    onChange={(event) => setEdgeDraft((current) => ({ ...current, networkPolicy: event.target.value as NetworkPolicyIntent }))}
                  >
                    <option value="allow">Allow traffic and generate policy</option>
                    <option value="deny">Document dependency but deny traffic</option>
                  </select>
                </label>
              </div>
              <div className="edge-guidance">
                <div className="edge-guidance-title">Valid targets from this source</div>
                {validEdgeTargets.length > 0 ? (
                  validEdgeTargets.slice(0, 5).map(({ node, inferredType }) => (
                    <button
                      key={node.id}
                      type="button"
                      className="edge-target-button"
                      onClick={() =>
                        setEdgeDraft((current) => ({
                          ...current,
                          to: node.id,
                          type: inferredType,
                        }))
                      }
                    >
                      <span>{node.name}</span>
                      <strong>{inferredType}</strong>
                    </button>
                  ))
                ) : (
                  <div className="node-type-description">No valid targets for the selected source.</div>
                )}
              </div>
              <div className={`status-chip ${connectionMessage.tone}`}>{connectionMessage.text}</div>
              <button type="button" className="primary-button wide" onClick={() => addEdge()}>
                Add connection
              </button>
            </LeftSection>

            <LeftSection title="Workspace" defaultOpen={false}>
              <button type="button" className="ghost-button wide" onClick={resetWorkspace}>
                Reset model
              </button>
            </LeftSection>
          </div>
        )}
      </aside>
      <div
        className={leftRailOpen ? 'side-resizer' : 'side-resizer disabled'}
        onPointerDown={(event) => {
          if (!leftRailOpen) {
            return;
          }
          leftRailResizeRef.current = { startX: event.clientX, startWidth: leftRailWidth };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        aria-label="Resize left panel"
      />

      <main className="main-surface">
        <div className="toolbar">
          <div className="toolbar-group">
            <strong>Cluster Graph</strong>
            <span className="toolbar-chip">{detectPattern(model)}</span>
            <span className="toolbar-chip">{deploymentPlan.nodeCount} nodes</span>
            <span className="toolbar-chip">{model.activeEnvironment}</span>
            <span className="toolbar-chip">{model.provider}</span>
            <span className={validationIssues.some((issue) => issue.level === 'error') ? 'toolbar-chip error' : 'toolbar-chip'}>
              {validationIssues.filter((issue) => issue.level === 'error').length} errors /{' '}
              {validationIssues.filter((issue) => issue.level === 'warning').length} warnings
            </span>
            {canvasConnectMode && selectedNode && <span className="toolbar-chip">connecting from {selectedNode.name}</span>}
            {!canvasConnectMode && connectionMessage.tone === 'error' && <span className="toolbar-chip error">{connectionMessage.text}</span>}
          </div>
          <div className="toolbar-group">
            <span className="toolbar-metric">
              {deploymentPlan.estimatedMonthlyCost.toLocaleString('en-US', { style: 'currency', currency: 'USD' })}/month
            </span>
            <span className="toolbar-chip">{Math.round(canvasViewport.scale * 100)}%</span>
            <button type="button" className="icon-button" onClick={fitCanvasToContent}>
              Fit
            </button>
            <button type="button" className="icon-button" onClick={resetCanvasView}>
              100%
            </button>
            <button type="button" className="icon-button" onClick={() => setCanvasConnectMode((value) => !value)}>
              {canvasConnectMode ? 'Cancel connect' : 'Connect on stage'}
            </button>
            <button type="button" className="icon-button" onClick={() => setLeftRailOpen((value) => !value)}>
              {leftRailOpen ? 'Hide palette' : 'Show palette'}
            </button>
            <button type="button" className="icon-button" onClick={() => setRightRailOpen((value) => !value)}>
              {rightRailOpen ? 'Hide inspector' : 'Show inspector'}
            </button>
          </div>
        </div>

        <section
          className="canvas-stage"
          onDragOver={(event) => {
            event.preventDefault();
            event.dataTransfer.dropEffect = 'copy';
          }}
          onDrop={handleCanvasDrop}
        >
          <div className="canvas-watermark">CLUSTER GRAPH</div>
          <svg
            ref={canvasSvgRef}
            viewBox={`0 0 ${virtualCanvas.width} ${virtualCanvas.height}`}
            role="img"
            aria-label="Architecture diagram"
            className={canvasPanning || spacePressed ? 'diagram panning' : 'diagram'}
            onWheel={handleCanvasWheel}
            onPointerDown={handleCanvasPointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handleSVGPointerUp}
            onPointerLeave={handleSVGPointerLeave}
          >
            <defs>
              <linearGradient id="edgeGlow" x1="0%" y1="0%" x2="100%" y2="0%">
                <stop offset="0%" stopColor="#495057" />
                <stop offset="100%" stopColor="#adb5bd" />
              </linearGradient>
            </defs>

            <rect className="canvas-hit-area" x="0" y="0" width={virtualCanvas.width} height={virtualCanvas.height} />
            <g className="graph-layer" transform={`translate(${canvasViewport.x} ${canvasViewport.y}) scale(${canvasViewport.scale})`}>
            {clusterSummaries.map(({ cluster, bounds, nodes }) => {
              if (!bounds) {
                return null;
              }
              const active = selectedCluster?.id === cluster.id;
              return (
                <g key={cluster.id} className={active ? 'cluster-backdrop active' : 'cluster-backdrop'}>
                  <rect x={bounds.x} y={bounds.y} width={bounds.width} height={bounds.height} rx="22" ry="22" />
                  <text x={bounds.x + 18} y={bounds.y + 28} className="cluster-label">
                    {cluster.name} | {cluster.region} | {nodes.length} nodes
                  </text>
                </g>
              );
            })}
            {resolvedModel.edges.map((edge) => {
              const from = layout[edge.from];
              const to = layout[edge.to];
              if (!from || !to) {
                return null;
              }

              const fromSize = nodeSizes.get(edge.from) ?? { width: canvasBounds.nodeWidth, height: canvasBounds.nodeHeight };
              const x1 = from.x + fromSize.width - nodePortInset;
              const y1 = from.y + nodePortOffsetY;
              const x2 = to.x + nodePortInset;
              const y2 = to.y + nodePortOffsetY;
              const dx = Math.max(Math.abs(x2 - x1) * 0.5, 80);
              const fromCluster = model.clusters.find((cluster) => cluster.nodeIds.includes(edge.from));
              const toCluster = model.clusters.find((cluster) => cluster.nodeIds.includes(edge.to));
              const crossCluster = Boolean(fromCluster && toCluster && fromCluster.id !== toCluster.id);

              return (
                <g key={edge.id}>
                  <path
                    d={`M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`}
                    stroke={edge.networkPolicy === 'deny' ? '#ff6b6b' : 'url(#edgeGlow)'}
                    strokeWidth="3"
                    fill="none"
                    className={simulationActive ? 'edge-path simulating' : 'edge-path'}
                    strokeDasharray={crossCluster ? '16 8' : edge.networkPolicy === 'deny' ? '2 8' : edge.type === 'async' ? '12 6' : edge.type === 'data' ? '4 4' : undefined}
                  />
                  <text x={(x1 + x2) / 2} y={Math.min(y1, y2) - 10} textAnchor="middle" className="edge-label">
                    {edge.type} | {edge.latencyBudgetMs}ms | {edge.networkPolicy}{crossCluster ? ' | cross-cluster' : ''}
                  </text>
                </g>
              );
            })}

            {dragConnection &&
              (() => {
                const from = layout[dragConnection.fromId];
                if (!from) return null;

                const fromNode = resolvedModel.nodes.find((n) => n.id === dragConnection.fromId);
                const hoveredNode = dragConnection.hoveredNodeId ? resolvedModel.nodes.find((n) => n.id === dragConnection.hoveredNodeId) : null;
                const hoveredPos = dragConnection.hoveredNodeId ? layout[dragConnection.hoveredNodeId] : null;
                const isValidTarget = fromNode && hoveredNode ? canConnectNodes(fromNode, hoveredNode).allowed : false;
                const fromSize = nodeSizes.get(dragConnection.fromId) ?? { width: canvasBounds.nodeWidth, height: canvasBounds.nodeHeight };

                const x1 = from.x + fromSize.width - nodePortInset;
                const y1 = from.y + nodePortOffsetY;
                const x2 = isValidTarget && hoveredPos ? hoveredPos.x + nodePortInset : dragConnection.x;
                const y2 = isValidTarget && hoveredPos ? hoveredPos.y + nodePortOffsetY : dragConnection.y;
                const dx = Math.max(Math.abs(x2 - x1) * 0.5, 80);

                const wireColor = dragConnection.hoveredNodeId
                  ? isValidTarget
                    ? '#51cf66'
                    : '#ff6b6b'
                  : '#74c0fc';

                return (
                  <path
                    d={`M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`}
                    stroke={wireColor}
                    strokeWidth="3"
                    fill="none"
                    strokeDasharray="10 6"
                    className="edge-preview"
                  />
                );
              })()}

            {resolvedModel.nodes.map((node) => {
              const position = layout[node.id];
              if (!position) {
                return null;
              }

              const selected = node.id === selectedNode?.id;
              const headerColor = nodeColors[node.type];
              const isDragSource = dragConnection?.fromId === node.id;
              const isHoveredTarget = dragConnection?.hoveredNodeId === node.id;
              const dragSourceNode = dragConnection ? resolvedModel.nodes.find((n) => n.id === dragConnection.fromId) : undefined;
              const isValidDragTarget = dragSourceNode ? canConnectNodes(dragSourceNode, node).allowed : false;
              const isConnectModeTarget = canvasConnectMode && selectedNode && selectedNode.id !== node.id && canConnectNodes(selectedNode, node).allowed;

              let borderColor = '#343a40';
              let borderWidth = '2';
              if (selected) {
                borderColor = '#e9ecef';
              } else if (isHoveredTarget) {
                borderColor = isValidDragTarget ? '#51cf66' : '#ff6b6b';
                borderWidth = '3';
              } else if (dragConnection && !isDragSource && isValidDragTarget) {
                borderColor = '#2d5a3d';
              } else if (isConnectModeTarget) {
                borderColor = '#51cf66';
              }

              let inputPortClass = 'connector-handle target';
              let inputPortFill = headerColor;
              let inputPortStroke = '#0b0d12';
              if (isHoveredTarget && isValidDragTarget) {
                inputPortClass = 'connector-handle target target-valid';
                inputPortFill = '#51cf66';
                inputPortStroke = '#d3f9d8';
              } else if (isHoveredTarget && !isValidDragTarget) {
                inputPortClass = 'connector-handle target target-invalid';
                inputPortFill = '#ff6b6b';
                inputPortStroke = '#ffd8de';
              }

              const nodeKindLabel = node.type.toUpperCase();
              const nodeSize = nodeSizes.get(node.id) ?? { width: canvasBounds.nodeWidth, height: canvasBounds.nodeHeight };
              const runtimeLabel = nodeRuntimeLabel(node);
              const textWidth = nodeSize.width - 32;
              const headerNameWidth = nodeSize.width - estimateTextWidth(nodeKindLabel, 6.4) - 48;
              const pinTargetLabel =
                node.type === 'database' || node.type === 'cache'
                  ? 'storage'
                  : node.type === 'queue'
                    ? 'events'
                  : node.type === 'job' || node.type === 'cronjob'
                    ? 'trigger'
                    : node.type === 'networkPolicy'
                      ? 'select'
                      : node.type === 'role'
                        ? 'bind'
                      : 'in';
              const pinSourceLabel =
                node.type === 'ingress'
                  ? 'route'
                  : node.type === 'database'
                    ? 'rows'
                    : node.type === 'job' || node.type === 'cronjob' || node.type === 'worker'
                      ? 'deps'
                      : node.type === 'networkPolicy'
                        ? 'policy'
                        : node.type === 'role'
                          ? 'rbac'
                      : 'out';

              return (
                <g
                  key={node.id}
                  onClick={() => handleCanvasNodeClick(node.id)}
                  onPointerDown={(event) => {
                    if (canvasConnectMode || dragConnection) {
                      return;
                    }

                    const svgRect = event.currentTarget.ownerSVGElement?.getBoundingClientRect();
                    const svgElement = event.currentTarget.ownerSVGElement;
                    if (!svgRect || !svgElement) {
                      return;
                    }

                    const pointer = clientPointToCanvas(svgElement, event.clientX, event.clientY);
                    dragRef.current = {
                      nodeId: node.id,
                      offsetX: pointer.x - position.x,
                      offsetY: pointer.y - position.y,
                    };
                    event.currentTarget.setPointerCapture(event.pointerId);
                  }}
                  className="node-group"
                  aria-label={node.name}
                >
                  <rect
                    x={position.x}
                    y={position.y}
                    rx="8"
                    ry="8"
                    width={nodeSize.width}
                    height={nodeSize.height}
                    fill={selected ? '#1b1d22' : '#17191d'}
                    stroke={borderColor}
                    strokeWidth={borderWidth}
                  />
                  <rect x={position.x} y={position.y} rx="8" ry="8" width={nodeSize.width} height="6" fill={headerColor} />
                  <rect x={position.x + 1} y={position.y + 8} rx="6" ry="6" width={nodeSize.width - 2} height="28" fill="#101216" />
                  <rect x={position.x + 1} y={position.y + 42} width={nodeSize.width - 2} height="1" fill="#2b3038" />
                  <text x={position.x + 16} y={position.y + 28} className="node-header-text" textLength={fitTextLength(node.name, headerNameWidth, 7.2)}>
                    {node.name}
                  </text>
                  <text x={position.x + nodeSize.width - 16} y={position.y + 28} textAnchor="end" className="node-kind-text">
                    {nodeKindLabel}
                  </text>
                  <text x={position.x + 26} y={position.y + 60} className="node-pin-label">
                    {pinTargetLabel}
                  </text>
                  <text x={position.x + nodeSize.width - 26} y={position.y + 60} textAnchor="end" className="node-pin-label">
                    {pinSourceLabel}
                  </text>
                  <text x={position.x + 16} y={position.y + 86} className="node-meta" textLength={fitTextLength(runtimeLabel, textWidth, 6.2)}>
                    {runtimeLabel}
                  </text>
                  <text x={position.x + 16} y={position.y + 106} className="node-meta" textLength={fitTextLength(`ns ${node.namespace} | ${node.workload.kind}`, textWidth, 6.2)}>
                    ns {node.namespace} | {node.workload.kind}
                  </text>
                  <text x={position.x + 16} y={position.y + 126} className="node-meta" textLength={fitTextLength(`sa ${node.serviceAccountName}`, textWidth, 6.2)}>
                    sa {node.serviceAccountName}
                  </text>
                  <text x={position.x + 16} y={position.y + nodeSize.height - 10} className="node-footer-text">
                    rep {node.replicas} | port {node.containerPort}
                  </text>
                  <circle
                    cx={position.x + nodePortInset}
                    cy={position.y + nodePortOffsetY}
                    r="6"
                    fill={inputPortFill}
                    stroke={inputPortStroke}
                    strokeWidth="2"
                    className={inputPortClass}
                  />
                  <circle
                    cx={position.x + nodeSize.width - nodePortInset}
                    cy={position.y + nodePortOffsetY}
                    r="6"
                    fill={isDragSource ? '#74c0fc' : headerColor}
                    stroke={isDragSource ? '#d0ebff' : '#0b0d12'}
                    strokeWidth="2"
                    className={isDragSource ? 'connector-handle source dragging-source' : 'connector-handle source'}
                    onPointerDown={(event) => startHandleConnection(node.id, event)}
                  />
                </g>
              );
            })}
            </g>
          </svg>
        </section>

        <section className="bottom-dock" style={{ height: `${dockHeight}px` }}>
          <div
            className="dock-resizer"
            onPointerDown={(event) => {
              dockResizeRef.current = { startY: event.clientY, startHeight: dockHeight };
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            aria-label="Resize export panel"
          />
          <div className="dock-tabs">
            <button
              type="button"
              className={exportMode === 'selected-yaml' ? 'tab active' : 'tab'}
              onClick={() => setExportMode('selected-yaml')}
            >
              Selected node YAML
            </button>
            <button type="button" className={exportMode === 'yaml' ? 'tab active' : 'tab'} onClick={() => setExportMode('yaml')}>
              Full stack YAML
            </button>
            <button type="button" className={exportMode === 'terraform' ? 'tab active' : 'tab'} onClick={() => setExportMode('terraform')}>
              Terraform
            </button>
            <div className="dock-actions">
              {exportMode === 'selected-yaml' ? (
                <>
                  <button type="button" className="icon-button" disabled={!selectedNodeYamlOutput} onClick={() => void copyText(selectedNodeYamlOutput)}>
                    Copy selected
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    disabled={!selectedNodeYamlOutput}
                    onClick={() => downloadSingleFile(selectedNodeExportFilename, selectedNodeYamlOutput)}
                  >
                    Download selected
                  </button>
                </>
              ) : (
                <>
                  <button type="button" className="icon-button" onClick={() => downloadSingleFile('manifests.yaml', yamlOutput)}>
                    Download YAML
                  </button>
                  <button type="button" className="icon-button" onClick={() => downloadSingleFile('main.tf', terraformOutput)}>
                    Download Terraform
                  </button>
                  <button type="button" className="primary-button" onClick={downloadBundle}>
                    Download ZIP
                  </button>
                </>
              )}
            </div>
          </div>
          {exportMode === 'selected-yaml' && !selectedNodeYamlOutput ? (
            <div className="export-placeholder" aria-label="selected node yaml export">
              Select a node with generated Kubernetes resources to preview node-scoped YAML.
            </div>
          ) : (
            <pre className="export-preview" aria-label={exportLabel}>
              <code>{exportText}</code>
            </pre>
          )}
        </section>
      </main>

      {rightRailOpen && (
        <div
          className="side-resizer"
          onPointerDown={(event) => {
            rightRailResizeRef.current = { startX: event.clientX, startWidth: rightRailWidth };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          aria-label="Resize right panel"
        />
      )}
      <aside className={`rail right-rail ${rightRailOpen ? 'open' : 'collapsed'}`} style={rightRailOpen ? { width: `${rightRailWidth}px` } : undefined}>
        <div className="rail-header">
          <strong>Inspector</strong>
          <button type="button" className="icon-button" onClick={() => setRightRailOpen((value) => !value)}>
            {rightRailOpen ? 'Hide' : 'Show'}
          </button>
        </div>
        {rightRailOpen && (
          <div className="rail-content inspector-content">
            <div className="library-tabs" aria-label="Right panel tabs">
              <button type="button" className={rightPanelTab === 'inspector' ? 'mini-tab active' : 'mini-tab'} onClick={() => setRightPanelTab('inspector')}>
                Inspector
              </button>
              <button type="button" className={rightPanelTab === 'history' ? 'mini-tab active' : 'mini-tab'} onClick={() => setRightPanelTab('history')}>
                History
              </button>
            </div>
            {rightPanelTab === 'history' ? (
              <>
                <div className="section-card">
                  <div className="section-title">Snapshots</div>
                  <div className="mini-metrics">
                    <span>{snapshots.length} saved</span>
                    <span>{workspaceSummary(workspace)}</span>
                  </div>
                  <div className="status-chip neutral">{snapshotMessage}</div>
                  <div className="quick-actions">
                    <button type="button" className="primary-button" onClick={() => void createWorkspaceSnapshot('Manual save')}>
                      Save snapshot
                    </button>
                    <button type="button" className="ghost-button" onClick={undoWorkspaceChange}>
                      Undo
                    </button>
                    <button type="button" className="ghost-button" onClick={redoWorkspaceChange}>
                      Redo
                    </button>
                  </div>
                </div>
                <div className="section-card">
                  <div className="section-title">Timeline</div>
                  <div className="snapshot-list" aria-label="Snapshot timeline">
                    {snapshots.length > 0 ? (
                      snapshots.map((snapshot) => (
                        <button
                          key={snapshot.id}
                          type="button"
                          className={snapshot.id === selectedSnapshot?.id ? 'snapshot-item active' : 'snapshot-item'}
                          onClick={() => setSelectedSnapshotId(snapshot.id)}
                        >
                          <strong>{snapshot.name}</strong>
                          <span>{snapshot.summary}</span>
                          <small>{new Date(snapshot.createdAt).toLocaleString()}</small>
                        </button>
                      ))
                    ) : (
                      <div className="node-type-description">No snapshots yet. Use Save in the action bar or Save snapshot here.</div>
                    )}
                  </div>
                </div>
                <div className="section-card">
                  <div className="section-title">Selected snapshot</div>
                  {selectedSnapshot ? (
                    <>
                      <div className="selected-name">{selectedSnapshot.name}</div>
                      <div className="selected-subtle">
                        <span>{selectedSnapshot.summary}</span>
                        <span>{new Date(selectedSnapshot.createdAt).toLocaleString()}</span>
                      </div>
                      <div className="behavior-card">
                        <strong>Diff</strong>
                        <span>{snapshotDiffSummary(selectedSnapshot)}</span>
                      </div>
                      <div className="quick-actions">
                        <button type="button" className="primary-button" onClick={restoreSelectedSnapshot}>
                          Restore snapshot
                        </button>
                        <button type="button" className="danger-button" onClick={() => void removeSelectedSnapshot()}>
                          Delete snapshot
                        </button>
                      </div>
                    </>
                  ) : (
                    <div className="node-type-description">Select or create a snapshot to restore, delete, or compare.</div>
                  )}
                </div>
              </>
            ) : selectedNode && selectedNodeResolved ? (
              <>
            <div className="section-card compact">
              <div className="section-title">Selected</div>
              <div className="selected-name">{selectedNodeResolved.name}</div>
              <div className="selected-subtle">
                <span>{selectedNodeResolved.type}</span>
                <span>{selectedNodeResolved.namespace}</span>
                <span>{model.activeEnvironment}</span>
              </div>
              <div className="behavior-card">
                <strong>Behavior</strong>
                <span>{selectedNodeBehavior}</span>
              </div>
              <div className="quick-actions" aria-label="Quick actions">
                <button type="button" className="ghost-button" onClick={applyProdReadyProfile}>
                  Prod-ready
                </button>
                <button type="button" className="ghost-button" onClick={applyPublicTlsIngress}>
                  Public TLS ingress
                </button>
                <button type="button" className="ghost-button" onClick={applyDurableStorageProfile}>
                  Durable storage
                </button>
              </div>
            </div>

            {selectedCluster && (
              <div className="section-card">
                <div className="section-title">Cluster</div>
                <div className="field-grid">
                  <label>
                    Cluster
                    <select value={selectedCluster.id} onChange={(event) => setSelectedClusterId(event.target.value)}>
                      {model.clusters.map((cluster) => (
                        <option key={cluster.id} value={cluster.id}>
                          {cluster.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Name
                    <input value={selectedCluster.name} onChange={(event) => updateCluster(selectedCluster.id, { name: event.target.value })} />
                  </label>
                  <label>
                    Cloud
                    <select
                      value={selectedCluster.provider}
                      onChange={(event) => updateCluster(selectedCluster.id, { provider: event.target.value as CloudProvider })}
                    >
                      <option value="aws">AWS</option>
                      <option value="gcp">GCP</option>
                      <option value="azure">Azure</option>
                      <option value="generic">Generic</option>
                    </select>
                  </label>
                  <label>
                    Region
                    <input value={selectedCluster.region} onChange={(event) => updateCluster(selectedCluster.id, { region: event.target.value })} />
                  </label>
                  <label>
                    Worker count
                    <input
                      type="number"
                      min="1"
                      value={selectedCluster.workerCount}
                      onChange={(event) => updateCluster(selectedCluster.id, { workerCount: Number(event.target.value) })}
                    />
                  </label>
                  <label>
                    Node assignment
                    <select
                      value={model.clusters.find((cluster) => cluster.nodeIds.includes(selectedNode.id))?.id ?? ''}
                      onChange={(event) => assignNodeToCluster(selectedNode.id, event.target.value)}
                    >
                      <option value="">Unassigned</option>
                      {model.clusters.map((cluster) => (
                        <option key={cluster.id} value={cluster.id}>
                          {cluster.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="node-type-description span-two">
                    Drag a node into a cluster backdrop to reassign it. Cross-cluster edges render dashed and export with review annotations.
                  </div>
                </div>
              </div>
            )}

            {selectedNode.type === 'networkPolicy' && (
              <div className="section-card">
                <div className="section-title">NetworkPolicy</div>
                <div className="field-grid">
                  <label className="span-two">
                    Target selector labels
                    <textarea
                      className="code-input compact-input"
                      value={formatKeyValueEntries(selectedNode.networkPolicy.targetLabels)}
                      onChange={(event) =>
                        updateNode({
                          networkPolicy: { ...selectedNode.networkPolicy, targetLabels: parseKeyValueEntries(event.target.value) },
                        })
                      }
                    />
                  </label>
                  <label className="span-two">
                    Ingress from labels
                    <textarea
                      className="code-input compact-input"
                      value={formatKeyValueEntries(selectedNode.networkPolicy.ingressFromLabels)}
                      onChange={(event) =>
                        updateNode({
                          networkPolicy: { ...selectedNode.networkPolicy, ingressFromLabels: parseKeyValueEntries(event.target.value) },
                        })
                      }
                    />
                  </label>
                  <label className="span-two">
                    Egress CIDRs
                    <textarea
                      className="code-input compact-input"
                      value={selectedNode.networkPolicy.egressToCidrs.join('\n')}
                      onChange={(event) =>
                        updateNode({
                          networkPolicy: { ...selectedNode.networkPolicy, egressToCidrs: parseListInput(event.target.value) },
                        })
                      }
                    />
                  </label>
                  <label className="toggle-row">
                    <span>Allow ingress</span>
                    <input
                      type="checkbox"
                      checked={selectedNode.networkPolicy.allowIngress}
                      onChange={(event) => updateNode({ networkPolicy: { ...selectedNode.networkPolicy, allowIngress: event.target.checked } })}
                    />
                  </label>
                  <label className="toggle-row">
                    <span>Allow egress</span>
                    <input
                      type="checkbox"
                      checked={selectedNode.networkPolicy.allowEgress}
                      onChange={(event) => updateNode({ networkPolicy: { ...selectedNode.networkPolicy, allowEgress: event.target.checked } })}
                    />
                  </label>
                  <div className="node-type-description span-two">Use `key=value` labels. Explicit NetworkPolicy nodes replace edge-inferred allow policies.</div>
                </div>
              </div>
            )}

            {selectedNode.type === 'role' && (
              <div className="section-card">
                <div className="section-title">Role</div>
                <div className="field-grid">
                  <label className="span-two">
                    Service accounts
                    <textarea
                      className="code-input compact-input"
                      value={selectedNode.role.serviceAccounts.join('\n')}
                      onChange={(event) => updateNode({ role: { ...selectedNode.role, serviceAccounts: parseListInput(event.target.value) } })}
                    />
                  </label>
                  <label className="span-two">
                    Rules
                    <textarea
                      className="code-input"
                      value={formatRoleRules(selectedNode.role.rules)}
                      onChange={(event) => updateNode({ role: { ...selectedNode.role, rules: parseRoleRules(event.target.value) } })}
                    />
                  </label>
                  <div className="node-type-description span-two">Rule format: `apiGroup1,apiGroup2|resource1,resource2|verb1,verb2`.</div>
                </div>
              </div>
            )}

            <div className="section-card">
              <div className="section-title">Runtime</div>
              <div className="field-grid">
                <label>
                  Name
                  <input value={selectedNode.name} onChange={(event) => updateNode({ name: event.target.value })} />
                </label>
                <label>
                  Namespace
                  <input value={selectedNode.namespace} onChange={(event) => updateNode({ namespace: event.target.value })} />
                </label>
                <label>
                  Image
                  <input value={selectedNode.image} onChange={(event) => updateNode({ image: event.target.value })} />
                </label>
                <label>
                  Tag
                  <input value={selectedNode.tag} onChange={(event) => updateNode({ tag: event.target.value })} />
                </label>
                <label>
                  Container port
                  <input type="number" min="1" value={selectedNode.containerPort} onChange={(event) => updateNode({ containerPort: Number(event.target.value) })} />
                </label>
                <label>
                  Workload replicas
                  <input aria-label="Workload replicas" type="number" min="1" value={selectedNode.replicas} onChange={(event) => updateNode({ replicas: Number(event.target.value) })} />
                </label>
                <label className="span-two">
                  Service account
                  <input value={selectedNode.serviceAccountName} onChange={(event) => updateNode({ serviceAccountName: event.target.value })} />
                </label>
              </div>
            </div>

            <div className="section-card">
              <div className="section-title">Workload</div>
              <div className="field-grid">
                <label>
                  Kubernetes kind
                  <select
                    value={selectedNode.workload.kind}
                    onChange={(event) =>
                      updateNode({
                        workload: {
                          ...selectedNode.workload,
                          kind: event.target.value as ArchitectureNode['workload']['kind'],
                          restartPolicy:
                            event.target.value === 'Job' || event.target.value === 'CronJob'
                              ? selectedNode.workload.restartPolicy === 'Always'
                                ? 'OnFailure'
                                : selectedNode.workload.restartPolicy
                              : 'Always',
                        },
                      })
                    }
                  >
                    <option value="Deployment">Deployment</option>
                    <option value="StatefulSet">StatefulSet</option>
                    <option value="Job">Job</option>
                    <option value="CronJob">CronJob</option>
                  </select>
                </label>
                <label>
                  Restart policy
                  <select
                    value={selectedNode.workload.restartPolicy}
                    onChange={(event) =>
                      updateNode({
                        workload: { ...selectedNode.workload, restartPolicy: event.target.value as ArchitectureNode['workload']['restartPolicy'] },
                      })
                    }
                  >
                    <option value="Always">Always</option>
                    <option value="OnFailure">OnFailure</option>
                    <option value="Never">Never</option>
                  </select>
                </label>
                <label>
                  Completions
                  <input
                    type="number"
                    min="1"
                    value={selectedNode.workload.completions}
                    onChange={(event) => updateNode({ workload: { ...selectedNode.workload, completions: Number(event.target.value) } })}
                  />
                </label>
                <label>
                  Parallelism
                  <input
                    type="number"
                    min="1"
                    value={selectedNode.workload.parallelism}
                    onChange={(event) => updateNode({ workload: { ...selectedNode.workload, parallelism: Number(event.target.value) } })}
                  />
                </label>
                <label>
                  Backoff limit
                  <input
                    type="number"
                    min="0"
                    value={selectedNode.workload.backoffLimit}
                    onChange={(event) => updateNode({ workload: { ...selectedNode.workload, backoffLimit: Number(event.target.value) } })}
                  />
                </label>
                <label>
                  Termination grace
                  <input
                    type="number"
                    min="0"
                    value={selectedNode.workload.terminationGracePeriodSeconds}
                    onChange={(event) =>
                      updateNode({ workload: { ...selectedNode.workload, terminationGracePeriodSeconds: Number(event.target.value) } })
                    }
                  />
                </label>
                <label>
                  Cron schedule
                  <input
                    value={selectedNode.workload.schedule}
                    onChange={(event) => updateNode({ workload: { ...selectedNode.workload, schedule: event.target.value } })}
                  />
                </label>
                <label className="span-two">
                  Command
                  <textarea
                    className="code-input compact-input"
                    value={selectedNode.workload.command.join('\n')}
                    onChange={(event) => updateNode({ workload: { ...selectedNode.workload, command: parseListInput(event.target.value) } })}
                  />
                </label>
                <label className="span-two">
                  Args
                  <textarea
                    className="code-input compact-input"
                    value={selectedNode.workload.args.join('\n')}
                    onChange={(event) => updateNode({ workload: { ...selectedNode.workload, args: parseListInput(event.target.value) } })}
                  />
                </label>
              </div>
            </div>

            <div className="section-card">
              <div className="section-title">Security</div>
              <div className="field-grid">
                <label className="span-two">
                  Image pull secrets
                  <textarea
                    className="code-input compact-input"
                    value={selectedNode.imagePullSecrets.join('\n')}
                    onChange={(event) =>
                      updateNode({
                        imagePullSecrets: event.target.value
                          .split('\n')
                          .map((line) => line.trim())
                          .filter(Boolean),
                      })
                    }
                  />
                </label>
                <label>
                  Run as user
                  <input
                    type="number"
                    min="0"
                    value={selectedNode.security.runAsUser}
                    onChange={(event) => updateNode({ security: { ...selectedNode.security, runAsUser: Number(event.target.value) } })}
                  />
                </label>
                <label>
                  Seccomp profile
                  <select
                    value={selectedNode.security.seccompProfile}
                    onChange={(event) =>
                      updateNode({
                        security: {
                          ...selectedNode.security,
                          seccompProfile: event.target.value as ArchitectureNode['security']['seccompProfile'],
                        },
                      })
                    }
                  >
                    <option value="RuntimeDefault">RuntimeDefault</option>
                    <option value="Localhost">Localhost</option>
                    <option value="Unconfined">Unconfined</option>
                  </select>
                </label>
                <label className="toggle-row">
                  <span>Run as non-root</span>
                  <input
                    type="checkbox"
                    checked={selectedNode.security.runAsNonRoot}
                    onChange={(event) => updateNode({ security: { ...selectedNode.security, runAsNonRoot: event.target.checked } })}
                  />
                </label>
                <label className="toggle-row">
                  <span>Read-only root FS</span>
                  <input
                    type="checkbox"
                    checked={selectedNode.security.readOnlyRootFilesystem}
                    onChange={(event) => updateNode({ security: { ...selectedNode.security, readOnlyRootFilesystem: event.target.checked } })}
                  />
                </label>
                <label className="toggle-row span-two">
                  <span>Allow privilege escalation</span>
                  <input
                    type="checkbox"
                    checked={selectedNode.security.allowPrivilegeEscalation}
                    onChange={(event) => updateNode({ security: { ...selectedNode.security, allowPrivilegeEscalation: event.target.checked } })}
                  />
                </label>
              </div>
            </div>

            <div className="section-card">
              <div className="section-title">Environment Overrides</div>
              <div className="field-grid">
                <label>
                  Active environment
                  <select
                    value={model.activeEnvironment}
                    onChange={(event) => updateModel({ activeEnvironment: event.target.value as EnvironmentName })}
                  >
                    {supportedEnvironments.map((environment) => (
                      <option key={environment} value={environment}>
                        {environment}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Effective tag
                  <input
                    value={selectedNodeResolved.tag}
                    onChange={(event) => updateNodeEnvironmentOverride(model.activeEnvironment, { tag: event.target.value })}
                  />
                </label>
                <label>
                  Effective replicas
                  <input
                    type="number"
                    min="1"
                    value={selectedNodeResolved.replicas}
                    onChange={(event) => updateNodeEnvironmentOverride(model.activeEnvironment, { replicas: Number(event.target.value) })}
                  />
                </label>
                <label>
                  Environment host
                  <input
                    value={selectedNodeResolved.ingress.host}
                    onChange={(event) =>
                      updateNodeEnvironmentOverride(model.activeEnvironment, {
                        ingress: { host: event.target.value },
                      })
                    }
                  />
                </label>
                <label>
                  Env request CPU
                  <input
                    value={selectedNodeResolved.resources.requestsCpu}
                    onChange={(event) =>
                      updateNodeEnvironmentOverride(model.activeEnvironment, {
                        resources: { requestsCpu: event.target.value },
                      })
                    }
                  />
                </label>
                <label>
                  Env request memory
                  <input
                    value={selectedNodeResolved.resources.requestsMemory}
                    onChange={(event) =>
                      updateNodeEnvironmentOverride(model.activeEnvironment, {
                        resources: { requestsMemory: event.target.value },
                      })
                    }
                  />
                </label>
                <label>
                  Env limit CPU
                  <input
                    value={selectedNodeResolved.resources.limitsCpu}
                    onChange={(event) =>
                      updateNodeEnvironmentOverride(model.activeEnvironment, {
                        resources: { limitsCpu: event.target.value },
                      })
                    }
                  />
                </label>
                <label>
                  Env limit memory
                  <input
                    value={selectedNodeResolved.resources.limitsMemory}
                    onChange={(event) =>
                      updateNodeEnvironmentOverride(model.activeEnvironment, {
                        resources: { limitsMemory: event.target.value },
                      })
                    }
                  />
                </label>
                <label>
                  Env min replicas
                  <input
                    type="number"
                    min="1"
                    value={selectedNodeResolved.autoscaling.minReplicas}
                    onChange={(event) =>
                      updateNodeEnvironmentOverride(model.activeEnvironment, {
                        autoscaling: { minReplicas: Number(event.target.value) },
                      })
                    }
                  />
                </label>
                <label>
                  Env max replicas
                  <input
                    type="number"
                    min="1"
                    value={selectedNodeResolved.autoscaling.maxReplicas}
                    onChange={(event) =>
                      updateNodeEnvironmentOverride(model.activeEnvironment, {
                        autoscaling: { maxReplicas: Number(event.target.value) },
                      })
                    }
                  />
                </label>
                <label className="span-two toggle-row">
                  <span>Env HPA enabled</span>
                  <input
                    type="checkbox"
                    checked={selectedNodeResolved.autoscaling.enabled}
                    onChange={(event) =>
                      updateNodeEnvironmentOverride(model.activeEnvironment, {
                        autoscaling: { enabled: event.target.checked },
                      })
                    }
                  />
                </label>
              </div>
            </div>

            <div className="section-card">
              <div className="section-title">Service</div>
              <div className="field-grid">
                <label>
                  Exposure
                  <select
                    value={selectedNode.service.exposure}
                    onChange={(event) =>
                      updateNode({ service: { ...selectedNode.service, exposure: event.target.value as ArchitectureNode['service']['exposure'] } })
                    }
                  >
                    <option value="internal">Internal</option>
                    <option value="external">External</option>
                  </select>
                </label>
                <label>
                  LB scope
                  <select
                    value={selectedNode.service.loadBalancerScope}
                    onChange={(event) =>
                      updateNode({
                        service: { ...selectedNode.service, loadBalancerScope: event.target.value as ArchitectureNode['service']['loadBalancerScope'] },
                      })
                    }
                  >
                    <option value="private">Private</option>
                    <option value="public">Public</option>
                  </select>
                </label>
                <label>
                  Service type
                  <select
                    value={selectedNodeResolved.service.type}
                    onChange={(event) => updateNode({ service: { ...selectedNode.service, type: event.target.value as ArchitectureNode['service']['type'] } })}
                  >
                    <option value="ClusterIP">ClusterIP</option>
                    <option value="NodePort">NodePort</option>
                    <option value="LoadBalancer">LoadBalancer</option>
                  </select>
                </label>
                <label>
                  Service port
                  <input type="number" min="1" value={selectedNodeResolved.service.port} onChange={(event) => updateNode({ service: { ...selectedNode.service, port: Number(event.target.value) } })} />
                </label>
                <label className="span-two">
                  External traffic policy
                  <select
                    value={selectedNode.service.externalTrafficPolicy}
                    onChange={(event) =>
                      updateNode({
                        service: {
                          ...selectedNode.service,
                          externalTrafficPolicy: event.target.value as ArchitectureNode['service']['externalTrafficPolicy'],
                        },
                      })
                    }
                  >
                    <option value="Cluster">Cluster</option>
                    <option value="Local">Local</option>
                  </select>
                </label>
              </div>
            </div>

            <div className="section-card">
              <div className="section-title">Resources</div>
              <div className="field-grid">
                <label>
                  Request CPU
                  <input value={selectedNode.resources.requestsCpu} onChange={(event) => updateNode({ resources: { ...selectedNode.resources, requestsCpu: event.target.value } })} />
                </label>
                <label>
                  Request memory
                  <input value={selectedNode.resources.requestsMemory} onChange={(event) => updateNode({ resources: { ...selectedNode.resources, requestsMemory: event.target.value } })} />
                </label>
                <label>
                  Limit CPU
                  <input value={selectedNode.resources.limitsCpu} onChange={(event) => updateNode({ resources: { ...selectedNode.resources, limitsCpu: event.target.value } })} />
                </label>
                <label>
                  Limit memory
                  <input value={selectedNode.resources.limitsMemory} onChange={(event) => updateNode({ resources: { ...selectedNode.resources, limitsMemory: event.target.value } })} />
                </label>
              </div>
            </div>

            <div className="section-card">
              <div className="section-title">Health checks</div>
              <div className="field-grid">
                <label>
                  Readiness type
                  <select
                    value={selectedNode.readinessProbe.type}
                    onChange={(event) =>
                      updateNode({ readinessProbe: { ...selectedNode.readinessProbe, type: event.target.value as ArchitectureNode['readinessProbe']['type'] } })
                    }
                  >
                    <option value="http">HTTP</option>
                    <option value="tcp">TCP</option>
                    <option value="exec">Exec</option>
                  </select>
                </label>
                <label>
                  Readiness path
                  <input value={selectedNode.readinessProbe.path} onChange={(event) => updateNode({ readinessProbe: { ...selectedNode.readinessProbe, path: event.target.value } })} />
                </label>
                <label>
                  Liveness type
                  <select
                    value={selectedNode.livenessProbe.type}
                    onChange={(event) =>
                      updateNode({ livenessProbe: { ...selectedNode.livenessProbe, type: event.target.value as ArchitectureNode['livenessProbe']['type'] } })
                    }
                  >
                    <option value="http">HTTP</option>
                    <option value="tcp">TCP</option>
                    <option value="exec">Exec</option>
                  </select>
                </label>
                <label>
                  Liveness path
                  <input value={selectedNode.livenessProbe.path} onChange={(event) => updateNode({ livenessProbe: { ...selectedNode.livenessProbe, path: event.target.value } })} />
                </label>
                <label>
                  Probe port
                  <input
                    type="number"
                    min="1"
                    value={selectedNode.readinessProbe.port}
                    onChange={(event) =>
                      updateNode({
                        readinessProbe: { ...selectedNode.readinessProbe, port: Number(event.target.value) },
                        livenessProbe: { ...selectedNode.livenessProbe, port: Number(event.target.value) },
                      })
                    }
                  />
                </label>
                <label>
                  Failure threshold
                  <input
                    type="number"
                    min="1"
                    value={selectedNode.readinessProbe.failureThreshold}
                    onChange={(event) =>
                      updateNode({
                        readinessProbe: { ...selectedNode.readinessProbe, failureThreshold: Number(event.target.value) },
                        livenessProbe: { ...selectedNode.livenessProbe, failureThreshold: Number(event.target.value) },
                      })
                    }
                  />
                </label>
                <label className="toggle-row span-two">
                  <span>Enable startup probe</span>
                  <input
                    type="checkbox"
                    checked={selectedNode.startupProbe.enabled}
                    onChange={(event) => updateNode({ startupProbe: { ...selectedNode.startupProbe, enabled: event.target.checked } })}
                  />
                </label>
                <label>
                  Startup type
                  <select
                    value={selectedNode.startupProbe.type}
                    onChange={(event) =>
                      updateNode({ startupProbe: { ...selectedNode.startupProbe, type: event.target.value as ArchitectureNode['startupProbe']['type'] } })
                    }
                  >
                    <option value="http">HTTP</option>
                    <option value="tcp">TCP</option>
                    <option value="exec">Exec</option>
                  </select>
                </label>
                <label>
                  Startup failure threshold
                  <input
                    type="number"
                    min="1"
                    value={selectedNode.startupProbe.failureThreshold}
                    onChange={(event) => updateNode({ startupProbe: { ...selectedNode.startupProbe, failureThreshold: Number(event.target.value) } })}
                  />
                </label>
                <label className="span-two">
                  Probe command
                  <input
                    value={selectedNode.startupProbe.command || selectedNode.readinessProbe.command}
                    onChange={(event) =>
                      updateNode({
                        startupProbe: { ...selectedNode.startupProbe, command: event.target.value },
                        readinessProbe: { ...selectedNode.readinessProbe, command: event.target.value },
                        livenessProbe: { ...selectedNode.livenessProbe, command: event.target.value },
                      })
                    }
                  />
                </label>
              </div>
            </div>

            <div className="section-card">
              <div className="section-title">Config and secrets</div>
              <div className="field-grid">
                <label className="span-two">
                  Config entries
                  <textarea
                    className="code-input"
                    value={selectedNode.env.map((entry) => `${entry.key}=${entry.value}`).join('\n')}
                    onChange={(event) =>
                      updateNode({
                        env: event.target.value
                          .split('\n')
                          .map((line) => line.trim())
                          .filter(Boolean)
                          .map((line) => {
                            const [key, ...rest] = line.split('=');
                            return { key: key.trim(), value: rest.join('=').trim() };
                          }),
                      })
                    }
                  />
                </label>
                <label className="span-two">
                  Secret entries
                  <textarea
                    className="code-input"
                    value={selectedNode.secretEnv.map((entry) => formatSecretEntry(entry)).join('\n')}
                    onChange={(event) =>
                      updateNode({
                        secretEnv: parseSecretEntries(event.target.value),
                      })
                    }
                  />
                </label>
                <div className="node-type-description span-two">
                  Use `KEY=value` for inline secrets or `KEY@secret-name#secret-key` to reference an existing Kubernetes secret.
                </div>
              </div>
            </div>

            <div className="section-card">
              <div className="section-title">Graph Wiring</div>
              {derivedSelectedNodeEnv.length > 0 ? (
                <div className="derived-env-list">
                  {derivedSelectedNodeEnv.map((entry) => (
                    <div key={entry.key} className="derived-env-item">
                      <span className="derived-env-key">{entry.key}</span>
                      <span className="derived-env-value">{entry.value}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="node-type-description">No dependency-derived config for this node yet.</div>
              )}
            </div>

            <div className="section-card">
              <div className="section-title">Storage and ingress</div>
              <div className="field-grid">
                <label className="toggle-row span-two">
                  <span>Enable persistent storage</span>
                  <input type="checkbox" checked={selectedNode.storage.enabled} onChange={(event) => updateNode({ storage: { ...selectedNode.storage, enabled: event.target.checked } })} />
                </label>
                <label>
                  Storage size
                  <input value={selectedNode.storage.size} onChange={(event) => updateNode({ storage: { ...selectedNode.storage, size: event.target.value } })} />
                </label>
                <label>
                  Storage class
                  <input value={selectedNodeResolved.storage.storageClassName} onChange={(event) => updateNode({ storage: { ...selectedNode.storage, storageClassName: event.target.value } })} />
                </label>
                <label>
                  Access mode
                  <select
                    value={selectedNode.storage.accessMode}
                    onChange={(event) =>
                      updateNode({ storage: { ...selectedNode.storage, accessMode: event.target.value as ArchitectureNode['storage']['accessMode'] } })
                    }
                  >
                    <option value="ReadWriteOnce">ReadWriteOnce</option>
                    <option value="ReadWriteOncePod">ReadWriteOncePod</option>
                    <option value="ReadOnlyMany">ReadOnlyMany</option>
                    <option value="ReadWriteMany">ReadWriteMany</option>
                  </select>
                </label>
                <label>
                  Volume mode
                  <select
                    value={selectedNode.storage.volumeMode}
                    onChange={(event) =>
                      updateNode({ storage: { ...selectedNode.storage, volumeMode: event.target.value as ArchitectureNode['storage']['volumeMode'] } })
                    }
                  >
                    <option value="Filesystem">Filesystem</option>
                    <option value="Block">Block</option>
                  </select>
                </label>
                <label className="span-two">
                  Mount path
                  <input value={selectedNode.storage.mountPath} onChange={(event) => updateNode({ storage: { ...selectedNode.storage, mountPath: event.target.value } })} />
                </label>
                <label>
                  Retain on delete
                  <select
                    value={selectedNode.storage.retainOnDelete}
                    onChange={(event) =>
                      updateNode({
                        storage: { ...selectedNode.storage, retainOnDelete: event.target.value as ArchitectureNode['storage']['retainOnDelete'] },
                      })
                    }
                  >
                    <option value="Retain">Retain</option>
                    <option value="Delete">Delete</option>
                  </select>
                </label>
                <label>
                  Retain on scale-down
                  <select
                    value={selectedNode.storage.retainOnScaleDown}
                    onChange={(event) =>
                      updateNode({
                        storage: { ...selectedNode.storage, retainOnScaleDown: event.target.value as ArchitectureNode['storage']['retainOnScaleDown'] },
                      })
                    }
                  >
                    <option value="Retain">Retain</option>
                    <option value="Delete">Delete</option>
                  </select>
                </label>
                <label className="toggle-row span-two">
                  <span>Backup intent</span>
                  <input
                    type="checkbox"
                    checked={selectedNode.storage.backupEnabled}
                    onChange={(event) => updateNode({ storage: { ...selectedNode.storage, backupEnabled: event.target.checked } })}
                  />
                </label>
                <label className="span-two">
                  Backup schedule
                  <input
                    value={selectedNode.storage.backupSchedule}
                    onChange={(event) => updateNode({ storage: { ...selectedNode.storage, backupSchedule: event.target.value } })}
                  />
                </label>
                <label className="toggle-row span-two">
                  <span>Enable ingress</span>
                  <input type="checkbox" checked={selectedNode.ingress.enabled} onChange={(event) => updateNode({ ingress: { ...selectedNode.ingress, enabled: event.target.checked } })} />
                </label>
                <label>
                  Ingress exposure
                  <select
                    value={selectedNode.ingress.exposure}
                    onChange={(event) =>
                      updateNode({ ingress: { ...selectedNode.ingress, exposure: event.target.value as ArchitectureNode['ingress']['exposure'] } })
                    }
                  >
                    <option value="internal">Internal</option>
                    <option value="external">External</option>
                  </select>
                </label>
                <label>
                  Ingress LB scope
                  <select
                    value={selectedNode.ingress.loadBalancerScope}
                    onChange={(event) =>
                      updateNode({
                        ingress: { ...selectedNode.ingress, loadBalancerScope: event.target.value as ArchitectureNode['ingress']['loadBalancerScope'] },
                      })
                    }
                  >
                    <option value="private">Private</option>
                    <option value="public">Public</option>
                  </select>
                </label>
                <label>
                  Ingress host
                  <input value={selectedNode.ingress.host} onChange={(event) => updateNode({ ingress: { ...selectedNode.ingress, host: event.target.value } })} />
                </label>
                <label>
                  Ingress path
                  <input value={selectedNode.ingress.path} onChange={(event) => updateNode({ ingress: { ...selectedNode.ingress, path: event.target.value } })} />
                </label>
                <label>
                  Ingress class
                  <input value={selectedNodeResolved.ingress.ingressClassName} onChange={(event) => updateNode({ ingress: { ...selectedNode.ingress, ingressClassName: event.target.value } })} />
                </label>
                <label>
                  TLS issuer
                  <input value={selectedNode.ingress.tlsIssuer} onChange={(event) => updateNode({ ingress: { ...selectedNode.ingress, tlsIssuer: event.target.value } })} />
                </label>
                <label className="toggle-row">
                  <span>Enable TLS</span>
                  <input type="checkbox" checked={selectedNode.ingress.tlsEnabled} onChange={(event) => updateNode({ ingress: { ...selectedNode.ingress, tlsEnabled: event.target.checked } })} />
                </label>
                <label>
                  TLS secret
                  <input value={selectedNode.ingress.tlsSecretName} onChange={(event) => updateNode({ ingress: { ...selectedNode.ingress, tlsSecretName: event.target.value } })} />
                </label>
              </div>
            </div>

            <div className="section-card">
              <div className="section-title">Autoscaling</div>
              <div className="field-grid">
                <label className="toggle-row span-two">
                  <span>Enable HPA</span>
                  <input type="checkbox" checked={selectedNode.autoscaling.enabled} onChange={(event) => updateNode({ autoscaling: { ...selectedNode.autoscaling, enabled: event.target.checked } })} />
                </label>
                <label>
                  Min replicas
                  <input type="number" min="1" value={selectedNode.autoscaling.minReplicas} onChange={(event) => updateNode({ autoscaling: { ...selectedNode.autoscaling, minReplicas: Number(event.target.value) } })} />
                </label>
                <label>
                  Max replicas
                  <input type="number" min="1" value={selectedNode.autoscaling.maxReplicas} onChange={(event) => updateNode({ autoscaling: { ...selectedNode.autoscaling, maxReplicas: Number(event.target.value) } })} />
                </label>
                <label className="span-two">
                  Target CPU %
                  <input type="number" min="1" max="100" value={selectedNode.autoscaling.targetCPUUtilizationPercentage} onChange={(event) => updateNode({ autoscaling: { ...selectedNode.autoscaling, targetCPUUtilizationPercentage: Number(event.target.value) } })} />
                </label>
              </div>
            </div>

            <div className="section-card compact">
              <div className="section-title">Validation</div>
              <div className="mini-metrics">
                <span>{validationIssues.filter((issue) => issue.level === 'error').length} errors</span>
                <span>{validationIssues.filter((issue) => issue.level === 'warning').length} warnings</span>
              </div>
              <div className="validation-list">
                {validationIssues.slice(0, 8).map((issue) => (
                  <div key={`${issue.level}-${issue.message}`} className={`validation-item ${issue.level}`}>
                    <strong>{issue.level}</strong>
                    <span>{issue.message}</span>
                  </div>
                ))}
                {validationIssues.length > 8 && <div className="node-type-description">Showing 8 of {validationIssues.length} validation issues.</div>}
              </div>
              <button type="button" className="danger-button wide" onClick={deleteSelectedNode}>
                Delete node
              </button>
            </div>
              </>
            ) : (
              <div className="section-card">
                <div className="section-title">Inspector</div>
                <div className="node-type-description">Select a node to inspect runtime, networking, resources, and validation settings.</div>
              </div>
            )}
          </div>
        )}
      </aside>
      </div>
      {findOpen && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Find nodes">
          <div className="command-modal">
            <div className="modal-header">
              <div>
                <div className="section-title">Find</div>
                <h2>Search graph</h2>
              </div>
              <button type="button" className="icon-button" onClick={() => setFindOpen(false)}>
                Close
              </button>
            </div>
            <label>
              Node search
              <input autoFocus value={findQuery} onChange={(event) => setFindQuery(event.target.value)} placeholder="service, namespace, image, account..." />
            </label>
            <div className="command-list" aria-label="Find results">
              {findResults.length > 0 ? (
                findResults.map((node) => (
                  <button key={node.id} type="button" className="command-list-item" onClick={() => selectFoundNode(node.id)}>
                    <strong>{node.name}</strong>
                    <span>{node.type} | ns {node.namespace} | {node.image}:{node.tag}</span>
                  </button>
                ))
              ) : (
                <div className="node-type-description">No nodes match that search.</div>
              )}
            </div>
          </div>
        </div>
      )}
      {blueprintSettingsOpen && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Blueprint settings">
          <div className="command-modal">
            <div className="modal-header">
              <div>
                <div className="section-title">Blueprint Settings</div>
                <h2>Stack defaults</h2>
              </div>
              <button type="button" className="icon-button" onClick={() => setBlueprintSettingsOpen(false)}>
                Close
              </button>
            </div>
            <div className="field-grid">
              <label>
                Stack name
                <input value={model.name} onChange={(event) => updateModel({ name: event.target.value })} />
              </label>
              <label>
                Default namespace
                <input value={model.defaultNamespace} onChange={(event) => updateModel({ defaultNamespace: event.target.value })} />
              </label>
              <label>
                Provider
                <select value={model.provider} onChange={(event) => updateModel({ provider: event.target.value as CloudProvider })}>
                  <option value="aws">AWS</option>
                  <option value="gcp">GCP</option>
                  <option value="azure">Azure</option>
                  <option value="generic">Generic</option>
                </select>
              </label>
              <label>
                Environment
                <select value={model.activeEnvironment} onChange={(event) => updateModel({ activeEnvironment: event.target.value as EnvironmentName })}>
                  {supportedEnvironments.map((environment) => (
                    <option key={environment} value={environment}>{environmentLabel(environment)}</option>
                  ))}
                </select>
              </label>
            </div>
            <div className="status-chip neutral">Blueprint defaults flow into generated YAML, Terraform, templates, snapshots, and exports.</div>
          </div>
        </div>
      )}
      {clusterDefaultsOpen && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Cluster defaults">
          <div className="command-modal">
            <div className="modal-header">
              <div>
                <div className="section-title">Cluster Defaults</div>
                <h2>Cluster profile</h2>
              </div>
              <button type="button" className="icon-button" onClick={() => setClusterDefaultsOpen(false)}>
                Close
              </button>
            </div>
            {selectedCluster ? (
              <>
                <div className="field-grid">
                  <label>
                    Cluster
                    <select value={selectedCluster.id} onChange={(event) => setSelectedClusterId(event.target.value)}>
                      {model.clusters.map((cluster) => (
                        <option key={cluster.id} value={cluster.id}>{cluster.name}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Name
                    <input value={selectedCluster.name} onChange={(event) => updateCluster(selectedCluster.id, { name: event.target.value })} />
                  </label>
                  <label>
                    Provider
                    <select value={selectedCluster.provider} onChange={(event) => updateCluster(selectedCluster.id, { provider: event.target.value as CloudProvider })}>
                      <option value="aws">AWS</option>
                      <option value="gcp">GCP</option>
                      <option value="azure">Azure</option>
                      <option value="generic">Generic</option>
                    </select>
                  </label>
                  <label>
                    Region
                    <input value={selectedCluster.region} onChange={(event) => updateCluster(selectedCluster.id, { region: event.target.value })} />
                  </label>
                  <label>
                    Worker count
                    <input
                      type="number"
                      min="1"
                      value={selectedCluster.workerCount}
                      onChange={(event) => updateCluster(selectedCluster.id, { workerCount: Number(event.target.value) })}
                    />
                  </label>
                </div>
                <div className="status-chip neutral">{selectedCluster.nodeIds.length} nodes assigned to this cluster.</div>
              </>
            ) : (
              <button type="button" className="primary-button" onClick={addCluster}>Add first cluster</button>
            )}
          </div>
        </div>
      )}
      {playPreviewOpen && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Live preview">
          <div className="template-modal">
            <div className="modal-header">
              <div>
                <div className="section-title">Play</div>
                <h2>Live preview</h2>
              </div>
              <button type="button" className="icon-button" onClick={() => setPlayPreviewOpen(false)}>
                Close
              </button>
            </div>
            <div className="mini-metrics">
              <span>{model.nodes.length} nodes</span>
              <span>{model.edges.length} edges</span>
              <span>{validationIssues.filter((issue) => issue.level === 'error').length} errors</span>
              <span>{validationIssues.filter((issue) => issue.level === 'warning').length} warnings</span>
            </div>
            <pre className="export-preview live-preview" aria-label="live preview yaml">
              <code>{yamlOutput}</code>
            </pre>
          </div>
        </div>
      )}
      {helpOpen && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Help">
          <div className="command-modal">
            <div className="modal-header">
              <div>
                <div className="section-title">Help</div>
                <h2>Visual Kubernetes shortcuts</h2>
              </div>
              <button type="button" className="icon-button" onClick={() => setHelpOpen(false)}>
                Close
              </button>
            </div>
            <div className="section-card compact">
              <div className="node-type-description">Mouse wheel zooms the canvas. Drag the background to pan. Drag node ports to create valid Kubernetes-aware links.</div>
              <div className="node-type-description">Top menus mirror key toolbar actions and provide overflow space as the tool grows.</div>
            </div>
          </div>
        </div>
      )}
      {templatesOpen && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Template browser">
          <div className="template-modal">
            <div className="modal-header">
              <div>
                <div className="section-title">Templates</div>
                <h2>Graph browser</h2>
              </div>
              <button type="button" className="icon-button" onClick={() => setTemplatesOpen(false)}>
                Close
              </button>
            </div>
            <div className="library-tabs" aria-label="Template tabs">
              <button type="button" className={templateTab === 'builtin' ? 'mini-tab active' : 'mini-tab'} onClick={() => setTemplateTab('builtin')}>
                Out-of-box
              </button>
              <button type="button" className={templateTab === 'custom' ? 'mini-tab active' : 'mini-tab'} onClick={() => setTemplateTab('custom')}>
                Custom
              </button>
            </div>
            <div className="template-browser">
              <div className="template-grid" aria-label="Graph templates">
                {activeGraphTemplates.length > 0 ? (
                  activeGraphTemplates.map((template) => (
                    <button
                      key={template.id}
                      type="button"
                      className={template.id === selectedGraphTemplate?.id ? 'template-card active' : 'template-card'}
                      onClick={() => setSelectedTemplateId(template.id)}
                      onDoubleClick={() => loadGraphTemplate(template, 'replace')}
                    >
                      <span className="template-thumb">{template.thumbnail}</span>
                      <strong>{template.name}</strong>
                      <small>{template.workspace.model.nodes.length} nodes / {template.workspace.model.clusters.length} clusters</small>
                    </button>
                  ))
                ) : (
                  <div className="empty-template-state">No custom templates yet. Save the current graph to create one.</div>
                )}
              </div>
              <div className="template-detail">
                {selectedGraphTemplate && (
                  <>
                    <div className="section-title">Selected template</div>
                    <h3>{selectedGraphTemplate.name}</h3>
                    <p>{selectedGraphTemplate.notes}</p>
                    <div className="template-stats">
                      <span>{selectedGraphTemplate.workspace.model.nodes.length} nodes</span>
                      <span>{selectedGraphTemplate.workspace.model.edges.length} edges</span>
                      <span>{selectedGraphTemplate.workspace.model.clusters.length} clusters</span>
                      <span>{selectedGraphTemplate.workspace.model.provider}</span>
                    </div>
                    <div className="template-actions">
                      <button type="button" className="primary-button" onClick={() => loadGraphTemplate(selectedGraphTemplate, 'replace')}>
                        Replace graph
                      </button>
                      <button type="button" className="ghost-button" onClick={() => loadGraphTemplate(selectedGraphTemplate, 'merge')}>
                        Merge with offset
                      </button>
                      {templateTab === 'custom' && (
                        <button type="button" className="danger-button" onClick={() => deleteCustomGraphTemplate(selectedGraphTemplate.id)}>
                          Delete template
                        </button>
                      )}
                    </div>
                  </>
                )}
                <div className="save-template-panel">
                  <div className="section-title">Save current graph</div>
                  <label>
                    Template name
                    <input value={templateSaveName} onChange={(event) => setTemplateSaveName(event.target.value)} />
                  </label>
                  <label>
                    Notes
                    <textarea className="code-input compact-input" value={templateSaveNotes} onChange={(event) => setTemplateSaveNotes(event.target.value)} />
                  </label>
                  <button type="button" className="primary-button wide" onClick={saveCurrentGraphTemplate}>
                    Save current as template
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
