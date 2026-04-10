#!/usr/bin/env python3
"""
Discord ↔ AgentChattr bridge.

Bidirectional relay: messages from a Discord channel appear in
AgentChattr, and agent messages from AC appear in Discord.

Mirrors the Telegram bridge (agentchattr-telegram/telegram_bridge.py)
as closely as possible. Bundled inside the quadwork npm package at
bridges/discord/ instead of a separate repo.

Config: read from TOML [discord] section, env var overrides win.
"""

import argparse
import asyncio
import atexit
import json
import logging
import os
import signal
import sys
import threading
import time
from pathlib import Path

try:
    import tomllib  # Python 3.11+
except ModuleNotFoundError:
    try:
        import tomli as tomllib  # type: ignore[no-redef]
    except ModuleNotFoundError:
        tomllib = None  # type: ignore[assignment]

import discord
import requests

log = logging.getLogger("discord-bridge")

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

DEFAULT_CONFIG = {
    "bot_token": "",
    "channel_id": "",
    "agentchattr_url": "http://127.0.0.1:8300",
    "poll_interval": 2,
    "bridge_sender": "discord-bridge",
    "cursor_file": "",
}

ENV_MAP = {
    "DISCORD_BOT_TOKEN": "bot_token",
    "DISCORD_CHANNEL_ID": "channel_id",
    "AGENTCHATTR_URL": "agentchattr_url",
    "CURSOR_FILE": "cursor_file",
}


def load_config(toml_path=None):
    """Load config: defaults → TOML [discord] → env vars."""
    cfg = dict(DEFAULT_CONFIG)

    if toml_path and os.path.isfile(toml_path):
        if tomllib is None:
            log.warning("tomli not installed and Python < 3.11; skipping TOML config")
        else:
            with open(toml_path, "rb") as f:
                data = tomllib.load(f)
            section = data.get("discord", {})
            for key in cfg:
                if key in section:
                    cfg[key] = section[key]
            # Resolve cursor_file relative to TOML directory
            if cfg["cursor_file"] and not os.path.isabs(cfg["cursor_file"]):
                cfg["cursor_file"] = os.path.join(
                    os.path.dirname(os.path.abspath(toml_path)),
                    cfg["cursor_file"],
                )

    # Env vars always override
    for env_key, cfg_key in ENV_MAP.items():
        val = os.environ.get(env_key)
        if val:
            cfg[cfg_key] = val

    # bot_token may use "env:VAR" indirection (same as TG bridge)
    if cfg["bot_token"].startswith("env:"):
        env_name = cfg["bot_token"][4:]
        cfg["bot_token"] = os.environ.get(env_name, "")

    # channel_id must be an integer for discord.py comparisons
    if cfg["channel_id"]:
        cfg["channel_id"] = int(cfg["channel_id"])

    return cfg


def validate_config(cfg):
    """Raise on missing required fields."""
    if not cfg["bot_token"]:
        raise SystemExit("bot_token is required (TOML [discord] or DISCORD_BOT_TOKEN env)")
    if not cfg["channel_id"]:
        raise SystemExit("channel_id is required (TOML [discord] or DISCORD_CHANNEL_ID env)")


# ---------------------------------------------------------------------------
# Cursor persistence
# ---------------------------------------------------------------------------

_cursor = {"last_seen_id": 0}


def load_cursor(path):
    """Load cursor from JSON file. Non-fatal on error."""
    global _cursor
    if not path or not os.path.isfile(path):
        return
    try:
        with open(path) as f:
            data = json.load(f)
        if isinstance(data, dict) and "last_seen_id" in data:
            _cursor["last_seen_id"] = int(data["last_seen_id"])
            log.info("Loaded cursor: last_seen_id=%d", _cursor["last_seen_id"])
    except Exception as exc:
        log.warning("Failed to load cursor from %s: %s", path, exc)


def save_cursor(path):
    """Save cursor to JSON file. Non-fatal on error."""
    if not path:
        return
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as f:
            json.dump(_cursor, f)
    except Exception as exc:
        log.warning("Failed to save cursor to %s: %s", path, exc)


# ---------------------------------------------------------------------------
# AgentChattr registration + heartbeat
# ---------------------------------------------------------------------------

# Mutable dict so heartbeat thread sees re-registration updates.
# bridge_sender is set from cfg during main() so all callers can read it.
ac = {"token": "", "name": "", "bridge_sender": "discord-bridge"}


