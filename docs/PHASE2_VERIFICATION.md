# Phase 2 verification

Manual sign-in smoke test:

1. Deploy the updated frontend to staging.
2. Open `https://emr.flatratenexus.com`.
3. Confirm unauthenticated traffic renders the Compact EMR sign-in screen.
4. Sign in as an admin Cognito user with a temporary password.
5. Confirm the permanent-password challenge is shown when Cognito requires it.
6. Confirm TOTP enrollment or TOTP prompt is shown when required.
7. Confirm admin lands on `/` and can see Home placeholders.
8. Confirm a physician user cannot access `/` and is sent to `/403`, with Back to home pointing to `/p/queue`.
9. Confirm `/p/queue` renders for physician and `/physicians` returns `/403`.
10. Confirm sign-out returns to the sign-in screen.
