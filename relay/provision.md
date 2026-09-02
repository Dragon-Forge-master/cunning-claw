# Provisioning a Dragon Forge token

Tokens are minted by hand for now. A token is just a KV record; the relay
trusts whatever is under `tok:<token>`, so mint tokens with real entropy —
never guessable words.

## Mint a token

Generate the token itself (32 hex chars is plenty):

```bash
TOKEN=$(openssl rand -hex 16)
echo "df_${TOKEN}"
```

Write the record. The JSON shape is exactly what `parseTokenRecord` in
`src/lib.ts` validates — `plan` (string), `monthlyBudgetTokens` (number),
optional `disabled` (boolean):

```bash
wrangler kv key put --binding TOKENS "tok:df_${TOKEN}" \
  '{"plan":"starter","monthlyBudgetTokens":2000000}'
```

Hand `df_<token>` to the customer; it is the only copy — we store the record,
not a register of who has which token, so note the pairing somewhere private.

## Disable a token

Cheaper than deletion and reversible — the relay returns 403 while
`disabled` is true:

```bash
wrangler kv key put --binding TOKENS "tok:df_${TOKEN}" \
  '{"plan":"starter","monthlyBudgetTokens":2000000,"disabled":true}'
```

## Check a customer's usage this month

Counters live at `use:<token>:<YYYY-MM>` (UTC month) and expire on their own
after ~90 days:

```bash
wrangler kv key get --binding TOKENS "use:df_${TOKEN}:2026-09"
```

To reset a month (goodwill gesture), delete the counter:

```bash
wrangler kv key delete --binding TOKENS "use:df_${TOKEN}:2026-09"
```

## PLANNED: Stripe replaces this

The manual mint above is scaffolding. The plan is a Stripe Checkout flow whose
webhook (`checkout.session.completed` / `customer.subscription.updated` /
`...deleted`) runs a small provisioning Worker: it mints the token, writes the
KV record with the budget for the purchased plan, emails the customer their
token, and flips `disabled` on subscription lapse — so the KV record shape
above stays the contract and the relay itself never changes. Until then,
every sale is a `wrangler kv key put`.