def ac_register(url, base=None, label="Discord Bridge"):
    """Register with AgentChattr. Returns {name, token} or raises."""
    if base is None:
        base = ac["bridge_sender"]
    resp = requests.post(
        f"{url}/api/register",
        json={"base": base, "label": label},
        timeout=10,
    )
    resp.raise_for_status()
    data = resp.json()
    ac["name"] = data["name"]
    ac["token"] = data["token"]
    log.info("Registered with AC as %s", ac["name"])
    return data


def ac_deregister(url):
    """Best-effort deregister from AC."""
    if not ac["name"]:
        return
    try:
        requests.post(
            f"{url}/api/deregister/{ac['name']}",
            headers={"Authorization": f"Bearer {ac['token']}"},
            timeout=5,
        )
        log.info("Deregistered %s from AC", ac["name"])
    except Exception:
        pass


def _heartbeat_loop(url):
    """Daemon thread: POST /api/heartbeat/{name} every 5s."""
    while True:
        name = ac["name"]
        token = ac["token"]
        if name:
            try:
                resp = requests.post(
                    f"{url}/api/heartbeat/{name}",
                    headers={"Authorization": f"Bearer {token}"} if token else {},
                    timeout=5,
                )
                if resp.status_code == 409:
                    # AC restarted — re-register
                    log.warning("Heartbeat 409 — AC restarted, re-registering")
                    try:
                        ac_register(url)
                    except Exception as exc:
                        log.error("Re-register failed: %s", exc)
            except Exception:
                pass
        time.sleep(5)


def start_heartbeat(url):
    """Start the heartbeat daemon thread."""
    t = threading.Thread(target=_heartbeat_loop, args=(url,), daemon=True)
    t.start()
    return t


# ---------------------------------------------------------------------------
# AC → Discord polling
# ---------------------------------------------------------------------------

async def poll_ac_to_discord(cfg, channel):
    """Poll AC for new messages and forward to Discord channel."""
    url = cfg["agentchattr_url"]
    bridge_sender = cfg["bridge_sender"]
    interval = cfg["poll_interval"]

    while True:
        try:
            params = {"limit": 50}
            if _cursor["last_seen_id"]:
                params["since_id"] = _cursor["last_seen_id"]
            headers = {}
            if ac["token"]:
                headers["Authorization"] = f"Bearer {ac['token']}"

            resp = requests.get(
                f"{url}/api/messages",
                params=params,
                headers=headers,
                timeout=10,
            )

            if resp.status_code in (401, 403):
                log.warning("AC poll %d — re-registering", resp.status_code)
                try:
                    ac_register(url)
                except Exception as exc:
                    log.error("Re-register failed: %s", exc)
                await asyncio.sleep(interval)
                continue

            resp.raise_for_status()
            messages = resp.json()

            if not isinstance(messages, list):
                await asyncio.sleep(interval)
                continue

            for msg in messages:
                msg_id = msg.get("id", 0)
                sender = msg.get("sender", "")
                text = msg.get("text", "")

                # Echo prevention: skip our own messages
                if sender == bridge_sender or sender == ac["name"]:
                    if msg_id > _cursor["last_seen_id"]:
                        _cursor["last_seen_id"] = msg_id
                    continue

                # Skip system auto-recovery messages
                if sender == "system":
                    if msg_id > _cursor["last_seen_id"]:
                        _cursor["last_seen_id"] = msg_id
                    continue

                if not text:
                    if msg_id > _cursor["last_seen_id"]:
                        _cursor["last_seen_id"] = msg_id
                    continue

                # Forward to Discord
                try:
                    discord_text = f"**{sender}**: {text}"
                    # Discord message limit is 2000 chars
                    if len(discord_text) > 2000:
                        discord_text = discord_text[:1997] + "..."
                    await channel.send(discord_text)
                except Exception as exc:
                    log.error("Failed to send to Discord: %s", exc)

                if msg_id > _cursor["last_seen_id"]:
                    _cursor["last_seen_id"] = msg_id

            # Persist cursor after each poll cycle
            save_cursor(cfg["cursor_file"])

        except requests.RequestException as exc:
            log.warning("AC poll error: %s", exc)
        except Exception as exc:
            log.error("Unexpected AC poll error: %s", exc)

        await asyncio.sleep(interval)


