import { useEffect, useMemo, useRef, useState } from 'react';
import JSZip from 'jszip';
import { availableNodeTypes, createNodeTemplate, starterWorkspace } from './data';
import {
  canConnectNodes,
  detectPattern,
  generateDeploymentPlan,
  generateKubernetesYaml,
  generateProjectFiles,
  generateTerraform,
  inferEdgeType,
  validateArchitecture,
} from './engine';
import { loadWorkspace, saveWorkspace } from './storage';
import type { ArchitectureEdge, ArchitectureNode, EdgeType, NodeType, WorkspaceState } from './types';

const nodeColors: Record<NodeType, string> = {
  ingress: '#4dabf7',
  frontend: '#ff6b6b',
  gateway: '#74c0fc',
  service: '#f59f00',
  worker: '#ffd43b',
  database: '#845ef7',
  cache: '#51cf66',
  queue: '#12b886',
};

const canvasBounds = {
  width: 1600,
  height: 900,
  nodeWidth: 220,
  nodeHeight: 132,
};

const nodePortOffsetY = 106;
const nodePortInset = 14;

function nextLayoutPosition(count: number) {
  const column = count % 4;
  const row = Math.floor(count / 4);
  return {
    x: 80 + column * 280,
    y: 100 + row * 180,
  };
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
  const [edgeDraft, setEdgeDraft] = useState<{ from: string; to: string; type: EdgeType; latencyBudgetMs: number }>({
    from: workspace.model.nodes[0]?.id ?? '',
    to: workspace.model.nodes[1]?.id ?? '',
    type: 'http',
    latencyBudgetMs: 100,
  });

  const dragRef = useRef<{ nodeId: string; offsetX: number; offsetY: number } | null>(null);
  const dockResizeRef = useRef<{ startY: number; startHeight: number } | null>(null);
  const leftRailResizeRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const rightRailResizeRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const edgeSequenceRef = useRef(0);

  const model = workspace.model;
  const layout = workspace.layout;
  const validationIssues = useMemo(() => validateArchitecture(model), [model]);
  const deploymentPlan = useMemo(() => generateDeploymentPlan(model), [model]);
  const yamlOutput = useMemo(() => generateKubernetesYaml(model), [model]);
  const terraformOutput = useMemo(() => generateTerraform(model), [model]);
  const selectedNode = model.nodes.find((node) => node.id === selectedNodeId) ?? model.nodes[0];

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
      for (const node of model.nodes) {
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
        const fromNode = model.nodes.find((n) => n.id === dragConnection.fromId);
        const toNode = model.nodes.find((n) => n.id === dragConnection.hoveredNodeId);
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
                  <select value={edgeDraft.from} onChange={(event) => setEdgeDraft((current) => ({ ...current, from: event.target.value }))}>
                    {model.nodes.map((node) => (
                      <option key={node.id} value={node.id}>
                        {node.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  To
                  <select value={edgeDraft.to} onChange={(event) => setEdgeDraft((current) => ({ ...current, to: event.target.value }))}>
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
            <strong>Visual Kubernetes</strong>
            <span className="toolbar-chip">{detectPattern(model)}</span>
            <span className="toolbar-chip">{deploymentPlan.nodeCount} nodes</span>
            <span className="toolbar-chip">{model.provider}</span>
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

            {model.edges.map((edge) => {
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
                    stroke="url(#edgeGlow)"
                    strokeWidth="3"
                    fill="none"
                    strokeDasharray={edge.type === 'async' ? '12 6' : edge.type === 'data' ? '4 4' : undefined}
                  />
                  <text x={(x1 + x2) / 2} y={Math.min(y1, y2) - 10} textAnchor="middle" className="edge-label">
                    {edge.type} | {edge.latencyBudgetMs}ms
                  </text>
                </g>
              );
            })}

            {dragConnection &&
              (() => {
                const from = layout[dragConnection.fromId];
                if (!from) return null;

                const fromNode = model.nodes.find((n) => n.id === dragConnection.fromId);
                const hoveredNode = dragConnection.hoveredNodeId ? model.nodes.find((n) => n.id === dragConnection.hoveredNodeId) : null;
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

            {model.nodes.map((node) => {
              const position = layout[node.id];
              if (!position) {
                return null;
              }

              const selected = node.id === selectedNode?.id;
              const headerColor = nodeColors[node.type];
              const isDragSource = dragConnection?.fromId === node.id;
              const isHoveredTarget = dragConnection?.hoveredNodeId === node.id;
              const dragSourceNode = dragConnection ? model.nodes.find((n) => n.id === dragConnection.fromId) : undefined;
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
                    rx="14"
                    ry="14"
                    width="220"
                    height="132"
                    fill={selected ? '#1a1f2b' : '#151922'}
                    stroke={borderColor}
                    strokeWidth={borderWidth}
                  />
                  <rect x={position.x} y={position.y} rx="14" ry="14" width="220" height="30" fill={headerColor} />
                  <text x={position.x + 20} y={position.y + 20} className="node-header-text">
                    {node.name}
                  </text>
                  <text x={position.x + 20} y={position.y + 52} className="node-meta">
                    {node.image}:{node.tag}
                  </text>
                  <text x={position.x + 20} y={position.y + 74} className="node-meta">
                    ns {node.namespace} | svc {node.service.port}
                  </text>
                  <text x={position.x + 20} y={position.y + 96} className="node-meta">
                    sa {node.serviceAccountName}
                  </text>
                  <circle
                    cx={position.x + nodePortInset}
                    cy={position.y + nodePortOffsetY}
                    r="7"
                    fill={inputPortFill}
                    stroke={inputPortStroke}
                    strokeWidth="2"
                    className={inputPortClass}
                  />
                  <circle
                    cx={position.x + canvasBounds.nodeWidth - nodePortInset}
                    cy={position.y + nodePortOffsetY}
                    r="7"
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
        {rightRailOpen && selectedNode && (
          <div className="rail-content inspector-content">
            <div className="section-card compact">
              <div className="section-title">Selected</div>
              <div className="selected-name">{selectedNode.name}</div>
              <div className="selected-subtle">
                <span>{selectedNode.type}</span>
                <span>{selectedNode.namespace}</span>
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
              <div className="section-title">Service</div>
              <div className="field-grid">
                <label>
                  Service type
                  <select
                    value={selectedNode.service.type}
                    onChange={(event) => updateNode({ service: { ...selectedNode.service, type: event.target.value as ArchitectureNode['service']['type'] } })}
                  >
                    <option value="ClusterIP">ClusterIP</option>
                    <option value="NodePort">NodePort</option>
                    <option value="LoadBalancer">LoadBalancer</option>
                  </select>
                </label>
                <label>
                  Service port
                  <input type="number" min="1" value={selectedNode.service.port} onChange={(event) => updateNode({ service: { ...selectedNode.service, port: Number(event.target.value) } })} />
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
                  Readiness path
                  <input value={selectedNode.readinessProbe.path} onChange={(event) => updateNode({ readinessProbe: { ...selectedNode.readinessProbe, path: event.target.value } })} />
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
                    value={selectedNode.secretEnv.map((entry) => `${entry.key}=${entry.value}`).join('\n')}
                    onChange={(event) =>
                      updateNode({
                        secretEnv: event.target.value
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
              </div>
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
                  <input value={selectedNode.storage.storageClassName} onChange={(event) => updateNode({ storage: { ...selectedNode.storage, storageClassName: event.target.value } })} />
                </label>
                <label className="span-two">
                  Mount path
                  <input value={selectedNode.storage.mountPath} onChange={(event) => updateNode({ storage: { ...selectedNode.storage, mountPath: event.target.value } })} />
                </label>
                <label className="toggle-row span-two">
                  <span>Enable ingress</span>
                  <input type="checkbox" checked={selectedNode.ingress.enabled} onChange={(event) => updateNode({ ingress: { ...selectedNode.ingress, enabled: event.target.checked } })} />
                </label>
                <label>
                  Ingress host
                  <input value={selectedNode.ingress.host} onChange={(event) => updateNode({ ingress: { ...selectedNode.ingress, host: event.target.value } })} />
                </label>
                <label>
                  Ingress path
                  <input value={selectedNode.ingress.path} onChange={(event) => updateNode({ ingress: { ...selectedNode.ingress, path: event.target.value } })} />
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
              <button type="button" className="danger-button wide" onClick={deleteSelectedNode}>
                Delete node
              </button>
            </div>
          </div>
        )}
      </aside>
    </div>
  );
}
