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
import re
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

log = logging.getLogger("dc-bridge")

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

DEFAULT_CONFIG = {
    "bot_token": "",
    "channel_id": "",
    "agentchattr_url": "http://127.0.0.1:8300",
    "poll_interval": 2,
    "bridge_sender": "dc",
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
ac = {"token": "", "name": "", "bridge_sender": "dc", "known_names": set()}


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
    ac["known_names"].add(data["name"])
    log.info("Registered with AC as %s (known: %s)", ac["name"], ac["known_names"])
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
# #501: message filter — suppress AC housekeeping noise from bridge output
# ---------------------------------------------------------------------------

_NOISE_PATTERNS = [
    re.compile(r"^.+ is online$"),
    re.compile(r"disconnected \(timeout\)"),
    re.compile(r"^.+ disconnected$"),
    re.compile(r"auto-recovered"),
    re.compile(r"Resuming agent conversation"),
]

# Dedup guard: (sender, text) → timestamp of last forward
_last_forwarded: dict[tuple[str, str], float] = {}
_DEDUP_WINDOW = 60  # seconds


def _should_forward(msg: dict) -> bool:
    """Return True if this AC message should be forwarded to Discord/Telegram."""
    sender = msg.get("sender", "")
    text = msg.get("text", "")
    msg_type = msg.get("type", "chat")

    # Skip join/leave system messages (online, disconnected, timeout)
    if msg_type in ("join", "leave"):
        return False

    # Skip system sender entirely
    if sender == "system":
        return False

    # Pattern-based filter for edge cases
    for pat in _NOISE_PATTERNS:
        if pat.search(text):
            return False

    # Dedup: suppress identical (sender, text) within window
    key = (sender, text)
    now = time.time()
    last = _last_forwarded.get(key)
    if last is not None and now - last < _DEDUP_WINDOW:
        return False
    _last_forwarded[key] = now

    # Prune stale dedup entries periodically
    if len(_last_forwarded) > 500:
        cutoff = now - _DEDUP_WINDOW
        stale = [k for k, t in _last_forwarded.items() if t < cutoff]
        for k in stale:
            del _last_forwarded[k]

    return True


# ---------------------------------------------------------------------------
# AC → Discord polling
# ---------------------------------------------------------------------------

async def poll_ac_to_discord(cfg, channel):
    """Poll AC for new messages and forward to Discord channel."""
    url = cfg["agentchattr_url"]
    bridge_sender = cfg["bridge_sender"]
    interval = cfg["poll_interval"]

    # #458: dedup guard — track recently forwarded message IDs so a
    # stale cursor, drain-loop hiccup, or restart replay can't send
    # the same AC message to Discord twice within a session.
    forwarded_ids: set[int] = set()
    # Cap the set size to avoid unbounded growth in long-running sessions.
    MAX_FORWARDED = 2000

    while True:
        try:
            # Drain all available messages before sleeping. When AC
            # returns a full batch (limit messages), immediately
            # re-fetch with the updated cursor to avoid dropping
            # overflow under high volume.
            # #458: cap drain iterations to prevent infinite loop if
            # since_id isn't being honored by AC.
            drain_iterations = 0
            MAX_DRAIN = 20
            while drain_iterations < MAX_DRAIN:
                drain_iterations += 1
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
                    break

                resp.raise_for_status()
                messages = resp.json()

                if not isinstance(messages, list) or not messages:
                    break

                # #458: detect stale responses — if every message ID in
                # the batch is <= our cursor, the server isn't honoring
                # since_id. Break to avoid re-forwarding.
                max_batch_id = max(m.get("id", 0) for m in messages)
                if max_batch_id <= _cursor["last_seen_id"]:
                    log.warning("AC returned stale batch (max_id=%d <= cursor=%d) — breaking drain", max_batch_id, _cursor["last_seen_id"])
                    break

                # #458: build echo names once per batch (inputs don't
                # change per-message).
                echo_names = ac["known_names"] | {
                    bridge_sender,
                    "discord-bridge",
                    "discord_bridge",
                }

                for msg in messages:
                    msg_id = msg.get("id", 0)
                    sender = msg.get("sender", "")
                    text = msg.get("text", "")

                    # Helper: advance cursor and persist. Called after
                    # a message is fully handled (skipped or forwarded)
                    # so a crash can't replay it (#458). NOT called
                    # before Discord delivery to avoid silent message
                    # loss on transient send failures.
                    def commit_cursor():
                        if msg_id > _cursor["last_seen_id"]:
                            _cursor["last_seen_id"] = msg_id
                            save_cursor(cfg["cursor_file"])

                    # Echo prevention: skip our own messages
                    if sender in echo_names:
                        commit_cursor()
                        continue

                    if not text:
                        commit_cursor()
                        continue

                    # #501: skip system/status noise and dedup
                    if not _should_forward(msg):
                        commit_cursor()
                        continue

                    # #458: dedup guard — skip already-forwarded messages
                    if msg_id in forwarded_ids:
                        commit_cursor()
                        continue

                    # Forward to Discord
                    try:
                        discord_text = f"**{sender}**: {text}"
                        # Discord message limit is 2000 chars
                        if len(discord_text) > 2000:
                            discord_text = discord_text[:1997] + "..."
                        await channel.send(discord_text)
                        # Only commit cursor + mark forwarded AFTER
                        # successful Discord delivery.
                        forwarded_ids.add(msg_id)
                        commit_cursor()
                        # Trim the set if it grows too large
                        if len(forwarded_ids) > MAX_FORWARDED:
                            sorted_ids = sorted(forwarded_ids)
                            forwarded_ids.clear()
                            forwarded_ids.update(sorted_ids[len(sorted_ids) // 2:])
                    except Exception as exc:
                        log.error("Failed to send to Discord: %s", exc)

                # If we got a full batch, there may be more — drain immediately
                if len(messages) >= 50:
                    continue
                break

            if drain_iterations >= MAX_DRAIN:
                log.warning("Drain loop hit %d iterations — breaking to avoid infinite loop", MAX_DRAIN)

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
