import { starterArchitecture } from './data';
import { canConnectNodes, detectPattern, generateKubernetesYaml, generateTerraform } from './engine';

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
  });

  it('exports terraform manifests for the kubernetes provider', () => {
    const terraform = generateTerraform(starterArchitecture);

    expect(terraform).toContain('provider "kubernetes"');
    expect(terraform).toContain('resource "kubernetes_manifest"');
    expect(terraform).toContain('kind: Secret');
    expect(terraform).toContain('kind: ServiceAccount');
    expect(terraform).toContain('kind: Ingress');
  });
});
