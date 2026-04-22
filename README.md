# @bitsocial/ai-moderation-challenge

Automatic PKC challenge that evaluates Bitsocial comment content against `community.rules` with an OpenAI-compatible model endpoint. The package runs on the community node and does not require a hosted Bitsocial moderation server.

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
        options: {
            apiKey: "sk-...",
            branch: "allow",
            promptPath: "/root/bitsocial-ai-moderation-prompt.md"
        },
        exclude: [{ challenges: [2] }]
    },
    {
        name: "@bitsocial/ai-moderation-challenge",
        options: {
            apiKey: "sk-...",
            branch: "review",
            promptPath: "/root/bitsocial-ai-moderation-prompt.md"
        },
        pendingApproval: true,
        exclude: [{ challenges: [1] }]
    }
];
```

Challenge options are private community-node settings in `pkc-js`, so `apiKey`, `prompt`, `promptPath`, `apiUrl`, and `cachePath` are not copied into the public community challenge metadata. Keep local settings backups private because they can contain `apiKey`.

## Options

| Option       | Default                                 | Description                                                                           |
| ------------ | --------------------------------------- | ------------------------------------------------------------------------------------- |
| `apiUrl`     | `https://api.openai.com/v1/responses`   | Full OpenAI-compatible endpoint URL                                                   |
| `apiFormat`  | `responses`                             | Request/response format: `responses` or `chat-completions`                            |
| `apiKey`     | none                                    | Private provider API key                                                              |
| `model`      | `gpt-5.4-mini`                          | Model name sent to the provider                                                       |
| `branch`     | `allow`                                 | Branch mode: `allow` or `review`                                                      |
| `prompt`     | built-in prompt                         | Private inline system prompt text                                                     |
| `promptPath` | none                                    | Private file path for a system prompt on the community node                           |
| `cachePath`  | `~/.bitsocial-ai-moderation-cache.json` | Private JSON verdict cache path; set to an empty string to disable persistent caching |
| `error`      | `Rejected by Bitsocial AI moderation.`  | Error shown when content edits are rejected or moderation is unavailable for an edit  |

Use either `prompt` or `promptPath`, not both.

For providers exposing the chat-completions API shape, set both `apiFormat` and `apiUrl`:

```js
{
    name: "@bitsocial/ai-moderation-challenge",
    options: {
        branch: "allow",
        apiFormat: "chat-completions",
        apiUrl: "https://provider.example/v1/chat/completions",
        apiKey: "provider-key",
        model: "provider-model"
    }
}
```

OpenAI-compatible APIs are a practical compatibility convention, not a formal open standard. Test custom providers before enabling the challenge on live communities.

## Behavior

- New comments with verdict `allow` publish normally.
- New comments with verdict `review` are sent to pending approval.
- New comments are also sent to pending approval if the model API is unavailable.
- Content edits with verdict `review` are rejected until PKC supports pending approval for edits.
- Content edits are rejected if the model API is unavailable.
- Delete-only edits and non-comment publication types bypass AI moderation.
- The challenge sends text, title, link URL/domain/path, flags, flairs, community address/title/description/features, and `community.rules`.
- The challenge does not fetch linked media in v1.
- Two branch invocations for the same publication reuse one in-process verdict promise.
- Successful verdicts are cached in a private JSON file keyed by a SHA-256 hash over model/provider config, community context, target content, and the final prompt hash. The cache does not store the raw prompt or API key.

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
