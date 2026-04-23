import { fireEvent, render, screen } from '@testing-library/react';
import { App } from './App';
import { WORKSPACE_STORAGE_KEY } from './storage';

describe('App', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('adds a new node from the component palette', () => {
    render(<App />);

    fireEvent.change(screen.getByLabelText(/Node type/i), { target: { value: 'service' } });
    fireEvent.click(screen.getByRole('button', { name: /Add node/i }));

    expect(screen.getAllByText(/Service 1/i).length).toBeGreaterThan(0);
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

    fireEvent.change(screen.getByLabelText(/Node type/i), { target: { value: 'worker' } });
    fireEvent.click(screen.getByRole('button', { name: /Add node/i }));
    const workerOption = screen.getAllByRole('option', { name: /Worker \d+/i }).at(-1);

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

    fireEvent.change(screen.getByLabelText(/Node type/i), { target: { value: 'service' } });
    fireEvent.click(screen.getByRole('button', { name: /Add node/i }));
    fireEvent.click(screen.getByRole('button', { name: /Prod-ready/i }));
    fireEvent.click(screen.getByRole('button', { name: /Public TLS ingress/i }));

    expect(window.localStorage.getItem(WORKSPACE_STORAGE_KEY)).toContain('"tag":"1.0.0"');
    expect(screen.getByLabelText(/yaml export/i)).toHaveTextContent('cert-manager.io/cluster-issuer: "letsencrypt-prod"');
  });

  it('adds cronjob workloads and exports scheduled batch yaml', () => {
    render(<App />);

    fireEvent.change(screen.getByLabelText(/Node type/i), { target: { value: 'cronjob' } });
    fireEvent.click(screen.getByRole('button', { name: /Add node/i }));

    expect(screen.getAllByText(/CronJob \d+/i).length).toBeGreaterThan(0);
    expect(screen.getByLabelText(/yaml export/i)).toHaveTextContent('kind: CronJob');
    expect(screen.getByLabelText(/yaml export/i)).toHaveTextContent('schedule: "*/15 * * * *"');
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
