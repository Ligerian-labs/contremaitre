# One container, two endpoints

With Contremaitre and local HTTPS configured, run from this directory:

```sh
contremaitre init --no-ai
contremaitre deploy
contremaitre show
```

Setup resolves the development command and Bun image into `.contremaitre.lock`. The included lock also lets you deploy directly. The API and web page run in the same container and receive different local URLs. Edit `server.ts` to exercise source synchronization and Bun's watcher.

Add `memory: 3G` under `apps.app` and deploy again. Deployment updates the lock automatically. Commit the YAML and lock together. Run `contremaitre logs app` for container logs or `contremaitre down` to stop the example.

Read the [compact configuration guide](../../docs/compact-config.md) for application wiring, grouping and lock behavior.
