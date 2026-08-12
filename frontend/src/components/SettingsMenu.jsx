import React from "react";
import Modal from "./Modal";
import { THEMES } from "../utils/theme";
import "../styles/SettingsMenu.css";

/* =====================================================================
   SettingsMenu — one destination for account settings.

   These used to be six unlabelled entries scattered across the avatar menu
   and the header ("Proxies…", "Speed…", "API keys…", "Webhooks…", "Custom
   Actions"), with nothing to say what any of them did or which ones were
   even yours vs. this scraper's.

   Two things this fixes:

   1. One place, with a sentence each. Discoverability was the real problem —
      "Webhooks…" tells you nothing if you don't already know.

   2. It separates ACCOUNT settings from PER-WORKFLOW ones. Speed and Proxy
      are stored in the workflow's own meta and travel with it on export;
      API keys, webhooks, e-mail alerts and custom actions belong to you.
      Listing all six together implied they were the same kind of thing, so
      changing "Speed" looked global when it wasn't. Per-workflow settings
      stay out of here — they're grouped under the scraper's own heading.

   Each row opens that area's existing dialog rather than embedding it. That
   costs one extra click; it buys not rewriting six working dialogs into
   panes, which is a much larger and more fragile change than the problem
   warrants. Appearance is inline because it IS one control.
   ===================================================================== */

const THEME_LABELS = { system: "Auto", light: "Light", dark: "Dark" };

export default function SettingsMenu({
  open, onClose,
  themePref, onChooseTheme,
  onOpenCustomActions, customActionCount = 0,
  onOpenApiKeys, onOpenWebhooks, onOpenNotifications,
}) {
  const rows = [
    {
      key: "actions",
      icon: "⚡",
      title: "Custom actions",
      detail: "Reusable steps you write in JavaScript, available in every scraper you build.",
      badge: customActionCount > 0 ? String(customActionCount) : null,
      onOpen: onOpenCustomActions,
    },
    {
      key: "alerts",
      icon: "✉️",
      title: "E-mail alerts",
      detail: "Get told when a scraper fails, or when a page you're watching changes.",
      onOpen: onOpenNotifications,
    },
    {
      key: "webhooks",
      icon: "🔗",
      title: "Webhooks",
      detail: "Send the same alerts to Slack, Discord, ntfy or your own server as signed JSON.",
      onOpen: onOpenWebhooks,
    },
    {
      key: "apikeys",
      icon: "🔑",
      title: "API keys",
      detail: "Run and read your scrapers from your own code, through the public REST API.",
      onOpen: onOpenApiKeys,
    },
  ];

  return (
    <Modal open={open} onClose={onClose} title="Settings" modalClassName="set-modal">
      <p className="set-intro">
        These apply to your whole account. Settings that belong to one scraper —
        its speed options and proxy — live with that scraper, under its own menu.
      </p>

      <div className="set-list">
        {rows.map(r => (
          <button key={r.key} className="set-row" onClick={() => { onClose(); r.onOpen?.(); }}>
            <span className="set-row-icon" aria-hidden="true">{r.icon}</span>
            <span className="set-row-body">
              <span className="set-row-title">
                {r.title}
                {r.badge && <span className="set-row-badge">{r.badge}</span>}
              </span>
              <span className="set-row-detail">{r.detail}</span>
            </span>
            <svg className="set-row-go" width="15" height="15" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
              <polyline points="9,18 15,12 9,6" />
            </svg>
          </button>
        ))}
      </div>

      {/* Inline, because it's a single control and bouncing to another dialog
          to flip a theme would be absurd. */}
      <div className="set-section">
        <div className="set-section-title">Appearance</div>
        <div className="set-theme" role="group" aria-label="Appearance">
          {THEMES.map(value => (
            <button
              key={value}
              className={`set-theme-opt ${themePref === value ? "active" : ""}`}
              onClick={() => onChooseTheme(value)}
              aria-pressed={themePref === value}
            >
              {THEME_LABELS[value]}
            </button>
          ))}
        </div>
        <p className="set-section-hint">
          {themePref === "system"
            ? "Following your device's setting."
            : `Always ${THEME_LABELS[themePref].toLowerCase()}, whatever your device says.`}
        </p>
      </div>
    </Modal>
  );
}
