import { useEffect, useMemo, useRef, useState } from 'react';
import JSZip from 'jszip';
import { availableNodeTypes, createNodeTemplate, starterWorkspace, supportedEnvironments } from './data';
import {
  canConnectNodes,
  detectPattern,
  generateDeploymentPlan,
  getDerivedEnvironmentVariables,
  generateKubernetesYaml,
  generateProjectFiles,
  generateTerraform,
  getResolvedModel,
  getProviderProfile,
  inferEdgeType,
  validateArchitecture,
} from './engine';
import { loadWorkspace, saveWorkspace } from './storage';
import type { ArchitectureEdge, ArchitectureNode, EdgeType, EnvironmentName, NetworkPolicyIntent, NodeType, WorkspaceState } from './types';

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
};

const canvasBounds = {
  width: 1600,
  height: 900,
  nodeWidth: 248,
  nodeHeight: 154,
};

const nodePortOffsetY = 56;
const nodePortInset = 12;
const editorMenus = ['File', 'Edit', 'Asset', 'View', 'Graph', 'Tools', 'Help'];
const actionBarItems = ['Compile', 'Save', 'Browse', 'Diff', 'Find', 'Blueprint Settings'];
const workbenchTabs = ['Viewport', 'Cluster Graph', 'Runtime Model'];

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
};

function environmentLabel(environment: EnvironmentName) {
  return environment === 'prod' ? 'Prod' : environment === 'stage' ? 'Stage' : 'Dev';
}

