import { useState } from 'react';
import { Code2, Eye } from 'lucide-react';
import type { AgentArtifact } from '../../../../shared/agent';
import { useI18n } from '../../../i18n/useI18n';

/**
 * Renders an interactive HTML artifact (v6 §G4/U6) inline. The HTML runs in a
 * SANDBOXED iframe: `sandbox="allow-scripts"` WITHOUT `allow-same-origin` gives it
 * an opaque origin (no access to the app, cookies, or storage), and the injected
 * strict CSP (`connect-src 'none'`, `default-src 'none'`) blocks all network and
 * external resources (§S.1: display only, network-isolated, no privileged bridge).
 * A toggle shows the raw source.
 */

// Strict policy for the isolated frame. Inline script/style only; no network.
const ARTIFACT_CSP =
  "default-src 'none'; " +
  "script-src 'unsafe-inline' 'unsafe-eval'; " +
  "style-src 'unsafe-inline'; " +
  "img-src data: blob:; font-src data:; media-src data: blob:; " +
  "connect-src 'none'; base-uri 'none'; form-action 'none'";

function wrapArtifact(html: string): string {
  // The default body styling lives INSIDE the isolated document (not app tokens),
  // giving artifacts a sane white canvas without touching the app's theme.
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    `<meta http-equiv="Content-Security-Policy" content="${ARTIFACT_CSP}">` +
    '<style>html,body{margin:0}body{padding:8px;font-family:system-ui,sans-serif;' +
    'background:#fff;color:#111;font-size:14px;line-height:1.5}</style></head>' +
    `<body>${html}</body></html>`
  );
}

export function ArtifactView({ artifact }: { artifact: AgentArtifact }) {
  const { t } = useI18n();
  const [showSource, setShowSource] = useState(false);
  return (
    <div className="overflow-hidden rounded border border-subtle bg-surface-1">
      <div className="flex items-center gap-2 border-b border-subtle bg-surface-2 px-2.5 py-1.5">
        <span className="flex-1 truncate text-caption text-fg-secondary">{artifact.title}</span>
        <button
          type="button"
          onClick={() => setShowSource((v) => !v)}
          className="flex items-center gap-1 text-caption text-fg-tertiary hover:text-fg-secondary transition-colors duration-fast"
          title={showSource ? t('agent.chat.artifact.preview') : t('agent.chat.artifact.source')}
        >
          {showSource ? <Eye size={12} /> : <Code2 size={12} />}
          {showSource ? t('agent.chat.artifact.preview') : t('agent.chat.artifact.source')}
        </button>
      </div>
      {showSource ? (
        <pre className="m-0 max-h-80 overflow-auto whitespace-pre-wrap break-words p-2.5 font-mono text-caption text-fg-secondary">
          {artifact.html}
        </pre>
      ) : (
        <iframe
          title={artifact.title}
          sandbox="allow-scripts"
          srcDoc={wrapArtifact(artifact.html)}
          className="h-80 w-full border-0"
        />
      )}
    </div>
  );
}
