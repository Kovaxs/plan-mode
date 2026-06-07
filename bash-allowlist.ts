/**
 * Read-only bash gating for plan mode.
 * Adapted from pi's shipped plan-mode example.
 */

const DESTRUCTIVE_PATTERNS = [
	/\brm\b/i,
	/\brmdir\b/i,
	/\bmv\b/i,
	/\bcp\b/i,
	/\bmkdir\b/i,
	/\btouch\b/i,
	/\bchmod\b/i,
	/\bchown\b/i,
	/\bln\b/i,
	/\btee\b/i,
	/\btruncate\b/i,
	/\bdd\b/i,
	/(^|[^<])>(?!>)/,
	/>>/,
	/\bnpm\s+(install|uninstall|update|ci|link|publish|run)/i,
	/\byarn\s+(add|remove|install|publish)/i,
	/\bpnpm\s+(add|remove|install|publish)/i,
	/\bpip\s+(install|uninstall)/i,
	/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|switch|branch\s+-[dD]|stash|cherry-pick|revert|tag|init|clone)/i,
	/\bsudo\b/i,
	/\bkill(all)?\b/i,
	/\b(vim?|nano|emacs|code|subl)\b/i,
];

const SAFE_PATTERNS = [
	/^\s*cat\b/, /^\s*head\b/, /^\s*tail\b/, /^\s*less\b/, /^\s*more\b/,
	/^\s*grep\b/, /^\s*find\b/, /^\s*ls\b/, /^\s*pwd\b/, /^\s*echo\b/,
	/^\s*wc\b/, /^\s*sort\b/, /^\s*uniq\b/, /^\s*diff\b/, /^\s*file\b/,
	/^\s*stat\b/, /^\s*tree\b/, /^\s*which\b/, /^\s*type\b/,
	/^\s*git\s+(status|log|diff|show|branch|remote|ls-)/i,
	/^\s*npm\s+(list|ls|view|info|outdated)/i,
	/^\s*jq\b/, /^\s*sed\s+-n/i, /^\s*awk\b/, /^\s*rg\b/, /^\s*fd\b/, /^\s*bat\b/,
];

export function isSafeCommand(command: string): boolean {
	if (DESTRUCTIVE_PATTERNS.some((p) => p.test(command))) return false;
	return SAFE_PATTERNS.some((p) => p.test(command));
}
