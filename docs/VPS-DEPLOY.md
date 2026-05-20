# Oracle Cloud Free Tier — Octave Deploy Guide

This walks you through running Octave 24/7 on a free Oracle Cloud VM. The
**Always Free** ARM Ampere offering gives you **4 OCPU + 24 GB RAM** at no
cost — way more than Octave needs.

Total setup time: ~15 minutes.

## 1. Sign up + create the VM

1. Go to https://www.oracle.com/cloud/free/
2. Create an Oracle account (credit card required for verification but **NOT charged** for Always Free resources).
3. In the console, go to **Compute → Instances → Create Instance**.
4. **Image**: Canonical Ubuntu 22.04 (ARM-compatible).
5. **Shape**: switch shape series to **Ampere** → pick `VM.Standard.A1.Flex` → 2 OCPUs, 12 GB RAM (or up to 4 / 24).
6. **Networking**: keep the default VCN. Note the auto-generated public IP.
7. **Add SSH key**: paste your laptop's `~/.ssh/id_ed25519.pub` (run `ssh-keygen -t ed25519` first if you don't have one).
8. Click **Create**. Provisioning takes ~60 seconds.

## 2. SSH in

```bash
ssh ubuntu@<the-public-ip>
```

## 3. Run the deploy script

```bash
# Either curl-pipe it:
curl -fsSL https://raw.githubusercontent.com/octavebot/octave/main/scripts/vps-deploy.sh | sudo bash

# Or clone first then run:
sudo apt update && sudo apt install -y git
git clone https://github.com/octavebot/octave.git
sudo bash octave/scripts/vps-deploy.sh
```

The script will:
- Install Node 20 LTS
- Create the `octave` system user
- Clone the repo to `/home/octave/trading-alerts`
- Prompt for `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`
- Install 4 systemd units (signal-engine, telegram, webui, watchdog)
- Start everything

## 4. Optional: expose the dashboard publicly

By default the dashboard binds `127.0.0.1:7345` (loopback only). To open it on the public IP:

```bash
sudo OPEN_DASHBOARD=1 bash /home/octave/trading-alerts/scripts/vps-deploy.sh
```

Then also open ingress in the Oracle Cloud VCN's security list:
- **Source CIDR**: `0.0.0.0/0` (or your home IP for tighter security)
- **Destination port**: `7345`
- **Protocol**: TCP

**Recommended:** instead of exposing 7345, use **Cloudflare Tunnel** for free HTTPS:

```bash
# On the VPS:
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64 -o /usr/local/bin/cloudflared
chmod +x /usr/local/bin/cloudflared
cloudflared tunnel --url http://localhost:7345
```

The output gives you `https://random-words.trycloudflare.com` — works in Telegram's web_app button, on your phone, anywhere.

## 5. Verify

From your phone, send the bot:
- `/health` — should show `signal-engine 🟢`, `bot 🟢`, `webui 🟢`, `watchdog 🟢`
- `/status` — current state
- `/backtest 7` — quick smoke test of the backtest runner

## Upgrading

When you push new code to GitHub:
```bash
ssh ubuntu@<vps-ip>
sudo -u octave git -C /home/octave/trading-alerts pull
sudo systemctl restart octave-signal-engine octave-telegram octave-webui octave-watchdog
```

Or simpler — just re-run the deploy script; it pulls and restarts.

## Logs

```bash
sudo journalctl -u octave-signal-engine -f       # live tail
sudo journalctl -u octave-telegram --since 1h    # last hour
tail -f /home/octave/.octave-logs/*.log          # alternative
```

## Memory / CPU monitoring

```bash
htop
# octave services typically use:
#   signal-engine  ~80 MB
#   telegram       ~70 MB
#   webui          ~50 MB
#   watchdog       ~30 MB
# Total: well under 250 MB. The ARM Ampere free tier has 12-24 GB.
```

## Why Oracle Cloud and not <other>

- **Free forever** — no 12-month limit like AWS, no $5/mo like Hetzner cheapest tier.
- **24 GB RAM** is overkill but means you'll never see OOM.
- **No bandwidth surprises** — Always Free includes 10 TB/month outbound.
- ARM Ampere instances are not oversubscribed (unlike AWS t2.micro) — Octave's 3s polling stays consistent.

The deploy works identically on Hetzner CX11 ($4/mo x86), AWS Lightsail $3.50, etc. — only the VM-creation step differs.
