# afk

Monitor and interact with your Claude Code sessions from Slack or Discord. Get notified when Claude needs input, and respond from wherever you can access Slack/Discord. Claude Code runs on your machine where it normally does, and afk forwards messages between it and Slack/Discord.

## How it works

1. Run `afk slack` or `afk discord` to start the bot, and leave it running
2. Run `afk run -- claude ` to start a monitored Claude Code session
3. A new thread (Slack) or channel (Discord) is created for the session
4. All messages are relayed bidirectionally - respond from your phone while AFK

## Installation

```bash
# Clone the repo
git clone https://github.com/clharman/afk.git
cd afk

# Install dependencies
bun install

# Link the CLI globally (optional)
bun link
```

Requires [Bun](https://bun.sh) runtime.

## Slack Setup

### 1. Create a Slack App

Go to [api.slack.com/apps](https://api.slack.com/apps) and click **Create New App** → **From manifest**.

Paste the contents of `slack-manifest.json` from this repo, then click **Create**.

### 2. Install to Workspace

Click **Install to Workspace** and authorize the app.

### 3. Get Your Credentials

- **Bot Token**: OAuth & Permissions → Bot User OAuth Token (`xoxb-...`)
- **App Token**: Basic Information → App-Level Tokens → Generate Token with `connections:write` scope (`xapp-...`)
- **Signing Secret**: Basic Information → Signing Secret
- **Your User ID**: In Slack, click your profile → three dots → Copy member ID

### 4. Configure AFK

```bash
afk slack setup
```

Follow the prompts to enter your credentials. Config is saved to `~/.afk/slack.env`.

### 5. Run

```bash
# Terminal 1: Start the Slack bot
afk slack

# Terminal 2: Start a Claude Code session
afk run -- claude
```

A new thread will appear in your Slack channel for each session. It will be automatically archived when you exit the Claude Code session.

## Discord Setup

### 1. Create a Discord Application

Go to [discord.com/developers/applications](https://discord.com/developers/applications) and click **New Application**.

### 2. Create a Bot

- Go to **Bot** in the sidebar
- Click **Reset Token** and copy it
- Enable **Message Content Intent** under Privileged Gateway Intents

### 3. Invite the Bot

- Go to **OAuth2** → **URL Generator**
- Select scopes: `bot`
- Select permissions: `Send Messages`, `Manage Channels`, `Read Message History`
- Open the generated URL to invite the bot to your server

### 4. Get Your User ID

Enable Developer Mode in Discord settings, then right-click your name → **Copy User ID**.

### 5. Configure AFK

```bash
afk discord setup
```

Enter your bot token and user ID. Config is saved to `~/.afk/discord.env`.

### 6. Run

```bash
# Terminal 1: Start the Discord bot
afk discord

# Terminal 2: Start a Claude Code session
afk run -- claude
```

An "AFK Sessions" category will be created with a channel for each session.

## Commands

```
afk run -- <command>   Start a monitored session (e.g., afk run -- claude)
afk slack              Run the Slack bot
afk slack setup        Configure Slack credentials
afk discord            Run the Discord bot
afk discord setup      Configure Discord credentials
afk help               Show help
```

## How It Works

AFK watches Claude Code's JSONL output files to capture messages in real-time. When you start a session with `afk run`, it:

1. Spawns the command in a PTY (pseudo-terminal)
2. Connects to the running Slack/Discord bot via Unix socket
3. Watches the Claude Code JSONL file for new messages
4. Relays messages bidirectionally between terminal and chat

Messages you send in Slack/Discord threads are forwarded to the terminal as if you typed them.

## License

MIT
