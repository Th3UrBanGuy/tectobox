# RabbitMQ definitions — read before touching this file

## Why there is no password in `definitions.json` (C6 fix, 2026-11-11)

The `users` entry in `definitions.json` intentionally has **no `password`
field**. Passwords must never live in git. The broker password lives only in
the server's `.env` (`RABBITMQ_PASS`) and in the **live copy of this file on
the VPS**, which is a local, uncommitted override (same treatment as `.env`).

## ⚠️ The broker resets the password from this file on every boot

Proven live on 2026-11-11: the broker runs `load_definitions` at every boot
and applies this file. If the file has **no `password` field for the user,
the broker wipes the stored password** (sets it empty/unusable) — all
services then get `403 ACCESS-REFUSED` and nothing reconnects until the
password is put back and the broker is restarted. Do not assume "no field =
leave it alone": that assumption was tested and it is false.

## Rules

1. **Repo copy:** never put a real password in this file. It ships without
   the `password` field on purpose.
2. **Live copy (VPS `/opt/tectobox/infra/rabbitmq/definitions.json`):** must
   keep `"password"` set to the **same value as `.env` `RABBITMQ_PASS`**.
   It is an uncommitted local modification — never commit it, never push it.
3. **Deploy / pull:** a `git pull` that overwrites the live file with the
   repo version will break RabbitMQ auth on the next broker restart (the
   password gets wiped). After any deploy that touches this file, re-apply
   the password from `.env`, restart the broker, then restart
   api/workers/ingress and verify with
   `rabbitmqctl list_connections` (expect 7 running) and zero
   `ACCESS-REFUSED` in the service logs.
4. **Fresh install:** copy this file, set the `password` field to the same
   value as `.env` `RABBITMQ_PASS` **before the first broker boot**. Do not
   boot the broker with a password-less user entry.
5. **Rotation:** change the password in BOTH `.env` (`RABBITMQ_PASS`) and
   the live `definitions.json`, then restart the broker, then restart the
   services. Changing only one side breaks auth.

## Longer-term fix (not done here)

Move the live definitions file out of the git checkout (e.g. mount it from
`/etc/tectobox/definitions.json`) so a `git pull` can never touch it, or
stop using `load_definitions` for the user and seed the broker user from
`RABBITMQ_DEFAULT_PASS` on first boot only.
