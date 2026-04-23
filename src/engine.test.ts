import { starterArchitecture } from './data';
import {
  canConnectNodes,
  detectPattern,
  generateKubernetesYaml,
  generateTerraform,
  getDerivedEnvironmentVariables,
  getResolvedModel,
} from './engine';

describe('architecture engine', () => {
  it('detects event-driven topologies when services publish to a queue', () => {
    expect(detectPattern(starterArchitecture)).toBe('event-driven');
  });

  it('blocks invalid ingress targets across the shared connection rules', () => {
    const fromNode = starterArchitecture.nodes.find((node) => node.id === 'ingress-web')!;
    const toNode = starterArchitecture.nodes.find((node) => node.id === 'db-orders')!;

    expect(canConnectNodes(fromNode, toNode)).toEqual(
      expect.objectContaining({
        allowed: false,
        reason: expect.stringContaining('frontend, gateway, or service'),
      }),
    );
  });

  it('exports kubernetes yaml with runnable deployment primitives', () => {
    const yaml = generateKubernetesYaml(starterArchitecture);

    expect(yaml).toContain('kind: Namespace');
    expect(yaml).toContain('namespace: checkout-platform');
    expect(yaml).toContain('namespace: data');
    expect(yaml).toContain('namespace: inventory');
    expect(yaml).toContain('kind: ServiceAccount');
    expect(yaml).toContain('kind: ConfigMap');
    expect(yaml).toContain('kind: Secret');
    expect(yaml).toContain('volumeClaimTemplates:');
    expect(yaml).toContain('kind: PersistentVolumeClaim');
    expect(yaml).toContain('secretName: checkout-api-tls');
    expect(yaml).toContain('kind: HorizontalPodAutoscaler');
    expect(yaml).toContain('secretKeyRef:');
    expect(yaml).toContain('name: checkout-service-runtime');
  });

  it('exports terraform manifests for the kubernetes provider', () => {
    const terraform = generateTerraform(starterArchitecture);

    expect(terraform).toContain('provider "kubernetes"');
    expect(terraform).toContain('resource "kubernetes_manifest"');
    expect(terraform).toContain('kind: Secret');
    expect(terraform).toContain('kind: ServiceAccount');
    expect(terraform).toContain('kind: Ingress');
  });

  it('applies active environment overrides before export', () => {
    const devModel = {
      ...starterArchitecture,
      activeEnvironment: 'dev' as const,
    };
    const resolvedCheckout = getResolvedModel(devModel).nodes.find((node) => node.id === 'service-checkout')!;
    const yaml = generateKubernetesYaml(devModel);

    expect(resolvedCheckout.replicas).toBe(1);
    expect(resolvedCheckout.tag).toBe('1.0.0-dev');
    expect(yaml).toContain('image: ghcr.io/visual-kubernetes/checkout-service:1.0.0-dev');
    expect(yaml).toContain('replicas: 1');
    expect(yaml).toContain('host: api.dev.checkout.internal');
  });

  it('derives dependency config from graph edges for exports', () => {
    const derived = getDerivedEnvironmentVariables(starterArchitecture, 'service-checkout');
    const yaml = generateKubernetesYaml(starterArchitecture);

    expect(derived).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'INVENTORY_SERVICE_SERVICE_URL',
          value: 'http://inventory-service.inventory.svc.cluster.local:80',
        }),
        expect.objectContaining({
          key: 'DOMAIN_EVENTS_QUEUE_URL',
          value: 'amqp://domain-events.platform.svc.cluster.local:5672',
        }),
        expect.objectContaining({
          key: 'ORDERS_DB_DATABASE_HOST',
          value: 'orders-db.data.svc.cluster.local',
        }),
      ]),
    );
    expect(yaml).toContain('INVENTORY_SERVICE_SERVICE_URL: "http://inventory-service.inventory.svc.cluster.local:80"');
    expect(yaml).toContain('DOMAIN_EVENTS_QUEUE_URL: "amqp://domain-events.platform.svc.cluster.local:5672"');
    expect(yaml).toContain('ORDERS_DB_DATABASE_HOST: "orders-db.data.svc.cluster.local"');
  });

  it('only generates inline secret documents while preserving existing secret references', () => {
    const yaml = generateKubernetesYaml(starterArchitecture);

    expect(yaml).toContain('name: checkout-service-secret');
    expect(yaml).not.toContain('DATABASE_PASSWORD: "change-me"');
    expect(yaml).toContain('name: checkout-service-runtime');
    expect(yaml).toContain('key: database-password');
  });
});
