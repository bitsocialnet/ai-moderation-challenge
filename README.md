# @bitsocial/ai-moderation-challenge

Automatic PKC challenge that evaluates Bitsocial comment content against `community.rules` using the hosted Bitsocial AI moderation API.

## Installation

```bash
bitsocial challenge install @bitsocial/ai-moderation-challenge
```

## Configuration

Install this challenge twice: one `allow` branch and one `review` branch. The `review` branch uses PKC `pendingApproval` to route rule-breaking comments to the moderator queue.

```js
[
    { name: "@bitsocial/spam-blocker-challenge" },
    {
        name: "@bitsocial/ai-moderation-challenge",
        options: { branch: "allow" },
        exclude: [{ challenges: [2] }]
    },
    {
        name: "@bitsocial/ai-moderation-challenge",
        options: { branch: "review" },
        pendingApproval: true,
        exclude: [{ challenges: [1] }]
    }
];
```

## Options

| Option      | Default                                   | Description                                 |
| ----------- | ----------------------------------------- | ------------------------------------------- |
| `serverUrl` | `https://moderation.bitsocial.net/api/v1` | URL of the Bitsocial moderation API         |
| `branch`    | `allow`                                   | Branch mode: `allow` or `review`            |
| `error`     | `Rejected by Bitsocial AI moderation.`    | Error shown when content edits are rejected |

## Behavior

- New comments with verdict `allow` publish normally.
- New comments with verdict `review` are sent to pending approval.
- Content edits with verdict `review` are rejected until PKC supports pending approval for edits.
- Delete-only edits and non-comment publication types bypass AI moderation.
- The challenge does not fetch linked media in v1.

## Publishing

The first npm publish must create the package before trusted publishing can be configured:

```bash
npm publish --access public
```

After the package exists, configure npm trusted publishing:

- Publisher: GitHub Actions
- Organization: `bitsocialnet`
- Repository: `ai-moderation-challenge`
- Workflow filename: `publish.yml`
- Environment: leave blank

Equivalent npm CLI command:

```bash
npm trust github @bitsocial/ai-moderation-challenge --repo bitsocialnet/ai-moderation-challenge --file publish.yml
```

Future releases publish automatically when `package.json` version changes on `master`. The publish workflow skips versions that already exist on npm.
