# Orcha push relay

The one component in the push pipeline that holds APNs signing material.
Boxes (customer or BYOC) never see the `.p8` key — they queue needs-you events
in their portal's `push_outbox` and `deploy/push-forwarder.py` POSTs batches
here; the relay signs an ES256 provider JWT and delivers over APNs HTTP/2.

For the dogfood phase this runs on our own box next to the stack; the
architecture is already central — nothing changes when it moves to a dedicated
host except the boxes' `RELAY_URL`.

**Dormant by design:** without the `APNS_*` env every `/relay/push` answers
`503` with an explanatory message. Deploying the relay before the paid Apple
Developer account exists is safe and expected — see the activation runbook in
`docs/push-notifications.md`.

## Install

```sh
sudo mkdir -p /opt/orcha-push-relay
sudo cp relay.py requirements.txt /opt/orcha-push-relay/
cd /opt/orcha-push-relay
sudo python3 -m venv venv && sudo venv/bin/pip install -r requirements.txt

# The per-box bearer. One shared token for dogfood; per-box tokens later.
sudo sh -c 'umask 077; printf "RELAY_TOKEN=%s\n" "$(openssl rand -hex 32)" > relay.env'

sudo cp push-relay.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now push-relay
curl -s http://127.0.0.1:8787/relay/healthz   # {"ok": true, "configured": false}
```

The relay binds `127.0.0.1:8787` by default (`RELAY_BIND` to change). To serve
boxes elsewhere, front it with the host Caddy/TLS like the portal — never
expose it plaintext off-host.

## Activation (after the paid Apple Developer upgrade)

1. Apple Developer → Certificates, Identifiers & Profiles → Keys → create an
   **APNs Auth Key**; download `AuthKey_<KEYID>.p8` (downloadable exactly once).
2. Place it: `sudo install -m 600 AuthKey_<KEYID>.p8 /opt/orcha-push-relay/`.
3. Append to `relay.env`:

   ```
   APNS_KEY_ID=<KEYID>
   APNS_TEAM_ID=<your team id>
   APNS_KEY_P8=/opt/orcha-push-relay/AuthKey_<KEYID>.p8
   APNS_TOPIC=io.openorcha.mobile.ios
   APNS_ENV=sandbox        # development/TestFlight-sandbox builds; production for App Store
   ```

4. `sudo systemctl restart push-relay` — healthz flips to `"configured": true`
   and the same `RELAY_TOKEN` the boxes already hold starts delivering.

## API

- `POST /relay/push` — `Authorization: Bearer $RELAY_TOKEN`; body
  `{"events": [{"apns_token", "title", "body", "payload": {"cid","kind","id"}}]}`.
  Answers `{"results": [{"apns_token", "status", "detail"}]}` where status is
  `delivered`, `unregistered` (410/`Unregistered`/`BadDeviceToken` — the box
  revokes the token via its portal), or `failed` (retryable; boxes leave the
  outbox row pending).
- `GET /relay/healthz` — unauthenticated `{"ok": true, "configured": bool}`.
