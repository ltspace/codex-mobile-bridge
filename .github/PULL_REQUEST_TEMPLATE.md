## What

<!-- Summarize the user-visible or operational change. -->

## Why

<!-- Explain the concrete problem this solves. -->

## Testing

<!-- List the checks you actually ran and their results. -->

- [ ] `npm run check`
- [ ] Relevant Windows behavior was verified, or the unverified boundary is stated
- [ ] Tailscale/phone behavior was verified when affected, or the unverified boundary is stated

## Security and privacy

- [ ] No credentials, tailnet URLs, personal paths, real conversations, logs, or runtime state are included
- [ ] The change does not expose the Bridge beyond loopback plus Tailscale Serve
- [ ] Process termination, approvals, sandboxing, and thread-writer ownership remain fail-closed
