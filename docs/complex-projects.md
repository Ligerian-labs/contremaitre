# Complex project verification

Inspected Kohral and Tokenops on 2026-09-08. Their deployments use Kubernetes semantics that Dockerfile discovery cannot reconstruct.

## Kohral

The current Bun implementation lives on `migration/structure`; the repository's `main` branch still contains the earlier PHP application. Its Contremaitre integration is a project-owned driver and manifest targeting that current implementation.

The driver creates a dedicated k3d cluster and image registry per environment through Podman. It builds the API, provisioner, Angular client, OpenClaw overlay, and Hermes overlay. Existing Helm charts retain ownership of migrations, probes, worker restart behavior, RBAC, and workload network policies. Each cluster defaults to a 5 GiB memory limit and uses saved loopback ports and a private kubeconfig. HTTPS certificates come from the existing mkcert CA.

The integration defaults to self-hosted mode with billing disabled and local Mailpit. It does not read or modify the existing `kohral-local` cluster. Application and provider settings belong to the project's ignored configuration files and private driver state.

A fork stops source application and agent writers, dumps the Kohral database, copies encryption/JWT material and agent PVC data, and copies registry storage. Source writers are restored through a recovery journal. The destination has its own Kubernetes control plane, PVCs, and registry. Registry mirrors preserve historical digest references without requiring the source registry to remain online. Runtime SQLite state is copied only while its writers are stopped.

Verification used disposable clusters and synthetic data, including a test agent workload with a persistent uploaded file. It did not initiate model-provider requests. The application's authenticated smoke test covers login, secure refresh cookies, profile access, agent listing, realtime configuration, and local email delivery. OAuth provider sign-in needs configured provider credentials and was not exercised.

Cold upstream downloads remain external dependencies. A Hermes archive request was rate-limited during verification; the existing cached archive was reused and verified by the repository's checksum checks. An ingress chart download returned HTTP 500; the integration now caches that version and retries the read-only download before applying it.

## Tokenops assessment

Tokenops has nine application components in its Helm values: control API, data API, gateway, pipeline, web, analytics projector, reconciliation projector, repricing projector, and repricing worker. Images are shared between several processes, with explicit command overrides. Its platform chart provides PostgreSQL, ClickHouse, Nisshi, optional object storage, and Vault. Local values use PostgreSQL-backed Nisshi storage, disable object storage, and enable development Vault.

Its repository instructions require Kubernetes and forbid adding Compose. The current scripts hardcode a `tokenops` cluster, a shared registry, `.kube-tokenops`, and exclusive host ports 80/443. Those scripts must be adapted before they can act as a Contremaitre driver; wrapping them unchanged would preserve collisions.

A Tokenops driver can use the same protocol, but needs its own implementation and acceptance tests:

- Scope the cluster, registry, kubeconfig, HTTPS host, and ports to the environment; retain its existing 8 GiB budget initially.
- Deploy the existing platform and application charts with environment-specific values and secrets.
- Quiesce ingestion, consumers, projectors, and gateway writers together before copying PostgreSQL, ClickHouse, encrypted raw files, gateway WAL, and required Vault/configuration state.
- Preserve the keys needed to decrypt copied payloads and WAL records, together with broker offsets and the corresponding database state.
- Keep tenant-local raw data out of control-plane and broker contracts during the copy.
- Test replay and restart behavior so cloned queues and WAL cannot accidentally deliver back to main.

Tokenops was inspected only. No Tokenops source files, cluster, kubeconfig, or data were changed, and no claim is made that its existing scripts are already a working Contremaitre driver.
