import { fireEvent, render, screen } from '@testing-library/react';
import { App } from './App';
import { GRAPH_TEMPLATE_STORAGE_KEY, NODE_LIBRARY_STORAGE_KEY, WORKSPACE_STORAGE_KEY } from './storage';

function addLibraryTile(name: RegExp) {
  fireEvent.click(screen.getByRole('button', { name }));
  fireEvent.click(screen.getByRole('button', { name: /Add selected tile/i }));
}

describe('App', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('adds a new node from the component palette', () => {
    render(<App />);

    addLibraryTile(/Add rest service/i);

    expect(screen.getAllByText(/rest service/i).length).toBeGreaterThan(0);
  });

  it('includes a generic workload fallback tile for custom cases', () => {
    render(<App />);

    addLibraryTile(/Add generic workload/i);

    expect(screen.getAllByText(/generic workload/i).length).toBeGreaterThan(0);
    expect(screen.getByLabelText(/yaml export/i)).toHaveTextContent('image: ghcr.io/visual-kubernetes/custom-workload:latest');
    expect(screen.getByLabelText(/yaml export/i)).toHaveTextContent('kind: Deployment');
  });

  it('persists workspace changes to local storage', () => {
    render(<App />);

    fireEvent.change(screen.getByLabelText('Workload replicas'), { target: { value: '4' } });

    const saved = window.localStorage.getItem(WORKSPACE_STORAGE_KEY);
    expect(saved).toContain('"replicas":4');
  });

  it('updates namespace in the project settings', () => {
    render(<App />);

    fireEvent.change(screen.getByLabelText(/Default namespace/i), { target: { value: 'prod-checkout' } });

    expect(screen.getByDisplayValue('prod-checkout')).toBeInTheDocument();
  });

  it('renders the scoped menubar and actionbar command labels', () => {
    render(<App />);

    expect(screen.getByRole('button', { name: 'File' })).toHaveAttribute('title', expect.stringContaining('Import YAML'));
    expect(screen.getByRole('button', { name: 'View' })).toHaveAttribute('title', expect.stringContaining('Toggle Inspector'));
    expect(screen.getByRole('button', { name: 'Compile' })).toHaveAttribute('title', expect.stringContaining('Validate graph'));
    expect(screen.getByRole('button', { name: 'Blueprint Settings' })).toHaveAttribute('title', expect.stringContaining('stack-wide defaults'));
    expect(screen.getByRole('button', { name: 'Simulate' })).toHaveAttribute('title', expect.stringContaining('traffic'));
  });

  it('switches the active environment and updates export output', () => {
    render(<App />);

    fireEvent.change(screen.getAllByLabelText(/Environment/i)[0]!, { target: { value: 'dev' } });

    expect(screen.getByLabelText(/yaml export/i)).toHaveTextContent('api.dev.checkout.internal');
    expect(screen.getByLabelText(/yaml export/i)).toHaveTextContent('checkout-service:1.0.0-dev');
  });

  it('switches environments from the top workflow bar', () => {
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: 'Dev' }));

    expect(screen.getByLabelText(/yaml export/i)).toHaveTextContent('api.dev.checkout.internal');
    expect(screen.getByText(/DEV \| Provider AWS/i)).toBeInTheDocument();
  });

  it('switches provider-aware defaults in the UI and export output', () => {
    render(<App />);

    fireEvent.change(screen.getByLabelText(/Provider/i), { target: { value: 'gcp' } });

    expect(screen.getByText(/standard-rwo storage/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/yaml export/i)).toHaveTextContent('ingressClassName: gce');
    expect(screen.getByLabelText(/yaml export/i)).toHaveTextContent('storageClassName: standard-rwo');
  });

  it('edits cluster grouping metadata and assigns new nodes to the active cluster', () => {
    render(<App />);

    expect(screen.getAllByText('Primary EKS').length).toBeGreaterThan(0);

    fireEvent.change(screen.getByLabelText(/Worker count/i), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: /Add cluster/i }));
    fireEvent.change(screen.getAllByLabelText(/^Name$/i)[0]!, { target: { value: 'West AKS' } });
    fireEvent.change(screen.getByLabelText(/Cloud/i), { target: { value: 'azure' } });
    addLibraryTile(/Add rest service/i);

    const saved = window.localStorage.getItem(WORKSPACE_STORAGE_KEY) ?? '';
    expect(saved).toContain('"workerCount":5');
    expect(saved).toContain('"name":"West AKS"');
    expect(saved).toContain('"provider":"azure"');
    expect(saved).toMatch(/"nodeIds":\["service-\d+"\]/);
  });

  it('controls canvas zoom from the graph toolbar', () => {
    render(<App />);

    expect(screen.getAllByText('100%').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: 'Fit' }));
    expect(screen.getByText('140%')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '100%' }));
    expect(screen.getAllByText('100%').length).toBeGreaterThan(0);
  });

  it('pans the canvas with a normal background drag', () => {
    const { container } = render(<App />);
    const diagram = screen.getByRole('img', { name: /architecture diagram/i });
    const graphLayer = container.querySelector('.graph-layer');

    expect(graphLayer).toHaveAttribute('transform', 'translate(0 0) scale(1)');

    fireEvent.pointerDown(diagram, { button: 0, clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(diagram, { clientX: 150, clientY: 130, pointerId: 1 });
    fireEvent.pointerUp(diagram, { pointerId: 1 });

    expect(graphLayer?.getAttribute('transform')).not.toBe('translate(0 0) scale(1)');
  });

  it('shows graph-derived dependency wiring for the selected node', () => {
    render(<App />);

    fireEvent.click(screen.getAllByText('Checkout Service').at(-1)!);

    expect(screen.getByText('INVENTORY_SERVICE_SERVICE_URL')).toBeInTheDocument();
    expect(screen.getByText('amqp://domain-events.platform.svc.cluster.local:5672')).toBeInTheDocument();
  });

  it('edits security settings for the selected node', () => {
    render(<App />);

    fireEvent.click(screen.getAllByText('Checkout Service').at(-1)!);
    fireEvent.change(screen.getByLabelText(/Image pull secrets/i), { target: { value: 'private-registry-secret' } });
    fireEvent.change(screen.getByLabelText(/Run as user/i), { target: { value: '2000' } });

    expect(screen.getByLabelText(/yaml export/i)).toHaveTextContent('name: private-registry-secret');
    expect(screen.getByLabelText(/yaml export/i)).toHaveTextContent('runAsUser: 2000');
  });

  it('connects a newly added node from the connection form', () => {
    render(<App />);

    addLibraryTile(/Add queue worker/i);
    const workerOption = screen.getAllByRole('option', { name: /queue worker/i }).at(-1);

    expect(workerOption).toBeTruthy();
    const workerId = workerOption!.getAttribute('value')!;

    fireEvent.change(screen.getByLabelText(/^From$/i), { target: { value: workerId } });
    fireEvent.change(screen.getByLabelText(/^To$/i), { target: { value: 'queue-events' } });
    fireEvent.click(screen.getByRole('button', { name: /Add connection/i }));

    expect(screen.getAllByText(/async \| 100ms/i).length).toBeGreaterThan(0);
    expect(window.localStorage.getItem(WORKSPACE_STORAGE_KEY)).toContain(`"from":"${workerId}"`);
  });

  it('uses connection guidance to select a valid inferred edge target', () => {
    render(<App />);

    fireEvent.change(screen.getByLabelText(/^From$/i), { target: { value: 'service-inventory' } });
    fireEvent.click(screen.getByRole('button', { name: /Domain Eventsasync/i }));
    fireEvent.click(screen.getByRole('button', { name: /Add connection/i }));

    expect(screen.getAllByText(/async \| 100ms \| allow/i).length).toBeGreaterThan(0);
    expect(window.localStorage.getItem(WORKSPACE_STORAGE_KEY)).toContain('"from":"service-inventory","to":"queue-events","type":"async"');
  });

  it('applies quick workflow actions for common deployment fields', () => {
    render(<App />);

    addLibraryTile(/Add rest service/i);
    fireEvent.click(screen.getByRole('button', { name: /Prod-ready/i }));
    fireEvent.click(screen.getByRole('button', { name: /Public TLS ingress/i }));

    expect(window.localStorage.getItem(WORKSPACE_STORAGE_KEY)).toContain('"tag":"1.0.0"');
    expect(screen.getByLabelText(/yaml export/i)).toHaveTextContent('cert-manager.io/cluster-issuer: "letsencrypt-prod"');
  });

  it('adds cronjob workloads and exports scheduled batch yaml', () => {
    render(<App />);

    addLibraryTile(/Add maintenance cron/i);

    expect(screen.getAllByText(/maintenance cron/i).length).toBeGreaterThan(0);
    expect(screen.getByLabelText(/yaml export/i)).toHaveTextContent('kind: CronJob');
    expect(screen.getByLabelText(/yaml export/i)).toHaveTextContent('schedule: "*/15 * * * *"');
  });

  it('adds explicit NetworkPolicy and Role nodes from the palette', () => {
    render(<App />);

    addLibraryTile(/Add network policy/i);
    fireEvent.change(screen.getByLabelText(/Target selector labels/i), { target: { value: 'app=checkout-service' } });

    expect(screen.getByLabelText(/yaml export/i)).toHaveTextContent('kind: NetworkPolicy');
    expect(screen.getByLabelText(/yaml export/i)).toHaveTextContent('app: checkout-service');

    addLibraryTile(/Add rbac role/i);

    expect((screen.getByLabelText(/Service accounts/i) as HTMLTextAreaElement).value).toMatch(/role-\d+-sa/);
    expect(screen.getByLabelText(/yaml export/i)).toHaveTextContent('kind: RoleBinding');
  });

  it('saves and edits custom node library tiles separately from the workspace', () => {
    render(<App />);

    fireEvent.click(screen.getAllByText('Checkout Service').at(-1)!);
    fireEvent.click(screen.getByRole('button', { name: /Save selected as custom/i }));
    fireEvent.change(screen.getByLabelText(/Custom tile notes/i), { target: { value: 'Reusable checkout service tile' } });

    const customLibrary = window.localStorage.getItem(NODE_LIBRARY_STORAGE_KEY) ?? '';
    expect(customLibrary).toContain('Checkout Service');
    expect(customLibrary).toContain('Reusable checkout service tile');
    expect(window.localStorage.getItem(WORKSPACE_STORAGE_KEY)).not.toContain('Reusable checkout service tile');
  });

  it('drops a library tile onto the zoom-aware canvas', () => {
    const { container } = render(<App />);
    const transferData: Record<string, string> = {};
    const dataTransfer = {
      effectAllowed: '',
      dropEffect: '',
      setData: (type: string, value: string) => {
        transferData[type] = value;
      },
      getData: (type: string) => transferData[type] ?? '',
    };
    const diagram = screen.getByRole('img', { name: /architecture diagram/i });
    vi.spyOn(diagram, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      right: 1600,
      bottom: 900,
      width: 1600,
      height: 900,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);

    fireEvent.dragStart(screen.getByRole('button', { name: /Add redis cache/i }), { dataTransfer });
    fireEvent.drop(container.querySelector('.canvas-stage')!, { dataTransfer, clientX: 800, clientY: 450 });

    expect(screen.getAllByText(/redis cache/i).length).toBeGreaterThan(0);
    expect(window.localStorage.getItem(WORKSPACE_STORAGE_KEY)).toContain('"cache-');
  });

  it('loads an out-of-box graph template by replacing the current graph', () => {
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: /Open templates/i }));
    fireEvent.click(screen.getByRole('button', { name: /Monolith \+ Database/i }));
    fireEvent.click(screen.getByRole('button', { name: /Replace graph/i }));

    expect(screen.getAllByText(/Monolith App/i).length).toBeGreaterThan(0);
    expect(screen.getByLabelText(/yaml export/i)).toHaveTextContent('namespace: monolith');
    expect(window.localStorage.getItem(WORKSPACE_STORAGE_KEY)).toContain('Monolith Platform');
  });

  it('saves and merges custom full-graph templates', () => {
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: 'Browse' }));
    fireEvent.change(screen.getByLabelText(/Template name/i), { target: { value: 'Current checkout template' } });
    fireEvent.change(screen.getByLabelText(/^Notes$/i), { target: { value: 'Reusable checkout graph' } });
    fireEvent.click(screen.getByRole('button', { name: /Save current as template/i }));

    expect(window.localStorage.getItem(GRAPH_TEMPLATE_STORAGE_KEY)).toContain('Current checkout template');
    fireEvent.click(screen.getByRole('button', { name: /Merge with offset/i }));

    const saved = window.localStorage.getItem(WORKSPACE_STORAGE_KEY) ?? '';
    expect(saved).toContain('Checkout Service copy');
    expect(saved).toContain('cluster-primary-tpl-');
  });

  it('edits storage depth settings for stateful exports', () => {
    render(<App />);

    fireEvent.click(screen.getAllByText('Orders DB').at(-1)!);
    fireEvent.change(screen.getByLabelText(/Access mode/i), { target: { value: 'ReadWriteOncePod' } });
    fireEvent.change(screen.getByLabelText(/Backup schedule/i), { target: { value: '30 1 * * *' } });

    expect(screen.getByLabelText(/yaml export/i)).toHaveTextContent('- ReadWriteOncePod');
    expect(screen.getByLabelText(/yaml export/i)).toHaveTextContent('persistentVolumeClaimRetentionPolicy:');
    expect(screen.getByLabelText(/yaml export/i)).toHaveTextContent('visual-kubernetes.io/backup-schedule: "30 1 * * *"');
  });

  it('edits networking exposure settings for exports', () => {
    render(<App />);

    fireEvent.click(screen.getAllByText('Public API').at(-1)!);
    fireEvent.change(screen.getByLabelText(/Ingress LB scope/i), { target: { value: 'private' } });
    fireEvent.change(screen.getByLabelText(/TLS issuer/i), { target: { value: 'private-ca' } });

    expect(screen.getByLabelText(/yaml export/i)).toHaveTextContent('alb.ingress.kubernetes.io/scheme: "internal"');
    expect(screen.getByLabelText(/yaml export/i)).toHaveTextContent('cert-manager.io/cluster-issuer: "private-ca"');
  });

  it('edits runtime command and startup probe settings', () => {
    render(<App />);

    fireEvent.click(screen.getAllByText('Checkout Service').at(-1)!);
    fireEvent.change(screen.getByLabelText(/^Command$/i), { target: { value: '/bin/sh' } });
    fireEvent.change(screen.getByLabelText(/^Args$/i), { target: { value: '-c\nnode server.js' } });
    fireEvent.change(screen.getByLabelText(/Startup type/i), { target: { value: 'exec' } });
    fireEvent.change(screen.getByLabelText(/Probe command/i), { target: { value: 'test -f /tmp/ready' } });

    expect(screen.getByLabelText(/yaml export/i)).toHaveTextContent('- "/bin/sh"');
    expect(screen.getByLabelText(/yaml export/i)).toHaveTextContent('- "-c"');
    expect(screen.getByLabelText(/yaml export/i)).toHaveTextContent('- "node server.js"');
    expect(screen.getByLabelText(/yaml export/i)).toHaveTextContent('startupProbe:');
    expect(screen.getByLabelText(/yaml export/i)).toHaveTextContent('exec:');
  });

  it('shows validation issue details in the inspector', () => {
    render(<App />);

    expect(screen.getByText(/Public API has no prod environment override/i)).toBeInTheDocument();
    expect(screen.getAllByText(/warning/i).length).toBeGreaterThan(0);
  });

  it('renders terraform export output', () => {
    render(<App />);

    fireEvent.click(screen.getAllByRole('button', { name: /Terraform/i })[0]!);

    expect(screen.getByLabelText(/terraform export/i)).toHaveTextContent('resource "kubernetes_manifest"');
    expect(screen.getByLabelText(/terraform export/i)).toHaveTextContent('kind: Secret');
  });

  it('hydrates older saved workload objects without blanking the app', () => {
    window.localStorage.setItem(
      WORKSPACE_STORAGE_KEY,
      JSON.stringify({
        model: {
          name: 'Old Workspace',
          defaultNamespace: 'legacy',
          provider: 'aws',
          activeEnvironment: 'prod',
          nodes: [
            {
              id: 'service-old',
              name: 'Old Service',
              type: 'service',
              namespace: 'legacy',
              replicas: 1,
              cpu: 1,
              memory: 1,
              sla: 'standard',
              image: 'nginx',
              tag: 'latest',
              containerPort: 8080,
              env: [],
              secretEnv: [],
              resources: {
                requestsCpu: '100m',
                requestsMemory: '128Mi',
                limitsCpu: '500m',
                limitsMemory: '512Mi',
              },
              readinessProbe: { enabled: true, path: '/ready', port: 8080, initialDelaySeconds: 10, periodSeconds: 10 },
              livenessProbe: { enabled: true, path: '/health', port: 8080, initialDelaySeconds: 10, periodSeconds: 10 },
              autoscaling: { enabled: false, minReplicas: 1, maxReplicas: 1, targetCPUUtilizationPercentage: 70 },
              workload: {
                kind: 'Deployment',
                schedule: '*/15 * * * *',
                completions: 1,
                parallelism: 1,
                backoffLimit: 3,
                restartPolicy: 'Always',
              },
              storage: { enabled: false, size: '5Gi', storageClassName: 'standard', mountPath: '/data' },
              service: { type: 'ClusterIP', port: 80 },
              serviceAccountName: 'old-sa',
              imagePullSecrets: [],
              security: {
                runAsNonRoot: true,
                runAsUser: 1000,
                readOnlyRootFilesystem: true,
                allowPrivilegeEscalation: false,
                seccompProfile: 'RuntimeDefault',
              },
              ingress: { enabled: false, host: 'old.example.internal', path: '/', tlsEnabled: false, tlsSecretName: 'old-tls', ingressClassName: 'nginx' },
              environmentOverrides: {},
            },
          ],
          edges: [],
        },
        layout: {
          'service-old': { x: 80, y: 100 },
        },
      }),
    );

    render(<App />);

    expect(screen.getAllByText('Old Service').length).toBeGreaterThan(0);
    expect(screen.getByLabelText(/^Command$/i)).toHaveValue('');
    expect(screen.getByLabelText(/yaml export/i)).toHaveTextContent('terminationGracePeriodSeconds: 45');
  });
});
