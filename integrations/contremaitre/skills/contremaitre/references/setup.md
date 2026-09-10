# Setup

Contremaitre's native runtime requires Apple silicon, macOS 26, Apple container, and its local HTTPS prerequisites. `contremaitre ensure` reports missing runtime setup. Use `contremaitre COMMAND --help` for that command only.

If no manifest exists, inspect the project's actual development commands and Dockerfiles. Use `contremaitre init --no-ai` only when its conventional detection fits. Otherwise write `.contremaitre.yaml` directly using the project's configuration workflow. The calling agent already has the context; interactive `init` would start a second model.

Add checks to the manifest, reusing existing scripts:

```yaml
verification:
  profiles:
    smoke:
      - name: api-tests
        service: api
        command: [bun, test, test/smoke.test.ts]
        timeout_seconds: 120
      - name: browser
        command: [bun, run, test:e2e]
        timeout_seconds: 180
```

Checks without `service` run on the host in the project directory. Service checks run in the service container. Both receive `CONTREMAITRE_BASE_URL`, `CONTREMAITRE_URLS` as a JSON map, and `CONTREMAITRE_ARTIFACTS`. Host checks get browser URLs; native container checks get private network URLs. Container checks require `setsid`, `timeout` and standard shell tools in the image. Configure the browser test runner to use those URLs and write screenshots and traces under the artifact directory. Container checks can declare relative `artifacts: [screenshot.png, trace.zip]` to retrieve known files. Host checks collect files under the artifact directory automatically.

Use `verification.exclude` for host-generated output directories that would otherwise invalidate source fingerprints. Build contexts still follow their Docker ignore rules; exclude test outputs there too. Do not exclude application source or verification configuration.

Missing profiles return `not-configured`. Never invent a passing result. A deterministic smoke check is useful only if it asserts the behavior being changed.
