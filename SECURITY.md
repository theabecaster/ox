# Security notes

## No secrets ship in this package

Ox deliberately contains **no embedded API keys**. Everything in the published npm tarball
and the git history is key-free, enforced by `scripts/check-no-secrets.sh` in CI.

Key resolution at runtime (first match wins):

1. `OX_API_KEY` environment variable
2. `OPENROUTER_API_KEY` environment variable
3. `~/.ox/key` file (chmod 600 recommended) — never commit this
4. the hosted free gateway (`gateway` setting / default), where the real key lives
   server-side and is injected by the gateway operator

## Why not embed an obfuscated key?

Any secret shipped to a user's machine — minified, split, XOR'd, whatever — is recoverable.
Embedding a key means publishing it. The only safe place for a shared key is a server you
control; that is exactly what the optional gateway is for.

If you self-host a gateway: keep its `OPENROUTER_API_KEY` in your platform's secret store
(e.g. Vercel encrypted env vars), set spend caps on the underlying account, and expose
per-IP quotas + a global kill switch.

## Reporting

Open a GitHub issue or email theabecaster0@gmail.com for anything sensitive.