function nextLayoutPosition(count: number) {
  const column = count % 4;
  const row = Math.floor(count / 4);
  return {
    x: 80 + column * 280,
    y: 100 + row * 180,
  };
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

export function App() {
  const [workspace, setWorkspace] = useState<WorkspaceState>(() => loadWorkspace());
  const [selectedNodeId, setSelectedNodeId] = useState(workspace.model.nodes[0]?.id ?? '');
  const [leftRailOpen, setLeftRailOpen] = useState(true);
  const [rightRailOpen, setRightRailOpen] = useState(true);
  const [leftRailWidth, setLeftRailWidth] = useState(380);
  const [rightRailWidth, setRightRailWidth] = useState(420);
  const [exportMode, setExportMode] = useState<'yaml' | 'terraform'>('yaml');
  const [dockHeight, setDockHeight] = useState(320);
  const [newNodeType, setNewNodeType] = useState<NodeType>('service');
  const [canvasConnectMode, setCanvasConnectMode] = useState(false);
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
  const edgeSequenceRef = useRef(0);

  const model = workspace.model;
  const resolvedModel = useMemo(() => getResolvedModel(model), [model]);
  const layout = workspace.layout;
  const validationIssues = useMemo(() => validateArchitecture(model), [model]);
  const deploymentPlan = useMemo(() => generateDeploymentPlan(model), [model]);
  const yamlOutput = useMemo(() => generateKubernetesYaml(model), [model]);
  const terraformOutput = useMemo(() => generateTerraform(model), [model]);
  const selectedNode = model.nodes.find((node) => node.id === selectedNodeId) ?? model.nodes[0];
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

  useEffect(() => {
    saveWorkspace(workspace);
  }, [workspace]);

  useEffect(() => {
    function handleWindowPointerMove(event: PointerEvent) {
      if (dockResizeRef.current) {
        const delta = dockResizeRef.current.startY - event.clientY;
        setDockHeight(Math.min(620, Math.max(180, dockResizeRef.current.startHeight + delta)));
      }

      if (leftRailResizeRef.current) {
        const delta = event.clientX - leftRailResizeRef.current.startX;
        setLeftRailWidth(Math.min(560, Math.max(300, leftRailResizeRef.current.startWidth + delta)));
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

  function updateModel(patch: Partial<WorkspaceState['model']>) {
    setWorkspace((current) => ({
      ...current,
      model: {
        ...current.model,
        ...patch,
      },
    }));
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

  function updateNodePosition(nodeId: string, x: number, y: number) {
    const clampedX = Math.min(Math.max(24, x), canvasBounds.width - canvasBounds.nodeWidth - 24);
    const clampedY = Math.min(Math.max(24, y), canvasBounds.height - canvasBounds.nodeHeight - 24);

    setWorkspace((current) => ({
      ...current,
      layout: {
        ...current.layout,
        [nodeId]: { x: clampedX, y: clampedY },
      },
    }));
  }

  function handlePointerMove(event: React.PointerEvent<SVGSVGElement>) {
    const svgRect = event.currentTarget.getBoundingClientRect();
    const scaleX = canvasBounds.width / svgRect.width;
    const scaleY = canvasBounds.height / svgRect.height;
    const svgX = (event.clientX - svgRect.left) * scaleX;
    const svgY = (event.clientY - svgRect.top) * scaleY;

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
        if (!pos) continue;
        if (
          svgX >= pos.x &&
          svgX <= pos.x + canvasBounds.nodeWidth &&
          svgY >= pos.y &&
          svgY <= pos.y + canvasBounds.nodeHeight
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
    dragRef.current = null;
  }

  function handleSVGPointerLeave() {
    dragRef.current = null;
  }

  function addNode(type: NodeType) {
    const previousSelectedNodeId = selectedNode?.id ?? model.nodes[0]?.id ?? '';
    const node = createNodeTemplate(type, model.defaultNamespace);
    const position = nextLayoutPosition(model.nodes.length);
    const sourceNode = model.nodes.find((candidate) => candidate.id === previousSelectedNodeId);
    const suggestedType = sourceNode ? inferEdgeType(sourceNode, node) : 'http';

    setWorkspace((current) => ({
      model: {
        ...current.model,
        nodes: [...current.model.nodes, node],
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
      text: `${node.name} added. Connect it from the stage or use the connection form.`,
    });
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

  const exportText = exportMode === 'yaml' ? yamlOutput : terraformOutput;

  function startHandleConnection(nodeId: string, event: React.PointerEvent<SVGCircleElement>) {
    const svgEl = event.currentTarget.ownerSVGElement;
    const svgRect = svgEl?.getBoundingClientRect();
    if (!svgRect || !svgEl) {
      return;
    }

    const scaleX = canvasBounds.width / svgRect.width;
    const scaleY = canvasBounds.height / svgRect.height;
    const svgX = (event.clientX - svgRect.left) * scaleX;
    const svgY = (event.clientY - svgRect.top) * scaleY;

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
            {editorMenus.map((item) => (
              <button key={item} type="button" className="menu-button">
                {item}
              </button>
            ))}
          </nav>
          <div className="editor-context">
            {model.activeEnvironment.toUpperCase()} | Provider {model.provider.toUpperCase()}
          </div>
        </div>

        <div className="editor-actionbar">
          <div className="editor-action-group">
            {actionBarItems.map((item) => (
              <button key={item} type="button" className="chrome-button">
                {item}
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
            <button type="button" className="chrome-button active">
              Cluster Defaults
            </button>
            <button type="button" className="chrome-button">
              Simulate
            </button>
            <button type="button" className="chrome-button">
              Play
            </button>
          </div>
        </div>

        <div className="editor-tabbar">
          <div className="editor-tab-track">
            {workbenchTabs.map((tab, index) => (
              <button key={tab} type="button" className={index === 1 ? 'workspace-tab active' : 'workspace-tab'}>
                {tab}
              </button>
            ))}
          </div>
          <div className="editor-top-status">{model.activeEnvironment} environment active</div>
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
            <div className="section-card">
              <div className="section-title">Project</div>
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
            </div>

            <div className="section-card">
              <div className="section-title">Add node</div>
              <div className="field-grid">
                <label>
                  Node type
                  <select value={newNodeType} onChange={(event) => setNewNodeType(event.target.value as NodeType)}>
                    {availableNodeTypes.map((nodeType) => (
                      <option key={nodeType.type} value={nodeType.type}>
                        {nodeType.label}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="node-type-description span-two">
                  {availableNodeTypes.find((nodeType) => nodeType.type === newNodeType)?.description}
                </div>
                <div className="behavior-card span-two">
                  <strong>Behavior</strong>
                  <span>{nodeBehaviorCopy[newNodeType]}</span>
                </div>
              </div>
              <button type="button" className="primary-button wide" onClick={() => addNode(newNodeType)}>
                Add node
              </button>
            </div>

            <div className="section-card">
              <div className="section-title">Connections</div>
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
            </div>

            <div className="section-card compact">
              <div className="section-title">Workspace</div>
              <button type="button" className="ghost-button wide" onClick={resetWorkspace}>
                Reset model
              </button>
            </div>
          </div>
        )}
      </aside>
      {leftRailOpen && (
        <div
          className="side-resizer"
          onPointerDown={(event) => {
            leftRailResizeRef.current = { startX: event.clientX, startWidth: leftRailWidth };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          aria-label="Resize left panel"
        />
      )}

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

        <section className="canvas-stage">
          <div className="canvas-watermark">CLUSTER GRAPH</div>
          <svg
            viewBox={`0 0 ${canvasBounds.width} ${canvasBounds.height}`}
            role="img"
            aria-label="Architecture diagram"
            className="diagram"
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

            {resolvedModel.edges.map((edge) => {
              const from = layout[edge.from];
              const to = layout[edge.to];
              if (!from || !to) {
                return null;
              }

              const x1 = from.x + canvasBounds.nodeWidth - nodePortInset;
              const y1 = from.y + nodePortOffsetY;
              const x2 = to.x + nodePortInset;
              const y2 = to.y + nodePortOffsetY;
              const dx = Math.max(Math.abs(x2 - x1) * 0.5, 80);

              return (
                <g key={edge.id}>
                  <path
                    d={`M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`}
                    stroke={edge.networkPolicy === 'deny' ? '#ff6b6b' : 'url(#edgeGlow)'}
                    strokeWidth="3"
                    fill="none"
                    strokeDasharray={edge.networkPolicy === 'deny' ? '2 8' : edge.type === 'async' ? '12 6' : edge.type === 'data' ? '4 4' : undefined}
                  />
                  <text x={(x1 + x2) / 2} y={Math.min(y1, y2) - 10} textAnchor="middle" className="edge-label">
                    {edge.type} | {edge.latencyBudgetMs}ms | {edge.networkPolicy}
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

                const x1 = from.x + canvasBounds.nodeWidth - nodePortInset;
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
              const runtimeLabel = `${node.image}:${node.tag}`;
              const pinTargetLabel =
                node.type === 'database' || node.type === 'cache'
                  ? 'storage'
                  : node.type === 'queue'
                    ? 'events'
                    : node.type === 'job' || node.type === 'cronjob'
                      ? 'trigger'
                      : 'in';
              const pinSourceLabel =
                node.type === 'ingress'
                  ? 'route'
                  : node.type === 'database'
                    ? 'rows'
                    : node.type === 'job' || node.type === 'cronjob' || node.type === 'worker'
                      ? 'deps'
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
                    if (!svgRect) {
                      return;
                    }

                    const scaleX = canvasBounds.width / svgRect.width;
                    const scaleY = canvasBounds.height / svgRect.height;
                    dragRef.current = {
                      nodeId: node.id,
                      offsetX: (event.clientX - svgRect.left) * scaleX - position.x,
                      offsetY: (event.clientY - svgRect.top) * scaleY - position.y,
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
                    width={canvasBounds.nodeWidth}
                    height={canvasBounds.nodeHeight}
                    fill={selected ? '#1b1d22' : '#17191d'}
                    stroke={borderColor}
                    strokeWidth={borderWidth}
                  />
                  <rect x={position.x} y={position.y} rx="8" ry="8" width={canvasBounds.nodeWidth} height="6" fill={headerColor} />
                  <rect x={position.x + 1} y={position.y + 8} rx="6" ry="6" width={canvasBounds.nodeWidth - 2} height="28" fill="#101216" />
                  <rect x={position.x + 1} y={position.y + 42} width={canvasBounds.nodeWidth - 2} height="1" fill="#2b3038" />
                  <text x={position.x + 16} y={position.y + 28} className="node-header-text">
                    {node.name}
                  </text>
                  <text x={position.x + canvasBounds.nodeWidth - 16} y={position.y + 28} textAnchor="end" className="node-kind-text">
                    {nodeKindLabel}
                  </text>
                  <text x={position.x + 26} y={position.y + 60} className="node-pin-label">
                    {pinTargetLabel}
                  </text>
                  <text x={position.x + canvasBounds.nodeWidth - 26} y={position.y + 60} textAnchor="end" className="node-pin-label">
                    {pinSourceLabel}
                  </text>
                  <text x={position.x + 16} y={position.y + 86} className="node-meta">
                    {runtimeLabel}
                  </text>
                  <text x={position.x + 16} y={position.y + 106} className="node-meta">
                    ns {node.namespace} | {node.workload.kind}
                  </text>
                  <text x={position.x + 16} y={position.y + 126} className="node-meta">
                    sa {node.serviceAccountName}
                  </text>
                  <text x={position.x + 16} y={position.y + 144} className="node-footer-text">
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
                    cx={position.x + canvasBounds.nodeWidth - nodePortInset}
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
            <button type="button" className={exportMode === 'yaml' ? 'tab active' : 'tab'} onClick={() => setExportMode('yaml')}>
              Kubernetes YAML
            </button>
            <button type="button" className={exportMode === 'terraform' ? 'tab active' : 'tab'} onClick={() => setExportMode('terraform')}>
              Terraform
            </button>
            <div className="dock-actions">
              <button type="button" className="icon-button" onClick={() => downloadSingleFile('manifests.yaml', yamlOutput)}>
                Download YAML
              </button>
              <button type="button" className="icon-button" onClick={() => downloadSingleFile('main.tf', terraformOutput)}>
                Download Terraform
              </button>
              <button type="button" className="primary-button" onClick={downloadBundle}>
                Download ZIP
              </button>
            </div>
          </div>
          <pre className="export-preview" aria-label={`${exportMode} export`}>
            <code>{exportText}</code>
          </pre>
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
        {rightRailOpen && selectedNode && selectedNodeResolved && (
          <div className="rail-content inspector-content">
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
          </div>
        )}
      </aside>
      </div>
    </div>
  );
}