# ---------------------------------------------------------------------------
# Discord → AC path
# ---------------------------------------------------------------------------

def send_to_ac(cfg, text, channel_name="general"):
    """Forward a message from Discord to AgentChattr."""
    url = cfg["agentchattr_url"]
    headers = {}
    if ac["token"]:
        headers["Authorization"] = f"Bearer {ac['token']}"

    try:
        resp = requests.post(
            f"{url}/api/send",
            json={
                "text": text,
                "channel": channel_name,
                "sender": cfg["bridge_sender"],
            },
            headers=headers,
            timeout=10,
        )
        if resp.status_code in (401, 403):
            log.warning("AC send %d — re-registering", resp.status_code)
            ac_register(url)
            # Retry once after re-register
            headers["Authorization"] = f"Bearer {ac['token']}"
            resp = requests.post(
                f"{url}/api/send",
                json={
                    "text": text,
                    "channel": channel_name,
                    "sender": cfg["bridge_sender"],
                },
                headers=headers,
                timeout=10,
            )
        resp.raise_for_status()
    except requests.RequestException as exc:
        log.error("Failed to send to AC: %s", exc)


# ---------------------------------------------------------------------------
# Discord client
# ---------------------------------------------------------------------------

def create_client(cfg):
    """Create and configure the Discord client."""
    intents = discord.Intents.default()
    intents.message_content = True  # Privileged — must be enabled in Developer Portal
    client = discord.Client(intents=intents)
    target_channel_id = cfg["channel_id"]

    @client.event
    async def on_ready():
        log.info("Discord bot logged in as %s (id=%s)", client.user, client.user.id)
        channel = client.get_channel(target_channel_id)
        if not channel:
            log.error(
                "Cannot find channel %s — check channel_id and bot permissions",
                target_channel_id,
            )
            return
        log.info("Monitoring Discord channel: #%s (%s)", channel.name, channel.id)
        # Start the AC → Discord poll loop
        client.loop.create_task(poll_ac_to_discord(cfg, channel))

    @client.event
    async def on_message(message):
        # Ignore own messages
        if message.author == client.user:
            return
        # Ignore other bots
        if message.author.bot:
            return
        # Only relay from the configured channel
        if message.channel.id != target_channel_id:
            return

        text = message.content
        if not text:
            # Warn about missing MESSAGE_CONTENT intent
            if not message.flags.value and not message.embeds and not message.attachments:
                log.warning(
                    "Received message with empty content from %s — "
                    "MESSAGE_CONTENT intent may not be enabled in the Developer Portal",
                    message.author,
                )
            return

        # Prefix with Discord username for attribution
        ac_text = f"[discord:{message.author.display_name}] {text}"
        log.debug("Discord → AC: %s", ac_text[:100])
        send_to_ac(cfg, ac_text)

    return client


# ---------------------------------------------------------------------------
# Shutdown
# ---------------------------------------------------------------------------

_shutdown_done = []


def shutdown(cfg):
    """Graceful shutdown: deregister from AC, save cursor."""
    if _shutdown_done:
        return
    _shutdown_done.append(True)
    log.info("Shutting down...")
    ac_deregister(cfg["agentchattr_url"])
    save_cursor(cfg["cursor_file"])


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Discord ↔ AgentChattr bridge")
    parser.add_argument(
        "-c", "--config",
        help="Path to TOML config file (reads [discord] section)",
    )
    parser.add_argument(
        "-v", "--verbose",
        action="store_true",
        help="Enable debug logging",
    )
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
    )

    cfg = load_config(args.config)
    validate_config(cfg)

    # Set bridge_sender so ac_register uses the configured base name
    ac["bridge_sender"] = cfg["bridge_sender"]

    # Load cursor
    load_cursor(cfg["cursor_file"])

    # Register with AgentChattr
    try:
        ac_register(cfg["agentchattr_url"])
    except Exception as exc:
        log.error("Initial AC registration failed: %s", exc)
        log.info("Will retry on first message send")

    # Start heartbeat
    start_heartbeat(cfg["agentchattr_url"])

    # Register shutdown handlers
    atexit.register(shutdown, cfg)
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: (shutdown(cfg), sys.exit(0)))

    # Start Discord client
    client = create_client(cfg)
    log.info("Starting Discord bridge (channel_id=%s)", cfg["channel_id"])
    client.run(cfg["bot_token"], log_handler=None)


if __name__ == "__main__":
    main()
