# Lead capture backend

Receives submissions from the three kineura-site lead forms, stores them in
DynamoDB, and emails a notification. Replaces FormSubmit.co.

Design: [`../docs/lead-capture/design.md`](../docs/lead-capture/design.md)

## What is deployed

| Resource | Name |
|---|---|
| Lambda | `kineura-lead-capture` (`nodejs22.x`) |
| Leads table | `kineura-leads` — PK `email`, SK `submittedAt`, PITR on |
| Throttle table | `kineura-lead-throttle` — PK `throttleKey`, TTL on `expiresAt` |
| Stack | `kineura-lead-capture` in `us-east-1` |

No npm dependencies. AWS SDK v3 ships inside the Lambda runtime.

## First-time setup

```bash
mkdir -p ~/.kineura
printf 'NOTIFY_EMAIL=you@example.com\nIP_SALT=%s\n' "$(openssl rand -hex 16)" \
  > ~/.kineura/lead-capture.env
```

Never commit that file. It holds the only secret here.

## Deploy

```bash
./scripts/deploy.sh
```

Runs the tests, deploys the stack, uploads the code, and prints the outputs.
Idempotent — re-run it for either infrastructure or code changes.

## SES DNS records

The first deploy prints `DkimName1..3` and `DkimValue1..3`. Add each as a CNAME
at the `kineura.com` registrar. **Sending fails until those records propagate**,
which is expected and usually takes minutes to an hour.

The SES sandbox is fine here: it restricts who you can send *to*, and the only
recipient is the Kineura address you verify. No production-access request is
needed unless we later auto-reply to submitters.

Verify the recipient once:

```bash
aws ses verify-email-identity --email-address you@example.com --region us-east-1
```

## Change the notification recipient

When `hello@kineura.com` exists, no code change and no site redeploy:

```bash
aws lambda update-function-configuration \
  --function-name kineura-lead-capture \
  --environment "Variables={LEADS_TABLE=kineura-leads,THROTTLE_TABLE=kineura-lead-throttle,NOTIFY_EMAIL=hello@kineura.com,SENDER_ADDRESS=noreply@kineura.com,IP_SALT=$(grep IP_SALT ~/.kineura/lead-capture.env | cut -d= -f2),RATE_LIMIT=5}" \
  --region us-east-1
```

Then update `NOTIFY_EMAIL` in `~/.kineura/lead-capture.env` so the next
`deploy.sh` does not revert it.

## Export the leads

```bash
node scripts/export-leads.mjs > leads.csv
```

## Run the tests

```bash
node --test src/
```
