# Mobile Pairing Auth Follow-Up

The portal pairing slice adds `GET /api/containers/{cid}/pairing` and returns a short-lived
pairing token in the QR payload. That token is forward-compatible only.

Still unresolved: implement and review the mobile auth exchange, tentatively
`POST /api/pair/device-token`, which should trade the short-lived pairing token for a revocable
device token. Until that endpoint and authorization model are implemented, the mobile app should
not claim Orcha has a complete authenticated device-pairing model.
