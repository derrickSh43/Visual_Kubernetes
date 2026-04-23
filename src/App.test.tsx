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

  it('shows graph-derived dependency wiring for the selected node', () => {
    render(<App />);

    fireEvent.click(screen.getAllByText('Checkout Service').at(-1)!);

    expect(screen.getByText('INVENTORY_SERVICE_SERVICE_URL')).toBeInTheDocument();
    expect(screen.getByText('amqp://domain-events.platform.svc.cluster.local:5672')).toBeInTheDocument();
  });

  it('connects a newly added node from the connection form', () => {
    render(<App />);

    fireEvent.change(screen.getByLabelText(/Node type/i), { target: { value: 'worker' } });
    fireEvent.click(screen.getByRole('button', { name: /Add node/i }));
    const workerOption = screen.getAllByRole('option', { name: /Worker \d+/i }).at(-1);

    expect(workerOption).toBeTruthy();
    const workerId = workerOption!.getAttribute('value')!;

    fireEvent.change(screen.getByLabelText(/^From$/i), { target: { value: 'service-checkout' } });
    fireEvent.change(screen.getByLabelText(/^To$/i), { target: { value: workerId } });
    fireEvent.click(screen.getByRole('button', { name: /Add connection/i }));

    expect(screen.getByText(/http \| 100ms/i)).toBeInTheDocument();
    expect(window.localStorage.getItem(WORKSPACE_STORAGE_KEY)).toContain(`"to":"${workerId}"`);
  });

  it('renders terraform export output', () => {
    render(<App />);

    fireEvent.click(screen.getAllByRole('button', { name: /Terraform/i })[0]!);

    expect(screen.getByLabelText(/terraform export/i)).toHaveTextContent('resource "kubernetes_manifest"');
    expect(screen.getByLabelText(/terraform export/i)).toHaveTextContent('kind: Secret');
  });
});
