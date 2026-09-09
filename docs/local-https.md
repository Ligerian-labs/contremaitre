# Local HTTPS

Contremaitre uses one local Traefik process for browser-facing services. URLs use
`https://HOST.localhost`, with no explicit port. Application containers continue
listening on their existing internal ports. PostgreSQL, Redis and SMTP connections
keep their existing internal protocols.

## Setup on macOS

Install the runtime tools and trust a local development certificate authority:

```sh
brew install traefik mkcert
mkcert -install
```

The trust step may request administrator authentication. Run it as your normal
user so the hub and mkcert use the same certificate authority. See
[mkcert's trust-store documentation](https://github.com/FiloSottile/mkcert#supported-root-stores)
for Firefox and other clients.

macOS requires elevated privileges to bind port 443. In a separate terminal, run:

```sh
sudo "$HOME/.local/bin/contremaitre" forward-https
```

Leave that terminal running. The forwarder carries encrypted TCP traffic from
`127.0.0.1:443` to `127.0.0.1:8443`. It holds no certificates and does not run the
hub or containers. Ctrl-C stops forwarding.

Run the hub and applications as your normal user:

```sh
contremaitre start
contremaitre deploy
```

Contremaitre starts and stops Traefik with the hub. Do not also start a Homebrew
Traefik service on the same port. If 8443 is occupied, use the same custom target
in both commands:

```sh
sudo "$HOME/.local/bin/contremaitre" forward-https --https-port 18443
contremaitre start --https-port 18443
```

The published URLs still use port 443. Only one forwarder can own that port.
The listener binds to IPv4 loopback; clients that do not resolve `.localhost`
can explicitly resolve their environment hostname to `127.0.0.1`.

## Traefik dashboard

Open [https://contremaitre.localhost](https://contremaitre.localhost). The root URL
redirects to `/dashboard/`. The dashboard and its `/api` endpoints use this hostname
on the same loopback HTTPS listener as applications, with a dedicated mkcert
certificate. They are available as soon as the HTTPS hub starts, even with no
deployed applications. The dashboard requires no login and is local to your Mac.

The usual certificate trust and port-443 forwarder setup above applies. Clients
that do not resolve `.localhost` must resolve `contremaitre.localhost` to
`127.0.0.1`. With a custom HTTPS listener port, the forwarder still provides the
same dashboard URL. The dashboard is unavailable in legacy `--http` mode.

## Routing and certificates

The hub writes Traefik configuration under `<home>/traefik/dynamic/routes.yml`
using the [file provider](https://doc.traefik.io/traefik/reference/install-configuration/providers/others/file/).
It updates routes as services become ready, change address, stop, or are deleted.
Traefik reloads these changes without restarting. Each service and the designated
main alias get their own host route. Offline services return 503.

The hub asks mkcert for certificates for its recorded local hostnames. Leaf
certificates and private keys live under `<home>/certificates`, with private keys
restricted to their owner. The CA stays in mkcert's own directory. Certificates
are reused and checked hourly, with renewal during the last 30 days of validity.
Restart the hub after replacing the mkcert CA. No project manifest needs TLS
fields or Traefik configuration.

Traefik terminates TLS and proxies HTTP and WebSockets directly to the service.
`{{service.local_url}}`, `{{contremaitre.local_url}}`, and
`CONTREMAITRE_LOCAL_URL` use HTTPS. Vite HMR should use `wss` and client port 443;
the assisted-init instructions already derive these from the local URL.

The hub supervises Traefik and records its child process for crash recovery. A
Traefik exit or configuration-publication failure closes the hub rather than
leaving it reporting healthy HTTPS routing. Application containers remain intact.
Diagnostics go to `<home>/daemon.log`. Port-443 forwarding is a separate process;
the hub does not report its availability through the control API.

## Upgrading and troubleshooting

Restart a running HTTP hub after installing the updated binary. Sending SIGTERM
to the hub preserves running application containers; `contremaitre stop` also
stops the applications. Redeploy to update app origins, cookies and HMR settings.
The CLI rejects a routing-mode mismatch with a restart message.

If the browser cannot connect, check that the port-443 forwarder is running. If
it reports an untrusted certificate, run `mkcert -install` as the same user that
runs the hub and restart the browser. A 503 means the service is not ready; inspect
`contremaitre logs SERVICE` and `contremaitre deploy logs --failure`.

Legacy HTTP is available explicitly:

```sh
contremaitre start --http --http-port 8080
contremaitre deploy --http
```

`--http-port` and `--public-port` require `--http`. External tunnel providers keep
their existing routing and certificate ownership.

## Verification

`bun run check` runs the repository checks and standalone packaging test. With
Traefik and mkcert installed, `test/traefik.test.ts` also exercises a real Traefik
process, verified HTTPS requests, WebSocket upgrades, certificate reuse, and
route addition, removal and readiness changes. It also checks the dashboard
redirect, HTML and API access, hostname isolation, and availability without apps.
Its disposable CA is never installed in the system trust store. The test is
skipped when those tools are unavailable. Port 443 and browser trust require the
macOS setup above.
