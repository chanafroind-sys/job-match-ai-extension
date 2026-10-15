"""Subscriptions sold through an Israeli card processor (Grow, PayPlus, ...).

A payment issues our own license key ("JMA-...") and the extension stores it
in the same field a Gumroad key used to go in, so every feature that already
checks a license (V1 AI calls, Daily Matches, community features) works for a
subscriber without knowing billing exists. main.verify_gumroad_license asks
billing.service.verify_key first.

Visibility follows the Daily Matches rollout switch (DAILY_MATCHES_ENABLED):
off — nobody sees billing; admins — only ADMIN_KEYS; on — everyone. On top of
that, billing shows only when a provider is configured and a price is set,
so turning the feature on before the processor's keys exist shows no
"subscribe" button that leads nowhere.
"""
